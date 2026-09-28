#!/usr/bin/env node
// Tests for web/src/lib/planUnits.ts — how Plans → Session plans cuts a
// plan-mode plan into the units Split and Attach offer. A wrong cut offers the
// human the wrong rows to tick, so each rule the header states is pinned here.
// Run: node --experimental-strip-types scripts/plan-units.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { planUnits, unitTitle } = await import(new URL('../web/src/lib/planUnits.ts', import.meta.url).href);
const titles = (src) => planUnits(src).map((u) => `${u.meta ? '-' : '+'}${u.title}`);

test('the shallowest repeated level below the title is the unit', () => {
  const src = '# Plan\n\n## Context\nwhy\n### aside\n## Unit 1 — Add the table\nsql\n## Unit 2 — Wire it\n### detail\nx\n## Verification\nrun';
  assert.deepEqual(titles(src), ['-Context', '+Add the table', '+Wire it', '-Verification']);
  assert.equal(planUnits(src)[2].body, '### detail\nx', 'a deeper heading stays inside its unit');
});

test('headings inside a fence are not units', () => {
  const src = '# P\n## A\n```bash\n# Unit 0 — not a heading\n## nor this\n```\n## B\n';
  assert.deepEqual(titles(src), ['+A', '+B']);
});

test('a plan with several top-level headings uses them', () => {
  assert.deepEqual(titles('# One\nx\n# Two\ny'), ['+One', '+Two']);
});

test('no section level falls back to the top-level numbered list', () => {
  assert.deepEqual(titles('# P\n\n1. Add the table:\n   - nested\n2. Wire the route\n'), ['+Add the table', '+Wire the route']);
});

test('nothing to cut is an empty answer, not a guess', () => {
  assert.deepEqual(planUnits('# Just a title\n\nSome prose.'), []);
  assert.deepEqual(planUnits('# P\n\n1. only one step'), []);
});

test('prefixes come off, and a title that is only a prefix keeps it', () => {
  assert.equal(unitTitle('Unit 3 — `./stack models`'), './stack models');
  assert.equal(unitTitle('Step 2: Wire it'), 'Wire it');
  assert.equal(unitTitle('2. Tests'), 'Tests');
  assert.equal(unitTitle('Unit 3'), 'Unit 3');
});
