#!/usr/bin/env node
// stack-board-demo.mjs — dummy cards for driving the wired board, and the
// button that takes every one of them away again.
//
//   node scripts/stack-board-demo.mjs --seed [--slug stack]
//   node scripts/stack-board-demo.mjs --remove [--slug stack]
//   node scripts/stack-board-demo.mjs            # prints what is on the board now
//
// WHY THIS IS A SCRIPT AND NOT A FIXTURE. Demo rows go into the REAL
// `roadmap_items` table of a real project — there is no other table for them —
// so the only honest way to add them is a way that also removes them. Every row
// this writes carries the marker below in its note, `--remove` deletes exactly
// the rows carrying it, and nothing else is touched.
//
// FOUR THINGS IT DOES TO KEEP THE DEMO OUT OF THE OWNER'S REAL NIGHT. All four
// are load-bearing; read them before changing what gets seeded:
//
//  1. EVERY ROW IS PARKED (`skipped: true`). The overnight runner's pick filters
//     on `NOT done AND NOT skipped AND claimed_by = ''` (routes/autopilot.js,
//     stack-autopilot.mjs), so a parked row can never be picked up and built.
//     Unpark one from the board's card menu if you want to see that happen.
//  2. EVERY ROW IS IN AREA `Demo`. Parking does NOT exempt a row from the AREA
//     LANE: `(project, area)` is occupied by any row with `NOT done AND
//     claimed_by <> '' AND area <> ''`, parked or not (#267, and the holders
//     query in routes/autopilot.js has no `skipped` clause). So the three rows
//     seeded WITH a branch claim would hold a real lane if they wore a real
//     area — instead they hold `stack::demo`, which only ever blocks each
//     other.
//  3. NOTHING IS `highest` OR `high`. `computeProgress` weighs those two and
//     ignores medium/low/lowest entirely (#469 kept the old must/should
//     weighting under the new names), so a demo board cannot move the
//     dashboard's progress bar. Promote one from the card's priority picker and
//     it will — that is the picker working, not a bug. The same two names are
//     what the overnight runner picks from, so a promoted demo card would also
//     become buildable; it stays parked, which is guard 1.
//  4. NOTHING IS TICKED. `done` is what the merge job writes and what progress
//     weighs. The rows that sit in Done get there by carrying a VERDICT
//     (`review_tag`), which is what `listFor` derives on — the same route a
//     real verdicted-but-unmerged change takes.
//
// The three In Review rows carry a `built_note` and a `claimed_by`, which is
// #374's built-not-ticked predicate — the one a night's work actually lands in.
// The branches are named the current way (`<kind>/<id>-<summary>`, #363) so the
// board draws what a real claim looks like.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The marker. It is in the NOTE rather than a column because there is no column
// for it and inventing one would outlive the demo by years.
const MARK = '[board-demo]';

const AREA = 'Demo';

// title, bucket, and where it should end up. `lane` is the state that DERIVES
// the column (server/src/lists.js listFor) — never a `list_key` override, so
// the demo exercises the derivation the board is built on rather than routing
// around it.
const CARDS = [
  // --- To Do: nothing claimed, nothing built.
  { title: 'Sidebar tree keyboard nav', bucket: 'medium', lane: 'planned', estimate: 2 },
  { title: 'Audit contrast on dark surfaces', bucket: 'medium', lane: 'planned' },
  { title: 'Split token files by concern', bucket: 'medium', lane: 'planned', estimate: 1 },
  { title: 'Quarantine flaky checks', bucket: 'medium', lane: 'planned', estimate: 3 },
  { title: 'Budget line on the usage chart', bucket: 'low', lane: 'planned' },
  { title: 'Print sheet geometry', bucket: 'low', lane: 'planned', estimate: 5 },

  // --- In Progress: claimed, nothing built yet.
  { title: 'Row recycling on scroll', bucket: 'medium', lane: 'progress', estimate: 3,
    branch: 'perf/9001-row-recycling-on-scroll' },
  { title: 'Second surface step for nested cards', bucket: 'medium', lane: 'progress',
    branch: 'ui/9002-second-surface-step' },

  // --- In Review: built and not yet verdicted (#374).
  { title: 'Replace the legacy grey ramp', bucket: 'medium', lane: 'review', estimate: 2,
    branch: 'refactor/9003-replace-legacy-grey-ramp',
    built: 'Swapped every --grey-* reference for the kit ramp; two rules kept their own tone and say why.' },
  { title: 'Extract the diff bar', bucket: 'medium', lane: 'review',
    branch: 'refactor/9004-extract-the-diff-bar',
    built: 'DiffBar replaces three inline copies. No behaviour change; the smoke walks all three call sites.' },
  { title: 'Drag a timeline bar to move a date', bucket: 'low', lane: 'review', estimate: 1,
    branch: 'feat/9005-drag-a-timeline-bar',
    built: 'Bars drag and snap to the grain. The BASELINE is untouched by a drag, per lib/plan.ts.' },

  // --- Done: a verdict is on record. NOT ticked — see note 4 above.
  { title: 'Ship Button and IconButton', bucket: 'medium', lane: 'shipped', verdict: 'solid',
    branch: 'feat/9006-ship-button-and-iconbutton',
    built: 'Both components land with the kit tokens and a focus ring spec.' },
  { title: 'Focus ring spec', bucket: 'medium', lane: 'shipped', verdict: 'solid',
    branch: 'docs/9007-focus-ring-spec',
    built: 'One rule, one token, and the two places that were rolling their own.' },
  { title: 'Point the palette audit at the board', bucket: 'low', lane: 'shipped', verdict: 'needs-work',
    branch: 'test/9008-palette-audit-board',
    built: 'Audits the four columns. Misses an open card menu, which is why this came back.' },
];

