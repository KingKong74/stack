#!/usr/bin/env node
// Tests for `dueRead` in web/src/lib/ui.ts — how a board item's due date (#508)
// reads on a card.
// Run: node --experimental-strip-types scripts/due.test.mjs
//
// Same loader shim as scripts/spine.test.mjs: ui.ts is TypeScript living under
// web/, outside this repo's module graph, and imports its siblings with no
// extension. See that file's header for why both pieces are needed.
//
// WHY A PURE FUNCTION THIS SMALL EARNS A TEST FILE. Every assertion below is
// about a timezone trap that has already cost this repo something once —
// server/src/shape.js's `dayOf` exists because node-postgres parses a DATE at
// LOCAL midnight, and the obvious `toISOString().slice(0, 10)` served 13 Sep
// for a sprint starting on the 14th on this host (UTC+10). The same trap is on
// the client, mirrored:
//
//   • `new Date('2026-09-14')` is UTC midnight.
//   • `new Date(2026, 8, 14)` is LOCAL midnight.
//
// Subtract one from the other and you get a whole day of error, in a direction
// that depends on which side of Greenwich the viewer is on — so "due today"
// reads as overdue in Sydney and as due tomorrow in Los Angeles, and neither
// is reproducible on a CI box running UTC. `dueRead` therefore takes BOTH sides
// apart and reassembles them at UTC midnight, and these tests pin that by
// running the same day-differences at three offsets.
//
// The two rules that are not arithmetic:
//   • A DONE CARD NEVER SHOUTS. Work that landed late is not something to act
//     on, and red in the Done column is red where nothing needs doing.
//   • THE YEAR IS DROPPED when the due date is in the reader's own year, and
//     added back when it is not. A board is read at a glance.
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

const { dueRead } = await import(new URL('../web/src/lib/ui.ts', import.meta.url).href);

// "Today" as a LOCAL Date, which is what a browser hands in. Built from
// components so the fixture means the same day whatever TZ the runner is in.
const localDay = (y, m, d, hour = 12) => new Date(y, m - 1, d, hour, 0, 0);

test('no due date reads as nothing at all', () => {
  assert.equal(dueRead(null, false, localDay(2026, 9, 14)), null);
  assert.equal(dueRead(undefined, false, localDay(2026, 9, 14)), null);
  assert.equal(dueRead('', false, localDay(2026, 9, 14)), null);
});

test('a malformed date is not a deadline', () => {
  // The server clears these on the way in, but a stale payload or a hand-made
  // one can still carry one, and half a date must never be drawn as a date.
  for (const bad of ['2026-9-4', 'tomorrow', '2026-09', '14/09/2026', 'null']) {
    assert.equal(dueRead(bad, false, localDay(2026, 9, 14)), null, bad);
  }
});

test('TODAY is day zero, not overdue and not soon', () => {
  const r = dueRead('2026-09-14', false, localDay(2026, 9, 14));
  assert.equal(r.days, 0);
  assert.equal(r.tone, 'today');
  assert.match(r.title, /Due today/);
});

test('the boundaries of the three-day window', () => {
  const on = (d) => dueRead(`2026-09-${String(d).padStart(2, '0')}`, false, localDay(2026, 9, 14));
  assert.equal(on(13).tone, 'late');   // yesterday
  assert.equal(on(14).tone, 'today');
  assert.equal(on(15).tone, 'soon');   // +1
  assert.equal(on(17).tone, 'soon');   // +3, the last day inside the window
  assert.equal(on(18).tone, 'none');   // +4, outside it
  assert.equal(on(18).days, 4);
});

test('overdue counts the days and says so', () => {
  const r = dueRead('2026-09-04', false, localDay(2026, 9, 14));
  assert.equal(r.days, -10);
  assert.equal(r.tone, 'late');
  assert.match(r.title, /Overdue — was due 4 Sep, 10 days ago/);
});

test('ONE day reads as "day", not "days", both directions', () => {
  assert.match(dueRead('2026-09-13', false, localDay(2026, 9, 14)).title, /1 day ago/);
  assert.match(dueRead('2026-09-15', false, localDay(2026, 9, 14)).title, /Due in 1 day \(/);
});

test('A DONE CARD NEVER SHOUTS — it keeps the date and loses the tone', () => {
  const late = dueRead('2026-09-04', true, localDay(2026, 9, 14));
  assert.equal(late.tone, 'none');
  assert.equal(late.label, '4 Sep');
  assert.match(late.title, /^Was due 4 Sep$/);
  // …and that is true on the day it is due, too.
  assert.equal(dueRead('2026-09-14', true, localDay(2026, 9, 14)).tone, 'none');
});

test('the year is dropped in the reader\'s own year and kept outside it', () => {
  const today = localDay(2026, 9, 14);
  assert.equal(dueRead('2026-12-25', false, today).label, '25 Dec');
  assert.equal(dueRead('2027-01-04', false, today).label, '4 Jan 2027');
  assert.equal(dueRead('2025-12-31', false, today).label, '31 Dec 2025');
});

test('MONTH AND YEAR BOUNDARIES are days, not 30s and 365s', () => {
  assert.equal(dueRead('2026-10-01', false, localDay(2026, 9, 30)).days, 1);
  assert.equal(dueRead('2027-01-01', false, localDay(2026, 12, 31)).days, 1);
  // 2028 is a leap year: 29 Feb exists and is one day after the 28th.
  assert.equal(dueRead('2028-02-29', false, localDay(2028, 2, 28)).days, 1);
  assert.equal(dueRead('2028-03-01', false, localDay(2028, 2, 29)).days, 1);
});

test('THE TRAP ITSELF: the same day-difference on both sides of Greenwich', () => {
  // The whole reason this file exists. Each of these runs the identical
  // comparison with the process in a different zone; a `toISOString()` or a
  // `new Date(dueOn)` compared against a local-midnight "today" gives a
  // different answer in at least one of them.
  const orig = process.env.TZ;
  try {
    for (const tz of ['UTC', 'Australia/Sydney', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      const today = localDay(2026, 9, 14);
      assert.equal(dueRead('2026-09-14', false, today).days, 0, `today in ${tz}`);
      assert.equal(dueRead('2026-09-14', false, today).tone, 'today', `tone in ${tz}`);
      assert.equal(dueRead('2026-09-13', false, today).days, -1, `yesterday in ${tz}`);
      assert.equal(dueRead('2026-09-15', false, today).days, 1, `tomorrow in ${tz}`);
      assert.equal(dueRead('2026-09-14', false, today).label, '14 Sep', `label in ${tz}`);
    }
  } finally {
    if (orig === undefined) delete process.env.TZ; else process.env.TZ = orig;
  }
});

test('an hour late in the day does not roll the answer over', () => {
  // A browser hands in `new Date()`, which carries a time. Only the DAY may
  // count — 23:59 and 00:01 on the same date must agree.
  for (const hour of [0, 1, 12, 23]) {
    assert.equal(dueRead('2026-09-14', false, localDay(2026, 9, 14, hour)).days, 0, `hour ${hour}`);
  }
});
