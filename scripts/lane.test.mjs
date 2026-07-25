#!/usr/bin/env node
// Tests for autopilot lane naming and item-ID extraction from branch names.
// Run: node scripts/lane.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchSlug, laneFor } from './lib/lane.mjs';

// --- branchSlug ---

test('branchSlug: basic title', () => {
  assert.equal(branchSlug('Add dark mode support'), 'add-dark-mode-support');
});

test('branchSlug: truncates at 30 chars and trims trailing hyphen', () => {
  const slug = branchSlug('This is a very long title that should be truncated nicely');
  assert.ok(slug.length <= 30, `slug too long: ${slug.length}`);
  assert.ok(!slug.endsWith('-'), `slug ends with hyphen: ${slug}`);
});

test('branchSlug: special characters collapse to single hyphens', () => {
  assert.equal(branchSlug('feat(control): per-session'), 'feat-control-per-session');
});

test('branchSlug: all-special title returns empty string', () => {
  assert.equal(branchSlug(''), '');
  assert.equal(branchSlug('!!! ---'), '');
});

test('branchSlug: unicode/emoji becomes hyphen', () => {
  const slug = branchSlug('Add ✨ sparkle feature');
  assert.ok(/^[a-z0-9-]+$/.test(slug), `non-safe chars in slug: ${slug}`);
});

// --- laneFor ---

test('laneFor: basic item', () => {
  assert.equal(laneFor({ id: 42, title: 'Add dark mode' }), 'auto/item-42-add-dark-mode');
});

test('laneFor: item 224 title slug', () => {
  const lane = laneFor({ id: 224, title: 'Descriptive branch names on autopilot runs' });
  assert.equal(lane, 'auto/item-224-descriptive-branch-names-on-au');
  assert.ok(!lane.endsWith('-'), `lane ends with hyphen: ${lane}`);
});

test('laneFor: empty slug falls back to numeric-only lane', () => {
  assert.equal(laneFor({ id: 7, title: '!!! ---' }), 'auto/item-7');
});

// --- item-ID extraction, mirrors stack-autopilot-dispatch.mjs:104 ---
const ITEM_RE = /(?:^|\/)item-(\d+)/;

test('dispatch regex: new descriptive format', () => {
  assert.equal(ITEM_RE.exec('auto/item-42-add-dark-mode')?.[1], '42');
});

test('dispatch regex: old numeric-only format', () => {
  assert.equal(ITEM_RE.exec('auto/item-7')?.[1], '7');
});

test('dispatch regex: bare item-N-slug', () => {
  assert.equal(ITEM_RE.exec('item-3-descriptive-slug')?.[1], '3');
});

test('dispatch regex: no match on unrelated branch', () => {
  assert.equal(ITEM_RE.exec('main'), null);
  assert.equal(ITEM_RE.exec('idea/some-idea'), null);
});

// --- tree sort, mirrors stack-tree.mjs:116 ---
const itemNo = (name) => { const m = name.match(/(\d+)/); return m ? Number(m[1]) : Infinity; };

test('tree sorter: extracts item number from descriptive lane', () => {
  assert.equal(itemNo('auto/item-12-some-feature'), 12);
  assert.equal(itemNo('auto/item-104-another-feature'), 104);
  assert.ok(itemNo('auto/item-12-some-feature') < itemNo('auto/item-104-another-feature'));
});
