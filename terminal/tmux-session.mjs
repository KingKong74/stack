// tmux 3.x gotcha: set-option's -t is a target-PANE, so a SESSION user option
// needs the `=name:` target form — a bare `=name` fails on a session that
// plainly exists.
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
// The trailing command sequence (`;` args) turns mouse mode on server-wide —
// without it the wheel can't scroll: tmux repaints a fixed viewport, so the
// outer xterm never accumulates scrollback; with it, wheel-up scrolls tmux's
// own history in copy-mode. history-limit raises the ceiling for panes
// created after the first (the global default is only 2000 lines).
//
// set-clipboard is the other half of that trade. Mouse mode means a plain drag
// is TMUX's selection, not xterm's — it lands in a tmux paste buffer the
// browser cannot see, which is what "I highlighted it and nothing copied"
// actually was. The default (`external`) only forwards OSC 52 that an
// application inside tmux emits; `on` makes tmux emit its OWN copies too, so a
// copy-mode selection reaches the browser, where lib/termClipboard turns the
// escape into a real clipboard write. The terminal has to advertise the
// capability for tmux to bother: TERM is xterm-256color (pty-shim), whose
// terminfo carries Ms, and the terminal-features append covers any host whose
// terminfo does not.
export function sessionArgv(name, cwd, shellCmd) {
  return ['tmux', 'new-session', '-A', '-s', name, '-c', cwd, shellCmd,
    ';', 'set-option', '-g', 'mouse', 'on',
    ';', 'set-option', '-g', 'set-clipboard', 'on',
    ';', 'set-option', '-as', 'terminal-features', ',*:clipboard',
    ';', 'set-option', '-g', 'history-limit', '20000'];
}

// Kill a named tmux session — used on idle timeout to prevent zombie sessions
// accumulating on the host. Uses = exact-match prefix (same reason as above).
export function killSession(name) {
  spawnSync('tmux', ['kill-session', '-t', `=${name}`], { stdio: 'ignore' });
}

