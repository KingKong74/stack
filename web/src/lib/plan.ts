// The Roadmap tab v2's arithmetic — pure, no React, no network.
//
// Everything the three views compute lives here rather than in a component, for
// the same reason `lib/spine.ts` does: the bar geometry is the one part of a
// Gantt that is genuinely easy to get wrong, and a wrong bar is a plan you act
// on. Tested in `scripts/plan.test.mjs`.
//
// FOUR THINGS THIS FILE INSISTS ON:
//
//  1. A WEEK INDEX IS NOT A DATE, AND A SCALE IS A ZOOM. `sched.start` counts
//     weeks from the project's own week zero, and NO scale ever changes it. What
//     a scale changes is the VIEWPORT — how many of those weeks fill the track —
//     so the same bar stretches at days and condenses at quarters while the
//     schedule it draws is untouched. Switching scale still cannot move a bar;
//     it can only change how much track a week is worth.
//     DAYS IS A READING SCALE, NOT A FINER UNIT. `sched_start`/`sched_len` are
//     integer WEEKS server-side, so a bar zoomed to days still moves a week at a
//     time — the view is finer than the model, and the toolbar says so rather
//     than letting a day-wide grid imply a precision the column does not have.
//  2. SLIP IS MEASURED AGAINST THE BASELINE, AND ONLY EXISTS IF THERE IS ONE.
//     `baseline == null` means nothing was ever committed to, which is NOT the
//     same as "on plan" and must not render as a clean bar. Same rule as a NULL
//     review_verdict.
//  3. AN UNSIZED TICKET IS NOT A FREE ONE. `estimate == null` is excluded from
//     the scope drawer's committed total AND counted separately, so a cycle that
//     looks like it fits because half of it is unsized says so out loud.
//  4. THE ARRANGE ACTIONS PROPOSE, THEY DO NOT APPLY. Each returns a diff —
//     a list of {id, sched} — and the caller decides. Nothing here mutates.

import type { RoadmapItem, SchedSpan } from '../types';
import { tierRank } from '../types';

/** The timeline's span, in weeks. Twin of SCHED_WEEKS in server/src/routes/roadmap.js. */
export const SCHED_WEEKS = 24;
/** The scope drawer's cycle length, in weeks — what "does this fit" is measured against. */
export const CYCLE_WEEKS = 6;

/**
 * Which week is "now". A THIRD of the way in, not at the right-hand edge.
 *
 * The edge is where a timeline naturally puts today if nobody thinks about it,
 * and it is the wrong place: it leaves the whole chart showing what already
 * happened and nowhere to draw what is coming. Eight weeks of context behind,
 * sixteen ahead — a planning instrument should be mostly future.
 */
export const NOW_WEEK = 8;

export type Scale = 'day' | 'week' | 'month' | 'quarter';
export interface ScaleCol { label: string; now: boolean; weeks: number; startWeek: number }

/**
 * WHICH SLICE OF THE SCHEDULE THE TRACK IS DRAWING. `start` is a week index and
 * `weeks` is how many of them fill the whole track, so a narrow viewport is a
 * zoom IN: fewer weeks over the same pixels means every bar is wider.
 *
 * It is a viewport and not a filter — nothing is excluded from the plan by being
 * off-screen, which is why `layoutLane` counts what it left either side rather
 * than dropping it silently.
 */
export interface Viewport { start: number; weeks: number }

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The real date a week index lands on. `weekZero` is the project's own start
 * (projects.week_zero); without one the timeline still works — it just has no
 * dates, which the calendar view says rather than inventing a start.
 */
