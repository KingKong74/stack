#!/usr/bin/env node
// Tests for web/src/lib/instructions.ts — the CLAUDE.md parser behind the
// Instructions tab. Run: node --experimental-strip-types scripts/instructions.test.mjs
//
// Same loader shim as scripts/feature.test.mjs: the module is TypeScript under
// web/, outside this repo's Node module graph, so it needs strip-types to run
// at all. (No resolve hook is needed here — instructions.ts imports nothing.)
//
// What this pins is the one property the whole tab rests on: **an edit splices
// lines and never re-renders the file.** Anything the parser does not model —
// code fences, tables, blank-line spacing, a trailing note — has to survive an
// edit byte-for-byte, because this is somebody's writing and Claude reads it.
// A round trip that "tidies" a file is a round trip that loses work.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = new URL('../web/src/lib/instructions.ts', import.meta.url);
const {
  parseInstructions, setRuleFlags, moveRule, removeRule, addRule,
  mergeContext, mergeTokens, fileStats, precedenceRank, estimateTokens,
} = await import(url.href);

const FILE = `# CLAUDE.md

## Project

Atlas is the triage surface for incoming bug reports. The web app is
Vite + React; the API is Go.

## Commands

- Dev server is \`pnpm dev\` from the repo root — it starts web and api
  together. Do not run them separately.
- Run \`pnpm test -- --run\` before proposing a change.

<!-- stack: off scope=api/** -->
- Use \`pnpm db:reset\` after touching migrations.

## Code style

<!-- stack: overrides -->
- Import order is React, third-party, local.
`;

test('reads the title, the sections and every rule', () => {
  const p = parseInstructions(FILE);
  assert.equal(p.title, 'CLAUDE.md');
  assert.deepEqual(p.sections.map((s) => s.name), ['Project', 'Commands', 'Code style']);
  assert.equal(p.rules.length, 5);
});

test('a paragraph under a heading is a rule, not nothing', () => {
  // The failure this guards: a bullets-only parser shows a prose CLAUDE.md as
  // empty, which reads as "Stack cannot see your rules".
  const p = parseInstructions(FILE);
  const prose = p.rules[0];
  assert.equal(prose.section, 'Project');
  assert.equal(prose.bullet, false);
  assert.match(prose.text, /^Atlas is the triage surface/);
  // Continuations fold into one line of prose.
  assert.match(prose.text, /Vite \+ React; the API is Go\.$/);
});

test('a bullet swallows its indented continuation', () => {
  const p = parseInstructions(FILE);
  assert.match(p.rules[1].text, /it starts web and api together\. Do not run them separately\.$/);
});

test('annotations set off, scope and overrides; absent means on and unscoped', () => {
  const p = parseInstructions(FILE);
  const disabled = p.rules.find((r) => r.text.includes('db:reset'));
  assert.equal(disabled.on, false);
  assert.equal(disabled.scope, 'api/**');
  assert.equal(disabled.overrides, false);

  const declared = p.rules.find((r) => r.text.includes('Import order'));
  assert.equal(declared.overrides, true);
  assert.equal(declared.on, true);

  const plain = p.rules[1];
  assert.equal(plain.on, true);
  assert.equal(plain.scope, '');
  assert.equal(plain.overrides, false);
});

test('an unannotated file parses — this is somebody else\'s CLAUDE.md', () => {
  const p = parseInstructions('# Notes\n\n- One thing.\n- Another thing.\n');
  assert.equal(p.rules.length, 2);
  assert.ok(p.rules.every((r) => r.on && !r.scope && !r.overrides));
});

test('toggling a rule off inserts an annotation and nothing else changes', () => {
  const next = setRuleFlags(FILE, 1, { on: false });
  const p = parseInstructions(next);
  assert.equal(p.rules[1].on, false);
  assert.equal(p.rules.length, 5);
  // Every other line is untouched: the only difference is one added line.
  const before = FILE.split('\n');
  const after = next.split('\n');
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.filter((l) => !l.startsWith('<!-- stack: off -->')), before);
});

test('toggling the last flag off removes the annotation line entirely', () => {
  const off = setRuleFlags(FILE, 4, { overrides: false });
  assert.ok(!off.includes('<!-- stack: overrides -->'));
  assert.equal(parseInstructions(off).rules.length, 5);
  // And it is byte-identical to the file minus that one line.
  assert.equal(off, FILE.split('\n').filter((l) => l !== '<!-- stack: overrides -->').join('\n'));
});

