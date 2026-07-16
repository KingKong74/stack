#!/usr/bin/env node
// Stack web terminal — the host-side PTY daemon (#/terminal in the web app).
//
// A small websocket server that spawns a real shell (or a claude session) in a
// project directory on THIS machine and streams it to xterm.js in the browser.
// The web container's nginx proxies /term here, so the browser only ever talks
// to the app's own origin.
//
// Trust model
//   • Every connection must present a bearer before anything spawns. The token
//     is validated AGAINST THE STACK API (GET /api/settings), so both the API
//     token and PIN-minted device tokens work, and revocation is respected.
//     Valid tokens are cached for 60s; the token itself is never logged.
//   • The working directory is jailed to STACK_TERM_ROOT (default: $HOME) —
//     a cwd resolving outside it is refused.
//   • Only two commands exist: an interactive login shell, or claude. There is
//     no arbitrary-exec frame.
//   • Bind address defaults to 0.0.0.0 (auth still gates every session); set
//     STACK_TERM_BIND to the docker bridge gateway to hide it from the LAN.
//
// The PTY itself comes from pty-shim.py (python3 stdlib) — no native node
// modules, so the daemon installs with plain `npm install` anywhere.
//
// Install (once, on the host):
//   cd terminal && npm install
//   node stack-term.mjs                       # foreground
//   (crontab) @reboot cd /home/you/stack/terminal && node stack-term.mjs >> ~/.stack/term.log 2>&1
//
// Config (~/.stack/env or real env):
//   STACK_API                 the API base the web app uses (token validation)
//   STACK_TERM_PORT           default 7703
//   STACK_TERM_BIND           default 0.0.0.0
//   STACK_TERM_ROOT           cwd jail, default $HOME
//   STACK_TERM_IDLE_MINUTES   kill a silent session after this, default 240
//   STACK_TERM_MAX_SESSIONS   default 8

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

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

const API = (process.env.STACK_API || 'http://localhost:8787').replace(/\/$/, '');
const PORT = parseInt(process.env.STACK_TERM_PORT || '', 10) || 7703;
const BIND = process.env.STACK_TERM_BIND || '0.0.0.0';
const ROOT = realpathSync(process.env.STACK_TERM_ROOT || homedir());
const IDLE_MS = (parseInt(process.env.STACK_TERM_IDLE_MINUTES || '', 10) || 240) * 60_000;
const MAX_SESSIONS = parseInt(process.env.STACK_TERM_MAX_SESSIONS || '', 10) || 8;
const SHIM = join(dirname(fileURLToPath(import.meta.url)), 'pty-shim.py');

const log = (...a) => console.log(`[stack-term] ${new Date().toISOString()}`, ...a);

// ---- token validation against the Stack API (60s cache, hash-keyed) ----
const okTokens = new Map(); // token -> expiry ms
async function tokenValid(token) {
  if (!token) return false;
  const hit = okTokens.get(token);
  if (hit && hit > Date.now()) return true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${API}/api/settings`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.status === 200) {
      okTokens.set(token, Date.now() + 60_000);
      return true;
    }
  } catch { /* unreachable API = refuse; a terminal fails CLOSED */ }
  return false;
}

// ---- cwd jail ----
function resolveCwd(raw) {
  const want = resolve(ROOT, String(raw || '').replace(/^[/\\]+/, ''));
  let real;
  try { real = realpathSync(want); } catch { return null; }
  if (real !== ROOT && !real.startsWith(ROOT + sep)) return null;
  try { if (!statSync(real).isDirectory()) return null; } catch { return null; }
  return real;
}

// ---- sessions ----
let sessions = 0;

function startSession(ws, msg) {
  const cwd = resolveCwd(msg.cwd);
  if (!cwd) { ws.send(JSON.stringify({ t: 'err', msg: `No such directory under ${ROOT}.` })); ws.close(); return; }
  if (sessions >= MAX_SESSIONS) { ws.send(JSON.stringify({ t: 'err', msg: 'Too many live sessions.' })); ws.close(); return; }

  // Two commands only. `claude` goes through a login shell so the user's PATH
  // (nvm, ~/.local/bin, …) applies — same environment as sitting at the box.
  const argv = msg.cmd === 'claude'
    ? ['/bin/bash', '-lc', 'exec claude']
    : [process.env.SHELL || '/bin/bash', '-l'];

  const child = spawn('python3', [SHIM, cwd, ...argv], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], // fd3 = resize control
    detached: false,
  });
  sessions++;
  log(`session up (${sessions} live): ${msg.cmd === 'claude' ? 'claude' : 'shell'} in ${cwd}`);

  let lastActivity = Date.now();
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_MS) {
      ws.send(JSON.stringify({ t: 'err', msg: 'Session closed after inactivity.' }));
      child.kill('SIGTERM');
    }
  }, 60_000);

  const resize = (cols, rows) => {
    const c = Math.max(2, Math.min(500, cols | 0));
    const r = Math.max(2, Math.min(300, rows | 0));
    try { child.stdio[3].write(`R ${c} ${r}\n`); } catch { /* gone */ }
  };
  if (msg.cols && msg.rows) resize(msg.cols, msg.rows);

  // Data frames carry base64 — JSON-safe, and the browser hands the raw bytes
  // to xterm so UTF-8 renders correctly.
  child.stdout.on('data', (d) => {
    lastActivity = Date.now();
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'out', data: d.toString('base64') }));
  });
  child.stderr.on('data', (d) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'out', data: d.toString('base64') }));
  });
  child.on('exit', (code) => {
    clearInterval(idleTimer);
    sessions--;
    log(`session down (${sessions} live), exit ${code}`);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'exit', code: code ?? 0 }));
      ws.close();
    }
  });
  child.on('error', (e) => {
    clearInterval(idleTimer);
    if (ws.readyState === ws.OPEN) { ws.send(JSON.stringify({ t: 'err', msg: e.message })); ws.close(); }
  });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === 'in' && typeof m.data === 'string') {
      lastActivity = Date.now();
      child.stdin.write(Buffer.from(m.data, 'base64'));
    } else if (m.t === 'resize') {
      resize(m.cols, m.rows);
    }
  });
  ws.on('close', () => child.kill('SIGTERM'));

  ws.send(JSON.stringify({ t: 'ready', cwd: cwd === ROOT ? '~' : '~/' + cwd.slice(ROOT.length + 1) }));
}

// ---- server ----
const http = createServer((_req, res) => { res.writeHead(200); res.end('stack-term\n'); });
const wss = new WebSocketServer({ server: http, path: '/term' });

wss.on('connection', (ws) => {
  // First frame must be a valid start within 10s, or the socket goes away.
  const gate = setTimeout(() => ws.close(), 10_000);
  ws.once('message', async (raw) => {
    clearTimeout(gate);
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { ws.close(); return; }
    if (msg.t !== 'start' || !(await tokenValid(msg.token))) {
      ws.send(JSON.stringify({ t: 'err', msg: 'Not authorised.' }));
      ws.close();
      return;
    }
    delete msg.token; // never keep it around
    startSession(ws, msg);
  });
});

http.listen(PORT, BIND, () => log(`listening on ${BIND}:${PORT} (root ${ROOT}, api ${API})`));
