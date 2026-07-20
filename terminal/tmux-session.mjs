// Stack terminal — tmux session lifecycle helpers.
//
// Used by stack-term.mjs to run claude sessions inside named tmux sessions so
// they survive browser disconnects. The PTY the browser sees is always a
// `tmux new-session -A` process; when the attach exits (browser disconnect →
// pty-shim dies → HUP to tmux client), the underlying tmux session (and the
// claude process inside it) keeps running. A reconnect re-attaches by passing
// the same session name in the start frame.
//
// All functions are synchronous (spawnSync) so they can be called inline in
// the session start path without restructuring the async-free event loop.
// When tmux is not installed, tmuxAvailable() returns false and the daemon
// falls back to the existing direct-spawn path.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// Cached tmux presence check — one fork per daemon restart, not per session.
let _tmuxAvailable = null;
export function tmuxAvailable() {
  if (_tmuxAvailable !== null) return _tmuxAvailable;
  _tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
  return _tmuxAvailable;
}

// Validate a tmux session name arriving from the browser.
// Requires the stack- prefix (prevents attaching to arbitrary user sessions)
// and excludes tmux target-syntax characters (: . % =) that would alter the
// -t interpretation.
export function validName(name) {
  return typeof name === 'string' && /^stack-[A-Za-z0-9_-]{1,64}$/.test(name);
}

// Generate a unique session name with a random suffix so same-second starts
// (e.g. page reload) don't collide.
// prefix should be a short alphanumeric string ('term', 'auto', etc.).
export function generateName(prefix) {
  return `stack-${prefix}-${randomBytes(4).toString('hex')}`;
}

// Check if a named tmux session exists. Uses the = exact-match prefix to
// prevent prefix-matching: without it, `stack-auto-item1` would match
// `stack-auto-item17`.
export function sessionExists(name) {
  return spawnSync('tmux', ['has-session', '-t', `=${name}`], { stdio: 'ignore' }).status === 0;
}

// Returns the argv array to pass to pty-shim.py for a tmux session.
// -A means: attach to the named session if it exists, otherwise create it.
// This handles both the "new session" and "re-attach" cases in one command,
// eliminating the race between separate create + attach calls.
// shellCmd is a single string that tmux passes to sh -c (tmux's convention
// for one-arg shell commands; multi-arg joining varies between versions).
export function sessionArgv(name, cwd, shellCmd) {
  return ['tmux', 'new-session', '-A', '-s', name, '-c', cwd, shellCmd];
}

// Kill a named tmux session — used on idle timeout to prevent zombie sessions
// accumulating on the host. Uses = exact-match prefix (same reason as above).
export function killSession(name) {
  spawnSync('tmux', ['kill-session', '-t', `=${name}`], { stdio: 'ignore' });
}
