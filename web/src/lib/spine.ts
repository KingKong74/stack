// The Overview tab's PROGRESSION SPINE (design 4a) — pure derivation, no
// network, no React. Turns a project's own collections into the five stages a
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
//  • BUILT is the Review room's own queue predicate (#374) — `done` OR
//    (`builtNote` non-empty AND `claimedBy` non-empty), with no verdict yet.
//    NOT `done && !reviewTag`: nothing in Stack ticks an item, so that spelling
//    draws an empty stage over a full night's work. If `routes/review.js` ever
//    changes its predicate, this changes with it or the spine's Built count
//    stops agreeing with the room it links to.
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
// The four roadmap stages partition the board exactly — every row is in one and
// only one — which is what lets the spine's counts be added up and trusted.
//
// WHAT IS DELIBERATELY NOT HERE: a flow rate per hand-off. The design draws a
// throughput figure between each pair of stages, and Stack cannot honestly
// supply one — roadmap rows carry `updatedAt` (MOVEMENT, per CLAUDE.md) and no
// stage-transition stamp at all, so "9 promoted to Planned last week" would be
// a number with no source. `lastMovedDays` below is the one honest thing the
// data does support: how long the queue in a stage has sat untouched. Absent is
// not zero — the same rule as a NULL `review_verdict`.

import type { Bug, Future, Roadmap, RoadmapItem, Severity } from '../types';
import { hrefTo } from './route';
import { tierRank } from '../types';

export type StageKey = 'idea' | 'planned' | 'inflight' | 'built' | 'landed';

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

/** The Review room's queue predicate (#374), kept in one place on the client. */
export const isBuilt = (it: RoadmapItem): boolean =>
  (it.done || (it.builtNote.trim() !== '' && it.claimedBy.trim() !== '')) && it.reviewTag === '';

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
 * The five stages, in order. `blocked` marks at most ONE stage — the deepest
 * queue that is also standing still — because a spine that flags three
 * bottlenecks has told you nothing about where to go first.
 */
export function buildSpine(
  roadmap: Roadmap, futures: Future[], slug: string, now = Date.now()
): Stage[] {
  const items = flat(roadmap);
  const planned = items.filter(isPlanned);
  const inflight = items.filter(isInFlight);
  const built = items.filter(isBuilt);
  const landed = items.filter(isLanded);

  const stages: Stage[] = [
    {
      key: 'idea', label: 'Idea', sub: 'directional, uncommitted',
      count: futures.length,
      href: hrefTo.detail(slug, 'futures'), hrefLabel: 'Polaris',
      blocked: false, lastMovedDays: null,
    },
    {
      key: 'planned', label: 'Planned', sub: 'open, unclaimed',
      count: planned.length,
      href: hrefTo.detail(slug, 'roadmap'), hrefLabel: 'Roadmap',
      blocked: false, lastMovedDays: lastMoved(planned, now),
    },
    {
      key: 'inflight', label: 'In flight', sub: 'claimed right now',
      count: inflight.length,
      href: hrefTo.control('now'), hrefLabel: 'Mission Control',
      blocked: false, lastMovedDays: lastMoved(inflight, now),
    },
    {
      key: 'built', label: 'Built', sub: 'awaiting your verdict',
      count: built.length,
      href: hrefTo.control('review'), hrefLabel: 'Review',
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
    if (s.key === 'landed' || s.key === 'idea') continue;
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
