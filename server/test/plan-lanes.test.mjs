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
//  2. THE LANES HAVE A CLIENT AGAIN, AND IT CARRIES THE CATCH-ALL. #428
//     unlocked renaming and deleting a lane on one condition: the board draws a
//     catch-all, so a card whose resolved key lost its column still renders
//     somewhere rather than being counted everywhere and visible nowhere. That
//     condition went unenforced while the board was a mockup (#443) and reading
//     no rows; web/src/detail/Board.tsx reads rows again, so the four
//     structural checks are back. The rule has not moved: a board ships with
//     the catch-all lane OR with `isProtectedList` back in routes/board.js,
//     never with neither.
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

// THE CLIENT HALF IS BACK, AND SO IS ITS GUARD. This file's header set the
// terms while the board was a mockup: a real board may only ship with ONE of
// the two — the catch-all lane, or `isProtectedList` back on the server. The
// board is wired again (web/src/detail/Board.tsx), it ships the catch-all, and
// these are the checks that hold it there. Every one is structural rather than
// a word match, because this file's own prose names all of these things.
const boardTsx = readFileSync(join(REPO, 'web/src/detail/Board.tsx'), 'utf8');

// The tripwire the mockup era used, read the other way round: `store.ts` is the
// only module in this client allowed to touch the network, so an import of it
// is what says a board reads rows at all. It does now, which is what makes the
// four checks below owed rather than optional.
check('the client board reads rows again',
  /^import \{[\s\S]{0,400}?\} from '\.\.\/store';$/m.test(boardTsx), true);

// 1. There is a catch-all key at all, and it cannot collide with a real one.
//    `POST /lists` slugifies a name into `[a-z0-9-]+-<position>`, so a key with
//    a space in it is unreachable from that route by construction.
const catchAll = /const CATCH_ALL = '([^']+)'/.exec(boardTsx);
check('the client board declares a catch-all lane', !!catchAll, true);
check('and its key cannot collide with one POST /lists could mint',
  /[^a-z0-9-]/.test(catchAll ? catchAll[1] : 'x'), true);

// 2. A card whose derived key has no column goes there rather than nowhere.
//    This is the whole of what keeps deleting `shipped` from losing cards.
check('a card whose derived lane has no column falls to the catch-all',
  /known\.has\([a-zA-Z]+\)\s*\?\s*[a-zA-Z]+\s*:\s*CATCH_ALL/.test(boardTsx), true);

// 3. The catch-all is RENDERED, not merely computed. A bag nobody draws is the
//    same silent loss the lane exists to prevent.
//
//    Matched on the PUSH carrying CATCH_ALL rather than on the array it is
//    pushed into: #469 grouped the board by area, so the drawn columns are now
//    built per SECTION and the array changed name. What must not change is that
//    an orphan bag ends up in the list something renders.
check('and the catch-all column is appended to the drawn columns',
  /orphans[\s\S]{0,120}\.push\(\{\s*key: CATCH_ALL/.test(boardTsx), true);

// 4. Nothing may be DROPPED into it. It is a holding pen for cards whose column
//    was deleted, not a lane — a drop that wrote its key would store a
//    `list_key` no derivation and no server route knows.
check('and nothing can be dropped into the catch-all',
  /if \(key === CATCH_ALL[\s\S]{0,80}\) return;/.test(boardTsx), true);

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
