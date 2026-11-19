#!/usr/bin/env node
// Tests for web/src/lib/workMap.ts — the Board tab's work map model.
// Run: node --experimental-strip-types scripts/work-map.test.mjs
//
// Same loader shim as scripts/spine.test.mjs: workMap.ts is TypeScript under
// web/ and imports its siblings with no extension.
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

const {
  buildWorkMap, layoutMap, activeSet, ancestors, descendants, itemStatus, rollUp,
  itemKey, sliceKey, msKey, ROOT, laneBoard, laneMilestones, defaultLaneMilestone, stageOf: STAGE_OF,
} = await import(new URL('../web/src/lib/workMap.ts', import.meta.url).href);

let seq = 0;
function item(over = {}) {
  seq += 1;
  return {
    id: seq, title: `Item ${seq}`, note: '', done: false, bucket: 'medium',
    source: 'manual', reviewed: true, claimedBy: '', area: '', builtNote: '',
    reviewTag: '', reviewTags: [], refineNote: '', reviewShelved: false,
    skipped: false, skippedAt: null, risk: 'normal', riskSource: '', riskReason: '',
    sprintId: null, sprintRank: 0, sliceId: 1, sliceRank: 0, plan: [], spec: {},
    ready: false, readyRank: 0, updatedAt: null, createdAt: null, agentProfile: '',
    parentId: null, sched: null, baseline: null, labels: [], listKey: '',
    archived: false, estimate: null, points: null, dueOn: null, kind: '',
    flySession: '', testKind: '', testTarget: '', subArea: '', verdictSource: 'human',
    verdictAt: null, verdictEvidence: '', committed: false,
    ...over,
  };
}
const ms = (id, status, position) => ({ id, name: `M${id}`, goal: '', status, position, targetOn: null, startedAt: null, endedAt: null, createdAt: null, updatedAt: null });
const sl = (id, milestoneId, position, over = {}) => ({ id, milestoneId, title: `S${id}`, spec: '', areas: [], position, archived: false, createdAt: null, updatedAt: null, ...over });
const P = { slug: 'demo', name: 'Demo' };

test('statuses come from the kanban derivations, and Done is never "on main"', () => {
  assert.equal(itemStatus(item()), 'planned');
  assert.equal(itemStatus(item({ ready: true })), 'ready');
  assert.equal(itemStatus(item({ skipped: true })), 'parked');
  assert.equal(itemStatus(item({ claimedBy: 'term:stack-term-1' })), 'active');
  assert.equal(itemStatus(item({ claimedBy: 'feat/1-x', builtNote: 'did it' })), 'review');
  assert.equal(itemStatus(item({ done: true })), 'done');
  assert.equal(itemStatus(item({ source: 'fly', reviewed: false })), 'held');
  // a held row somebody has worked is no longer waiting on a sign-off
  assert.equal(itemStatus(item({ source: 'fly', reviewed: false, claimedBy: 'x' })), 'active');
});

test('a job rolls up from its tasks; an empty job is empty, not finished', () => {
  assert.equal(rollUp([]), 'empty');
  assert.equal(rollUp(['done', 'done']), 'done');
  assert.equal(rollUp(['done', 'review']), 'review');
  assert.equal(rollUp(['planned', 'done']), 'active');
  assert.equal(rollUp(['planned', 'ready']), 'ready');
  assert.equal(rollUp(['planned']), 'planned');
});

test('the tree: milestone → job → task → ticket, in position order', () => {
  const rows = [
    item({ id: 10, sliceId: 2 }),
    item({ id: 11, sliceId: 1 }),
    item({ id: 12, sliceId: 1, parentId: 11 }),
    item({ id: 13, sliceId: null, claimedBy: 'feat/13' }), // worked, no slice
    item({ id: 14, sliceId: null }),                         // Icebox
    item({ id: 15, sliceId: null, source: 'hook', reviewed: false }), // idea
    item({ id: 16, sliceId: 1, archived: true }),
  ];
  const map = buildWorkMap(P, rows, [ms(2, 'planned', 1), ms(1, 'active', 0)], [sl(2, 1, 1), sl(1, 1, 0), sl(3, 2, 0)]);
  assert.deepEqual(map.nodes.get(ROOT).kids, [msKey(1), msKey(2), itemKey(13)]);
  assert.deepEqual(map.nodes.get(msKey(1)).kids, [sliceKey(1), sliceKey(2)]);
  assert.equal(map.nodes.get(sliceKey(1)).ref, 'J1');
  assert.equal(map.nodes.get(sliceKey(3)).ref, 'J3');
  assert.deepEqual(map.nodes.get(sliceKey(1)).kids, [itemKey(11)]);
  assert.equal(map.nodes.get(itemKey(12)).type, 'ticket');
  assert.equal(map.nodes.get(itemKey(12)).parent, itemKey(11));
  assert.equal(map.nodes.has(itemKey(16)), false);
  assert.deepEqual(map.offMap, { iced: 1, ideas: 1 });
  assert.equal(map.nodes.get(sliceKey(3)).status, 'empty');
  assert.deepEqual(ancestors(map, itemKey(12)), [ROOT, msKey(1), sliceKey(1), itemKey(11)]);
  assert.deepEqual(descendants(map, sliceKey(1)), [itemKey(11), itemKey(12)]);
});

