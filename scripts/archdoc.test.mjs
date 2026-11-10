#!/usr/bin/env node
// Tests for web/src/lib/archDoc.ts — the Architecture doc read as the design's
// page. A shape that misparses draws the owner's doc as something it does not
// say, so each convention is pinned here, and so is its plain-markdown fallback.
// Run: node --experimental-strip-types scripts/archdoc.test.mjs
// (Same loader shim as scripts/spine.test.mjs: web/src imports omit extensions.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';

module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});
const { parseArchDoc, parseMap, parseDeps, archRows, chainOf, splitGoal } = await import(new URL('../web/src/lib/archDoc.ts', import.meta.url).href);

const DOC = `# Architecture

The lede.

## System map

\`\`\`map
node Client | Browser | web/
link HTTPS
node! Container | Express | server/
node Data | Postgres | schema.sql
band every host part DIALS OUT
group Host | outside the container
proc Hooks | hook/ | SessionStart | SessionEnd
\`\`\`

## Codebase

- **web/**: the client.
- **Docs on the spine** are artifacts.

## Deps

\`\`\`deps
Frontend: Vite (build), React
note: No paid APIs.
\`\`\`

## Flow

1. **Pick.** Choose a card.
2. **Build.** Write it.

**Open question, owned by the Delivery milestone:** which work skips the branch.

## Runtimes

| | A | B |
| --- | --- | --- |
| Rules | x | y |

## Shelved

**The fleet** · shelved 2026-11-09

It is idle.

\`a.mjs\` \`b.js\`
`;

test('h1 dropped, lede kept, sections numbered', () => {
  const d = parseArchDoc(DOC);
  assert.deepEqual(d.lede.map((b) => b.k), ['p']);
  assert.deepEqual(d.sections.map((s) => [s.n, s.title]), [
    [1, 'System map'], [2, 'Codebase'], [3, 'Deps'], [4, 'Flow'], [5, 'Runtimes'], [6, 'Shelved'],
  ]);
});

test('the map: nodes, links (implied when missing), band, groups', () => {
  const m = parseArchDoc(DOC).sections[0].parts[0];
  assert.equal(m.k, 'map');
  assert.deepEqual(m.map.row.map((x) => (x.k === 'node' ? x.node.name : `→${x.label}`)), ['Browser', '→HTTPS', 'Express', '→', 'Postgres']);
  assert.equal(m.map.row[2].node.accent, true);
  assert.equal(m.map.band, 'every host part DIALS OUT');
  assert.deepEqual(m.map.groups[0].procs[0], { name: 'Hooks', path: 'hook/', detail: 'SessionStart | SessionEnd' });
  assert.equal(parseMap('just a drawing\n──▶'), null, 'no node: plain code');
});

test('bold-led bullets are cards; a path label is marked; a colon starts a sentence', () => {
  const p = parseArchDoc(DOC).sections[1].parts[0];
  assert.equal(p.k, 'cards');
  assert.deepEqual(p.cards, [
    { label: 'web/', text: 'The client.', path: true, eyebrow: '', tag: '' },
    { label: 'Docs on the spine', text: 'are artifacts.', path: false, eyebrow: '', tag: '' },
  ]);
  const plain = parseArchDoc('## X\n\n- one\n- two\n').sections[0].parts[0];
  assert.equal(plain.k, 'block', 'no bold lead at all: the list stays a list');
});

test('deps chips and the footer', () => {
  assert.deepEqual(parseDeps('Frontend: Vite (build), React\nnote: No paid APIs.'), {
    groups: [{ group: 'Frontend', items: [{ name: 'Vite', note: 'build' }, { name: 'React', note: '' }] }],
    note: 'No paid APIs.',
  });
  assert.equal(parseDeps('nothing here'), null);
});

test('steps and the open-question callout', () => {
  const parts = parseArchDoc(DOC).sections[3].parts;
  assert.equal(parts[0].k, 'steps');
  assert.deepEqual(parts[0].steps.map((s) => s.label), ['Pick', 'Build']);
  assert.deepEqual(parts[1], { k: 'callout', label: 'Open question', text: 'Owned by the Delivery milestone: which work skips the branch.' });
});

