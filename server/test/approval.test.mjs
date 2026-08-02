// "Approved for the auto runner" — the one rule, tested against both shapes
// it has to work against (a DB row and the client-shaped item), and against
// the SQL fragment that is the same rule inside a WHERE clause.
//
//   node server/test/approval.test.mjs      # exits non-zero on any failure
//
// Pure precisely so this needs no database and no host.
import { isApproved, approvalHold, APPROVED_SQL, partitionApproved } from '../src/approval.js';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ---- isApproved / approvalHold --------------------------------------------

check('a manual item is never held, even unreviewed — the point of this feature',
  isApproved({ source: 'manual', reviewed_at: null }), true);

check('a manual item shaped for the client is never held either',
  isApproved({ source: 'manual', reviewed: false }), true);

check('a hook item with no reviewed_at is not approved (DB shape)',
  isApproved({ source: 'hook', reviewed_at: null }), false);
check('a hook item with reviewed:false is not approved (client shape)',
  isApproved({ source: 'hook', reviewed: false }), false);
check('and approvalHold names the review inbox',
  approvalHold({ source: 'hook', reviewed_at: null }),
  'auto-found and not yet approved — it is in the review inbox');

check('a hook item with a reviewed_at timestamp is approved (DB shape)',
  isApproved({ source: 'hook', reviewed_at: '2026-08-01T00:00:00Z' }), true);
check('and approvalHold is empty for it',
  approvalHold({ source: 'hook', reviewed_at: '2026-08-01T00:00:00Z' }), '');

check('a hook item with reviewed:true is approved (client shape)',
  isApproved({ source: 'hook', reviewed: true }), true);

check('null is not approved (fail safe)', isApproved(null), false);
check('undefined is not approved (fail safe)', isApproved(undefined), false);

// ---- APPROVED_SQL -----------------------------------------------------------

check('APPROVED_SQL produces the expected fragment',
  APPROVED_SQL('ri'), "(ri.source <> 'hook' OR ri.reviewed_at IS NOT NULL)");
check('APPROVED_SQL defaults to alias r',
  APPROVED_SQL(), "(r.source <> 'hook' OR r.reviewed_at IS NOT NULL)");

{
  let threw = false;
  try { APPROVED_SQL('r; DROP TABLE'); } catch { threw = true; }
  check('APPROVED_SQL rejects an alias that is not a plain identifier', threw, true);
}

// ---- partitionApproved -------------------------------------------------------

{
  const items = [
    { id: 1, source: 'manual', reviewed_at: null },
    { id: 2, source: 'hook', reviewed_at: null },
    { id: 3, source: 'hook', reviewed_at: '2026-08-01T00:00:00Z' },
    { id: 4, source: 'hook', reviewed: true },
  ];
  const { approved, held } = partitionApproved(items);
  check('partitionApproved splits a mixed list', [approved.map((i) => i.id), held.map((i) => i.id)],
    [[1, 3, 4], [2]]);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
