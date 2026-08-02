#!/usr/bin/env node
// Tests for refine-round branch resolution (#274).
// Run: node scripts/refine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refineTargetBranch } from './lib/refine.mjs';

const item274 = { id: 274, title: 'Refine job kind so refine queues work' };

test('refineTargetBranch: exact current-spelling match wins over a legacy branch for the same item', () => {
  const exact = 'feat/274-refine-job-kind-so-refine-queu';
  const heads = [exact, 'auto/item-274-old-slug', 'main'];
  assert.equal(refineTargetBranch(item274, heads), exact);
});

test('refineTargetBranch: a retitled item still finds its branch by id', () => {
  // The item's title changed since the branch was cut, so laneFor(item) no
  // longer matches the name on origin — the id must still resolve it.
  const retitled = { id: 274, title: 'A completely different title now' };
  const heads = ['feat/274-refine-job-kind-so-refine-queu', 'main'];
  assert.equal(refineTargetBranch(retitled, heads), 'feat/274-refine-job-kind-so-refine-queu');
});

test('refineTargetBranch: a legacy auto/item-N branch is found', () => {
  const heads = ['auto/item-274-old-slug', 'main'];
  const found = refineTargetBranch(item274, heads);
  assert.equal(found, 'auto/item-274-old-slug');
});

test('refineTargetBranch: feat/2740-… and fix/bug-274-x do NOT match item 274', () => {
  const heads = ['feat/2740-something', 'fix/bug-274-x', 'main'];
  assert.equal(refineTargetBranch(item274, heads), null);
});

test('refineTargetBranch: no branch for the item returns null', () => {
  const heads = ['feat/99-unrelated', 'main'];
  assert.equal(refineTargetBranch(item274, heads), null);
});

// An empty heads list is what an unreachable/misconfigured origin looks like
// (see stack-autopilot.mjs) — the module's answer here is correctly null; it
// is the CALLER's job to tell "origin said nothing" apart from "origin has
// no branch for this item" and never treat the former as the latter.
test('refineTargetBranch: an empty heads list resolves to null, same as no match', () => {
  assert.equal(refineTargetBranch(item274, []), null);
});

test('refineTargetBranch: two candidates in either input order produce the same answer', () => {
  const a = ['auto/item-274-old-slug', 'fix/274-a-different-slug'];
  const b = ['fix/274-a-different-slug', 'auto/item-274-old-slug'];
  const resultA = refineTargetBranch(item274, a);
  const resultB = refineTargetBranch(item274, b);
  assert.equal(resultA, resultB);
  // Non-legacy sorts before legacy.
  assert.equal(resultA, 'fix/274-a-different-slug');
});

test('refineTargetBranch: two non-legacy candidates in either order sort lexicographically', () => {
  const a = ['feat/274-b-slug', 'feat/274-a-slug'];
  const b = ['feat/274-a-slug', 'feat/274-b-slug'];
  assert.equal(refineTargetBranch(item274, a), refineTargetBranch(item274, b));
  assert.equal(refineTargetBranch(item274, a), 'feat/274-a-slug');
});
