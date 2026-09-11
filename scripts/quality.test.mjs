#!/usr/bin/env node
// Tests for web/src/lib/quality.ts — the pure derivation behind the Quality tab
// (#497). Run: node --experimental-strip-types scripts/quality.test.mjs
//
// Same loader shim as scripts/spine.test.mjs: quality.ts is TypeScript living
// under web/, outside this repo's module graph, and imports its siblings with
// no extension. See that file's header for why both pieces are needed.
//
// WHAT THIS IS ACTUALLY FOR. Checks are Stack's only automated regression net
// and a green suite is what #212 auto-merge and #263 auto-verdict SPEND, so the
// arithmetic deciding "is this suite green" earns a net of its own. The one
// test nothing else can replace is the last block: the rail's badge takes no
// history and the screen has one, and they must still count the same rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';

module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const url = new URL('../web/src/lib/quality.ts', import.meta.url);
const {
  SEVERITY, bugGrade, readHistory, isGreenFlake, readHealth, gradeRedCheck,
  openItems, qualityAttention, groupByFeature, statStrip, sparkline, clusterBugs,
  assertLabel, runBy, bugAge, fmtMs, worstOf,
} = await import(url.href);

// --- fixtures ---------------------------------------------------------

let nextId = 1;
const check = (o = {}) => ({
  id: o.id ?? nextId++, name: o.name ?? `check ${nextId}`, url: 'https://x/', method: 'GET',
  expectStatus: 200, reqBody: '', contains: '', jsonPath: '', jsonExpect: '', semantic: '',
  feature: '', auth: false, external: false,
  lastStatus: '', lastCode: null, lastMs: null, lastError: '', when: '1h',
  ...o,
});
const pass = (o = {}) => check({ lastStatus: 'pass', lastCode: 200, lastMs: 500, ...o });
const fail = (o = {}) => check({ lastStatus: 'fail', lastCode: 500, lastMs: 500, lastError: 'boom', ...o });

const bug = (o = {}) => ({
  id: o.id ?? 'BUG-1', title: o.title ?? 'a bug', severity: 'medium', status: 'open',
  meta: '2h', linkRef: null, checkId: null, source: 'manual', reviewed: true, ...o,
});

const hist = (...statuses) => statuses.map((s) => ({ status: s, code: null, ms: 10, error: '', at: '', when: '1h' }));
const LABELS = { open: 'Open', investigating: 'Investigating', fixing: 'Fixing', fixed: 'Fixed' };

// --- the severity mapping ---------------------------------------------

test('a bug\'s grade is its own column, 1:1, and flaky is never one of them', () => {
  assert.deepEqual(
    ['critical', 'high', 'medium', 'low'].map(bugGrade),
    ['blocking', 'broken', 'degraded', 'cosmetic'],
  );
  assert.equal(SEVERITY.flaky.rank, 4, 'flaky sits below every graded state');
});

test('a red check is broken, blocking only when the whole suite is down', () => {
  assert.equal(gradeRedCheck(null, false), 'broken');
  assert.equal(gradeRedCheck(null, true), 'blocking');
});

test('a linked bug may LIFT a red check\'s grade and can never lower it', () => {
  assert.equal(gradeRedCheck(bug({ severity: 'critical' }), false), 'blocking', 'a critical bug lifts it');
  assert.equal(gradeRedCheck(bug({ severity: 'low' }), false), 'broken',
    'a low-graded bug does not make a red check cosmetic');
  assert.equal(gradeRedCheck(bug({ severity: 'low' }), true), 'blocking', 'nor does it soften a downed suite');
});

test('worstOf is empty-safe — no rows is clean, not cosmetic', () => {
  assert.equal(worstOf([]), null);
  assert.equal(worstOf(['cosmetic', 'degraded', 'flaky']), 'degraded');
});

// --- what a check remembers -------------------------------------------

test('one run is not a trend, so it gets no diagnosis', () => {
  assert.equal(readHistory(hist('fail')).diagnosis, '');
  assert.equal(readHistory(undefined).n, 0);
});

test('a fresh regression and a fortnight of failure read differently', () => {
  assert.equal(readHistory(hist('fail', 'pass', 'pass')).diagnosis, 'failed for the first time in 3 runs');
  assert.equal(readHistory(hist('fail', 'fail', 'fail')).diagnosis, 'failed every one of the last 3 runs');
  assert.equal(readHistory(hist('fail', 'pass', 'fail', 'pass')).diagnosis, 'failed 2 of the last 4 runs');
  assert.equal(readHistory(hist('pass', 'fail', 'pass')).diagnosis, 'failed once in the last 3 runs');
});

