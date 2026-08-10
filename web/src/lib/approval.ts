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
