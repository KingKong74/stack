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
  SCHED_WEEKS, CYCLE_WEEKS, NOW_WEEK, scaleCols, slipOf, layoutLane, weekAt, scopeTotals,
  listKeyOf, proposeSchedule, proposeCompact, proposeTrim, inCycle,
  nowLeft, whatsNext, calendarMonths, weekDate, fmtDate,
  proposeCatchUp, proposeBalance, proposeByTier, areaMatches, horizonOf, UNALLOCATED,
  viewFor, clampView, focusOf, inView, SCALE_WEEKS,
} = await import(planUrl.href);

// Widest last — the order the toolbar draws them in, and the order the zoom
// tests walk to assert each step condenses what the one before it showed.
const SCALES = ['day', 'week', 'month', 'quarter'];

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

// --- the scale is a zoom -----------------------------------------------------

test('every scale rules exactly the viewport it is given', () => {
  for (const scale of SCALES) {
    const view = viewFor(scale);
    const cols = scaleCols(scale, view);
    const total = cols.reduce((n, c) => n + c.weeks, 0);
    // Floating point: a day column is a seventh of a week.
    assert.ok(Math.abs(total - view.weeks) < 1e-9, `${scale} columns must span its window`);
    assert.equal(cols[0].startWeek, view.start, `${scale} must start where its window does`);
  }
  // No scale may show more than can be scheduled — those weeks would be a
  // window onto nothing, and a drop into them is clamped back anyway.
  for (const scale of SCALES) assert.ok(SCALE_WEEKS[scale] <= SCHED_WEEKS);
  assert.equal(SCALE_WEEKS[SCALES[SCALES.length - 1]], SCHED_WEEKS, 'the widest scale is the whole horizon');
});

test('a scale is a ZOOM: the same bar stretches and condenses, the schedule does not move', () => {
  // The point of the control. A two-week bar inside a six-month window is four
  // pixels of nothing; at days it fills the track. What must NOT change is the
  // schedule — same weeks, different pixels.
  const it = item({ sched: { start: 6, len: 3 } });
  const widths = SCALES.map((s) => layoutLane('editor', [it], 1000, viewFor(s, 7)).bars[0].width);
  for (let i = 1; i < widths.length; i += 1) {
    assert.ok(widths[i] < widths[i - 1], `${SCALES[i]} must condense what ${SCALES[i - 1]} showed`);
  }
  // …and the item itself is untouched by any of it.
  assert.deepEqual(it.sched, { start: 6, len: 3 });
});

test('the full view still positions a bar as a fraction of the whole horizon', () => {
  const a = layoutLane('editor', [item({ sched: { start: 6, len: 3 } })], 1000).bars[0];
  assert.equal(a.left, (6 / SCHED_WEEKS) * 100);
  assert.equal(a.width, (3 / SCHED_WEEKS) * 100);
});

test('a bar is positioned against the viewport, not the horizon', () => {
  const view = { start: 4, weeks: 6 };
  const a = layoutLane('editor', [item({ sched: { start: 6, len: 3 } })], 1000, view).bars[0];
  assert.equal(a.left, ((6 - 4) / 6) * 100, 'the left edge is measured from the window, not week zero');
  assert.equal(a.width, (3 / 6) * 100);
});

test('a bar outside the window is COUNTED at its edge, never silently dropped', () => {
  // Zooming in is the one gesture that can empty a lane that is full of work.
  // A lane drawn as "drop something here" while holding three bars a fortnight
  // to the left is the chart lying about the plan.
  const lane = layoutLane('editor', [
    item({ title: 'behind', sched: { start: 0, len: 2 } }),
    item({ title: 'inside', sched: { start: 9, len: 2 } }),
    item({ title: 'ahead', sched: { start: 20, len: 2 } }),
  ], 1000, { start: 8, weeks: 6 });
  assert.deepEqual(lane.bars.map((b) => b.item.title), ['inside']);
  assert.equal(lane.offLeft, 1);
  assert.equal(lane.offRight, 1);
});

