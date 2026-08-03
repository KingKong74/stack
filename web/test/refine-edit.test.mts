// Pure tests for the refine note's edit rules (#319) — no test runner, no
// dependency beyond node:assert/strict. Node 22 strips types from .mts
// natively, so this runs directly:
//
//   node web/test/refine-edit.test.mts

import assert from 'node:assert/strict';
import { REFINE_MAX, normaliseRefine, refineDirty, planRefineSave } from '../src/lib/refineEdit.ts';

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

test('trims surrounding whitespace', () => {
  assert.equal(normaliseRefine('  hello  '), 'hello');
});

test('caps at REFINE_MAX characters', () => {
  const long = 'a'.repeat(REFINE_MAX + 50);
  const norm = normaliseRefine(long);
  assert.equal(norm.length, REFINE_MAX);
  assert.equal(norm, 'a'.repeat(REFINE_MAX));
});

test('a draft differing only past the cap is not dirty', () => {
  const original = 'a'.repeat(REFINE_MAX);
  const draft = 'a'.repeat(REFINE_MAX) + 'extra tail the server will slice off';
  assert.equal(refineDirty(original, draft), false);
});

test('a draft differing only by surrounding whitespace is not dirty', () => {
  assert.equal(refineDirty('hello', '  hello  '), false);
});

test('a real change is dirty', () => {
  assert.equal(refineDirty('hello', 'hello world'), true);
});

test('planRefineSave: unchanged draft is none', () => {
  assert.deepEqual(planRefineSave('hello', '  hello  '), { kind: 'none' });
});

test('planRefineSave: clearing a non-empty note is clear', () => {
  assert.deepEqual(planRefineSave('hello', ''), { kind: 'clear' });
  assert.deepEqual(planRefineSave('hello', '   '), { kind: 'clear' });
});

test('planRefineSave: clearing an already-empty note is none (no pointless PATCH)', () => {
  assert.deepEqual(planRefineSave('', '   '), { kind: 'none' });
});

test('planRefineSave: a real edit is save', () => {
  assert.deepEqual(planRefineSave('hello', 'hello there'), { kind: 'save', text: 'hello there' });
});

test("planRefineSave: a save's text comes back already normalised", () => {
  const draft = `  ${'b'.repeat(REFINE_MAX + 20)}  `;
  const result = planRefineSave('hello', draft);
  assert.equal(result.kind, 'save');
  if (result.kind === 'save') {
    assert.equal(result.text, 'b'.repeat(REFINE_MAX));
    assert.equal(result.text.length, REFINE_MAX);
  }
});

console.log(`\n${passed} passed`);
process.exit(0);
