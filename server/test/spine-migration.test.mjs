#!/usr/bin/env node
// #608 — THE SPINE MIGRATION, run against a board shaped the way boards were
// before it: clusters, loose rows, worked rows, a Ready row, an archived Ready
// row. It applies schema.sql up to the #608 block, seeds that board, applies
// the whole file, and checks where every row landed. Then it applies the file
// AGAIN and checks nothing moved: the migration is one-shot, and a reboot
// months later must never re-file a board the owner has shaped by hand.
//
// Needs DATABASE_URL pointed at an EMPTY Postgres (its own, fresh: it asserts
// the one-shot guard, which reads the whole milestones table):
//   docker run -d --rm --name spine-pg -e POSTGRES_PASSWORD=test \
//     -e POSTGRES_DB=stack -p 55433:5432 postgres:16-alpine
//   DATABASE_URL=postgres://postgres:test@127.0.0.1:55433/stack \
//     node server/test/spine-migration.test.mjs

if (!process.env.DATABASE_URL) {
  console.log('SKIP — set DATABASE_URL to an EMPTY Postgres to run this test (see the header).');
  process.exit(0);
}

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { q, pool } = await import('../src/db.js');
const here = dirname(fileURLToPath(import.meta.url));
const full = readFileSync(join(here, '../src/schema.sql'), 'utf8');
const MARK = '-- #608 — THE SPINE';
const at = full.indexOf(MARK);
if (at < 0) { console.log('FAIL  schema.sql has no #608 block'); process.exit(1); }

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

try {
  const { rows: pre } = await q(`SELECT to_regclass('roadmap_items') AS t`);
  if (pre[0].t) { console.log('FAIL  the database is not empty: give this test a fresh one'); process.exit(1); }

  // ---- the board as it was ------------------------------------------------
  await q(full.slice(0, at));
  const { rows: [p] } = await q(`INSERT INTO projects (slug, name) VALUES ('mig', 'mig') RETURNING id`);
  const { rows: [other] } = await q(`INSERT INTO projects (slug, name) VALUES ('mig-quiet', 'quiet') RETURNING id`);
  await q(`INSERT INTO projects (slug, name) VALUES ('mig-empty', 'empty')`);
  const row = async (title, extra = {}) => {
    const fields = { project_id: p.id, title, fingerprint: title, ...extra };
    const cols = Object.keys(fields);
    const vals = Object.values(fields);
    const { rows } = await q(
      `INSERT INTO roadmap_items (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, vals);
    return rows[0].id;
  };
  const idle = await row('idle cluster', { area: 'board', note: 'the spec' });
  const idleA = await row('idle part a', { parent_id: idle });
  const idleB = await row('idle part b', { parent_id: idle });
  const busy = await row('claimed cluster', { claimed_by: 'feat/1-x' });
  const busyA = await row('busy part', { parent_id: busy });
  const loose = await row('loose idea');
  const kept = await row('kept, not committed', { committed: false });
  const built = await row('built loose', { claimed_by: 'main', built_note: 'landed' });
  const ticked = await row('ticked loose', { done: true });
  const readyRow = await row('ready loose', { ready_at: new Date(), ready_rank: 0 });
  const archReady = await row('archived ready', { archived: true, ready_at: new Date() });
  const quietRow = await row('quiet idea', { project_id: other.id });

  // ---- migrate ------------------------------------------------------------
  await q(full);
  const slice = async (id) => (await q('SELECT slice_id, archived, ready_at FROM roadmap_items WHERE id = $1', [id])).rows[0];
  const { rows: ms } = await q(`SELECT project_id, name, status FROM milestones ORDER BY project_id`);
  check('every project WITH rows gets one active "Current" milestone, and an empty project none',
    ms.map((m) => [m.project_id, m.name, m.status]), [[p.id, 'Current', 'active'], [other.id, 'Current', 'active']]);
  const { rows: sl } = await q(`SELECT id, title, spec, areas FROM slices WHERE project_id = $1 ORDER BY position`, [p.id]);
  check('the two clusters became slices, then "Carried over" last', sl.map((s) => s.title),
    ['idle cluster', 'claimed cluster', 'Carried over']);
  check('a cluster slice takes the parent note as its spec and its area', [sl[0].spec, sl[0].areas], ['the spec', ['board']]);
  const [sIdle, sBusy, sCarry] = sl.map((s) => s.id);
  check('an idle cluster\'s parts go into its slice', [(await slice(idleA)).slice_id, (await slice(idleB)).slice_id], [sIdle, sIdle]);
  check('…and its UNWORKED parent is archived (the slice carries it now)', (await slice(idle)).archived, true);
  check('a WORKED cluster parent stays as an item in its slice', [(await slice(busy)).slice_id, (await slice(busy)).archived], [sBusy, false]);
  check('…beside its parts', (await slice(busyA)).slice_id, sBusy);
  check('built, ticked and Ready loose rows are carried over, so nothing in flight leaves the board',
    [(await slice(built)).slice_id, (await slice(ticked)).slice_id, (await slice(readyRow)).slice_id], [sCarry, sCarry, sCarry]);
  check('the Ready row is still Ready', (await slice(readyRow)).ready_at !== null, true);
  check('a loose idea and a not-committed row go to the Icebox',
    [(await slice(loose)).slice_id, (await slice(kept)).slice_id], [null, null]);
  check('an ARCHIVED Ready row leaves Ready instead of blocking the CHECK',
    [(await slice(archReady)).slice_id, (await slice(archReady)).ready_at], [null, null]);
  check('a project with nothing worked gets no "Carried over" slice',
    (await q('SELECT count(*)::int AS n FROM slices WHERE project_id = $1', [other.id])).rows[0].n, 0);
  check('…and its idea is iced', (await slice(quietRow)).slice_id, null);

  // ---- the CHECK ----------------------------------------------------------
  let refused = '';
  try { await q('UPDATE roadmap_items SET ready_at = now() WHERE id = $1', [loose]); }
  catch (e) { refused = e.constraint || e.message; }
  check('Ready ⇒ sliced is a CHECK: an iced row cannot be made Ready', refused, 'roadmap_ready_needs_slice');

  // ---- one-shot -----------------------------------------------------------
  await q('UPDATE roadmap_items SET slice_id = NULL WHERE id = $1', [idleA]);   // the owner iced it by hand
  await q(`INSERT INTO roadmap_items (project_id, title, fingerprint, claimed_by) VALUES ($1, 'later', 'later', 'x')`, [p.id]);
  await q(full);
  check('a second boot creates no milestone and no slice',
    [(await q('SELECT count(*)::int AS n FROM milestones')).rows[0].n, (await q('SELECT count(*)::int AS n FROM slices')).rows[0].n], [2, 3]);
  check('…and does not re-file a row the owner moved', (await slice(idleA)).slice_id, null);
} finally {
  await pool.end();
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
