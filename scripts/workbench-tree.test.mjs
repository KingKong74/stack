#!/usr/bin/env node
// Tests for web/src/lib/workbenchTree.ts — the Workbench's folder tree (#414).
// Run: node --experimental-strip-types scripts/workbench-tree.test.mjs
//
// Same loader shim as scripts/feature.test.mjs: the module is TypeScript, lives
// under web/ outside this repo's module graph, and needs strip-types to run at
// all. It imports nothing but a type, so no resolve hook is needed here.
//
// What this pins is the half of the folder feature a render cannot show you: a
// cycle draws as a folder that opens into itself, and a smart folder counting
// the wrong population draws as a perfectly ordinary list.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = new URL('../web/src/lib/workbenchTree.ts', import.meta.url);
const {
  SMART, ROOT, STALE_DAYS, smartOf, isSmart, isFolder,
  childrenOf, descendantsOf, countIn, pathTo, canFileInto, sortCards,
  foldName, phasesOf, KIND_LABEL,
} = await import(url.href);

// --- fixtures ---------------------------------------------------------

let seq = 0;
const card = (over = {}) => {
  seq += 1;
  return {
    id: over.id ?? seq,
    kind: 'note',
    op: '',
    noteId: null,
    futureId: null,
    title: `card ${seq}`,
    colour: '',
    meta: '',
    body: {},
    x: 0, y: 0, w: 244,
    parentId: null,
    days: 0,
    when: 'just now',
    ...over,
  };
};
const folder = (over = {}) => card({ kind: 'folder', ...over });

// A small tree:  root ─┬─ #1 Work ─┬─ #2 Deep ── #3 note
//                      │           └─ #4 note
//                      └─ #5 note (loose)
const tree = () => [
  folder({ id: 1, title: 'Work', parentId: null }),
  folder({ id: 2, title: 'Deep', parentId: 1 }),
  card({ id: 3, title: 'buried', parentId: 2 }),
  card({ id: 4, title: 'in work', parentId: 1 }),
  card({ id: 5, title: 'loose', parentId: null }),
];

// --- children, descendants, counts ------------------------------------

test('childrenOf is one level, descendantsOf is all of them', () => {
  const cards = tree();
  assert.deepEqual(childrenOf(cards, 1).map((c) => c.id), [2, 4]);
  assert.deepEqual(descendantsOf(cards, 1).map((c) => c.id), [2, 3, 4]);
  assert.equal(countIn(cards, 1), 2);
});

test('the root is null and holds what nothing else claims', () => {
  const cards = tree();
  assert.deepEqual(childrenOf(cards, ROOT).map((c) => c.id), [1, 5]);
});

test('a cycle in remote data is walked once, not forever', () => {
  // The server refuses to write this. The client still must not hang on it.
  const cards = [
    folder({ id: 1, title: 'A', parentId: 2 }),
    folder({ id: 2, title: 'B', parentId: 1 }),
  ];
  const out = descendantsOf(cards, 1);
  assert.deepEqual(out.map((c) => c.id), [2, 1]);
  assert.deepEqual(pathTo(cards, 1, 'Stack').map((c) => c.name), ['Stack', 'B', 'A']);
});

// --- the breadcrumb ---------------------------------------------------

test('pathTo names the project first and the folder last', () => {
  const cards = tree();
  assert.deepEqual(pathTo(cards, 2, 'Stack').map((c) => c.name), ['Stack', 'Work', 'Deep']);
  assert.deepEqual(pathTo(cards, ROOT, 'Stack').map((c) => c.name), ['Stack']);
});

test('an untitled folder still gets a crumb you can click', () => {
  const cards = [folder({ id: 1, title: '', parentId: null })];
  assert.deepEqual(pathTo(cards, 1, 'Stack').map((c) => c.name), ['Stack', 'Untitled folder']);
});

// --- smart folders ----------------------------------------------------

test('a smart folder is a query over the whole canvas, flat', () => {
  const cards = [
    ...tree(),
    card({ id: 6, title: 'old', parentId: 1, days: STALE_DAYS + 1 }),
    card({ id: 7, kind: 'polaris', futureId: 9, title: 'idea', parentId: 2 }),
  ];
  assert.deepEqual(childrenOf(cards, 'smart:stale').map((c) => c.id), [6]);
  assert.deepEqual(childrenOf(cards, 'smart:polaris').map((c) => c.id), [7]);
  assert(isSmart('smart:stale'));
  assert(!isSmart(1));
  assert.equal(smartOf('smart:stale').name, 'Stale · 30d+');
});

