#!/usr/bin/env node
// Tests for autopilot lane naming and item-ID extraction from branch names.
// Run: node scripts/lane.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchSlug, laneFor, lockFor } from './lib/lane.mjs';

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

// --- lockFor ---

test('lockFor: pinned item', () => {
  assert.equal(lockFor({ slug: 'stack', itemId: 265, kind: 'build' }), 'autopilot-stack-item-265.lock');
});

test('lockFor: unpinned build night', () => {
  assert.equal(lockFor({ slug: 'stack', itemId: null, kind: 'build' }), 'autopilot-stack-build.lock');
});

test('lockFor: plan sweep', () => {
  assert.equal(lockFor({ slug: 'stack', itemId: null, kind: 'plan' }), 'autopilot-stack-plan.lock');
});

test('lockFor: audit night', () => {
  assert.equal(lockFor({ slug: 'stack', itemId: null, kind: 'audit' }), 'autopilot-stack-audit.lock');
});

test('lockFor: debug night', () => {
  assert.equal(lockFor({ slug: 'stack', itemId: undefined, kind: 'debug' }), 'autopilot-stack-debug.lock');
});

test('lockFor: numeric-string itemId still pins', () => {
  assert.equal(lockFor({ slug: 'stack', itemId: '265', kind: 'build' }), 'autopilot-stack-item-265.lock');
});

test('lockFor: itemId 0 is not a pin', () => {
  assert.equal(lockFor({ slug: 'stack', itemId: 0, kind: 'build' }), 'autopilot-stack-build.lock');
});

test('lockFor: itemId null is not a pin', () => {
  assert.equal(lockFor({ slug: 'stack', itemId: null, kind: 'build' }), 'autopilot-stack-build.lock');
});

test('lockFor: itemId undefined is not a pin', () => {
  assert.equal(lockFor({ slug: 'stack', itemId: undefined, kind: 'build' }), 'autopilot-stack-build.lock');
});

test('lockFor: negative itemId is not a pin', () => {
  assert.equal(lockFor({ slug: 'stack', itemId: -5, kind: 'build' }), 'autopilot-stack-build.lock');
});

test('lockFor: slug with spaces and capitals is sanitised', () => {
  assert.equal(lockFor({ slug: 'My Project', itemId: null, kind: 'build' }), 'autopilot-my-project-build.lock');
});

test('lockFor: empty slug falls back to unknown', () => {
  assert.equal(lockFor({ slug: '', itemId: null, kind: 'build' }), 'autopilot-unknown-build.lock');
});

test('lockFor: empty/missing kind falls back to build', () => {
  assert.equal(lockFor({ slug: 'stack', itemId: null, kind: '' }), 'autopilot-stack-build.lock');
  assert.equal(lockFor({ slug: 'stack', itemId: null }), 'autopilot-stack-build.lock');
});

test('lockFor: dispatcher and runner spellings agree for a pinned job', () => {
  // The dispatcher computes its lock from job.slug/job.itemId/sessionKind; the
  // runner computes its own from SLUG/ITEM_ID/KIND for the same job. Same
  // inputs must produce the exact same filename on both sides of the fork.
  const job = { slug: 'stack', itemId: 265, sessionKind: 'build' };
  const dispatcherLock = lockFor({ slug: job.slug, itemId: job.itemId, kind: job.sessionKind || 'build' });
  const runnerLock = lockFor({ slug: 'stack', itemId: 265, kind: 'build' });
  assert.equal(dispatcherLock, runnerLock);
  assert.equal(dispatcherLock, 'autopilot-stack-item-265.lock');
});

test('lockFor: dispatcher and runner spellings agree for an unpinned plan job', () => {
  const job = { slug: 'stack', itemId: null, sessionKind: 'plan' };
  const dispatcherLock = lockFor({ slug: job.slug, itemId: job.itemId, kind: job.sessionKind || 'build' });
  const runnerLock = lockFor({ slug: 'stack', itemId: null, kind: 'plan' });
  assert.equal(dispatcherLock, runnerLock);
  assert.equal(dispatcherLock, 'autopilot-stack-plan.lock');
});

// --- tree sort, mirrors stack-tree.mjs:116 ---
const itemNo = (name) => { const m = name.match(/(\d+)/); return m ? Number(m[1]) : Infinity; };

test('tree sorter: extracts item number from descriptive lane', () => {
  assert.equal(itemNo('auto/item-12-some-feature'), 12);
  assert.equal(itemNo('auto/item-104-another-feature'), 104);
  assert.ok(itemNo('auto/item-12-some-feature') < itemNo('auto/item-104-another-feature'));
});
