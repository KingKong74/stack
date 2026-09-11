#!/usr/bin/env node
// THE TERMINAL'S SESSION LIFECYCLE AND ITS THREE REAPERS, tested against the
// REAL terminal/tmux-session.mjs and a FAKE tmux on PATH.
//
//   node server/test/tmux-session.test.mjs     # exits non-zero on any failure
//
// No database, no API, no daemon, and — deliberately — NO REAL TMUX. Every
// function under test here can kill a session, and this host is shared: the
// owner's own long-running claude sessions live in `stack-term-*` names, which
// is exactly the namespace the reapers hunt in. A test that stood up real
// sessions to reap would be one bad predicate away from taking a real one.
//
// So PATH is pointed at a fake `tmux` that this file writes at startup. It is
// not a stub: it keeps STATE in a JSON fixture, answers the real format
// strings, applies `kill-session` and `set-option` to that state, and logs
// every argv it was called with. That buys three things a mock could not:
//
//   • THE ARGV IS UNDER TEST, not just the return value. tmux 3.x's
//     set-option/-t is a target-PANE, so a session user option needs the
//     `=name:` form and a bare `=name` fails on a session that plainly exists.
//     tmux-session.mjs documents that trap in four separate places, which is
//     what happens when a rule has no test. It has one now.
//   • THE RESULTING STATE IS UNDER TEST. "the fresh mark comes off an attached
//     session" is a claim about what the tmux server ends up holding, and the
//     fake holds it.
//   • THE NUMBER OF CALLS IS UNDER TEST. See section K.
//
// WHY THIS SUITE EXISTS AT ALL. These are the app's only self-destructive
// paths, and CLAUDE.md's fail-safe rule says which way each must fail: an
// unknown threshold reaps NOTHING. Most of what follows is that one sentence,
// asserted from every direction a caller can approach it — 0 hours, a null the
// API never answered, a missing timestamp, a session the daemon did not make.
// A regression in any of them does not throw or look wrong on a screen. It
// quietly kills a session somebody was using, and the first anyone knows is a
// context that is gone.
//
// VALIDATED BY MUTATION, because a suite that passes on its first run has
// proved nothing. Eight regressions were introduced into tmux-session.mjs on
// purpose and this file was run against each:
//
//   the idle reaper forgets the keep pin          → 1 fail
//   the fuse forgets the keep pin                 → 2 fails
//   `!(minutes > 0)` becomes `minutes === 0`      → 1 fail  (null reaps again)
//   the fuse stops clearing the mark on attached  → 2 fails
//   setKeep drops the pane-target colon           → 2 fails
//   the fuse guesses on a missing created stamp   → 1 fail
//   listStackSessions widens to stack-auto-*      → 4 fails
//   the sweep re-reads the host per session       → 1 fail  (the N+1, section H)
//
// Seven of the eight are a reaper killing something it must not. That ratio is
// the point: this is not a suite about tmux, it is a suite about the fail-safe
// direction.
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'stack-tmux-test-'));
const STATE = join(DIR, 'state.json');
const CALLS = join(DIR, 'calls.log');

