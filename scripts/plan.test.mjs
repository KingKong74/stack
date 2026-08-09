#!/usr/bin/env node
// Tests for web/src/lib/plan.ts — the Roadmap tab v2's arithmetic.
// Run: node --experimental-strip-types scripts/plan.test.mjs
//
// Same loader shim as scripts/feature.test.mjs (#365) — see that file's header.
//
// The bar geometry is the part of a Gantt that is genuinely easy to get subtly
// wrong, and a wrong bar is a plan somebody acts on. Most of what follows pins
// a case that renders plausibly while being false: a label overlapping the next
// bar, a slip that vanishes because the baseline moved with it, a cycle that
// "fits" because half its lines are unsized.
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

const planUrl = new URL('../web/src/lib/plan.ts', import.meta.url);
const {
  SCHED_WEEKS, CYCLE_WEEKS, scaleCols, slipOf, layoutLane, weekAt, scopeTotals,
  listKeyOf, proposeSchedule, proposeCompact, proposeTrim,
} = await import(planUrl.href);

let seq = 0;
function item(over = {}) {
  seq += 1;
  return {
    id: seq, title: over.title || `Item ${seq}`, note: '', done: false, bucket: 'should',
    source: 'manual', reviewed: true, claimedBy: '', area: 'editor', builtNote: '',
    reviewTag: '', reviewTags: [], refineNote: '', reviewShelved: false,
    skipped: false, skippedAt: null, risk: 'normal', riskSource: '', riskReason: '',
    tier: '', plan: [], updatedAt: null, agentProfile: '',
    parentId: null, sched: null, baseline: null, labels: [], listKey: '',
    archived: false, estimate: null,
    ...over,
  };
}

// --- the scale is cosmetic ---------------------------------------------------

test('the scale changes the headings and never the geometry', () => {
  for (const scale of ['week', 'month', 'quarter']) {
    const cols = scaleCols(scale);
    const total = cols.reduce((n, c) => n + c.weeks, 0);
    assert.equal(total, SCHED_WEEKS, `${scale} columns must span the whole window`);
  }
  // A bar's position is in weeks, so it cannot depend on the scale at all.
  const it = item({ sched: { start: 6, len: 3 } });
  const a = layoutLane('editor', [it], 1000).bars[0];
  assert.equal(a.left, (6 / SCHED_WEEKS) * 100);
  assert.equal(a.width, (3 / SCHED_WEEKS) * 100);
});

test('a quarter column really is a quarter wide', () => {
  // Equal-width columns would misdraw every bar crossing one. The widths are
  // proportional to `weeks`, so this is the check that keeps them honest.
  const [q1, q2] = scaleCols('quarter');
  assert.equal(q1.weeks + q2.weeks, SCHED_WEEKS);
  assert.ok(q1.weeks > 1 && q2.weeks > 1);
});

// --- slip --------------------------------------------------------------------

test('no baseline is NOT on plan', () => {
  const s = slipOf(item({ sched: { start: 4, len: 2 } }));
  assert.equal(s.measured, false);
  assert.equal(s.weeks, null, 'unmeasured slip must not read as zero');
});

test('slip is start drift and duration drift, separately', () => {
  const s = slipOf(item({ sched: { start: 9, len: 6 }, baseline: { start: 4, len: 5 } }));
  assert.equal(s.weeks, 5);
  assert.equal(s.longer, 1);
  assert.equal(s.measured, true);
});

test('a bar sitting on its baseline draws no ghost', () => {
  const on = item({ sched: { start: 4, len: 3 }, baseline: { start: 4, len: 3 } });
  const off = item({ sched: { start: 6, len: 3 }, baseline: { start: 4, len: 3 } });
  assert.equal(layoutLane('editor', [on], 1000).bars[0].ghost, null);
  assert.notEqual(layoutLane('editor', [off], 1000).bars[0].ghost, null);
});

// --- lane stacking -----------------------------------------------------------