// Last visible lines of a session's active pane — plain text (capture-pane
// without -e emits no escape sequences). Feeds the Gemini labeller so even a
// detached session can be named by what it's doing. Empty string on any miss.
//
// `chars` defaults to 1500 — right for the 60s push, which rides in every
// periodic frame — but an on-demand read (#366's autoView) wants far more, so
// it's a third optional parameter rather than a second hard cap. Existing
// callers that pass only `name`/`lines` are byte-for-byte unchanged.
export function paneTail(name, lines = 30, { chars = 1500 } = {}) {
  // `=name:` — exact-match session (same reason as sessionExists), trailing
  // colon so tmux parses it as a pane target (bare `=name` doesn't).
  const r = spawnSync(
    'tmux',
    ['capture-pane', '-p', '-t', `=${name}:`, '-S', `-${lines}`],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return '';
  return (r.stdout || '').replace(/\s+$/, '').slice(-chars);
}

// Type into a session's pane. The ONLY writer into a running session that is
// not the browser's own PTY, and it exists for exactly one caller: answering a
// permission prompt from Mission Control (prompt-scan.mjs).
//
// `literal` decides how tmux reads what it is given — `-l` sends the string as
// keystrokes ('1' is the character one), without it tmux resolves key NAMES
// ('Escape', 'Enter'). Sending a digit non-literally would have tmux hunt for a
// key called "1"; sending 'Escape' literally would type the six letters.
//
// Same `=name:` exact-target rule as everything else here, and the same reason.
export function sendKeys(name, keys, { literal = false } = {}) {
  const args = ['send-keys', '-t', `=${name}:`];
  if (literal) args.push('-l');
  const r = spawnSync('tmux', [...args, ...keys], { encoding: 'utf8' });
  if (r.status === 0) return { ok: true };
  return { ok: false, error: (r.stderr || '').trim() || 'tmux refused the keys' };
}

// (#292) The KEEP PIN — "the reaper must not take this one".
//
// It lives as a tmux user option ON THE SESSION rather than in a store of the
// daemon's own, and that is the whole point: the state sits where the thing it
// describes sits. A daemon restart, a browser reload, a re-attach from another
// device — none of them can drift from it, because there is nothing to drift.
// It dies exactly when the session does.
//
// User options need tmux 3.0+ (2019). Older tmux fails the set, and setKeep
// reports that rather than returning quietly: a pin that silently did nothing
// would be worse than no pin at all, since the session would read as protected
// and be reaped anyway.
export function setKeep(name, keep) {
  // `=name:` — exact-match session, trailing colon so tmux reads it as a PANE
  // target. set-option's -t is a target-pane in tmux 3.x (options can be
  // pane-scoped), so a bare `=name` fails with "no such session" even though
  // the session plainly exists. Same trap paneTail() already documents.
  const args = keep
    ? ['set-option', '-t', `=${name}:`, '@stack-keep', '1']
    : ['set-option', '-t', `=${name}:`, '-u', '@stack-keep'];
  const r = spawnSync('tmux', args, { encoding: 'utf8' });
  if (r.status === 0) return { ok: true };
  return { ok: false, error: (r.stderr || '').trim() || 'tmux refused the option' };
}

// List every stack-term-* tmux session on the host — the web daemon's own and
// any started by hand (ssh + `stack term`), with whether a client is attached
// anywhere. Only stack-term-* names: autopilot/test sessions are not the
// browser's to view, mirror or kill. created is epoch ms; path is the
// session's start directory on the host.
export function listStackSessions() {
  const r = spawnSync(
    'tmux',
    ['list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{session_created}\t#{session_path}\t#{session_activity}\t#{@stack-keep}'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return []; // no server running = no sessions
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const [name, attached, created, path, activity, keep] = line.split('\t');
    // One strict pattern (#218: #199) instead of the old two-step
    // validName() + startsWith() pair, whose rules could drift apart.
    if (typeof name !== 'string' || !/^stack-term-[A-Za-z0-9_-]{1,64}$/.test(name)) continue;
    out.push({
      name,
      attached: attached !== '0',
      created: (parseInt(created, 10) || 0) * 1000,
      path: path || '',
      // #287 — when the session last produced output, epoch ms. tmux bumps
      // this on real pane activity, so it measures whether WORK is happening
      // rather than whether a tab happens to be open.
      activity: (parseInt(activity, 10) || 0) * 1000,
      // #292 — the keep pin, read straight off the session that carries it.
      keep: keep === '1',
    });
  }
  return out;
}

// The subset with no client attached — what a page reload orphans, and the
// only names the browser's kill request may touch.
export function listDetached() {
  return listStackSessions().filter((s) => !s.attached);
}

// List every stack-auto-* tmux session on the host (#366) — the autopilot
// runner's own sessions, spawned by scripts/stack-autopilot-dispatch.mjs.
// An exact sibling of listStackSessions() above: same single tmux
// list-sessions call, same format string, same shape — only the name pattern
// differs.
//
// THIS LIST IS FOR READING A PANE, NEVER FOR MIRRORING, KILLING OR REAPING.
// listStackSessions() stays stack-term-* only on purpose — the web
// terminal's mirror/kill/reap paths all read it, and an autopilot session run
// with --dangerously-skip-permissions is not the browser's to touch that way.
// This sibling exists solely so the daemon can capture-pane a stack-auto-*
// session for Mission Control's fleet view.
export function listAutoSessions() {
  const r = spawnSync(
    'tmux',
    ['list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{session_created}\t#{session_path}\t#{session_activity}\t#{@stack-keep}'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return []; // no server running = no sessions
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const [name, attached, created, path, activity, keep] = line.split('\t');
    if (typeof name !== 'string' || !/^stack-auto-[A-Za-z0-9_-]{1,64}$/.test(name)) continue;
    out.push({
      name,
      attached: attached !== '0',
      created: (parseInt(created, 10) || 0) * 1000,
      path: path || '',
      activity: (parseInt(activity, 10) || 0) * 1000,
      keep: keep === '1',
    });
  }
  return out;
}

// Garbage-collect truly dead sessions (#197): a detached stack-term-* session
// whose active pane is DEAD — the process inside already exited, tmux is just
// holding the corpse (remain-on-exit leftovers and crashed shims). Detached
// sessions with a LIVE process are never touched: a walked-away claude session
// is a feature (#188), not a leak. Returns the names reaped.
export function reapDeadSessions() {
  const r = spawnSync(
    'tmux',
    ['list-panes', '-a', '-F', '#{session_name}\t#{session_attached}\t#{pane_dead}'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return [];
  const reaped = [];
  for (const line of r.stdout.split('\n')) {
    const [name, attached, dead] = line.split('\t');
    if (typeof name !== 'string' || !/^stack-term-[A-Za-z0-9_-]{1,64}$/.test(name)) continue;
    if (attached !== '0' || dead !== '1') continue;
    killSession(name);
    reaped.push(name);
  }
  return reaped;
}

// (#287) Reap sessions that have gone QUIET — no pane activity for `hours`.
//
// This is a deliberate narrowing of #188's "a walked-away claude session is
// sacred". It still is, for hours; it is not forever. What #188 protects is
// work in progress surviving a closed laptop, and a session that has produced
// nothing for six hours is not that — it is a shell holding memory and, for
// claude, a context nobody is coming back to.
//
// Idleness is measured by tmux's own session_activity (real output), NOT by
// whether a client is attached: a browser tab left open overnight is exactly
// the case this exists for, and treating "attached" as "in use" would exempt
// it. The browser is told — killing the session ends the shim, which sends the
// exit frame the UI already handles — so a reaped tab reads as ended rather
// than silently going dead.
//
// Only stack-term-* names are ever considered, so the autopilot's own
// stack-auto-* sessions are untouched by construction: a build night is
// legitimately quiet for long stretches while a model thinks.
//
// `hours` <= 0 means never. Returns [{ name, idleHours }] for the log.
export function reapIdleSessions(hours) {
  if (!(hours > 0)) return [];
  const cutoff = Date.now() - hours * 3600_000;
  const reaped = [];
  for (const s of listStackSessions()) {
    // #292 — the keep pin exempts a session outright. A session parked
    // mid-investigation, or one waiting out a usage-limit reset, looks exactly
    // like an abandoned one to session_activity; this is the only way to say
    // which it is, and saying it must beat guessing at it.
    if (s.keep) continue;
    // activity 0 = tmux told us nothing; refuse to guess rather than kill on a
    // missing timestamp.
    if (!s.activity || s.activity > cutoff) continue;
    killSession(s.name);
    reaped.push({ name: s.name, idleHours: Math.round((Date.now() - s.activity) / 3600_000 * 10) / 10 });
  }
  return reaped;
}
