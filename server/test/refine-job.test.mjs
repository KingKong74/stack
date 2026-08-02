#!/usr/bin/env node
// #274 — the `refine` session kind round-trips through the whole server path.
//
// `cleanKind()` (routes/autopilot.js) coerces ANY kind it doesn't recognise
// to 'build'. That is exactly the failure mode a spelling slip or a missed
// plumbing site produces: silently, not loudly — a refine round comes back
// out as a full build night that rebuilds the item from scratch on a fresh
// branch, and nothing in the response shape says so unless you check the
// actual string. This test exists to catch that, over the real HTTP surface
// (never by importing cleanKind() directly), with a negative control (a
// nonsense kind IS coerced to 'build') that proves the positive assertions
// are testing something real rather than an echo.
//
// It also pins the BIGINT-comes-back-as-a-STRING trap that shipped a booking
// button with itemId null silently coerced to 0 (#272): autopilot_jobs and
// autopilot_schedule both carry item_id as BIGINT, and jobShape/scheduleShape
// stringify it — so a job's itemId must be asserted against the exact string,
// not just truthiness.
//
// Needs a running server on an EMPTY database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   node server/test/refine-job.test.mjs
//
// Override with STACK_TEST_API / STACK_TEST_TOKEN.

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = 'refine-job-test';

let failed = 0;
function check(name, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

const call = async (path, opts = {}) => {
  const r = await fetch(`${API}/api${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};

// A queued/claimed/running job blocks /start from making a new one for the
// same project (it hands the open job back instead) — finish a job off
// before the next scenario reuses the project, so a re-run of this file
// against a still-live server starts each scenario clean too.
async function finishOpenJob() {
  const jobs = await call(`/autopilot/jobs?slug=${SLUG}&limit=5`);
  for (const j of jobs) {
    if (['queued', 'claimed', 'running'].includes(j.status)) {
      await call(`/autopilot/jobs/${j.id}`, { method: 'PATCH', body: { status: 'done', detail: 'test cleanup' } });
    }
  }
}

(async () => {
  // A project and a roadmap item to point a refine round at — created through
  // the API, not SQL. ingest upserts the project by slug (idempotent across
  // re-runs); the roadmap POST makes a fresh item every run, which is fine —
  // nothing here depends on there being exactly one.
  await call('/ingest', {
    method: 'POST',
    body: { project: { slug: SLUG, name: 'Refine job test' }, session: { summary: 'seed' } },
  });
  const item = await call(`/projects/${SLUG}/roadmap`, {
    method: 'POST',
    body: { title: 'Refine round-trip fixture item', bucket: 'must' },
  });

  await finishOpenJob(); // in case a previous failed run left one open

  // --- 1 & 2: POST /autopilot/start with kind: 'refine' -------------------
  const job = await call('/autopilot/start', {
    method: 'POST',
    body: { slug: SLUG, itemId: item.id, kind: 'refine' },
  });
  check("POST /start with kind:'refine' comes back sessionKind 'refine', not the cleanKind() 'build' fallback",
    job.sessionKind, 'refine');
  check('the job carries the item id as the exact string (BIGINT-via-pg trap, #272) — not null, not "0"',
    job.itemId, String(item.id));

  // --- 3: GET /next hands the same job back still carrying the kind -------
  const { job: claimed } = await call('/autopilot/next?local=2026-08-05T09:00&dow=3');
  check('GET /next claims a job', Boolean(claimed), true);
  check('GET /next hands the job back still carrying sessionKind: refine (the dispatcher reads it from here)',
    claimed?.sessionKind, 'refine');
  check('the claimed job still carries the exact item id string', claimed?.itemId, String(item.id));

  await finishOpenJob();

  // --- 4: POST /autopilot/schedule with kind: 'refine' ---------------------
  const schedule = await call('/autopilot/schedule', {
    method: 'POST',
    body: { slug: SLUG, atTime: '09:00', days: [3], itemId: item.id, kind: 'refine', agenda: [] },
  });
  check("POST /schedule with kind:'refine' stores and returns 'refine'", schedule.kind, 'refine');
  check('the schedule row carries the exact item id string too', schedule.itemId, String(item.id));

  // --- 5: negative control — a nonsense kind IS coerced to 'build' --------
  // This is what proves assertions 1 and 3 are testing cleanKind() actually
  // whitelisting 'refine', rather than passing because the server echoes
  // back whatever it's handed.
  const badJob = await call('/autopilot/start', {
    method: 'POST',
    body: { slug: SLUG, itemId: item.id, kind: 'wibble' },
  });
  check("a nonsense kind ('wibble') is coerced to 'build' by cleanKind() — proves the whitelist is real",
    badJob.sessionKind, 'build');

  await finishOpenJob();

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
