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
// "fits" because half its lines are unsized, a grain that claims to draw hours
// onto a four-pixel day.
//
// #401 — THE SCHEDULE IS MINUTES, NOT A WEEK INDEX, and several tests here are
// specifically about the unit: a `sched` that still reads as weeks somewhere
// draws a two-hour bar as a fortnight, which is the failure this file exists to
// make loud.
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
  MIN_PER_HOUR, MIN_PER_DAY, MIN_PER_WEEK, SCHED_WEEKS, SCHED_MINUTES, MIN_SCHED_LEN,
  CYCLE_WEEKS, NOW_WEEK, PX_DAY_MIN, PX_DAY_MAX, ZOOM_STOPS,
  dateAt, minAt, nowMin, fmtDate, fmtTime, fmtDur, weekNo,
  pxPerDay, grainFor, spanForPx, clampSpan, viewAround, centreOn, panBy, zoomAt, fitAll,
  leftPct, spanPct, inView, snapFor, snapTo, timeAt, clampSpanToDomain,
  ticksFor, windowLabel, spanLabel,
  whatsNext, fmtWhen, calendarDays, calendarMonths, CAL_HOUR_FROM,
  slipOf, layoutLane, scopeTotals, defaultLen, DUR_OPTIONS, rolledSched, isRolled,
  newItemSched,
  listKeyOf, inCycle, areaMatches, horizonOf, UNALLOCATED,
} = await import(planUrl.href);

// A Monday, which is what a project's week zero is. Several tests below read a
// weekday off it, so a Tuesday here would move every one of them.
const WZ = '2026-06-01';
/** A viewport in the units the chart uses, spelled in days for legibility. */
const days = (start, span) => ({ start: start * MIN_PER_DAY, span: span * MIN_PER_DAY });

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

// --- the units ---------------------------------------------------------------

test('the units are what the column stores, and the domain is spelled in them', () => {
  assert.equal(MIN_PER_HOUR, 60);
  assert.equal(MIN_PER_DAY, 1440);
  assert.equal(MIN_PER_WEEK, 10080);
  // The twin of SCHED_MINUTES in server/src/routes/roadmap.js. If these two ever
  // disagree the client clamps a drag to one horizon and the server to another,
  // and a bar silently snaps back on release.
  assert.equal(SCHED_MINUTES, SCHED_WEEKS * MIN_PER_WEEK);
  assert.equal(MIN_SCHED_LEN, 15, 'the finest thing the hour grain snaps to');
});

test('a duration is said in the units a person would say it in', () => {
  assert.equal(fmtDur(90), '1h 30m');
  assert.equal(fmtDur(120), '2h');
  assert.equal(fmtDur(45), '45m');
  assert.equal(fmtDur(MIN_PER_DAY), '1d');
  // A 3d 4h bar is 3d 4h, never 76h — the point of having two branches.
  assert.equal(fmtDur(3 * MIN_PER_DAY + 4 * MIN_PER_HOUR), '3d 4h');
  assert.equal(fmtDur(MIN_PER_WEEK), '7d');
});

// --- dates -------------------------------------------------------------------

test('an offset becomes a real instant only when the project has a week zero', () => {
  assert.equal(dateAt(3 * MIN_PER_WEEK, null), null, 'no start date means no date, not epoch');
  const d = dateAt(3 * MIN_PER_WEEK, WZ);
  assert.equal(d.toISOString().slice(0, 10), '2026-06-22');
  assert.equal(fmtDate(d), '22 Jun');
});

test('minutes and instants round-trip, in UTC', () => {
  // UTC throughout, or every bar slides by the reader's own offset and a 09:00
  // start reads as 20:00 for anyone far enough east.
  const at = 5 * MIN_PER_DAY + 9 * MIN_PER_HOUR + 30;
  assert.equal(minAt(dateAt(at, WZ), WZ), at);
  assert.equal(fmtTime(dateAt(at, WZ)), '09:30');
});

test('now is the real clock with a week zero, and a fixed third-in week without one', () => {
  // A fixed week 8 was tolerable while the finest column was a week wide. On an
  // hour grid it would put the now-line somewhere today provably is not.
  assert.equal(nowMin(null), NOW_WEEK * MIN_PER_WEEK);
  const at = new Date(Date.parse('2026-06-17T14:36:00Z'));
  assert.equal(nowMin(WZ, at), 16 * MIN_PER_DAY + 14 * MIN_PER_HOUR + 36);
});

test('now is NOT clamped into the domain — a project can outlive its own horizon', () => {
  // Clamping would draw the now-line at the right-hand edge, which is a claim
  // that today is the last week of the plan. The caller checks `inView` and says
  // "now is off this window" instead. Same rule as a NULL review_verdict.
  const late = new Date(Date.parse('2027-06-01T00:00:00Z'));
  assert.ok(nowMin(WZ, late) > SCHED_MINUTES);
});

// --- the zoom ----------------------------------------------------------------

