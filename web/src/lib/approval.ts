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
// NOTHING IN THIS CLIENT CALLS IT AT THE MOMENT. Its caller was the Roadmap
// tab, which sorted a held row into Thinking and drew it a HELD chip; that tab
// is a mockup now (detail/IdeasMock.tsx). Deleting this file would leave the
// rule written twice instead of three times — and the three exist because none
// of the packages can import another, not because three surfaces wanted it. It
// stays, `scripts/approval.test.mjs` keeps it honest, and the next client that
// has to know whether a row may run reads it rather than writing a fourth.

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
