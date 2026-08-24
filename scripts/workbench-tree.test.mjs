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
  SMART, SYSTEM, ROOT, STALE_DAYS, smartOf, isSmart, isSystem, systemOf, isFolder,
  childrenOf, descendantsOf, countIn, pathTo, canFileInto, sortCards, upFrom,
  foldName, phasesOf, KIND_LABEL, mapLayout, MAP_ROW, isPinned, pinnedFolder,
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

// --- going up ---------------------------------------------------------

test('Up returns a BOX, so "the root" and "nowhere" cannot collide', () => {
  const cards = tree();
  // The bug this pins: a folder at the root goes UP to the root, and the root
  // is null — so a bare-id return made "go to the root" indistinguishable from
  // "there is nowhere to go" and disabled the button in the commonest case.
  assert.deepEqual(upFrom(cards, 1), { to: null });
  assert.deepEqual(upFrom(cards, 2), { to: 1 });
  assert.equal(upFrom(cards, ROOT), null);
  assert.deepEqual(upFrom(cards, 'smart:stale'), { to: null });
});

// --- smart folders ----------------------------------------------------

test('a smart folder is a query over the whole canvas, flat', () => {
  const cards = [
    ...tree(),
    card({ id: 6, title: 'old', parentId: 1, days: STALE_DAYS + 1 }),
    card({ id: 7, kind: 'ai', op: 'plan', title: 'from an op', parentId: 2 }),
  ];
  assert.deepEqual(childrenOf(cards, 'smart:stale').map((c) => c.id), [6]);
  assert.deepEqual(childrenOf(cards, 'smart:sessions').map((c) => c.id), [7]);
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

test('no smart folder shares a name with a system folder', () => {
  // Two rows in one tree wearing the same name is a tree you cannot navigate
  // by reading — and it was "Polaris" twice until this caught it. Polaris is
  // culled and both of those rows went with it; the property still holds for
  // whatever is added next, which is why the test stays.
  const names = [...SMART, ...SYSTEM].map((f) => f.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, names.join(' | '));
});

// --- the system folders -----------------------------------------------

test('a system folder holds no CARDS — its rows live in other tables', () => {
  const cards = tree();
  assert.deepEqual(childrenOf(cards, 'sys:roadmap'), []);
  assert.equal(countIn(cards, 'sys:roadmap'), 0);
});

test('a system folder is undeletable because there is nothing to delete', () => {
  // The property, stated as a test: neither key is a card id, so no delete path
  // can reach one. A `system: true` flag on a real row would need defending in
  // DELETE, in the move guard and in the fold — three places to forget.
  const cards = tree();
  for (const s of SYSTEM) {
    assert.equal(typeof s.key, 'string');
    assert.equal(cards.some((c) => String(c.id) === s.key), false);
    assert(isSystem(s.key));
    assert.equal(systemOf(s.key).name, s.name);
  }
});

test('nothing may be filed into a system folder', () => {
  const cards = tree();
  assert.equal(canFileInto(cards, 5, 'sys:roadmap'), false);
  assert.equal(canFileInto(cards, 1, 'sys:roadmap'), false);
});

test('a system folder hangs off the root and Up goes there', () => {
  const cards = tree();
  assert.deepEqual(upFrom(cards, 'sys:roadmap'), { to: null });
  assert.deepEqual(pathTo(cards, 'sys:roadmap', 'Stack').map((c) => c.name), ['Stack', 'Roadmap']);
});

test('smart and system keys cannot be mistaken for each other', () => {
  assert(isSmart('smart:stale') && !isSystem('smart:stale'));
  assert(isSystem('sys:roadmap') && !isSmart('sys:roadmap'));
  assert(!isSmart(3) && !isSystem(3) && !isSmart(null) && !isSystem(null));
});

test('every system folder carries a token, never a hex', () => {
  for (const s of SYSTEM) assert.match(s.tone, /^var\(--[a-z-]+\)$/);
});

// --- the Stack folder (#416) ------------------------------------------
//
// The pinned folder is the opposite trade from the two above: a REAL row, so
// that cards can be filed into it, and therefore a flag that has to be defended
// everywhere a folder can be moved. These pin the client half — the server
// refuses the same three things at their own routes, and both halves have to.

test('the Stack folder is a real folder, and holds cards like one', () => {
  const cards = [...tree(), folder({ id: 9, title: 'Stack', system: 'stack' })];
  assert.equal(pinnedFolder(cards).id, 9);
  assert(isPinned(pinnedFolder(cards)));
  assert(isFolder(pinnedFolder(cards)));
  // The point of it being a row rather than a query: things go IN.
  assert.equal(canFileInto(cards, 5, 9), true);
  assert.equal(canFileInto(cards, 1, 9), true);
});

test('the Stack folder itself is filed nowhere — it stays at the root', () => {
  const cards = [...tree(), folder({ id: 9, title: 'Stack', system: 'stack' })];
  assert.equal(canFileInto(cards, 9, 1), false);      // into another folder
  assert.equal(canFileInto(cards, 9, ROOT), false);   // already there anyway
  assert.equal(canFileInto(cards, 9, 2), false);      // and not deeper down
});

test('an ordinary folder is not pinned, and a canvas may have none', () => {
  const cards = tree();
  assert.equal(pinnedFolder(cards), undefined);
  assert.equal(isPinned(cards[0]), false);
  assert.equal(isPinned(undefined), false);
  assert.equal(isPinned(null), false);
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

// --- the map ----------------------------------------------------------

test('the map draws folders only, root included', () => {
  const { nodes } = mapLayout(tree(), 'Stack', new Set());
  assert.deepEqual(nodes.map((n) => n.name).sort(), ['Deep', 'Stack', 'Work']);
  const root = nodes.find((n) => n.name === 'Stack');
  assert.equal(root.card, null);      // the root has no card
  assert.equal(root.depth, 0);
});

test('a parent sits at the midpoint of its children, not on the first one', () => {
  // root -> A -> (B, C). A must sit BETWEEN B and C, or a branch reads as a
  // staircase and the map stops showing structure.
  const cards = [
    folder({ id: 1, title: 'A', parentId: null }),
    folder({ id: 2, title: 'B', parentId: 1 }),
    folder({ id: 3, title: 'C', parentId: 1 }),
  ];
  const { nodes } = mapLayout(cards, 'Stack', new Set());
  const y = (n) => nodes.find((x) => x.name === n).y;
  assert.equal(y('B'), 0);
  assert.equal(y('C'), MAP_ROW);
  assert.equal(y('A'), MAP_ROW / 2);
  assert.equal(y('Stack'), MAP_ROW / 2);
});

test('a collapsed folder takes one row and draws no edges below it', () => {
  const cards = [
    folder({ id: 1, title: 'A', parentId: null }),
    folder({ id: 2, title: 'B', parentId: 1 }),
  ];
  const open = mapLayout(cards, 'Stack', new Set());
  const shut = mapLayout(cards, 'Stack', new Set([1]));
  assert.equal(open.nodes.length, 3);
  assert.equal(shut.nodes.length, 2);          // B is not placed
  assert.equal(shut.edges.length, 1);          // root -> A only
  assert.equal(shut.nodes.find((n) => n.name === 'A').collapsed, true);
});

test('a node counts everything it holds, not just its folders', () => {
  const { nodes } = mapLayout(tree(), 'Stack', new Set());
  const work = nodes.find((n) => n.name === 'Work');
  assert.equal(work.kids, 1);    // one folder inside
  assert.equal(work.holds, 3);   // Deep + its note + the loose note in Work
});

test('a cycle in remote data does not make the map recurse forever', () => {
  const cards = [
    folder({ id: 1, title: 'A', parentId: 2 }),
    folder({ id: 2, title: 'B', parentId: 1 }),
  ];
  const out = mapLayout(cards, 'Stack', new Set());
  assert(out.nodes.length >= 1);
  assert(out.w > 0 && out.h > 0);
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
  for (const k of ['folder', 'ai', 'note']) assert(KIND_LABEL[k]);
  assert.equal(isFolder(folder()), true);
  assert.equal(isFolder(card()), false);
});
