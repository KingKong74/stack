// The Overview tab's PROGRESSION SPINE (design 4a) — pure derivation, no
// network, no React. Turns a project's own collections into the four stages a
// change passes through, the progress ledger's arithmetic, and the small
// panels that hang off the spine.
//
// WHY A STAGE IS DERIVED AND NEVER STORED. There is no `stage` column and there
// must not be one: every stage below is a predicate over rows that already say
// what they are, and a stored copy would be a second truth that drifts the first
// time something is ticked outside the one path that maintains it. Same rule as
// `lib/feature.ts` (#365) and `lib/branch.ts` (#363).
//
// THE PREDICATES, AND THE TWO THAT ARE EASY TO GET WRONG:
//
//  • BUILT is the old Review room's queue predicate (#374) — `done` OR
//    (`builtNote` non-empty AND `claimedBy` non-empty), with no verdict yet.
//    NOT `done && !reviewTag`: nothing in Stack ticks an item, so that spelling
//    draws an empty stage over a full night's work. The room was culled; the
//    predicate outlived it and is now the ONLY definition of "built but not
//    verdicted" on the client, so it must not be simplified back.
//  • LANDED is `done && reviewTag` — verdicted, not merely ticked. Built and
//    Landed are therefore disjoint by construction (one demands an empty
//    verdict, the other a non-empty one), so no change is ever counted twice.
//  • IN FLIGHT subtracts Built, and that subtraction is load-bearing. A claim
//    is NOT released when the work finishes — `claimed_by` stays until a human
//    merges and ticks (#277) — so a change that has been built is still
//    claimed, and the plain reading (`!done && claimedBy`) counts it in two
//    stages at once. In flight therefore means claimed and NOT yet built:
//    something is being worked on, as against something waiting on you.
//
// The four stages partition the board exactly — every row is in one and only
// one — which is what lets the spine's counts be added up and trusted.
//
// The Idea stage was Polaris and went with it; Built no longer links to the
// Review room, which was culled with Mission Control. The BUILT PREDICATE
// stays exactly as it was even so — it is what the board's own "waiting on
// you" reading is built from, and softening it to `done` would hide a night's
// work the same way it did before #374.
//
// WHAT IS DELIBERATELY NOT HERE: a flow rate per hand-off. The design draws a
// throughput figure between each pair of stages, and Stack cannot honestly
// supply one — roadmap rows carry `updatedAt` (MOVEMENT, per CLAUDE.md) and no
// stage-transition stamp at all, so "9 promoted to Planned last week" would be
// a number with no source. `lastMovedDays` below is the one honest thing the
// data does support: how long the queue in a stage has sat untouched. Absent is
// not zero — the same rule as a NULL `review_verdict`.

import type { Bug, PulseUsage, Roadmap, RoadmapItem, Severity } from '../types';
import { hrefTo } from './route';
import { tierRank } from '../types';
import { parseBranch, type LaneKind } from './branch';
// The Roadmap tab owns the schedule, so its arithmetic is imported and never
// re-spelt here: one definition of the minute offsets, of slip, and of what "in
// this cycle" means, or the Overview and the Timeline disagree about the same plan.
import { SCHED_MINUTES, MIN_SCHED_LEN, slipOf, scopeTotals, isBuilt, type ScopeTotals } from './plan';

export type StageKey = 'planned' | 'inflight' | 'built' | 'landed';

export interface Stage {
  key: StageKey;
  label: string;
  sub: string;          // what standing in this stage means
  count: number;
  href: string;         // where the stage sends you — its owning tab or room
  hrefLabel: string;
  /** The queue here is backed up and is this project's bottleneck. */
  blocked: boolean;
  /** Days since anything in this stage last moved; null = nothing to move. */
  lastMovedDays: number | null;
}

const flat = (r: Roadmap): RoadmapItem[] => [...r.must, ...r.should, ...r.could, ...r.wont];

/**
 * The built-not-verdicted predicate (#374). It MOVED to `lib/plan.ts` (#440),
 * whose lane derivation needs it and which this file already imports — one of
 * the two had to be lower. Re-exported, not re-spelt: every importer still says
 * `from '../lib/spine'`, and there is still exactly one definition.
 */
export { isBuilt } from './plan';