test('the grain is DERIVED from pixels, so "Hour" cannot be selected onto a 4px day', () => {
  const track = 1000;
  const at = (px) => grainFor({ start: 0, span: spanForPx(px, track) }, track);
  assert.equal(at(300), 'hour');
  assert.equal(at(46), 'day');
  assert.equal(at(15), 'week');
  assert.equal(at(5), 'month');
  assert.equal(at(2.1), 'quarter');
});

test('every named stop lands in the grain it is named after, at any track width', () => {
  // A stop is a pixel DENSITY, not a mode, so the same press has to give the
  // same reading experience on a phone and on a wide monitor.
  for (const track of [420, 900, 1800]) {
    for (const s of ZOOM_STOPS) {
      const view = { start: 0, span: clampSpan(spanForPx(s.px, track), track) };
      assert.equal(grainFor(view, track), s.key, `${s.label} at ${track}px`);
    }
  }
});

test('the zoom cannot be pushed past its own range', () => {
  const track = 1000;
  const tight = clampSpan(1, track);
  const loose = clampSpan(1e12, track);
  assert.ok(pxPerDay({ start: 0, span: tight }, track) <= PX_DAY_MAX + 1e-6);
  assert.ok(pxPerDay({ start: 0, span: loose }, track) >= PX_DAY_MIN - 1e-6);
});

test('zooming keeps whatever is under the anchor exactly where it is', () => {
  // The whole reason a wheel zoom anchors on the cursor: the bar you are reading
  // must not slide out from under you while everything around it stretches.
  const track = 1000;
  const view = days(0, 30);
  for (const anchor of [0, 0.25, 0.5, 1]) {
    const before = view.start + view.span * anchor;
    const after = zoomAt(view, track, 2, anchor);
    assert.ok(Math.abs((after.start + after.span * anchor) - before) < 1e-6,
      `the point at ${anchor} must not move`);
    assert.ok(after.span < view.span, 'and zooming in must actually narrow the window');
  }
});

test('a bar stretches and condenses with the zoom; the schedule does not move', () => {
  const it = item({ sched: { start: 6 * MIN_PER_DAY, len: 3 * MIN_PER_DAY } });
  // Every window contains the bar; only their WIDTH differs.
  const widths = [1, 7, 30, 120].map(
    (d) => layoutLane('editor', [it], 1000, days(6, d)).bars[0].width);
  for (let i = 1; i < widths.length; i += 1) {
    assert.ok(widths[i] < widths[i - 1], 'a wider window must condense what the narrower one showed');
  }
  // …and the item itself is untouched by any of it.
  assert.deepEqual(it.sched, { start: 6 * MIN_PER_DAY, len: 3 * MIN_PER_DAY });
});

// --- panning -----------------------------------------------------------------

test('the VIEWPORT pans anywhere — a window that stops dead explains nothing', () => {
  const v = panBy(days(0, 14), -400 * MIN_PER_DAY);
  assert.ok(v.start < 0, 'panning before week zero is allowed; it just shows empty time');
  assert.ok(panBy(days(0, 14), 4000 * MIN_PER_DAY).start > SCHED_MINUTES);
});

test('a BAR does not: every edit is clamped to the schedulable domain', () => {
  // The pair that makes rule 5 safe. The viewport may wander; a write may not.
  assert.deepEqual(clampSpanToDomain({ start: -5000, len: MIN_PER_DAY }),
    { start: 0, len: MIN_PER_DAY });
  const far = clampSpanToDomain({ start: SCHED_MINUTES + 1e6, len: MIN_PER_DAY });
  assert.equal(far.start + far.len, SCHED_MINUTES);
  assert.equal(clampSpanToDomain({ start: 0, len: 1 }).len, MIN_SCHED_LEN,
    'a zero-width bar is one you can neither see nor grab');
});

test('centring puts a moment a third of the way in, not at the edge', () => {
  const v = centreOn(days(0, 30), 100 * MIN_PER_DAY);
  const at = (100 * MIN_PER_DAY - v.start) / v.span;
  assert.ok(Math.abs(at - 1 / 3) < 1e-9, 'a planning instrument should be mostly future');
});

test('fit-all frames every bar with room either side, and holds the zoom range', () => {
  const spans = [
    { start: 2 * MIN_PER_DAY, len: MIN_PER_DAY },
    { start: 40 * MIN_PER_DAY, len: 3 * MIN_PER_DAY },
  ];
  const v = fitAll(spans, 1000, 0);
  assert.ok(v.start < spans[0].start, 'the earliest bar is not flush against the left edge');
  assert.ok(v.start + v.span > spans[1].start + spans[1].len, 'and the latest is inside the right');
  assert.ok(pxPerDay(v, 1000) >= PX_DAY_MIN - 1e-6);
});

test('fit-all with nothing scheduled falls back to a window around the moment given', () => {
  const v = fitAll([], 1000, 10 * MIN_PER_DAY);
  assert.ok(inView(10 * MIN_PER_DAY, v));
});