test('a stale FOLDER is not stale work — only what is inside can be', () => {
  const cards = [folder({ id: 1, days: STALE_DAYS + 40 })];
  assert.deepEqual(childrenOf(cards, 'smart:stale'), []);
});

test('"loose" is unfiled work, and a folder at the root is not loose', () => {
  const cards = tree();
  assert.deepEqual(childrenOf(cards, 'smart:loose').map((c) => c.id), [5]);
});

test('every smart folder carries a token, never a hex', () => {
  for (const s of SMART) assert.match(s.tone, /^var\(--[a-z-]+\)$/);
});

// --- the cycle guard --------------------------------------------------

test('a folder may not be filed into itself or its own descendant', () => {
  const cards = tree();
  assert.equal(canFileInto(cards, 1, 1), false);   // into itself
  assert.equal(canFileInto(cards, 1, 2), false);   // into its own child
  assert.equal(canFileInto(cards, 2, 1), false);   // already there
  assert.equal(canFileInto(cards, 5, 2), true);    // a loose note, downward
  assert.equal(canFileInto(cards, 3, ROOT), true); // out to the root
});

test('nothing may be filed into a smart folder or a non-folder', () => {
  const cards = tree();
  assert.equal(canFileInto(cards, 5, 'smart:stale'), false);
  assert.equal(canFileInto(cards, 5, 4), false);   // 4 is a note
  assert.equal(canFileInto(cards, 999, 1), false); // a card that isn't there
});

// --- sorting ----------------------------------------------------------

test('folders lead a name sort and only a name sort', () => {
  const cards = [
    card({ id: 1, title: 'apple', days: 1 }),
    folder({ id: 2, title: 'zebra', days: 9 }),
  ];
  assert.deepEqual(sortCards(cards, 'name', 1, cards).map((c) => c.id), [2, 1]);
  assert.deepEqual(sortCards(cards, 'updated', 1, cards).map((c) => c.id), [1, 2]);
});

test('a sort with a tie keeps a stable order rather than shuffling', () => {
  const cards = [card({ id: 3, days: 5 }), card({ id: 1, days: 5 }), card({ id: 2, days: 5 })];
  assert.deepEqual(sortCards(cards, 'updated', 1, cards).map((c) => c.id), [1, 2, 3]);
  assert.deepEqual(sortCards(cards, 'updated', -1, cards).map((c) => c.id), [1, 2, 3]);
});

test('sorting by items counts a folder’s contents and ranks files below', () => {
  const cards = tree();
  const shown = childrenOf(cards, ROOT);
  assert.deepEqual(sortCards(shown, 'items', -1, cards).map((c) => c.id), [1, 5]);
});

// --- fold + promote ---------------------------------------------------

test('a folded pile is named after the first card and how many joined it', () => {
  assert.equal(foldName('Canvas should remember zoom per project, really', 3), 'Canvas should remember zoom + 2');
  assert.equal(foldName('Solo', 1), 'Solo');
  assert.equal(foldName('', 2), 'Untitled + 1');
});

test('promoting a folder makes one phase per named thing inside', () => {
  const cards = tree();
  const phases = phasesOf(cards, 1, 'Work');
  assert.deepEqual(phases.map((p) => p.t), ['Deep', 'in work']);
  assert.deepEqual(phases.map((p) => p.n), ['1', '2']);
  assert(phases.every((p) => p.bucket === 'should'));
});

test('an empty folder promotes as one phase, never as nothing', () => {
  const cards = [folder({ id: 1, title: 'Empty' })];
  assert.deepEqual(phasesOf(cards, 1, 'Empty').map((p) => p.t), ['Empty — single phase']);
});

test('every card kind has a label the Details view can print', () => {
  for (const k of ['folder', 'polaris', 'ai', 'note']) assert(KIND_LABEL[k]);
  assert.equal(isFolder(folder()), true);
  assert.equal(isFolder(card()), false);
});