const usage = `stack-board-demo — dummy cards for the board

  node scripts/stack-board-demo.mjs --seed [--slug stack]
  node scripts/stack-board-demo.mjs --remove [--slug stack]
  node scripts/stack-board-demo.mjs [--slug stack]      # report only

Every seeded row is PARKED, in area "${AREA}", and in a bucket that cannot move
the progress bar. --remove deletes exactly the rows carrying "${MARK}".`;

export async function main(argv = process.argv.slice(2)) {
  const flag = (n) => argv.includes(`--${n}`);
  const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  if (flag('help') || flag('h')) { process.stdout.write(`${usage}\n`); return 0; }

  const slug = arg('slug') || 'stack';
  const SEED = flag('seed');
  const REMOVE = flag('remove');
  if (SEED && REMOVE) { process.stderr.write('--seed and --remove are opposites; pick one.\n'); return 1; }

  // Token + API base from ~/.stack/env, never printed — same as every other
  // tool in here.
  let API; let TOKEN;
  try {
    const env = readFileSync(join(homedir(), '.stack', 'env'), 'utf8');
    const get = (k) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
    API = (get('STACK_API') || '').replace(/\/$/, '');
    TOKEN = get('STACK_TOKEN');
  } catch {
    process.stderr.write('Could not read ~/.stack/env — is this the Stack host?\n');
    return 1;
  }
  if (!API || !TOKEN) { process.stderr.write('STACK_API or STACK_TOKEN missing from ~/.stack/env.\n'); return 1; }

  const api = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return null; }
  };

  // The payload's five priority keys (#469). Spelled here because a host script
  // imports nothing from the server — and a stale list does not error on the
  // READ, it silently reports fewer demo cards than are really on the board and
  // then leaves the rest behind on --remove.
  const readAll = async () => {
    const r = await api('GET', `/api/projects/${slug}/roadmap`);
    return ['highest', 'high', 'medium', 'low', 'lowest'].flatMap((b) => r[b] || []);
  };

  const existing = (await readAll()).filter((it) => it.note.includes(MARK));

  if (REMOVE) {
    if (!existing.length) { process.stdout.write(`No demo cards on ${slug}.\n`); return 0; }
    for (const it of existing) {
      await api('DELETE', `/api/projects/${slug}/roadmap/${it.id}`);
      process.stdout.write(`removed #${it.id} ${it.title}\n`);
    }
    process.stdout.write(`\n${existing.length} demo card(s) gone from ${slug}.\n`);
    return 0;
  }

  if (!SEED) {
    process.stdout.write(`${slug}: ${existing.length} demo card(s) on the board.\n`);
    for (const it of existing) process.stdout.write(`  #${it.id} ${it.title}\n`);
    if (!existing.length) process.stdout.write(`\n${usage}\n`);
    return 0;
  }

  if (existing.length) {
    // Re-seeding on top of a live demo would double every card, and there is no
    // fingerprint to dedup on (these are `manual` rows, not `hook` ones).
    process.stderr.write(`${slug} already has ${existing.length} demo card(s). Run --remove first.\n`);
    return 1;
  }

  let made = 0;
  for (const c of CARDS) {
    const item = await api('POST', `/api/projects/${slug}/roadmap`, {
      title: c.title,
      note: `${MARK} A dummy card for driving the board. Delete it, or run stack-board-demo.mjs --remove.`,
      bucket: c.bucket,
      area: AREA,
    });

    // The state that derives the column. Parked and the estimate go on in the
    // same PATCH, so a row is never briefly live in a real area's lane.
    const patch = { skipped: true };
    if (c.estimate !== undefined) patch.estimate = c.estimate;
    if (c.branch) patch.claimed_by = c.branch;
    if (c.built) patch.built_note = c.built;
    if (c.verdict) patch.review_tag = c.verdict;
    await api('PATCH', `/api/projects/${slug}/roadmap/${item.id}`, patch);

    process.stdout.write(`#${item.id.toString().padEnd(5)} ${c.lane.padEnd(9)} ${c.title}\n`);
    made += 1;
  }

  process.stdout.write(`\n${made} demo card(s) on ${slug} — all parked, all in area "${AREA}".\n`);
  process.stdout.write('Remove them with:  node scripts/stack-board-demo.mjs --remove\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  });
}
