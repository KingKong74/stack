// The Roadmap tab v2's arithmetic — pure, no React, no network.
//
// Everything the three views compute lives here rather than in a component, for
// the same reason `lib/spine.ts` does: the bar geometry is the one part of a
// Gantt that is genuinely easy to get wrong, and a wrong bar is a plan you act
// on. Tested in `scripts/plan.test.mjs`.
//
// FIVE THINGS THIS FILE INSISTS ON:
//
//  1. THE SCHEDULE IS MINUTES FROM WEEK ZERO, AND A VIEWPORT IS A WINDOW ONTO
//     IT (#401). `sched.start` and `sched.len` are both minute offsets, and NO
//     amount of zooming ever changes either. What zooming changes is `span` —
//     how many minutes fill the track — so the same bar stretches at the hour
//     grain and condenses at quarters while the schedule it draws is untouched.
//     IT WAS AN INTEGER WEEK INDEX UNTIL #401. The unit is the whole of what
//     changed, and it changed because the timeline's zoom now runs from hours to
//     quarters: a week-stored model made the hour grid a READING scale over
//     something it could not edit, a precision the column behind it did not
//     have. Minutes are the finest thing the UI offers (a 15-minute snap), so
//     the grid and the model finally agree.
//  2. THE GRAIN IS DERIVED FROM PIXELS, NOT PICKED. `grainFor` reads pixels-per-
//     day off the measured track, so "Hour" means hours are actually legible
//     rather than being a mode you can select onto a 4px column. The zoom stops
//     are shortcuts to a pixel density, not five discrete states.
//  3. SLIP IS MEASURED AGAINST THE BASELINE, AND ONLY EXISTS IF THERE IS ONE.
//     `baseline == null` means nothing was ever committed to, which is NOT the
//     same as "on plan" and must not render as a clean bar. Same rule as a NULL
//     review_verdict.
//  4. AN UNSIZED TICKET IS NOT A FREE ONE. `estimate == null` is excluded from
//     the scope drawer's committed total AND counted separately, so a cycle that
//     looks like it fits because half of it is unsized says so out loud.
//     `estimate` stays in WEEKS — it is a size somebody typed, not a position.
//  5. THE VIEWPORT IS NOT CLAMPED TO THE DOMAIN; THE BARS ARE. You can pan past
//     either end of the schedulable window, because the alternative is a pan
//     that stops dead with no explanation. What must never move is a BAR: every
//     drag, drop and nudge clamps to [0, SCHED_MINUTES], so a viewport that has
//     wandered off the plan cannot schedule anything outside it. The way back is
//     `centreOn(nowMin(...))` — and when now is off-screen, the caller says so
//     rather than pinning a now-line to an edge it is nowhere near.

import type { RoadmapItem, SchedSpan } from '../types';

// --- units -----------------------------------------------------------------

export const MIN_PER_HOUR = 60;
export const MIN_PER_DAY = 24 * 60;
export const MIN_PER_WEEK = 7 * MIN_PER_DAY;

/** The timeline's span, in weeks. Twin of SCHED_WEEKS in server/src/routes/roadmap.js. */
export const SCHED_WEEKS = 24;
/** The schedulable domain, in minutes. Every bar is clamped inside it. */
export const SCHED_MINUTES = SCHED_WEEKS * MIN_PER_WEEK;
/**
 * The floor on a bar's length. A minute column can express a zero-width bar,
 * and a bar with no width is a schedule entry you can neither see nor grab.
 * Twin of MIN_SCHED_LEN in server/src/routes/roadmap.js.
 */
export const MIN_SCHED_LEN = 15;
/** The scope drawer's cycle length, in weeks — what "does this fit" is measured against. */
export const CYCLE_WEEKS = 6;

/**
 * WHERE "NOW" IS WHEN THE PROJECT HAS NO WEEK ZERO. A third of the way in, not
 * at the right-hand edge: the edge is where a timeline puts today if nobody
 * thinks about it, and it leaves the whole chart showing what already happened
 * with nowhere to draw what is coming. A planning instrument should be mostly
 * future.
 *
 * With a week zero, `nowMin` uses the REAL CLOCK instead — which it must, now
 * that the chart draws hours. A fixed week 8 was tolerable while the finest
 * column was a week wide; against an hour grid it would put the now-line
 * somewhere today is provably not.
 */
export const NOW_WEEK = 8;

// --- time and dates --------------------------------------------------------

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW_NARROW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The real instant a minute offset lands on. `weekZero` is the project's own
 * start (projects.week_zero); without one the timeline still works — it just has
 * no dates, which the calendar says rather than inventing a year.
 *
 * EVERYTHING HERE IS UTC. Week zero is a bare date with no zone, so reading it
 * back in the browser's zone would slide every bar by the offset and put a 09:00
 * start at 20:00 for anyone east of Greenwich.
 */
