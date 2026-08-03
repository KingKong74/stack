#!/usr/bin/env node
// #267 + #335 — the AREA LANE as the claim statement actually enforces it.
//
// These two items landed on separate branches and both rewrote the same claim.
// #335 replaced a fleet-wide "one job in flight" lock with two gates (a
// tunable fleet cap and a fixed per-project serialisation); #267 added a third
// (one worker per (project, area), because two branches in one area collide at
// MERGE time, not at run time). Merging them naively kept #267's global lock
// and silently undid #335 — the fanned night would have gone back to serial
// with nothing failing to say so.
//
// `area-lanes.test.mjs` pins lanes.js, which is pure and knows nothing about
// SQL. `autopilot-next.test.mjs` pins the cap and the per-project gate, and
// passes an EMPTY occupied list. Neither one runs the lane predicate against a
// database, so this file does: it is the only place the composed statement —
// three gates in one WHERE — is executed before a dispatcher depends on it.
//
// Needs DATABASE_URL pointed at an EMPTY-enough Postgres (schema.sql is
// applied here, idempotently). It only ever touches rows under the throwaway
// t267-* project slugs:
//
//   docker run -d --rm --name stack267-pg -e POSTGRES_PASSWORD=test \
//     -e POSTGRES_DB=stack -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/stack \
//     node server/test/area-lane-claim.test.mjs

if (!process.env.DATABASE_URL) {
  console.log('SKIP — set DATABASE_URL to run this test. e.g.:');
  console.log('  docker run -d --rm --name stack267-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=stack -p 55432:5432 postgres:16-alpine');
  console.log('  DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/stack node server/test/area-lane-claim.test.mjs');
  process.exit(0);
}

const { migrate, q, pool } = await import('../src/db.js');
const { CLAIM_NEXT_SQL } = await import('../src/routes/autopilot.js');
const { laneKey } = await import('../src/lanes.js');

const SLUGS = ['t267-a', 't267-b'];

let failed = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

async function wipe() {
  await q(`DELETE FROM autopilot_jobs WHERE project_id IN (SELECT id FROM projects WHERE slug = ANY($1))`, [SLUGS]);
  await q(`DELETE FROM roadmap_items WHERE project_id IN (SELECT id FROM projects WHERE slug = ANY($1))`, [SLUGS]);
  await q(`DELETE FROM projects WHERE slug = ANY($1)`, [SLUGS]);
}

async function project(slug) {
  const { rows } = await q(
    `INSERT INTO projects (slug, name) VALUES ($1, $2) RETURNING id`, [slug, slug]);
  return rows[0].id;
}

// `fingerprint` is NOT NULL (it is what auto-extraction dedups on), so a
// fixture has to carry one; it is unused by the lane predicate.
let fp = 0;
async function item(projectId, { area = '', claimedBy = null, done = false } = {}) {
  const { rows } = await q(
    `INSERT INTO roadmap_items (project_id, title, area, claimed_by, done, fingerprint)
     VALUES ($1, 'lane fixture', $2, $3, $4, $5) RETURNING id`,
    [projectId, area, claimedBy, done, `t267-fixture-${++fp}`]);
  return rows[0].id;
}

async function job(projectId, { area = '', itemId = null } = {}) {
  const { rows } = await q(
    `INSERT INTO autopilot_jobs (project_id, kind, status, item_id, area)
     VALUES ($1, 'manual', 'queued', $2, $3) RETURNING id`,
    [projectId, itemId, area]);
  return rows[0].id;
}

// cap 0 = unlimited, so every result below is the LANE's doing and nothing else.
const claim = async (occupied) =>
  (await q(CLAIM_NEXT_SQL, [0, occupied])).rows[0]?.id ?? null;

const requeue = (id) => q(`UPDATE autopilot_jobs SET status = 'queued' WHERE id = $1`, [id]);

(async () => {
  await migrate();
  await wipe();

  const a = await project('t267-a');
  const b = await project('t267-b');

  console.log('\n--- 1. a job whose OWN area is occupied is passed over ---');
  const j1 = await job(a, { area: 'terminal' });
  check('claims when no lane is occupied', await claim([]), j1);
  await requeue(j1);
  check('is held when its lane is occupied', await claim([laneKey(a, 'terminal')]), null);
  await requeue(j1);
  check('an unrelated lane does not hold it', await claim([laneKey(a, 'polaris')]), j1);
  await q(`DELETE FROM autopilot_jobs WHERE id = $1`, [j1]);

  console.log('\n--- 2. a lane is keyed on (project, area), never the bare area ---');
  const j2 = await job(b, { area: 'terminal' });
  check('the SAME area name in another project does not hold it',
    await claim([laneKey(a, 'terminal')]), j2);
  await q(`DELETE FROM autopilot_jobs WHERE id = $1`, [j2]);

  console.log('\n--- 3. an untagged area is never a lane ---');
  const j3 = await job(a, { area: '' });
  check('an untagged job is not held by an occupied-lane list',
    await claim([laneKey(a, 'terminal'), laneKey(a, '')]), j3);
  await q(`DELETE FROM autopilot_jobs WHERE id = $1`, [j3]);

  console.log('\n--- 4. the lane of the PINNED item counts, not just the job\'s own ---');
  const held = await item(a, { area: 'workbench', claimedBy: 'lane/other-worker' });
  const pinned = await item(a, { area: 'workbench' });
  const j4 = await job(a, { itemId: pinned });          // job carries no area of its own
  check('a job pinned to an item in an occupied area is held',
    await claim([laneKey(a, 'workbench')]), null);

  console.log('\n--- 5. ...but a holder never blocks ITSELF (that is a resume) ---');
  // Drop the other holder: now the only claim on the lane is the pinned item's
  // own. A worker returning to its own item must still be able to claim it.
  await q(`DELETE FROM roadmap_items WHERE id = $1`, [held]);
  await q(`UPDATE roadmap_items SET claimed_by = 'lane/mine' WHERE id = $1`, [pinned]);
  check('a job pinned to an item claimed only by itself still claims',
    await claim([laneKey(a, 'workbench')]), j4);

  await wipe();
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  await pool.end();
  process.exit(failed ? 1 : 0);
})();