test('a prose-only section is a panel with a title, a tag and chips', () => {
  const p = parseArchDoc(DOC).sections[5].parts[0];
  assert.deepEqual(p, { k: 'panel', title: 'The fleet', tag: 'shelved 2026-11-09', paras: ['It is idle.'], chips: ['a.mjs', 'b.js'] });
});

test('half sections pair with the section before, never with a map or steps', () => {
  const rows = archRows(parseArchDoc(DOC).sections).map((r) => r.map((s) => s.n));
  assert.deepEqual(rows, [[1], [2, 3], [4], [5, 6]]);
});

test('a plain doc still parses, with nothing lost', () => {
  const d = parseArchDoc('Just a note.\n\n- a\n- b\n');
  assert.equal(d.sections.length, 0);
  assert.deepEqual(d.lede.map((b) => b.k), ['p', 'list']);
});

// --- the Charter's shapes (design: Charter.dc.html) --------------------------

const CHARTER = `# Charter

Opening.

## Who it is for

- _Primary reader_ **The owner**: working alone.
- _Second reader_ **The agents**: Claude Code and Codex.

## Principles

- **Resume is the point.** A session authors its own.
- **Computed, never hand-set.** Derived.

## What success looks like (this phase)

1. **Every everyday flow reaches the right outcome.** One path.
2. **One delivery flow, written down and followed.** Commit → review → mirror site → verdict → merge, with an explicit rule.

## Out of scope (for now)

- **The unattended fleet** (shelved 2026-11-09): continuous autopilot.
- Teams and other users.
`;

test('a heading tag, eyebrowed cards, principle rows', () => {
  const s = parseArchDoc(CHARTER).sections;
  assert.deepEqual(s.map((x) => [x.title, x.tag]), [
    ['Who it is for', ''], ['Principles', ''], ['What success looks like', 'This phase'], ['Out of scope', 'For now'],
  ]);
  assert.deepEqual(s[0].parts[0].cards.map((c) => [c.eyebrow, c.label, c.text]), [
    ['Primary reader', 'The owner', 'Working alone.'], ['Second reader', 'The agents', 'Claude Code and Codex.'],
  ]);
  assert.equal(s[1].parts[0].k, 'rows');
  assert.deepEqual(s[1].parts[0].rows.map((r) => r.label), ['Resume is the point.', 'Computed, never hand-set.']);
});

test('long ordered labels are goals, and a goal can open with a chain', () => {
  const g = parseArchDoc(CHARTER).sections[2].parts[0];
  assert.equal(g.k, 'goals');
  assert.deepEqual(g.goals[0].chain, []);
  assert.equal(g.goals[0].label, 'Every everyday flow reaches the right outcome.');
  assert.deepEqual(g.goals[1].chain, ['Commit', 'review', 'mirror site', 'verdict', 'merge']);
  assert.equal(g.goals[1].text, 'With an explicit rule.');
  assert.deepEqual(chainOf('project → milestone → item (`roadmap_items`). More').chain, [], 'code in a link: not a chain');
});

test('a mixed list: bold items are cards (with a tag), the rest are lines', () => {
  const m = parseArchDoc(CHARTER).sections[3].parts[0];
  assert.equal(m.k, 'mixed');
  assert.deepEqual(m.items[0], { k: 'card', card: { label: 'The unattended fleet', text: 'Continuous autopilot.', path: false, eyebrow: '', tag: 'shelved 2026-11-09' } });
  assert.deepEqual(m.items[1], { k: 'line', text: 'Teams and other users.' });
});

test('a milestone goal splits at its "Done when:" paragraph', () => {
  assert.deepEqual(splitGoal('Ship it.\n\nDone when: it ships.\n\nProduct brief:\n\n## Purpose'), {
    goal: 'Ship it.', done: 'It ships.', more: 'Product brief:\n\n## Purpose',
  });
  assert.deepEqual(splitGoal('Just a goal.'), { goal: 'Just a goal.', done: '', more: '' });
  assert.deepEqual(splitGoal(''), { goal: '', done: '', more: '' });
});
