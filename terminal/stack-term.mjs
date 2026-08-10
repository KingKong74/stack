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

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import meow from 'meow';
import WebSocket from 'ws';
import { createUsageMeter } from './usage-meter.mjs';
import { createPlanUsage } from './plan-usage.mjs';
import { tmuxAvailable, validName, generateName, sessionArgv, sessionExists, killSession, listDetached, listStackSessions, listAutoSessions, paneTail, reapDeadSessions, reapIdleSessions, sendKeys, setKeep } from './tmux-session.mjs';
import { detectPrompt } from './prompt-scan.mjs';
import { parseAutoName, readActivity } from './auto-scan.mjs';
import { agentScratchDir, agentClaudeArgs } from './agent-run.mjs';
import { primedLaunch, launchCommand } from './console-launch.mjs';
import { createEditWatch } from './edit-watch.mjs';
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
  const sessionsList = listStackSessions().map((s) => {
    // The pane's recent content — what the Gemini labeller reads relay-side,
    // and what the permission-prompt read below works off. One capture, two
    // readers: watching for a block costs no extra fork.
    const tail = paneTail(s.name);
    return {
      name: s.name,
      created: s.created,
      attached: s.attached,
      // Jail-relative cwd, the same form the browser sends in start frames
      // ('' = the root). A path outside the jail (shouldn't happen) maps to ''.
      cwd: s.path === ROOT ? '' : s.path.startsWith(ROOT + sep) ? s.path.slice(ROOT.length + 1) : '',
      tail,
      // #292 — pinned against the idle reaper. Read off the session itself on
      // every push, so the browser's view of the pin can never be a cache of
      // what the daemon last did rather than what the host actually holds.
      keep: s.keep === true,
      // Stopped, waiting on a human. null unless a permission prompt is
      // genuinely sitting at the end of the pane right now.
      blocked: detectPrompt(tail),
    };
  });
  sendUplink({ t: 'detached', sessions: sessionsList });
}
setInterval(pushDetached, 60_000);

// ---- autopilot pane advertising (#366) --------------------------------------
// Mission Control's fleet strip shows what a running autopilot job is DOING,
// not just that a job claims it — and the only place that answer exists is
// the pane itself. stack-auto-* sessions are never mirrored or killed from
// the browser (listAutoSessions() is a read-only sibling of
// listStackSessions()), so this push carries only what the pane says, plus
// the parsed job identity and a lightweight "what is it doing" read.
//
// Same 60s cadence as pushDetached, on the same tick, and cheap by
// construction: FLEET_CAPACITY is 1, so there is at most one autopilot
// session at a time — one extra capture-pane fork a minute, no database
// work. The alternative (the browser polling the host per render) is what
// this periodic push is deliberately avoiding.
function pushAuto() {
  if (!tmuxAvailable()) return;
  const now = Date.now();
  const sessions = listAutoSessions().map((s) => {
    const tail = paneTail(s.name);                 // one capture, two readers
    const idleMs = s.activity ? Math.max(0, now - s.activity) : 0;
    const parsed = parseAutoName(s.name);
    const read = readActivity(tail, { idleMs });
    return { name: s.name, jobId: parsed?.jobId ?? null, slug: parsed?.slug ?? '',
             created: s.created, attached: s.attached, activityAt: s.activity,
             idleMs, tail, doing: read.doing };
  });
  sendUplink({ t: 'auto', sessions });
}
setInterval(pushAuto, 60_000);

// ---- the block watch --------------------------------------------------------
// A session that has stopped to ask permission is the most time-sensitive thing
// the host knows: every second it waits is a second nothing is happening. Sixty
// is too many, so a light tick re-reads the panes and pushes the moment the set
// of blocked sessions CHANGES — no change, no frame. A capture-pane is a couple
// of milliseconds, and this is the only cost of noticing within twenty seconds
// instead of within sixty.
let blockedKey = '';
function watchBlocks() {
  if (!tmuxAvailable()) return;
  const key = listStackSessions()
    .map((s) => `${s.name}:${detectPrompt(paneTail(s.name))?.fingerprint || ''}`)
    .join('|');
  if (key === blockedKey) return;
  blockedKey = key;
  pushDetached();
}
setInterval(watchBlocks, 20_000);

