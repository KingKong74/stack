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

// ---- approvalHold -------------------------------------------------------------

check('approvalHold is empty for an approved item',
  approvalHold({ source: 'manual', reviewed: false }), '');

check('approvalHold names the review inbox for a held item',
  approvalHold({ source: 'hook', reviewed: false }),
  'auto-found and not yet approved — approve it in the review inbox first');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
