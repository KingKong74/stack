#!/usr/bin/env node
// Tests for web/src/lib/termSwarm.ts — the Terminal screen's Swarm view:
// window snapping, tile status and the hand-made tile order.
// Run: node --experimental-strip-types scripts/termswarm.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  zoneRect, zoneAt, tileRects, clampRect, tileStatus, agoLabel, orderTiles, moveKey, compactLines,
  WORKING_MS, advanceRun, runLabel, spanLabel, RUN_GRACE_MS,
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

test('a coloured peek narrows like the plain one and keeps its colours', async () => {
  const { compactRich, paletteColour } = await import(new URL('../web/src/lib/termSwarm.ts', import.meta.url).href);
  const rows = [[], [{ t: 'ok ', c: 'red' }, { t: '   ' }], [], [], [{ t: 'b' }], [], []];
  assert.deepEqual(compactRich(rows), [[{ t: 'ok', c: 'red' }], [], [{ t: 'b' }]]);
  assert.equal(paletteColour(1, { red: '#bf0000' }), '#bf0000');
  assert.equal(paletteColour(196, {}), '#ff0000');
  assert.equal(paletteColour(232, {}), '#080808');
});

test('a run of work: starts on work, spans short pauses, ends on a long stop', () => {
  let r = advanceRun(undefined, false, 0, 1000);
  assert.equal(r, undefined);
  r = advanceRun(r, true, 10_000, 10_000);
  assert.deepEqual(r, { start: 10_000, last: 10_000 });
  r = advanceRun(r, true, 30_000, 31_000);
  assert.deepEqual(r, { start: 10_000, last: 30_000 });
  // stopped: the run is kept as it was
  assert.deepEqual(advanceRun(r, false, 30_000, 200_000), r);
  // a pause inside the grace stays the same run
  r = advanceRun(r, true, 30_000 + RUN_GRACE_MS, 30_000 + RUN_GRACE_MS);
  assert.equal(r.start, 10_000);
  // a longer stop starts a new run
  const n = advanceRun(r, true, r.last + RUN_GRACE_MS + 1, r.last + RUN_GRACE_MS + 1);
  assert.equal(n.start, r.last + RUN_GRACE_MS + 1);
});

test('the timer reads elapsed while working, and the last run once stopped', () => {
  const r = { start: 0, last: 185_000 };
  assert.equal(runLabel(r, true, 200_000), '3m');
  assert.equal(runLabel(r, false, 999_000), 'worked 3m');
  assert.equal(runLabel({ start: 0, last: 2_000 }, false, 9_000), '');
  assert.equal(runLabel(undefined, true, 9_000), '');
  assert.equal(spanLabel(42_000), '42s');
  assert.equal(spanLabel(3_840_000), '1h 4m');
});

test('the host run wins; a tab only sharpens it where they overlap', async () => {
  const { pickRun } = await import(new URL('../web/src/lib/termSwarm.ts', import.meta.url).href);
  const host = { start: 1_000_000, last: 1_600_000, working: false };
  // no host run: the tab's own
  assert.deepEqual(pickRun(null, { start: 5, last: 9 }, true), { run: { start: 5, last: 9 }, working: true });
  // reopened long after: the tab's attach burst is not a run, the host's last run is
  assert.deepEqual(pickRun(host, { start: 9_000_000, last: 9_000_100 }, true), { run: { start: 1_000_000, last: 1_600_000 }, working: false });
  // overlapping: one run, the wider span
  assert.deepEqual(pickRun({ ...host, working: true }, { start: 1_590_000, last: 1_610_000 }, true),
    { run: { start: 1_000_000, last: 1_610_000 }, working: true });
});