test('flaky is a GREEN check that flips, and three results is the floor', () => {
  assert.equal(isGreenFlake(pass(), readHistory(hist('pass', 'fail', 'pass'))), true);
  assert.equal(isGreenFlake(pass(), readHistory(hist('pass', 'fail'))), false, 'two cannot tell a flake from a fix');
  assert.equal(isGreenFlake(fail(), readHistory(hist('fail', 'pass', 'fail'))), false,
    'a red check is broken; the flipping is in its diagnosis, not its grade');
});

// --- the health read ---------------------------------------------------

test('no pass is not a failed pass — a never-run suite is Untested, not 0%', () => {
  const h = readHealth([check(), check()], []);
  assert.equal(h.verdict, 'untested');
  assert.equal(h.run, 0);
  assert.equal(h.down, false, 'nothing has run, so nothing is down');
});

test('every check red the same way is ONE cause, not N bugs', () => {
  const h = readHealth([fail({ lastError: 'refused' }), fail({ lastError: 'refused' })], []);
  assert.equal(h.verdict, 'down');
  assert.equal(h.oneCause, 'refused');
  assert.match(h.why, /every one of them refused/);
});

test('two red checks failing differently is still down, but with no single cause', () => {
  const h = readHealth([fail({ lastError: 'a' }), fail({ lastError: 'b' })], []);
  assert.equal(h.verdict, 'down');
  assert.equal(h.oneCause, null);
});

test('a green suite with a serious bug open does not read Good', () => {
  const h = readHealth([pass()], [bug({ severity: 'critical' })]);
  assert.equal(h.verdict, 'needs-work');
  assert.equal(h.serious, 1);
  assert.equal(h.avgMs, 500);
});

test('a fixed bug is not open and not serious', () => {
  const h = readHealth([pass()], [bug({ severity: 'critical', status: 'fixed' })]);
  assert.equal(h.verdict, 'good');
  assert.equal(h.open, 0);
});

// --- open items --------------------------------------------------------

test('a bug linked to a red check is that row\'s chip, never a second row', () => {
  const c = fail({ id: 7, name: 'Bugs — collection' });
  const b = bug({ id: 'BUG-31', severity: 'high', checkId: 7 });
  const items = openItems([c], [b], {});
  assert.equal(items.length, 1, 'one problem, one row');
  assert.equal(items[0].kind, 'check');
  assert.equal(items[0].bugKey, 'BUG-31');
  assert.equal(items[0].wantsBug, false);
});

test('a red check whose only bug is already FIXED wants a fresh one filed', () => {
  const c = fail({ id: 7 });
  const items = openItems([c], [bug({ id: 'BUG-9', checkId: 7, status: 'fixed' })], {});
  assert.equal(items.length, 1);
  assert.equal(items[0].wantsBug, true, 'a fixed bug is a tracked failure no longer');
  assert.equal(items[0].bugKey, null);
});

test('an uncovered open bug is its own row and wants a check written', () => {
  const items = openItems([], [bug({ id: 'BUG-29', severity: 'low' })], {});
  assert.deepEqual(
    items.map((i) => [i.kind, i.severity, i.wantsCheck, i.canRun]),
    [['bug', 'cosmetic', true, false]],
  );
});

test('a bug covered by a check that is GREEN still needs you, and can be retested', () => {
  const c = pass({ id: 4, name: 'cover' });
  const items = openItems([c], [bug({ id: 'BUG-2', checkId: 4 })], {});
  assert.equal(items.length, 1);
  assert.equal(items[0].wantsCheck, false);
  assert.equal(items[0].canRun, true);
  assert.match(items[0].detail, /covered by/);
});

test('an external row can never be run from here', () => {
  const items = openItems([fail({ id: 3, external: true })], [], {});
  assert.equal(items[0].canRun, false, '#291 — probing it would overwrite a real report');
});

test('a green flake is an item at rank 4, and only history can find it', () => {
  const c = pass({ id: 5 });
  assert.equal(openItems([c], [], {}).length, 0, 'no history, no flake');
  const items = openItems([c], [], { 5: hist('pass', 'fail', 'pass') });
  assert.deepEqual(items.map((i) => i.severity), ['flaky']);
});

