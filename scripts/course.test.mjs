#!/usr/bin/env node
// Tests for web/src/lib/course.ts — the Activity slip's headline and Course's
// next-step wording. Run: node scripts/course.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { stripConventional, sentences, slipHeadline, splitStep, resumeBrief } =
  await import(new URL('../web/src/lib/course.ts', import.meta.url).href);

test('a conventional prefix is stripped and the subject capitalised', () => {
  assert.equal(stripConventional('fix(board): the receipt floats as a toast'), 'The receipt floats as a toast');
  assert.equal(stripConventional('feat!: breaking thing'), 'Breaking thing');
  assert.equal(stripConventional('Plain subject'), 'Plain subject');
  assert.equal(stripConventional('  '), '');
});

test('the headline is the commit subject when there is one', () => {
  assert.equal(slipHeadline({ headline: 'fix(notes): Delete deletes on one press', summary: 'Long story. More.' }),
    'Delete deletes on one press');
});

test('an older row falls back to the first sentence, capped', () => {
  assert.equal(slipHeadline({ headline: '', summary: "It's live now. Reload the page." }), "It's live now");
  const long = slipHeadline({ summary: 'word '.repeat(60) });
  assert.ok(long.length <= 91 && long.endsWith('…'));
  assert.equal(slipHeadline({ summary: '' }), 'No summary was posted for this push');
});

test('sentences split only before a capital, so versions and paths survive', () => {
  assert.deepEqual(sentences('Bumped to v2.1 today. Then `npm` ran.'), ['Bumped to v2.1 today.', 'Then `npm` ran.']);
  assert.deepEqual(sentences('see lib/plan.ts and go. ok'), ['see lib/plan.ts and go. ok']);
});

test('a step splits into title and detail', () => {
  assert.deepEqual(splitStep('Try End on a real tab. Probes could not.'), { title: 'Try End on a real tab', detail: 'Probes could not.' });
  assert.deepEqual(splitStep('One line only'), { title: 'One line only', detail: '' });
});

test('the resume brief names the step and leaves out an empty summary', () => {
  const b = resumeBrief('stack', 'Do X.', '');
  assert.match(b, /Resume work on stack/);
  assert.match(b, /Do X\./);
  assert.doesNotMatch(b, /left off/);
  assert.doesNotMatch(b, /\n\n\n/);
});
