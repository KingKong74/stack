// Folding one PATCHed roadmap item back into a loaded Roadmap, without a refetch.
//
// Mission Control's Plan room projects "Tonight" from the project details it
// already holds. When you accept something out of the inbox, the PATCH lands
// server-side but those details are a SNAPSHOT — so the item stayed unapproved
// in the copy the projection reads, and the row vanished from the inbox without
// ever appearing in the queue. It came back on the next page load, which read
// as the accept having silently failed.
//
// These two functions are the whole of that fix, kept pure and out of the
// component because the case that goes wrong is not the obvious one: an accept
// may RECATEGORISE at the same time (the inbox's own bucket picker), so the
// item can have to leave one bucket and join another in a single write. Drop it
// from every bucket first and re-add by the updated item's OWN bucket — a
// same-bucket update then falls out as the degenerate case rather than needing
// its own branch.
//
//   node web/test/roadmap-patch.test.mts

import type { Roadmap, RoadmapItem, Priority } from '../types';

export const BUCKET_KEYS: readonly Priority[] = ['must', 'should', 'could', 'wont'];

// Replace (or move) an item. The caller passes the row the SERVER returned, so
// the projection can never drift from what actually landed.
//
// Position within the bucket: the item is appended rather than restored to
// where it was. The Plan room sorts its own queue (tier, then bucket, then
// position), so appending never decides the order — and an item arriving from
// the inbox has no meaningful place in a list it was not previously part of.
export function applyRoadmapItem(roadmap: Roadmap, updated: RoadmapItem): Roadmap {
  const next: Roadmap = { ...roadmap };
  for (const b of BUCKET_KEYS) next[b] = next[b].filter((it) => it.id !== updated.id);
  next[updated.bucket] = [...next[updated.bucket], updated];
  return next;
}

// Drop an item entirely — the dismiss path, where the server no longer has it.
export function removeRoadmapItem(roadmap: Roadmap, id: number): Roadmap {
  const next: Roadmap = { ...roadmap };
  for (const b of BUCKET_KEYS) next[b] = next[b].filter((it) => it.id !== id);
  return next;
}
