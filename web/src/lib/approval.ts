import type { RoadmapItem } from '../types';

// Client copy of the "approved for the auto runner" rule. The canonical
// definition is server/src/approval.js; the script-side twin is
// scripts/lib/approval.mjs. Change one, change all three.
//
// Rule: an item nobody typed needs a human's sign-off (the client-shaped
// `reviewed: true`) before the auto runner may pick it up — 'hook' (read off a
// push by the extractor) and 'fly' (#381, opened by a live Claude session for
// its own work). A manual item is approved the moment a human writes it, and is
// NEVER held, because blocking hand-written work is the failure mode this
// feature must not have.
//
// FOR YOU'S AUTO-IDEAS PANE IS ITS CALLER (#496, via `homeOf` in lib/plan.ts).
// A held row is not merely flagged there — it is the whole reason the pane
// exists: an unsigned `hook` or `fly` row that NOBODY HAS WORKED is a session's
// own idea, so it is drawn there and kept off BOTH planning screens, and the
// pane's two promotions are what sign it off. Being held is not by itself an
// answer to WHICH SCREEN — a held row a session has claimed or built is
// committed work, drawn on the board, and held from the runner all the same;
// `homeOf` owns that line and this file does not. (#472 had these rows on the
// Roadmap tab; #496 moved them once the Keep/Promote split existed.)
// The rule is written
// three times (`server/src/`, `scripts/lib/`, here) because none of the three
// packages can import another; `scripts/approval.test.mjs` keeps them honest.

const NEEDS_SIGNOFF = new Set(['hook', 'fly']);

type Approvable = Pick<RoadmapItem, 'source' | 'reviewed'>;

// NO ITEM, NO APPROVAL — the same fail-safe direction both host twins take, and
// the one place this copy had drifted from them: it read `it.source` off the
// argument unguarded, so a null threw a TypeError where the others answered
// `false`. Nothing passes one today; it is the FAIL-SAFE DIRECTION that had
// gone, and a rule about what the overnight fleet may build does not get to
// have one of its three copies crash instead of refusing.
export function isApproved(it: Approvable | null | undefined): boolean {
  if (!it) return false;
  const src = String(it.source || 'manual');
  if (!NEEDS_SIGNOFF.has(src)) return true;
  // `reviewed` ALONE, deliberately, where the host twins also accept a raw
  // `reviewed_at`: the client never sees a DB row — shape.js renders it to a
  // boolean first. A narrowing, not a disagreement, and safe in one direction
  // only: handed a raw row this reports HELD, which errs toward refusing to run
  // rather than toward running something unsigned. `scripts/approval.test.mjs`
  // pins both halves of that against all three copies.
  return it.reviewed === true;
}

// The inverse — an auto-found item still awaiting approval, i.e. still
// sitting in the review inbox.
export function isHeld(it: Approvable | null | undefined): boolean {
  return !isApproved(it);
}
