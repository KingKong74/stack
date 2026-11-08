#!/usr/bin/env node
// The board's Review all digest — the PURE half: which paths in a built note or
// a session's files_touched count as a test, and which summaries cite an item.
// `node server/test/review-digest.test.mjs` — no database.
//
// What matters most: a bare "tests" in prose names nothing and must not be
// listed as a test file, and #50 must never claim a session that cites #509.
import assert from 'node:assert/strict';
import { testRefsOf, testFilesOf, citesItem } from '../src/review-digest.js';

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`ok ${n} - ${name}`); };

t('named test files are found, deduped, in order', () => {
  const note = 'Pinned by server/test/progress.test.mjs and scripts/due.test.mjs; tests pass. Again: server/test/progress.test.mjs';
  assert.deepEqual(testRefsOf(note), ['server/test/progress.test.mjs', 'scripts/due.test.mjs']);
});
t('prose "tests" / "smoke" alone is not a file', () => {
  assert.deepEqual(testRefsOf('the tests pass and the UI smoke is clean; test_kind/test_target'), []);
});
t('a smoke script and a spec file count', () => {
  assert.deepEqual(testRefsOf('ran scripts/run-ui-smoke.sh and web/src/a.spec.tsx'),
    ['scripts/run-ui-smoke.sh', 'web/src/a.spec.tsx']);
});
t('a file under a test directory counts without .test.', () => {
  assert.deepEqual(testRefsOf('see server/test/helpers.mjs'), ['server/test/helpers.mjs']);
});
t('session files are made relative to cwd and non-tests dropped', () => {
  assert.deepEqual(
    testFilesOf(['/home/u/stack/server/test/x.test.mjs', '/home/u/stack/web/src/Board.tsx', 'scripts/y.test.mjs'], '/home/u/stack/'),
    ['server/test/x.test.mjs', 'scripts/y.test.mjs']);
  assert.deepEqual(testFilesOf(null), []);
});
t('an item is cited exactly, never by prefix', () => {
  assert.equal(citesItem('built #509 today', 509), true);
  assert.equal(citesItem('ends with #509', 509), true);
  assert.equal(citesItem('built #5090', 509), false);
  assert.equal(citesItem('built #509', 50), false);
  assert.equal(citesItem(null, 1), false);
});
console.log(`\n${n} passed`);
