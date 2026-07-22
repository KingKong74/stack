#!/usr/bin/env node
// Stack web terminal — the host-side PTY daemon (#/terminal in the web app).
//
// Spawns a real shell (or a claude session) in a project directory on THIS
// machine and streams it to xterm.js in the browser. This host's firewall
// drops container→host traffic, so the daemon doesn't listen — it dials OUT:
// one persistent websocket to the Stack server's /term-agent endpoint (bearer
// in the upgrade headers), reconnecting with backoff. The server relays
// browser sessions over that socket, multiplexed by sid (see server/src/term.js).
//
// Trust model
//   • The server validates every browser session's token BEFORE any frame
//     reaches us, and strips the credential — the daemon never sees tokens
//     other than its own.
//   • The working directory is jailed to STACK_TERM_ROOT (default: $HOME) —
//     a cwd resolving outside it is refused.
//   • Only two commands exist: an interactive login shell, or claude. There is
//     no arbitrary-exec frame.
//
// The PTY itself comes from pty-shim.py (python3 stdlib) — no native node
// modules, so the daemon installs with plain `npm install` anywhere.
//
// Install (once, on the host):
//   cd terminal && npm install
//   node stack-term.mjs                       # foreground
//   (crontab) @reboot /usr/bin/node /home/you/stack/terminal/stack-term.mjs >> ~/.stack/term.log 2>&1
//
// Config (~/.stack/env or real env; CLI flags override individual values — run with --help):
//   STACK_API                 the app origin, e.g. https://stack.example (required, env only)
//   STACK_TOKEN               the API token the agent connects with (required, env only)
//   STACK_TERM_ROOT           cwd jail, default $HOME  (--root)
//   STACK_TERM_IDLE_MINUTES   close inactive sessions after this many minutes, default 240  (--idle-minutes)
//   STACK_TERM_MAX_SESSIONS   default 8  (--max-sessions)
//
// STACK_API and STACK_TOKEN are env-only — passing credentials as CLI flags would expose
// them in process listings, which is against the project's security conventions.
//
// Alternative model switching (#152):
//   When a Claude session hits a usage limit and exits, the daemon prompts the
//   user (via in-terminal ANSI text) to switch to an alternative AI provider.
//   Providers are configured via API keys in ~/.stack/env or ~/.ccm_config:
//   DEEPSEEK_API_KEY, KIMI_API_KEY, GLM_API_KEY, QWEN_API_KEY, MINIMAX_API_KEY.
//   The chosen provider is persisted to ~/.stack/term-model.json.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import meow from 'meow';
import WebSocket from 'ws';
import { createUsageMeter } from './usage-meter.mjs';
import { createPlanUsage } from './plan-usage.mjs';
import { tmuxAvailable, validName, generateName, sessionArgv, killSession, listDetached, listStackSessions, paneTail } from './tmux-session.mjs';
import {
  availableProviders, providerEnv, getProvider,
  loadPreferredProvider, savePreferredProvider,
} from './model-switch.mjs';

// ---- env (same loader contract as the hooks: ~/.stack/env, never printed) ----
const envFile = join(homedir(), '.stack', 'env');
if (existsSync(envFile)) {
  try {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      const v = s.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  } catch { /* ignore */ }
}

// ---- CLI flags (parsed after env load so --help works without credentials) ----
// Flags override the corresponding env vars. STACK_API and STACK_TOKEN are deliberately
// excluded — exposing credentials in process listings (ps, /proc) is against this
// project's security conventions. Run `node stack-term.mjs --help` for usage.
const cli = meow(`
	Usage
	  $ node stack-term.mjs [options]

	Options
	  --root <directory>     Jail all sessions to this path (default: $HOME)
	  --idle-minutes <n>     Close a session idle for this many minutes (default: 240)
	  --max-sessions <n>     Maximum number of concurrent sessions (default: 8)

	Required environment variables (never passed as flags)
	  STACK_API              App origin, e.g. https://stack.example
	  STACK_TOKEN            Bearer token this daemon authenticates with

	  Set both in ~/.stack/env. The daemon refuses to start if either is absent.
	  Passing them as CLI flags would expose credentials in process listings.

	Examples
	  $ node stack-term.mjs
	  $ node stack-term.mjs --idle-minutes 60
	  $ node stack-term.mjs --root /home/me/projects --max-sessions 4
`, {
  importMeta: import.meta,
  autoVersion: false,
  flags: {
    root: {
      type: 'string',
    },
    idleMinutes: {
      type: 'number',
    },
    maxSessions: {
      type: 'number',
    },
  },
});