export const isLanded = (it: RoadmapItem): boolean => it.done && it.reviewTag !== '';
/** Claimed and NOT yet built — see the header on why the subtraction matters. */
export const isInFlight = (it: RoadmapItem): boolean =>
  !it.done && it.claimedBy.trim() !== '' && !isBuilt(it);
export const isPlanned = (it: RoadmapItem): boolean => !it.done && it.claimedBy.trim() === '';

const daysSince = (iso: string | null, now: number): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86400000)) : null;
};

// The freshest `updatedAt` in a set, as whole days ago. null when the set is
// empty OR when not one row carries a stamp — an unstamped queue has not been
// shown to be still, and must not be drawn as if it had.
function lastMoved(items: RoadmapItem[], now: number): number | null {
  let newest: number | null = null;
  for (const it of items) {
    const t = it.updatedAt ? Date.parse(it.updatedAt) : NaN;
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  return newest === null ? null : Math.max(0, Math.floor((now - newest) / 86400000));
}

/**
 * The four stages, in order. `blocked` marks at most ONE stage — the deepest
 * queue that is also standing still — because a spine that flags three
 * bottlenecks has told you nothing about where to go first.
 */
export function buildSpine(
  roadmap: Roadmap, slug: string, now = Date.now()
): Stage[] {
  const items = flat(roadmap);
  const planned = items.filter(isPlanned);
  const inflight = items.filter(isInFlight);
  const built = items.filter(isBuilt);
  const landed = items.filter(isLanded);

  const stages: Stage[] = [
    {
      key: 'planned', label: 'Planned', sub: 'open, unclaimed',
      count: planned.length,
      href: hrefTo.detail(slug, 'roadmap'), hrefLabel: 'Roadmap',
      blocked: false, lastMovedDays: lastMoved(planned, now),
    },
    {
      key: 'inflight', label: 'In flight', sub: 'claimed right now',
      count: inflight.length,
      href: hrefTo.detail(slug, 'roadmap'), hrefLabel: 'Roadmap',
      blocked: false, lastMovedDays: lastMoved(inflight, now),
    },
    {
      key: 'built', label: 'Built', sub: 'awaiting your verdict',
      count: built.length,
      href: hrefTo.detail(slug, 'roadmap'), hrefLabel: 'Roadmap',
      blocked: false, lastMovedDays: lastMoved(built, now),
    },
    {
      key: 'landed', label: 'Landed', sub: 'verdicted and merged',
      count: landed.length,
      href: hrefTo.detail(slug, 'activity'), hrefLabel: 'Activity',
      blocked: false, lastMovedDays: lastMoved(landed, now),
    },
  ];

  // A stage is the bottleneck when it holds a real queue that has not moved in
  // days. Landed is excluded — it is where work is meant to pile up, and a
  // finished project would otherwise report its own success as a blockage.
  const STILL_DAYS = 3;
  const MIN_QUEUE = 5;
  let worst: Stage | null = null;
  for (const s of stages) {
    if (s.key === 'landed') continue;
    if (s.count < MIN_QUEUE) continue;
    if (s.lastMovedDays === null || s.lastMovedDays < STILL_DAYS) continue;
    if (!worst || s.count > worst.count) worst = s;
  }
  if (worst) worst.blocked = true;
  return stages;
}

// --- the progress ledger ---------------------------------------------------

export interface BucketLine { label: string; done: number; total: number; }
export interface ProgressLedger {
  pct: number;
  lines: BucketLine[];
  /** Open critical/high bugs — what holds the 90% ceiling down. */
  seriousBugs: number;
  /** The ceiling is not merely armed, it is what you are looking at. */
  capBiting: boolean;
}

// Mirrors server/src/util.js computeProgress: only Must and Should count, a
// done Must weighs double a done Should, and any open critical/high bug caps
// the figure at 90%. The percentage itself is NOT recomputed here — it arrives
// on the project payload and this only explains it, so the two cannot drift.
export const PROGRESS_CAP = 90;

export function progressLedger(pct: number, roadmap: Roadmap, bugs: Bug[]): ProgressLedger {
  const done = (list: RoadmapItem[]) => list.filter((i) => i.done).length;
  const seriousBugs = bugs.filter(
    (b) => (b.severity === 'critical' || b.severity === 'high') && b.status !== 'fixed'
  ).length;
  return {
    pct,
    lines: [
      { label: 'Must have', done: done(roadmap.must), total: roadmap.must.length },
      { label: 'Should have', done: done(roadmap.should), total: roadmap.should.length },
    ],
    seriousBugs,
    capBiting: seriousBugs > 0 && pct >= PROGRESS_CAP,
  };
}

// --- the panels that hang off the spine ------------------------------------

const BUCKET_ORDER: Record<string, number> = { must: 0, should: 1, could: 2, wont: 3 };

/**
 * The top of the run queue: tier first, then bucket, then board order — the
 * same primary sort the queue itself uses (#227). Parked items are left out;
 * they are planned but explicitly not to be picked up.
 */
export function nextUp(roadmap: Roadmap, limit = 3): RoadmapItem[] {
  return flat(roadmap)
    .filter((it) => isPlanned(it) && !it.skipped)
    .sort((a, b) =>
      tierRank(a.tier) - tierRank(b.tier)
      || (BUCKET_ORDER[a.bucket] ?? 4) - (BUCKET_ORDER[b.bucket] ?? 4))
    .slice(0, limit);
}

export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

/** Open bugs by severity, always all four rows so a zero reads as measured. */
export function bugSpread(bugs: Bug[]): { severity: Severity; n: number }[] {
  const open = bugs.filter((b) => b.status !== 'fixed');
  return SEVERITIES.map((severity) => ({
    severity, n: open.filter((b) => b.severity === severity).length,
  }));
}

// --- the cadence strip -----------------------------------------------------

export interface CadenceDay { day: string; n: number }
export interface Cadence {
  days: CadenceDay[];
  peak: number;
  /** Whole days since the last push; null = never pushed. */
  quietFor: number | null;
  /** Nothing has landed in a working week. */
  quiet: boolean;
}

export const QUIET_DAYS = 5;

// `days` comes from the server already zero-filled and UTC-bucketed; an empty
// array means the server did not measure it, which the caller renders as an
// absent strip rather than as a month of silence.
export function readCadence(days: CadenceDay[], lastPushAt: string | null, now = Date.now()): Cadence {
  const quietFor = daysSince(lastPushAt, now);
  return {
    days,
    peak: days.reduce((m, d) => Math.max(m, d.n), 0),
    quietFor,
    quiet: quietFor !== null && quietFor >= QUIET_DAYS,
  };
}

// --- awaiting your verdict -------------------------------------------------

export interface VerdictRow {
  id: number;
  title: string;
  /** What actually landed. '' = the session never wrote one. */
  built: string;
  /** The lane's kind, from the BRANCH NAME. '' = the name doesn't say, which is
   *  not 'feat' — a legacy `auto/item-N` lane records no kind at all (#363). */
  kind: LaneKind | '';
  branch: string;
  /** Whole days since the row last moved; null = it carries no stamp. */
  ageDays: number | null;
  /** Ticked already, so it is waiting on a verdict rather than on a build. */
  ticked: boolean;
}

/**
 * What is built and waiting on a verdict, for THIS project — the same `isBuilt`
 * predicate the spine's Built stage counts, so the list and the number can
 * never disagree.
 *
 * OLDEST FIRST. The design orders by age because that is the actionable order:
 * the row that has waited longest is the one blocking everything behind it, and
 * a newest-first queue hides exactly the change the band exists to surface. A
 * row with no stamp sorts LAST rather than as age zero — unknown is not fresh.
 */
export function verdictQueue(roadmap: Roadmap, limit = 5, now = Date.now()): VerdictRow[] {
  return flat(roadmap)
    .filter(isBuilt)
    .map((it) => ({
      id: it.id,
      title: it.title,
      built: it.builtNote.trim(),
      kind: parseBranch(it.claimedBy).kind,
      branch: it.claimedBy,
      ageDays: daysSince(it.updatedAt, now),
      ticked: it.done,
    }))
    .sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1))
    .slice(0, limit);
}