test('items sort worst first, checks ahead of bugs at the same grade', () => {
  // The green check is load-bearing: without it the suite is DOWN and the red
  // row grades blocking too, which is the rule working rather than a mis-sort.
  const items = openItems(
    [fail({ id: 1, name: 'red' }), pass({ id: 2 })],
    [bug({ id: 'BUG-1', severity: 'high', title: 'also broken' }), bug({ id: 'BUG-2', severity: 'critical', title: 'worst' })],
    {},
  );
  assert.deepEqual(items.map((i) => i.name), ['worst', 'red', 'also broken']);
});

test('one red check and nothing green means the suite is DOWN, so it is blocking', () => {
  const items = openItems([fail({ id: 1, name: 'red' })], [], {});
  assert.equal(items[0].severity, 'blocking');
});

// --- THE BADGE AND THE SCREEN MUST COUNT THE SAME ROWS -----------------

test('the badge takes no history and still agrees with the screen it labels', () => {
  const checks = [
    fail({ id: 1 }),                       // broken
    pass({ id: 2 }),                       // flaky once history lands
    fail({ id: 3 }),                       // broken
    pass({ id: 4 }),
  ];
  const bugs = [
    bug({ id: 'BUG-1', severity: 'critical' }),   // blocking
    bug({ id: 'BUG-2', severity: 'low' }),        // cosmetic — below the badge
    bug({ id: 'BUG-3', severity: 'high', checkId: 1 }), // the chip on check 1
  ];
  const history = { 2: hist('pass', 'fail', 'pass'), 1: hist('fail', 'fail') };

  const badge = qualityAttention(checks, bugs);
  const onScreen = openItems(checks, bugs, history)
    .filter((o) => SEVERITY[o.severity].rank <= 3).length;
  assert.equal(badge, onScreen, 'a row\'s number and the screen behind it must agree');
  assert.equal(badge, 3, 'two red checks and one critical bug; the flake and the cosmetic are not an alarm');
});

test('a suite nothing has run reads an em dash, never 0 of N', () => {
  const checks = [check({ id: 1 }), check({ id: 2 })];
  const strip = statStrip(openItems(checks, [], {}), readHealth(checks, []));
  assert.equal(strip[0].v, '\u2014/2', 'no pass is not a failed pass, in the headline number too');
  assert.equal(strip[4].v, '\u2014', 'and there is no average to claim');
});

test('the strip\'s blocking count is the same grading the list uses', () => {
  const checks = [fail({ id: 1 }), fail({ id: 2 })];   // suite down -> both blocking
  const items = openItems(checks, [], {});
  const strip = statStrip(items, readHealth(checks, []));
  assert.deepEqual(strip.map((s) => [s.l, s.v]), [
    ['passing', '0/2'], ['blocking', '2'], ['broken or degraded', '0'], ['flaky', '0'], ['avg', '—'],
  ]);
  assert.equal(strip[1].good, undefined, 'two blocking is not a good number');
  assert.equal(strip[2].good, true);
});

// --- the feature grouping ----------------------------------------------

test('ungrouped is a real group, sorts last, and is never an empty table', () => {
  const groups = groupByFeature([pass({ feature: '' }), pass({ feature: 'Read layer' })], [], {});
  assert.deepEqual(groups.map((g) => g.label), ['Read layer', 'Ungrouped']);
});

test('a group where nothing has run reads never-run, not 0%', () => {
  const [g] = groupByFeature([check({ feature: 'A' }), check({ feature: 'A' })], [], {});
  assert.equal(g.rate, null);
  assert.equal(g.never, 2);
  assert.match(g.read, /waiting on a first run/);
});

test('red groups lead, then flaky, then never-run, then the green ones by name', () => {
  const groups = groupByFeature([
    pass({ id: 10, feature: 'Zed green' }),
    pass({ id: 11, feature: 'Alpha flaky' }),
    fail({ id: 12, feature: 'Red' }),
    check({ id: 13, feature: 'Never' }),
    pass({ id: 14, feature: 'Apples green' }),
  ], [], { 11: hist('pass', 'fail', 'pass') });
  assert.deepEqual(groups.map((g) => g.label), ['Red', 'Alpha flaky', 'Never', 'Apples green', 'Zed green']);
});

