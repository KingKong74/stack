// The Roadmap tab v2's arithmetic — pure, no React, no network.
//
// Everything the three views compute lives here rather than in a component, for
// the same reason `lib/spine.ts` does: the bar geometry is the one part of a
// Gantt that is genuinely easy to get wrong, and a wrong bar is a plan you act
// on. Tested in `scripts/plan.test.mjs`.
//
// FOUR THINGS THIS FILE INSISTS ON:
//
//  1. A WEEK INDEX IS NOT A DATE. `sched.start` counts weeks from the project's
//     own week zero. The scale control (week / month / quarter) changes only the
//     COLUMN HEADINGS and gridlines — never the geometry, which is always in
//     weeks. That is why switching scale cannot move a bar.
//  2. SLIP IS MEASURED AGAINST THE BASELINE, AND ONLY EXISTS IF THERE IS ONE.
//     `baseline == null` means nothing was ever committed to, which is NOT the
//     same as "on plan" and must not render as a clean bar. Same rule as a NULL
//     review_verdict.
//  3. AN UNSIZED TICKET IS NOT A FREE ONE. `estimate == null` is excluded from
//     the scope drawer's committed total AND counted separately, so a cycle that
//     looks like it fits because half of it is unsized says so out loud.
//  4. THE ARRANGE ACTIONS PROPOSE, THEY DO NOT APPLY. Each returns a diff —
//     a list of {id, sched} — and the caller decides. Nothing here mutates.

import type { RoadmapItem } from '../types';

/** The timeline's span, in weeks. Twin of SCHED_WEEKS in server/src/routes/roadmap.js. */
export const SCHED_WEEKS = 24;
/** The scope drawer's cycle length, in weeks — what "does this fit" is measured against. */
export const CYCLE_WEEKS = 6;

export type Scale = 'week' | 'month' | 'quarter';
export interface ScaleCol { label: string; now: boolean; weeks: number }

/**
 * The columns under the timeline's ruler. Widths are proportional to `weeks`,
 * so a quarter column really is three months wide — a scale whose columns were
 * all equal would misdraw every bar that crossed one.
 */
export function scaleCols(scale: Scale, weeks = SCHED_WEEKS): ScaleCol[] {
  if (scale === 'week') {
    return Array.from({ length: weeks }, (_, i) => ({
      // Every other week is labelled; all 24 would collide at any real width.
      label: i % 2 === 0 ? `W${i + 1}` : '', now: i === weeks - 4, weeks: 1,
    }));
  }
  if (scale === 'quarter') {
    const half = Math.round(weeks / 2);
    return [
      { label: 'Q1', now: false, weeks: half },
      { label: 'Q2', now: true, weeks: weeks - half },
    ];
  }
  const months = Math.max(1, Math.round(weeks / 4));
  return Array.from({ length: months }, (_, i) => ({
    label: `M${i + 1}`, now: i === months - 1, weeks: weeks / months,
  }));
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
export function layoutLane(area: string, items: RoadmapItem[], trackPx: number, weeks = SCHED_WEEKS): Lane {
  const pxPerWeek = trackPx > 0 ? trackPx / weeks : 0;
  const placed = items
    .filter((i) => i.sched)
    .map((i) => {
      const sched = i.sched!;
      const barPx = sched.len * pxPerWeek;
      const labelPx = i.title.length * CHAR_PX + LABEL_PAD;
      const inside = barPx >= labelPx;
      const x0 = sched.start * pxPerWeek;
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
      left: (sched.start / weeks) * 100,
      width: (sched.len / weeks) * 100,
      row,
      inside: p.inside,
      before: p.before,
      ghost: moved ? { left: (base!.start / weeks) * 100, width: (base!.len / weeks) * 100 } : null,
    };
  });

  return { area, bars, rows: Math.max(1, rowEnds.length) };
}

/** Where a drop at this pixel offset lands, clamped so the bar stays in view. */
export function weekAt(offsetPx: number, trackPx: number, len: number, weeks = SCHED_WEEKS): number {
  if (trackPx <= 0) return 0;
  const raw = Math.round((offsetPx / trackPx) * weeks);
  return Math.max(0, Math.min(weeks - len, raw));
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
 * never "the first list" — see that file's header.
 */
export function listKeyOf(it: RoadmapItem): string {
  if (it.listKey) return it.listKey;
  if (it.done) return 'shipped';
  if (it.claimedBy.trim()) return 'progress';
  if (it.source === 'hook' && !it.reviewed) return 'idea';
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