export function dateAt(min: number, weekZero: string | null): Date | null {
  if (!weekZero) return null;
  const t = Date.parse(`${weekZero}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + min * 60000);
}

/** The minute offset of a real instant. The inverse of `dateAt`. */
export function minAt(at: Date, weekZero: string | null): number | null {
  if (!weekZero) return null;
  const t = Date.parse(`${weekZero}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.round((at.getTime() - t) / 60000);
}

/**
 * WHERE NOW IS, in minutes from week zero.
 *
 * NOT CLAMPED into the schedulable domain. A project whose week zero is nine
 * months back has a now that is genuinely past the end of its own horizon, and
 * clamping would draw the now-line at the right-hand edge — a claim that today
 * is the last week of the plan. The callers check `inView` and say "now is off
 * this window" instead.
 */
export const nowMin = (weekZero: string | null, at: Date = new Date()): number =>
  minAt(at, weekZero) ?? NOW_WEEK * MIN_PER_WEEK;

export const fmtDate = (d: Date): string => `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
export const fmtDateYear = (d: Date): string => `${fmtDate(d)} ${d.getUTCFullYear()}`;
export const fmtTime = (d: Date): string =>
  `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
export const monthName = (d: Date): string => MONTH_NAMES[d.getUTCMonth()];
export const dowShort = (d: Date): string => DOW_SHORT[d.getUTCDay()];
export const dowNarrow = (d: Date): string => DOW_NARROW[d.getUTCDay()];

/** The week number a minute offset falls in, 1-based — what a dateless project reads instead. */
export const weekNo = (min: number): number => Math.floor(min / MIN_PER_WEEK) + 1;
/** The day index from week zero (0 = week zero itself). */
export const dayNo = (min: number): number => Math.floor(min / MIN_PER_DAY);
/** The minute offset of the start of the day a minute offset falls in. */
export const dayStart = (min: number): number => Math.floor(min / MIN_PER_DAY) * MIN_PER_DAY;

/**
 * A duration, in the units a person would say it in. Days once it is a day or
 * more (a 3d 4h bar is 3d 4h, not 76h); hours and minutes below that. Never
 * "0m" for something that has a length — the floor is MIN_SCHED_LEN.
 */
export function fmtDur(min: number): string {
  const total = Math.max(0, Math.round(min));
  if (total >= MIN_PER_DAY) {
    const d = Math.floor(total / MIN_PER_DAY);
    const h = Math.round((total - d * MIN_PER_DAY) / MIN_PER_HOUR);
    return h ? `${d}d ${h}h` : `${d}d`;
  }
  const h = Math.floor(total / MIN_PER_HOUR);
  const m = total - h * MIN_PER_HOUR;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

// --- the viewport ----------------------------------------------------------

export type Grain = 'hour' | 'day' | 'week' | 'month' | 'quarter';

/**
 * WHICH SLICE OF THE SCHEDULE THE TRACK IS DRAWING, in minutes. A narrow `span`
 * is a zoom IN: fewer minutes over the same pixels means every bar is wider.
 *
 * It is a viewport and not a filter — nothing is excluded from the plan by being
 * off-screen, which is why `layoutLane` counts what it left either side rather
 * than dropping it silently.
 */
export interface Viewport { start: number; span: number }

/**
 * The zoom's range, as pixels per DAY. The floor is where a quarter still has a
 * readable column; the ceiling is where an hour is about an inch, past which
 * there is nothing finer to see and panning becomes the only gesture that works.
 */
export const PX_DAY_MIN = 1.9;
export const PX_DAY_MAX = 1440;

/**
 * The named stops on the zoom, coarsest last. A stop is a PIXEL DENSITY, not a
 * mode: pressing "Week" sets the span that makes a day fifteen pixels wide on
 * THIS track, so the same press gives the same reading experience on a phone and
 * on a wide monitor. `grainFor` then names whatever density you land on, whether
 * you got there by pressing a stop or by scrolling between two.
 */
export const ZOOM_STOPS: { key: Grain; label: string; px: number }[] = [
  { key: 'hour', label: 'Hour', px: 300 },
  { key: 'day', label: 'Day', px: 46 },
  { key: 'week', label: 'Week', px: 15 },
  { key: 'month', label: 'Month', px: 5 },
  { key: 'quarter', label: 'Quarter', px: 2.1 },
];

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** How many pixels one day occupies on a track of this width. */
export const pxPerDay = (view: Viewport, trackPx: number): number =>
  (trackPx <= 0 || view.span <= 0 ? 0 : (trackPx / view.span) * MIN_PER_DAY);

/**
 * WHAT THE CHART IS CURRENTLY DRAWING, read off the pixels rather than chosen.
 *
 * The thresholds are the points at which the next unit down stops being legible:
 * below 150px a day cannot carry hour columns, below 26px it cannot carry its own
 * date, and so on. Deriving it is what stops "Hour" being a mode you can select
 * onto a four-pixel day.
 */
export function grainFor(view: Viewport, trackPx: number): Grain {
  const px = pxPerDay(view, trackPx);
  if (px >= 150) return 'hour';
  if (px >= 26) return 'day';
  if (px >= 10) return 'week';
  if (px >= 3.4) return 'month';
  return 'quarter';
}

/** The span, in minutes, that puts this many pixels on a day. */
export const spanForPx = (px: number, trackPx: number): number =>
  (trackPx <= 0 ? SCHED_MINUTES : (trackPx / clamp(px, PX_DAY_MIN, PX_DAY_MAX)) * MIN_PER_DAY);

/** A span pinned inside the zoom's range. */
export const clampSpan = (span: number, trackPx: number): number => {
  if (trackPx <= 0) return Math.max(1, span);
  return clamp(span, spanForPx(PX_DAY_MAX, trackPx), spanForPx(PX_DAY_MIN, trackPx));
};

/** The window this project opens on: a fortnight, with now a third of the way in. */
export const viewAround = (at: number, span = 14 * MIN_PER_DAY): Viewport =>
  ({ start: at - span / 3, span });

/** Put a moment a third of the way across, keeping the current zoom. */
export const centreOn = (view: Viewport, at: number): Viewport =>
  ({ start: at - view.span / 3, span: view.span });

/** Slide the window. Deliberately unclamped — see this file's rule 5. */
export const panBy = (view: Viewport, minutes: number): Viewport =>
  ({ start: view.start + minutes, span: view.span });

/**
 * Zoom about a point, keeping whatever is under it exactly where it is.
 * `anchor` is a fraction of the track (0 = left edge, 0.5 = middle), so a wheel
 * zoom anchors on the cursor and a button zoom anchors on the middle.
 */
export function zoomAt(view: Viewport, trackPx: number, factor: number, anchor = 0.5): Viewport {
  const at = view.start + view.span * anchor;
  const span = clampSpan(view.span / factor, trackPx);
  return { start: at - span * anchor, span };
}

/** The window that holds every one of these spans, plus a margin either side. */
export function fitAll(spans: SchedSpan[], trackPx: number, fallback: number): Viewport {
  if (!spans.length) return viewAround(fallback);
  let lo = Infinity; let hi = -Infinity;
  for (const s of spans) { lo = Math.min(lo, s.start); hi = Math.max(hi, s.start + s.len); }
  const pad = Math.max(MIN_PER_DAY, (hi - lo) * 0.06);
  return { start: lo - pad, span: clampSpan((hi - lo) + pad * 2, trackPx) };
}

/** Where a minute offset sits, as a percentage across the track. Can be outside 0–100. */
export const leftPct = (min: number, view: Viewport): number =>
  ((min - view.start) / view.span) * 100;

/** Where a span sits in the viewport, as percentages. */
export const spanPct = (span: SchedSpan, view: Viewport) => ({
  left: leftPct(span.start, view),
  width: (span.len / view.span) * 100,
});

/** Is a moment inside the window at all? */
export const inView = (min: number, view: Viewport): boolean =>
  min >= view.start && min < view.start + view.span;

/**
 * HOW FINELY AN EDIT MOVES AT THIS GRAIN. Quarter-hours when hours are on
 * screen, an hour when days are, a whole day when they are not: a drag at the
 * quarter grain that landed on 14:23 would be recording a precision the gesture
 * never had.
 */
export const snapFor = (grain: Grain): number =>
  (grain === 'hour' ? 15 : grain === 'day' ? MIN_PER_HOUR : MIN_PER_DAY);

/** A moment snapped to the grain, then pinned inside the schedulable domain. */
export const snapTo = (min: number, snap: number): number => Math.round(min / snap) * snap;

/**
 * Where a drop at this pixel offset lands, clamped so the bar stays in the
 * SCHEDULABLE domain — not in the viewport. Zooming and panning must never be
 * able to schedule outside the plan, and the server clamps to the same domain.
 */
export function timeAt(
  offsetPx: number, trackPx: number, len: number, view: Viewport, snap = MIN_PER_DAY,
): number {
  if (trackPx <= 0) return 0;
  const raw = snapTo(view.start + (offsetPx / trackPx) * view.span, snap);
  return clamp(raw, 0, Math.max(0, SCHED_MINUTES - len));
}

/** A whole span pinned inside the domain — what every drag and nudge ends with. */
export function clampSpanToDomain(span: SchedSpan): SchedSpan {
  const len = clamp(span.len, MIN_SCHED_LEN, SCHED_MINUTES);
  return { start: clamp(span.start, 0, SCHED_MINUTES - len), len };
}

// --- the ruler -------------------------------------------------------------

export interface Tick {
  /** The moment this tick marks, in minutes. */
  at: number;
  /** Percentage across the track. Can be outside 0–100 at the edges. */
  left: number;
  label: string;
  /** The line above the label — the date a run of hours belongs to, the year a run of months does. */
  sub: string;
  /** A stronger rule and a brighter label: midnight, a Monday, a January. */
  major: boolean;
}

/** A shaded stretch of the track — nights at the hour grain, weekends at the day grain. */
export interface Band { key: string; left: number; width: number }

/**
 * THE RULER, AND THE SHADING UNDER IT, for whatever the chart is drawing.
 *
 * One function rather than a column list per grain, because both halves have to
 * agree about where a day begins: a weekend band that started at a different
 * minute from the Saturday tick is a chart whose grid and whose shading disagree
 * about the date, and the eye believes the shading.
 *
 * Labels are REAL DATES once the project has a week zero, and D…/W…/M…/Q…
 * without one — honest about not knowing when this is, rather than inventing a
 * year. Bands are only ever drawn where a real date says where the weekend is,
 * so a dateless project gets ticks and no shading rather than shading in the
 * wrong place.
 */
export function ticksFor(
  view: Viewport, grain: Grain, weekZero: string | null, trackPx: number,
): { ticks: Tick[]; bands: Band[] } {
  const ticks: Tick[] = [];
  const bands: Band[] = [];
  const { start, span } = view;
  const end = start + span;
  const push = (at: number, label: string, sub: string, major: boolean) =>
    ticks.push({ at, left: leftPct(at, view), label, sub, major });
  const band = (key: string, from: number, to: number) =>
    bands.push({ key, left: leftPct(from, view), width: ((to - from) / span) * 100 });

  const firstDay = Math.floor(start / MIN_PER_DAY) - 1;
  const lastDay = Math.ceil(end / MIN_PER_DAY) + 1;
  // A pathological zoom must not build a million ticks. The cap is generous
  // enough that it is never reached at a legible density, and it is a guard
  // rather than a policy — nothing about the chart's meaning depends on it.
  const MAX = 400;

  if (grain === 'hour') {
    const pxh = pxPerDay(view, trackPx) / 24;
    const step = pxh >= 46 ? 1 : pxh >= 23 ? 2 : pxh >= 15 ? 3 : 6;
    for (let d = firstDay; d <= lastDay && ticks.length < MAX; d += 1) {
      const at0 = d * MIN_PER_DAY;
      const dt = dateAt(at0, weekZero);
      for (let hr = 0; hr < 24; hr += step) {
        const at = at0 + hr * MIN_PER_HOUR;
        push(at, `${String(hr).padStart(2, '0')}:00`,
          hr === 0 ? (dt ? `${dowShort(dt)} ${fmtDate(dt)}` : `D${d + 1}`) : '', hr === 0);
      }
      // Night: 20:00 to 07:00 the next morning. Not "outside working hours" —
      // it is the stretch nothing is expected to run in, which is what makes a
      // bar drawn across it worth noticing.
      band(`n${d}`, at0 + 20 * MIN_PER_HOUR, at0 + MIN_PER_DAY + 7 * MIN_PER_HOUR);
    }
    return { ticks, bands };
  }

  if (grain === 'day') {
    for (let d = firstDay; d <= lastDay && ticks.length < MAX; d += 1) {
      const at = d * MIN_PER_DAY;
      const dt = dateAt(at, weekZero);
      const dow = dt ? dt.getUTCDay() : ((d % 7) + 8) % 7; // week zero is a Monday
      push(at, dt ? String(dt.getUTCDate()) : `D${d + 1}`, dt ? dowNarrow(dt) : '', dow === 1);
      if (dow === 6) band(`w${d}`, at, at + 2 * MIN_PER_DAY);
    }
    return { ticks, bands };
  }

  if (grain === 'week') {
    const firstWeek = Math.floor(start / MIN_PER_WEEK) - 1;
    const lastWeek = Math.ceil(end / MIN_PER_WEEK) + 1;
    for (let w = firstWeek; w <= lastWeek && ticks.length < MAX; w += 1) {
      const at = w * MIN_PER_WEEK;
      const dt = dateAt(at, weekZero);
      push(at, dt ? fmtDate(dt) : `W${w + 1}`, `wk ${w + 1}`, true);
    }
    return { ticks, bands };
  }

  // Month and quarter both walk real calendar months, so they need a date to
  // walk from. Without a week zero there is no calendar to speak of, and the
  // labels fall back to indices on the same regular stride.
  const from = dateAt(firstDay * MIN_PER_DAY, weekZero);
  if (!from) {
    const stride = grain === 'month' ? 4 * MIN_PER_WEEK : 12 * MIN_PER_WEEK;
    const i0 = Math.floor(start / stride) - 1;
    for (let i = i0; i * stride <= end + stride && ticks.length < MAX; i += 1) {
      push(i * stride, grain === 'month' ? `M${i + 1}` : `Q${i + 1}`, '', grain === 'quarter');
    }
    return { ticks, bands };
  }
  const step = grain === 'month' ? 1 : 3;
  const cursor = new Date(Date.UTC(
    from.getUTCFullYear(),
    grain === 'month' ? from.getUTCMonth() : Math.floor(from.getUTCMonth() / 3) * 3,
    1));
  for (let i = 0; i < MAX; i += 1) {
    const at = minAt(cursor, weekZero)!;
    if (at > end + MIN_PER_WEEK) break;
    const jan = cursor.getUTCMonth() === 0;
    push(at,
      grain === 'month' ? monthName(cursor) : `Q${Math.floor(cursor.getUTCMonth() / 3) + 1}`,
      jan || grain === 'quarter' ? String(cursor.getUTCFullYear()) : '',
      jan);
    cursor.setUTCMonth(cursor.getUTCMonth() + step);
  }
  return { ticks, bands };
}

/**
 * WHAT THE WINDOW COVERS, in one line. Real dates whenever there is a week zero,
 * week indices when there is not — never an invented date, which is the calendar
 * view's rule too. It says the TIME as well once hours are on screen, because at
 * that zoom "17 Aug → 17 Aug" is the one thing the reader already knows.
 */
export function windowLabel(view: Viewport, grain: Grain, weekZero: string | null): string {
  const a = dateAt(view.start, weekZero);
  const b = dateAt(view.start + view.span, weekZero);
  if (!a || !b) {
    return `wk ${weekNo(view.start)} – ${weekNo(view.start + view.span)}`;
  }
  const crossesYear = a.getUTCFullYear() !== b.getUTCFullYear();
  if (grain === 'hour') {
    // The time-only form is only honest INSIDE ONE DAY. On a wide track the
    // hour stop is several days across, and "10 Aug · 21:12 → 21:41" read as
    // twenty-nine minutes when the window was four days — a label that
    // understates its own range by two orders of magnitude.
    const sameDay = Math.floor(view.start / MIN_PER_DAY) === Math.floor((view.start + view.span) / MIN_PER_DAY);
    return sameDay
      ? `${fmtDate(a)} · ${fmtTime(a)} → ${fmtTime(b)}`
      : `${fmtDate(a)} ${fmtTime(a)} → ${fmtDate(b)} ${fmtTime(b)}`;
  }
  const wide = grain === 'month' || grain === 'quarter';
  return crossesYear || wide
    ? `${fmtDateYear(a)} → ${fmtDateYear(b)}`
    : `${fmtDate(a)} → ${fmtDate(b)}`;
}

/** The second, quieter line under the range — what scale of thing you are looking at. */
export function spanLabel(view: Viewport, grain: Grain, weekZero: string | null): string {
  const days = view.span / MIN_PER_DAY;
  if (grain === 'hour') {
    const d = dateAt(view.start, weekZero);
    return d
      ? `${DOW_SHORT[d.getUTCDay()]} · wk ${weekNo(view.start)}`
      : `${Math.round(days * 24)} hours in view`;
  }
  if (days < 16) return `${Math.round(days)} days in view`;
  if (days < 80) return `${Math.round(days / 7)} weeks in view`;
  return `${Math.round(days / 30.4)} months in view`;
}

// --- what's next -----------------------------------------------------------

export interface NextUpBar {
  item: RoadmapItem;
  /** Minutes until it starts. Negative = already running. */
  inMin: number;
  running: boolean;
}

/**
 * The bars around and after now, soonest first — what the timeline is actually
 * asking you to look at. Anything already finished is excluded: a Gantt's job
 * to the right of the now-line is to show what has not happened yet.
 */
export function whatsNext(items: RoadmapItem[], now: number, limit = 6): NextUpBar[] {
  return items
    .filter((i) => !i.archived && !i.done && i.sched && i.sched.start + i.sched.len > now)
    .map((i) => ({
      item: i,
      inMin: i.sched!.start - now,
      running: i.sched!.start <= now,
    }))
    .sort((a, b) => a.inMin - b.inMin || a.item.title.localeCompare(b.item.title))
    .slice(0, limit);
}

/** "in 3d", "in 40m", "running" — how far off something is, said the short way. */
export function fmtWhen(inMin: number, running: boolean): string {
  if (running) return 'running';
  if (inMin < MIN_PER_HOUR) return `${Math.max(1, Math.round(inMin))}m`;
  if (inMin < MIN_PER_DAY) return `${Math.round(inMin / MIN_PER_HOUR)}h`;
  if (inMin < 14 * MIN_PER_DAY) return `${Math.round(inMin / MIN_PER_DAY)}d`;
  return `${Math.round(inMin / MIN_PER_WEEK)}w`;
}

// --- the calendar ----------------------------------------------------------
//
// THE CALENDAR IS THE SAME SCHEDULE, READ AT WHATEVER GRAIN THE ZOOM IS ON.
// Hours and days become a time grid with real hour rows; weeks and coarser
// become month grids, because an hour row is meaningless once a screen holds a
// quarter. It is the SAME `view` and the SAME zoom — switching to Calendar
// changes the shape of the drawing and nothing about where you are looking.
//
// All of it needs a week zero. A week index has no place on a calendar, and a
// calendar whose dates are made up is worse than no calendar, so both builders
// return empty and the view says why.

/** One event inside a day column — a bar shorter than a day. */
export interface CalEvent { item: RoadmapItem; startMin: number; endMin: number }

export interface CalDay {
  /** Day index from week zero. */
  day: number;
  date: Date;
  today: boolean;
  /** Bars a day or longer, drawn in the all-day strip. `first` = it starts here. */
  allDay: { item: RoadmapItem; first: boolean }[];
  events: CalEvent[];
}

/** The hour window the day columns draw. Outside it a bar is still an event — see `calendarDays`. */
export const CAL_HOUR_FROM = 6;
export const CAL_HOUR_TO = 22;

/**
 * The day columns for the time grid: one day at the hour grain, a Monday-aligned
 * week at the day grain.
 *
 * A bar SHORTER than a day is an event in its own column; a bar a day or longer
 * is an all-day chip on every day it covers, marked on the one it starts. Two
 * shapes because they are two different claims — "this happens at 14:00" and
 * "this is what next week is about" — and drawing a five-day bar as a 120-hour
 * event would fill the grid with one item.
 */
export function calendarDays(
  items: RoadmapItem[], view: Viewport, grain: Grain, weekZero: string | null, now: number,
): CalDay[] {
  if (!weekZero) return [];
  const n = grain === 'hour' ? 1 : 7;
  let first = Math.floor(view.start / MIN_PER_DAY);
  if (n === 7) {
    // Anchor on the MIDDLE of the window, then walk back to its Monday: anchoring
    // on the left edge shows the week the window happens to start in, which after
    // a pan is usually the one you just left.
    first = Math.floor((view.start + view.span / 2) / MIN_PER_DAY);
    const d = dateAt(first * MIN_PER_DAY, weekZero)!;
    first -= (d.getUTCDay() + 6) % 7;
  }
  const live = items.filter((i) => !i.archived && i.sched);
  const today = Math.floor(now / MIN_PER_DAY);

  return Array.from({ length: n }, (_, k) => {
    const day = first + k;
    const from = day * MIN_PER_DAY;
    const to = from + MIN_PER_DAY;
    return {
      day,
      date: dateAt(from, weekZero)!,
      today: day === today,
      allDay: live
        .filter((i) => i.sched!.len >= MIN_PER_DAY && i.sched!.start < to && i.sched!.start + i.sched!.len > from)
        .map((i) => ({ item: i, first: Math.floor(i.sched!.start / MIN_PER_DAY) === day })),
      events: live
        .filter((i) => i.sched!.len < MIN_PER_DAY && i.sched!.start < to && i.sched!.start + i.sched!.len > from)
        .map((i) => ({ item: i, startMin: i.sched!.start, endMin: i.sched!.start + i.sched!.len }))
        .sort((a, b) => a.startMin - b.startMin),
    };
  });
}

export interface CalCell {
  day: number;
  date: Date;
  inMonth: boolean;
  today: boolean;
  items: RoadmapItem[];
}
export interface CalMonth { key: string; title: string; cells: CalCell[] }

/**
 * The month grids: one month at the week and month grains, a quarter's three at
 * the quarter grain. Every cell lists what is ACTIVE that day, not what starts
 * that day — a bar covering a fortnight belongs on all fourteen squares, and a
 * month showing it once is a month claiming thirteen free days.
 */
export function calendarMonths(
  items: RoadmapItem[], view: Viewport, grain: Grain, weekZero: string | null, now: number,
): CalMonth[] {
  if (!weekZero) return [];
  const count = grain === 'quarter' ? 3 : 1;
  const mid = dateAt(view.start + view.span / 2, weekZero)!;
  const anchorMonth = mid.getUTCMonth() - (count === 3 ? 1 : 0);
  const live = items.filter((i) => !i.archived && i.sched);
  const today = Math.floor(now / MIN_PER_DAY);
  const out: CalMonth[] = [];

  for (let m = 0; m < count; m += 1) {
    const first = new Date(Date.UTC(mid.getUTCFullYear(), anchorMonth + m, 1));
    const lead = (first.getUTCDay() + 6) % 7;             // Monday-first grids
    const dim = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const startDay = Math.floor(minAt(first, weekZero)! / MIN_PER_DAY) - lead;
    const weeks = Math.ceil((lead + dim) / 7);
    const cells: CalCell[] = [];
    for (let i = 0; i < weeks * 7; i += 1) {
      const day = startDay + i;
      const from = day * MIN_PER_DAY;
      const date = dateAt(from, weekZero)!;
      cells.push({
        day,
        date,
        inMonth: date.getUTCMonth() === first.getUTCMonth(),
        today: day === today,
        items: live.filter((i2) => i2.sched!.start < from + MIN_PER_DAY
          && i2.sched!.start + i2.sched!.len > from),
      });
    }
    out.push({
      key: `${first.getUTCFullYear()}-${first.getUTCMonth()}`,
      title: `${MONTH_NAMES[first.getUTCMonth()]} ${first.getUTCFullYear()}`,
      cells,
    });
  }
  return out;
}

// --- slip ------------------------------------------------------------------

export interface Slip {
  /** Minutes later than the baseline start. null = no baseline, which is NOT "on plan". */
  min: number | null;
  longer: number | null;
  measured: boolean;
}

export function slipOf(it: RoadmapItem): Slip {
  if (!it.sched || !it.baseline) return { min: null, longer: null, measured: false };
  return {
    min: it.sched.start - it.baseline.start,
    longer: it.sched.len - it.baseline.len,
    measured: true,
  };
}

/**
 * #425 — WHERE A NEWLY ADDED ITEM LANDS.
 *
 * An item added by hand used to be born unscheduled, so the act of deciding to
 * do something put it in the tray rather than on the plan, and the timeline only
 * ever showed the subset somebody had gone back and dragged. It now starts at
 * now, for a working day.
 *
 * A DAY, not `defaultLen`'s three: this runs when nobody is looking at a grain
 * (the add modal is reachable from every tab), and a new line is the least-known
 * thing on the board — the smaller claim is the honest one, and it is one drag
 * from being whatever it really is.
 *
 * Only ever for something a PERSON added. Nothing here is applied to hook
 * extractions or agent posts: `sched` is omitted for those and NULL still means
 * UNSCHEDULED, which is a real state and the right one for work nobody has
 * agreed to yet.
 */
export function newItemSched(weekZero: string | null, at: Date = new Date()): SchedSpan {
  return { start: Math.min(nowMin(weekZero, at), SCHED_MINUTES - MIN_PER_DAY), len: MIN_PER_DAY };
}

/**
 * #410 — IS THIS WORK IN FLIGHT? Claimed by a session, or ticked. Either way its
 * bar reports something that actually happened and must not be moved by a clock.
 */
export const inFlight = (it: RoadmapItem): boolean => it.done || it.claimedBy.trim() !== '';

/**
 * #410 — THE SPAN A BAR IS DRAWN AT, which is not always the span it is stored
 * at.
 *
 * A plan rots by standing still. Work nobody has started keeps the dates it was
 * given, so a week later the chart shows it as having been due in the past — and
 * the further back it falls the less the whole view says about what happens
 * next. So an unstarted bar keeps its LENGTH and floors its START at now: it
 * moves with the now line instead of falling behind it.
 *
 * Four populations do NOT move, and each for its own reason:
 *   • in flight (claimed or done) — the bar is a record, not a plan;
 *   • skipped — parked on purpose, and rolling it forward would quietly
 *     un-park it;
 *   • archived — not on the chart at all;
 *   • anything already at or after now — there is nothing to catch up to.
 *
 * DISPLAY ONLY. Nothing here writes: `sched` is untouched in the database, and
 * the baseline it is measured against is untouched too, so the ghost still shows
 * where the work was first planned and the gap between them is the slip. A
 * stored roll would need a machine writing the owner's plan on a timer, which is
 * a much larger claim than "draw it where it can still happen".
 */
export function rolledSched(it: RoadmapItem, now: number): SchedSpan | null {
  if (!it.sched) return null;
  if (inFlight(it) || it.skipped || it.archived) return it.sched;
  if (it.sched.start >= now) return it.sched;
  return { start: now, len: it.sched.len };
}

/** Did `rolledSched` actually move this one? The bar says so when it did. */
export const isRolled = (it: RoadmapItem, now: number): boolean =>
  !!it.sched && rolledSched(it, now) !== it.sched;

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
   * Scheduled bars this lane has that sit entirely BEFORE / AFTER the viewport,
   * and the nearest one either way so the caller can pan to it.
   *
   * Counted rather than dropped. Zooming in is the one thing that can empty a
   * lane that has work in it, and a lane drawn as "drop something here" while
   * holding three bars a fortnight to the left is the chart lying about the plan.
   */
  offLeft: number;
  offRight: number;
  nearestLeft: number | null;
  nearestRight: number | null;
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
  area: string, items: RoadmapItem[], trackPx: number, view: Viewport,
): Lane {
  const { start: winStart, span } = view;
  const winEnd = winStart + span;
  const pxPerMin = trackPx > 0 && span > 0 ? trackPx / span : 0;
  let offLeft = 0; let offRight = 0;
  let nearestLeft: number | null = null; let nearestRight: number | null = null;

  const placed = items
    .filter((i) => i.sched)
    .filter((i) => {
      const { start, len } = i.sched!;
      if (start + len <= winStart) {
        offLeft += 1;
        nearestLeft = nearestLeft === null ? start : Math.max(nearestLeft, start);
        return false;
      }
      if (start >= winEnd) {
        offRight += 1;
        nearestRight = nearestRight === null ? start : Math.min(nearestRight, start);
        return false;
      }
      return true;
    })
    .map((i) => {
      const sched = i.sched!;
      const barPx = sched.len * pxPerMin;
      const labelPx = i.title.length * CHAR_PX + LABEL_PAD;
      const inside = barPx >= labelPx;
      const x0 = (sched.start - winStart) * pxPerMin;
      const x1 = x0 + barPx;
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
      left: leftPct(sched.start, view),
      width: (sched.len / span) * 100,
      row,
      inside: p.inside,
      before: p.before,
      ghost: moved ? spanPct(base!, view) : null,
    };
  });

  return { area, bars, rows: Math.max(1, rowEnds.length), offLeft, offRight, nearestLeft, nearestRight };
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
// the old trim arithmetic believe it had saved time it had never spent, and a
// figure that claims weeks it did not save is worse than one that refuses. The
// trim is the Curator's job now, and the total it reads is still this one.
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

/**
 * THE LENGTH A NEWLY PLACED BAR GETS, in minutes.
 *
 * `estimate` is in WEEKS and stays there — it is a size somebody typed, not a
 * position — so this is the one place the two units meet. An UNSIZED item does
 * not get a zero-length bar: it gets a working length for the grain you are
 * looking at, because a bar you cannot see is not a schedule, and the Horizon
 * row is where genuinely unsized work lives.
 */
export function defaultLen(it: RoadmapItem, grain: Grain): number {
  if (it.estimate !== null) return Math.max(MIN_SCHED_LEN, Math.round(it.estimate * MIN_PER_WEEK));
  // #412 — an IDEA is two hours until somebody sizes it, at every grain.
  //
  // Asked for as "default the estimate field to 2 hours", which that column
  // cannot hold: `estimate` is NUMERIC(4,1) in WEEKS, so two hours is 0.0119 and
  // stores as 0.0 — a zero-length bar, the exact thing the note above forbids.
  // The request is really about the SIZE an unsized idea is drawn at, which is
  // this function, so it lands here and the units rule is left alone.
  //
  // Above the grain fallbacks because an idea is unsized in a way a planned item
  // is not: it is a line somebody's session dropped on the board, and three days
  // is a claim about it that nobody made. It still yields to a real `estimate`,
  // which is what "the owner can still override" means.
  if (listKeyOf(it) === 'idea') return 2 * MIN_PER_HOUR;
  if (grain === 'hour') return 2 * MIN_PER_HOUR;
  if (grain === 'day') return 4 * MIN_PER_HOUR;
  return 3 * MIN_PER_DAY;
}

/** The durations the drawer offers as one press. Anything else is a drag or a nudge. */
export const DUR_OPTIONS: { label: string; min: number }[] = [
  { label: '1h', min: MIN_PER_HOUR },
  { label: '2h', min: 2 * MIN_PER_HOUR },
  { label: '4h', min: 4 * MIN_PER_HOUR },
  { label: '1d', min: MIN_PER_DAY },
  { label: '3d', min: 3 * MIN_PER_DAY },
  { label: '1w', min: MIN_PER_WEEK },
  { label: '2w', min: 2 * MIN_PER_WEEK },
];

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

// THE ARRANGE PROPOSALS ARE GONE, and their absence is the point.
//
// proposeSchedule / proposeCompact / proposeCatchUp / proposeBalance /
// proposeByTier / proposeTrim lived here: deterministic sums over the rows on
// screen, each returning a diff the owner applied or discarded. They were exact
// and they were the ceiling — six jobs somebody had written a function for, and
// every one of them blind to everything the board does not store.
//
// The Arrange panel's six buttons now hand the same jobs to the CURATOR'S OWN
// SESSION instead (web/src/lib/curatorTasks.ts composes the brief; the console
// on the Roadmap tab runs it), which can read the board AND the code, ask a
// question back, and be told the thing the sum could not know. What is left in
// this file is the GEOMETRY — where a bar is drawn — which is arithmetic that
// has one right answer and belongs nowhere near a model.
//
// `Move` survives as the shape of a proposed position, because the two ✧ reads
// still come back as one and the timeline still ghosts it.

/** A proposed position for one bar, in minutes. null = back to the tray. */
export interface Move { id: number; sched: SchedSpan | null }