test('a bar straddling the window edge is drawn, not counted off', () => {
  const lane = layoutLane('editor', [item({ sched: { start: 6, len: 4 } })], 1000, { start: 8, weeks: 6 });
  assert.equal(lane.bars.length, 1, 'work that overlaps the window is in it');
  assert.equal(lane.offLeft, 0);
  assert.ok(lane.bars[0].left < 0, 'and it starts off the left edge, where CSS clips it');
});

test('a quarter column really is a quarter wide', () => {
  // Equal-width columns would misdraw every bar crossing one. The widths are
  // proportional to `weeks`, so this is the check that keeps them honest.
  const [q1, q2] = scaleCols('quarter', viewFor('quarter'));
  assert.equal(q1.weeks + q2.weeks, SCHED_WEEKS);
  assert.ok(q1.weeks > 1 && q2.weeks > 1);
});

test('days rules a seventh of a week per column and never claims to store one', () => {
  const view = viewFor('day');
  const cols = scaleCols('day', view, '2026-06-01');
  assert.equal(cols.length, view.weeks * 7);
  assert.ok(cols.every((c) => Math.abs(c.weeks - 1 / 7) < 1e-9));
  // Consecutive columns are consecutive DAYS…
  assert.equal(fmtDate(weekDate(cols[0].startWeek, '2026-06-01')), fmtDate(new Date(Date.parse('2026-06-01T00:00:00Z') + view.start * 7 * 86400000)));
  // …and a drop is still clamped to a whole week, because that is the unit the
  // column is reading, not the unit the schedule is stored in.
  assert.equal(weekAt(0, 1000, 2, view), view.start);
  assert.ok(Number.isInteger(weekAt(517, 1000, 2, view)));
});

// --- panning -----------------------------------------------------------------

test('a viewport cannot be panned off the schedulable domain', () => {
  assert.equal(clampView(-40, 6).start, 0);
  assert.equal(clampView(999, 6).start, SCHED_WEEKS - 6);
  assert.equal(clampView(999, SCHED_WEEKS).start, 0, 'the full horizon has nowhere to pan to');
});

test('zooming keeps the focus week, so what you are reading stays put', () => {
  const wide = viewFor('quarter');
  const near = viewFor('day', focusOf(wide));
  assert.ok(Math.abs(focusOf(near) - focusOf(wide)) <= 1, 'the third-across week survives the zoom');
  assert.ok(near.weeks < wide.weeks);
});

