// Pure tests for where "Open in Workbench" lands (#321) — no test runner, no
// dependency beyond node:assert/strict. Node 22 strips types from .mts
// natively, so this runs directly:
//
//   node web/test/workbench-open.test.mts

import assert from 'node:assert/strict';
import { planWorkbenchOpen, type WorkbenchOpenCard } from '../src/lib/workbenchOpen.ts';

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

test('empty canvas creates at the server default corner', () => {
  assert.deepEqual(planWorkbenchOpen([], 1), { action: 'create', x: 40, y: 40 });
});

test('one card places the new one past its right edge, at its own y', () => {
  const cards: WorkbenchOpenCard[] = [{ id: 1, futureId: 5, x: 100, y: 200, w: 244 }];
  assert.deepEqual(planWorkbenchOpen(cards, 99), { action: 'create', x: 384, y: 200 });
});

test('several cards: x from the rightmost edge, y from the topmost card', () => {
  const cards: WorkbenchOpenCard[] = [
    { id: 1, futureId: 1, x: 0, y: 500, w: 244 },
    { id: 2, futureId: 2, x: 300, y: 40, w: 244 },
    { id: 3, futureId: 3, x: 150, y: 900, w: 244 },
  ];
  // rightmost edge: card 2 at 300+244=544, +40 = 584; topmost y: card 2's 40
  assert.deepEqual(planWorkbenchOpen(cards, 99), { action: 'create', x: 584, y: 40 });
});

test('a missing w is treated as the 244 default width', () => {
  const cards: WorkbenchOpenCard[] = [{ id: 1, futureId: 1, x: 100, y: 10, w: null }];
  assert.deepEqual(planWorkbenchOpen(cards, 99), { action: 'create', x: 384, y: 10 });
});

test('an idea already on the canvas reveals its card instead of creating one', () => {
  const cards: WorkbenchOpenCard[] = [
    { id: 1, futureId: 7, x: 900, y: 900, w: 244 },
    { id: 2, futureId: 42, x: 0, y: 0, w: 244 },
  ];
  assert.deepEqual(planWorkbenchOpen(cards, 42), { action: 'reveal', cardId: 2 });
});

test('a note card (futureId null) never matches, but still counts for placement', () => {
  const cards: WorkbenchOpenCard[] = [{ id: 1, futureId: null, x: 500, y: 30, w: 244 }];
  const plan = planWorkbenchOpen(cards, 42);
  assert.deepEqual(plan, { action: 'create', x: 784, y: 30 });
});

test('placement clamps to the server range', () => {
  const cards: WorkbenchOpenCard[] = [{ id: 1, futureId: 1, x: 19999, y: 40, w: 244 }];
  // 19999 + 244 + 40 = 20283, clamped to 20000
  assert.deepEqual(planWorkbenchOpen(cards, 99), { action: 'create', x: 20000, y: 40 });
});

console.log(`\n${passed} passed`);
process.exit(0);
