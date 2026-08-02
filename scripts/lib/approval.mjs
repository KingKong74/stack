// Script-side twin of the "approved for the auto runner" rule. The canonical
// copy is server/src/approval.js; the client's is web/src/lib/approval.ts.
// Change one, change all three — each is tested on its own side (this one by
// scripts/approval.test.mjs) because none of the three can import another:
// the host scripts are a separate package from the server, and the browser
// bundle is a separate package again.
//
// Rule: a hook-extracted item needs a human's sign-off in the review inbox
// before the auto runner may pick it up; a manual item is approved the
// moment a human writes it — a manual item is NEVER held, because blocking
// hand-written work is the failure mode this feature must not have.
//
// The scripts only ever see items as they come back from the API, i.e. the
// CLIENT shape: { source: 'hook'|'manual', reviewed: boolean }. There is no
// DB row here to fall back to, unlike the server-side copy.

export function isApproved(item) {
  if (!item) return false; // fail safe: no item, no approval
  const src = String(item.source || 'manual');
  if (src !== 'hook') return true;
  return item.reviewed === true || Boolean(item.reviewed_at);
}

export function approvalHold(item) {
  return isApproved(item)
    ? ''
    : 'auto-found and not yet approved — approve it in the review inbox first';
}