// ---- who is editing what (live) --------------------------------------------
// Read off the transcripts Claude Code is writing, not off git: two sessions in
// ONE checkout both have the same dirty working tree, so git cannot say which
// of them wrote a file. The transcript can, because each session writes its own.
const editWatch = createEditWatch();
function pushEdits() {
  let sessionsList;
  try { sessionsList = editWatch.read(); } catch { return; }
  sendUplink({ t: 'edits', sessions: sessionsList });
}
setInterval(pushEdits, 60_000);

// Orphan GC (#197): every 10 minutes reap detached stack-term-* sessions whose
// pane is DEAD (the process inside already exited — tmux holding a corpse).
// Sessions normally clean themselves up when their command exits; this is the
// explicit backstop for remain-on-exit leftovers and crashed shims. Detached
// sessions with a live process are sacred (#188) and never touched.
function gcOrphans() {
  if (!tmuxAvailable()) return;
  const reaped = reapDeadSessions();
  if (reaped.length) {
    log(`orphan GC: reaped ${reaped.length} dead session(s): ${reaped.join(', ')}`);
    pushDetached(); // the advertised list just changed
  }
}
setInterval(gcOrphans, 10 * 60_000);
gcOrphans(); // and once at startup — reboots are when corpses accumulate

// (#287) Idle reaper — the second half of a ladder the daemon only had the
// first half of.
//
// The per-child idle timer above kills the pty-SHIM after inactivity, which
// for a tmux session merely detaches the client: the tmux session and the
// claude inside it keep running, forever, because that is exactly what tmux
// persistence is for. Which is right at four hours and wrong at four days —
// the machine ends up holding contexts nobody is coming back to.
//
// So: detach frees the socket, and this frees the machine. The threshold is an
// app setting (Settings → Terminal), read from the API rather than a flag,
// because it is a policy about the whole system rather than about this host's
// process.
//
// FAIL SAFE. `idleHours` starts null and stays null until a fetch actually
// succeeds, and null NEVER reaps. An unreachable API therefore means sessions
// survive — the opposite of the arm-switch convention, and deliberately so:
// this deletes running work, so the failure mode has to be "do nothing".
let idleHours = null;
async function refreshTermSettings() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${API}/api/settings`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return;
    const s = await res.json();
    if (typeof s.termIdleHours === 'number' && s.termIdleHours >= 0) idleHours = s.termIdleHours;
  } catch { /* unreachable — keep the last known value, or stay null and reap nothing */ }
  finally { clearTimeout(timer); }
}

async function gcIdle() {
  await refreshTermSettings();
  if (!tmuxAvailable() || idleHours == null || idleHours <= 0) return;
  const reaped = reapIdleSessions(idleHours);
  if (reaped.length) {
    log(`idle reaper: terminated ${reaped.length} session(s) silent for >${idleHours}h: `
      + reaped.map((r) => `${r.name} (${r.idleHours}h)`).join(', '));
    pushDetached(); // the advertised list just changed
  }
}
setInterval(gcIdle, 10 * 60_000);
// Not at startup: a reboot is when the clock is least trustworthy and the
// settings fetch has not happened yet. The first pass runs ten minutes in.

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

// PTY size bounds (#218: #186): resize requests are clamped to what the shim
// can sanely handle — the floor stops zero/negative sizes, the caps stop a
// rogue frame asking for absurd buffers.
const MIN_COLS = 2;
const MAX_COLS = 500;
const MIN_ROWS = 2;
const MAX_ROWS = 300;

// ANSI styling for the daemon's own in-terminal prompts (#218: #187): one
// vocabulary instead of escape soup at every call site. Lines start from
// reset so claude's own colours never bleed into ours.
const ANSI_RESET = '\x1b[0m';
const ansi = {
  warn: (s) => `\x1b[33m${s}${ANSI_RESET}`, // yellow — attention
  ok: (s) => `\x1b[32m${s}${ANSI_RESET}`,   // green — confirmation
  bold: (s) => `\x1b[1m${s}${ANSI_RESET}`,
};

// ---- wireChild — attach I/O handlers to a newly spawned child ----
// Used by startSession (initial spawn) and respawnWithProvider (model switch).
// Stores the child + idle timer on sess; each child gets its own plainTail.
function wireChild(sid, sess, child) {
  sess.child = child;

  child.resize = (cols, rows) => {
    const c = Math.max(MIN_COLS, Math.min(MAX_COLS, cols | 0));
    const r = Math.max(MIN_ROWS, Math.min(MAX_ROWS, rows | 0));
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
    `\r\n${ANSI_RESET}${ansi.warn('⚠  Claude usage limit reached.')}\r\n`,
    `${ANSI_RESET}   Switch to a free AI model:\r\n\r\n`,
  ];
  available.forEach((p, i) => {
    const pref = p.key === preferred ? `  ${ansi.ok('← preferred')}` : '';
    lines.push(`${ANSI_RESET}   ${ansi.bold(`[${i + 1}]`)} ${p.label} — ${p.model}${pref}\r\n`);
  });
  lines.push(`\r\n${ANSI_RESET}   Press ${ansi.bold('1')}–${ansi.bold(String(available.length))} to switch`);
  if (preferred && available.some((p) => p.key === preferred)) {
    lines.push(`, ${ansi.bold('Enter')} for preferred`);
  }
  lines.push(`, or ${ansi.bold('q')} to end session.\r\n`);
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
    `\r\n${ansi.ok(`► Switching to ${provider.label} (${provider.model})…`)}\r\n\r\n`,
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
  let reattached = false; // true when the named tmux session was already running

  if (msg.cmd === 'claude') {
    // The browser may ask for permission prompts to be skipped — a boolean
    // only, mapped to the one allow-listed flag here. There is no path for
    // arbitrary arguments to reach the spawn.
    const claudeCmd = msg.skipPerms === true ? 'exec claude --dangerously-skip-permissions' : 'exec claude';
    // #380 — a tab agent's console is spawned AS that agent: the server's
    // briefing goes in as an appended system prompt via a launcher script (see
    // console-launch.mjs for why the text never travels through a command
    // line). Everything about this is fail-safe: no prime, an unwritable
    // directory or a session that already exists all fall through to the plain
    // `exec claude` above, because an unprimed console is a working terminal.
    const prime = typeof msg.prime === 'string' ? msg.prime : '';
    if (tmuxAvailable()) {
      // Use a validated name from the browser if provided, otherwise generate one.
      tmuxSession = validName(msg.tmuxSession) ? msg.tmuxSession : generateName('term');
      // Did this session already exist? `new-session -A` deliberately does not
      // say — it creates or attaches with one command precisely so there is no
      // race between the two — so the answer has to be taken BEFORE the spawn.
      // The browser needs it: a tab agent's console (#379) opens the same
      // deterministic name every time, and "you are looking at a session that
      // was already running" is a different thing to be told than "this one
      // just started". Asking after the spawn would always answer yes.
      reattached = sessionExists(tmuxSession);
      // Only for a session being CREATED. `new-session -A` ignores the command
      // when it attaches, so priming a re-attach would write a briefing nothing
      // ever reads — and, worse, would read as having re-primed a session whose
      // agent is still running on the identity it was spawned with.
      let shellCmd = `/bin/bash -lc "${claudeCmd}"`;
      if (!reattached && prime) {
        const primed = primedLaunch({
          key: tmuxSession, prime, skipPerms: msg.skipPerms === true, model: msg.model,
        });
        if (primed) {
          shellCmd = launchCommand(primed);
          log(`session ${sid}: primed ${tmuxSession} (${prime.length} chars${msg.model ? `, model ${msg.model}` : ''})`);
        } else {
          log(`session ${sid}: could not write the prime for ${tmuxSession} — opening unprimed`);
        }
      }
      argv = sessionArgv(tmuxSession, cwd, shellCmd);
      log(`session ${sid}: tmux session ${tmuxSession} (${reattached ? 're-attach' : 'new'})`);
    } else {
      // Degrade gracefully when tmux is absent — direct spawn, no persistence.
      // A prime still applies: persistence and identity are separate questions,
      // and the launcher is keyed by the relay's session id here because there
      // is no tmux name to key it by.
      const primed = primedLaunch({
        key: `sid-${String(sid).replace(/[^A-Za-z0-9_-]/g, '')}`,
        prime, skipPerms: msg.skipPerms === true, model: msg.model,
      });
      argv = primed ? ['/bin/bash', '-l', primed] : ['/bin/bash', '-lc', claudeCmd];
      log(`session ${sid}: tmux not available, running claude directly${primed ? ' (primed)' : ''}`);
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
  if (tmuxSession) {
    readyFrame.tmuxSession = tmuxSession;
    readyFrame.reattached = reattached;
  }
  sendUplink(readyFrame);
  sendUplink(usageFrame(sid)); // usage snapshot lands with the prompt
  if (tmuxSession) pushDetached(); // a re-attach just consumed a detached entry
}

// ---- running a tab agent's prompt through Claude on this host ---------------
//
// #364 — Stack's tab agents (Auditor · Curator · Polaris) and the Merge room's
// agent run on CLAUDE now, not on the Gemini API, and this is where they run.
// The server composes the prompt and cannot execute anything: it lives in a
// container and the host firewall drops container→host, so it asks over the
// uplink this daemon already holds open — the same correlated request/reply
// shape as answerPrompt above, and the same shape the autopilot uses to reach
// the CLI. No API key is involved anywhere: this is the owner's own Claude
// subscription through `claude -p`, which is why it satisfies the project's
// standing rule against paid external AI APIs.
//
// THREE THINGS ARE LOAD-BEARING, and all three are about what a prompt that
// arrives over a socket must NOT be able to do:
//
//   • EVERY TOOL IS DISABLED. `--disallowed-tools` names the write and read
//     tools explicitly and `--permission-mode plan` refuses the rest, so the
//     session can only think and answer. An agent prompt is composed from
//     tracker rows, and a tracker row is text somebody else wrote; if a
//     crafted note could talk the model into a Bash call, the note author
//     would have a shell on this host. It cannot, because there is no tool to
//     call. This is deliberately NOT the autopilot's posture — that runs with
//     --dangerously-skip-permissions because it is MEANT to write code, in a
//     throwaway worktree, from a prompt the runner composed itself.
//   • IT RUNS IN A SCRATCH DIRECTORY, never a repo. Combined with the above
//     that is belt and braces, but it means the worst case of a tool slipping
//     through a future CLI change is an empty directory rather than the source.
//   • IT IS BOUNDED. A timeout the server sets, killed on expiry, and the
//     reply says so. A hung `claude` must not silently hold a ✧ button open.
//
// The reply carries the model's text plus what the run COST, because the CLI
// reports it and the agent ledger is the only place the owner can see what
// these buttons spend.
// AGENT_NO_TOOLS and the scratch cwd are pinned in ./agent-run.mjs, not here —
// see that file's header for why.

// The Merge room's agent asks about branches, and the branches are HERE — the
// server has the host's ~10-minute report, not the code. So a claudeAsk may
// carry `diffs: [{ slug, branch }]` and the host appends the real
// `git diff origin/main...<branch>` for each before it asks.
//
// Hard-capped, and the cap SPEAKS. A merge plan can hold forty branches and one
// of them can be a 2,000-line rewrite; a silent truncation would let the model
// answer confidently about a diff it only saw the first tenth of, which is
// worse than not asking. Per branch and overall, and the prompt says which
// branches were shortened and by how much (the #239 rule).
const DIFF_BYTES_PER_BRANCH = 24_000;
const DIFF_BYTES_TOTAL = 140_000;

function gatherDiffs(list) {
  const root = process.env.STACK_AUTOPILOT_ROOT || homedir();
  const out = [];
  let budget = DIFF_BYTES_TOTAL;
  for (const entry of Array.isArray(list) ? list.slice(0, 40) : []) {
    const slug = String(entry?.slug || '').replace(/[^A-Za-z0-9._-]/g, '');
    const branch = String(entry?.branch || '');
    if (!slug || !branch || !/^[\w./-]{1,120}$/.test(branch)) continue;
    const dir = join(root, slug);
    if (!existsSync(join(dir, '.git'))) {
      out.push(`### ${slug}/${branch}\n(no checkout for "${slug}" on this host — not read)`);
      continue;
    }
    const r = spawnSync('git', ['-C', dir, 'diff', `origin/main...${branch}`], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
    });
    if (r.status !== 0) {
      out.push(`### ${slug}/${branch}\n(git could not read this branch on this host — not read)`);
      continue;
    }
    const full = r.stdout || '';
    const room = Math.max(0, Math.min(DIFF_BYTES_PER_BRANCH, budget));
    const body = full.slice(0, room);
    budget -= body.length;
    const cut = full.length - body.length;
    out.push(`### ${slug}/${branch}\n${body}${cut > 0
      ? `\n… TRUNCATED: ${cut} of ${full.length} characters of this diff are NOT shown. Do not assume the unshown part is empty.`
      : ''}`);
    if (budget <= 0) {
      out.push('(the overall diff budget is spent — any branches after this one were not read at all)');
      break;
    }
  }
  return out.join('\n\n');
}

