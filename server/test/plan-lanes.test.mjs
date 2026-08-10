// The Plan view's LANES: where an untouched card is derived to, and which of
// the four lanes may not be renamed or removed.
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
//  2. THE FOUR DEFAULT LANES ARE THE DERIVATION'S TARGETS. Every string
//     `listFor` can return must be a protected key, or the board has a derived
//     column somebody can rename out from under it — and the cards sent there
//     would vanish from the board while still counting everywhere else.
//
// It also holds the two twins in step by READING THE FILES: `listKeyOf` in
// web/src/lib/plan.ts is the client copy of `listFor`, and neither package can
// import the other. A structural check, not a string match — the point is that
// both spell the same four lanes and both put the verdict before the claim.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listFor, listKeyOf, isProtectedList, PROTECTED_LISTS, DEFAULT_LISTS } from '../src/lists.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const row = (over = {}) => ({
  done: false, claimed_by: null, review_tag: null, source: 'manual', reviewed_at: '2026-01-01',
  list_key: null, ...over,
});

// --- the derivation ---------------------------------------------------------

check('a ticked row is shipped', listFor(row({ done: true })), 'shipped');
check('a claimed row is in progress', listFor(row({ claimed_by: 'feat/3-x' })), 'progress');
check('an unapproved hook extraction is an idea',
  listFor(row({ source: 'hook', reviewed_at: null })), 'idea');
check('an unapproved fly card is an idea',
  listFor(row({ source: 'fly', reviewed_at: null })), 'idea');
check('everything else is planned', listFor(row()), 'planned');

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

// --- the lock ---------------------------------------------------------------

// The load-bearing one: whatever `listFor` can return must be protected.
const derived = new Set([
  listFor(row({ done: true })),
  listFor(row({ review_tag: 'solid' })),
  listFor(row({ claimed_by: 'x' })),
  listFor(row({ source: 'hook', reviewed_at: null })),
  listFor(row()),
]);
check('every lane the derivation targets is locked',
  [...derived].filter((k) => !isProtectedList(k)), []);
check('the four defaults are exactly the locked set',
  DEFAULT_LISTS.map((l) => l.key).sort(), [...PROTECTED_LISTS].sort());
check('a lane the owner added is not locked', isProtectedList('backlog-4'), false);
check('an empty key is not locked into anything', isProtectedList(''), false);

// A new lane's key is suffixed with its position (board.js), which is what
// makes a collision with a protected key impossible. If that suffix ever goes,
// an owner adding a lane called "Shipped" would silently take over the lane the
// Review room delivers into.
const board = readFileSync(join(REPO, 'server/src/routes/board.js'), 'utf8');
check('POST /lists still suffixes the key with its position',
  /INSERT INTO project_lists[\s\S]{0,400}?\$\{key\}-\$\{pos\[0\]\.p\}/.test(board)
  || board.includes('`${key}-${pos[0].p}`'), true);
check('both list writers refuse a protected key',
  (board.match(/isProtectedList\(key\)\) return res\.status\(400\)/g) || []).length, 2);

// --- the client twin --------------------------------------------------------

const twin = readFileSync(join(REPO, 'web/src/lib/plan.ts'), 'utf8');
const fn = twin.slice(twin.indexOf('export function listKeyOf'));
const body = fn.slice(0, fn.indexOf('\n}'));
check('the client twin returns the same four lanes',
  [...new Set([...body.matchAll(/return '([a-z]+)'/g)].map((m) => m[1]))].sort(),
  ['idea', 'planned', 'shipped'].concat('progress').sort());
check('the client twin puts the verdict before the claim',
  body.indexOf('reviewTag') < body.indexOf('claimedBy'), true);

// --- the write that makes the move unconditional ----------------------------

const roadmap = readFileSync(join(REPO, 'server/src/routes/roadmap.js'), 'utf8');
check('recording a verdict clears a hand-dragged column',
  /if \(verdict && req\.body\.listKey === undefined\) sets\.push\('list_key = NULL'\)/.test(roadmap), true);

console.log(fails ? `\n${fails} failing` : '\nall good');
process.exit(fails ? 1 : 0);