test('the now-line is reported OUTSIDE the track rather than pinned to its edge', () => {
  // Same rule as a NULL review_verdict: "cannot be seen from here" is not
  // "just off the edge". The caller draws nothing rather than a line at 0%.
  const far = { start: NOW_WEEK + 6, weeks: 6 };
  assert.ok(nowLeft(far) < 0, 'now is behind this window and must read as behind it');
  assert.ok(nowLeft({ start: 0, weeks: 2 }) > 100, 'and ahead of a window that ends before it');
  assert.equal(inView(NOW_WEEK, { start: NOW_WEEK, weeks: 2 }), true);
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

// --- now, what's next, and the calendar --------------------------------------

test('now sits inside the window, not at its edge', () => {
  // A timeline whose "today" is the right-hand edge shows only the past and has
  // nowhere to draw what is coming — which is most of what a plan is.
  assert.ok(NOW_WEEK > 0 && NOW_WEEK < SCHED_WEEKS - 1);
  assert.ok(nowLeft() > 20 && nowLeft() < 50, `now-line at ${nowLeft()}% should be roughly a third in`);
});

test('exactly one column is marked now, at every scale', () => {
  for (const scale of SCALES) {
    const marked = scaleCols(scale, viewFor(scale)).filter((c) => c.now);
    assert.equal(marked.length, 1, `${scale} must mark one column`);
    const c = marked[0];
    assert.ok(c.startWeek <= NOW_WEEK && NOW_WEEK < c.startWeek + c.weeks,
      `${scale}'s now column must actually contain week ${NOW_WEEK}`);
  }
});

test("what's next is soonest-first and excludes what is already finished", () => {
  const items = [
    item({ title: 'done', sched: { start: 10, len: 2 }, done: true }),
    item({ title: 'past', sched: { start: 0, len: 3 } }),          // ends before now
    item({ title: 'running', sched: { start: NOW_WEEK - 1, len: 4 } }),
    item({ title: 'soon', sched: { start: NOW_WEEK + 2, len: 2 } }),
    item({ title: 'later', sched: { start: NOW_WEEK + 9, len: 2 } }),
    item({ title: 'tray', sched: null }),
  ];
  const next = whatsNext(items);
  assert.deepEqual(next.map((n) => n.item.title), ['running', 'soon', 'later']);
  assert.equal(next[0].running, true, 'a bar spanning now is running, not upcoming');
  assert.equal(next[1].inWeeks, 2);
});

test("what's next is empty rather than wrong when nothing is scheduled ahead", () => {
  assert.deepEqual(whatsNext([item({ sched: { start: 0, len: 2 } })]), []);
});

test('a week index becomes a real date only when the project has a week zero', () => {
  assert.equal(weekDate(3, null), null, 'no start date means no date, not epoch');
  const d = weekDate(3, '2026-06-01');
  assert.equal(d.toISOString().slice(0, 10), '2026-06-22');
  assert.equal(fmtDate(d), '22 Jun');
});

test('the ruler shows real months once there is a week zero, and M1..Mn without one', () => {
  const full = { start: 0, weeks: SCHED_WEEKS };
  assert.equal(scaleCols('month', full, null)[0].label, 'M1');
  assert.equal(scaleCols('month', full, '2026-06-01')[0].label, 'Jun');
});

test('the calendar refuses to draw without a start date rather than inventing one', () => {
  assert.deepEqual(calendarMonths([item({ sched: { start: 1, len: 2 } })], null), []);
});

test('a calendar week lists every bar RUNNING in it, not only those that start in it', () => {
  const long = item({ title: 'long', sched: { start: 0, len: 4 } });
  const months = calendarMonths([long], '2026-06-01');
  const weeks = months.flatMap((m) => m.weeks).slice(0, 5);
  assert.deepEqual(weeks.map((w) => w.items.length), [1, 1, 1, 1, 0],
    'the bar spans four weeks, so it appears on four');
  assert.equal(weeks[0].from.toISOString().slice(0, 10), '2026-06-01');
});

test('the calendar marks the now week exactly once', () => {
  const months = calendarMonths([item({ sched: { start: 0, len: 1 } })], '2026-06-01');
  const nows = months.flatMap((m) => m.weeks).filter((w) => w.now);
  assert.equal(nows.length, 1);
  assert.equal(nows[0].week, NOW_WEEK);
});

// --- in the cycle ------------------------------------------------------------
// `inCycle` is what the Roadmap tab's area chips count, what decides whether an
// area chip is hidden, and what the Tiers board ranks. Three surfaces, one
// predicate — these pin the three exclusions and, just as importantly, the two
// states that are NOT exclusions.

test('the three exclusions: archived, parked and a Won\'t', () => {
  assert.equal(inCycle(item()), true);
  assert.equal(inCycle(item({ archived: true })), false, 'off the board, but recoverable');
  assert.equal(inCycle(item({ skipped: true })), false, 'cut from this cycle');
  assert.equal(inCycle(item({ bucket: 'wont' })), false, 'out of the feature entirely');
});

test('a DONE row is still in the cycle — it is the cycle’s work, finished', () => {
  // Excluding it would empty an area's chip the moment its work shipped, and
  // take the Timeline lane that still draws its bars with it.
  assert.equal(inCycle(item({ done: true })), true);
  assert.equal(inCycle(item({ done: true, bucket: 'must' })), true);
});

test('a CLAIMED row is in the cycle — being worked on is not being excluded', () => {
  assert.equal(inCycle(item({ claimedBy: 'feat/1-x' })), true);
});

test('the exclusions compose — any one of them is enough', () => {
  assert.equal(inCycle(item({ bucket: 'must', archived: true })), false);
  assert.equal(inCycle(item({ bucket: 'could', skipped: true })), false);
  assert.equal(inCycle(item({ bucket: 'wont', done: true })), false);
});

test('inCycle agrees with scopeTotals about what is committed', () => {
  // The chips and the scope drawer must never describe different populations.
  const kids = [
    item({ bucket: 'must', estimate: 2 }),
    item({ bucket: 'could', estimate: 1 }),
    item({ bucket: 'could', estimate: 1, skipped: true }),   // deferred
    item({ bucket: 'wont', estimate: 3 }),                   // out
  ];
  const totals = scopeTotals(kids);
  const summed = kids.filter(inCycle).reduce((n, k) => n + (k.estimate ?? 0), 0);
  assert.equal(summed, totals.committed);
});

// --- the three new arrangements ---------------------------------------------

test('catch-up moves only what finished in the past, never what is running', () => {
  const past = item({ title: 'past', sched: { start: 0, len: 3 } });          // ends wk 3, now is 8
  const running = item({ title: 'running', sched: { start: NOW_WEEK - 1, len: 4 } });
  const ahead = item({ title: 'ahead', sched: { start: NOW_WEEK + 3, len: 2 } });
  const p = proposeCatchUp([past, running, ahead]);
  assert.deepEqual(p.moves.map((m) => m.id), [past.id]);
  assert.equal(p.moves[0].sched.start, NOW_WEEK);
  assert.equal(p.moves[0].sched.len, 3, 'catching up must not change how long it takes');
});

test('catch-up says so when nothing is stranded in the past', () => {
  const p = proposeCatchUp([item({ sched: { start: NOW_WEEK + 1, len: 2 } })]);
  assert.equal(p.moves.length, 0);
  assert.match(p.summary, /Nothing is scheduled entirely in the past/);
});

test('levelling hands one bar from the busiest lane to the emptiest', () => {
  const heavy = [
    item({ area: 'editor', sched: { start: NOW_WEEK, len: 4 } }),
    item({ area: 'editor', title: 'last in editor', sched: { start: NOW_WEEK + 4, len: 3 } }),
  ];
  const light = [item({ area: 'billing', sched: { start: NOW_WEEK, len: 1 } })];
  const p = proposeBalance([...heavy, ...light]);
  assert.equal(p.moves.length, 1, 'one bar only — levelling is not worth reorganising a board over');
  assert.equal(p.moves[0].id, heavy[1].id, 'the LAST bar in the heavy lane is the cheapest to move');
});

test('levelling never moves claimed work, and says why it could not', () => {
  const p = proposeBalance([
    item({ area: 'editor', claimedBy: 'feat/1-x', sched: { start: NOW_WEEK, len: 6 } }),
    item({ area: 'billing', sched: { start: NOW_WEEK, len: 1 } }),
  ]);
  assert.equal(p.moves.length, 0);
  assert.match(p.summary, /every bar in it is claimed/);
});

test('levelling leaves lanes that are already within a week of each other', () => {
  const p = proposeBalance([
    item({ area: 'editor', sched: { start: NOW_WEEK, len: 3 } }),
    item({ area: 'billing', sched: { start: NOW_WEEK, len: 3 } }),
  ]);
  assert.equal(p.moves.length, 0);
  assert.match(p.summary, /within a week/);
});

test('tier order reorders a lane to S, A, B, C without changing lengths', () => {
  const c = item({ area: 'editor', tier: 'C', sched: { start: NOW_WEEK, len: 2 } });
  const s0 = item({ area: 'editor', tier: 'S', sched: { start: NOW_WEEK + 2, len: 3 } });
  const p = proposeByTier([c, s0]);
  const byId = Object.fromEntries(p.moves.map((m) => [m.id, m.sched]));
  assert.equal(byId[s0.id].start, NOW_WEEK, 'the S takes the first slot');
  assert.equal(byId[s0.id].len, 3, 'lengths are untouched');
  assert.equal(byId[c.id].start, NOW_WEEK + 3, 'the C follows it');
});

test('tier order leaves a lane that is already in order, and says so', () => {
  const p = proposeByTier([
    item({ area: 'editor', tier: 'S', sched: { start: NOW_WEEK, len: 2 } }),
    item({ area: 'editor', tier: 'B', sched: { start: NOW_WEEK + 2, len: 2 } }),
  ]);
  assert.equal(p.moves.length, 0);
  assert.match(p.summary, /already runs in tier order/);
});

test('none of the three arrangements mutates its input', () => {
  const items = [
    item({ area: 'editor', tier: 'C', sched: { start: 0, len: 2 } }),
    item({ area: 'billing', tier: 'S', sched: { start: NOW_WEEK + 1, len: 4 } }),
  ];
  const before = JSON.stringify(items);
  proposeCatchUp(items); proposeBalance(items); proposeByTier(items);
  assert.equal(JSON.stringify(items), before);
});

// ---- the area filter --------------------------------------------------------
// Every view filters on one string, and the sentinel is the part that can go
// silently wrong: `i.area === areaFilter` under UNALLOCATED matches nothing and
// renders as an empty board rather than as the filter it is.

test('the empty filter admits every area, tagged or not', () => {
  assert.equal(areaMatches('editor', ''), true);
  assert.equal(areaMatches('', ''), true);
});

test('a named filter admits only that area', () => {
  assert.equal(areaMatches('editor', 'editor'), true);
  assert.equal(areaMatches('billing', 'editor'), false);
  assert.equal(areaMatches('', 'editor'), false);
});

test('UNALLOCATED admits untagged rows and nothing else', () => {
  assert.equal(areaMatches('', UNALLOCATED), true);
  assert.equal(areaMatches('editor', UNALLOCATED), false);
});

test('the sentinel cannot collide with a real area — the server lowercases them', () => {
  assert.equal(UNALLOCATED, UNALLOCATED.toUpperCase());
  assert.notEqual(UNALLOCATED, UNALLOCATED.toLowerCase());
});

// ---- the horizon ------------------------------------------------------------
// Unscheduled AND unsized: on the roadmap, not yet in the plan. It is drawn as
// its own row under the lanes, and it used to be the ONE population on the
// chart that ignored the area chip — which does not look like a bug, it looks
// like unsized work in the area you are filtered to.

test('the horizon is the unscheduled and unsized, and obeys the area chip', () => {
  const items = [
    item({ area: 'editor', title: 'no size', estimate: null, sched: null }),
    item({ area: 'billing', title: 'other area', estimate: null, sched: null }),
    item({ area: 'editor', title: 'sized', estimate: 2, sched: null }),
    item({ area: 'editor', title: 'scheduled', estimate: null, sched: { start: 3, len: 2 } }),
  ];
  assert.deepEqual(horizonOf(items, '').map((i) => i.title), ['no size', 'other area']);
  assert.deepEqual(horizonOf(items, 'editor').map((i) => i.title), ['no size']);
  assert.deepEqual(horizonOf(items, 'billing').map((i) => i.title), ['other area']);
});

test('the horizon takes the untagged chip like any other filter', () => {
  const items = [
    item({ area: '', title: 'untagged', estimate: null, sched: null }),
    item({ area: 'editor', title: 'tagged', estimate: null, sched: null }),
  ];
  assert.deepEqual(horizonOf(items, UNALLOCATED).map((i) => i.title), ['untagged']);
});

test('the horizon holds no finished or archived work', () => {
  const items = [
    item({ area: 'editor', title: 'done', estimate: null, sched: null, done: true }),
    item({ area: 'editor', title: 'archived', estimate: null, sched: null, archived: true }),
    item({ area: 'editor', title: 'open', estimate: null, sched: null }),
  ];
  assert.deepEqual(horizonOf(items, '').map((i) => i.title), ['open']);
});
