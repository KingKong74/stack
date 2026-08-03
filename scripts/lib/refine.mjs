// Autopilot refine-round branch resolution (#274) — shared by stack-autopilot.mjs
// and refine.test.mjs.
//
// A refine round is a DELTA on top of work that already landed, not a fresh
// build: the item carries a `refineNote` because a human looked at what a
// previous session built and sent it back with a correction. Cutting a fresh
// branch off main for that round would either lose the unmerged previous
// round's commits (if the branch is still open) or present the same work
// twice for review (a second branch doing what the first already did). The
// right branch for a refine round is therefore the item's OWN branch,
// continued — never a new one.
//
// A branch missing from origin is not an error: it means the previous round
// was already merged and its branch deleted, so the prior work is on main and
// a fresh branch off main (the runner's ordinary build path) is correct.
import { laneFor, parseBranch } from './lane.mjs';

// Resolves the branch a refine round for `item` should continue.
//
//   item        a roadmap item ({ id, title, ... })
//   remoteHeads short branch names as `git ls-remote --heads origin` reports
//               them (no `refs/heads/` prefix)
//
// Returns the branch name, or null when nothing on origin belongs to this
// item (merged-and-deleted — build fresh off main instead).
// Is `item` mid a refine round right now?
//
// `refine_note` is only cleared when the item is ticked `done:true` (see
// CLAUDE.md's data rules) — so "carries a refine note" is a durable marker,
// not a snapshot of how this particular session got started. It means: a
// human looked at what landed, was not satisfied, and sent it back; that
// round is not closed until a human ticks it. It is deliberately independent
// of the session KIND — an item with a pending refine note is a refine round
// no matter which kind of session happened to build it this time, and any
// guard built on this predicate must hold on all of them, not just sessions
// launched with `--kind refine`.
export function isRefineRound(item) {
  return typeof item?.refineNote === 'string' && item.refineNote.trim().length > 0;
}

// The #212 risk-tiered auto-merge gate, as a pure predicate so its truth
// table can be pinned directly rather than re-derived from log lines.
// Every gate is POSITIVE evidence; anything absent (no checks, no review,
// no verdict) means NO auto-merge. A refine round is excluded outright
// (#274): it is by definition work a human already looked at and sent
// back, so merging it unattended would discard the very judgement the
// send-back asked for — no matter how green the run looks this time.
export function autoMergeAllowed({ risk, limitHit, checksRan, checksFailing, reviewClean, item }) {
  if ((risk || 'normal') !== 'low') return false;
  if (limitHit) return false;
  if (isRefineRound(item)) return false;
  const checksGreen = checksRan > 0 && checksFailing === 0;
  return checksGreen && !!reviewClean;
}

export function refineTargetBranch(item, remoteHeads) {
  const heads = Array.isArray(remoteHeads) ? remoteHeads : [];
  const id = Number(item?.id);

  // 1. The exact name this item's branch would have TODAY — the common case,
  // and the one that needs no parsing at all.
  const current = laneFor(item);
  if (heads.includes(current)) return current;

  // 2. Any head whose parsed itemId matches — covers a retitled item (the
  // slug moved, so the exact name no longer matches) and a legacy
  // `auto/item-<id>-…` branch cut before #363. `bugKey` must be empty: a
  // debug lane for BUG-274 must never be mistaken for roadmap item 274, and
  // comparing on the PARSED itemId (never a string prefix test) is what keeps
  // item 274 from matching feat/2740-… or fix/bug-274-….
  const candidates = heads.filter((name) => {
    const p = parseBranch(name);
    return p.itemId === id && !p.bugKey;
  });
  if (candidates.length === 0) return null;

  // Deterministic even when git lists heads in a different order each time:
  // a current-scheme branch is more recent than a legacy one, so it sorts
  // first; ties break lexicographically.
  candidates.sort((a, b) => {
    const pa = parseBranch(a);
    const pb = parseBranch(b);
    if (pa.legacy !== pb.legacy) return pa.legacy ? 1 : -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return candidates[0];
}