/** Verdicted and merged, freshest first — the river the verdict queue feeds. */
export function shippedRecently(roadmap: Roadmap, limit = 5, now = Date.now()): VerdictRow[] {
  return flat(roadmap)
    .filter(isLanded)
    .map((it) => ({
      id: it.id,
      title: it.title,
      built: it.builtNote.trim(),
      kind: parseBranch(it.claimedBy).kind,
      branch: it.claimedBy,
      ageDays: daysSince(it.updatedAt, now),
      ticked: true,
    }))
    .sort((a, b) => (a.ageDays ?? Infinity) - (b.ageDays ?? Infinity))
    .slice(0, limit);
}

// --- the headline tiles ----------------------------------------------------

export interface StatTile {
  label: string;
  value: string;
  note: string;
  /** '' = the ordinary ink. Anything else is a semantic token, never a hex. */
  tone: '' | 'live' | 'accent' | 'building';
}

/**
 * The four numbers above the fold. Every one is read off data this page already
 * holds — there is no forecast tile, because forecasting a finish date needs a
 * completion RATE and roadmap rows carry `updatedAt` (movement) and no
 * stage-transition stamp at all. A date computed from "2.4 items a week" would
 * be a number with no source, which is the one thing this tab must not print.
 */
export function overviewStats(
  roadmap: Roadmap, stages: Stage[], pct: number, cadence: CadenceDay[]
): StatTile[] {
  const items = flat(roadmap);
  const landed = items.filter(isLanded);
  const inflight = items.filter(isInFlight);
  const built = stages.find((s) => s.key === 'built');
  const pushes = cadence.reduce((n, d) => n + d.n, 0);

  return [
    {
      label: 'Landed', value: `${landed.length} of ${items.length}`,
      note: items.length ? 'verdicted and merged' : 'nothing on the board yet',
      tone: landed.length > 0 ? 'live' : '',
    },
    {
      label: 'In flight', value: String(inflight.length),
      // Naming them is the point: a bare "2" sends you to Mission Control to
      // find out what it was.
      note: inflight.length
        ? inflight.slice(0, 2).map((i) => i.title).join(' · ')
        : 'nothing claimed right now',
      tone: inflight.length > 0 ? 'accent' : '',
    },
    {
      label: 'Awaiting verdict', value: String(built?.count ?? 0),
      note: built?.lastMovedDays !== null && built?.lastMovedDays !== undefined
        ? `oldest moved ${built.lastMovedDays} day${built.lastMovedDays === 1 ? '' : 's'} ago`
        : 'nothing waiting on you',
      tone: (built?.count ?? 0) > 0 ? 'accent' : '',
    },
    {
      label: 'Progress', value: `${pct}%`,
      // The cadence strip is absent on an older server, and an absent strip
      // must not report zero pushes — say the window instead of a wrong count.
      note: cadence.length ? `${pushes} push${pushes === 1 ? '' : 'es'} in 28 days` : 'weighted Musts and Shoulds',
      tone: '',
    },
  ];
}

