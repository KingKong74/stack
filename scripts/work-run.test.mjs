// terminal/work-run.mjs — the host-side work timer. Run: node scripts/work-run.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { trackRun, runWorking, encodeRun, decodeRun, RUN_GAP_MS } from '../terminal/work-run.mjs';

const T = 1_700_000_000_000;

test('the first read is a baseline, never work', () => {
  assert.deepEqual(trackRun(undefined, 'a', T), { sig: 'a', start: 0, last: 0 });
  // a run restored after a daemon restart carries no signature: baseline too
  assert.deepEqual(trackRun({ start: T - 9e5, last: T - 6e5 }, 'a', T), { sig: 'a', start: T - 9e5, last: T - 6e5 });
});

test('a changing pane is one run; a long still pane ends it', () => {
  let r = trackRun(undefined, 'a', T);
  r = trackRun(r, 'b', T + 20_000);
  assert.deepEqual([r.start, r.last], [T + 20_000, T + 20_000]);
  r = trackRun(r, 'c', T + 40_000);
  r = trackRun(r, 'c', T + 60_000);           // one still read inside the gap
  r = trackRun(r, 'd', T + 80_000);
  assert.deepEqual([r.start, r.last], [T + 20_000, T + 80_000]);
  assert.equal(runWorking(r, T + 80_000 + RUN_GAP_MS), true);
  assert.equal(runWorking(r, T + 80_001 + RUN_GAP_MS), false);
  // still for minutes: the run is kept as it was
  r = trackRun(r, 'd', T + 600_000);
  assert.deepEqual([r.start, r.last], [T + 20_000, T + 80_000]);
  // then work again: a new run
  r = trackRun(r, 'e', T + 620_000);
  assert.deepEqual([r.start, r.last], [T + 620_000, T + 620_000]);
});

test('the stored option round-trips, and junk reads as no run', () => {
  assert.deepEqual(decodeRun(encodeRun({ start: T, last: T + 5 })), { start: T, last: T + 5 });
  for (const v of ['', '#{@stack-run}', 'x:y', `${T + 5}:${T}`, undefined]) assert.equal(decodeRun(v), null);
});
