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
//  2. THE CATCH-ALL IS WHAT MAKES THE UNLOCK SAFE (#428). The four lanes were
//     unrenameable and undeletable because every string `listFor` returns needs
//     a column to render in — delete one and its cards vanish from the board
//     while still counting everywhere else, which is the worst kind of loss.
//     The owner asked for a Trello board, so the guard MOVED: `RoadmapPlan`
//     draws an UNFILED lane for any card whose resolved key has no column. This
//     asserts the guard is still there, structurally, in the file that carries
//     it — take the catch-all out and the lock has to come back.
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

// --- the catch-all ----------------------------------------------------------

// Every string the derivation can return is one of the seeded lanes, so a fresh
// board renders all of them. That is still true and still load-bearing — it is
// what makes the catch-all a safety net rather than the normal case.
const derived = new Set([
  listFor(row({ done: true })),
  listFor(row({ review_tag: 'solid' })),
  listFor(row({ claimed_by: 'x' })),
  listFor(row({ source: 'hook', reviewed_at: null })),
  listFor(row()),
]);
const seeded = new Set(DEFAULT_LISTS.map((l) => l.key));
check('every lane the derivation targets is one the board seeds',
  [...derived].filter((k) => !seeded.has(k)), []);
check('the seeded lanes are exactly the derivation\'s targets',
  [...seeded].sort(), [...derived].sort());

// Polaris is culled and the lane no longer carries its name (#428). Named
// explicitly: the string is what the schema's convergent migration matches on,
// so the two have to agree or an existing board keeps the dead reference.
check('the ideas lane no longer names Polaris',
  DEFAULT_LISTS.find((l) => l.key === 'idea').name, 'Ideas');

// A new lane's key is suffixed with its position (board.js). Nothing locks the
// four any more, but their keys are still WIRING: two lanes answering to
// `shipped` would split one derived column in two, with half the cards in each.
const board = readFileSync(join(REPO, 'server/src/routes/board.js'), 'utf8');
check('POST /lists still suffixes the key with its position',
  /INSERT INTO project_lists[\s\S]{0,400}?\$\{key\}-\$\{pos\[0\]\.p\}/.test(board)
  || board.includes('`${key}-${pos[0].p}`'), true);

// THE ONE THAT REPLACES THE LOCK. Deleting `shipped` is allowed now, and the
// only thing standing between that and silently losing every done card is the
// board's catch-all. It lives in the client, which this cannot import — so it
// is checked structurally, the same arrangement as the client twin below.
const plan = readFileSync(join(REPO, 'web/src/detail/RoadmapPlan.tsx'), 'utf8');
check('the board still declares a catch-all lane', /const UNFILED = '/.test(plan), true);
check('a card whose key has no column is routed to it',
  /lists\.some\(\(l\) => l\.key === derived\) \? derived : UNFILED/.test(plan), true);
check('and the catch-all is actually drawn when it holds something',
  /if \(orphans\.length\) columns\.push\(/.test(plan), true);
// It is a rendering slot, never a stored column: writing this key would file a
// card under a lane no server knows about.
check('dropping onto the catch-all clears the column rather than storing its key',
  /onMoveToList\(it, col\.list \? col\.key : ''\)/.test(plan), true);

// The server, for its half: neither writer refuses a key any more.
check('neither list writer refuses a key',
  (board.match(/isProtectedList/g) || []).length, 0);

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