// Resolve each value: CLI flag wins, then env var, then hardcoded default.
// envInt preserves the original || semantics — 0 is not a valid value for either
// setting (0 idle minutes or 0 max sessions would be nonsensical), so it falls
// through to the default just as the original parseInt(...) || default did.
const envInt = (k) => { const n = parseInt(process.env[k] || '', 10); return (n || undefined); };
const ROOT = realpathSync(cli.flags.root || process.env.STACK_TERM_ROOT || homedir());
const IDLE_MS = (cli.flags.idleMinutes > 0 ? cli.flags.idleMinutes : (envInt('STACK_TERM_IDLE_MINUTES') ?? 240)) * 60_000;
const MAX_SESSIONS = cli.flags.maxSessions > 0 ? cli.flags.maxSessions : (envInt('STACK_TERM_MAX_SESSIONS') ?? 8);

const API = (process.env.STACK_API || '').replace(/\/$/, '');
const TOKEN = process.env.STACK_TOKEN || '';
if (!API || !TOKEN) {
  console.error('[stack-term] STACK_API and STACK_TOKEN are required (~/.stack/env).');
  process.exit(1);
}
const AGENT_URL = API.replace(/^http/, 'ws') + '/term-agent';
const SHIM = join(dirname(fileURLToPath(import.meta.url)), 'pty-shim.py');

// Output buffer cap per session: 256 KB.  Drop oldest when full.
const OUT_BUF_CAP = 256 * 1024;

const log = (...a) => console.log(`[stack-term] ${new Date().toISOString()}`, ...a);

// ---- cwd jail ----
function resolveCwd(raw) {
  const want = resolve(ROOT, String(raw || '').replace(/^[/\\]+/, ''));
  let real;
  try { real = realpathSync(want); } catch { return null; }
  if (real !== ROOT && !real.startsWith(ROOT + sep)) return null;
  try { if (!statSync(real).isDirectory()) return null; } catch { return null; }
  return real;
}

// ---- token usage + limit watch (#111) ----
// The meter reads real usage from ~/.claude transcripts; the limit watch greps
// each session's pty stream for Claude's usage-limit message (same patterns the
// autopilot runner uses) and derives the reset time. Both ride to the browser
// as `usage` frames — one per live session, every USAGE_TICK_MS and on ready.
const meter = createUsageMeter();
// Real Plan usage limits (#195) — the numbers Claude shows in-app, from the
// account's OAuth usage endpoint via the CLI's own credentials. get() serves
// a ≤10-min cache and refreshes itself in the background; null degrades to
// the old transcript-count-only frame.
const planUsage = createPlanUsage();
const USAGE_TICK_MS = 15_000;
// CSI + OSC escape stripper, so the match runs on what the human actually sees.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g;
const LIMIT_RE = /(hit|reached).{0,40}(session|usage|token|rate).{0,20}limit|limit.{0,30}resets/i;
const RESET_RE = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
let limitResetAt = null; // epoch ms; account-wide, cleared once the reset passes

function parseReset(text) {
  const m = RESET_RE.exec(text);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toLowerCase() === 'pm') h += 12;
  const t = new Date();
  t.setHours(h, m[2] ? parseInt(m[2], 10) : 0, 0, 0);
  if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

function noteLimit(plainTail) {
  if (limitResetAt && limitResetAt > Date.now()) return false; // already known
  if (!LIMIT_RE.test(plainTail)) return false;
  // Unparseable message → the session window's real reset (#195) beats the
  // runner's old +4h guess; the guess survives as the offline last resort.
  const planReset = planUsage.get()?.session?.resetAt;
  limitResetAt = parseReset(plainTail)
    || (planReset && planReset > Date.now() ? planReset : Date.now() + 4 * 3_600_000);
  log(`usage limit seen — reset assumed ${new Date(limitResetAt).toISOString()}`);
  return true;
}