// --- where a bar is drawn ----------------------------------------------------

test('a bar is positioned against the viewport, not the horizon', () => {
  const view = days(4, 6);
  const a = layoutLane('editor',
    [item({ sched: { start: 6 * MIN_PER_DAY, len: 3 * MIN_PER_DAY } })], 1000, view).bars[0];
  assert.equal(a.left, ((6 - 4) / 6) * 100, 'the left edge is measured from the window, not week zero');
  assert.equal(a.width, (3 / 6) * 100);
});

test('a sub-day bar is a sub-day bar — the unit is minutes all the way down', () => {
  // The #401 regression in one line. Read as weeks, a 90-minute bar would be
  // 90 weeks wide and would swallow the whole chart.
  const view = days(0, 1);
  const a = layoutLane('editor',
    [item({ sched: { start: 9 * MIN_PER_HOUR, len: 90 } })], 1000, view).bars[0];
  assert.ok(Math.abs(a.left - (9 / 24) * 100) < 1e-9);
  assert.ok(Math.abs(a.width - (1.5 / 24) * 100) < 1e-9);
});

test('a bar outside the window is COUNTED at its edge, never silently dropped', () => {
  // Zooming in is the one gesture that can empty a lane that is full of work.
  // A lane drawn as "drop something here" while holding three bars a fortnight
  // to the left is the chart lying about the plan.
  const lane = layoutLane('editor', [
    item({ title: 'behind', sched: { start: 0, len: 2 * MIN_PER_DAY } }),
    item({ title: 'inside', sched: { start: 9 * MIN_PER_DAY, len: 2 * MIN_PER_DAY } }),
    item({ title: 'ahead', sched: { start: 20 * MIN_PER_DAY, len: 2 * MIN_PER_DAY } }),
  ], 1000, days(8, 6));
  assert.deepEqual(lane.bars.map((b) => b.item.title), ['inside']);
  assert.equal(lane.offLeft, 1);
  assert.equal(lane.offRight, 1);
});

test('the off-window count carries the NEAREST bar, so the marker can go to it', () => {
  // A marker that panned a fixed step would land on empty track as often as not.
  const lane = layoutLane('editor', [
    item({ sched: { start: 0, len: MIN_PER_DAY } }),
    item({ sched: { start: 5 * MIN_PER_DAY, len: MIN_PER_DAY } }),
    item({ sched: { start: 40 * MIN_PER_DAY, len: MIN_PER_DAY } }),
    item({ sched: { start: 90 * MIN_PER_DAY, len: MIN_PER_DAY } }),
  ], 1000, days(10, 6));
  assert.equal(lane.offLeft, 2);
  assert.equal(lane.nearestLeft, 5 * MIN_PER_DAY, 'the latest of the ones behind');
  assert.equal(lane.offRight, 2);
  assert.equal(lane.nearestRight, 40 * MIN_PER_DAY, 'the earliest of the ones ahead');
});

test('an empty lane reports no nearest bar at all', () => {
  const lane = layoutLane('editor', [], 1000, days(0, 6));
  assert.equal(lane.nearestLeft, null);
  assert.equal(lane.nearestRight, null);
});

test('a bar straddling the window edge is drawn, not counted off', () => {
  const lane = layoutLane('editor',
    [item({ sched: { start: 6 * MIN_PER_DAY, len: 4 * MIN_PER_DAY } })], 1000, days(8, 6));
  assert.equal(lane.bars.length, 1, 'work that overlaps the window is in it');
  assert.equal(lane.offLeft, 0);
  assert.ok(lane.bars[0].left < 0, 'and it starts off the left edge, where CSS clips it');
});

test('unscheduled items are not laid out at minute zero', () => {
  const lane = layoutLane('editor',
    [item({ sched: null }), item({ sched: { start: 3 * MIN_PER_DAY, len: 2 * MIN_PER_DAY } })],
    900, days(0, 30));
  assert.equal(lane.bars.length, 1, 'the tray item must not appear on the lane at all');
});

// --- lane stacking -----------------------------------------------------------

test('overlapping bars stack onto separate rows', () => {
  const lane = layoutLane('editor', [
    item({ title: 'A', sched: { start: 0, len: 6 * MIN_PER_DAY } }),
    item({ title: 'B', sched: { start: 3 * MIN_PER_DAY, len: 6 * MIN_PER_DAY } }),
  ], 1200, days(0, 30));
  assert.equal(lane.rows, 2);
  assert.notEqual(lane.bars[0].row, lane.bars[1].row);
});

test('bars that clear each other share a row', () => {
  const lane = layoutLane('editor', [
    item({ title: 'A', sched: { start: 0, len: 2 * MIN_PER_DAY } }),
    item({ title: 'B', sched: { start: 60 * MIN_PER_DAY, len: 2 * MIN_PER_DAY } }),
  ], 1200, days(0, 120));
  assert.equal(lane.rows, 1);
  assert.equal(lane.bars[0].row, lane.bars[1].row);
});

