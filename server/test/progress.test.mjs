#!/usr/bin/env node
// THE PROGRESS MODEL — `util.computeProgress`, the single definition of "how
// done is a project".
//
//   node server/test/progress.test.mjs      # exits non-zero on any failure
//
// Pure: no database, no API, no host.
//
// WHY IT EARNS A TEST. This one function is the number on the Dashboard's
// "Progress by app" panel, on every project card and in the public showcase —
// the most-looked-at number the app produces, and until now the only derivation
// of its size with nothing pinning it. Its header says it is deliberately
// tweakable ("tune the weights or the cap here and everywhere reflects it"),
// which is exactly the kind of function that gets tuned by somebody who has not
// read the two rules that are not arithmetic:
//
//   • CAPPED AT 90% WHILE ANY CRITICAL OR HIGH BUG IS OPEN. The cap is the
//     whole reason the number is honest: a project can be feature-complete and
//     broken, and 100% over an open critical bug is a lie the owner would act
//     on. It is NOT a health score — that is said in CLAUDE.md — but this one
//     clamp is where the two ideas touch.
//   • 0% WITH NO HIGHEST/HIGH ITEMS AT ALL. Not 100%: an empty plan has not
//     been finished, it has not been made. Dividing by a zero total and
//     rendering NaN, or short-circuiting to 100, are both one line away.
//
// And the one #469 left behind on purpose: `medium` — the level MoSCoW never
// had — does NOT move the bar. Weighting all five is a defensible change and a
// DIFFERENT one; it moves every number on every dashboard and must not be
// smuggled in under a rename. A test is what makes that a decision rather than
// an accident.
//
// VALIDATED BY MUTATION. Six regressions were introduced into util.js on
// purpose and this file run against each:
//
//   the cap becomes a floor (Math.min → Math.max)  → 6 fails
//   an empty plan returns 100 instead of 0         → 3 fails
//   `medium` starts counting                       → 3 fails
//   `highest` stops counting double                → 4 fails
//   a FIXED serious bug still caps                 → 1 fail
//   every bug but `low` counts as serious          → 1 fail
import { computeProgress } from '../src/util.js';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const item = (bucket, done = false) => ({ bucket, done });
const bug = (severity, status = 'open') => ({ severity, status });

// ---- the weighting ---------------------------------------------------------

check('nothing done is 0%', computeProgress([item('highest'), item('high')], []), 0);
check('everything done is 100%',
  computeProgress([item('highest', true), item('high', true)], []), 100);

check('a done HIGHEST counts double a done HIGH',
  // weight 2 of 3 done = 67, not 50: the two items are not equal.
  computeProgress([item('highest', true), item('high', false)], []), 67);
check('…and the other way round is the third that is left',
  computeProgress([item('highest', false), item('high', true)], []), 33);

check('the result is a rounded integer, never a float',
  computeProgress([item('high', true), item('high'), item('high')], []), 33);

// ---- what does NOT move the bar (#469) -------------------------------------

check('MEDIUM does not move the bar — the level MoSCoW never had',
  computeProgress([item('high', true), item('medium', false)], []), 100);
check('nor does low', computeProgress([item('high', true), item('low', false)], []), 100);
check('nor does lowest', computeProgress([item('high', true), item('lowest', false)], []), 100);
check('a DONE medium does not move it either — it is out of the sum entirely',
  computeProgress([item('high', false), item('medium', true)], []), 0);

check('an unknown bucket is ignored rather than counted or crashed on',
  computeProgress([item('high', true), item('must', true), item(''), item(null)], []), 100);

// ---- 0% WITH NO HIGHEST/HIGH ITEMS -----------------------------------------

check('an empty board is 0%, not 100% and not NaN', computeProgress([], []), 0);
check('a board of nothing but medium/low is 0%, however much of it is done',
  computeProgress([item('medium', true), item('low', true), item('lowest', true)], []), 0);
check('…and that is true with bugs open too — no division by zero anywhere',
  computeProgress([item('low', true)], [bug('critical')]), 0);

// ---- THE 90% CAP -----------------------------------------------------------

check('100% with a CRITICAL bug open is capped at 90',
  computeProgress([item('high', true)], [bug('critical')]), 90);
check('100% with a HIGH bug open is capped at 90',
  computeProgress([item('high', true)], [bug('high')]), 90);

check('a medium bug does not cap — only critical and high are serious',
  computeProgress([item('high', true)], [bug('medium')]), 100);
check('nor does a low bug', computeProgress([item('high', true)], [bug('low')]), 100);

check('a FIXED critical bug does not cap — it is not open any more',
  computeProgress([item('high', true)], [bug('critical', 'fixed')]), 100);
check('but investigating and fixing are still OPEN, and still cap',
  [computeProgress([item('high', true)], [bug('critical', 'investigating')]),
   computeProgress([item('high', true)], [bug('critical', 'fixing')])], [90, 90]);

check('THE CAP IS A CEILING, NOT A FLOOR — it never raises a low number',
  computeProgress([item('high', true), item('high'), item('high'), item('high')], [bug('critical')]), 25);
check('a number already at the cap is unchanged by it',
  // 9 of 10 weight done = 90 exactly.
  computeProgress([...Array(9).fill(item('high', true)), item('high')], [bug('critical')]), 90);

check('one serious bug among many harmless ones still caps',
  computeProgress([item('high', true)], [bug('low'), bug('medium', 'fixed'), bug('high')]), 90);

check('no bugs at all is not a cap', computeProgress([item('high', true)], []), 100);

// ---- the shapes it is handed in real life -----------------------------------

check('a realistic board: 2 highest + 3 high, half done, one high bug open',
  // done weight = 2 (one highest) + 1 (one high) = 3; total = 4 + 3 = 7 → 43.
  computeProgress(
    [item('highest', true), item('highest'), item('high', true), item('high'), item('high')],
    [bug('high')],
  ), 43);

check('…and the same board with that bug fixed is the same number, uncapped',
  computeProgress(
    [item('highest', true), item('highest'), item('high', true), item('high'), item('high')],
    [bug('high', 'fixed')],
  ), 43);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