// --- the usage band --------------------------------------------------------

/** Tokens as a human reads them: 48.2M, 212K, 900. */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}

export interface UsageBar {
  week: string;
  /** Pixel heights, interactive stacked under auto — the design's two tones. */
  interactiveH: number;
  autoH: number;
  total: number;
  last: boolean;
}

export const USAGE_BAR_MAX = 82;

/**
 * The twelve-week strip. LINEAR, deliberately — unlike the spine's bars and the
 * cadence strip, which are square-rooted so an ordinary day stays visible. Here
 * the comparison IS the magnitude: a week that cost four times another must
 * look four times taller, or the strip stops answering the only question it is
 * asked. A zero week draws nothing at all rather than a stub, because a stub
 * reads as a small amount of spend.
 */
export function usageBars(usage: PulseUsage): UsageBar[] {
  const peak = usage.weeks.reduce((m, w) => Math.max(m, w.interactive + w.auto), 0);
  const h = (n: number) => (peak > 0 && n > 0 ? Math.max(2, Math.round((n / peak) * USAGE_BAR_MAX)) : 0);
  return usage.weeks.map((w, i) => ({
    week: w.week,
    interactiveH: h(w.interactive),
    autoH: h(w.auto),
    total: w.interactive + w.auto,
    last: i === usage.weeks.length - 1,
  }));
}

/** The rows the by-model drill-down shows for one model, newest first. */
export function recentForModel(usage: PulseUsage, model: string, limit = 4) {
  return usage.recent.filter((r) => r.models.includes(model)).slice(0, limit);
}