test('a bar whose LABEL would sit on the next bar is pushed to its own row', () => {
  // The bars themselves do not overlap. Their labels do — and a label lying
  // across the next bar is how a Gantt starts misreporting dates.
  const lane = layoutLane('editor', [
    item({ title: 'A very long feature title indeed', sched: { start: 0, len: MIN_PER_DAY } }),
    item({ title: 'B', sched: { start: 2 * MIN_PER_DAY, len: MIN_PER_DAY } }),
  ], 700, days(0, 24));
  assert.equal(lane.bars[0].inside, false, 'the long title cannot fit its one-day bar');
  assert.equal(lane.rows, 2, 'so it must not share a row with the bar its label crosses');
});

test('a label that would overflow the right edge goes to the left of its bar', () => {
  const lane = layoutLane('editor', [
    item({ title: 'A rather long trailing label', sched: { start: 22 * MIN_PER_DAY, len: 2 * MIN_PER_DAY } }),
  ], 700, days(0, 24));
  assert.equal(lane.bars[0].before, true);
});

// --- slip --------------------------------------------------------------------

test('no baseline is NOT on plan', () => {
  const s = slipOf(item({ sched: { start: 4 * MIN_PER_DAY, len: 2 * MIN_PER_DAY } }));
  assert.equal(s.measured, false);
  assert.equal(s.min, null, 'unmeasured slip must not read as zero');
});

test('slip is start drift and duration drift, separately, in minutes', () => {
  const s = slipOf(item({
    sched: { start: 9 * MIN_PER_DAY, len: 6 * MIN_PER_HOUR },
    baseline: { start: 4 * MIN_PER_DAY, len: 5 * MIN_PER_HOUR },
  }));
  assert.equal(s.min, 5 * MIN_PER_DAY);
  assert.equal(s.longer, MIN_PER_HOUR);
  assert.equal(s.measured, true);
});

test('a slip finer than a week is still a slip', () => {
  // The whole reason the unit changed: rounded to weeks this reads as zero, and
  // "on the plan it started with" is exactly what it is not.
  const s = slipOf(item({
    sched: { start: 3 * MIN_PER_DAY, len: MIN_PER_HOUR },
    baseline: { start: 0, len: MIN_PER_HOUR },
  }));
  assert.equal(s.min, 3 * MIN_PER_DAY);
  assert.equal(fmtDur(s.min), '3d');
});

test('a bar sitting on its baseline draws no ghost', () => {
  const on = item({ sched: { start: 4 * MIN_PER_DAY, len: 3 * MIN_PER_DAY }, baseline: { start: 4 * MIN_PER_DAY, len: 3 * MIN_PER_DAY } });
  const off = item({ sched: { start: 6 * MIN_PER_DAY, len: 3 * MIN_PER_DAY }, baseline: { start: 4 * MIN_PER_DAY, len: 3 * MIN_PER_DAY } });
  assert.equal(layoutLane('editor', [on], 1000, days(0, 30)).bars[0].ghost, null);
  assert.notEqual(layoutLane('editor', [off], 1000, days(0, 30)).bars[0].ghost, null);
});

// --- the ruler ---------------------------------------------------------------

test('the ruler rules the window it is given, at every grain', () => {
  const track = 1000;
  for (const s of ZOOM_STOPS) {
    const view = { start: 30 * MIN_PER_DAY, span: clampSpan(spanForPx(s.px, track), track) };
    const { ticks } = ticksFor(view, s.key, WZ, track);
    assert.ok(ticks.length > 1, `${s.key} must draw a ruler`);
    // Ticks are ordered and cover the window from before its start to past its
    // end — a ruler that began inside the window would leave a blank margin.
    // "Past its end" is measured against the ruler's OWN stride: a quarter ruler
    // legitimately places its last tick eleven weeks before the right edge,
    // because the next one is a quarter away.
    for (let i = 1; i < ticks.length; i += 1) assert.ok(ticks[i].at > ticks[i - 1].at);
    assert.ok(ticks[0].at <= view.start, `${s.key} must start before the window does`);
    const stride = ticks[ticks.length - 1].at - ticks[ticks.length - 2].at;
    assert.ok(ticks[ticks.length - 1].at + stride >= view.start + view.span,
      `${s.key} must rule to the right-hand edge`);
  }
});

test('the hour ruler marks midnight as major and carries the date there', () => {
  const view = days(3, 1);
  const { ticks, bands } = ticksFor(view, 'hour', WZ, 1200);
  const midnight = ticks.filter((t) => t.major);
  assert.ok(midnight.length >= 1);
  assert.ok(midnight.every((t) => t.at % MIN_PER_DAY === 0), 'only midnight is major at this grain');
  assert.ok(midnight[0].sub.includes('Jun'), 'and midnight is where the date is written');
  assert.equal(ticks.find((t) => t.at === 3 * MIN_PER_DAY + 9 * MIN_PER_HOUR)?.label, '09:00');
  assert.ok(bands.length > 0, 'night is shaded at the hour grain');
});