test('a task in an archived slice hangs off the project rather than vanishing', () => {
  const map = buildWorkMap(P, [item({ id: 1, sliceId: 9, claimedBy: 'x' })], [ms(1, 'active', 0)], [sl(9, 1, 0, { archived: true })]);
  assert.equal(map.nodes.get(itemKey(1)).parent, ROOT);
});

test('a term: claim names the session; focus keeps hot work and its ancestors lit', () => {
  const rows = [item({ id: 1, claimedBy: 'term:stack-term-abc' }), item({ id: 2 })];
  const map = buildWorkMap(P, rows, [ms(1, 'active', 0)], [sl(1, 1, 0)]);
  assert.equal(map.nodes.get(itemKey(1)).session, 'stack-term-abc');
  assert.equal(map.nodes.get(itemKey(2)).session, '');
  const hot = activeSet(map);
  assert.ok(hot.has(itemKey(1)) && hot.has(sliceKey(1)) && hot.has(msKey(1)) && hot.has(ROOT));
  assert.equal(hot.has(itemKey(2)), false);
});

test('layout places every visible node, and a fold hides what is under it', () => {
  const rows = [item({ id: 1 }), item({ id: 2, parentId: 1 })];
  const map = buildWorkMap(P, rows, [ms(1, 'active', 0)], [sl(1, 1, 0)]);
  const open = layoutMap(map, 'tree', () => false);
  assert.equal(open.pos.size, 5);
  const shut = layoutMap(map, 'tree', (k) => k === sliceKey(1));
  assert.equal(shut.pos.size, 3);
  assert.equal(shut.pos.get(sliceKey(1)).folded, true);
  const stage = layoutMap(map, 'stage', () => false);
  assert.equal(stage.heads.length, 5);
  assert.ok(stage.pos.has(itemKey(2)));
});

test('lanes: a lane per job of one milestone, plus loose work, split by stage', () => {
  const rows = [
    item({ id: 1, sliceId: 1 }),
    item({ id: 2, sliceId: 1, parentId: 1, done: true }),
    item({ id: 6, sliceId: 1, parentId: 1 }),
    item({ id: 3, sliceId: 2, claimedBy: 'feat/3' }),
    item({ id: 4, sliceId: 3, claimedBy: 'x', builtNote: 'built' }),
    item({ id: 5, sliceId: null, claimedBy: 'feat/5' }),
  ];
  const map = buildWorkMap(P, rows, [ms(1, 'done', 0), ms(2, 'active', 1)], [sl(1, 2, 0), sl(2, 2, 1), sl(3, 1, 0)]);
  assert.deepEqual(laneMilestones(map), [msKey(1), msKey(2)]);
  // opens on the current milestone, or on the selection's own
  assert.equal(defaultLaneMilestone(map, ROOT), msKey(2));
  assert.equal(defaultLaneMilestone(map, itemKey(4)), msKey(1));
  const b = laneBoard(map, msKey(2));
  assert.deepEqual(b.lanes.map((l) => l.key), [sliceKey(1), sliceKey(2), ROOT]);
  // a ticket is a card of its own, in its own stage, not its task's
  const j1 = b.lanes[0];
  const stage = (k) => j1.cols.findIndex((c) => c.includes(k));
  assert.equal(stage(itemKey(2)), 3);
  assert.equal(stage(itemKey(6)), 0);
  assert.equal(stage(itemKey(1)), STAGE_OF(map.nodes.get(itemKey(1)).status));
  assert.equal(j1.done, 1); assert.equal(j1.total, 3);
  assert.deepEqual(b.lanes[1].cols[1], [itemKey(3)]);
  assert.deepEqual(b.lanes[2].cols[1], [itemKey(5)]);
  assert.equal(b.counts.reduce((a, c) => a + c, 0), 5);
  assert.deepEqual(laneBoard(map, msKey(1)).lanes[0].cols[2], [itemKey(4)]);
  assert.deepEqual(laneBoard(map, null).lanes.map((l) => l.key), [ROOT]);
});
