import type { RoadmapItem } from '../types';

// Client copy of the "approved for the auto runner" rule. The canonical
// definition is server/src/approval.js; the script-side twin is
// scripts/lib/approval.mjs. Change one, change all three.
//
// Rule: a hook-extracted item needs a human's sign-off (the client-shaped
// `reviewed: true`) before the auto runner may pick it up; a manual item is
// approved the moment a human writes it — a manual item is NEVER held,
// because blocking hand-written work is the failure mode this feature must
// not have.

type Approvable = Pick<RoadmapItem, 'source' | 'reviewed'>;

export function isApproved(it: Approvable): boolean {
  const src = String(it.source || 'manual');
  if (src !== 'hook') return true;
  return it.reviewed === true;
}

// The inverse — an auto-found item still awaiting approval, i.e. still
// sitting in the review inbox.
export function isHeld(it: Approvable): boolean {
  return !isApproved(it);
}