export function weekDate(week: number, weekZero: string | null): Date | null {
  if (!weekZero) return null;
  const t = Date.parse(`${weekZero}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + week * 7 * 86400000);
}

export const fmtDate = (d: Date): string =>
  `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;

/**
 * HOW MANY WEEKS ONE SCREENFUL SHOWS AT EACH SCALE — the whole of what the scale
 * control does. Each step is roughly half the one below it, so the same bar
 * visibly doubles in width as you zoom in, which is the point: a two-week bar
 * inside a six-month window is four pixels of nothing.
 *
 * The widest is the whole schedulable horizon. A viewport wider than the domain
 * would be drawing weeks nothing can ever be scheduled into.
 */
export const SCALE_WEEKS: Record<Scale, number> = {
  day: 2, week: 6, month: 12, quarter: SCHED_WEEKS,
};

/** The whole horizon at once — what every geometry function falls back to. */
export const FULL_VIEW: Viewport = { start: 0, weeks: SCHED_WEEKS };

/** A viewport pinned inside the schedulable domain. */
export const clampView = (start: number, weeks: number, domain = SCHED_WEEKS): Viewport => ({
  start: Math.max(0, Math.min(domain - weeks, Math.round(start))),
  weeks,
});

/**
 * The viewport for a scale, with `focus` a THIRD of the way in.
 *
 * A third, not the middle, for the same reason NOW_WEEK sits a third in: a
 * planning instrument should be mostly future. Zooming preserves the focus week
 * rather than the window, so the bar you were looking at stays where it is on
 * screen while everything around it stretches or condenses.
 */
export function viewFor(scale: Scale, focus = NOW_WEEK, domain = SCHED_WEEKS): Viewport {
  const weeks = Math.min(domain, SCALE_WEEKS[scale]);
  return clampView(focus - weeks / 3, weeks, domain);
}

/** The week a viewport is focused on — the inverse of `viewFor`'s third. */
export const focusOf = (view: Viewport): number => view.start + view.weeks / 3;

/**
 * The columns under the timeline's ruler, for the slice of schedule the viewport
 * is showing. Widths are proportional to `weeks`, so a quarter column really is
 * three months wide — a scale whose columns were all equal would misdraw every
 * bar that crossed one.
 *
 * Labels become REAL dates once the project has a week zero; without one they
 * fall back to D1…/W1…/M1…/Q1…, which is honest about not knowing when this is.
 */
export function scaleCols(scale: Scale, view: Viewport = FULL_VIEW, weekZero: string | null = null): ScaleCol[] {
  const { start, weeks } = view;
  const mark = (startWeek: number, span: number) => startWeek <= NOW_WEEK && NOW_WEEK < startWeek + span;
  if (scale === 'day') {
    // A day is a seventh of a week. The MODEL is still weekly (see the header):
    // these columns read the plan finer than it can be edited, and that is the
    // whole of what "Days" is.
    const days = Math.round(weeks * 7);
    return Array.from({ length: days }, (_, i) => {
      const startWeek = start + i / 7;
      const d = weekDate(startWeek, weekZero);
      return {
        label: d ? fmtDate(d) : `D${i + 1}`,
        now: mark(startWeek, 1 / 7), weeks: 1 / 7, startWeek,
      };
    });
  }
  if (scale === 'week') {
    return Array.from({ length: Math.round(weeks) }, (_, i) => {
      const startWeek = start + i;
      const d = weekDate(startWeek, weekZero);
      return {
        // Every column is labelled while there are few enough to read; past
        // fourteen they collide at any real width, so every other one is.
        label: weeks <= 14 || i % 2 === 0 ? (d ? fmtDate(d) : `W${startWeek + 1}`) : '',
        now: mark(startWeek, 1), weeks: 1, startWeek,
      };
    });
  }
  if (scale === 'quarter') {
    const quarters = Math.max(1, Math.round(weeks / 12));
    const span = weeks / quarters;
    return Array.from({ length: quarters }, (_, i) => {
      const startWeek = start + i * span;
      const from = weekDate(startWeek, weekZero);
      const to = weekDate(startWeek + span - 1, weekZero);
      return {
        label: from && to
          ? (from.getUTCMonth() === to.getUTCMonth()
            ? MONTH_NAMES[from.getUTCMonth()]
            : `${MONTH_NAMES[from.getUTCMonth()]}–${MONTH_NAMES[to.getUTCMonth()]}`)
          : `Q${Math.floor(startWeek / 12) + 1}`,
        now: mark(startWeek, span), weeks: span, startWeek,
      };
    });
  }
  const months = Math.max(1, Math.round(weeks / 4));
  const span = weeks / months;
  return Array.from({ length: months }, (_, i) => {
    const startWeek = start + i * span;
    const d = weekDate(startWeek, weekZero);
    return {
      label: d ? MONTH_NAMES[d.getUTCMonth()] : `M${Math.round(startWeek / 4) + 1}`,
      now: mark(startWeek, span), weeks: span, startWeek,
    };
  });
}

/**
 * Where the now-line sits, as a percentage across the track.
 *
 * It can be OUTSIDE 0–100 once the viewport is narrower than the horizon, and
 * the caller has to check: a now-line clamped to an edge would be claiming today
 * is at the edge of a window it is nowhere near.
 */
export const nowLeft = (view: Viewport = FULL_VIEW): number =>
  ((NOW_WEEK - view.start) / view.weeks) * 100;

/** Is a week index inside the viewport at all? */
export const inView = (week: number, view: Viewport): boolean =>
  week >= view.start && week < view.start + view.weeks;

// --- what's next -----------------------------------------------------------

export interface NextUpBar {
  item: RoadmapItem;
  /** Weeks until it starts. 0 = this week, negative = already running. */
  inWeeks: number;
  running: boolean;
}

/**
 * The bars around and after now, soonest first — what the timeline is actually
 * asking you to look at. Anything already finished is excluded: a Gantt's job
 * to the right of the now-line is to show what has not happened yet.
 */
export function whatsNext(items: RoadmapItem[], limit = 5, now = NOW_WEEK): NextUpBar[] {
  return items
    .filter((i) => !i.archived && !i.done && i.sched && i.sched.start + i.sched.len > now)
    .map((i) => ({
      item: i,
      inWeeks: i.sched!.start - now,
      running: i.sched!.start <= now,
    }))
    .sort((a, b) => a.inWeeks - b.inWeeks || a.item.title.localeCompare(b.item.title))
    .slice(0, limit);
}

// --- the calendar ----------------------------------------------------------

export interface CalMonth {
  label: string;
  /** One entry per week that starts inside this month. */
  weeks: { week: number; from: Date; to: Date; now: boolean; items: RoadmapItem[] }[];
}

/**
 * The same schedule as months of weeks. Needs a week zero — a week index has no
 * place on a calendar — and returns [] without one so the caller can say why
 * rather than drawing an invented year.
 */
export function calendarMonths(
  items: RoadmapItem[], weekZero: string | null, weeks = SCHED_WEEKS,
): CalMonth[] {
  if (!weekZero) return [];
  const live = items.filter((i) => !i.archived && i.sched);
  const out: CalMonth[] = [];
  for (let w = 0; w < weeks; w += 1) {
    const from = weekDate(w, weekZero)!;
    const to = new Date(from.getTime() + 6 * 86400000);
    const label = `${MONTH_NAMES[from.getUTCMonth()]} ${from.getUTCFullYear()}`;
    if (!out.length || out[out.length - 1].label !== label) out.push({ label, weeks: [] });
    out[out.length - 1].weeks.push({
      week: w, from, to, now: w === NOW_WEEK,
      // Active in this week — a bar spans weeks, so it appears on each one it
      // covers rather than only on the week it starts.
      items: live.filter((i) => i.sched!.start <= w && w < i.sched!.start + i.sched!.len),
    });
  }
  return out;
}

// --- slip ------------------------------------------------------------------

export interface Slip {
  /** null = no baseline was ever set, which is NOT "on plan". */
  weeks: number | null;
  longer: number | null;
  measured: boolean;
}

export function slipOf(it: RoadmapItem): Slip {
  if (!it.sched || !it.baseline) return { weeks: null, longer: null, measured: false };
  return {
    weeks: it.sched.start - it.baseline.start,
    longer: it.sched.len - it.baseline.len,
    measured: true,
  };
}

// --- lane geometry ---------------------------------------------------------

export interface Bar {
  item: RoadmapItem;
  /** Percentages of the track, so the lane scales with its container. */
  left: number;
  width: number;
  /** Which stacked row inside the lane this bar sits on (0 = top). */
  row: number;
  /** The title fits inside the bar at the current width. */
  inside: boolean;
  /** The outside label would run off the right edge, so it goes on the left. */
  before: boolean;
  /** The baseline ghost, when there is a baseline AND it differs from the bar. */
  ghost: { left: number; width: number } | null;
}

export interface Lane {
  area: string;
  bars: Bar[];
  /** Rows needed to stack these bars without overlap — drives the lane height. */
  rows: number;
  /**
   * Scheduled bars this lane has that sit entirely BEFORE / AFTER the viewport.
   *
   * Counted rather than dropped. Zooming in is the one thing that can empty a
   * lane that has work in it, and a lane drawn as "drop something here" while
   * holding three bars a fortnight to the left is the chart lying about the plan.
   */
  offLeft: number;
  offRight: number;
}

// Roughly the width one character of the bar label occupies, plus the padding
// either side. Only used to decide inside-vs-outside, so being a few pixels out
// costs a label position, never a bar position.
const CHAR_PX = 6.7;
const LABEL_PAD = 20;

/**
 * Lay out one area's bars: horizontal position from the schedule, vertical row
 * from a first-fit that accounts for the LABEL as well as the bar. Two bars
 * that do not overlap can still collide through their labels, and a label
 * sitting on top of another bar is how a Gantt starts lying about dates.
 */
export function layoutLane(
  area: string, items: RoadmapItem[], trackPx: number, view: Viewport = FULL_VIEW,
): Lane {
  const { start: winStart, weeks } = view;
  const winEnd = winStart + weeks;
  const pxPerWeek = trackPx > 0 ? trackPx / weeks : 0;
  // Off-screen either side, counted before anything is laid out — see Lane.
  let offLeft = 0; let offRight = 0;
  const placed = items
    .filter((i) => i.sched)
    .filter((i) => {
      const { start, len } = i.sched!;
      if (start + len <= winStart) { offLeft += 1; return false; }
      if (start >= winEnd) { offRight += 1; return false; }
      return true;
    })
    .map((i) => {
      const sched = i.sched!;
      const barPx = sched.len * pxPerWeek;
      const labelPx = i.title.length * CHAR_PX + LABEL_PAD;
      const inside = barPx >= labelPx;
      const x0 = (sched.start - winStart) * pxPerWeek;
      const x1 = x0 + barPx;
      // If the label cannot sit inside and would overflow the track on the
      // right, it goes to the LEFT of the bar instead.
      const before = !inside && x1 + labelPx > trackPx;
      return {
        item: i,
        span: [before ? x0 - labelPx : x0, inside ? x1 : before ? x1 : x1 + labelPx] as [number, number],
        inside,
        before,
      };
    })
    .sort((a, b) => a.span[0] - b.span[0]);

  const rowEnds: number[] = [];
  const bars: Bar[] = placed.map((p) => {
    let row = rowEnds.findIndex((end) => end <= p.span[0] - 6);
    if (row === -1) { row = rowEnds.length; rowEnds.push(0); }
    rowEnds[row] = p.span[1];
    const sched = p.item.sched!;
    const base = p.item.baseline;
    const moved = !!base && (base.start !== sched.start || base.len !== sched.len);
    return {
      item: p.item,
      left: ((sched.start - winStart) / weeks) * 100,
      width: (sched.len / weeks) * 100,
      row,
      inside: p.inside,
      before: p.before,
      ghost: moved
        ? { left: ((base!.start - winStart) / weeks) * 100, width: (base!.len / weeks) * 100 }
        : null,
    };
  });

  return { area, bars, rows: Math.max(1, rowEnds.length), offLeft, offRight };
}

/** Where a span sits in the viewport, as percentages — for a bar drawn outside `layoutLane`. */
export const spanPct = (span: SchedSpan, view: Viewport = FULL_VIEW) => ({
  left: ((span.start - view.start) / view.weeks) * 100,
  width: (span.len / view.weeks) * 100,
});

/**
 * Where a drop at this pixel offset lands, clamped so the bar stays in the
 * SCHEDULABLE domain — not in the viewport. Zooming must never be able to
 * shorten the plan, and the server clamps to the same 24 weeks.
 */
export function weekAt(
  offsetPx: number, trackPx: number, len: number,
  view: Viewport = FULL_VIEW, domain = SCHED_WEEKS,
): number {
  if (trackPx <= 0) return 0;
  const raw = Math.round(view.start + (offsetPx / trackPx) * view.weeks);
  return Math.max(0, Math.min(domain - len, raw));
}

// --- the scope drawer ------------------------------------------------------

export interface ScopeTotals {
  /** Everything still IN the cycle: Must, Should and Could that is not parked. */
  committed: number;
  /** Explicitly parked — cut from this cycle but still part of the feature. */
  deferred: number;
  out: number;         // Won't — out of the feature's scope entirely
  /** Lines with no estimate. Counted APART — an unsized ticket is not free. */
  unsized: number;
  over: number;        // weeks past the cycle (0 = fits)
  fits: boolean;
}

// What "committed" means, and it is NOT Must+Should. A Could is in the cycle
// until somebody cuts it — that is what "first to cut" means, and it is why
// cutting one actually buys a week back. Counting Coulds as pre-deferred made
// `proposeTrim` believe it had saved time it had never spent, and a trim that
// reports weeks it did not save is worse than one that refuses.
const IN_CYCLE = new Set(['must', 'should', 'could']);

/**
 * Is this row part of the cycle at all? The predicate behind `scopeTotals`'s
 * committed/deferred split, exported because the area chips count with it too —
 * and a chip counting a different population from the drawer beside it is two
 * answers to one question.
 *
 * The three exclusions each mean something different and none of them is
 * "deleted": ARCHIVED is off the board but recoverable, PARKED is cut from this
 * cycle but still part of the feature, and a WON'T is out of the feature's
 * scope entirely. A `done` row IS still in the cycle — it is the cycle's work,
 * finished — and excluding it would empty an area's chip the moment its work
 * shipped, taking the Timeline lane that still draws its bars with it.
 */
export const inCycle = (it: RoadmapItem): boolean =>
  !it.archived && !it.skipped && IN_CYCLE.has(it.bucket);

/**
 * The area filter's value for UNALLOCATED — items carrying no area at all.
 *
 * A SENTINEL rather than a second piece of state, because every view already
 * threads one `areaFilter` string and a parallel boolean would be a second truth
 * to keep in step. It is safe as a sentinel because it is UPPERCASE: the server
 * lowercases every area it stores (`routes/board.js`, `routes/roadmap.js`), so
 * no real area can ever spell it — which is the only reason a magic string is
 * allowed here at all.
 *
 * Untagged work is the population most likely to be forgotten, so it needs to be
 * filterable like any other area. Reach for `areaMatches` rather than comparing
 * strings: `i.area === areaFilter` silently matches nothing under this value,
 * which renders as an empty board rather than as the filter it is.
 */
export const UNALLOCATED = 'UNALLOCATED';

/** Does this row's area pass the filter? '' = every area, UNALLOCATED = untagged. */
export const areaMatches = (area: string, filter: string): boolean =>
  (filter === '' ? true : filter === UNALLOCATED ? !area : area === filter);

/**
 * THE HORIZON: committed work with no schedule AND no estimate — on the roadmap
 * but not yet in the plan. Drawn as a row of chips under the lanes rather than
 * parked at week zero, because a bar at week zero is a claim about when it runs.
 *
 * IT OBEYS THE AREA CHIP, like every other population on the chart. It is a
 * function here, and not four filters inlined in the render, because it was
 * inlined and the filter was the clause that got left out: the lanes, the tray
 * and the orphan fold all narrowed to the chip and the Horizon alone kept
 * listing every area's unsized work. A lane that ignores the filter above it
 * does not read as a bug — it reads as unsized work belonging to the area you
 * are looking at, which is the one thing it is not.
 */
export const horizonOf = (items: RoadmapItem[], areaFilter: string): RoadmapItem[] =>
  items.filter((i) => !i.archived && !i.done && !i.sched && i.estimate === null
    && areaMatches(i.area, areaFilter));

export function scopeTotals(children: RoadmapItem[], cycle = CYCLE_WEEKS): ScopeTotals {
  let committed = 0; let deferred = 0; let out = 0; let unsized = 0;
  for (const c of children) {
    if (c.estimate === null) { unsized += 1; if (c.bucket !== 'wont') continue; }
    const w = c.estimate ?? 0;
    if (c.bucket === 'wont') out += w;
    else if (c.skipped) deferred += w;
    else if (IN_CYCLE.has(c.bucket)) committed += w;
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    committed: round(committed), deferred: round(deferred), out: round(out), unsized,
    over: round(Math.max(0, committed - cycle)),
    fits: committed <= cycle,
  };
}

// --- the Plan view's lists -------------------------------------------------

/**
 * Client twin of `listFor` in server/src/lists.js. '' on the item means DERIVED,
 * never "the first list" — see that file's header, which also carries why a
 * VERDICT outranks the branch claim and why that is not a tick.
 */
export function listKeyOf(it: RoadmapItem): string {
  if (it.listKey) return it.listKey;
  if (it.done) return 'shipped';
  if (it.reviewTag.trim()) return 'shipped';
  if (it.claimedBy.trim()) return 'progress';
  // #381 — a released fly card sits with the hook extractions: a session's note
  // about what it was doing is not a commitment by the board until someone
  // signs it off. While the session still holds it, `progress` above wins,
  // which is where a fly card spends its whole working life.
  if ((it.source === 'hook' || it.source === 'fly') && !it.reviewed) return 'idea';
  return 'planned';
}

// --- the arrange proposals -------------------------------------------------
//
// Deterministic arithmetic, not a model read — and the UI says so. Each returns
// a DIFF the caller renders as ghosts and the owner applies or discards, which
// is what keeps "the human disposes" true of a button that rearranges a board.

export interface Move { id: number; sched: { start: number; len: number } | null }
export interface Proposal { kind: string; moves: Move[]; summary: string }

const lenFor = (it: RoadmapItem) => Math.max(1, Math.round(it.estimate ?? 2));

/** Every unscheduled Must and Should onto its own area lane, after the last bar there. */
export function proposeSchedule(items: RoadmapItem[], weeks = SCHED_WEEKS): Proposal {
  const live = items.filter((i) => !i.archived && !i.done);
  // Must and Should only — deliberately NOT the same set as IN_CYCLE. A Could
  // is in the cycle's arithmetic but is not COMMITTED work, and putting one on
  // the timeline unasked is how a maybe becomes a promise.
  const pending = live.filter((i) => !i.sched && (i.bucket === 'must' || i.bucket === 'should'));
  const ends = new Map<string, number>();
  live.filter((i) => i.sched).forEach((i) => {
    const end = i.sched!.start + i.sched!.len;
    ends.set(i.area, Math.max(ends.get(i.area) ?? 0, end));
  });
  const moves: Move[] = pending.map((i) => {
    const len = lenFor(i);
    const start = Math.max(0, Math.min(ends.get(i.area) ?? 0, weeks - len));
    ends.set(i.area, start + len);
    return { id: i.id, sched: { start, len } };
  });
  return {
    kind: 'schedule',
    moves,
    summary: moves.length
      ? `Places ${moves.length} committed item${moves.length === 1 ? '' : 's'} on the timeline, each after the last bar in its own area.`
      : 'Nothing committed is unscheduled — every Must and Should is already on the timeline.',
  };
}

/** Pull planned bars earlier so no lane sits idle. Never moves finished work. */
export function proposeCompact(items: RoadmapItem[]): Proposal {
  const live = items.filter((i) => !i.archived && i.sched && !i.done);
  const byArea = new Map<string, RoadmapItem[]>();
  live.forEach((i) => byArea.set(i.area, [...(byArea.get(i.area) || []), i]));
  const moves: Move[] = [];
  let saved = 0;
  byArea.forEach((bars) => {
    const sorted = bars.slice().sort((a, b) => a.sched!.start - b.sched!.start);
    let cursor: number | null = null;
    sorted.forEach((b) => {
      const { start, len } = b.sched!;
      if (cursor === null) { cursor = start + len; return; }
      if (start > cursor) {
        saved += start - cursor;
        moves.push({ id: b.id, sched: { start: cursor, len } });
        cursor += len;
      } else {
        cursor = Math.max(cursor, start + len);
      }
    });
  });
  return {
    kind: 'compact',
    moves,
    summary: moves.length
      ? `Pulls ${moves.length} bar${moves.length === 1 ? '' : 's'} earlier and removes ${saved} idle week${saved === 1 ? '' : 's'}.`
      : 'No dead weeks to remove — every planned bar already starts as its area frees up.',
  };
}

export interface TrimProposal { kind: 'trim'; defer: number[]; summary: string }

/**
 * Defer Coulds, then Shoulds, until the feature fits its cycle. Returns the ids
 * to park rather than parking them — and stops at Shoulds: cutting a Must is a
 * decision about what the feature IS, which no arithmetic gets to make.
 */
export function proposeTrim(children: RoadmapItem[], cycle = CYCLE_WEEKS): TrimProposal {
  const totals = scopeTotals(children, cycle);
  if (totals.fits) {
    const spare = Math.round((cycle - totals.committed) * 10) / 10;
    return {
      kind: 'trim', defer: [],
      summary: `Fits the ${cycle}-week cycle with ${spare} week${spare === 1 ? '' : 's'} spare — nothing to cut.`,
    };
  }
  let over = totals.committed - cycle;
  const defer: number[] = [];
  for (const bucket of ['could', 'should'] as const) {
    for (const c of children.filter((k) => k.bucket === bucket && !k.skipped && k.estimate !== null)) {
      if (over <= 0) break;
      defer.push(c.id);
      over -= c.estimate ?? 0;
    }
  }
  return {
    kind: 'trim',
    defer,
    summary: defer.length
      ? `Defers ${defer.length} line${defer.length === 1 ? '' : 's'} to bring the feature inside ${cycle} weeks. Musts are never cut — that is a decision about what the feature is.`
      : `Over the ${cycle}-week cycle by ${Math.round(over * 10) / 10} weeks, but only Musts remain. Cutting one is a decision about what the feature is, so nothing is proposed.`,
  };
}

/**
 * Push every bar that has fallen behind its baseline so it starts at NOW.
 *
 * The one the timeline makes obvious and nothing acts on: a bar whose ghost is
 * behind it has already slipped, and leaving it starting in the past is how a
 * plan quietly becomes fiction. Only bars that START before now are touched —
 * a bar already running is not late, it is running.
 */
export function proposeCatchUp(items: RoadmapItem[], now = NOW_WEEK, weeks = SCHED_WEEKS): Proposal {
  const moves: Move[] = [];
  for (const i of items) {
    if (i.archived || i.done || !i.sched) continue;
    if (i.sched.start + i.sched.len > now && i.sched.start < now) continue; // running, not late
    if (i.sched.start + i.sched.len > now) continue;                        // still ahead
    const len = i.sched.len;
    moves.push({ id: i.id, sched: { start: Math.min(now, weeks - len), len } });
  }
  return {
    kind: 'catchup',
    moves,
    summary: moves.length
      ? `Moves ${moves.length} bar${moves.length === 1 ? '' : 's'} that finished in the past up to now — they were still drawn as if they had not slipped.`
      : 'Nothing is scheduled entirely in the past. Every bar either ran, is running, or is still ahead.',
  };
}

/**
 * Level the load: give the busiest area's overflow to the emptiest one.
 *
 * It only moves UNCLAIMED, unstarted work, and only between areas — a claimed
 * item belongs to whoever claimed it, and a running bar is not a spare part.
 * Deliberately conservative: one pass, and it stops as soon as the spread is
 * within a week, because "balanced" is not worth reorganising a board over.
 */
export function proposeBalance(items: RoadmapItem[], now = NOW_WEEK): Proposal {
  const live = items.filter((i) => !i.archived && !i.done && i.sched && i.sched.start >= now);
  const load = new Map<string, number>();
  for (const i of live) load.set(i.area, (load.get(i.area) ?? 0) + i.sched!.len);
  if (load.size < 2) {
    return { kind: 'balance', moves: [], summary: 'Only one area has upcoming work, so there is nothing to level against.' };
  }
  const sorted = [...load.entries()].sort((a, b) => b[1] - a[1]);
  const [heavy, heavyW] = sorted[0];
  const [lightArea, lightW] = sorted[sorted.length - 1];
  if (heavyW - lightW <= 1) {
    return { kind: 'balance', moves: [], summary: `The areas are within a week of each other (${heavy} ${heavyW}w, ${lightArea} ${lightW}w). Nothing worth moving.` };
  }
  // The heavy lane's LAST unclaimed bar — the one whose move costs least.
  const movable = live
    .filter((i) => i.area === heavy && !i.claimedBy)
    .sort((a, b) => b.sched!.start - a.sched!.start)[0];
  if (!movable) {
    return { kind: 'balance', moves: [], summary: `${heavy} carries the most (${heavyW}w) but every bar in it is claimed, so none can be handed over.` };
  }
  const lightEnd = live
    .filter((i) => i.area === lightArea)
    .reduce((n, i) => Math.max(n, i.sched!.start + i.sched!.len), now);
  return {
    kind: 'balance',
    moves: [{ id: movable.id, sched: { start: lightEnd, len: movable.sched!.len } }],
    summary: `Hands "${movable.title}" from ${heavy} (${heavyW}w) to ${lightArea} (${lightW}w). One bar — levelling is not worth reorganising a board over.`,
  };
}

/**
 * Reorder the unstarted bars in each lane so the desire tier leads.
 *
 * `tier` is the run queue's primary sort (#227), and a timeline that schedules
 * a C before an S is quietly disagreeing with the queue about what matters.
 * Lengths and lane are untouched; only the ORDER within a lane changes.
 */
export function proposeByTier(items: RoadmapItem[], now = NOW_WEEK): Proposal {
  const moves: Move[] = [];
  const byArea = new Map<string, RoadmapItem[]>();
  for (const i of items) {
    if (i.archived || i.done || !i.sched || i.sched.start < now) continue;
    byArea.set(i.area, [...(byArea.get(i.area) || []), i]);
  }
  byArea.forEach((lane) => {
    const slots = lane.map((i) => i.sched!.start).sort((a, b) => a - b);
    const wanted = lane.slice().sort((a, b) =>
      tierRank(a.tier) - tierRank(b.tier) || a.sched!.start - b.sched!.start);
    let cursor = slots[0];
    wanted.forEach((i) => {
      if (i.sched!.start !== cursor) moves.push({ id: i.id, sched: { start: cursor, len: i.sched!.len } });
      cursor += i.sched!.len;
    });
  });
  return {
    kind: 'tier',
    moves,
    summary: moves.length
      ? `Reorders ${moves.length} bar${moves.length === 1 ? '' : 's'} so each lane runs S, A, B, C — the same sort the run queue uses.`
      : 'Every lane already runs in tier order.',
  };
}