function claudeAsk(m) {
  const id = m.id;
  const done = (ok, out) => sendUplink({ t: 'claudeAnswer', id, ok, ...out });
  let prompt = String(m.prompt || '');
  if (!prompt.trim()) return done(false, { error: 'empty prompt' });
  if (Array.isArray(m.diffs) && m.diffs.length) {
    const body = gatherDiffs(m.diffs);
    // BEFORE the instruction, never after: every op prompt ends on "Respond
    // with ONLY this JSON: {…}", and material appended past that reads as part
    // of the shape instruction. Same rule as the agent preamble.
    prompt = `BRANCH DIFFS, read from git on the host just now:\n\n${body}\n\n---\n\n${prompt}`;
  }

  const args = agentClaudeArgs(prompt, m.model);
  const scratch = agentScratchDir();
  try { mkdirSync(scratch, { recursive: true }); } catch { /* best effort */ }

  const timeoutMs = Math.min(600_000, Math.max(10_000, Number(m.timeoutMs) || 120_000));
  let out = '', err = '', finished = false;
  const child = spawn('claude', args, {
    cwd: existsSync(scratch) ? scratch : homedir(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    log(`agent ask ${id}: timed out after ${Math.round(timeoutMs / 1000)}s`);
    done(false, { error: `claude did not answer within ${Math.round(timeoutMs / 1000)}s on this host` });
  }, timeoutMs);

  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done(false, { error: `could not start claude on this host: ${e.message}` });
  });
  child.on('close', (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    let parsed = null;
    try { parsed = JSON.parse(out); } catch { /* not JSON — reported below */ }
    if (!parsed) {
      return done(false, {
        error: code === 0
          ? 'claude returned something that was not JSON'
          : `claude exited ${code}: ${(err || out).trim().slice(0, 200) || 'no output'}`,
      });
    }
    if (parsed.is_error) {
      return done(false, { error: String(parsed.result || 'claude reported an error').slice(0, 300) });
    }
    log(`agent ask ${id}: ${String(parsed.result || '').length} chars, $${Number(parsed.total_cost_usd || 0).toFixed(4)}`);
    done(true, {
      text: String(parsed.result ?? ''),
      costUsd: Number(parsed.total_cost_usd) || 0,
      model: Object.keys(parsed.modelUsage || {})[0] || '',
    });
  });
}

