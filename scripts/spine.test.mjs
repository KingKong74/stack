#!/usr/bin/env node
// Tests for web/src/lib/spine.ts — the pure derivation behind the Overview
// tab's progression spine (design 4a).
// Run: node --experimental-strip-types scripts/spine.test.mjs
//
// Same loader shim as scripts/feature.test.mjs (#365): spine.ts is TypeScript
// living under web/, outside this repo's module graph, and imports its siblings
// with no extension. See that file's header for why both pieces are needed.
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

const spineUrl = new URL('../web/src/lib/spine.ts', import.meta.url);
const {
  buildSpine, progressLedger, nextUp, bugSpread, readCadence, isBuilt, isLanded, isInFlight,
  verdictQueue, shippedRecently, overviewStats, compactTokens, usageBars, recentForModel,
  USAGE_BAR_MAX, scheduleStrip, inFlightScope, planVsReality,
} = await import(spineUrl.href);

// --- fixtures ---------------------------------------------------------

const DAY = 86400000;
const NOW = Date.parse('2026-08-09T00:00:00Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();

// #401 — the schedule is MINUTES from week zero. These fixtures still think in
// weeks because that is the grain a plan strip is read at, so `wk` is the one
// place the conversion happens rather than 10080 appearing thirty times.
const MIN_PER_WEEK = 7 * 24 * 60;
const wk = (n) => Math.round(n * MIN_PER_WEEK);

let seq = 0;
function item(over = {}) {
  seq += 1;
  return {
    id: seq, title: `Item ${seq}`, note: '', done: false, bucket: 'should',
    source: 'manual', reviewed: true, claimedBy: '', area: '', builtNote: '',
    reviewTag: '', reviewTags: [], refineNote: '', reviewShelved: false,
    skipped: false, skippedAt: null, risk: 'normal', riskSource: '', riskReason: '',
    tier: '', plan: [], updatedAt: ago(1), agentProfile: '',
    // the Roadmap v2 columns the schedule panels read
    parentId: null, sched: null, baseline: null, labels: [], listKey: '',
    archived: false, estimate: null,
    ...over,
  };
}
const board = (items) => ({
  must: items.filter((i) => i.bucket === 'must'),
  should: items.filter((i) => i.bucket === 'should'),
  could: items.filter((i) => i.bucket === 'could'),
  wont: items.filter((i) => i.bucket === 'wont'),
});
const stage = (stages, key) => stages.find((s) => s.key === key);

// --- the stage predicates --------------------------------------------

test('BUILT is the Review room predicate, not done-without-a-verdict', () => {
  // The #374 rule: nothing in Stack ticks an item, so a change that was built
  // and claimed but never ticked IS in the queue. The naive spelling
  // (done && !reviewTag) would drop it and draw an empty stage over a night's
  // work — the exact bug the Review room had.
  const built = item({ done: false, builtNote: 'shipped the thing', claimedBy: 'feat/12-thing' });
  assert.equal(isBuilt(built), true);
  assert.equal(isLanded(built), false);

  // ticked but unverdicted is also in the queue
  assert.equal(isBuilt(item({ done: true })), true);
  // a bare open item is not
  assert.equal(isBuilt(item()), false);
  // built_note alone is not enough — un-ticking clears claimed_by and keeps the
  // note, which is what makes a rejected change re-queue rather than vanish
  assert.equal(isBuilt(item({ builtNote: 'x', claimedBy: '' })), false);
});

test('BUILT and LANDED are disjoint — no change is counted in two stages', () => {
  const verdicted = item({ done: true, reviewTag: 'solid', builtNote: 'x', claimedBy: 'feat/1-x' });
  assert.equal(isBuilt(verdicted), false);
  assert.equal(isLanded(verdicted), true);
});

test('IN FLIGHT excludes what has already been built on the same claim', () => {
  // A claim is not released when the work finishes (#277), so this row is still
  // claimed_by its branch. Counting it as in flight AND built double-counts it
  // and, worse, reports a fleet as busy when it is actually idle and waiting.
  const waiting = item({ done: false, builtNote: 'shipped', claimedBy: 'feat/7-x' });
  assert.equal(isBuilt(waiting), true);
  assert.equal(isInFlight(waiting), false);

  // still being worked: claimed, nothing reported back yet
  const working = item({ done: false, builtNote: '', claimedBy: 'feat/8-y' });
  assert.equal(isInFlight(working), true);

  // a sent-back round is in flight again: it carries a verdict, so it is not
  // in the Built queue, and its claim says somebody is on it
  const refining = item({ done: false, builtNote: 'v1', claimedBy: 'feat/9-z', reviewTag: 'needs-work' });
  assert.equal(isBuilt(refining), false);
  assert.equal(isInFlight(refining), true);
});

test('the four stages count a real board without overlap', () => {
  const items = [
    item({ bucket: 'must' }),                                             // planned
    item({ bucket: 'should' }),                                           // planned
    item({ claimedBy: 'feat/3-live' }),                                   // in flight
    item({ done: false, builtNote: 'b', claimedBy: 'fix/4-b' }),          // built
    item({ done: true }),                                                 // built (ticked, no verdict)
    item({ done: true, reviewTag: 'solid' }),                             // landed
  ];
  const s = buildSpine(board(items), 'demo', NOW);
  assert.deepEqual(s.map((x) => x.count), [2, 1, 2, 1]);
  // every roadmap row lands in exactly one of the four stages
  const total = s.reduce((n, x) => n + x.count, 0);
  assert.equal(total, items.length);
});

test('a stage sends you to the tab that owns it', () => {
  // The Idea stage was Polaris and In flight / Built pointed into Mission
  // Control's rooms. All three are culled, so every stage now lands on a tab
  // that exists — which is the property worth pinning, not the destinations.
  const s = buildSpine(board([]), 'demo', NOW);
  assert.match(stage(s, 'planned').href, /roadmap/);
  assert.match(stage(s, 'inflight').href, /roadmap/);
  assert.match(stage(s, 'built').href, /roadmap/);
  assert.match(stage(s, 'landed').href, /activity/);
  for (const st of s) assert.doesNotMatch(st.href, /control|futures/);
});

// --- the bottleneck ---------------------------------------------------

test('a deep queue that has not moved in days is flagged, and only one is', () => {
  const items = [
    ...Array.from({ length: 12 }, () => item({ updatedAt: ago(9) })),                 // planned, still
    ...Array.from({ length: 20 }, () => item({ done: true, updatedAt: ago(6) })),     // built, still
  ];
  const s = buildSpine(board(items), 'demo', NOW);
  assert.equal(s.filter((x) => x.blocked).length, 1, 'exactly one bottleneck');
  assert.equal(stage(s, 'built').blocked, true, 'the deeper still queue wins');
  assert.equal(stage(s, 'built').lastMovedDays, 6);
});

test('a queue that moved today is not a bottleneck however deep', () => {
  const items = Array.from({ length: 40 }, () => item({ done: true, updatedAt: ago(0) }));
  const s = buildSpine(board(items), 'demo', NOW);
  assert.equal(s.some((x) => x.blocked), false);
});

test('LANDED is never the bottleneck — a finished project is not stuck', () => {
  const items = Array.from({ length: 300 }, () => item({ done: true, reviewTag: 'solid', updatedAt: ago(90) }));
  const s = buildSpine(board(items), 'demo', NOW);
  assert.equal(stage(s, 'landed').count, 300);
  assert.equal(s.some((x) => x.blocked), false);
});

test('an unstamped queue is not reported as still', () => {
  // No updatedAt anywhere: the rows have not been SHOWN to be sitting, which is
  // a different claim from having sat. Absent is not zero.
  const items = Array.from({ length: 30 }, () => item({ done: true, updatedAt: null }));
  const s = buildSpine(board(items), 'demo', NOW);
  assert.equal(stage(s, 'built').lastMovedDays, null);
  assert.equal(stage(s, 'built').blocked, false);
});

// --- the progress ledger ---------------------------------------------

test('the ledger explains the served percentage and never recomputes it', () => {
  const items = [
    item({ bucket: 'must', done: true }), item({ bucket: 'must' }),
    item({ bucket: 'should', done: true }), item({ bucket: 'should', done: true }),
  ];
  // 71 is deliberately not what any local arithmetic would produce: the figure
  // must come from the payload, or the tab and the Dashboard can disagree.
  const led = progressLedger(71, board(items), []);
  assert.equal(led.pct, 71);
  assert.deepEqual(led.lines, [
    { label: 'Must have', done: 1, total: 2 },
    { label: 'Should have', done: 2, total: 2 },
  ]);
});

test('the 90% cap is reported as armed vs actually biting', () => {
  const bugs = [{ severity: 'high', status: 'open' }];
  assert.equal(progressLedger(64, board([]), bugs).capBiting, false, 'below the ceiling on its own');
  assert.equal(progressLedger(90, board([]), bugs).capBiting, true, 'the ceiling is what you see');
  // fixed bugs do not hold the ceiling; medium/low never did
  assert.equal(progressLedger(90, board([]), [{ severity: 'high', status: 'fixed' }]).seriousBugs, 0);
  assert.equal(progressLedger(90, board([]), [{ severity: 'medium', status: 'open' }]).seriousBugs, 0);
});

// --- the rail ---------------------------------------------------------

test('next up sorts by tier, then bucket, and leaves parked items out', () => {
  const items = [
    item({ title: 'unranked must', bucket: 'must' }),
    item({ title: 'tier B', bucket: 'should', tier: 'B' }),
    item({ title: 'tier S', bucket: 'could', tier: 'S' }),
    item({ title: 'parked S', bucket: 'must', tier: 'S', skipped: true }),
    item({ title: 'claimed S', bucket: 'must', tier: 'S', claimedBy: 'feat/9-x' }),
  ];
  assert.deepEqual(nextUp(board(items)).map((i) => i.title), ['tier S', 'tier B', 'unranked must']);
});

test('the bug spread always carries all four severities so a zero reads as measured', () => {
  const spread = bugSpread([
    { severity: 'critical', status: 'open' },
    { severity: 'low', status: 'fixed' },
  ]);
  assert.deepEqual(spread.map((s) => s.severity), ['critical', 'high', 'medium', 'low']);
  assert.deepEqual(spread.map((s) => s.n), [1, 0, 0, 0]);
});

// --- cadence ----------------------------------------------------------

test('cadence reports the quiet stretch off the real stamp', () => {
  const days = [{ day: '2026-08-01', n: 3 }, { day: '2026-08-02', n: 1 }];
  const c = readCadence(days, ago(6), NOW);
  assert.equal(c.peak, 3);
  assert.equal(c.quietFor, 6);
  assert.equal(c.quiet, true);
});

test('never pushed is null, not a very long silence', () => {
  const c = readCadence([{ day: '2026-08-01', n: 0 }], null, NOW);
  assert.equal(c.quietFor, null);
  assert.equal(c.quiet, false);
  assert.equal(c.peak, 0);
});

// --- the verdict queue ------------------------------------------------

test('the verdict queue is the Built stage, row for row', () => {
  const items = [
    item({ builtNote: 'shipped it', claimedBy: 'ui/12-thing' }),
    item({ done: true, reviewTag: 'solid' }),               // landed, not waiting
    item({ claimedBy: 'feat/13-other' }),                   // claimed, not built
  ];
  const b = board(items);
  const rows = verdictQueue(b, 5, NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'ui');
  assert.equal(stage(buildSpine(b, 'p', NOW), 'built').count, rows.length,
    'the list and the stage number must never disagree');
});

test('the queue is OLDEST first — the row blocking everything behind it leads', () => {
  const rows = verdictQueue(board([
    item({ title: 'fresh', builtNote: 'x', claimedBy: 'fix/1-a', updatedAt: ago(1) }),
    item({ title: 'stale', builtNote: 'x', claimedBy: 'fix/2-b', updatedAt: ago(9) }),
  ]), 5, NOW);
  assert.deepEqual(rows.map((r) => r.title), ['stale', 'fresh']);
  assert.equal(rows[0].ageDays, 9);
});

test('an unstamped row sorts LAST — unknown age is not fresh', () => {
  const rows = verdictQueue(board([
    item({ title: 'none', builtNote: 'x', claimedBy: 'fix/1-a', updatedAt: null }),
    item({ title: 'day', builtNote: 'x', claimedBy: 'fix/2-b', updatedAt: ago(1) }),
  ]), 5, NOW);
  assert.deepEqual(rows.map((r) => r.title), ['day', 'none']);
  assert.equal(rows[1].ageDays, null);
});

test("a legacy lane's kind is '' and never 'feat' (#363)", () => {
  const rows = verdictQueue(board([
    item({ builtNote: 'x', claimedBy: 'auto/item-271-descriptive-branch-names' }),
  ]), 5, NOW);
  assert.equal(rows[0].kind, '', 'the branch records no kind, so the row claims none');
});

test('shipped recently is FRESHEST first — the opposite order, on purpose', () => {
  const rows = shippedRecently(board([
    item({ title: 'old', done: true, reviewTag: 'solid', updatedAt: ago(9) }),
    item({ title: 'new', done: true, reviewTag: 'solid', updatedAt: ago(1) }),
    item({ title: 'waiting', builtNote: 'x', claimedBy: 'fix/1-a' }),
  ]), 5, NOW);
  assert.deepEqual(rows.map((r) => r.title), ['new', 'old']);
});

// --- the headline tiles -----------------------------------------------

test('the tiles NAME what is in flight rather than just counting it', () => {
  const b = board([
    item({ title: 'Inline comments', claimedBy: 'feat/9-inline' }),
    item({ done: true, reviewTag: 'solid' }),
  ]);
  const tiles = overviewStats(b, buildSpine(b, 'p', NOW), 62, []);
  assert.equal(tiles[0].value, '1 of 2');
  assert.equal(tiles[1].value, '1');
  assert.match(tiles[1].note, /Inline comments/);
  assert.equal(tiles[3].value, '62%');
});

test('an absent cadence strip does not report zero pushes', () => {
  const b = board([item()]);
  const stages = buildSpine(b, 'p', NOW);
  assert.match(overviewStats(b, stages, 10, []).at(-1).note, /weighted/);
  assert.match(overviewStats(b, stages, 10, [{ day: '2026-08-01', n: 2 }]).at(-1).note, /2 pushes/);
});

test('an empty board says so instead of reading 0 of 0', () => {
  const b = board([]);
  const tiles = overviewStats(b, buildSpine(b, 'p', NOW), 0, []);
  assert.equal(tiles[0].value, '0 of 0');
  assert.match(tiles[0].note, /nothing on the board/);
});

// --- the usage band ---------------------------------------------------

test('compactTokens reads the way a human says the number', () => {
  assert.equal(compactTokens(48_200_000), '48.2M');
  assert.equal(compactTokens(212_000), '212K');
  assert.equal(compactTokens(900), '900');
  assert.equal(compactTokens(0), '0');
  assert.equal(compactTokens(-5), '0');
});

const usage = (weeks) => ({
  measured: true, weeks, sessions: 0, runs: 0, tokens: 0,
  interactiveTokens: 0, autoTokens: 0, medianSessionTokens: null,
  costUsd: 0, pricedRuns: 0, delegations: { calls: 0, recorded: 0 },
  models: [], recent: [],
});

test('the usage strip is LINEAR — four times the spend is four times the bar', () => {
  const bars = usageBars(usage([
    { week: '2026-06-01', interactive: 100, auto: 0 },
    { week: '2026-06-08', interactive: 400, auto: 0 },
  ]));
  assert.equal(bars[1].interactiveH, USAGE_BAR_MAX);
  assert.equal(bars[0].interactiveH, Math.round(USAGE_BAR_MAX / 4));
  assert.equal(bars[1].last, true);
});

test('a zero week draws NOTHING — a stub would read as a little spend', () => {
  const bars = usageBars(usage([
    { week: '2026-06-01', interactive: 0, auto: 0 },
    { week: '2026-06-08', interactive: 50, auto: 50 },
  ]));
  assert.equal(bars[0].interactiveH, 0);
  assert.equal(bars[0].autoH, 0);
  assert.equal(bars[0].total, 0);
  assert.ok(bars[1].interactiveH > 0 && bars[1].autoH > 0, 'both populations keep their own tone');
});

test('a strip with no spend at all divides by nothing rather than by zero', () => {
  const bars = usageBars(usage([{ week: '2026-06-01', interactive: 0, auto: 0 }]));
  assert.equal(bars[0].interactiveH, 0);
});

test('the drill-down shows only the rows that named that model', () => {
  const u = usage([]);
  u.recent = [
    { kind: 'session', at: '2026-08-08T00:00:00Z', models: ['opus'], text: 'a', tokens: 1 },
    { kind: 'run', at: '2026-08-07T00:00:00Z', models: ['haiku'], text: 'b', tokens: 2 },
    { kind: 'session', at: '2026-08-06T00:00:00Z', models: ['opus', 'haiku'], text: 'c', tokens: 3 },
  ];
  assert.deepEqual(recentForModel(u, 'opus').map((r) => r.text), ['a', 'c']);
  assert.deepEqual(recentForModel(u, 'haiku').map((r) => r.text), ['b', 'c']);
  assert.deepEqual(recentForModel(u, 'sonnet'), []);
});

// --- the schedule strip -----------------------------------------------------

test('only TOP-LEVEL items get a bar — a scope line is not a feature', () => {
  const parent = item({ title: 'Inline comments', area: 'Editor', sched: { start: wk(2), len: wk(4) } });
  const child = item({ title: 'Threading', parentId: parent.id, area: 'Editor', sched: { start: wk(2), len: wk(1) } });
  const s = scheduleStrip(board([parent, child]), wk(24));
  assert.equal(s.scheduled, 1, 'drawing children turns one feature into several');
  assert.deepEqual(s.lanes.map((l) => l.area), ['Editor']);
  assert.equal(s.lanes[0].bars.length, 1);
});

test('a bar is placed as a percentage of the track it is measured against', () => {
  const s = scheduleStrip(board([item({ sched: { start: wk(6), len: wk(6) }, area: 'Sync' })]), wk(24));
  const b = s.lanes[0].bars[0];
  assert.equal(b.left, 25);
  assert.equal(b.width, 25);
});

test('UNTAGGED is its own lane, never folded into the first real one', () => {
  const s = scheduleStrip(board([
    item({ area: 'Editor', sched: { start: wk(0), len: wk(2) } }),
    item({ area: '', sched: { start: wk(4), len: wk(2) } }),
  ]), wk(24));
  assert.deepEqual(s.lanes.map((l) => l.area).sort(), ['Editor', 'Untagged']);
});

test('the ghost is drawn only where the bar has MOVED off its baseline', () => {
  const put = scheduleStrip(board([
    item({ area: 'A', sched: { start: wk(4), len: wk(2) }, baseline: { start: wk(4), len: wk(2) } }),
    item({ area: 'A', sched: { start: wk(6), len: wk(2) }, baseline: { start: wk(4), len: wk(2) } }),
    item({ area: 'A', sched: { start: wk(8), len: wk(2) }, baseline: null }),
  ]), wk(24));
  const [same, moved, none] = put.lanes[0].bars;
  assert.equal(same.ghost, null, 'a ghost under its own bar reads as a slip on every row');
  assert.ok(moved.ghost, 'a bar that moved shows what it was committed to');
  assert.equal(none.ghost, null);
});

test('unscheduled features are counted, not dropped', () => {
  const s = scheduleStrip(board([
    item({ sched: { start: wk(0), len: wk(2) } }), item(), item({ archived: true }),
  ]), wk(24));
  assert.equal(s.scheduled, 1);
  assert.equal(s.unscheduled, 1, 'an archived row is off the board entirely');
});

test('a bar wears the stage its own item is in', () => {
  const s = scheduleStrip(board([
    item({ area: 'A', sched: { start: wk(0), len: wk(1) }, claimedBy: 'feat/1-x' }),
    item({ area: 'A', sched: { start: wk(2), len: wk(1) }, builtNote: 'b', claimedBy: 'feat/2-y' }),
    item({ area: 'A', sched: { start: wk(4), len: wk(1) }, done: true, reviewTag: 'solid' }),
    item({ area: 'A', sched: { start: wk(6), len: wk(1) } }),
  ]), wk(24));
  assert.deepEqual(s.lanes[0].bars.map((b) => b.state), ['inflight', 'built', 'landed', 'planned']);
});

// --- in flight scope --------------------------------------------------------

test('a feature is drawn from its children, sized lines only', () => {
  const f = item({ title: 'Inline comments', claimedBy: 'feat/1-inline' });
  const kids = [
    item({ parentId: f.id, bucket: 'must', estimate: 3 }),
    item({ parentId: f.id, bucket: 'should', estimate: 1 }),
    item({ parentId: f.id, bucket: 'could', estimate: null }),   // unsized
  ];
  const [got] = inFlightScope(board([f, ...kids]));
  assert.deepEqual(got.segs.map((s) => [s.bucket, s.weeks]), [['must', 3], ['should', 1]]);
  assert.equal(got.segs[0].width, 75);
  assert.equal(got.totals.unsized, 1, 'an unsized line is counted apart, never as free');
  assert.equal(got.unscoped, false);
});

test('the bar IS the committed scope — a parked line and a Won\'t are not in it', () => {
  const f = item({ title: 'Resolve threads', claimedBy: 'ui/1-resolve' });
  const kids = [
    item({ parentId: f.id, bucket: 'must', estimate: 3 }),
    item({ parentId: f.id, bucket: 'should', estimate: 1 }),
    item({ parentId: f.id, bucket: 'could', estimate: 1.5, skipped: true }),  // cut from the cycle
    item({ parentId: f.id, bucket: 'wont', estimate: 2 }),                    // out of the feature
  ];
  const [got] = inFlightScope(board([f, ...kids]));
  assert.deepEqual(got.segs.map((s) => s.bucket), ['must', 'should']);
  const barWeeks = got.segs.reduce((n, s) => n + s.weeks, 0);
  assert.equal(barWeeks, got.totals.committed,
    'the bar and the "N wks committed" beside it must describe the same set');
  assert.equal(got.totals.deferred, 1.5);
  assert.equal(got.totals.out, 2);
});

test('an in-cycle Could IS in the bar — it is committed until somebody cuts it', () => {
  const f = item({ claimedBy: 'feat/1-x' });
  const [got] = inFlightScope(board([f,
    item({ parentId: f.id, bucket: 'must', estimate: 2 }),
    item({ parentId: f.id, bucket: 'could', estimate: 2 }),
  ]));
  assert.deepEqual(got.segs.map((s) => s.bucket), ['must', 'could']);
  assert.equal(got.totals.committed, 4);
});

test('a feature with no children says so rather than drawing an empty bar', () => {
  const [got] = inFlightScope(board([item({ claimedBy: 'feat/1-x' })]));
  assert.equal(got.unscoped, true);
  assert.deepEqual(got.segs, []);
});

test('in flight covers what is BUILT too — it is still the thing being worked', () => {
  const got = inFlightScope(board([
    item({ title: 'claimed', claimedBy: 'feat/1-a' }),
    item({ title: 'built', builtNote: 'b', claimedBy: 'feat/2-b' }),
    item({ title: 'planned' }),
    item({ title: 'landed', done: true, reviewTag: 'solid' }),
  ]));
  assert.deepEqual(got.map((f) => f.title).sort(), ['built', 'claimed']);
  assert.deepEqual(got.map((f) => f.state).sort(), ['built', 'inflight']);
});

// --- plan vs reality --------------------------------------------------------

test('NO BASELINE is unmeasured, and is NOT counted as on plan', () => {
  const p = planVsReality(board([
    item({ sched: { start: wk(4), len: wk(2) }, baseline: null }),
    item({ sched: { start: wk(4), len: wk(2) }, baseline: { start: wk(4), len: wk(2) } }),
  ]));
  assert.equal(p.unmeasured, 1);
  assert.equal(p.measured, 1);
  assert.deepEqual(p.rows, [], 'the baselined one has not moved, so it is not a slip row');
});

test('slip is measured against the baseline, worst first, both axes', () => {
  const p = planVsReality(board([
    item({ title: 'small', sched: { start: wk(5), len: wk(3) }, baseline: { start: wk(4), len: wk(3) } }),
    item({ title: 'big', sched: { start: wk(8), len: wk(6) }, baseline: { start: wk(4), len: wk(4) } }),
    item({ title: 'early', sched: { start: wk(2), len: wk(3) }, baseline: { start: wk(4), len: wk(3) } }),
  ]));
  assert.deepEqual(p.rows.map((r) => r.title), ['big', 'small', 'early']);
  assert.deepEqual([p.rows[0].min, p.rows[0].longer], [wk(4), wk(2)]);
  assert.equal(p.rows[2].min, wk(-2), 'earlier than plan is a real answer, not a slip');
  assert.equal(p.totalSlip, wk(5), 'only LATE drift adds to the slip total');
});

test('an unscheduled item cannot slip and is left out entirely', () => {
  const p = planVsReality(board([item({ sched: null, baseline: { start: wk(4), len: wk(2) } })]));
  assert.equal(p.measured, 0);
  assert.equal(p.unmeasured, 0);
});
