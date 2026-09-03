// The auto-verdict gate (#263) — a low-risk overnight run that is green on
// every signal may set its own review_tag. Pure, no DB: every gate is
// positive evidence and an ABSENT signal must never read as a green one.
//
//   node server/test/auto-verdict.test.mjs      # exits non-zero on any failure
import { declaredFiles, unconfined, autoVerdict } from '../../scripts/lib/autoverdict.mjs';

let total = 0;
let fails = 0;
const check = (name, got, want) => {
  total++;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond) => check(name, !!cond, true);

// ---- the happy path ---------------------------------------------------

{
  const ev = {
    risk: 'low', limitHit: false, refineRound: false,
    checksRan: 7, checksFailing: 0,
    reviewBugs: 0,
    changed: ['server/src/routes/roadmap.js', 'web/src/detail/BoardMock.tsx',
      'server/src/schema.sql', 'web/src/lib/route.ts'],
    declared: ['server/src', 'web/src'],
  };
  const v = autoVerdict(ev);
  check('happy path fires', v.ok, true);
  check('happy path leaves no missing reasons', v.missing, []);
  ok('evidence mentions the check count', v.evidence.includes('7 check(s) green'));
  ok('evidence mentions the reviewer is clean', v.evidence.includes('reviewer clean (0 bugs)'));
  ok('evidence mentions the file coverage', v.evidence.includes('4 file(s), all within the 2 declared'));
}

const base = () => ({
  risk: 'low', limitHit: false, refineRound: false,
  checksRan: 3, checksFailing: 0,
  reviewBugs: 0,
  changed: ['server/src/routes/roadmap.js'],
  declared: ['server/src'],
});

// ---- risk -----------------------------------------------------------------

{
  const v = autoVerdict({ ...base(), risk: 'normal' });
  check('normal risk does not fire', v.ok, false);
  ok('names the risk', v.missing.some((m) => m.includes('not low risk (normal)')));
}
{
  const v = autoVerdict({ ...base(), risk: 'high' });
  check('high risk does not fire', v.ok, false);
  ok('names the risk', v.missing.some((m) => m.includes('not low risk (high)')));
}

// ---- limit / refine ---------------------------------------------------

{
  const v = autoVerdict({ ...base(), limitHit: true });
  check('limit-hit run does not fire', v.ok, false);
  ok('says the run hit its limit', v.missing.includes('the run hit its limit'));
}
{
  const v = autoVerdict({ ...base(), refineRound: true });
  check('refine round does not fire', v.ok, false);
  ok('says this is a refine round', v.missing.includes('this is a refine round'));
}

// ---- checks -----------------------------------------------------------

{
  const v = autoVerdict({ ...base(), checksRan: 0, checksFailing: 0 });
  check('zero checks ran does not fire', v.ok, false);
  ok('zero checks ran is NOT the same as green', v.missing.includes('no checks ran'));
}
{
  const v = autoVerdict({ ...base(), checksFailing: 2 });
  check('a failing check does not fire', v.ok, false);
  ok('names the failing count', v.missing.includes('2 check(s) failing'));
}
{
  const v = autoVerdict({ ...base(), checksFailing: null });
  check('unknown check results do not fire', v.ok, false);
  ok('says check results unknown', v.missing.includes('check results unknown'));
}

// ---- reviewer -----------------------------------------------------------

{
  const v = autoVerdict({ ...base(), reviewBugs: null });
  check('a missing reviewer verdict does not fire', v.ok, false);
  ok('says no reviewer verdict', v.missing.includes('no reviewer verdict'));
}
{
  const v = autoVerdict({ ...base(), reviewBugs: 0 });
  check('a 0-bug verdict does fire', v.ok, true);
}
{
  const v = autoVerdict({ ...base(), reviewBugs: 3 });
  check('a verdict with bugs does not fire', v.ok, false);
  ok('names the bug count', v.missing.includes('the reviewer flagged 3 bug(s)'));
}

// ---- declaration / coverage --------------------------------------------

{
  const v = autoVerdict({ ...base(), changed: [] });
  check('nothing changed does not fire', v.ok, false);
  ok('says nothing changed', v.missing.includes('nothing changed'));
}
{
  const v = autoVerdict({ ...base(), declared: [] });
  check('no declared files does not fire', v.ok, false);
  ok('says the item declares no files', v.missing.includes('the item declares no files'));
}
{
  const v = autoVerdict({
    ...base(),
    changed: ['server/src/routes/roadmap.js', 'web/src/lib/route.ts'],
    declared: ['server/src'],
  });
  check('a diff touching a file outside the declaration does not fire', v.ok, false);
  ok('names the stray file', v.missing.some((m) => m.includes('web/src/lib/route.ts')));
}

// ---- directory coverage vs sibling-prefix ---------------------------------

check('a directory declaration covers a file beneath it',
  unconfined(['web/src/detail/BoardMock.tsx'], ['web/src']), []);
check('a sibling directory sharing a prefix is NOT covered',
  unconfined(['web/src2/x.ts'], ['web/src']), ['web/src2/x.ts']);

// ---- declaredFiles ------------------------------------------------------

{
  const text = 'Interfaces: server/src/routes/roadmap.js (PATCH), web/src/detail/BoardMock.tsx';
  check('declaredFiles pulls both paths and skips the rest',
    declaredFiles(text),
    ['server/src/routes/roadmap.js', 'web/src/detail/BoardMock.tsx']);
}
check('declaredFiles ignores bare words and bare basenames',
  declaredFiles('touches roadmap.js and the schema, mostly prose'), []);
check('declaredFiles de-dupes and strips trailing punctuation/backticks',
  declaredFiles('`server/src/schema.sql`, then again server/src/schema.sql.'),
  ['server/src/schema.sql']);
check('declaredFiles strips a trailing slash',
  declaredFiles('touches web/src/ broadly'), ['web/src']);

console.log(fails === 0 ? `\n✓ auto-verdict: ${total} checks passed` : `\n${fails}/${total} FAILED`);
process.exit(fails === 0 ? 0 : 1);
