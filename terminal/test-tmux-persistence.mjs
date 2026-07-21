#!/usr/bin/env node
// Automated persistence test for the web terminal's tmux session lifecycle.
//
// Mirrors the daemon's exact spawn path (pty-shim → tmux new-session -A) to
// verify that killing the shim (what happens when a browser tab closes) leaves
// the underlying tmux session alive — the whole point of tmux persistence.
//
// Exits 0 on pass, 1 on failure. Prints "skipped" and exits 0 if tmux is not
// installed. Always cleans up the test session even on failure.
//
// Run: node terminal/test-tmux-persistence.mjs

import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  tmuxAvailable, generateName, sessionExists, sessionArgv, killSession,
} from './tmux-session.mjs';

const SHIM = join(dirname(fileURLToPath(import.meta.url)), 'pty-shim.py');
const HOME = homedir();

const log = (msg) => console.log(`[tmux-test] ${msg}`);
const fail = (msg) => { console.error(`[tmux-test] FAIL: ${msg}`); process.exit(1); };

// Poll until predicate returns true or timeout expires. Returns true/false.
function poll(fn, timeoutMs = 5000, intervalMs = 200) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (fn()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, intervalMs);
    };
    check();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

if (!tmuxAvailable()) {
  console.log('[tmux-test] skipped: tmux is not installed on this host');
  process.exit(0);
}

const name = generateName('test');
log(`session name: ${name}`);

// Always clean up on exit so failed runs don't leave zombie sessions.
process.on('exit', () => { try { killSession(name); } catch { /* ignore */ } });

// ── Phase 1: create a tmux session via the pty-shim (same path as the daemon) ──
// Use `sleep 60` so the inner process is idle (won't exit while we test).
log('phase 1: spawning shim → tmux new-session -A with sleep 60');
const argv1 = sessionArgv(name, HOME, 'sleep 60');
const child1 = spawn('python3', [SHIM, HOME, ...argv1], {
  stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
});

const ready1 = await poll(() => sessionExists(name));
if (!ready1) fail('tmux session did not appear within 5s');
log(`session exists: ${name}`);

// ── Phase 2: kill the shim — the daemon's exact browser-disconnect path ──
log('phase 2: SIGTERM the shim (simulates browser tab close)');
child1.kill('SIGTERM');
await new Promise((r) => child1.on('exit', r));

// Give tmux a brief moment to process the client HUP.
await sleep(400);

const survived = sessionExists(name);
if (!survived) fail('tmux session was destroyed when the shim exited — persistence broken');
log('session survived shim exit ✓');

// ── Phase 3: re-attach via a new shim (simulates browser reconnect) ──
log('phase 3: re-attaching via a second shim');
const argv2 = sessionArgv(name, HOME, 'sleep 60');
const child2 = spawn('python3', [SHIM, HOME, ...argv2], {
  stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
});

// Verify the second shim actually attached a client to the session (not just
// that the session exists — that was already true from phase 1).
const hasClient = () => {
  const r = spawnSync('tmux', ['list-clients', '-t', `=${name}`], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() !== '';
};
const reattached = await poll(hasClient);
if (!reattached) fail('second shim did not attach a client to the surviving session within 5s');
log('re-attach succeeded ✓');

child2.kill('SIGTERM');
await new Promise((r) => child2.on('exit', r));

// ── Phase 4: explicit cleanup ──
log('phase 4: killing session for cleanup');
killSession(name);
await sleep(300);
if (sessionExists(name)) fail('cleanup failed — session still exists after kill');
log('session cleaned up ✓');

console.log('[tmux-test] PASS — tmux session persists through browser disconnect and accepts re-attach');
process.exit(0);