// ---- the fake tmux ---------------------------------------------------------
//
// Written to disk rather than imported, because the thing under test reaches
// it the way the daemon does: `spawnSync('tmux', …)` through PATH. Anything
// short of a real executable would be testing a different code path from the
// one that runs.
const FAKE = `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const STATE = process.env.FAKE_TMUX_STATE;
const CALLS = process.env.FAKE_TMUX_CALLS;
const argv = process.argv.slice(2);
appendFileSync(CALLS, JSON.stringify(argv) + '\\n');
const s = JSON.parse(readFileSync(STATE, 'utf8'));
const save = () => writeFileSync(STATE, JSON.stringify(s));
const cmd = argv[0];

// "=name" and "=name:" both name one session; the trailing colon is tmux's
// pane-target form. The fake accepts either and the TEST asserts which was
// used — getting that backwards is the bug this file exists to catch.
const target = (t) => String(t || '').replace(/^=/, '').replace(/:$/, '');
const find = (t) => s.sessions.find((x) => x.name === target(t));

const fill = (fmt, x) => fmt
  .replace(/#\\{session_name\\}/g, x.name)
  .replace(/#\\{session_attached\\}/g, String(x.attached ?? 0))
  .replace(/#\\{session_created\\}/g, String(x.created ?? 0))
  .replace(/#\\{session_path\\}/g, x.path ?? '')
  .replace(/#\\{session_activity\\}/g, String(x.activity ?? 0))
  .replace(/#\\{pane_dead\\}/g, String(x.dead ?? 0))
  .replace(/#\\{@stack-keep\\}/g, x.keep ? '1' : '')
  .replace(/#\\{@stack-fresh\\}/g, x.fresh ? '1' : '');

if (cmd === '-V') { process.stdout.write('tmux 3.4\\n'); process.exit(0); }

if (cmd === 'has-session') { process.exit(find(argv[2]) ? 0 : 1); }

if (cmd === 'list-sessions' || cmd === 'list-panes') {
  // tmux exits non-zero with "no server running" when nothing is up. Every
  // reader has to treat that as "no sessions", never as a throw.
  if (!s.serverRunning) { process.stderr.write('no server running\\n'); process.exit(1); }
  const fmt = argv[argv.indexOf('-F') + 1];
  process.stdout.write(s.sessions.map((x) => fill(fmt, x)).join('\\n') + '\\n');
  process.exit(0);
}

if (cmd === 'kill-session') {
  const name = target(argv[2]);
  s.sessions = s.sessions.filter((x) => x.name !== name);
  save();
  process.exit(0);
}

if (cmd === 'set-option') {
  if (s.optionsFail) { process.stderr.write('unknown option\\n'); process.exit(1); }
  const unset = argv.includes('-u');
  const t = argv[argv.indexOf('-t') + 1];
  // A SESSION user option needs the pane-target form. A bare "=name" is what
  // tmux 3.x actually refuses, so the fake refuses it too — otherwise this
  // suite would pass over the exact mistake it is here to prevent.
  if (!/:$/.test(String(t))) { process.stderr.write("can't find pane\\n"); process.exit(1); }
  const sess = find(t);
  if (!sess) { process.stderr.write('no such session\\n'); process.exit(1); }
  const key = argv[argv.length - (unset ? 1 : 2)];
  const field = key === '@stack-keep' ? 'keep' : key === '@stack-fresh' ? 'fresh' : null;
  if (field) { sess[field] = unset ? false : true; save(); }
  process.exit(0);
}

if (cmd === 'capture-pane') {
  const sess = find(argv[argv.indexOf('-t') + 1]);
  if (!sess) { process.exit(1); }
  process.stdout.write(sess.pane ?? '');
  process.exit(0);
}

if (cmd === 'send-keys') {
  if (s.sendKeysFail) { process.stderr.write('no such session\\n'); process.exit(1); }
  process.exit(0);
}

process.exit(0);
`;

const TMUX = join(DIR, 'tmux');
writeFileSync(TMUX, FAKE);
chmodSync(TMUX, 0o755);
process.env.FAKE_TMUX_STATE = STATE;
process.env.FAKE_TMUX_CALLS = CALLS;
process.env.PATH = `${DIR}:${process.env.PATH}`;

// PATH is set BEFORE the import, because tmuxAvailable() caches its answer on
// the first call and the daemon's whole fallback path hangs off it.
const {
  validName, generateName, sessionExists, sessionArgv, killSession, paneTail, sendKeys,
  setKeep, markFresh, clearFresh, listStackSessions, listDetached, listAutoSessions,
  reapDeadSessions, reapFreshSessions, reapIdleSessions, tmuxAvailable,
} = await import('../../terminal/tmux-session.mjs');