test('overlapping bars stack onto separate rows', () => {
  const lane = layoutLane('editor', [
    item({ title: 'A', sched: { start: 0, len: 6 } }),
    item({ title: 'B', sched: { start: 3, len: 6 } }),
  ], 1200);
  assert.equal(lane.rows, 2);
  assert.notEqual(lane.bars[0].row, lane.bars[1].row);
});

test('bars that clear each other share a row', () => {
  const lane = layoutLane('editor', [
    item({ title: 'A', sched: { start: 0, len: 2 } }),
    item({ title: 'B', sched: { start: 18, len: 2 } }),
  ], 1200);
  assert.equal(lane.rows, 1);
  assert.equal(lane.bars[0].row, lane.bars[1].row);
});

test('a bar whose LABEL would sit on the next bar is pushed to its own row', () => {
  // The bars themselves do not overlap. Their labels do — and a label lying
  // across the next bar is how a Gantt starts misreporting dates.
  const lane = layoutLane('editor', [
    item({ title: 'A very long feature title indeed', sched: { start: 0, len: 1 } }),
    item({ title: 'B', sched: { start: 2, len: 1 } }),
  ], 700);
  assert.equal(lane.bars[0].inside, false, 'the long title cannot fit its 1-week bar');
  assert.equal(lane.rows, 2, 'so it must not share a row with the bar its label crosses');
});

test('a label that would overflow the right edge goes to the left of its bar', () => {
  const lane = layoutLane('editor', [
    item({ title: 'A rather long trailing label', sched: { start: 22, len: 2 } }),
  ], 700);
  assert.equal(lane.bars[0].before, true);
});

test('unscheduled items are not laid out at week zero', () => {
  const lane = layoutLane('editor', [item({ sched: null }), item({ sched: { start: 3, len: 2 } })], 900);
  assert.equal(lane.bars.length, 1, 'the tray item must not appear on the lane at all');
});

// --- dropping ----------------------------------------------------------------

test('a drop is clamped so the whole bar stays in the window', () => {
  assert.equal(weekAt(-500, 1000, 3), 0);
  assert.equal(weekAt(99999, 1000, 3), SCHED_WEEKS - 3);
  assert.equal(weekAt(500, 1000, 2), 12);
});

// --- the scope drawer --------------------------------------------------------

test('a Could is IN the cycle until it is cut — that is what "first to cut" means', () => {
  // The distinction that matters: committed is Must+Should+Could, deferred is
  // what has actually been parked. Treating Coulds as pre-deferred made
  // proposeTrim believe cutting one bought back a week it had never spent.
  const t = scopeTotals([
    item({ bucket: 'must', estimate: 2 }),
    item({ bucket: 'should', estimate: 1.5 }),
    item({ bucket: 'could', estimate: 1 }),
    item({ bucket: 'could', estimate: 2, skipped: true }),
    item({ bucket: 'wont', estimate: 3 }),
  ]);
  assert.equal(t.committed, 4.5, 'the live Could counts');
  assert.equal(t.deferred, 2, 'the parked one does not');
  assert.equal(t.out, 3);
});

test('an unsized line is counted apart, never as free', () => {
  const t = scopeTotals([
    item({ bucket: 'must', estimate: 5 }),
    item({ bucket: 'must', estimate: null }),
  ]);
  assert.equal(t.unsized, 1);
  assert.equal(t.committed, 5, 'the unsized line adds nothing…');
  assert.ok(t.unsized > 0, '…but the drawer can say the total is incomplete');
});

test('a parked line stops counting against the cycle', () => {
  const kids = [item({ bucket: 'must', estimate: 4 }), item({ bucket: 'should', estimate: 4 })];
  assert.equal(scopeTotals(kids).fits, false);
  kids[1].skipped = true;
  assert.equal(scopeTotals(kids).fits, true);
});

// --- the proposals -----------------------------------------------------------

