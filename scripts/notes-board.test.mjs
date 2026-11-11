#!/usr/bin/env node
// Tests for web/src/lib/notesBoard.ts — the Notes canvas's geometry: where an
// unplaced note goes, the tidy view, cluster boxes, drop targets and pruning.
// Run: node --experimental-strip-types scripts/notes-board.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { place, tidy, clusterRects, hitTest, lonely, clusterName, outside, NOTE_W, PAD, HEAD, X0, Y0 } =
  await import(new URL('../web/src/lib/notesBoard.ts', import.meta.url).href);

const h = () => 100;

test('a placed note keeps its place; an unplaced one flows in below, never on top', () => {
  const p = place([{ id: 1, board: { x: 300, y: 50, w: 200 } }, { id: 2, board: {} }, { id: 3 }], h, 2);
  assert.deepEqual(p.find((n) => n.id === 1), { id: 1, x: 300, y: 50, w: 200, r: p[0].r, pinned: false, cluster: null });
  const two = p.find((n) => n.id === 2), three = p.find((n) => n.id === 3);
  assert.ok(two.y >= 150, 'below the placed note');
  assert.equal(two.x, X0);
  assert.equal(three.x, X0 + NOTE_W + 24, 'the next column');
  assert.ok(two.r >= -5 && two.r <= 5);
  assert.deepEqual(place([{ id: 9 }], h, 3)[0].y, Y0, 'an empty board starts at the top');
});

test('tidy gives each cluster a column, pinned first, and never writes a tilt', () => {
  const placed = place([
    { id: 1, board: { x: 900, y: 900, cluster: 'a' } },
    { id: 2, board: { x: 10, y: 10, cluster: 'a', pinned: true } },
    { id: 3, board: { x: 500, y: 500 } },
  ], h, 3);
  const t = tidy(placed, ['a'], h, 3);
  const [first, second] = t.filter((n) => n.cluster === 'a');
  assert.equal(first.id, 2, 'pinned first');
  assert.equal(first.x, second.x);
  assert.equal(first.y, Y0 + HEAD);
  assert.ok(t.every((n) => n.r === 0));
  assert.notEqual(t.find((n) => n.id === 3).x, first.x, 'a loose note is not in the cluster column');
});

test('a cluster box wraps its members with a margin and a name strip', () => {
  const placed = place([{ id: 1, board: { x: 100, y: 200, w: 200, cluster: 'a' } }, { id: 2, board: { x: 350, y: 260, w: 200, cluster: 'a' } }], h);
  assert.deepEqual(clusterRects(placed, h), [{ id: 'a', x: 100 - PAD, y: 200 - HEAD, w: 450 + 2 * PAD, h: 160 + HEAD + PAD }]);
});

test('a drop lands on the topmost note, else a cluster box, never on itself or its own cluster', () => {
  const placed = place([
    { id: 1, board: { x: 0, y: 0, w: 200 } },
    { id: 2, board: { x: 50, y: 50, w: 200 } },
    { id: 3, board: { x: 600, y: 600, w: 200, cluster: 'a' } },
    { id: 4, board: { x: 900, y: 600, w: 200, cluster: 'a' } },
    { id: 5, board: { x: 0, y: 900, w: 200 } },
  ], h);
  const rects = clusterRects(placed, h);
  const z = (id) => id;
  const self = placed.find((n) => n.id === 5);
  assert.deepEqual(hitTest({ x: 60, y: 60 }, self, placed, rects, h, z), { type: 'note', id: 2 }, 'topmost');
  assert.deepEqual(hitTest({ x: 610, y: 610 }, self, placed, rects, h, z), { type: 'cluster', id: 'a' }, 'a member means its cluster');
  assert.deepEqual(hitTest({ x: 850, y: 620 }, self, placed, rects, h, z), { type: 'cluster', id: 'a' }, 'the gap inside the box');
  assert.equal(hitTest({ x: 10, y: 910 }, self, placed, rects, h, z), null, 'never itself');
  const member = placed.find((n) => n.id === 3);
  assert.equal(hitTest({ x: 950, y: 620 }, member, placed, rects, h, z), null, 'never its own cluster');
  assert.ok(outside({ x: 0, y: 0 }, rects[0]) && !outside({ x: 700, y: 650 }, rects[0]));
  assert.ok(outside({ x: 0, y: 0 }, undefined));
});

test('a cluster of one is no cluster, and the name is the first member\'s that has one', () => {
  const notes = [
    { id: 4, board: { cluster: 'a', clusterName: 'Later' } },
    { id: 2, board: { cluster: 'a' } },
    { id: 3, board: { cluster: 'b', clusterName: 'Alone' } },
    { id: 1, board: {} },
  ];
  assert.deepEqual(lonely(notes), [3]);
  assert.equal(clusterName(notes, 'a'), 'Later');
  assert.equal(clusterName(notes, 'zz'), '');
});