// ---- fixture helpers -------------------------------------------------------

const SEC = 1000;
const now = () => Date.now();
const minsAgo = (m) => Math.floor((now() - m * 60_000) / SEC);
const hoursAgo = (h) => Math.floor((now() - h * 3600_000) / SEC);

const session = (o = {}) => ({
  name: 'stack-term-aaaa1111',
  attached: 0,
  created: minsAgo(30),
  activity: minsAgo(30),
  path: '/home/bailey/stack',
  keep: false,
  fresh: false,
  dead: 0,
  pane: '',
  ...o,
});

/** Replace the whole tmux world and forget every call made against the old one. */
function world(sessions, extra = {}) {
  writeFileSync(STATE, JSON.stringify({ serverRunning: true, sessions, ...extra }));
  writeFileSync(CALLS, '');
}

const calls = () => readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const callsTo = (cmd) => calls().filter((a) => a[0] === cmd);
const names = () => JSON.parse(readFileSync(STATE, 'utf8')).sessions.map((x) => x.name).sort();
const stateOf = (name) => JSON.parse(readFileSync(STATE, 'utf8')).sessions.find((x) => x.name === name);

before(() => world([]));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

// ---- A. names, and the =name: target trap ---------------------------------

test('validName requires the stack- prefix and refuses tmux target syntax', () => {
  assert.equal(validName('stack-term-abc123'), true);
  assert.equal(validName('stack-auto-item-42'), true);
  for (const bad of ['term-abc', 'stack-a:b', 'stack-a.b', 'stack-a%b', 'stack-a=b', 'stack-', '', null, 42, {}]) {
    assert.equal(validName(bad), false, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(validName(`stack-${'a'.repeat(64)}`), true, '64 chars after the prefix is the ceiling');
  assert.equal(validName(`stack-${'a'.repeat(65)}`), false);
});

test('generateName is unique, prefixed, and passes its own validator', () => {
  const a = generateName('term');
  const b = generateName('term');
  assert.notEqual(a, b, 'two same-second starts must not collide');
  assert.match(a, /^stack-term-[0-9a-f]{8}$/);
  assert.equal(validName(a), true);
});

test('a SESSION option is targeted `=name:`, and a session itself `=name`', () => {
  // The tmux 3.x trap the module documents four times: set-option's -t is a
  // target-PANE, so the trailing colon is load-bearing and a bare `=name`
  // fails on a session that plainly exists. The fake refuses the bare form
  // exactly as tmux does, so this cannot pass by accident.
  world([session({ name: 'stack-term-t1' })]);
  assert.deepEqual(setKeep('stack-term-t1', true), { ok: true });
  markFresh('stack-term-t1');
  paneTail('stack-term-t1');
  sendKeys('stack-term-t1', ['1']);
  for (const a of calls()) {
    if (['set-option', 'capture-pane', 'send-keys'].includes(a[0])) {
      assert.equal(a[a.indexOf('-t') + 1], '=stack-term-t1:', `${a[0]} needs the pane-target form`);
    }
  }

  world([session({ name: 'stack-term-t1' })]);
  sessionExists('stack-term-t1');
  killSession('stack-term-t1');
  for (const a of calls()) {
    if (['has-session', 'kill-session'].includes(a[0])) {
      assert.equal(a[a.indexOf('-t') + 1], '=stack-term-t1', `${a[0]} names a session, not a pane`);
    }
  }
});

test('the = prefix stops a name prefix-matching a longer one', () => {
  world([session({ name: 'stack-auto-item17' })]);
  assert.equal(sessionExists('stack-auto-item17'), true);
  assert.equal(sessionExists('stack-auto-item1'), false,
    'without =, tmux would prefix-match item17 and report the wrong session alive');
});

test('tmuxAvailable answers once and the daemon can fall back on it', () => {
  assert.equal(tmuxAvailable(), true);
});

// ---- B. reading the session list -------------------------------------------

test('listStackSessions parses every field and converts seconds to ms', () => {
  const created = minsAgo(90);
  const activity = minsAgo(5);
  world([session({ name: 'stack-term-parse', attached: 1, created, activity, path: '/srv/x', keep: true, fresh: true })]);
  const [s] = listStackSessions();
  assert.equal(s.name, 'stack-term-parse');
  assert.equal(s.attached, true);
  assert.equal(s.created, created * SEC, 'tmux speaks seconds, every caller here speaks ms');
  assert.equal(s.activity, activity * SEC);
  assert.equal(s.path, '/srv/x');
  assert.equal(s.keep, true);
  assert.equal(s.fresh, true);
});

test('an unset user option is false, not undefined', () => {
  world([session({ name: 'stack-term-plain' })]);
  const [s] = listStackSessions();
  assert.equal(s.keep, false);
  assert.equal(s.fresh, false);
});

test('only stack-term-* is the browser\'s to see', () => {
  world([
    session({ name: 'stack-term-mine' }),
    session({ name: 'stack-auto-item-42' }),
    session({ name: 'my-own-work' }),
    session({ name: 'stack-preview-x' }),
  ]);
  assert.deepEqual(listStackSessions().map((s) => s.name), ['stack-term-mine']);
});

test('the two lists PARTITION — neither can ever see the other\'s sessions', () => {
  // #366's safety property. listStackSessions feeds the mirror, the kill button
  // and all three reapers; an autopilot session runs with
  // --dangerously-skip-permissions and is not the browser's to touch that way.
  world([
    session({ name: 'stack-term-a' }), session({ name: 'stack-term-b' }),
    session({ name: 'stack-auto-item-9' }), session({ name: 'stack-auto-item-10' }),
  ]);
  const term = listStackSessions().map((s) => s.name);
  const auto = listAutoSessions().map((s) => s.name);
  assert.deepEqual(term, ['stack-term-a', 'stack-term-b']);
  assert.deepEqual(auto, ['stack-auto-item-9', 'stack-auto-item-10']);
  assert.equal(term.filter((n) => auto.includes(n)).length, 0, 'the two lists must not overlap');
});

test('no tmux server is no sessions, never a throw', () => {
  world([], { serverRunning: false });
  assert.deepEqual(listStackSessions(), []);
  assert.deepEqual(listAutoSessions(), []);
  assert.deepEqual(listDetached(), []);
  assert.deepEqual(reapDeadSessions(), []);
  assert.deepEqual(reapFreshSessions(1), []);
  assert.deepEqual(reapIdleSessions(1), []);
});

test('listDetached is the subset with nobody on it', () => {
  world([
    session({ name: 'stack-term-held', attached: 1 }),
    session({ name: 'stack-term-loose', attached: 0 }),
  ]);
  assert.deepEqual(listDetached().map((s) => s.name), ['stack-term-loose']);
});

// ---- C. the dead reaper (#197) ---------------------------------------------

test('a detached session whose process already exited is a corpse and is taken', () => {
  world([session({ name: 'stack-term-dead', attached: 0, dead: 1 })]);
  assert.deepEqual(reapDeadSessions(), ['stack-term-dead']);
  assert.deepEqual(names(), []);
});

test('a walked-away session with a LIVE process is a feature, not a leak (#188)', () => {
  world([session({ name: 'stack-term-idle', attached: 0, dead: 0 })]);
  assert.deepEqual(reapDeadSessions(), []);
  assert.deepEqual(names(), ['stack-term-idle']);
});

test('an ATTACHED session is never a corpse, whatever the pane says', () => {
  world([session({ name: 'stack-term-live', attached: 1, dead: 1 })]);
  assert.deepEqual(reapDeadSessions(), []);
});

test('the dead reaper cannot reach an autopilot session either', () => {
  world([session({ name: 'stack-auto-item-3', attached: 0, dead: 1 })]);
  assert.deepEqual(reapDeadSessions(), []);
  assert.deepEqual(names(), ['stack-auto-item-3']);
});

// ---- D. THE SHORT FUSE: sessions nobody ever looked at ----------------------
//
// The ghost-terminal reaper. Every page load of #/terminal that cannot adopt a
// session opens one, and a tab closed a second later leaves the tmux session —
// and its claude process, and its context — running until the hours-scale
// reaper gets to it. These pin both halves: what it takes, and the much longer
// list of what it must refuse to take.

test('a session created, orphaned and never seen again is taken', () => {
  world([session({ name: 'stack-term-ghost', fresh: true, attached: 0, created: minsAgo(5) })]);
  const reaped = reapFreshSessions(1);
  assert.deepEqual(reaped.map((r) => r.name), ['stack-term-ghost']);
  assert.equal(reaped[0].ageMinutes, 5, 'the log says how old the ghost was');
  assert.deepEqual(names(), []);
});

test('the fuse is a fuse — a fresh session younger than it is left alone', () => {
  world([session({ name: 'stack-term-new', fresh: true, created: minsAgo(0) })]);
  assert.deepEqual(reapFreshSessions(1), []);
  assert.deepEqual(names(), ['stack-term-new']);
});

test('0 minutes means NEVER, and takes nothing however old and fresh', () => {
  world([session({ name: 'stack-term-ancient', fresh: true, created: hoursAgo(40) })]);
  assert.deepEqual(reapFreshSessions(0), []);
  assert.equal(callsTo('kill-session').length, 0, 'off means no kill is even attempted');
  assert.deepEqual(names(), ['stack-term-ancient']);
});

test('a threshold the API never answered takes nothing', () => {
  // CLAUDE.md's fail-safe direction, from every shape a missing setting takes.
  world([session({ name: 'stack-term-ancient', fresh: true, created: hoursAgo(40) })]);
  for (const nothing of [null, undefined, NaN, -5, '', 'soon']) {
    assert.deepEqual(reapFreshSessions(nothing), [], `${JSON.stringify(nothing)} must reap nothing`);
  }
  assert.equal(callsTo('kill-session').length, 0);
});

test('a session the daemon did not create is out of reach BY CONSTRUCTION', () => {
  // An ssh + `tmux new -s stack-term-…` never carries the mark, so it is not a
  // candidate at all — the fail-safe direction for something that kills.
  world([session({ name: 'stack-term-byhand', fresh: false, created: hoursAgo(9) })]);
  assert.deepEqual(reapFreshSessions(1), []);
  assert.deepEqual(names(), ['stack-term-byhand']);
});

test('somebody had it on screen, so the mark comes OFF and it is spared for good', () => {
  // Half the algorithm, not a tidy-up: a session reached over ssh is seen
  // within one sweep and permanently exempted, so the next sweep need not
  // re-decide it.
  world([session({ name: 'stack-term-seen', fresh: true, attached: 1, created: hoursAgo(9) })]);
  assert.deepEqual(reapFreshSessions(1), []);
  assert.equal(stateOf('stack-term-seen').fresh, false, 'the fresh mark is cleared, permanently');
  assert.equal(callsTo('kill-session').length, 0);
});

test('the caller\'s own live sessions are skipped WITHOUT being un-marked', () => {
  // `held` is the daemon's own set: it judges those on how long the BROWSER
  // held them, so a short-lived tab must not come to depend on whether a sweep
  // happened to tick during it.
  world([session({ name: 'stack-term-mine', fresh: true, attached: 0, created: hoursAgo(9) })]);
  assert.deepEqual(reapFreshSessions(1, new Set(['stack-term-mine'])), []);
  assert.equal(stateOf('stack-term-mine').fresh, true, 'still the daemon\'s to judge');
  assert.deepEqual(names(), ['stack-term-mine']);
});

test('the keep pin exempts a fresh session outright', () => {
  world([session({ name: 'stack-term-pinned', fresh: true, keep: true, created: hoursAgo(9) })]);
  assert.deepEqual(reapFreshSessions(1), []);
  assert.deepEqual(names(), ['stack-term-pinned']);
  assert.equal(stateOf('stack-term-pinned').fresh, true, 'a pin is not a sighting');
});

test('a missing created stamp is refused, not guessed at', () => {
  world([session({ name: 'stack-term-nostamp', fresh: true, created: 0 })]);
  assert.deepEqual(reapFreshSessions(1), []);
  assert.deepEqual(names(), ['stack-term-nostamp']);
});

test('a fresh-marked AUTOPILOT session is untouchable', () => {
  world([session({ name: 'stack-auto-item-7', fresh: true, created: hoursAgo(9) })]);
  assert.deepEqual(reapFreshSessions(1), []);
  assert.deepEqual(names(), ['stack-auto-item-7']);
});

test('a real sweep: two ghosts go, four survivors stay, each for its own reason', () => {
  world([
    session({ name: 'stack-term-ghost1', fresh: true, created: minsAgo(3) }),
    session({ name: 'stack-term-ghost2', fresh: true, created: minsAgo(9) }),
    session({ name: 'stack-term-young', fresh: true, created: minsAgo(0) }),
    session({ name: 'stack-term-seen', fresh: true, attached: 1, created: minsAgo(9) }),
    session({ name: 'stack-term-pinned', fresh: true, keep: true, created: minsAgo(9) }),
    session({ name: 'stack-term-owner', fresh: false, created: hoursAgo(80) }),
  ]);
  const reaped = reapFreshSessions(1, new Set());
  assert.deepEqual(reaped.map((r) => r.name).sort(), ['stack-term-ghost1', 'stack-term-ghost2']);
  assert.deepEqual(names(), [
    'stack-term-owner', 'stack-term-pinned', 'stack-term-seen', 'stack-term-young',
  ]);
});

// ---- E. the idle reaper (#287) ---------------------------------------------

test('a session that has produced nothing for longer than the threshold is taken', () => {
  world([session({ name: 'stack-term-quiet', activity: hoursAgo(7) })]);
  const reaped = reapIdleSessions(6);
  assert.deepEqual(reaped.map((r) => r.name), ['stack-term-quiet']);
  assert.equal(reaped[0].idleHours, 7);
  assert.deepEqual(names(), []);
});

test('ATTACHED IS NOT IN USE — a tab left open overnight is the case this exists for', () => {
  // The counter-intuitive half, and the one a "surely we should skip attached
  // sessions" refactor would quietly undo. Idleness is real OUTPUT, not a tab.
  world([session({ name: 'stack-term-openTab', attached: 1, activity: hoursAgo(9) })]);
  assert.deepEqual(reapIdleSessions(6).map((r) => r.name), ['stack-term-openTab']);
});

test('the keep pin says "parked, not abandoned", and is the only way to say it', () => {
  world([session({ name: 'stack-term-parked', keep: true, activity: hoursAgo(40) })]);
  assert.deepEqual(reapIdleSessions(6), []);
  assert.deepEqual(names(), ['stack-term-parked']);
});

test('0 hours, and every shape of an unanswered threshold, reap nothing', () => {
  world([session({ name: 'stack-term-quiet', activity: hoursAgo(40) })]);
  for (const nothing of [0, null, undefined, NaN, -1, '']) {
    assert.deepEqual(reapIdleSessions(nothing), [], `${JSON.stringify(nothing)} must reap nothing`);
  }
  assert.equal(callsTo('kill-session').length, 0);
  assert.deepEqual(names(), ['stack-term-quiet']);
});

test('a missing activity stamp is refused, not guessed at', () => {
  world([session({ name: 'stack-term-noactivity', activity: 0 })]);
  assert.deepEqual(reapIdleSessions(6), []);
  assert.deepEqual(names(), ['stack-term-noactivity']);
});

test('a quiet autopilot session is untouchable — a build night thinks in silence', () => {
  world([session({ name: 'stack-auto-item-11', activity: hoursAgo(40) })]);
  assert.deepEqual(reapIdleSessions(6), []);
  assert.deepEqual(names(), ['stack-auto-item-11']);
});

test('the two reapers judge different things and do not shadow each other', () => {
  // A fresh ghost is minutes old with recent activity (it just drew a splash);
  // an idle session is hours quiet but has been seen. Neither reaper may take
  // the other's subject.
  world([
    session({ name: 'stack-term-ghost', fresh: true, created: minsAgo(5), activity: minsAgo(5) }),
    session({ name: 'stack-term-stale', fresh: false, created: hoursAgo(30), activity: hoursAgo(9) }),
  ]);
  assert.deepEqual(reapFreshSessions(1).map((r) => r.name), ['stack-term-ghost'],
    'the fuse takes the ghost and not the stale one');
  assert.deepEqual(reapIdleSessions(6).map((r) => r.name), ['stack-term-stale']);
});

// ---- F. the keep pin's own failure mode ------------------------------------

test('a pin that could not be set SAYS SO rather than reading as protected', () => {
  // "a pin that silently did nothing would be worse than no pin at all, since
  // the session would read as protected and be reaped anyway" — tmux < 3.0.
  world([session({ name: 'stack-term-old' })], { optionsFail: true });
  const r = setKeep('stack-term-old', true);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown option', 'the refusal is passed through, not swallowed');
});

test('setting and clearing the pin are the set and the -u of one option', () => {
  world([session({ name: 'stack-term-p' })]);
  setKeep('stack-term-p', true);
  assert.equal(stateOf('stack-term-p').keep, true);
  setKeep('stack-term-p', false);
  assert.equal(stateOf('stack-term-p').keep, false);
  const [set, unset] = callsTo('set-option');
  assert.deepEqual(set.slice(-2), ['@stack-keep', '1']);
  assert.deepEqual(unset.slice(-2), ['-u', '@stack-keep']);
});

test('the fresh mark is a separate option from the pin and does not disturb it', () => {
  world([session({ name: 'stack-term-both', keep: true })]);
  markFresh('stack-term-both');
  assert.equal(stateOf('stack-term-both').fresh, true);
  assert.equal(stateOf('stack-term-both').keep, true, 'the pin survives a mark');
  clearFresh('stack-term-both');
  assert.equal(stateOf('stack-term-both').fresh, false);
  assert.equal(stateOf('stack-term-both').keep, true, 'and survives a clear');
});

// ---- G. the start argv, the pane read, the one writer ----------------------

test('one `new-session -A` does create AND attach, with no race between them', () => {
  const argv = sessionArgv('stack-term-x', '/home/bailey/stack', 'exec claude');
  assert.equal(argv[0], 'tmux');
  assert.deepEqual(argv.slice(1, 8),
    ['new-session', '-A', '-s', 'stack-term-x', '-c', '/home/bailey/stack', 'exec claude']);
  const tail = argv.join(' ');
  assert.match(tail, /mouse on/, 'without it the wheel cannot scroll');
  assert.match(tail, /set-clipboard on/, 'without it a drag lands in a buffer the browser cannot see');
  assert.match(tail, /history-limit 20000/);
});

test('paneTail trims trailing blank lines and caps from the END', () => {
  world([session({ name: 'stack-term-pane', pane: 'aaaa\nbbbb\ncccc\n\n\n' })]);
  assert.equal(paneTail('stack-term-pane'), 'aaaa\nbbbb\ncccc');
  assert.equal(paneTail('stack-term-pane', 30, { chars: 4 }), 'cccc', 'the TAIL is what is wanted');
});

test('a pane read that misses is an empty string, never a throw', () => {
  world([]);
  assert.equal(paneTail('stack-term-gone'), '');
});

test('sendKeys says whether tmux took the keys', () => {
  world([session({ name: 'stack-term-k' })]);
  assert.deepEqual(sendKeys('stack-term-k', ['1']), { ok: true });
  world([session({ name: 'stack-term-k' })], { sendKeysFail: true });
  assert.deepEqual(sendKeys('stack-term-k', ['1']), { ok: false, error: 'no such session' });
});

test('-l is the difference between typing a digit and hunting for a key called 1', () => {
  world([session({ name: 'stack-term-k' })]);
  sendKeys('stack-term-k', ['1'], { literal: true });
  sendKeys('stack-term-k', ['Enter']);
  const [lit, named] = callsTo('send-keys');
  assert.ok(lit.includes('-l'), 'a digit is sent literally');
  assert.ok(!named.includes('-l'), "a key NAME is not, or tmux types the six letters of 'Escape'");
});

// ---- H. COST: how many times a sweep forks tmux -----------------------------
//
// A STRUCTURAL claim, exact and hard, in the sense scripts/term-perf.test.mjs
// sets out: it is a property of the algorithm, true on any hardware under any
// load. The regression it guards is invisible to every test above — move the
// `keep`/`fresh` read out of the format string into a per-session
// `show-options` call and every assertion still passes, while a sweep over
// sixty sessions goes from one fork to a hundred and eighty, once a minute,
// for ever. A fork is ~2ms of a shared host's CPU; that is the whole budget of
// the daemon's periodic work spent on nothing.

test('reading every session on the host costs exactly ONE tmux call', () => {
  world(Array.from({ length: 200 }, (_, i) => session({ name: `stack-term-s${i}` })));
  const t0 = performance.now();
  const list = listStackSessions();
  const ms = performance.now() - t0;
  assert.equal(list.length, 200);
  assert.equal(calls().length, 1, 'one list-sessions, whatever the session count');
  console.log(`      200 sessions read in ${ms.toFixed(1)}ms via ${calls().length} tmux call`);
});

test('listDetached does not re-read the host to filter it', () => {
  world(Array.from({ length: 50 }, (_, i) => session({ name: `stack-term-d${i}`, attached: i % 2 })));
  assert.equal(listDetached().length, 25);
  assert.equal(calls().length, 1, 'a filter over one read, not a second read');
});

test('a sweep is one read plus one call per session it actually acts on', () => {
  // 200 sessions, 20 ghosts to kill, 5 seen sessions to un-mark, 175 no-ops.
  const sessions = Array.from({ length: 200 }, (_, i) => session({
    name: `stack-term-m${i}`,
    fresh: i < 25,
    attached: i >= 20 && i < 25 ? 1 : 0,
    created: minsAgo(9),
  }));
  world(sessions);
  const t0 = performance.now();
  const reaped = reapFreshSessions(1);
  const ms = performance.now() - t0;
  assert.equal(reaped.length, 20);
  assert.equal(callsTo('list-sessions').length, 1, 'the host is read once');
  assert.equal(callsTo('kill-session').length, 20, 'one kill per ghost and not one more');
  assert.equal(callsTo('set-option').length, 5, 'one clear per session someone was seen on');
  assert.equal(calls().length, 26, 'nothing is spent on the 175 that need no action');
  console.log(`      sweep of 200 (20 reaped, 5 cleared) in ${ms.toFixed(1)}ms via ${calls().length} tmux calls`);
});

test('an idle sweep that finds nothing to do costs one call', () => {
  world(Array.from({ length: 100 }, (_, i) => session({ name: `stack-term-q${i}`, activity: minsAgo(1) })));
  assert.deepEqual(reapIdleSessions(6), []);
  assert.equal(calls().length, 1, 'the quiet case is the common case and must stay free');
});
