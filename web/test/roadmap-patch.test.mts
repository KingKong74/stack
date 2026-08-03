// Pure tests for folding a PATCHed item back into a loaded Roadmap — no test
// runner, no dependency beyond node:assert/strict. Node 22 strips types from
// .mts natively, so this runs directly:
//
//   node web/test/roadmap-patch.test.mts
//
// What this is really pinning: Mission Control's Plan room projects "Tonight"
// from the details it already holds, so an accept that does not update them
// leaves the item in neither list — gone from the inbox, absent from the
// queue — until a page reload. The bucket MOVE is the case worth a test: an
// accept can recategorise at the same time, so the item has to leave one
// bucket and join another in a single write.

import assert from 'node:assert/strict';
import { applyRoadmapItem, removeRoadmapItem, BUCKET_KEYS } from '../src/lib/roadmapPatch.ts';
import type { Roadmap, RoadmapItem, Priority } from '../src/types.ts';

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// A roadmap item carries a lot of fields none of this logic reads; the cast
// keeps the fixtures to the three that decide placement.
const item = (id: number, bucket: Priority, extra: Partial<RoadmapItem> = {}) =>
  ({ id, bucket, title: `#${id}`, reviewed: false, ...extra } as RoadmapItem);

const board = (): Roadmap => ({
  must: [item(1, 'must'), item(2, 'must')],
  should: [item(3, 'should')],
  could: [],
  wont: [],
} as unknown as Roadmap);

const ids = (r: Roadmap) => BUCKET_KEYS.flatMap((b) => r[b].map((it) => it.id));
const find = (r: Roadmap, id: number) => BUCKET_KEYS.flatMap((b) => r[b]).find((it) => it.id === id);

test('an in-place update keeps the item in its bucket', () => {
  const next = applyRoadmapItem(board(), item(2, 'must', { reviewed: true }));
  assert.equal(next.must.length, 2);
  assert.equal(find(next, 2)?.reviewed, true);
});

test('the updated fields are the ones that land', () => {
  const next = applyRoadmapItem(board(), item(3, 'should', { title: 'renamed' }));
  assert.equal(find(next, 3)?.title, 'renamed');
});

// The case the Plan room's accept actually hits when the inbox's bucket picker
// was changed before pressing Accept.
test('a recategorising accept MOVES the item, leaving no copy behind', () => {
  const next = applyRoadmapItem(board(), item(1, 'could', { reviewed: true }));
  assert.deepEqual(next.must.map((it) => it.id), [2], 'left its old bucket');
  assert.deepEqual(next.could.map((it) => it.id), [1], 'joined the new one');
  assert.equal(ids(next).filter((id) => id === 1).length, 1, 'exactly one copy exists');
  assert.equal(find(next, 1)?.reviewed, true);
});

test('an item not already on the board is added rather than dropped', () => {
  const next = applyRoadmapItem(board(), item(9, 'wont'));
  assert.deepEqual(next.wont.map((it) => it.id), [9]);
});

test('the input roadmap is not mutated', () => {
  const before = board();
  const snapshot = JSON.stringify(before);
  applyRoadmapItem(before, item(1, 'could'));
  removeRoadmapItem(before, 2);
  assert.equal(JSON.stringify(before), snapshot);
});

test('remove drops the item from whichever bucket held it', () => {
  const next = removeRoadmapItem(board(), 3);
  assert.deepEqual(ids(next), [1, 2]);
});

test('removing an id that is not there changes nothing', () => {
  assert.deepEqual(ids(removeRoadmapItem(board(), 404)), [1, 2, 3]);
});

test('every bucket is walked, so no bucket can hide a stale copy', () => {
  // The same id planted in all four buckets — only a walk over every key
  // clears them all. A partial walk is exactly how a duplicate row survives.
  const messy = {
    must: [item(7, 'must')], should: [item(7, 'should')],
    could: [item(7, 'could')], wont: [item(7, 'wont')],
  } as unknown as Roadmap;
  assert.deepEqual(ids(removeRoadmapItem(messy, 7)), []);
  assert.equal(ids(applyRoadmapItem(messy, item(7, 'should'))).length, 1);
});

console.log(`\n${passed} passed`);
