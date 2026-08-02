#!/usr/bin/env node
// Tests for autopilot lane naming and the two-spelling branch parser.
// Run: node scripts/lane.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchSlug, branchKind, laneFor, bugLaneFor, auditLaneFor, parseBranch, isLaneBranch } from './lib/lane.mjs';

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

// --- branchKind (#363) ---

test('branchKind: a plain want is a feature', () => {
  assert.equal(branchKind({ title: 'Add dark mode support' }), 'feat');
  assert.equal(branchKind({ title: 'House-wide merge list' }), 'feat');
});

test('branchKind: repair language wins over everything else', () => {
  assert.equal(branchKind({ title: 'Fix the spacing on the roadmap card' }), 'fix');
  assert.equal(branchKind({ title: 'Terminal crashes on resize' }), 'fix');
});

test('branchKind: the other prefixes', () => {
  assert.equal(branchKind({ title: 'Speed up the control payload' }), 'perf');
  assert.equal(branchKind({ title: 'Refactor the run ledger shapes' }), 'refactor');
  assert.equal(branchKind({ title: 'Add coverage for the merge waves' }), 'test');
  assert.equal(branchKind({ title: 'Update the README' }), 'docs');
  assert.equal(branchKind({ title: 'Bump the node dependencies' }), 'chore');
  assert.equal(branchKind({ title: 'New layout for the Futures sky' }), 'ui');
});

test('branchKind: the area is read too, not just the title', () => {
  assert.equal(branchKind({ title: 'Merge room', area: 'ui' }), 'ui');
});

// --- laneFor ---

test('laneFor: a feature item', () => {
  assert.equal(laneFor({ id: 42, title: 'Add dark mode' }), 'feat/42-add-dark-mode');
});

test('laneFor: the kind comes from the title', () => {
  assert.equal(laneFor({ id: 99, title: 'Fix the stale merge probe' }), 'fix/99-fix-the-stale-merge-probe');
});

test('laneFor: item 224 title slug still truncates and never trails a hyphen', () => {
  const lane = laneFor({ id: 224, title: 'Descriptive branch names on autopilot runs' });
  assert.equal(lane, 'feat/224-descriptive-branch-names-on-au');
  assert.ok(!lane.endsWith('-'), `lane ends with hyphen: ${lane}`);
});

test('laneFor: empty slug falls back to <kind>/<id>', () => {
  assert.equal(laneFor({ id: 7, title: '!!! ---' }), 'feat/7');
});

test('bugLaneFor / auditLaneFor', () => {
  assert.equal(bugLaneFor({ id: 'BUG-12', title: 'Terminal hangs on paste' }), 'fix/bug-12-terminal-hangs-on-paste');
  assert.equal(bugLaneFor({ id: 'BUG-3', title: '!!!' }), 'fix/bug-3');
  assert.equal(auditLaneFor('20260802'), 'test/audit-20260802');
});

// The one collision worth pinning: roadmap item 12 and BUG-12 are both fixes.
test('a bug lane never collides with the roadmap item of the same number', () => {
  assert.notEqual(bugLaneFor({ id: 'BUG-12', title: 'Broken thing' }),
    laneFor({ id: 12, title: 'Broken thing' }));
});

// --- parseBranch: BOTH spellings, forever ---

test('parseBranch: the current convention', () => {
  const p = parseBranch('feat/314-include-orbited-items');
  assert.deepEqual(p, { kind: 'feat', itemId: 314, bugKey: '', summary: 'include-orbited-items', legacy: false });
});

test('parseBranch: a bug lane', () => {
  const p = parseBranch('fix/bug-12-terminal-hangs');
  assert.equal(p.kind, 'fix');
  assert.equal(p.bugKey, 'BUG-12');
  assert.equal(p.itemId, null);
});

test('parseBranch: an audit lane', () => {
  assert.equal(parseBranch('test/audit-20260802').kind, 'test');
});

test('parseBranch: the legacy auto/item-N spelling still resolves its item', () => {
  const p = parseBranch('auto/item-271-mission-control-the-cross-proj');
  assert.equal(p.itemId, 271);
  assert.equal(p.legacy, true);
  // A legacy lane genuinely does not record a kind, and '' must not be
  // silently upgraded to 'feat' — the room shows it as unlabelled instead.
  assert.equal(p.kind, '');
});

test('parseBranch: legacy numeric-only and legacy bug/audit lanes', () => {
  assert.equal(parseBranch('auto/item-7').itemId, 7);
  assert.equal(parseBranch('auto/bug-9-thing').bugKey, 'BUG-9');
  assert.equal(parseBranch('auto/audit-20260101').kind, 'test');
  assert.equal(parseBranch('lane/item-3-x').itemId, 3);
});

test('parseBranch: a kind with no id still yields the kind', () => {
  const p = parseBranch('ui/merge-room');
  assert.equal(p.kind, 'ui');
  assert.equal(p.itemId, null);
});

test('parseBranch: unrelated branches say nothing rather than guessing', () => {
  for (const name of ['main', 'idea/some-idea', '', 'wip']) {
    const p = parseBranch(name);
    assert.equal(p.kind, '', `${name} claimed a kind`);
    assert.equal(p.itemId, null, `${name} claimed an item`);
  }
});

test('isLaneBranch: what the tree groups and the Merge room lists', () => {
  assert.ok(isLaneBranch('feat/42-x'));
  assert.ok(isLaneBranch('auto/item-42-x'));
  assert.ok(!isLaneBranch('main'));
  assert.ok(!isLaneBranch('idea/some-idea'));
});

// --- tree sort, mirrors stack-tree.mjs ---
const itemNo = (name) => { const m = name.match(/(\d+)/); return m ? Number(m[1]) : Infinity; };

test('tree sorter: extracts the item number from both spellings', () => {
  assert.equal(itemNo('feat/12-some-feature'), 12);
  assert.equal(itemNo('auto/item-104-another-feature'), 104);
  assert.ok(itemNo('feat/12-some-feature') < itemNo('auto/item-104-another-feature'));
});
