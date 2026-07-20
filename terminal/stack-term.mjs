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
// Config (~/.stack/env or real env):
//   STACK_API                 the app origin, e.g. https://stack.example (required)
//   STACK_TOKEN               the API token the agent connects with (required)
//   STACK_TERM_ROOT           cwd jail, default $HOME
//   STACK_TERM_IDLE_MINUTES   kill a silent session after this, default 240
//   STACK_TERM_MAX_SESSIONS   default 8
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
import WebSocket from 'ws';
import { createUsageMeter } from './usage-meter.mjs';
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

const API = (process.env.STACK_API || '').replace(/\/$/, '');
const TOKEN = process.env.STACK_TOKEN || '';
if (!API || !TOKEN) {
  console.error('[stack-term] STACK_API and STACK_TOKEN are required (~/.stack/env).');
  process.exit(1);
}
const AGENT_URL = API.replace(/^http/, 'ws') + '/term-agent';
const ROOT = realpathSync(process.env.STACK_TERM_ROOT || homedir());
const IDLE_MS = (parseInt(process.env.STACK_TERM_IDLE_MINUTES || '', 10) || 240) * 60_000;
const MAX_SESSIONS = parseInt(process.env.STACK_TERM_MAX_SESSIONS || '', 10) || 8;
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
  limitResetAt = parseReset(plainTail) || Date.now() + 4 * 3_600_000; // unparseable → the runner's +4h guess
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

  // Two commands only. `claude` goes through a login shell so the user's PATH
  // (nvm, ~/.local/bin, …) applies — same environment as sitting at the box.
  const argv = msg.cmd === 'claude'
    ? ['/bin/bash', '-lc', 'exec claude']
    : [process.env.SHELL || '/bin/bash', '-l'];

  const child = spawn('python3', [SHIM, cwd, ...argv], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], // fd3 = resize control
  });

  const sess = {
    outBuf: { chunks: [], bytes: 0 },
    cwd,
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

  sendUplink({ t: 'ready', sid, cwd: cwd === ROOT ? '~' : '~/' + cwd.slice(ROOT.length + 1) });
  sendUplink(usageFrame(sid)); // usage snapshot lands with the prompt
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
  // each tick only parses transcript bytes appended since the last one.
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
    else if (m.t === 'kill') {
      if (sess?.switchMode) {
        // Browser tab closed during the switch prompt — clean up gracefully.
        clearTimeout(sess.switchMode.timeout);
        sessions.delete(m.sid);
        log(`session ${m.sid} switch prompt killed by browser`);
      } else if (child) {
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
