#!/usr/bin/env node
// Tests for web/src/lib/termSwarm.ts — the Terminal screen's Swarm view:
// window snapping, tile status and the hand-made tile order.
// Run: node --experimental-strip-types scripts/termswarm.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  zoneRect, zoneAt, tileRects, clampRect, tileStatus, agoLabel, orderTiles, moveKey, compactLines,
  WORKING_MS,
} = await import(new URL('../web/src/lib/termSwarm.ts', import.meta.url).href);

const A = { x: 0, y: 100, w: 1000, h: 600 };

test('snap zones split the area with an 8px gutter', () => {
  assert.deepEqual(zoneRect('max', A), { x: 8, y: 108, w: 984, h: 584 });
  const l = zoneRect('left', A), r = zoneRect('right', A);
  assert.equal(l.w, r.w);
  assert.equal(r.x - (l.x + l.w), 8);
  assert.equal(zoneRect('br', A).y, zoneRect('bottom', A).y);
});

test('a pointer near an edge asks for a zone; the middle asks for none', () => {
  assert.equal(zoneAt(500, 400, A), null);
  assert.equal(zoneAt(5, 400, A), 'left');
  assert.equal(zoneAt(5, 110, A), 'tl');
  assert.equal(zoneAt(995, 690, A), 'br');
  assert.equal(zoneAt(500, 105, A), 'max');
  assert.equal(zoneAt(500, 695, A), 'bottom');
});

test('tiling: named shapes to four, a grid past it', () => {
  assert.equal(tileRects(3, A).length, 3);
  assert.deepEqual(tileRects(1, A)[0], zoneRect('max', A));
  const six = tileRects(6, A);
  assert.equal(six.length, 6);
  assert.ok(six.every((r) => r.x >= A.x && r.x + r.w <= A.x + A.w));
});

test('a window is kept inside the area and above the minimum size', () => {
  const r = clampRect({ x: -50, y: 0, w: 10, h: 5000 }, A);
  assert.ok(r.x >= 8 && r.y >= 108);
  assert.equal(r.w, 320);
  assert.equal(r.h, 584);
});

test('status leans towards idle: no evidence of output is not working', () => {
  const now = 1_000_000;
  assert.equal(tileStatus({ asking: true, failed: true, activeAt: now, now, windowMs: WORKING_MS }), 'asking');
  assert.equal(tileStatus({ asking: false, failed: true, activeAt: now, now, windowMs: WORKING_MS }), 'error');
  assert.equal(tileStatus({ asking: false, failed: false, activeAt: now - 1000, now, windowMs: WORKING_MS }), 'working');
  assert.equal(tileStatus({ asking: false, failed: false, activeAt: now - WORKING_MS, now, windowMs: WORKING_MS }), 'idle');
  assert.equal(tileStatus({ asking: false, failed: false, activeAt: 0, now, windowMs: WORKING_MS }), 'idle', 'unknown is idle');
});

test('ago labels', () => {
  assert.equal(agoLabel(0, 5), '');
  assert.equal(agoLabel(1000, 30_000), 'now');
  assert.equal(agoLabel(0 + 1, 1 + 5 * 60_000), '5m');
  assert.equal(agoLabel(1, 1 + 3 * 3600_000), '3h');
});

test('tile order: placed keys first, new ones after in natural order', () => {
  const t = (k) => ({ key: k });
  assert.deepEqual(orderTiles([t('a'), t('b'), t('c'), t('d')], ['c', 'a']).map((x) => x.key), ['c', 'a', 'b', 'd']);
  assert.deepEqual(moveKey(['a', 'b', 'c'], 'a', 'c'), ['b', 'c', 'a'], 'dragging forward lands after the target');
  assert.deepEqual(moveKey(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b'], 'dragging back lands before it');
  assert.deepEqual(moveKey(['a', 'b', 'c'], 'a', null), ['b', 'c', 'a'], 'the empty slot is the end');
  assert.deepEqual(moveKey(['a', 'b'], 'x', 'a'), ['a', 'b'], 'an unknown key changes nothing');
});

test('compact lines mirror the host preview', () => {
  assert.deepEqual(compactLines(['', 'a  ', '', '', 'b', '', '']), ['a', '', 'b']);
  assert.equal(compactLines(Array.from({ length: 30 }, (_, i) => `x${i}`), 5).length, 5);
});
