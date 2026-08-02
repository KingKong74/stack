// #265 — N parallel workers instead of one global lane.
//
// This is the whole parallel-dispatch invariant, pulled into one pure module
// precisely because it has to hold in more than one runtime: the SQL claim in
// routes/autopilot.js's GET /next, the host dispatcher (which may one day
// poll ahead of a claim to decide what's even worth asking for) and any
// future Plan-room mirror that wants to show "would this run tonight?"
// without touching the database. Spelling the rule twice is how it drifts —
// see #267's lanes.js for the pattern this follows. No database, no imports
// from the rest of the server: everything this module needs arrives as
// plain arguments.
//
// A job row is at least { id, projectId, itemId, kind, status }. kind is one
// of manual | nightly | scheduled | revert | resume | plan | merge.
// itemId is null (or undefined — treated identically) unless the job is
// pinned to one roadmap item.

const MERGE_SERIAL_KINDS = new Set(['merge', 'revert']);

// Workers is a configured lane count: not finite or < 1 -> 1; > 4 -> 4.
export function cleanWorkers(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 4) return 4;
  return Math.trunc(n);
}

const sameProject = (a, b) => String(a.projectId) === String(b.projectId);
const sameItem = (a, b) => a != null && b != null && String(a) === String(b);

// canClaim(candidate, inFlight, workers) -> null (claimable) | short reason.
// inFlight is the array of jobs currently claimed or running. Gates run in
// order and each has its own reason string.
export function canClaim(candidate, inFlight, workers) {
  const n = cleanWorkers(workers);

  // 1. DECK FULL — every lane already holds a job.
  if (inFlight.length >= n) return `all ${n} lanes busy`;

  // 2. MAIN IS SERIAL — a merge/revert in flight touches main; nothing else
  // may start alongside it, in any project.
  if (inFlight.some((o) => MERGE_SERIAL_KINDS.has(o.kind))) {
    return 'a merge/revert is in flight';
  }

  // 3. MAIN IS SERIAL, the other way — a merge/revert candidate only starts
  // on an empty deck. Merges and reverts stay strictly serialised against
  // everything, including each other.
  if (MERGE_SERIAL_KINDS.has(candidate.kind) && inFlight.length !== 0) {
    return 'merge/revert waits for an empty deck';
  }

  // 4. PER-PROJECT — two jobs in the same project may only run side by side
  // when BOTH are pinned to items and those items differ. An unpinned job
  // (a nightly, a plan sweep, an audit) picks its items dynamically from the
  // board, so it would race any other job in the same repo for claims and
  // worktrees; two jobs pinned to the same item would fight over one
  // worktree and one branch.
  for (const o of inFlight) {
    if (!sameProject(o, candidate)) continue;
    if (o.itemId == null || candidate.itemId == null) {
      return 'project already has a job in flight';
    }
    if (sameItem(o.itemId, candidate.itemId)) {
      return 'that item is already running';
    }
  }

  return null;
}

// pickClaimable(queued, inFlight, workers) -> { job, reasons }
// Walks queued IN THE ORDER GIVEN (the caller has already applied the
// rotation ordering) and returns the first job whose canClaim is null. A
// blocked job is stepped over and reported in `reasons`, exactly like #267's
// claim guard — there is no second queue.
export function pickClaimable(queued, inFlight, workers) {
  const reasons = [];
  for (const job of queued) {
    const reason = canClaim(job, inFlight, workers);
    if (reason == null) return { job, reasons };
    reasons.push({ id: job.id, reason });
  }
  return { job: null, reasons };
}
