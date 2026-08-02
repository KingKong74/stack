// #267 — area-disjoint picking: an "area lane" (roadmap_items.area,
// normalised, scoped to ONE project) admits one worker at a time. Pure, no
// DB — server/src/lanes.js takes no dependency on the app, so this runs
// against the real export.
//
//   node server/test/area-lanes.test.mjs      # exits non-zero on any failure
import test from 'node:test';
import assert from 'node:assert/strict';
import { normArea, laneKey, occupiedAreas, laneHolders, areaHeld } from '../src/lanes.js';

const P1 = 1;
const P2 = 2;

test('normArea trims and lowercases', () => {
  assert.equal(normArea('  Billing  '), 'billing');
  assert.equal(normArea('BILLING'), 'billing');
  assert.equal(normArea(null), '');
  assert.equal(normArea(undefined), '');
  assert.equal(normArea(''), '');
});

test('laneKey pairs project and area; untagged is never a real key', () => {
  assert.equal(laneKey(P1, 'Billing'), '1::billing');
  assert.equal(laneKey(P1, ''), '');
  assert.equal(laneKey(P1, '   '), '');
});

test('an untagged area is NEVER a lane — it never occupies', () => {
  const occupied = occupiedAreas([
    { projectId: P1, area: '', by: 'auto/some-branch' },
    { projectId: P1, area: '   ', by: 'lane/other' },
  ]);
  assert.equal(occupied.size, 0);
  // and it can never be blocked by a lane either, whatever is occupied.
  const busy = occupiedAreas([{ projectId: P1, area: 'billing', by: 'auto/x' }]);
  assert.equal(areaHeld(P1, '', busy), false);
  assert.equal(areaHeld(P1, '   ', busy), false);
});

test('a claimed OPEN item occupies its area', () => {
  const occupied = occupiedAreas([{ projectId: P1, area: 'billing', by: 'auto/billing-item-9' }]);
  assert.equal(areaHeld(P1, 'billing', occupied), true);
});

test('a DONE item never reaches the holders list in the first place', () => {
  // The caller is responsible for filtering to open (NOT done) items before
  // building the holders array — occupiedAreas is dumb and total, so this
  // pins the CALLER's contract: a done item's claim must never be passed in.
  const holders = [{ projectId: P1, area: 'billing', by: 'auto/billing-item-9' }].filter(() => false); // "done, excluded"
  const occupied = occupiedAreas(holders);
  assert.equal(areaHeld(P1, 'billing', occupied), false);
});

test('case/whitespace-insensitive matching', () => {
  const occupied = occupiedAreas([{ projectId: P1, area: '  Billing ', by: 'auto/x' }]);
  assert.equal(areaHeld(P1, 'BILLING', occupied), true);
  assert.equal(areaHeld(P1, ' billing  ', occupied), true);
});

test('two genuinely different areas do not block each other', () => {
  const occupied = occupiedAreas([{ projectId: P1, area: 'billing', by: 'auto/billing-item' }]);
  assert.equal(areaHeld(P1, 'billing', occupied), true);
  assert.equal(areaHeld(P1, 'search', occupied), false);
});

// The bug the coordinator caught: a lane is (project, area), not the bare
// area string. "ui" claimed in project A must never stall project B's "ui"
// work — different repos, so their files cannot possibly collide.
test('the SAME area string in two different projects does not block', () => {
  const occupied = occupiedAreas([{ projectId: P1, area: 'ui', by: 'auto/p1-ui-item' }]);
  assert.equal(areaHeld(P1, 'ui', occupied), true);   // project 1's lane IS held
  assert.equal(areaHeld(P2, 'ui', occupied), false);  // project 2's namesake lane is NOT
});

test('a holder in project A occupies project A\'s lane only', () => {
  const occupied = occupiedAreas([
    { projectId: P1, area: 'billing', by: 'auto/p1-billing' },
    { projectId: P2, area: 'search', by: 'auto/p2-search' },
  ]);
  assert.equal(areaHeld(P1, 'billing', occupied), true);
  assert.equal(areaHeld(P2, 'billing', occupied), false); // never claimed in P2
  assert.equal(areaHeld(P2, 'search', occupied), true);
  assert.equal(areaHeld(P1, 'search', occupied), false);  // never claimed in P1
});

test('laneHolders names who holds an occupied lane, keyed per project', () => {
  const holders = [
    { projectId: P1, area: 'billing', by: 'auto/billing-item-9' },
    { projectId: P1, area: 'search', by: 'job #12' },
    { projectId: P2, area: 'billing', by: 'job #99' }, // same area, other project
  ];
  const map = laneHolders(holders);
  assert.equal(map.get(laneKey(P1, 'billing')), 'auto/billing-item-9');
  assert.equal(map.get(laneKey(P1, 'search')), 'job #12');
  assert.equal(map.get(laneKey(P2, 'billing')), 'job #99');
  assert.notEqual(map.get(laneKey(P1, 'billing')), map.get(laneKey(P2, 'billing')));
  assert.equal(map.has(''), false); // untagged never gets a holder entry
});

test('laneHolders drops untagged and keeps the first holder for a repeated lane', () => {
  const holders = [
    { projectId: P1, area: '', by: 'ignored' },
    { projectId: P1, area: 'billing', by: 'first-holder' },
    { projectId: P1, area: 'billing', by: 'second-holder' },
  ];
  const map = laneHolders(holders);
  assert.equal(map.get(laneKey(P1, 'billing')), 'first-holder');
  assert.equal(map.size, 1);
});

test('a holder does not block itself — the caller excludes its own claim', () => {
  // occupiedAreas/areaHeld are dumb and total: "does not block itself" is a
  // property of what the CALLER passes in (excluding the job's own pinned
  // item, or the candidate's own claim), not something these two functions
  // decide on their own. Pin that by showing the same holders list blocks
  // area X for anyone else...
  const holdersFromOthers = [{ projectId: P1, area: 'billing', by: 'auto/some-other-item' }];
  const occupied = occupiedAreas(holdersFromOthers);
  assert.equal(areaHeld(P1, 'billing', occupied), true);
  // ...but when the caller has already excluded the asking job's own claim
  // (the only holder was itself), the area reads as free.
  const occupiedExcludingSelf = occupiedAreas([]);
  assert.equal(areaHeld(P1, 'billing', occupiedExcludingSelf), false);
});
