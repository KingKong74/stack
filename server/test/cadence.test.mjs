#!/usr/bin/env node
// util.pushCadence — the Overview spine's 28-day push strip (design 4a).
//
// Pure, no database: run with `node server/test/cadence.test.mjs`.
//
// The bug this pins is a timezone one, and it is invisible until it isn't. The
// buckets are UTC days, and a browser in Sydney (UTC+10/+11) that built its own
// 28 slots from its local calendar would file every push made before 10am local
// into the previous day's bar — so the strip would show "quiet today" through
// most of a working morning. Zero-filling therefore happens HERE, against the
// same UTC basis the SQL grouped on, and `today` is injectable so a test can
// stand somewhere other than now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushCadence } from '../src/util.js';

const AT = new Date('2026-08-09T04:30:00Z');

test('returns one bucket per day, oldest first, ending today', () => {
  const days = pushCadence([], 28, AT);
  assert.equal(days.length, 28);
  assert.equal(days[0].day, '2026-07-13');
  assert.equal(days[27].day, '2026-08-09');
  assert.equal(days.every((d) => d.n === 0), true);
});

test('a day the project pushed carries its count; every other day is a real zero', () => {
  const days = pushCadence([{ d: '2026-08-01', n: 27 }, { d: '2026-08-02', n: 19 }], 28, AT);
  const byDay = Object.fromEntries(days.map((d) => [d.day, d.n]));
  assert.equal(byDay['2026-08-01'], 27);
  assert.equal(byDay['2026-08-02'], 19);
  assert.equal(byDay['2026-08-03'], 0);
  assert.equal(days.reduce((n, d) => n + d.n, 0), 46);
});

test('the window is inclusive of today whatever hour it is', () => {
  // Just after midnight UTC and just before it must both end on the same day —
  // an off-by-one here silently drops the most recent push from the strip.
  for (const at of ['2026-08-09T00:00:01Z', '2026-08-09T23:59:59Z']) {
    const days = pushCadence([{ d: '2026-08-09', n: 4 }], 28, new Date(at));
    assert.equal(days[27].day, '2026-08-09');
    assert.equal(days[27].n, 4, at);
  }
});

test('rows outside the window are ignored rather than folded into an edge bucket', () => {
  // The SQL already windows to 28 days, but a stale row must not pile onto the
  // first bar and invent a burst the project never had.
  const days = pushCadence([{ d: '2026-01-01', n: 99 }], 28, AT);
  assert.equal(days.reduce((n, d) => n + d.n, 0), 0);
});

test('counts survive arriving as strings from pg', () => {
  const days = pushCadence([{ d: '2026-08-05', n: '7' }], 28, AT);
  assert.equal(days.find((d) => d.day === '2026-08-05').n, 7);
});