test('the day ruler marks Mondays and shades the weekend', () => {
  const view = days(0, 14);
  const { ticks, bands } = ticksFor(view, 'day', WZ, 1000);
  // Week zero is a Monday, so day 0, 7 and 14 are the majors.
  const majors = ticks.filter((t) => t.major).map((t) => t.at / MIN_PER_DAY);
  assert.ok(majors.includes(0) && majors.includes(7));
  assert.ok(!majors.includes(3));
  assert.ok(bands.length >= 2, 'each weekend inside the window gets a band');
});

test('a dateless project gets a ruler and NO shading, rather than shading in the wrong place', () => {
  // Without a week zero nothing here knows which day is Saturday, and a band
  // drawn on a guess is worse than no band.
  const { ticks, bands } = ticksFor(days(0, 60), 'month', null, 1000);
  assert.ok(ticks.length > 0);
  assert.equal(ticks[0].label[0], 'M', 'M1…Mn is honest about not knowing when this is');
  assert.equal(bands.length, 0);
});

test('the ruler shows real months once there is a week zero', () => {
  const { ticks } = ticksFor(days(0, 120), 'month', WZ, 1000);
  assert.ok(ticks.some((t) => t.label === 'Jun'));
  assert.ok(ticks.some((t) => t.label === 'Jul'));
});

test('the window label says the time only once hours are on screen', () => {
  assert.ok(windowLabel(days(0, 1), 'hour', WZ).includes(':'));
  // The TIME-ONLY form is honest only inside one day. The hour stop on a wide
  // track is several days across, and dropping the date there made a four-day
  // window read as twenty-nine minutes.
  const oneDay = windowLabel({ start: 9 * MIN_PER_HOUR, span: 4 * MIN_PER_HOUR }, 'hour', WZ);
  assert.equal((oneDay.match(/Jun/g) || []).length, 1, 'inside a day, the date is said once');
  const fourDays = windowLabel({ start: 9 * MIN_PER_HOUR, span: 4 * MIN_PER_DAY }, 'hour', WZ);
  assert.equal((fourDays.match(/Jun/g) || []).length, 2, 'across days, BOTH ends carry their date');
  assert.ok(fourDays.includes(':'), 'and both still carry their time');
  assert.ok(!windowLabel(days(0, 60), 'month', WZ).includes(':'));
  assert.ok(windowLabel(days(0, 30), 'week', null).startsWith('wk '),
    'and falls back to week indices with no week zero');
  assert.ok(spanLabel(days(0, 10), 'week', WZ).includes('days'));
  assert.ok(spanLabel(days(0, 30), 'week', WZ).includes('weeks'));
});

// --- now, and dropping -------------------------------------------------------

test('the now-line is reported OUTSIDE the track rather than pinned to its edge', () => {
  // Same rule as a NULL review_verdict: "cannot be seen from here" is not "just
  // off the edge". The caller draws a button back to now rather than a line at 0%.
  const now = nowMin(null);
  assert.ok(leftPct(now, { start: now + 6 * MIN_PER_WEEK, span: 6 * MIN_PER_WEEK }) < 0);
  assert.ok(leftPct(now, { start: 0, span: 2 * MIN_PER_WEEK }) > 100);
  assert.equal(inView(now, { start: now, span: 2 * MIN_PER_WEEK }), true);
});

test('a nudge moves by the grain you are looking at, never finer than the gesture was', () => {
  assert.equal(snapFor('hour'), 15);
  assert.equal(snapFor('day'), MIN_PER_HOUR);
  assert.equal(snapFor('week'), MIN_PER_DAY);
  assert.equal(snapFor('quarter'), MIN_PER_DAY);
  assert.equal(snapTo(14 * MIN_PER_HOUR + 23, 15), 14 * MIN_PER_HOUR + 30);
});

test('a drop snaps to the grain and is clamped so the whole bar stays in the domain', () => {
  const view = days(0, 10);
  assert.equal(timeAt(-5000, 1000, 3 * MIN_PER_DAY, view, MIN_PER_DAY), 0);
  const late = timeAt(1e9, 1000, 3 * MIN_PER_DAY, view, MIN_PER_DAY);
  assert.equal(late, SCHED_MINUTES - 3 * MIN_PER_DAY);
  const mid = timeAt(500, 1000, MIN_PER_DAY, view, MIN_PER_HOUR);
  assert.equal(mid % MIN_PER_HOUR, 0, 'a drop at the day grain lands on an hour');
  assert.equal(mid, 5 * MIN_PER_DAY);
});

test('a span is drawn as a fraction of the window it is measured against', () => {
  const p = spanPct({ start: 5 * MIN_PER_DAY, len: MIN_PER_DAY }, days(0, 10));
  assert.equal(p.left, 50);
  assert.equal(p.width, 10);
});

