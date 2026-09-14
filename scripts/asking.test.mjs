#!/usr/bin/env node
// Tests for web/src/lib/asking.ts — the pure half of "a session is asking",
// the reader behind the project rail's foot and the topbar chip.
// Run: node --experimental-strip-types scripts/asking.test.mjs
//
// Same loader shim as scripts/spine.test.mjs: asking.ts is TypeScript living
// under web/, outside this repo's module graph, and imports its siblings with
// no extension. See that file's header for why both pieces are needed.
//
// WHAT IS WORTH PINNING HERE is narrow and specific. The surfaces are React
// and are checked by eye; these three are the ones that go quietly wrong:
//
//   · THE ORDER. Longest wait first. A rail shows two or three rows, so the
//     order is what decides which prompts you are shown AT ALL — get it
//     backwards and the one that has been stopped since last night is the one
//     that falls off the bottom.
//   · THE NAME. The ✧ label is usually absent (only the Terminal screen asks
//     Gemini for one), so the cwd fallback is the COMMON path and not the edge.
//     A row that fell back to the tmux name would say nothing at all.
//   · THE FLOOR ON A WAIT. `<1m`, never a precise zero — the relay stamps when
//     it first SAW the prompt, so every reading is "at least this long".
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

const url = new URL('../web/src/lib/asking.ts', import.meta.url);
const { pickAsking, waitedFor, askingName } = await import(url.href);

const MIN = 60_000;
const NOW = Date.parse('2026-09-14T12:00:00Z');

/** A host session row as GET /api/terminal/detached ships one. */
const sess = (over = {}) => ({
  name: 'stack-term-aa11', cwd: 'stack', created: NOW - 9e6, attached: false,
  keep: false, label: '', model: null, resolvedModel: '', blocked: null, ...over,
});
const ask = (over = {}) => ({
  title: 'Edit file', question: 'Do you want to make this edit to lanes.js?',
  detail: 'server/src/lanes.js', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }],
  yes: 1, fingerprint: 'abc123', since: NOW - 5 * MIN, ...over,
});

// ---- pickAsking ------------------------------------------------------------

test('only sessions the host reports as blocked come through', () => {
  const out = pickAsking([
    sess({ name: 'a' }),
    sess({ name: 'b', blocked: ask() }),
    sess({ name: 'c', blocked: null }),
  ]);
  assert.deepEqual(out.map((x) => x.name), ['b']);
});

test('nothing is ever promoted to asking on its own', () => {
  // The host's scan is the only thing that decides. A session can look as busy
  // as you like — no `blocked`, no row.
  assert.deepEqual(pickAsking([sess(), sess({ name: 'b' })]), []);
  assert.deepEqual(pickAsking([]), []);
});

test('LONGEST WAIT FIRST — the oldest prompt leads', () => {
  const out = pickAsking([
    sess({ name: 'fresh', blocked: ask({ since: NOW - 2 * MIN }) }),
    sess({ name: 'ancient', blocked: ask({ since: NOW - 600 * MIN }) }),
    sess({ name: 'middling', blocked: ask({ since: NOW - 40 * MIN }) }),
  ]);
  assert.deepEqual(out.map((x) => x.name), ['ancient', 'middling', 'fresh']);
});

test('two prompts stamped in the same push have a stable order', () => {
  // The relay stamps a whole push at once, so ties are routine rather than
  // exotic — and a list that reshuffled on every poll is a list you cannot
  // click, because the row moves out from under the press.
  const rows = [
    sess({ name: 'stack-term-zz', blocked: ask({ since: NOW - 7 * MIN }) }),
    sess({ name: 'stack-term-aa', blocked: ask({ since: NOW - 7 * MIN }) }),
  ];
  assert.deepEqual(pickAsking(rows).map((x) => x.name), ['stack-term-aa', 'stack-term-zz']);
  assert.deepEqual(pickAsking([...rows].reverse()).map((x) => x.name), ['stack-term-aa', 'stack-term-zz']);
});

test('an attached session is still asking', () => {
  // /detached advertises every stack-term-* session, and one somebody holds
  // over ssh can be just as stopped as an orphan. Dropping it here would make
  // this count disagree with the terminal rail's.
  const out = pickAsking([sess({ name: 'held', attached: true, blocked: ask() })]);
  assert.deepEqual(out.map((x) => x.name), ['held']);
});

test('the question rides through intact', () => {
  const [row] = pickAsking([sess({ blocked: ask() })]);
  assert.equal(row.ask.detail, 'server/src/lanes.js');
  assert.equal(row.ask.fingerprint, 'abc123');
});

// ---- askingName ------------------------------------------------------------

test('the ✧ label names a session when one has landed', () => {
  const [row] = pickAsking([sess({ label: 'Refactoring the lane guard', blocked: ask() })]);
  assert.equal(askingName(row), 'Refactoring the lane guard');
});

test('with no label — the common case — the cwd names it', () => {
  const [row] = pickAsking([sess({ cwd: 'bkos-landing', blocked: ask() })]);
  assert.equal(askingName(row), 'bkos-landing');
});

test('a nested cwd names it by its leaf, and the jail root is "home"', () => {
  const [deep] = pickAsking([sess({ cwd: 'work/stack/web', blocked: ask() })]);
  assert.equal(askingName(deep), 'web');
  const [root] = pickAsking([sess({ cwd: '', blocked: ask() })]);
  assert.equal(askingName(root), 'home');
});

test('never the tmux name — eight hex characters name nothing', () => {
  const [row] = pickAsking([sess({ name: 'stack-term-a1b2c3d4', cwd: '', label: '', blocked: ask() })]);
  assert.notEqual(askingName(row), 'stack-term-a1b2c3d4');
});

// ---- waitedFor -------------------------------------------------------------

test('a wait reads as a duration, not as a past event', () => {
  assert.equal(waitedFor(NOW - 4 * MIN, NOW), '4m');
  assert.equal(waitedFor(NOW - 59 * MIN, NOW), '59m');
  assert.equal(waitedFor(NOW - 60 * MIN, NOW), '1h');
  assert.equal(waitedFor(NOW - 23 * 60 * MIN, NOW), '23h');
  assert.equal(waitedFor(NOW - 25 * 60 * MIN, NOW), '1d');
});

test('the floor is <1m, never a precise zero', () => {
  // The relay stamps when it first SAW the prompt and does not persist it, so
  // every reading is "at least this long" — including a stamp from a clock
  // that is fractionally ahead of this one.
  assert.equal(waitedFor(NOW, NOW), '<1m');
  assert.equal(waitedFor(NOW - 59_000, NOW), '<1m');
  assert.equal(waitedFor(NOW + 5_000, NOW), '<1m');
});
