// The Plan view's LANES: where an untouched card is derived to, and what keeps
// a card visible when the lane it derives to has been deleted.
//
//   node server/test/plan-lanes.test.mjs      # exits non-zero on any failure
//
// Pure — no database, no host. Two things it pins that a build cannot:
//
//  1. A VERDICT SHIPS THE CARD AND STILL DOES NOT TICK IT. The branch claim
//     survives a verdict (it stays until a human merges and ticks), so a
//     claim-first derivation left every verdicted change sitting in "In
//     progress" for as long as its branch lived. `review_tag` has to outrank
//     `claimed_by` here, and `done` has to stay out of it entirely.
//  2. THE LANES NO LONGER HAVE A CLIENT AT ALL, and that is why the lock that
//     used to guard them is still off. #428 unlocked renaming and deleting a
//     lane on one condition: the board drew an UNFILED catch-all, so a card
//     whose resolved key lost its column still rendered somewhere. The board is
//     a MOCKUP now (web/src/detail/BoardMock.tsx) and reads no rows, so there is
//     no rendering left to lose a card from — the four structural checks on
//     that catch-all are gone with the file that carried them. What survives is
//     the derivation itself, which the overnight runner and every server reader
//     still depend on. IF A REAL BOARD EVER COMES BACK, one of the two has to
//     come back with it: the catch-all lane, or `isProtectedList` in
//     routes/board.js. Do not let a board ship with neither.
//
// It also holds the two twins in step by READING THE FILES: `listKeyOf` in
// web/src/lib/plan.ts is the client copy of `listFor`, and neither package can
// import the other. A structural check, not a string match — the point is that
// both spell the same four lanes and both put the verdict before the claim.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listFor, listKeyOf, DEFAULT_LISTS } from '../src/lists.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const row = (over = {}) => ({
  done: false, claimed_by: null, review_tag: null, built_note: null, source: 'manual',
  reviewed_at: '2026-01-01', list_key: null, ...over,
});

// --- the derivation ---------------------------------------------------------

check('a ticked row is shipped', listFor(row({ done: true })), 'shipped');
check('a claimed row with nothing built is in progress',
  listFor(row({ claimed_by: 'feat/3-x' })), 'progress');
check('everything else is planned', listFor(row()), 'planned');

// #440 — the lane that carries the state, rather than In Progress carrying two.
check('a built, unverdicted change is in review',
  listFor(row({ claimed_by: 'feat/3-x', built_note: 'what landed' })), 'review');
check('a built note with no claim is not in review — both halves are the predicate',
  listFor(row({ built_note: 'what landed' })), 'planned');
check('a whitespace-only built note does not move a card',
  listFor(row({ claimed_by: 'feat/3-x', built_note: '  ' })), 'progress');
check('a verdict outranks being built',
  listFor(row({ claimed_by: 'feat/3-x', built_note: 'x', review_tag: 'solid' })), 'shipped');
check('a tick outranks everything',
  listFor(row({ done: true, claimed_by: 'feat/3-x', built_note: 'x' })), 'shipped');

// The `idea` lane is retired (#440): the Roadmap tab's capture inbox says
// "held" on the card, so the board does not need a lane for it. A held row is
// planned work nobody has signed off, and it sits with the rest of To Do.
check('an unapproved hook extraction is planned now, not an idea',
  listFor(row({ source: 'hook', reviewed_at: null })), 'planned');
check('an unapproved fly card is planned too',
  listFor(row({ source: 'fly', reviewed_at: null })), 'planned');

// The one that regressed the room: the claim outlives the verdict.
check('a verdict ships a change whose branch claim still stands',
  listFor(row({ claimed_by: 'feat/3-x', review_tag: 'solid' })), 'shipped');
check('a needs-work verdict ships it too — it has been read and answered',
  listFor(row({ claimed_by: 'feat/3-x', review_tag: 'needs-work' })), 'shipped');
check('clearing the verdict hands the card straight back to the claim',
  listFor(row({ claimed_by: 'feat/3-x', review_tag: '' })), 'progress');
check('a whitespace-only tag is not a verdict',
  listFor(row({ claimed_by: 'feat/3-x', review_tag: '  ' })), 'progress');

// An explicit column still wins — the exception is on the verdict WRITE
// (roadmap.js clears `list_key`), never in the derivation.
check('a stored column wins over every derived one',
  listKeyOf(row({ done: true, list_key: 'planned' })), 'planned');
check('a blank stored column is derived, not "the first list"',
  listKeyOf(row({ list_key: '   ', claimed_by: 'feat/3-x' })), 'progress');

// --- the catch-all ----------------------------------------------------------