// --- the schedule: the shape of the plan, read-only -------------------------
//
// The Roadmap tab's Timeline is where a bar is DRAGGED; this is the same plan
// at a glance, on the tab that asks "which way is this project moving". Both
// read `sched`/`baseline` through `lib/plan.ts` — one definition of the minute
// offsets and one of slip, or the two surfaces quietly disagree about the plan.
// This strip has NO zoom: it always draws the whole horizon, which is why its
// domain is the constant and not a viewport.
//
// ONLY TOP-LEVEL ITEMS GET A BAR. A child is a scope line inside a feature, and
// drawing it as its own bar turns one feature into five and makes the strip
// report a project with five times the work in flight.

/** A scheduled feature, as percentages of the track so the lane scales. */
export interface StripBar {
  id: number;
  title: string;
  left: number;
  width: number;
  state: StageKey;
  /** Which stacked row inside the lane this bar sits on (0 = top). */
  row: number;
  /** The baseline it was committed to, when there is one AND it differs. */
  ghost: { left: number; width: number } | null;
}
export interface StripLane { area: string; bars: StripBar[]; rows: number }
export interface ScheduleStrip {
  lanes: StripLane[];
  /** The horizon this strip draws, in minutes — the whole schedulable domain. */
  span: number;
  scheduled: number;
  /** Committed to but never placed on the timeline — the Roadmap tab's tray. */
  unscheduled: number;
}

const stateOf = (it: RoadmapItem): StageKey =>
  (isLanded(it) ? 'landed' : isBuilt(it) ? 'built' : isInFlight(it) ? 'inflight' : 'planned');

/**
 * The area lanes, in board order, holding only the features that are actually
 * scheduled. An UNTAGGED area is its own lane and is labelled as such rather
 * than being folded into the first real one — untagged is a state, and the same
 * carve-out `lanes.js` makes for the claim lanes (#267).
 */
export function scheduleStrip(roadmap: Roadmap, span = SCHED_MINUTES): ScheduleStrip {
  const features = flat(roadmap).filter((it) => it.parentId === null && !it.archived);
  const byArea = new Map<string, RoadmapItem[]>();
  let scheduled = 0;

  for (const it of features) {
    if (!it.sched) continue;
    scheduled += 1;
    const area = it.area.trim() || 'Untagged';
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area)!.push(it);
  }

  const pc = (n: number) => (n / span) * 100;
  const lanes: StripLane[] = [];

  for (const [area, items] of byArea) {
    // First-fit row stacking, in start order — the same idea as layoutLane()'s,
    // minus its label geometry, which needs a pixel width this strip does not
    // have. TWO BARS ON ONE ROW READ AS ONE LONGER BAR, which is the whole
    // claim of a Gantt and the one thing it must not get wrong; a lane that
    // needs two rows gets two.
    const ends: number[] = [];
    const bars: StripBar[] = [];
    for (const it of [...items].sort((a, b) => a.sched!.start - b.sched!.start)) {
      const start = it.sched!.start;
      const len = Math.max(MIN_SCHED_LEN, it.sched!.len);
      // The ghost occupies the row too, or a bar can land on top of another
      // bar's baseline and the two become unreadable.
      const from = it.baseline ? Math.min(start, it.baseline.start) : start;
      const to = it.baseline
        ? Math.max(start + len, it.baseline.start + Math.max(MIN_SCHED_LEN, it.baseline.len))
        : start + len;

      let row = ends.findIndex((end) => end <= from);
      if (row === -1) { row = ends.length; ends.push(to); } else { ends[row] = to; }

      // The ghost is drawn only when the bar has actually MOVED. A ghost sitting
      // exactly under its bar is visual noise that reads as a slip on every row.
      const moved = it.baseline
        && (it.baseline.start !== start || Math.max(MIN_SCHED_LEN, it.baseline.len) !== len);
      bars.push({
        id: it.id,
        title: it.title,
        left: pc(start),
        width: pc(len),
        state: stateOf(it),
        row,
        ghost: moved && it.baseline
          ? { left: pc(it.baseline.start), width: pc(Math.max(MIN_SCHED_LEN, it.baseline.len)) }
          : null,
      });
    }
    lanes.push({ area, bars, rows: Math.max(1, ends.length) });
  }

  return {
    lanes,
    span,
    scheduled,
    unscheduled: features.length - scheduled,
  };
}

// --- in flight: what a feature's scope is made of --------------------------

export interface ScopeSeg { bucket: string; label: string; width: number; weeks: number }
export interface InFlightFeature {
  id: number;
  title: string;
  area: string;
  state: StageKey;
  segs: ScopeSeg[];
  totals: ScopeTotals;
  /** No children at all — the feature was never broken down. */
  unscoped: boolean;
}