// --- default lengths ---------------------------------------------------------

test('an estimate is WEEKS and a schedule is MINUTES — defaultLen is where they meet', () => {
  assert.equal(defaultLen(item({ estimate: 2 }), 'week'), 2 * MIN_PER_WEEK);
  assert.equal(defaultLen(item({ estimate: 0.5 }), 'week'), Math.round(0.5 * MIN_PER_WEEK));
});

test('an unsized item gets a working length for the grain, never a zero-width bar', () => {
  // A bar you cannot see is not a schedule. Genuinely unsized work lives in the
  // Horizon row instead, which is a different claim.
  for (const g of ['hour', 'day', 'week', 'month', 'quarter']) {
    assert.ok(defaultLen(item({ estimate: null }), g) >= MIN_SCHED_LEN);
  }
  assert.equal(defaultLen(item({ estimate: null }), 'hour'), 2 * MIN_PER_HOUR);
  assert.equal(defaultLen(item({ estimate: null }), 'quarter'), 3 * MIN_PER_DAY);
});

// --- #425, where a new item lands --------------------------------------------

test('#425 — an item added by hand is born ON the timeline, at now', () => {
  const at = new Date(Date.parse('2026-06-17T14:36:00Z'));
  const s = newItemSched(WZ, at);
  assert.equal(s.start, nowMin(WZ, at), 'starts at now');
  assert.equal(s.len, MIN_PER_DAY, 'a working day — the smallest honest claim about a new line');
});

test('#425 — a new item never lands outside the domain the server will accept', () => {
  // Without a week zero, now is the fixed fallback; with one far in the past it
  // can be beyond the horizon, and an unclamped start would be rejected on
  // arrival or clamped to something nobody chose.
  const late = new Date(Date.parse('2099-01-01T00:00:00Z'));
  for (const wz of [null, WZ]) {
    const s = newItemSched(wz, late);
    assert.ok(s.start >= 0 && s.start + s.len <= SCHED_MINUTES, `${wz} -> ${JSON.stringify(s)}`);
  }
});

// --- #410, the roll to now ---------------------------------------------------

test('#410 — an unstarted bar follows now instead of falling behind it', () => {
  const now = 10 * MIN_PER_WEEK;
  const it = item({ sched: { start: now - MIN_PER_WEEK, len: MIN_PER_DAY } });
  const rolled = rolledSched(it, now);
  assert.equal(rolled.start, now, 'starts at now');
  assert.equal(rolled.len, MIN_PER_DAY, 'and keeps its length — only the start floors');
  assert.ok(isRolled(it, now));
});

test('#410 — work IN FLIGHT is a record, not a plan, so nothing moves it', () => {
  const now = 10 * MIN_PER_WEEK;
  const behind = { start: now - MIN_PER_WEEK, len: MIN_PER_DAY };
  for (const over of [{ claimedBy: 'term:x' }, { done: true }, { skipped: true }, { archived: true }]) {
    const it = item({ sched: behind, ...over });
    assert.deepEqual(rolledSched(it, now), behind, JSON.stringify(over));
    assert.equal(isRolled(it, now), false, JSON.stringify(over));
  }
});

test('#410 — a bar already at or after now is left exactly alone', () => {
  const now = 10 * MIN_PER_WEEK;
  for (const start of [now, now + 1, now + MIN_PER_WEEK]) {
    const it = item({ sched: { start, len: MIN_PER_DAY } });
    assert.equal(rolledSched(it, now), it.sched, `start ${start}`);
    assert.equal(isRolled(it, now), false);
  }
  // Unscheduled is not "behind" — it is not on the chart at all.
  assert.equal(rolledSched(item({ sched: null }), now), null);
  assert.equal(isRolled(item({ sched: null }), now), false);
});

test('#410 — the roll is DISPLAY only: it never touches sched or the baseline', () => {
  // The stored span is what slip is measured from, and the ghost is the
  // baseline. If the roll wrote either, the chart would erase its own evidence
  // that the work slipped at all.
  const now = 10 * MIN_PER_WEEK;
  const sched = { start: now - MIN_PER_WEEK, len: MIN_PER_DAY };
  const baseline = { start: now - 2 * MIN_PER_WEEK, len: MIN_PER_DAY };
  const it = item({ sched, baseline });
  rolledSched(it, now);
  assert.deepEqual(it.sched, sched, 'sched untouched');
  assert.deepEqual(it.baseline, baseline, 'baseline untouched');
  assert.equal(slipOf(it).min, MIN_PER_WEEK, 'slip still reads off the stored span');
});

test('#412 — an unsized IDEA is two hours at every grain, not three days', () => {
  // An idea is a line somebody's session dropped on the board and nobody has
  // sized: the grain fallback would draw it as three days at a quarter view,
  // which is a claim about it that nobody made.
  const idea = { estimate: null, source: 'hook', reviewed: false };
  for (const g of ['hour', 'day', 'week', 'month', 'quarter']) {
    assert.equal(defaultLen(item(idea), g), 2 * MIN_PER_HOUR, g);
  }
  // A released fly card is the same population until it is signed off.
  assert.equal(defaultLen(item({ ...idea, source: 'fly' }), 'quarter'), 2 * MIN_PER_HOUR);
});