const clockLabel = (ms) => {
  const d = new Date(ms);
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() >= 12 ? 'pm' : 'am'}`;
};

function usageFrame(sid) {
  if (limitResetAt && limitResetAt <= Date.now()) limitResetAt = null;
  // tokens = the fresh count (input + output + cache write — what the budget
  // bar should measure, #130); totalTokens keeps the cache-read-inclusive sum.
  const { total, fresh } = meter.read();
  const f = { t: 'usage', sid, tokens: fresh, totalTokens: total };
  // Plan windows (#195): session/week percentages + reset times, verbatim what
  // the app's /usage shows. A limit the API marks active gives the REAL reset
  // time — it beats the pty-scrape guess (which stays as the offline fallback).
  const plan = planUsage.get();
  if (plan) {
    f.plan = { session: plan.session, week: plan.week, weekModel: plan.weekModel };
    if (plan.activeResetAt && plan.activeResetAt > Date.now()) limitResetAt = plan.activeResetAt;
  }
  if (limitResetAt) {
    f.resetAt = limitResetAt;
    f.resetLabel = clockLabel(limitResetAt);
    // A ready-to-book one-off calendar slot just past the reset, in HOST-local
    // time (the browser's clock may sit in another timezone entirely).
    const s = new Date(limitResetAt + 5 * 60_000);
    f.sched = {
      runDate: `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`,
      atTime: `${String(s.getHours()).padStart(2, '0')}:${String(s.getMinutes()).padStart(2, '0')}`,
    };
  }
  return f;
}

// ---- uplink — the one live ws to the relay ----
// Kept at module level so startSession's output handlers can always find the
// current socket without being bound to the one that existed when they started.
// On uplink loss the socket is nulled; output is buffered per session instead.
let uplink = null; // the current open WebSocket to /term-agent, or null

function sendUplink(obj) {
  if (uplink && uplink.readyState === WebSocket.OPEN) {
    uplink.send(JSON.stringify(obj));
  }
}

// ---- tmux-session advertising (#188 follow-up) ----
// A page reload orphans its tmux session: the claude process keeps running but
// no browser knows the session name any more. The daemon advertises EVERY
// stack-term-* session to the relay — detached survivors and ones attached
// elsewhere (another browser, or a laptop over ssh via `stack term`) — which
// caches the list for GET /api/terminal/detached; the Terminal screen and
// Mission Control render them as re-attach / mirror chips. Pushed on connect,
// on every session start/end (attach consumes a detached entry, detach
// creates one) and on a slow tick as a catch-all.
function pushDetached() {
  if (!tmuxAvailable()) return;
  const sessionsList = listStackSessions().map((s) => ({
    name: s.name,
    created: s.created,
    attached: s.attached,
    // Jail-relative cwd, the same form the browser sends in start frames
    // ('' = the root). A path outside the jail (shouldn't happen) maps to ''.
    cwd: s.path === ROOT ? '' : s.path.startsWith(ROOT + sep) ? s.path.slice(ROOT.length + 1) : '',
    // The pane's recent content — what the Gemini labeller reads relay-side.
    tail: paneTail(s.name),
  }));
  sendUplink({ t: 'detached', sessions: sessionsList });
}
setInterval(pushDetached, 60_000);

// Plan-window push (#220): the account-level Plan usage (#195) rides to the
// relay even with NO session open, so Mission Control's console can show the
// session/week bars over plain HTTP. planUsage self-throttles (60s cache),
// so a 60s tick costs at most one OAuth fetch a minute — usually none.
function pushPlan() {
  const plan = planUsage.get();
  if (!plan) return;
  const { fresh } = meter.read();
  sendUplink({
    t: 'plan', tokens: fresh,
    plan: { session: plan.session, week: plan.week, weekModel: plan.weekModel },
  });
}
setInterval(pushPlan, 60_000);

function pushUsage(ws) {
  if (ws && ws.readyState !== WebSocket.OPEN) return;
  const target = ws || uplink;
  if (!target || target.readyState !== WebSocket.OPEN) return;
  for (const sid of sessions.keys()) target.send(JSON.stringify(usageFrame(sid)));
}

// ---- sessions (sid -> { child, outBuf, cwd, cmd, cols, rows, lastActivity,
//                          idleTimer, hitLimit, provider, switchMode }) ----
// buf is the reconnect output buffer: a plain string of base64 chunks
// concatenated so they can be replayed as individual 'out' frames.
// We store them as an array of base64 strings (each is one original chunk)
// and track total byte size to implement the 256KB cap.
const sessions = new Map();

// ---- output buffering helper ----
// Sends text to the browser as an 'out' frame, buffering when the uplink is down.
function sendOutText(sid, sess, text) {
  const b64 = Buffer.from(text).toString('base64');
  if (uplink && uplink.readyState === WebSocket.OPEN) {
    uplink.send(JSON.stringify({ t: 'out', sid, data: b64 }));
  } else {
    sess.outBuf.bytes += b64.length;
    sess.outBuf.chunks.push(b64);
    while (sess.outBuf.bytes > OUT_BUF_CAP && sess.outBuf.chunks.length > 0) {
      sess.outBuf.bytes -= sess.outBuf.chunks.shift().length;
    }
  }
}

// ---- wireChild — attach I/O handlers to a newly spawned child ----
// Used by startSession (initial spawn) and respawnWithProvider (model switch).
// Stores the child + idle timer on sess; each child gets its own plainTail.
function wireChild(sid, sess, child) {
  sess.child = child;

  child.resize = (cols, rows) => {
    const c = Math.max(2, Math.min(500, cols | 0));
    const r = Math.max(2, Math.min(300, rows | 0));
    try { child.stdio[3].write(`R ${c} ${r}\n`); } catch { /* gone */ }
  };
  child.feed = (b64) => {
    sess.lastActivity = Date.now();
    child.stdin.write(Buffer.from(b64, 'base64'));
  };

  // Apply stored terminal dimensions immediately (set from start/resize frames).
  if (sess.cols && sess.rows) child.resize(sess.cols, sess.rows);

  // Reset the idle timer for this child (clears any prior timer from a respawn).
  if (sess.idleTimer) clearInterval(sess.idleTimer);
  sess.lastActivity = Date.now();
  sess.idleTimer = setInterval(() => {
    if (Date.now() - sess.lastActivity > IDLE_MS) {
      sendUplink({ t: 'err', sid, msg: 'Session closed after inactivity.' });
      sess.hitLimit = false; // prevent switch prompt on an idle-reaped session
      // Kill the pty-shim; for tmux sessions this detaches the client but leaves
      // the underlying tmux session (and any running claude process) alive — that
      // is the whole point of tmux persistence. Do NOT call killSession() here.
      // The session cleans itself up when the inner process exits naturally.
      child.kill('SIGTERM');
    }
  }, 60_000);

  // Per-child rolling tail for the Claude usage-limit scanner.
  let plainTail = '';
  const out = (d) => {
    sess.lastActivity = Date.now();
    // Track Claude limit per session. noteLimit() returns false when the limit
    // is already known globally — use a direct LIMIT_RE match so every session
    // gets its own hitLimit flag. Skip this entirely for provider sessions to
    // avoid polluting the account-wide limitResetAt with provider rate-limit
    // messages that may match the same pattern.
    if (!sess.provider) {
      plainTail = (plainTail + d.toString('utf8').replace(ANSI_RE, ' ')).slice(-600);
      if (!sess.hitLimit && LIMIT_RE.test(plainTail)) sess.hitLimit = true;
      if (noteLimit(plainTail)) pushUsage(null);
    }
    const b64 = d.toString('base64');
    if (uplink && uplink.readyState === WebSocket.OPEN) {
      uplink.send(JSON.stringify({ t: 'out', sid, data: b64 }));
    } else {
      sess.outBuf.bytes += b64.length;
      sess.outBuf.chunks.push(b64);
      while (sess.outBuf.bytes > OUT_BUF_CAP && sess.outBuf.chunks.length > 0) {
        sess.outBuf.bytes -= sess.outBuf.chunks.shift().length;
      }
    }
  };
  child.stdout.on('data', out);
  child.stderr.on('data', out);

  child.on('exit', (code) => {
    clearInterval(sess.idleTimer);
    // If a Claude session (not already on a provider) hit a usage limit, offer
    // the model-switch prompt instead of immediately ending the session.
    if (sess.cmd === 'claude' && !sess.provider && sess.hitLimit) {
      log(`session ${sid} claude limit — entering model-switch prompt`);
      startSwitchMode(sid, sess, code ?? 0);
    } else {
      sessions.delete(sid);
      log(`session ${sid} down (${sessions.size} live), exit ${code}`);
      sendUplink({ t: 'exit', sid, code: code ?? 0 });
      // A killed shim leaves its tmux session running detached; a real claude
      // exit removes it. Either way the detached list just changed.
      if (sess.tmuxSession) pushDetached();
    }
  });

  child.on('error', (e) => {
    clearInterval(sess.idleTimer);
    sessions.delete(sid);
    log(`session ${sid} error: ${e.message}`);
    sendUplink({ t: 'err', sid, msg: e.message });
    sendUplink({ t: 'exit', sid, code: 1 });
  });
}

// ---- startSwitchMode — hold the session open and prompt for a model switch ----
// Called when a Claude session exits after hitting a usage limit. If no
// providers are configured, falls through to a normal exit immediately.
function startSwitchMode(sid, sess, exitCode) {
  const available = availableProviders();
  if (available.length === 0) {
    sessions.delete(sid);
    log(`session ${sid} down (${sessions.size} live) — no alt providers configured`);
    sendUplink({ t: 'exit', sid, code: exitCode });
    return;
  }

  const preferred = loadPreferredProvider();

  // Build and send the in-terminal prompt (ANSI-coloured, \r\n for raw PTY mode).
  const lines = [
    '\r\n\x1b[0m\x1b[33m⚠  Claude usage limit reached.\x1b[0m\r\n',
    '\x1b[0m   Switch to a free AI model:\r\n\r\n',
  ];
  available.forEach((p, i) => {
    const pref = p.key === preferred ? '  \x1b[32m← preferred\x1b[0m' : '';
    lines.push(`\x1b[0m   \x1b[1m[${i + 1}]\x1b[0m ${p.label} — ${p.model}${pref}\r\n`);
  });
  lines.push('\r\n\x1b[0m   Press \x1b[1m1\x1b[0m–\x1b[1m' + available.length + '\x1b[0m to switch');
  if (preferred && available.some((p) => p.key === preferred)) {
    lines.push(', \x1b[1mEnter\x1b[0m for preferred');
  }
  lines.push(', or \x1b[1mq\x1b[0m to end session.\r\n');
  sendOutText(sid, sess, lines.join(''));

  // 5-minute failsafe — clean up an unanswered prompt rather than leaking forever.
  const switchTimeout = setTimeout(() => {
    if (!sessions.has(sid) || !sessions.get(sid).switchMode) return;
    sessions.delete(sid);
    log(`session ${sid} switch prompt timed out`);
    sendUplink({ t: 'exit', sid, code: exitCode });
  }, 5 * 60_000);

  sess.switchMode = {
    available,
    preferred,
    exitCode,
    timeout: switchTimeout,
    onInput: (b64) => {
      const ch = Buffer.from(b64, 'base64').toString('utf8');
      const byte0 = ch.charCodeAt(0);

      // Ctrl-C / lone Escape / q / n → decline and end the session.
      if (byte0 === 3 || (byte0 === 0x1b && ch.length === 1) || 'qQnN'.includes(ch[0])) {
        clearTimeout(switchTimeout);
        sessions.delete(sid);
        log(`session ${sid} model switch declined`);
        sendUplink({ t: 'exit', sid, code: exitCode });
        return;
      }

      // Enter → use the preferred provider if one is saved.
      if (ch === '\r' || ch === '\n') {
        if (preferred) {
          const pref = available.find((p) => p.key === preferred);
          if (pref) {
            clearTimeout(switchTimeout);
            respawnWithProvider(sid, sess, pref.key, exitCode);
            return;
          }
        }
        return; // no preferred set — ignore bare Enter
      }

      // Digit key → pick by list position.
      const digit = parseInt(ch, 10);
      if (digit >= 1 && digit <= available.length) {
        clearTimeout(switchTimeout);
        respawnWithProvider(sid, sess, available[digit - 1].key, exitCode);
        return;
      }
      // Ignore everything else (arrow keys arrive as multi-byte escape sequences).
    },
  };
}

// ---- respawnWithProvider — spawn claude with an alternative model's env ----
function respawnWithProvider(sid, sess, providerKey, prevExitCode) {
  const env = providerEnv(providerKey);
  if (!env) {
    sessions.delete(sid);
    sendUplink({ t: 'err', sid, msg: `No API key found for ${providerKey} — configure it in ~/.ccm_config.` });
    sendUplink({ t: 'exit', sid, code: prevExitCode });
    return;
  }
  const provider = getProvider(providerKey);
  savePreferredProvider(providerKey);

  sendOutText(
    sid, sess,
    `\r\n\x1b[32m► Switching to ${provider.label} (${provider.model})…\x1b[0m\r\n\r\n`,
  );

  // claude --continue resumes the most recent conversation so the context from
  // the limit-hit session is preserved. Keys are injected via spawn's env option
  // (never in argv, to keep ps output clean).
  const child = spawn('python3', [SHIM, sess.cwd, '/bin/bash', '-lc', 'exec claude --continue'], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

  sess.provider = providerKey;
  sess.switchMode = null;
  sess.hitLimit = false;
  wireChild(sid, sess, child);

  log(`session ${sid} respawned on ${providerKey} (${provider.label} / ${provider.model})`);
}

function startSession(msg) {
  const { sid } = msg;
  const failUplink = (m) => {
    sendUplink({ t: 'err', sid, msg: m });
    sendUplink({ t: 'exit', sid, code: 1 });
  };
  const cwd = resolveCwd(msg.cwd);
  if (!cwd) return failUplink(`No such directory under ${ROOT}.`);
  if (sessions.size >= MAX_SESSIONS) return failUplink('Too many live sessions.');

  // Two commands only. Shell sessions run the login shell directly.
  // Claude sessions run inside a named tmux session so the process survives
  // browser disconnects: the pty-shim runs `tmux new-session -A`, which
  // creates the session (or attaches if it already exists). When the shim is
  // killed (browser disconnect → kill frame → SIGTERM to shim → HUP to the
  // tmux client), tmux detaches gracefully but the session (and claude inside)
  // keeps running. A reconnect re-attaches by passing tmuxSession in the start
  // frame — `new-session -A` handles both cases without a separate has-session
  // check, eliminating the create-then-attach race.
  // When tmux is not installed on the host, falls back to direct claude spawn.
  let argv;
  let tmuxSession = null; // set when tmux is in use

  if (msg.cmd === 'claude') {
    // The browser may ask for permission prompts to be skipped — a boolean
    // only, mapped to the one allow-listed flag here. There is no path for
    // arbitrary arguments to reach the spawn.
    const claudeCmd = msg.skipPerms === true ? 'exec claude --dangerously-skip-permissions' : 'exec claude';
    if (tmuxAvailable()) {
      // Use a validated name from the browser if provided, otherwise generate one.
      tmuxSession = validName(msg.tmuxSession) ? msg.tmuxSession : generateName('term');
      argv = sessionArgv(tmuxSession, cwd, `/bin/bash -lc "${claudeCmd}"`);
      log(`session ${sid}: tmux session ${tmuxSession} (${validName(msg.tmuxSession) ? 're-attach' : 'new'})`);
    } else {
      // Degrade gracefully when tmux is absent — direct spawn, no persistence.
      argv = ['/bin/bash', '-lc', claudeCmd];
      log(`session ${sid}: tmux not available, running claude directly`);
    }
  } else {
    argv = [process.env.SHELL || '/bin/bash', '-l'];
  }

  const child = spawn('python3', [SHIM, cwd, ...argv], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], // fd3 = resize control
  });

  const sess = {
    outBuf: { chunks: [], bytes: 0 },
    cwd,
    tmuxSession, // non-null when the claude session runs inside tmux (#171)
    cmd: msg.cmd === 'claude' ? 'claude' : 'shell',
    // Terminal dimensions are stored on the session so respawned children get
    // the right size from the start (#152).
    cols: msg.cols || 0,
    rows: msg.rows || 0,
    lastActivity: Date.now(),
    idleTimer: null,
    hitLimit: false,  // set to true when LIMIT_RE fires on this session's output
    provider: null,   // non-null after a model switch (prevents re-triggering)
    switchMode: null, // non-null while awaiting user input for model selection
    child: null,      // set by wireChild
  };
  sessions.set(sid, sess);
  log(`session ${sid} up (${sessions.size} live): ${sess.cmd} in ${cwd}`);

  wireChild(sid, sess, child);

  const cwdLabel = cwd === ROOT ? '~' : '~/' + cwd.slice(ROOT.length + 1);
  const readyFrame = { t: 'ready', sid, cwd: cwdLabel };
  if (tmuxSession) readyFrame.tmuxSession = tmuxSession;
  sendUplink(readyFrame);
  sendUplink(usageFrame(sid)); // usage snapshot lands with the prompt
  if (tmuxSession) pushDetached(); // a re-attach just consumed a detached entry
}

// ---- the one outbound agent connection, kept alive forever ----
let backoff = 5_000;
function connect() {
  const ws = new WebSocket(AGENT_URL, { headers: { authorization: `Bearer ${TOKEN}` } });

  ws.on('open', () => {
    backoff = 5_000;
    uplink = ws;
    log(`connected to ${API}`);

    // Re-announce any sessions that survived the uplink gap, then flush their
    // buffered output so browsers can re-attach and catch up.
    pushDetached(); // seed the relay's detached-session cache straight away
    pushPlan();     // …and its plan-usage snapshot (#220)

    if (sessions.size > 0) {
      const liveSids = [...sessions.keys()];
      log(`re-announcing ${liveSids.length} surviving session(s): ${liveSids.join(', ')}`);
      ws.send(JSON.stringify({ t: 'hello', sids: liveSids }));
      for (const [sid, sess] of sessions) {
        // Flush buffered output chunks in order.
        for (const b64 of sess.outBuf.chunks) {
          ws.send(JSON.stringify({ t: 'out', sid, data: b64 }));
        }
        sess.outBuf.chunks = [];
        sess.outBuf.bytes = 0;
        // Send a fresh usage frame so the browser strip is current.
        ws.send(JSON.stringify(usageFrame(sid)));
      }
    }
  });

  // Live usage while any session is up — incremental after the first read, so
  // each tick only parses transcript bytes appended since the last one. Warm
  // the plan-limit cache up front so the first frame already carries it.
  void planUsage.refresh();
  const usageTick = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN && sessions.size) pushUsage(ws);
  }, USAGE_TICK_MS);

  // A replaced server (redeploy) can leave this outbound socket half-open —
  // no close, no error, just silence through the tunnel. Ping on an interval
  // and treat a missing pong as a dead line: terminate() fires close, and the
  // normal retry path takes it from there.
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!alive) {
      log('heartbeat lost — assuming the server went away');
      try { ws.terminate(); } catch { /* close still fires */ }
      return;
    }
    alive = false;
    try { ws.ping(); } catch { /* dead socket — caught on the next tick */ }
  }, 30_000);
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const sess = sessions.get(m.sid);
    const child = sess?.child;
    if (m.t === 'start') startSession(m);
    else if (m.t === 'in' && sess && typeof m.data === 'string') {
      // During model-switch mode the child has exited — route input to the
      // switch handler rather than the dead child's stdin (which would EPIPE).
      if (sess.switchMode) sess.switchMode.onInput(m.data);
      else if (child) child.feed(m.data);
    }
    else if (m.t === 'resize' && sess) {
      // Persist dimensions so a respawned child can be sized correctly.
      if (m.cols) sess.cols = m.cols;
      if (m.rows) sess.rows = m.rows;
      if (child) child.resize(m.cols, m.rows);
    }
    else if (m.t === 'killDetached') {
      // Browser asked to kill an orphaned tmux session (via the relay). Only
      // names currently in the detached list are killable — a name attached to
      // a live sid never matches, so a live session can't be killed this way.
      if (validName(m.name) && listDetached().some((s) => s.name === m.name)) {
        log(`killing detached tmux session ${m.name} (browser request)`);
        killSession(m.name);
      }
      pushDetached();
    }
    else if (m.t === 'kill') {
      if (sess?.switchMode) {
        // Browser tab closed during the switch prompt — clean up gracefully.
        clearTimeout(sess.switchMode.timeout);
        sessions.delete(m.sid);
        log(`session ${m.sid} switch prompt killed by browser`);
      } else if (child) {
        if (sess) sess.hitLimit = false; // prevent switch prompt on an explicit browser kill
        child.kill('SIGTERM');
      }
    }
  });
  // error and close can both fire (and a failed handshake may emit only
  // error) — whichever lands first schedules the single reconnect.
  let retried = false;
  const retry = () => {
    if (retried) return;
    retried = true;
    clearInterval(heartbeat);
    clearInterval(usageTick);
    if (uplink === ws) uplink = null;
    // PTY sessions are kept alive — they survive the uplink gap and are
    // re-announced on reconnect.  Only a shell exit or an explicit kill
    // terminates a session.
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  };
  ws.on('close', () => { log('disconnected — retrying'); retry(); });
  ws.on('error', (e) => { log(`connection error: ${e.message}`); retry(); try { ws.terminate(); } catch { /* already gone */ } });
}
connect();
log(`agent for ${API} (root ${ROOT})`);
