// The relay's shape for the host's work timer (terminal/work-run.mjs → term.js).
// Pure, no database: node server/test/term-run.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { runShape } from '../src/term.js';

test('a run passes through as numbers, and anything else is null (unknown)', () => {
  assert.deepEqual(runShape({ start: '5', last: 9, working: true }), { start: 5, last: 9, working: true });
  assert.deepEqual(runShape({ start: 5, last: 9, working: 'yes' }), { start: 5, last: 9, working: false });
  for (const v of [null, undefined, 'x', {}, { start: 0, last: 3 }, { start: 9, last: 5 }]) assert.equal(runShape(v), null);
});