// Every string the derivation can return is one of the seeded lanes, so a fresh
// board renders all of them. That is still true and still load-bearing — it is
// what makes the catch-all a safety net rather than the normal case.
const derived = new Set([
  listFor(row({ done: true })),
  listFor(row({ review_tag: 'solid' })),
  listFor(row({ claimed_by: 'x', built_note: 'y' })),
  listFor(row({ claimed_by: 'x' })),
  listFor(row({ source: 'hook', reviewed_at: null })),
  listFor(row()),
]);
const seeded = new Set(DEFAULT_LISTS.map((l) => l.key));
check('every lane the derivation targets is one the board seeds',
  [...derived].filter((k) => !seeded.has(k)), []);
check('the seeded lanes are exactly the derivation\'s targets',
  [...seeded].sort(), [...derived].sort());

// The seeded NAMES are what the schema's convergent migration matches on, so
// the two files have to agree or an existing board keeps the old wording while
// a new one gets the new. Checked in order, because left-to-right IS the
// workflow: what is next, what is running, what is waiting on you, what is done.
check('the seeded lanes are the four the kit draws, in order',
  DEFAULT_LISTS.map((l) => `${l.key}:${l.name}`),
  ['planned:To Do', 'progress:In Progress', 'review:In Review', 'shipped:Done']);
check('and their positions are left-to-right',
  DEFAULT_LISTS.map((l) => l.position), [0, 1, 2, 3]);

// The migration is what gives an EXISTING board the new lane: `ensureLists`
// only seeds a board with none, so without these an old board derives cards to
// `review` and the catch-all draws them under Unfiled.
const schema = readFileSync(join(REPO, 'server/src/schema.sql'), 'utf8');
check('the schema adds the review lane to every existing board',
  /INSERT INTO project_lists[\s\S]{0,200}'review'[\s\S]{0,120}ON CONFLICT/.test(schema), true);
check('and only renames a lane still carrying the name it was seeded with',
  /UPDATE project_lists SET name = 'To Do' WHERE key = 'planned' AND name IN/.test(schema), true);
check('and never deletes a lane that holds a dragged card',
  /DELETE FROM project_lists l[\s\S]{0,300}NOT EXISTS[\s\S]{0,200}list_key = 'idea'/.test(schema), true);

// A new lane's key is suffixed with its position (board.js). Nothing locks the
// four any more, but their keys are still WIRING: two lanes answering to
// `shipped` would split one derived column in two, with half the cards in each.
const board = readFileSync(join(REPO, 'server/src/routes/board.js'), 'utf8');
check('POST /lists still suffixes the key with its position',
  /INSERT INTO project_lists[\s\S]{0,400}?\$\{key\}-\$\{pos\[0\]\.p\}/.test(board)
  || board.includes('`${key}-${pos[0].p}`'), true);

// THE CLIENT HALF IS GONE. Four checks stood here, pinning the board's UNFILED
// catch-all — the thing that made deleting `shipped` safe. The board that drew
// it was replaced by a mockup that reads no rows, so there is nothing left to
// assert and nothing left to lose a card from. The header says what has to come
// back if a real board ever does.
//
// This ALSO pins that the client board is still a mockup: the moment a file
// under web/src reads lanes again, one of the two guards is owed.
// Tested by its IMPORTS, not by prose: this file's header talks about store.ts
// at length, and a word-match would fail on the very comment explaining why it
// does not use it. `store.ts` is the only module in this client allowed to
// touch the network, so an import of it is exactly the tripwire.
const boardMock = readFileSync(join(REPO, 'web/src/detail/BoardMock.tsx'), 'utf8');
check('the client board is still a mockup that reads nothing',
  /^import .*from '.*store';$/m.test(boardMock), false);

// The server, for its half: neither writer refuses a key any more.
check('neither list writer refuses a key',
  (board.match(/isProtectedList/g) || []).length, 0);

// --- the client twin --------------------------------------------------------

const twin = readFileSync(join(REPO, 'web/src/lib/plan.ts'), 'utf8');
const fn = twin.slice(twin.indexOf('export function listKeyOf'));
const body = fn.slice(0, fn.indexOf('\n}'));
check('the client twin returns the same four lanes',
  [...new Set([...body.matchAll(/return '([a-z]+)'/g)].map((m) => m[1]))].sort(),
  DEFAULT_LISTS.map((l) => l.key).sort());
check('the client twin puts the verdict before the claim',
  body.indexOf('reviewTag') < body.indexOf('claimedBy'), true);
// And BUILT before the claim, for the same reason: the claim outlives being
// built, so a claim-first twin would leave finished work in In Progress on the
// client while the server called it In Review.
check('the client twin puts built before the claim',
  body.indexOf('isBuilt') < body.indexOf('claimedBy'), true);

// --- the write that makes the move unconditional ----------------------------

const roadmap = readFileSync(join(REPO, 'server/src/routes/roadmap.js'), 'utf8');
check('recording a verdict clears a hand-dragged column',
  /if \(verdict && req\.body\.listKey === undefined\) sets\.push\('list_key = NULL'\)/.test(roadmap), true);

console.log(fails ? `\n${fails} failing` : '\nall good');
process.exit(fails ? 1 : 0);
