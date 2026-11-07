#!/usr/bin/env node
// #616 — the spine section SessionStart injects (hook/spine-block.mjs). Pure:
//   node scripts/spine-block.test.mjs
// Pins the two things a session would otherwise get wrong: every cap is
// STATED, and "your slice" is the slice of the item THIS branch claimed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spineLines, GOAL_CAP, SPEC_CAP } from '../hook/spine-block.mjs';

const item = (o) => ({ id: 1, done: false, archived: false, claimedBy: '', builtNote: '', sliceId: null, ...o });
const base = () => ({
  charter: { id: 9, summary: 'Stack is a command centre.', truncated: false, cap: 600 },
  milestones: [{ id: 1, name: 'Beta', status: 'active', goal: '\nShip it to friends.\nMore.', targetOn: '2026-12-01' },
    { id: 2, name: 'Old', status: 'done', goal: '' }],
  slices: [{ id: 10, milestoneId: 1, title: 'Sign-up', spec: 'Magic links.', archived: false },
    { id: 11, milestoneId: 2, title: 'Done slice', spec: '', archived: false },
    { id: 12, milestoneId: 1, title: 'Archived', spec: '', archived: true }],
  roadmap: { high: [item({ id: 1, sliceId: 10, done: true }), item({ id: 2, sliceId: 10, claimedBy: 'feat/2-x' })], medium: [] },
});

test('charter, milestone and its live slices, with derived progress', () => {
  const out = spineLines(base(), 'main').join('\n');
  assert.match(out, /\*\*Charter:\*\* Stack is a command centre\./);
  assert.match(out, /\*\*Current milestone:\*\* Beta \(target 2026-12-01\): Ship it to friends\./, 'the first non-blank goal line');
  assert.match(out, /- Sign-up: 1\/2 built/);
  assert.doesNotMatch(out, /Done slice|Archived/, 'only the current milestone, only live slices');
});

test('a truncated charter says it is the opening and where the rest is', () => {
  const p = base(); p.charter.truncated = true;
  assert.match(spineLines(p, '').join('\n'), /its first 600 characters; the whole charter is on Stack → Charter/);
});

test('a long goal and a long spec state their caps', () => {
  const p = base();
  p.milestones[0].goal = 'g'.repeat(GOAL_CAP + 50);
  p.slices[0].spec = 's'.repeat(SPEC_CAP + 50);
  const out = spineLines(p, 'feat/2-x').join('\n');
  assert.match(out, new RegExp(`goal cut at ${GOAL_CAP} characters`));
  assert.match(out, new RegExp(`spec cut at ${SPEC_CAP} characters`));
});

test('your slice is the slice of the open item THIS branch claimed', () => {
  const out = spineLines(base(), 'feat/2-x').join('\n');
  assert.match(out, /\*\*Your slice\*\* \(slice 10; branch `feat\/2-x` holds #2\): Sign-up/, 'the id is printed, for /checkpoint');
  assert.match(out, /Magic links\./);
  assert.doesNotMatch(spineLines(base(), 'feat/other').join('\n'), /Your slice/);
  assert.doesNotMatch(spineLines(base(), 'HEAD').join('\n'), /Your slice/, 'a detached HEAD claims nothing');
});

test('a project with none of the spine adds nothing', () => {
  assert.deepEqual(spineLines({ roadmap: {} }, 'main'), []);
  assert.deepEqual(spineLines({}, 'main'), []);
});
