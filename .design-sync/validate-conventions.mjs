// validate-conventions.mjs — does the conventions header still tell the truth?
//
//   node .design-sync/validate-conventions.mjs
//
// The header is inlined into a DESIGN AGENT'S system prompt. It will trust
// every name in it, write that vocabulary, and ship silently unstyled output if
// a name no longer resolves — and nothing downstream catches that. So the
// header's standing obligation is not "was it right when written" but "is it
// right against THIS build", and that is what this checks: every `--token` it
// names must be defined in ds-bundle/tokens/, and every family it claims in
// shorthand must expand to tokens that all exist.
//
// Run it after every rebuild. A name that stops verifying is either a header
// edit or a palette change — fix whichever is wrong, never delete the check.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = join(REPO, 'ds-bundle/tokens');

const built = readdirSync(TOKENS).filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(TOKENS, f), 'utf8')).join('\n');
const defined = new Set([...built.matchAll(/^\s*(--[A-Za-z0-9-]+)\s*:/gm)].map((m) => m[1]));

const conv = readFileSync(join(REPO, '.design-sync/conventions.md'), 'utf8');
// Markdown table rules are `---`, and the header deliberately writes families in
// two shorthands: `--grey-*` and `--status-{a,b,c}-bg`. Neither is a claim about
// one token, so neither is checked as one — the family lists below are.
const text = conv.replace(/\|\s*-{3,}\s*/g, ' ');
const named = [...new Set([...text.matchAll(/--[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g)].map((m) => m[0]))]
  .filter((n) => !new RegExp(`${n}-?[*{]`).test(text));

const FAMILIES = {
  'status pairs': ['success', 'info', 'danger', 'warning', 'neutral']
    .flatMap((k) => [`--status-${k}-bg`, `--status-${k}-fg`]),
  viz: Array.from({ length: 6 }, (_, i) => `--viz-${i + 1}`),
  space: Array.from({ length: 12 }, (_, i) => `--space-${i + 1}`),
  radius: ['xs', 'sm', 'md', 'lg', 'xl', '2xl', 'pill'].map((k) => `--radius-${k}`),
  type: ['display', 'title', 'heading', 'body', 'body-sm', 'label', 'caption', 'code', 'eyebrow']
    .map((k) => `--type-${k}`),
  action: ['primary', 'primary-hover', 'primary-press', 'accent', 'accent-hover', 'accent-press', 'danger']
    .map((k) => `--action-${k}`),
  ramps: ['--grey-900', '--grey-500', '--blue-600', '--blue-400', '--lime-500', '--red-500', '--amber-500'],
};

const missing = named.filter((n) => !defined.has(n));
const gaps = Object.entries(FAMILIES)
  .map(([k, list]) => [k, list.filter((t) => !defined.has(t))])
  .filter(([, list]) => list.length);

console.log(`${defined.size} tokens in the build · ${named.length} named in conventions.md`);
if (missing.length) {
  console.log('\nNAMED BUT NOT DEFINED — the header would teach a name that does not resolve:');
  for (const m of missing) console.log(`   ${m}`);
}
if (gaps.length) {
  console.log('\nFAMILY GAPS — the header claims a family the build does not fully carry:');
  for (const [k, list] of gaps) console.log(`   ${k}: ${list.join(', ')}`);
}
if (missing.length || gaps.length) process.exit(1);
console.log('\nok — every token the header names, and every family it claims, exists in the build');