test('#412 — a real estimate still wins, and a signed-off item is not an idea', () => {
  // "The owner can still override" is exactly this: the estimate branch is
  // above the idea branch, so sizing an idea sizes it.
  assert.equal(
    defaultLen(item({ estimate: 1, source: 'hook', reviewed: false }), 'quarter'),
    MIN_PER_WEEK,
  );
  // Reviewed, claimed or ticked all move it out of the idea list, and with it
  // out of the two-hour default — the size follows the STAGE, not the source.
  assert.equal(defaultLen(item({ estimate: null, source: 'hook', reviewed: true }), 'quarter'), 3 * MIN_PER_DAY);
  assert.equal(
    defaultLen(item({ estimate: null, source: 'hook', reviewed: false, claimedBy: 'term:x' }), 'quarter'),
    3 * MIN_PER_DAY,
  );
});

test('every duration preset is a length the domain and the server will accept', () => {
  for (const d of DUR_OPTIONS) {
    assert.ok(d.min >= MIN_SCHED_LEN && d.min <= SCHED_MINUTES, d.label);
    assert.equal(fmtDur(d.min).replace(' ', ''), fmtDur(d.min).replace(' ', ''));
  }
});

// --- what's next -------------------------------------------------------------

test("what's next is soonest-first and excludes what is already finished", () => {
  const now = 10 * MIN_PER_DAY;
  const items = [
    item({ title: 'done', sched: { start: now + MIN_PER_DAY, len: MIN_PER_DAY }, done: true }),
    item({ title: 'past', sched: { start: 0, len: MIN_PER_DAY } }),
    item({ title: 'running', sched: { start: now - MIN_PER_HOUR, len: 4 * MIN_PER_HOUR } }),
    item({ title: 'soon', sched: { start: now + 2 * MIN_PER_HOUR, len: MIN_PER_HOUR } }),
    item({ title: 'later', sched: { start: now + 9 * MIN_PER_DAY, len: MIN_PER_DAY } }),
    item({ title: 'tray', sched: null }),
  ];
  const next = whatsNext(items, now);
  assert.deepEqual(next.map((n) => n.item.title), ['running', 'soon', 'later']);
  assert.equal(next[0].running, true, 'a bar spanning now is running, not upcoming');
  assert.equal(next[1].inMin, 2 * MIN_PER_HOUR);
});

test("what's next is empty rather than wrong when nothing is scheduled ahead", () => {
  assert.deepEqual(whatsNext([item({ sched: { start: 0, len: MIN_PER_DAY } })], 10 * MIN_PER_DAY), []);
});

test('how far off something is, said the short way', () => {
  assert.equal(fmtWhen(0, true), 'running');
  assert.equal(fmtWhen(41, false), '41m');
  assert.equal(fmtWhen(3 * MIN_PER_HOUR, false), '3h');
  assert.equal(fmtWhen(3 * MIN_PER_DAY, false), '3d');
  assert.equal(fmtWhen(4 * MIN_PER_WEEK, false), '4w');
});

// --- the calendar ------------------------------------------------------------

test('the calendar refuses to draw without a start date rather than inventing one', () => {
  const it = [item({ sched: { start: MIN_PER_DAY, len: 2 * MIN_PER_DAY } })];
  assert.deepEqual(calendarDays(it, days(0, 7), 'day', null, 0), []);
  assert.deepEqual(calendarMonths(it, days(0, 30), 'week', null, 0), []);
});

test('the day grain draws a Monday-aligned week, the hour grain a single day', () => {
  const it = [];
  const week = calendarDays(it, days(9, 7), 'day', WZ, 0);
  assert.equal(week.length, 7);
  assert.equal(week[0].date.getUTCDay(), 1, 'a week starts on its Monday');
  assert.equal(calendarDays(it, days(9, 1), 'hour', WZ, 0).length, 1);
});

test('a bar shorter than a day is an EVENT; a day or longer is an all-day chip', () => {
  // Two shapes because they are two different claims — "this happens at 14:00"
  // and "this is what the week is about". A five-day bar drawn as a 120-hour
  // event would fill the grid with one item.
  const short = item({ title: 'short', sched: { start: 9 * MIN_PER_DAY + 9 * MIN_PER_HOUR, len: 90 } });
  const long = item({ title: 'long', sched: { start: 9 * MIN_PER_DAY, len: 3 * MIN_PER_DAY } });
  // The week is Monday-aligned around the MIDDLE of the window, so day 9 is not
  // column 0 — look the columns up by day rather than by position.
  const cols = calendarDays([short, long], days(9, 7), 'day', WZ, 0);
  const on = (d) => cols.find((c) => c.day === d);
  assert.deepEqual(on(9).events.map((e) => e.item.title), ['short']);
  assert.deepEqual(on(9).allDay.map((a) => a.item.title), ['long']);
  assert.equal(on(9).allDay[0].first, true, 'it starts on this day…');
  assert.equal(on(10).allDay[0].first, false, '…and continues onto the next');
  assert.equal(on(11).allDay.length, 1, '…and the one after that');
  assert.equal(on(12).allDay.length, 0, 'and stops when it stops');
});

