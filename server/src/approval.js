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
