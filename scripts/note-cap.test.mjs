#!/usr/bin/env node
// Tests for capNote — the capped-OUT-LOUD free-text field (BUG-12).
// Run: node scripts/note-cap.test.mjs   (pure; no API, no DATABASE_URL)
//
// built_note is written once by the session that finishes an item and read by
// the human in the Review room and by both second-model passes. A silent slice
// at 2000 took the last paragraph off notes without any of those readers being
// told — and the tail of an account of what landed is exactly where it keeps
// what it could NOT finish, so the truncation removed the caveats and left the
// confident part.
//
// The property that matters is not "it cuts at 2000". It is that a reader can
// always TELL. That is why the marker names the true length, and why the tests
// below check the marker rather than the offset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capNote, NOTE_MAX } from '../server/src/util.js';

test('a note under the cap passes through untouched', () => {
  assert.equal(capNote('what landed, in one line'), 'what landed, in one line');
  assert.equal(capNote('  trimmed  '), 'trimmed');
});

test('an empty or absent note is empty, never the string "null"', () => {
  // Both writers coerce '' to SQL NULL with `|| null`, so this must be falsy.
  for (const v of [null, undefined, '', '   ']) assert.equal(capNote(v), '');
});

test('a note exactly at the cap is not marked — nothing was lost', () => {
  const exact = 'x'.repeat(NOTE_MAX);
  const out = capNote(exact);
  assert.equal(out, exact);
  assert.doesNotMatch(out, /truncated/);
});

test('one character over the cap IS marked', () => {
  const out = capNote('x'.repeat(NOTE_MAX + 1));
  assert.match(out, /truncated/);
});

test('the marker names the TRUE length, which is what says how much is missing', () => {
  const out = capNote('x'.repeat(5000));
  assert.match(out, /5000 characters/);
  assert.match(out, new RegExp(`first ${NOTE_MAX} are kept`));
  // The kept text really is the head of the original, in order.
  assert.ok(out.startsWith('x'.repeat(NOTE_MAX)));
});

test('the stored value is LONGER than the cap, because the marker rides with it', () => {
  // This is the trap that kept BUG-12 half-alive: a downstream reader that
  // re-cut at the same NOTE_MAX would slice the marker off the end and hide
  // the cap again. Anything re-capping built_note must allow headroom.
  const out = capNote('x'.repeat(5000));
  assert.ok(out.length > NOTE_MAX,
    'the marker must survive storage, or no reader can see the cap');
  assert.ok(out.length < NOTE_MAX + 200, 'and it must stay a marker, not a paragraph');
});

test('capping is idempotent — a stored note re-capped is not double-marked', () => {
  // Re-PATCHing a row with the value read back off it is an ordinary thing for
  // a session to do, and it must not stack markers.
  const once = capNote('x'.repeat(5000));
  const twice = capNote(once);
  assert.equal((twice.match(/truncated/g) || []).length, 1);
});