test('schedule proposes and never mutates its input', () => {
  const items = [item({ bucket: 'must', estimate: 2, area: 'editor' })];
  const before = JSON.stringify(items);
  const p = proposeSchedule(items);
  assert.equal(p.moves.length, 1);
  assert.equal(JSON.stringify(items), before, 'the input must be untouched');
  assert.equal(items[0].sched, null, 'nothing is applied');
});

test('schedule stacks each area after its own last bar', () => {
  const p = proposeSchedule([
    item({ area: 'editor', bucket: 'must', sched: { start: 0, len: 4 } }),
    item({ area: 'editor', bucket: 'must', estimate: 2 }),
    item({ area: 'billing', bucket: 'must', estimate: 3 }),
  ]);
  const byId = Object.fromEntries(p.moves.map((m) => [m.id, m.sched]));
  const editorNew = Object.values(byId)[0];
  assert.equal(editorNew.start, 4, 'follows the editor lane, not the billing one');
  assert.equal(Object.values(byId)[1].start, 0, 'billing is empty so it starts at zero');
});

test('schedule leaves Coulds and Wonts alone', () => {
  const p = proposeSchedule([
    item({ bucket: 'could', estimate: 1 }), item({ bucket: 'wont', estimate: 1 }),
  ]);
  assert.equal(p.moves.length, 0);
  assert.match(p.summary, /already on the timeline/);
});

test('compact closes gaps but never moves finished work', () => {
  const p = proposeCompact([
    item({ area: 'editor', sched: { start: 0, len: 2 }, done: true }),
    item({ area: 'editor', sched: { start: 10, len: 2 } }),
  ]);
  // The done bar is excluded entirely, so the planned one is the first in its
  // lane and has nothing to close up against.
  assert.equal(p.moves.length, 0, 'a lane holding only finished work has no gap to close');
});

test('compact pulls a later bar up to the one before it', () => {
  const p = proposeCompact([
    item({ area: 'editor', sched: { start: 0, len: 3 } }),
    item({ area: 'editor', sched: { start: 9, len: 2 } }),
  ]);
  assert.equal(p.moves.length, 1);
  assert.equal(p.moves[0].sched.start, 3);
  assert.match(p.summary, /6 idle weeks/);
});

test('trim defers Coulds before Shoulds and never touches a Must', () => {
  const kids = [
    item({ bucket: 'must', estimate: 5, title: 'must' }),
    item({ bucket: 'should', estimate: 2, title: 'should' }),
    item({ bucket: 'could', estimate: 2, title: 'could' }),
  ];
  const p = proposeTrim(kids, CYCLE_WEEKS);
  const titles = p.defer.map((id) => kids.find((k) => k.id === id).title);
  assert.deepEqual(titles, ['could', 'should']);
  assert.ok(!titles.includes('must'));
});

test('trim refuses rather than cutting a Must, and says so', () => {
  const p = proposeTrim([item({ bucket: 'must', estimate: 20 })], CYCLE_WEEKS);
  assert.equal(p.defer.length, 0);
  assert.match(p.summary, /only Musts remain/);
});

test('trim on a feature that already fits proposes nothing', () => {
  const p = proposeTrim([item({ bucket: 'must', estimate: 1 })], CYCLE_WEEKS);
  assert.equal(p.defer.length, 0);
  assert.match(p.summary, /nothing to cut/i);
});

// --- list derivation ---------------------------------------------------------

test('an untouched card derives its column from the state it already carries', () => {
  assert.equal(listKeyOf(item({ done: true })), 'shipped');
  assert.equal(listKeyOf(item({ claimedBy: 'feat/3-x' })), 'progress');
  assert.equal(listKeyOf(item({ source: 'hook', reviewed: false })), 'idea');
  assert.equal(listKeyOf(item({})), 'planned');
});

test('an explicit column always wins over the derivation', () => {
  assert.equal(listKeyOf(item({ done: true, listKey: 'planned' })), 'planned');
});
