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
//   • 0% WITH NO ITEMS AT ALL. Not 100%: an empty plan has not been finished,
//     it has not been made. Dividing by a zero total and rendering NaN, or
//     short-circuiting to 100, are both one line away.
//
// #509 CHANGED THE FIRST HALF OF THIS FILE AND THAT WAS THE POINT. Until then
// only Highest and High counted, and this file's own note said weighting all
// five was "a defensible change and a DIFFERENT one" that must not be smuggled
// in under a rename. It was then made on its own: a row is BORN medium now
// (BUCKET_DEFAULT), so a default outside the sum would have every new board
// reading 0% for ever. The pairing is the invariant this file now pins — the
// default and the weights move together or not at all.
//
// What survived unchanged: the 90% cap, the rounding, 0% on an empty board, and
// the GRADING. A done Highest is worth three done Lowests, so finishing the
// small stuff can never read like finishing the plan.
//
// VALIDATED BY MUTATION. Six regressions were introduced into util.js on
// purpose and this file run against each:
//
//   the cap becomes a floor (Math.min → Math.max)  → 6 fails
//   an empty plan returns 100 instead of 0         → 2 fails
//   `medium` stops counting again (the #509 revert) → 12 fails
//   the five weights flattened to 1 each           → 9 fails
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

check('a done HIGHEST outweighs a done HIGH',
  // weight 3 of 5 done = 60, not 50: the two items are not equal.
  computeProgress([item('highest', true), item('high', false)], []), 60);
check('…and the other way round is the two fifths that are left',
  computeProgress([item('highest', false), item('high', true)], []), 40);

check('the result is a rounded integer, never a float',
  computeProgress([item('high', true), item('high'), item('high')], []), 33);

// ---- EVERY PRIORITY MOVES THE BAR (#509) -----------------------------------
//
// The half that changed. Each of these read 100% before #509, because the
// unfinished item was outside the sum entirely.

check('MEDIUM moves the bar — it is the level a row is BORN at',
  // 2 of 3 done: high weighs 2, medium weighs 1.
  computeProgress([item('high', true), item('medium', false)], []), 67);
check('so does low', computeProgress([item('high', true), item('low', false)], []), 67);
check('so does lowest', computeProgress([item('high', true), item('lowest', false)], []), 67);
check('a DONE medium moves it too — it is in the sum like anything else',
  computeProgress([item('high', false), item('medium', true)], []), 33);

check('MEDIUM, LOW AND LOWEST WEIGH THE SAME as each other — the ramp is a rank',
  [computeProgress([item('medium', true), item('low'), item('lowest')], []),
   computeProgress([item('low', true), item('medium'), item('lowest')], []),
   computeProgress([item('lowest', true), item('medium'), item('low')], [])], [33, 33, 33]);

check('a done HIGHEST is worth three done LOWESTs and no more',
  // 3 of 6: one highest against three lowests, all of the latter unfinished.
  computeProgress([item('highest', true), item('lowest'), item('lowest'), item('lowest')], []), 50);

check('an unknown bucket is ignored rather than counted or crashed on',
  // `must` is the pre-#469 spelling; schema.sql migrates it, but a payload
  // assembled by hand can still carry one and it must not become a weight of 1.
  computeProgress([item('high', true), item('must', true), item(''), item(null)], []), 100);

// ---- 0% ON AN EMPTY BOARD --------------------------------------------------

check('an empty board is 0%, not 100% and not NaN', computeProgress([], []), 0);
check('a board of nothing but medium/low is NOT 0% any more — all of it counts',
  computeProgress([item('medium', true), item('low', true), item('lowest', true)], []), 100);
check('…and a board of nothing but unknown buckets is still 0%, no division by zero',
  computeProgress([item('must', true), item(null, true)], [bug('critical')]), 0);

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
  // 18 of 20 weight done = 90 exactly.
  computeProgress([...Array(9).fill(item('high', true)), item('high')], [bug('critical')]), 90);

check('one serious bug among many harmless ones still caps',
  computeProgress([item('high', true)], [bug('low'), bug('medium', 'fixed'), bug('high')]), 90);

check('no bugs at all is not a cap', computeProgress([item('high', true)], []), 100);

// ---- the shapes it is handed in real life -----------------------------------

check('a realistic board: 2 highest + 3 high, half done, one high bug open',
  // done weight = 3 (one highest) + 2 (one high) = 5; total = 6 + 6 = 12 → 42.
  computeProgress(
    [item('highest', true), item('highest'), item('high', true), item('high'), item('high')],
    [bug('high')],
  ), 42);

check('…and the same board with that bug fixed is the same number, uncapped',
  computeProgress(
    [item('highest', true), item('highest'), item('high', true), item('high'), item('high')],
    [bug('high', 'fixed')],
  ), 42);

check('A BOARD OF UNRANKED WORK IS NOT STUCK AT ZERO — the #509 pairing itself',
  // Everything born at the default, half of it finished. Before #509 this read
  // 0% however much of it was done, which is what made the default a problem.
  computeProgress([item('medium', true), item('medium', true), item('medium'), item('medium')], []), 50);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