// ---- on-demand read of one autopilot pane (#366) -----------------------------
//
// Mission Control's fleet detail wants a FRESH read of a stack-auto-* pane,
// not the ~60s-stale cached report pushAuto() sends. This is that — and it is
// the WHOLE reason a stack-auto-* session may be read at all outside the
// periodic push: it captures the pane and nothing else. No sendKeys, no
// send-keys, no kill-session. Autopilot sessions run with
// --dangerously-skip-permissions; giving the browser a write path into one
// here would put it in charge of a session that trusts every keystroke it
// gets, which is exactly the hazard answerPrompt() below exists to avoid for
// stack-term-* sessions in the first place.
//
// Wrapped so a throw here can never take down the message handler — on any
// unexpected failure this replies ok:false with the error rather than going
// silent.
function autoView(m) {
  // Always exactly one reply, every field present, whatever path gets there.
  const done = (ok, out) => sendUplink({
    t: 'autoViewed', id: m.id, ok,
    error: '', name: typeof m.name === 'string' ? m.name : '',
    tail: '', doing: '', idleMs: 0, activityAt: 0, alive: false,
    ...out,
  });
  try {
    if (!tmuxAvailable()) return done(false, { error: 'no tmux on this host' });
    if (typeof m.name !== 'string' || !/^stack-auto-[A-Za-z0-9_-]{1,64}$/.test(m.name)) {
      return done(false, { error: 'that is not an autopilot session name' });
    }
    const s = listAutoSessions().find((x) => x.name === m.name);
    if (!s) {
      // A run that just finished is the NORMAL case here, not an error — the
      // job ended between the fleet strip's last render and this click.
      return done(false, { error: 'that autopilot session is not on this host any more', alive: false });
    }
    const lines = Math.max(20, Math.min(400, Number(m.lines) || 160));
    const tail = paneTail(m.name, lines, { chars: 20_000 });
    const idleMs = s.activity ? Math.max(0, Date.now() - s.activity) : 0;
    const read = readActivity(tail, { idleMs });
    done(true, { tail, doing: read.doing, idleMs, activityAt: s.activity, alive: true });
  } catch (e) {
    done(false, { error: e?.message || 'the host could not read that pane' });
  }
}

