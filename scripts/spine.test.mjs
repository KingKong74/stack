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
} = await import(spineUrl.href);

// --- fixtures ---------------------------------------------------------

const DAY = 86400000;
const NOW = Date.parse('2026-08-09T00:00:00Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();

let seq = 0;
function item(over = {}) {
  seq += 1;
  return {
    id: seq, title: `Item ${seq}`, note: '', done: false, bucket: 'should',
    source: 'manual', reviewed: true, claimedBy: '', area: '', builtNote: '',
    reviewTag: '', reviewTags: [], refineNote: '', reviewShelved: false,
    skipped: false, skippedAt: null, risk: 'normal', riskSource: '', riskReason: '',
    tier: '', plan: [], updatedAt: ago(1), agentProfile: '',
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

test('the five stages count a real board without overlap', () => {
  const items = [
    item({ bucket: 'must' }),                                             // planned
    item({ bucket: 'should' }),                                           // planned
    item({ claimedBy: 'feat/3-live' }),                                   // in flight
    item({ done: false, builtNote: 'b', claimedBy: 'fix/4-b' }),          // built
    item({ done: true }),                                                 // built (ticked, no verdict)
    item({ done: true, reviewTag: 'solid' }),                             // landed
  ];
  const s = buildSpine(board(items), [{ id: 1 }, { id: 2 }], 'demo', NOW);
  assert.deepEqual(s.map((x) => x.count), [2, 2, 1, 2, 1]);
  // every roadmap row lands in exactly one of the four roadmap stages
  const roadmapTotal = s.slice(1).reduce((n, x) => n + x.count, 0);
  assert.equal(roadmapTotal, items.length);
});

test('a stage sends you to the tab or room that owns it', () => {
  const s = buildSpine(board([]), [], 'demo', NOW);
  assert.match(stage(s, 'idea').href, /futures/);
  assert.match(stage(s, 'planned').href, /roadmap/);
  assert.equal(stage(s, 'inflight').href, '#/control');
  assert.equal(stage(s, 'built').href, '#/control/review');
  assert.match(stage(s, 'landed').href, /activity/);
});

// --- the bottleneck ---------------------------------------------------

test('a deep queue that has not moved in days is flagged, and only one is', () => {
  const items = [
    ...Array.from({ length: 12 }, () => item({ updatedAt: ago(9) })),                 // planned, still
    ...Array.from({ length: 20 }, () => item({ done: true, updatedAt: ago(6) })),     // built, still
  ];
  const s = buildSpine(board(items), [], 'demo', NOW);
  assert.equal(s.filter((x) => x.blocked).length, 1, 'exactly one bottleneck');
  assert.equal(stage(s, 'built').blocked, true, 'the deeper still queue wins');
  assert.equal(stage(s, 'built').lastMovedDays, 6);
});

test('a queue that moved today is not a bottleneck however deep', () => {
  const items = Array.from({ length: 40 }, () => item({ done: true, updatedAt: ago(0) }));
  const s = buildSpine(board(items), [], 'demo', NOW);
  assert.equal(s.some((x) => x.blocked), false);
});

test('LANDED is never the bottleneck — a finished project is not stuck', () => {
  const items = Array.from({ length: 300 }, () => item({ done: true, reviewTag: 'solid', updatedAt: ago(90) }));
  const s = buildSpine(board(items), [], 'demo', NOW);
  assert.equal(stage(s, 'landed').count, 300);
  assert.equal(s.some((x) => x.blocked), false);
});

test('an unstamped queue is not reported as still', () => {
  // No updatedAt anywhere: the rows have not been SHOWN to be sitting, which is
  // a different claim from having sat. Absent is not zero.
  const items = Array.from({ length: 30 }, () => item({ done: true, updatedAt: null }));
  const s = buildSpine(board(items), [], 'demo', NOW);
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
