// Canonical server-side definition of "approved for the auto runner". This is
// the ONE place the rule is spelt out on this side; the script-side twin is
// scripts/lib/approval.mjs and the client's is web/src/lib/approval.ts (both
// land in later commits — it is fine that they do not exist yet).
//
// Rule: a hook-extracted item needs a human's sign-off (reviewed_at set, or
// the client-shaped `reviewed: true`) before the auto runner may pick it up;
// a manual item is approved the moment a human writes it — a manual item is
// NEVER held, because blocking hand-written work is the failure mode this
// feature must not have.
//
// Works against either shape: a DB row ({ source, reviewed_at }) or a
// client-shaped item ({ source, reviewed }).

// roadmap_items.source defaults to 'manual' at the column level, so a missing
// source is treated the same way here.
export function isApproved(item) {
  if (!item) return false; // fail safe: no item, no approval
  const src = String(item.source || 'manual');
  if (src !== 'hook') return true;
  return Boolean(item.reviewed_at) || item.reviewed === true;
}

export function approvalHold(item) {
  return isApproved(item) ? '' : 'auto-found and not yet approved — it is in the review inbox';
}

// SQL fragment for use inside a WHERE clause. `alias` is interpolated
// directly into the query, so it is guarded against anything but a plain
// identifier.
export function APPROVED_SQL(alias = 'r') {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`APPROVED_SQL: invalid alias ${JSON.stringify(alias)}`);
  }
  return `(${alias}.source <> 'hook' OR ${alias}.reviewed_at IS NOT NULL)`;
}

// Splits a list into { approved, held }, preserving order — used by the
// enqueue gates.
export function partitionApproved(items) {
  const approved = [];
  const held = [];
  for (const it of items) {
    (isApproved(it) ? approved : held).push(it);
  }
  return { approved, held };
}

// ---------------------------------------------------------------------------
// The two enqueue gates, decided purely.
//
// routes/autopilot.js gates two queues that both pin an `item_id` and/or carry
// roadmap ids in an `agenda`: GET /next's scheduled enqueue and POST /start's
// Run now. The route does the lookup — one query, ids → rows — and hands the
// map in here; the DECIDING lives here, with no database in it, so both queues
// can be tested both ways (held work filtered out, manual + approved work still
// runs). That is the whole reason this half is separated from its caller.
//
// Everything below shares four rules:
//   · a pinned id that is held blocks the WHOLE request — the agenda never
//     gets a look-in;
//   · a non-numeric agenda entry is a bug key ('BUG-7'), not a roadmap item,
//     so it carries no approval gate and always passes, in place and in order;
//   · an agenda whose roadmap ids are ALL held is a held request, but an
//     agenda with survivors runs its survivors;
//   · an id that does not come back from the lookup at all (wrong project,
//     deleted since it was scheduled) is HELD, on the same fail-safe footing
//     as one that comes back explicitly unapproved.
//
// What differs is only what the caller does about it, and that difference is
// the point: the scheduled enqueue has nobody watching, so it drops silently;
// Run now has a human at the button, so it must refuse out loud.

// The roadmap ids a request puts in play. Empty = nothing to gate, which is
// the common case (a plain Run now with no itemId and no agenda) and must not
// pay for the lookup query, let alone be held.
export function roadmapIdsIn(itemId, agenda) {
  const agendaIds = (Array.isArray(agenda) ? agenda : [])
    .map(Number).filter((n) => Number.isFinite(n));
  const pinned = itemId == null ? [] : [Number(itemId)];
  return [...new Set([...pinned, ...agendaIds])];
}

// Shared decision. `byId` is a Map of roadmap id → row ({ id, source,
// reviewed_at, title }).
function decide(itemId, agenda, byId) {
  const agendaList = Array.isArray(agenda) ? agenda : [];
  const agendaIds = agendaList.map(Number).filter((n) => Number.isFinite(n));
  const okId = (id) => {
    const row = byId?.get(id);
    return row ? isApproved(row) : false; // not found at all = held, fail safe
  };
  const pinned = itemId == null ? null : Number(itemId);
  const filtered = agendaList.filter((a) => {
    const n = Number(a);
    return !Number.isFinite(n) || okId(n); // bug keys always pass
  });
  const survivors = filtered.filter((a) => Number.isFinite(Number(a))).length;
  return {
    pinned,
    pinnedHeld: pinned !== null && !okId(pinned),
    agendaIds,
    agenda: filtered,
    agendaHeld: agendaIds.length > 0 && survivors === 0,
  };
}

// The unattended gate (GET /next). Returns { held: true } when the caller must
// skip the INSERT — it still stamps/retires the schedule row, so a held
// schedule doesn't spin the dispatcher every minute for the rest of its
// window. Otherwise { agenda }, filtered down to the approved roadmap ids.
export function scheduleGate(itemId, agenda, byId) {
  const d = decide(itemId, agenda, byId);
  if (d.pinnedHeld || d.agendaHeld) return { held: true };
  return { agenda: d.agenda };
}

// The refuse-out-loud gate (POST /start). `held` is every roadmap id that
// blocks the request, each with the words to say about it; empty when nothing
// does. `agenda` is what would run.
export function startGate(itemId, agenda, byId) {
  const d = decide(itemId, agenda, byId);
  const describe = (id) => {
    const row = byId?.get(id);
    if (!row) return { id, title: '', reason: `#${id} is not an item on this project.` };
    return { id, title: row.title || '', reason: `#${id} "${row.title || ''}" is ${approvalHold(row)}.` };
  };
  if (d.pinnedHeld) return { held: [describe(d.pinned)], agenda: d.agenda };
  if (d.agendaHeld) return { held: d.agendaIds.map(describe), agenda: d.agenda };
  return { held: [], agenda: d.agenda };
}