test('a calendar cell lists every bar ACTIVE that day, not only those that start in it', () => {
  // A month showing a fortnight-long bar once is a month claiming thirteen free
  // days.
  const long = item({ sched: { start: 0, len: 4 * MIN_PER_DAY } });
  const [june] = calendarMonths([long], days(10, 30), 'month', WZ, 0);
  const busy = june.cells.filter((c) => c.items.length > 0);
  assert.equal(busy.length, 4);
  assert.equal(busy[0].date.toISOString().slice(0, 10), '2026-06-01');
});

test('the quarter grain draws three months, the coarser-than-day grains draw one', () => {
  const it = [item({ sched: { start: 0, len: MIN_PER_DAY } })];
  assert.equal(calendarMonths(it, days(10, 30), 'week', WZ, 0).length, 1);
  assert.equal(calendarMonths(it, days(10, 30), 'month', WZ, 0).length, 1);
  assert.equal(calendarMonths(it, days(10, 200), 'quarter', WZ, 0).length, 3);
});

test('the month grid marks today exactly once, and only when today is in it', () => {
  const now = 9 * MIN_PER_DAY;
  const [m] = calendarMonths([], days(9, 30), 'month', WZ, now);
  assert.equal(m.cells.filter((c) => c.today).length, 1);
  const [far] = calendarMonths([], days(400, 30), 'month', WZ, now);
  assert.equal(far.cells.filter((c) => c.today).length, 0, 'a month that is not this one has no today');
});

test('the month grid starts on a Monday and marks which days are out of month', () => {
  const [m] = calendarMonths([], days(40, 30), 'month', WZ, 0);
  assert.equal(m.cells[0].date.getUTCDay(), 1);
  assert.equal(m.cells.length % 7, 0);
  assert.ok(m.cells.some((c) => !c.inMonth) || m.cells[0].date.getUTCDate() === 1);
});

test('the calendar hour frame starts where the working day does', () => {
  assert.ok(CAL_HOUR_FROM >= 0 && CAL_HOUR_FROM < 12);
});

// --- the scope drawer --------------------------------------------------------

test('a Could is IN the cycle until it is cut — that is what "first to cut" means', () => {
  // The distinction that matters: committed is Must+Should+Could, deferred is
  // what has actually been parked. Treating Coulds as pre-deferred made
  // the old trim arithmetic believe cutting one bought back a week never spent.
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
  assert.equal(CYCLE_WEEKS, 6);
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

// A verdict is what ends "in progress", and the claim outlives it — it stays
// until a human merges and ticks. So the claim must NOT be what decides the
// column, or a verdicted change sits in In progress for as long as its branch.
test('a verdict ships the card even while its branch claim stands', () => {
  assert.equal(listKeyOf(item({ claimedBy: 'feat/3-x', reviewTag: 'solid' })), 'shipped');
  assert.equal(listKeyOf(item({ claimedBy: 'feat/3-x', reviewTag: 'needs-work' })), 'shipped');
  // And still not a tick: `done` is untouched by any of this.
  assert.equal(item({ claimedBy: 'feat/3-x', reviewTag: 'solid' }).done, false);
});

test('clearing the verdict returns the card to the lane its state puts it in', () => {
  assert.equal(listKeyOf(item({ claimedBy: 'feat/3-x', reviewTag: '' })), 'progress');
  assert.equal(listKeyOf(item({ claimedBy: '', reviewTag: '' })), 'planned');
});

// --- in the cycle ------------------------------------------------------------
// `inCycle` is what the Roadmap tab's area chips count, what decides whether an
// area chip is hidden, and what the Tiers board ranks. Three surfaces, one
// predicate — these pin the three exclusions and, just as importantly, the two
// states that are NOT exclusions.

test("the three exclusions: archived, parked and a Won't", () => {
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
    item({ area: 'editor', title: 'scheduled', estimate: null, sched: { start: 3 * MIN_PER_DAY, len: 2 * MIN_PER_DAY } }),
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

test('weekNo is 1-based, so wk 1 is the first week and not the zeroth', () => {
  assert.equal(weekNo(0), 1);
  assert.equal(weekNo(MIN_PER_WEEK), 2);
  assert.equal(weekNo(MIN_PER_WEEK - 1), 1);
});

test('the window opens around now rather than at week zero', () => {
  const v = viewAround(50 * MIN_PER_DAY);
  assert.ok(inView(50 * MIN_PER_DAY, v));
});
