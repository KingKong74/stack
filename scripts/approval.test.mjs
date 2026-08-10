#!/usr/bin/env node
// Tests for the script-side "approved for the auto runner" twin.
// Run: node scripts/approval.test.mjs
//
// Pure precisely so this needs no database and no host.
import { isApproved, approvalHold } from './lib/approval.mjs';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ---- isApproved -------------------------------------------------------------

check('a manual item is never held, even unreviewed — the point of this feature',
  isApproved({ source: 'manual', reviewed: false }), true);

check('a hook item that is unreviewed is NOT approved',
  isApproved({ source: 'hook', reviewed: false }), false);

check('a hook item that has been reviewed IS approved',
  isApproved({ source: 'hook', reviewed: true }), true);

check('a missing source defaults to manual, so it IS approved',
  isApproved({ reviewed: false }), true);

check('null is not approved (fail safe)', isApproved(null), false);
check('undefined is not approved (fail safe)', isApproved(undefined), false);

// ---- #381: a fly item is held on the same footing as a hook item ------------
// The card a session opens for its own work is one API call away from being
// tonight's build. The sign-off is the only thing between those two states.

check('a fly item that is unsigned is NOT approved',
  isApproved({ source: 'fly', reviewed: false }), false);

check('a fly item that has been signed off IS approved',
  isApproved({ source: 'fly', reviewed: true }), true);

check('a fly item is held on reviewed_at too, not just the client shape',
  isApproved({ source: 'fly', reviewed_at: '2026-08-10T00:00:00Z' }), true);

check('an unknown source is NOT held — only hook and fly are',
  isApproved({ source: 'imported', reviewed: false }), true);

// ---- approvalHold -------------------------------------------------------------

check('approvalHold is empty for an approved item',
  approvalHold({ source: 'manual', reviewed: false }), '');

check('approvalHold names the review inbox for a held item',
  approvalHold({ source: 'hook', reviewed: false }),
  'auto-found and not yet approved — approve it in the review inbox first');

check('approvalHold says SESSION for a fly item, not "auto-found" (#381)',
  approvalHold({ source: 'fly', reviewed: false }),
  'opened by a live session and not yet approved — approve it in the review inbox first');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
