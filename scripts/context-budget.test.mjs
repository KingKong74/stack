#!/usr/bin/env node
// The always-loaded docs have a size budget, and it is enforced (BUG-1).
//
//   node scripts/context-budget.test.mjs      # exits non-zero when a doc is over
//
// WHY THIS EXISTS: CLAUDE.md reached 157KB — roughly 40k tokens, loaded into
// EVERY session before a word of work is done — growing about 7.5KB a day.
// It was cut to 24KB on 2026-07-30 by keeping the rules and dropping the
// retelling. Three days later it was back to 35KB. The cut was not the fix;
// nothing was stopping it happening again, which is what "re-bloats" in that
// bug's title means.
//
// So: a budget, checked. Not a style rule — a number that fails.
//
// WHEN THIS FAILS, the fix is almost never a bigger budget. It is the edit the
// file itself asks for in its own opening: "Add to this file only when a
// session would get something WRONG without it." A feature list, an API
// reference or a retelling of what the code plainly says is what has to come
// out. Raise a cap only when the project has genuinely grown a new subsystem
// whose invariants cannot be read off the code — and say so in the commit.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ~4 characters per token is the rule of thumb these numbers were set by; the
// budget is in BYTES because that is what can be measured exactly.
const BUDGETS = [
  { path: 'CLAUDE.md', max: 40_000, what: 'loaded into every session in this repo' },
  { path: 'templates/stack-agent-context.md', max: 16_000, what: 'the portable agent manual, exported verbatim' },
];

let fails = 0;
for (const b of BUDGETS) {
  const size = readFileSync(join(ROOT, b.path), 'utf8').length;
  const pct = Math.round((size / b.max) * 100);
  const ok = size <= b.max;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${b.path} — ${size.toLocaleString()} of ${b.max.toLocaleString()} bytes `
    + `(${pct}%, ~${Math.round(size / 4 / 100) / 10}k tokens) — ${b.what}`);
  if (!ok) {
    console.log(`        Over by ${(size - b.max).toLocaleString()} bytes. Cut the retelling, not the rules:`);
    console.log('        anything a session could read off the code, or would not get WRONG without.');
  }
}

console.log(fails ? `\n${fails} over budget` : '\nall within budget');
process.exit(fails ? 1 : 0);