// ---- answering a permission prompt from Mission Control ---------------------
//
// The only path by which anything other than a human at the keyboard types
// into a running session, so it is deliberately the most suspicious code here.
//
// The hazard is staleness, not authorisation: the row the human clicked was
// drawn from a pane read up to twenty seconds ago, and in those twenty seconds
// the session may have been answered at the keyboard and moved on to a
// different question — or to no question at all, with a text input where the
// menu used to be. Typing "1" into that is a stray digit in someone's prompt.
//
// So the host does not trust the request. It re-reads the pane NOW, and refuses
// unless the prompt it finds is byte-for-byte the one the human was answering
// (fingerprint covers the question, the options AND the body, so "yes to
// `rm -rf build`" cannot land on whatever replaced it). Then it looks again a
// beat later and reports what actually happened rather than assuming.
function answerPrompt(m) {
  const done = (ok, error, state) => sendUplink({ t: 'answered', id: m.id, ok, error: error || '', state: state || '' });
  if (!tmuxAvailable()) return done(false, 'no tmux on this host');
  if (!validName(m.name) || !listStackSessions().some((s) => s.name === m.name)) {
    return done(false, 'that session is not on this host any more');
  }
  const p = detectPrompt(paneTail(m.name));
  if (!p) return done(false, 'nothing is waiting — that prompt has already been answered');
  if (p.fingerprint !== m.fingerprint) {
    return done(false, 'the session has moved on to a different prompt — read it again');
  }

  // Approve types the number of the PLAIN yes. Never the "and don't ask again"
  // variant: widening a permission for the rest of a session is a decision the
  // human has to make at the keyboard, where they can see what they are
  // widening. Deny is Escape — Claude's own hint for cancelling the prompt, and
  // the one keystroke that cannot mean anything else if the pane has changed
  // under us between the check above and the write below.
  const r = m.choice === 'approve'
    ? sendKeys(m.name, [String(p.yes)], { literal: true })
    : sendKeys(m.name, ['Escape']);
  if (!r.ok) return done(false, r.error);
  log(`${m.choice === 'approve' ? 'approved' : 'denied'} a prompt in ${m.name}: ${p.question}`);

  // Did it take? Claude redraws within a frame or two. Reporting "still up"
  // beats reporting success and leaving the human to notice on the next push
  // that nothing moved.
  setTimeout(() => {
    const after = detectPrompt(paneTail(m.name));
    const state = !after ? 'cleared' : after.fingerprint === p.fingerprint ? 'still-up' : 'next-prompt';
    done(true, '', state);
    blockedKey = ''; // force the next watch tick to re-push
    pushDetached();
  }, 700);
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
    pushEdits();    // …and who is mid-edit in which file right now
    pushAuto();     // …and the autopilot pane report (#366) — without this the
                     // relay's cache is empty for up to a minute after every
                     // reconnect/redeploy, reading as an unseen fleet

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
    else if (m.t === 'keepSession') {
      // #292 — pin or unpin a session against the idle reaper. Unlike
      // killDetached this is allowed on an ATTACHED session too: pinning the
      // tab you are working in is the main case, and the pin only ever DECLINES
      // to destroy something, so there is nothing here for one browser to do to
      // another's session that it would mind. Any stack-term-* name the host
      // actually has is fair game; anything else is refused.
      const want = m.keep === true;
      if (validName(m.name) && listStackSessions().some((s) => s.name === m.name)) {
        const r = setKeep(m.name, want);
        log(r.ok
          ? `${want ? 'pinned' : 'unpinned'} ${m.name} (browser request)`
          : `could not ${want ? 'pin' : 'unpin'} ${m.name}: ${r.error}`);
      } else {
        log(`refused keep request for unknown session ${m.name}`);
      }
      pushDetached();
    }
    else if (m.t === 'answerPrompt') answerPrompt(m);
    else if (m.t === 'claudeAsk') claudeAsk(m);
    else if (m.t === 'autoView') autoView(m);
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