test('flags round-trip through a rewrite without duplicating the comment', () => {
  let body = setRuleFlags(FILE, 1, { on: false });
  body = setRuleFlags(body, 1, { scope: 'web/**' });
  body = setRuleFlags(body, 1, { on: true });
  const rule = parseInstructions(body).rules[1];
  assert.equal(rule.on, true);
  assert.equal(rule.scope, 'web/**');
  // Three: this one, the db:reset one and the overrides one — a rewrite
  // replaces its own comment rather than stacking a second above it.
  assert.equal(body.match(/<!-- stack:/g).length, 3);
});

test('an edit leaves a code fence the parser never modelled untouched', () => {
  const fenced = `## Commands

- Run this:

  \`\`\`sh
  pnpm test -- --run
  ## not a heading
  \`\`\`

- And this one.
`;
  const p = parseInstructions(fenced);
  assert.equal(p.rules.length, 2, 'the fence body is part of its bullet, not new rules');
  const next = setRuleFlags(fenced, 1, { on: false });
  assert.ok(next.includes('## not a heading'), 'the fenced line survives verbatim');
  assert.ok(next.includes('pnpm test -- --run'));
});

test('moving a rule reorders it inside its section', () => {
  const p = parseInstructions(FILE);
  const commands = p.sections.find((s) => s.name === 'Commands').rules;
  const next = moveRule(FILE, commands[0].index, commands[1].index);
  const after = parseInstructions(next).sections.find((s) => s.name === 'Commands').rules;
  assert.match(after[0].text, /^Run `pnpm test/);
  assert.match(after[1].text, /^Dev server/);
  assert.equal(after.length, 3);
  // The disabled rule kept its annotation through the shuffle.
  assert.equal(after[2].on, false);
});

test('moving across sections is refused rather than silently reparenting', () => {
  assert.equal(moveRule(FILE, 0, 1), FILE);
});

test('removing a rule takes its annotation with it', () => {
  const next = removeRule(FILE, 3);
  assert.ok(!next.includes('db:reset'));
  assert.ok(!next.includes('scope=api/**'));
  assert.equal(parseInstructions(next).rules.length, 4);
});

test('adding a rule appends to an existing section', () => {
  const next = addRule(FILE, 'Commands', 'Never run the seed script twice.');
  const commands = parseInstructions(next).sections.find((s) => s.name === 'Commands').rules;
  assert.equal(commands.length, 4);
  assert.equal(commands[3].text, 'Never run the seed script twice.');
});

test('adding a rule to a new section creates the heading', () => {
  const next = addRule(FILE, 'Testing', 'Table-driven tests only.');
  const p = parseInstructions(next);
  assert.ok(p.sections.some((s) => s.name === 'Testing'));
  assert.ok(next.includes('## Testing'));
});

test('the merge preview drops switched-off rules', () => {
  const lines = mergeContext([{ label: 'CLAUDE.md', body: FILE }]);
  const text = lines.map((l) => l.line).join('\n');
  assert.ok(text.includes('Run `pnpm test'));
  assert.ok(!text.includes('db:reset'), 'off means off — the preview answers what Claude sees');
  assert.ok(text.includes('← overrides'));
});

test('the merge preview keeps precedence order and labels every line', () => {
  const lines = mergeContext([
    { label: '~/.claude', body: '# Yours\n\n- Answer with the change.\n' },
    { label: 'CLAUDE.md', body: FILE },
  ]);
  const srcs = lines.filter((l) => l.src).map((l) => l.src);
  assert.equal(srcs[0], '~/.claude');
  assert.ok(srcs.includes('CLAUDE.md'));
  assert.ok(srcs.indexOf('~/.claude') < srcs.indexOf('CLAUDE.md'));
  assert.ok(mergeTokens([{ label: 'x', body: FILE }]) > 0);
});

test('a file with no live rules contributes nothing to the preview', () => {
  const allOff = '## X\n\n<!-- stack: off -->\n- Nope.\n';
  assert.deepEqual(mergeContext([{ label: 'a', body: allOff }]), []);
});

test('fileStats counts on, overrides and the estimate', () => {
  const s = fileStats(FILE);
  assert.equal(s.rules, 5);
  assert.equal(s.on, 4);
  assert.equal(s.overrides, 1);
  assert.ok(s.tokens > 0);
  assert.equal(estimateTokens(''), 0);
});

test('precedence puts the personal file weakest and the deepest file strongest', () => {
  assert.ok(precedenceRank('global', '') < precedenceRank('project', ''));
  assert.ok(precedenceRank('project', '') < precedenceRank('project', 'web'));
  assert.ok(precedenceRank('project', 'web') < precedenceRank('project', 'packages/ui'));
});
