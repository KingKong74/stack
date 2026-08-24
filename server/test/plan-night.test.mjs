#!/usr/bin/env node
// #272 — booking a standing plan night. A schedule booked with NO item
// pinned (the plan-night preset: kind 'plan', agenda [], itemId null) must
// enqueue a job with item_id NULL, not 0. Number(null) is 0, and a stored 0
// rides the job to the dispatcher as `--item 0`, which the runner rejects
// (roadmap ids start at 1) with "nothing run" — an agenda-less plan night
// silently doing nothing.
//
// This drives the real HTTP surface end to end (POST /schedule then
// GET /next), the same throwaway-postgres-plus-running-server harness as
// ingest-identity.test.mjs, rather than the SQL-only
// harness of #335's autopilot-next.test.mjs (a file of the same shape on a
// separate, unmerged branch — feat/335-get-next-hands-out-one-job-at — that
// exports CLAIM_NEXT_SQL from routes/autopilot.js; that export does not
// exist on this branch, which is why this file was renamed off that same
// name to avoid an add/add merge conflict). Going through the route means
// this also covers the itemId coercion in POST /schedule and the enqueue
// path in GET /next, which is exactly where the bug lived; it does NOT
// cover the dispatcher script's own `--item` guard
// (scripts/stack-autopilot-dispatch.mjs), which has no HTTP surface to
// exercise here.
//
// Needs a running server on an EMPTY database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   node server/test/plan-night.test.mjs
//
// Override with STACK_TEST_API / STACK_TEST_TOKEN.

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = 'plan-night-test';

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

(async () => {
  // Arm the switch: GET /next only enqueues due calendar rows while it's on.
  await call('/settings', { method: 'PATCH', body: { autopilotEnabled: true } });

  // A project to book the night against (ingest upserts by slug).
  await call('/ingest', {
    method: 'POST',
    body: { project: { slug: SLUG, name: 'Autopilot next test' }, session: { summary: 'seed' } },
  });

  // The plan-night preset (#272, SessionPlanModal): no item pinned, itemId
  // sent as an explicit null — the exact shape that collapsed to 0.
  const schedule = await call('/autopilot/schedule', {
    method: 'POST',
    body: { slug: SLUG, atTime: '09:00', days: [3], itemId: null, kind: 'plan', agenda: [] },
  });
  check('the schedule itself stores no item', schedule.itemId, null);
  check('the schedule keeps its plan kind', schedule.kind, 'plan');

  // GET /next with a local time inside the schedule's window and the same
  // day-of-week — the "due calendar rows" enqueue path.
  const { job } = await call('/autopilot/next?local=2026-08-05T09:00&dow=3');
  check('the due schedule enqueues and is handed back', Boolean(job), true);
  check('the job carries NO item — null, not the string "0"', job?.itemId ?? null, null);
  check('the job keeps the plan session kind', job?.sessionKind, 'plan');
  check('the job carries the empty agenda', Array.isArray(job?.agenda) && job.agenda.length, 0);

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
