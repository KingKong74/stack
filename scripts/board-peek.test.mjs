#!/usr/bin/env node
// Tests for web/src/lib/boardPeek.ts — which rows the terminal's board peek
// draws, under which column, and in what order.
// Run: node --experimental-strip-types scripts/board-peek.test.mjs
//
// The rules that matter: only board work is drawn (never Auto-ideas or the
// Icebox), a cluster's parts draw inside it, and To do is in run order.
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

const { peekGroups, planningSliceIds } = await import(new URL('../web/src/lib/boardPeek.ts', import.meta.url).href);

let n = 0;
const item = (o = {}) => ({
  id: ++n, title: `item ${n}`, note: '', done: false, bucket: 'medium', source: 'manual', reviewed: false,
  claimedBy: '', area: '', builtNote: '', reviewTag: '', listKey: '', archived: false,
  sliceId: 1, sliceRank: 0, ready: false, readyRank: 0, parentId: null, updatedAt: null, ...o,
});
const milestones = [{ id: 1, status: 'active' }, { id: 2, status: 'planned' }];
const slices = [
  { id: 1, milestoneId: 1, position: 2, archived: false },
  { id: 2, milestoneId: 1, position: 1, archived: false },
  { id: 3, milestoneId: 1, position: 0, archived: true },
  { id: 4, milestoneId: 2, position: 0, archived: false },
];
const keysOf = (gs) => Object.fromEntries(gs.map((g) => [g.key, g.rows.map((r) => r.item.id)]));

test('the current milestone\'s live slices, in position order', () => {
  assert.deepEqual(planningSliceIds(milestones, slices), [2, 1]);
  assert.deepEqual(planningSliceIds([{ id: 1, status: 'done' }], slices), []);
});

test('only board work: Auto-ideas and the Icebox stay off the peek', () => {
  const onBoard = item();
  const autoIdea = item({ sliceId: null, source: 'hook' });
  const iced = item({ sliceId: null, source: 'manual' });
  const archived = item({ archived: true });
  const ids = peekGroups([onBoard, autoIdea, iced, archived], milestones, slices).flatMap((g) => g.rows.map((r) => r.item.id));
  assert.deepEqual(ids, [onBoard.id]);
});

test('columns lead with what is moving, and To do runs in queue order', () => {
  const later = item({ sliceId: 1 });
  const sooner = item({ sliceId: 2 });
  const readyOne = item({ sliceId: 1, ready: true, readyRank: 1 });
  const going = item({ claimedBy: 'feat/x' });
  const built = item({ claimedBy: 'feat/y', builtNote: 'landed' });
  const gs = peekGroups([later, sooner, readyOne, going, built], milestones, slices);
  assert.deepEqual(gs.map((g) => g.key), ['progress', 'review', 'planned']);
  assert.deepEqual(keysOf(gs).planned, [readyOne.id, sooner.id, later.id]);
});

test('a cluster carries its parts and rolls its column up from them', () => {
  const cluster = item();
  const a = item({ parentId: cluster.id, claimedBy: 'feat/a' });
  const b = item({ parentId: cluster.id });
  const gs = peekGroups([cluster, a, b], milestones, slices);
  assert.deepEqual(keysOf(gs), { progress: [cluster.id] });
  assert.deepEqual(gs[0].rows[0].parts.map((p) => p.id), [a.id, b.id]);
});

test('the filter matches title, #id or area, and a matching part keeps its cluster', () => {
  const cluster = item({ title: 'Parent' });
  const part = item({ parentId: cluster.id, title: 'needle here' });
  const other = item({ area: 'terminal' });
  assert.deepEqual(peekGroups([cluster, part, other], milestones, slices, 'NEEDLE').flatMap((g) => g.rows.map((r) => r.item.id)), [cluster.id]);
  assert.deepEqual(peekGroups([cluster, part, other], milestones, slices, `#${other.id}`).flatMap((g) => g.rows.map((r) => r.item.id)), [other.id]);
  assert.deepEqual(peekGroups([cluster, part, other], milestones, slices, 'termin').flatMap((g) => g.rows.map((r) => r.item.id)), [other.id]);
});

test('Done reads newest first', () => {
  const old = item({ done: true, updatedAt: '2026-01-01T00:00:00Z' });
  const fresh = item({ done: true, updatedAt: '2026-11-01T00:00:00Z' });
  assert.deepEqual(keysOf(peekGroups([old, fresh], milestones, slices)).shipped, [fresh.id, old.id]);
});
