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
// THE ROADMAP TAB IS ITS CALLER AGAIN (#472, via `isIdea` in lib/plan.ts).
// A held row is not merely flagged there — it is the whole reason the tab
// exists: an unsigned `hook` or `fly` row that NOBODY HAS WORKED is an IDEA, so
// it is drawn on Roadmap and kept off the board, and Promote is what signs it
// off. Being held is not by itself an answer to WHICH SCREEN — a held row a
// session has claimed or built is committed work, drawn on the board, and held
// from the runner all the same; `isIdea` owns that line and this file does not.
// The rule is written
// three times (`server/src/`, `scripts/lib/`, here) because none of the three
// packages can import another; `scripts/approval.test.mjs` keeps them honest.

const NEEDS_SIGNOFF = new Set(['hook', 'fly']);

type Approvable = Pick<RoadmapItem, 'source' | 'reviewed'>;

export function isApproved(it: Approvable): boolean {
  const src = String(it.source || 'manual');
  if (!NEEDS_SIGNOFF.has(src)) return true;
  return it.reviewed === true;
}

// The inverse — an auto-found item still awaiting approval, i.e. still
// sitting in the review inbox.
export function isHeld(it: Approvable): boolean {
  return !isApproved(it);
}