const SCOPE_ORDER = ['must', 'should', 'could', 'wont'];
const SCOPE_LABEL: Record<string, string> = {
  must: 'Must', should: 'Should', could: 'Could', wont: "Won't",
};

/**
 * The features being worked on right now, each drawn as the scope committed to
 * it. `scopeTotals` is `lib/plan.ts`'s, so the weeks here and the Scope view's
 * drawer are the same arithmetic — including the rule that an UNSIZED line is
 * counted apart rather than as a free one.
 */
export function inFlightScope(roadmap: Roadmap, limit = 4): InFlightFeature[] {
  const all = flat(roadmap);
  const kids = new Map<number, RoadmapItem[]>();
  for (const it of all) {
    if (it.parentId === null) continue;
    if (!kids.has(it.parentId)) kids.set(it.parentId, []);
    kids.get(it.parentId)!.push(it);
  }

  return all
    .filter((it) => it.parentId === null && !it.archived && (isInFlight(it) || isBuilt(it)))
    .slice(0, limit)
    .map((it) => {
      const children = kids.get(it.id) || [];
      const totals = scopeTotals(children);
      // THE BAR IS THE COMMITTED SCOPE, and nothing else — the same set
      // `scopeTotals.committed` sums, or the bar and the "N wks committed"
      // beside it describe different things. A Won't is out of the feature
      // entirely and a PARKED line has been cut from this cycle; drawing
      // either makes a feature that fits look like one that does not.
      //
      // Widths come off the SIZED lines only: an unsized line has no width to
      // give, and is reported in words beside the bar rather than drawn as
      // though it were zero weeks of work.
      const inBar = children.filter(
        (c) => c.bucket !== 'wont' && !c.skipped && c.estimate !== null);
      const byBucket = SCOPE_ORDER.map((bucket) => ({
        bucket,
        label: SCOPE_LABEL[bucket],
        weeks: inBar
          .filter((c) => c.bucket === bucket)
          .reduce((n, c) => n + (c.estimate ?? 0), 0),
      })).filter((s) => s.weeks > 0);
      const sized = byBucket.reduce((n, s) => n + s.weeks, 0);
      return {
        id: it.id,
        title: it.title,
        area: it.area,
        state: stateOf(it),
        segs: byBucket.map((s) => ({ ...s, width: sized > 0 ? (s.weeks / sized) * 100 : 0 })),
        totals,
        unscoped: children.length === 0,
      };
    });
}

// --- plan vs reality -------------------------------------------------------

export interface SlipRow {
  id: number;
  title: string;
  /** MINUTES later than the baseline start; negative = earlier (#401). */
  min: number;
  /** MINUTES longer than the baseline length. */
  longer: number;
}
export interface PlanVsReality {
  rows: SlipRow[];
  /** Scheduled features carrying NO baseline — not measured, and not on plan. */
  unmeasured: number;
  /** Total MINUTES of slip across everything that IS measured. */
  totalSlip: number;
  measured: number;
}

/**
 * Every scheduled feature whose bar has moved off the baseline it was committed
 * to, worst first. `slipOf` is `lib/plan.ts`'s, and its third state is the one
 * that matters here: `measured: false` means nothing was EVER committed to,
 * which is not "on plan" and is counted separately rather than shown as a zero.
 * Same rule as a NULL review_verdict.
 */
export function planVsReality(roadmap: Roadmap, limit = 6): PlanVsReality {
  const features = flat(roadmap).filter((it) => it.parentId === null && !it.archived && it.sched);
  const rows: SlipRow[] = [];
  let unmeasured = 0;
  let totalSlip = 0;
  let measured = 0;

  for (const it of features) {
    const s = slipOf(it);
    if (!s.measured) { unmeasured += 1; continue; }
    measured += 1;
    const min = s.min ?? 0;
    const longer = s.longer ?? 0;
    if (min !== 0 || longer !== 0) {
      rows.push({ id: it.id, title: it.title, min, longer });
      if (min > 0) totalSlip += min;
    }
  }

  rows.sort((a, b) => (b.min + b.longer) - (a.min + a.longer));
  return { rows: rows.slice(0, limit), unmeasured, totalSlip, measured };
}
