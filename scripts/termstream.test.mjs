#!/usr/bin/env node
// Regression checks for deferred terminal output and per-connection sizing.
// Run: node --experimental-strip-types scripts/termstream.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTermWrites, createTermSizeSender } from '../web/src/lib/termStream.ts';

// Keep retired callbacks callable: cancelling a frame alone must not be the
// protection against a reconnect racing a callback already dispatched.
let next = 0;
const frames = new Map();
globalThis.requestAnimationFrame = (cb) => { frames.set(++next, cb); return next; };
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
const tick = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb()); };
const encode = (s) => new TextEncoder().encode(s);
const decode = (bytes) => new TextDecoder().decode(bytes);

test('split control sequences and UTF-8 bytes retain their exact order', () => {
  const painted = [];
  const q = createTermWrites((b) => painted.push(b), () => true);
  const bytes = encode('\x1b[2J\x1b[Hthinking…');
  for (const b of bytes) q.push(Uint8Array.of(b));
  assert.equal(painted.length, 0);
  tick();
  assert.deepEqual(painted, [bytes]);
  q.dispose();
});

test('retired connection cannot repaint over a new connection', () => {
  const painted = [];
  const old = createTermWrites((b) => painted.push(decode(b)), () => true);
  old.push(encode('old line\r\n'));
  const stale = [...frames.values()][0];
  old.dispose();
  const fresh = createTermWrites((b) => painted.push(decode(b)), () => true);
  fresh.push(encode('\x1bcnew screen'));
  tick();
  stale();
  old.push(encode('late old data'));
  assert.deepEqual(painted, ['\x1bcnew screen']);
  fresh.dispose();
});

test('a superseded connection is rejected even before disposal', () => {
  let current = true;
  const painted = [];
  const q = createTermWrites((b) => painted.push(b), () => current);
  q.push(encode('stale'));
  current = false;
  tick();
  assert.equal(painted.length, 0);
  q.dispose();
});

test('flush preserves final output before an exit notice', () => {
  const painted = [];
  const q = createTermWrites((b) => painted.push(decode(b)), () => true);
  q.push(encode('last words'));
  q.flush();
  painted.push('[ended]');
  tick();
  assert.deepEqual(painted, ['last words', '[ended]']);
  q.dispose();
});

test('hidden tabs flush without an animation frame', async () => {
  const painted = [];
  const q = createTermWrites((b) => painted.push(decode(b)), () => true);
  q.push(encode('background output'));
  await new Promise((r) => setTimeout(r, 130));
  assert.deepEqual(painted, ['background output']);
  assert.equal(frames.size, 0);
  q.dispose();
});

test('a burst bounds pending bytes without waiting for either clock', () => {
  const painted = [];
  const q = createTermWrites((b) => painted.push(b.length), () => true);
  q.push(new Uint8Array(256 * 1024));
  assert.deepEqual(painted, [256 * 1024]);
  q.dispose();
});

test('focus changes and repeated fits do not resize an unchanged host grid', () => {
  const sent = [];
  const sizes = createTermSizeSender((c, r) => { sent.push([c, r]); return true; });
  sizes.seed(100, 30);
  sizes.update(100, 30);
  sizes.update(152, 22);
  sizes.update(152, 22);
  sizes.update(0, 0);
  sizes.update(NaN, 22);
  sizes.update(100.5, 22);
  assert.deepEqual(sent, [[152, 22]]);
});

test('a new socket gets its own grid and retries a failed send', () => {
  let connected = false;
  const sent = [];
  const sizes = createTermSizeSender((c, r) => {
    if (!connected) return false;
    sent.push([c, r]); return true;
  });
  sizes.seed(100, 30);
  sizes.update(152, 22);
  connected = true;
  sizes.update(152, 22);
  sizes.seed(100, 30); // reconnect's start dimensions
  sizes.update(152, 22);
  assert.deepEqual(sent, [[152, 22], [152, 22]]);
});
