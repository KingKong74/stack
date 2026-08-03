#!/usr/bin/env node
// #335 — GET /next hands out one job PER PROJECT, not one job for the whole
// fleet, bounded by a tunable fleet cap. This exercises CLAIM_NEXT_SQL itself
// (imported from routes/autopilot.js, not a copy of it — a copy is exactly
// what would drift) directly against a real database, so the statement that
// actually ships gets run at least once before a dispatcher depends on it.
//
// Needs DATABASE_URL pointed at an EMPTY-enough Postgres (schema.sql is
// applied here, idempotently) — it writes and deletes real rows under
// clearly-named throwaway project slugs (t335-*) and touches nothing else:
//
//   docker run -d --rm --name stack335-pg -e POSTGRES_PASSWORD=test \
//     -e POSTGRES_DB=stack -p 55432:5432 postgres:16-alpine
//   # wait for readiness: docker exec stack335-pg pg_isready -U postgres
//   DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/stack \
//     node server/test/autopilot-next.test.mjs

if (!process.env.DATABASE_URL) {
  console.log('SKIP — set DATABASE_URL to run this test. e.g.:');
  console.log('  docker run -d --rm --name stack335-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=stack -p 55432:5432 postgres:16-alpine');
  console.log('  DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/stack node server/test/autopilot-next.test.mjs');
  process.exit(0);
}

const { migrate, q, pool } = await import('../src/db.js');
const { CLAIM_NEXT_SQL } = await import('../src/routes/autopilot.js');

const SLUGS = ['t335-a', 't335-b', 't335-c'];

let failed = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

// Clean slate: only ever touches rows belonging to the t335-* throwaway
// projects, both before and after — never a blanket TRUNCATE/DELETE.
async function wipe() {
  await q(`DELETE FROM autopilot_jobs WHERE project_id IN (SELECT id FROM projects WHERE slug = ANY($1))`, [SLUGS]);
  await q(`DELETE FROM projects WHERE slug = ANY($1)`, [SLUGS]);
}

async function makeProject(slug) {
  const { rows } = await q(
    `INSERT INTO projects (slug, name) VALUES ($1, $1) RETURNING id`, [slug]);
  return rows[0].id;
}

// Queue one job. Options let a test backdate created_at (ordering case) or
// set kind/status/not_before directly.
async function queueJob(projectId, { kind = 'nightly', status = 'queued', notBefore = null, createdAt = null } = {}) {
  const { rows } = await q(
    `INSERT INTO autopilot_jobs (project_id, kind, status, not_before, created_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, now())) RETURNING id`,
    [projectId, kind, status, notBefore, createdAt]);
  return rows[0].id;
}

async function claim(cap) {
  const { rows } = await q(CLAIM_NEXT_SQL, [cap]);
  return rows[0]?.id ?? null;
}

async function setStatus(id, status) {
  await q(`UPDATE autopilot_jobs SET status = $1 WHERE id = $2`, [status, id]);
}

(async () => {
  await migrate();
  await wipe();

  console.log('--- 1. the fleet cap holds ---');
  {
    const [a, b, c] = await Promise.all(SLUGS.map(makeProject));
    await queueJob(a); await queueJob(b); await queueJob(c);
    const first = await claim(2);
    const second = await claim(2);
    const third = await claim(2);
    check('two of three claim under cap=2', [first, second].every(Boolean), true);
    check('the third returns no row', third, null);
    check('two distinct jobs claimed', first !== second, true);
  }
  await wipe();

  console.log('\n--- 2. the cap is what releases it (the actual #335 regression) ---');
  {
    // Fresh slate, but re-create the same shape: two jobs claimed, a third queued.
    const [a, b, c] = await Promise.all(SLUGS.map(makeProject));
    const ja = await queueJob(a);
    const jb = await queueJob(b);
    const jc = await queueJob(c);
    await setStatus(ja, 'claimed');
    await setStatus(jb, 'claimed');
    // jc is still queued. Under the OLD fleet-wide gate this could never claim
    // while anything else was claimed/running, regardless of any cap.
    const released = await claim(3);
    check('raising the cap to 3 lets the third job claim', released, jc);
  }
  await wipe();

  console.log('\n--- 3. 0 means unlimited ---');
  {
    const [a, b, c] = await Promise.all(SLUGS.map(makeProject));
    const ja = await queueJob(a);
    const jb = await queueJob(b);
    const jc = await queueJob(c);
    const got = new Set([await claim(0), await claim(0), await claim(0)]);
    check('all three claim with cap=0', got.has(ja) && got.has(jb) && got.has(jc), true);
    check('a fourth claim returns nothing (nothing left queued)', await claim(0), null);
  }
  await wipe();

  console.log('\n--- 4. per-project serialisation holds (the gate that must not slip) ---');
  {
    const [a] = [await makeProject(SLUGS[0])];
    const j1 = await queueJob(a);
    const j2 = await queueJob(a);
    const first = await claim(0); // cap=0 (unlimited) so the fleet cap cannot be what stops the second
    check('the first of two queued jobs on one project claims', first, j1);
    const blocked = await claim(0);
    check('the second is blocked while the first is still claimed', blocked, null);
    await setStatus(j1, 'done');
    const second = await claim(0);
    check('marking the first done releases the second', second, j2);
  }
  await wipe();

  console.log('\n--- 5. the old fleet-wide behaviour is still reachable (cap=1) ---');
  {
    const [a, b] = await Promise.all([makeProject(SLUGS[0]), makeProject(SLUGS[1])]);
    const ja = await queueJob(a);
    const jb = await queueJob(b);
    const first = await claim(1);
    const second = await claim(1);
    check('exactly one of two projects claims under cap=1', (first === ja || first === jb), true);
    check('the second returns no row', second, null);
  }
  await wipe();

  console.log('\n--- 6. ordering survived (non-nightly ahead of a nightly batch) ---');
  {
    const [a, b] = await Promise.all([makeProject(SLUGS[0]), makeProject(SLUGS[1])]);
    // Project a: a nightly queued first (earlier created_at).
    const nightly = await queueJob(a, { kind: 'nightly', createdAt: new Date(Date.now() - 60_000) });
    // Project b: a manual job queued LATER.
    const manual = await queueJob(b, { kind: 'manual', createdAt: new Date() });
    const first = await claim(0);
    check('the later manual job is claimed ahead of the earlier nightly one', first, manual);
    const second = await claim(0);
    check('the nightly job claims second', second, nightly);
  }
  await wipe();

  console.log('\n--- predicates that predate #335: paused and future not_before are never claimed ---');
  {
    const [a] = [await makeProject(SLUGS[0])];
    await queueJob(a, { status: 'paused' });
    await queueJob(a, { notBefore: new Date(Date.now() + 3600_000) });
    const got = await claim(0);
    check('neither a paused job nor a future not_before job claims', got, null);
  }
  await wipe();

  await pool.end();
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await wipe(); } catch { /* best effort */ }
  process.exit(1);
});
