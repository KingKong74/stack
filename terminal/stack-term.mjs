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

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

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

// ---- sessions (sid -> child) ----
const sessions = new Map();

function startSession(ws, msg) {
  const { sid } = msg;
  const fail = (m) => { ws.send(JSON.stringify({ t: 'err', sid, msg: m })); ws.send(JSON.stringify({ t: 'exit', sid, code: 1 })); };
  const cwd = resolveCwd(msg.cwd);
  if (!cwd) return fail(`No such directory under ${ROOT}.`);
  if (sessions.size >= MAX_SESSIONS) return fail('Too many live sessions.');

  // Two commands only. `claude` goes through a login shell so the user's PATH
  // (nvm, ~/.local/bin, …) applies — same environment as sitting at the box.
  const argv = msg.cmd === 'claude'
    ? ['/bin/bash', '-lc', 'exec claude']
    : [process.env.SHELL || '/bin/bash', '-l'];

  const child = spawn('python3', [SHIM, cwd, ...argv], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], // fd3 = resize control
  });
  sessions.set(sid, child);
  log(`session ${sid} up (${sessions.size} live): ${msg.cmd === 'claude' ? 'claude' : 'shell'} in ${cwd}`);

  let lastActivity = Date.now();
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_MS) {
      ws.send(JSON.stringify({ t: 'err', sid, msg: 'Session closed after inactivity.' }));
      child.kill('SIGTERM');
    }
  }, 60_000);

  child.resize = (cols, rows) => {
    const c = Math.max(2, Math.min(500, cols | 0));
    const r = Math.max(2, Math.min(300, rows | 0));
    try { child.stdio[3].write(`R ${c} ${r}\n`); } catch { /* gone */ }
  };
  child.feed = (b64) => { lastActivity = Date.now(); child.stdin.write(Buffer.from(b64, 'base64')); };
  if (msg.cols && msg.rows) child.resize(msg.cols, msg.rows);

  // Data frames carry base64 — JSON-safe, and the browser hands the raw bytes
  // to xterm so UTF-8 renders correctly.
  const out = (d) => {
    lastActivity = Date.now();
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'out', sid, data: d.toString('base64') }));
  };
  child.stdout.on('data', out);
  child.stderr.on('data', out);
  child.on('exit', (code) => {
    clearInterval(idleTimer);
    sessions.delete(sid);
    log(`session ${sid} down (${sessions.size} live), exit ${code}`);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'exit', sid, code: code ?? 0 }));
  });
  child.on('error', (e) => { clearInterval(idleTimer); sessions.delete(sid); fail(e.message); });

  ws.send(JSON.stringify({ t: 'ready', sid, cwd: cwd === ROOT ? '~' : '~/' + cwd.slice(ROOT.length + 1) }));
}

// ---- the one outbound agent connection, kept alive forever ----
let backoff = 5_000;
function connect() {
  const ws = new WebSocket(AGENT_URL, { headers: { authorization: `Bearer ${TOKEN}` } });

  ws.on('open', () => { backoff = 5_000; log(`connected to ${API}`); });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const child = sessions.get(m.sid);
    if (m.t === 'start') startSession(ws, m);
    else if (m.t === 'in' && child && typeof m.data === 'string') child.feed(m.data);
    else if (m.t === 'resize' && child) child.resize(m.cols, m.rows);
    else if (m.t === 'kill' && child) child.kill('SIGTERM');
  });
  // error and close can both fire (and a failed handshake may emit only
  // error) — whichever lands first schedules the single reconnect.
  let retried = false;
  const retry = () => {
    if (retried) return;
    retried = true;
    for (const child of sessions.values()) child.kill('SIGTERM');
    sessions.clear();
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  };
  ws.on('close', () => { log('disconnected — retrying'); retry(); });
  ws.on('error', (e) => { log(`connection error: ${e.message}`); retry(); try { ws.terminate(); } catch { /* already gone */ } });
}
connect();
log(`agent for ${API} (root ${ROOT})`);