test('a group wears the worst grade its own rows carry', () => {
  const groups = groupByFeature(
    [fail({ id: 20, feature: 'A' }), pass({ id: 21, feature: 'A' })],
    [bug({ id: 'BUG-5', severity: 'critical', checkId: 20 })],
    {},
  );
  assert.equal(groups[0].worst, 'blocking');
  assert.equal(groups[0].bugs, 1, 'open bugs filed from checks in this group');
  assert.equal(groups[0].rate, 50);
});

test('a clean group wears no grade at all', () => {
  const [g] = groupByFeature([pass({ feature: 'A' })], [], {});
  assert.equal(g.worst, null);
  assert.match(g.read, /All 1 check green/);
});

// --- the sparkline is FULL runs only ------------------------------------

test('a run-one or a feature run never reaches the sparkline', () => {
  const run = (id, scope, passed, total, failed) =>
    ({ id, scope, passed, total, failed, durationMs: 100, at: '', when: '1h' });
  const bars = sparkline([
    run(3, 'one', 1, 1, 0), run(2, 'all', 4, 5, 1), run(1, 'all', 5, 5, 0), run(0, 'feature', 2, 2, 0),
  ]);
  assert.deepEqual(bars.map((b) => b.key), [1, 2], 'oldest to newest, full runs only');
  assert.deepEqual(bars.map((b) => b.amber), [false, true]);
  assert.equal(bars[1].height, 80);
});

test('a total wipe-out still draws a bar', () => {
  const [bar] = sparkline([{ id: 1, scope: 'all', passed: 0, total: 4, failed: 4, durationMs: 1, at: '', when: '1h' }]);
  assert.equal(bar.height, 8);
});

// --- bugs, clustered ----------------------------------------------------

test('bugs cluster by status, then by whether a check covers them', () => {
  const c = pass({ id: 9, name: 'cover' });
  const clusters = clusterBugs([
    bug({ id: 'BUG-1', severity: 'high' }),
    bug({ id: 'BUG-2', severity: 'critical', checkId: 9 }),
    bug({ id: 'BUG-3', status: 'fixing', severity: 'low' }),
  ], [c], LABELS);
  assert.deepEqual(clusters.map((g) => g.status), ['open', 'fixing']);
  assert.deepEqual(clusters[0].subjects.map((s) => s.subject), ['No check covers it', 'Covered by a check']);
  assert.equal(clusters[0].uncovered, 1);
  assert.equal(clusters[0].worst, 'blocking');
  assert.deepEqual(clusters[0].bugs.map((b) => b.id), ['BUG-2', 'BUG-1'], 'worst first inside a cluster');
});

test('a bug pointing at a check this project no longer has is UNCOVERED', () => {
  const [g] = clusterBugs([bug({ checkId: 404 })], [], LABELS);
  assert.equal(g.uncovered, 1, 'a dangling link is not coverage');
});

test('a fixed cluster wears no grade — its severities are history, not a claim', () => {
  const [g] = clusterBugs([bug({ severity: 'critical', status: 'fixed' })], [], LABELS);
  assert.equal(g.worst, null);
});

test('an empty status is not an empty cluster', () => {
  assert.deepEqual(clusterBugs([], [], LABELS), []);
});

// --- the small readers --------------------------------------------------

test('a status-only check says so rather than pretending to assert something', () => {
  assert.equal(assertLabel(check()), 'status 200');
  assert.equal(assertLabel(check({ contains: 'ok' })), 'body contains "ok"');
  assert.equal(assertLabel(check({ jsonPath: 'a.b', jsonExpect: '2' })), 'a.b = 2');
  assert.equal(assertLabel(check({ semantic: 'looks right', jsonPath: 'a' })), '✧ looks right',
    'the judged assertion is the one worth showing');
});

test('who runs a check is the one two-value distinction the data can source', () => {
  assert.equal(runBy(check()), 'stack');
  assert.equal(runBy(check({ auth: true })), 'authed');
  assert.equal(runBy(check({ external: true })), 'reported',
    'external wins: #261 auth is about the token, not about who probes');
});

test('a bug\'s age loses the word the column already is', () => {
  assert.equal(bugAge(bug({ meta: 'reported 14h ago' })), '14h ago');
  assert.equal(bugAge(bug({ meta: 'reported recently' })), 'recently');
});

test('a missing latency is an em dash, never a zero', () => {
  assert.equal(fmtMs(null), '—');
  assert.equal(fmtMs(1400), '1.4s');
  assert.equal(fmtMs(940), '940ms');
});
