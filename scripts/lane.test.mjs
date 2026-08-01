#!/usr/bin/env node
// Tests for autopilot lane naming and item-ID extraction from branch names.
// Run: node scripts/lane.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchSlug, laneFor, laneForBug, laneForAudit, freeBranchName } from './lib/lane.mjs';

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

test('branchSlug: leading hyphens collapse rather than survive at the front', () => {
  const slug = branchSlug('-- fixed');
  assert.equal(slug, 'fixed');
  assert.ok(!slug.startsWith('-'), `slug looks like a CLI flag: ${slug}`);
});

test('branchSlug: never contains a ".." run', () => {
  assert.ok(!branchSlug('a..b').includes('..'));
});

test('branchSlug: a bare "@" returns empty, not a lone punctuation slug', () => {
  assert.equal(branchSlug('@'), '');
});

test('branchSlug: general shape invariant holds for nasty inputs', () => {
  const SAFE_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  const nasty = ['-- fixed', 'a..b', '@', '---', '..', '-a-', '  --  ', 'feat/foo: bar!!', '@@@---@@@'];
  for (const input of nasty) {
    const slug = branchSlug(input);
    assert.ok(slug === '' || SAFE_SHAPE.test(slug), `unsafe slug shape for ${JSON.stringify(input)}: ${JSON.stringify(slug)}`);
  }
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

// --- laneForBug ---

test('laneForBug: basic bug matches the old inline auto/bug-N-<slug> format', () => {
  const lane = laneForBug({ id: 'BUG-12', title: 'Login form loses focus on retry' });
  assert.equal(lane, 'auto/bug-12-login-form-loses-focus-on-retr');
  assert.ok(lane.startsWith('auto/bug-12-'), `lane lost the key: ${lane}`);
});

test('laneForBug: title that slugs to empty falls back to the key alone', () => {
  assert.equal(laneForBug({ id: 'BUG-3', title: '!!! ---' }), 'auto/bug-3');
});

// --- laneForAudit ---

test('laneForAudit: with a scope', () => {
  assert.equal(laneForAudit('20260802', 'control'), 'auto/audit-20260802-control');
});

test('laneForAudit: without a scope', () => {
  assert.equal(laneForAudit('20260802', ''), 'auto/audit-20260802');
});

test('laneForAudit: a scope that slugs to empty behaves as no scope', () => {
  assert.equal(laneForAudit('20260802', '!!!'), 'auto/audit-20260802');
});

// --- freeBranchName ---

test('freeBranchName: returns the name as-is when free', () => {
  assert.equal(freeBranchName('auto/audit-20260802', () => false), 'auto/audit-20260802');
});

test('freeBranchName: first collision resolves to -2', () => {
  const taken = new Set(['auto/audit-20260802']);
  assert.equal(freeBranchName('auto/audit-20260802', (n) => taken.has(n)), 'auto/audit-20260802-2');
});

test('freeBranchName: -2 also taken resolves to -3', () => {
  const taken = new Set(['auto/audit-20260802', 'auto/audit-20260802-2']);
  assert.equal(freeBranchName('auto/audit-20260802', (n) => taken.has(n)), 'auto/audit-20260802-3');
});

test('freeBranchName: every slot taken up to the cap throws', () => {
  assert.throws(
    () => freeBranchName('auto/audit-20260802', () => true, 3),
    /auto\/audit-20260802/,
  );
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

// A collision suffix (freeBranchName's -2, -3, …) must stay invisible to anything that
// reads the item id out of a branch name.
test('dispatch regex: collision suffix does not change the extracted id', () => {
  assert.equal(ITEM_RE.exec('auto/item-42-add-dark-mode-2')?.[1], '42');
});

test('dispatch regex: suffix as the only thing after a slugless id', () => {
  assert.equal(ITEM_RE.exec('auto/item-7-2')?.[1], '7');
});

// --- tree sort, mirrors stack-tree.mjs:116 ---
const itemNo = (name) => { const m = name.match(/(\d+)/); return m ? Number(m[1]) : Infinity; };

test('tree sorter: extracts item number from descriptive lane', () => {
  assert.equal(itemNo('auto/item-12-some-feature'), 12);
  assert.equal(itemNo('auto/item-104-another-feature'), 104);
  assert.ok(itemNo('auto/item-12-some-feature') < itemNo('auto/item-104-another-feature'));
});

// A collision suffix must stay invisible to the sort too — it must not be mistaken for a
// second, later number in the name.
test('tree sorter: collision suffix does not shift where a lane sorts', () => {
  assert.equal(itemNo('auto/item-12-some-feature-2'), 12);
});
