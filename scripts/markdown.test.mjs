#!/usr/bin/env node
// Tests for web/src/lib/markdown.ts — the block parser behind Plans → Session
// plans. A plan that parses into the wrong blocks reads as a different plan.
// Run: node --experimental-strip-types scripts/markdown.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseBlocks } = await import(new URL('../web/src/lib/markdown.ts', import.meta.url).href);
const kinds = (src) => parseBlocks(src).map((b) => b.k);

test('headings, paragraphs and rules', () => {
  const b = parseBlocks('# Title\n\nline one\nline two\n\n---\n## Sub ##');
  assert.deepEqual(b.map((x) => x.k), ['h', 'p', 'hr', 'h']);
  assert.equal(b[1].text, 'line one line two');
  assert.equal(b[3].text, 'Sub');
});

test('a fence keeps its text verbatim, markdown and all', () => {
  const b = parseBlocks('```js\n# not a heading\n- not a list\n```\nafter');
  assert.deepEqual(b.map((x) => x.k), ['code', 'p']);
  assert.equal(b[0].lang, 'js');
  assert.equal(b[0].text, '# not a heading\n- not a list');
});

test('an unclosed fence runs to the end rather than looping', () => {
  assert.deepEqual(kinds('```\nforever'), ['code']);
});

test('lists: ordered, nested, task boxes and wrapped lines', () => {
  const [ul, ol] = parseBlocks('- a\n  - b\n  wrapped\n- [x] done\n- [ ] open\n\n1. one\n2) two');
  assert.equal(ul.ordered, false);
  assert.deepEqual(ul.items.map((i) => [i.depth, i.text, i.box]),
    [[0, 'a', null], [1, 'b wrapped', null], [0, 'done', true], [0, 'open', false]]);
  assert.equal(ol.ordered, true);
  assert.deepEqual(ol.items.map((i) => i.text), ['one', 'two']);
});

test('a pipe table needs its divider row', () => {
  const [t] = parseBlocks('| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 |');
  assert.equal(t.k, 'table');
  assert.deepEqual(t.head, ['a', 'b']);
  assert.deepEqual(t.rows, [['1', '2'], ['3']]);
  assert.deepEqual(kinds('| just | pipes |'), ['p']);
});

test('quotes join, and every line of input lands somewhere', () => {
  const [q] = parseBlocks('> one\n> two');
  assert.equal(q.k, 'quote');
  assert.equal(q.text, 'one two');
  // A line that starts like a table but is not one must not stall the parser.
  assert.deepEqual(kinds('|x\nplain'), ['p', 'p']);
});
