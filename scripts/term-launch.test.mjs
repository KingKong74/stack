#!/usr/bin/env node
// Tests for web/src/lib/termLaunch.ts — the board's ⌨ Run in terminal (#525) —
// and for the column moves it relies on and does not write itself.
// Run: node --experimental-strip-types scripts/term-launch.test.mjs
//
// Same loader shim as scripts/spine.test.mjs. The second half imports the
// SERVER's `listFor`: the feature's whole promise (To Do → In Progress → In
// Review with no column written) is that derivation, so it is pinned against
// the real one rather than restated here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';

module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { newTermName, termClaim, launchBrief } = await import(new URL('../web/src/lib/termLaunch.ts', import.meta.url));
const { listFor } = await import(new URL('../server/src/lists.js', import.meta.url));

test('a new name passes the daemon\'s validName and is fresh each time', () => {
  const a = newTermName();
  assert.match(a, /^stack-[A-Za-z0-9_-]{1,64}$/);
  assert.match(a, /^stack-term-[0-9a-f]{8}$/);
  assert.notEqual(a, newTermName());
});

test('the claim is the spelling the checkpoint path uses, and fits the column', () => {
  const c = termClaim('stack-term-0a1b2c3d');
  assert.equal(c, 'term:stack-term-0a1b2c3d');
  assert.ok(c.length <= 100);
});

test('the brief names the item, owns the claim, and asks for a built_note, never a tick', () => {
  const b = launchBrief('stack', { id: 525, title: 'Run a card', note: 'Do the thing.' }, 'stack-term-0a1b2c3d');
  assert.match(b, /^Work Stack roadmap item #525 in the stack project: Run a card/);
  assert.match(b, /Do the thing\./);
  assert.match(b, /`term:stack-term-0a1b2c3d`\. That claim is yours/);
  assert.match(b, /\/api\/projects\/stack\/roadmap\/525"/);
  assert.match(b, /"built_note"/);
  assert.match(b, /leave claimed_by and done alone/);
  assert.doesNotMatch(b, /"done":true/);
});

test('an empty note leaves no empty heading, and a long one says it was cut', () => {
  assert.doesNotMatch(launchBrief('s', { id: 1, title: 't', note: '  ' }, 'stack-term-1'), /note:/);
  const long = launchBrief('s', { id: 1, title: 't', note: 'x'.repeat(5000) }, 'stack-term-1');
  assert.match(long, /\[note cut at 3000 of 5000 characters/);
  assert.match(long, /built_note/); // the instructions after the note survive
});

test('the columns move themselves: claim → In Progress, built_note → In Review', () => {
  const card = { done: false, review_tag: '', built_note: '', claimed_by: '' };
  assert.equal(listFor(card), 'planned');
  const claimed = { ...card, claimed_by: termClaim('stack-term-0a1b2c3d') };
  assert.equal(listFor(claimed), 'progress');
  assert.equal(listFor({ ...claimed, built_note: 'Built it; verified by the test.' }), 'review');
  // Released without building: back to To Do.
  assert.equal(listFor({ ...claimed, claimed_by: '' }), 'planned');
});
