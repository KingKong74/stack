#!/usr/bin/env node
// A ONE-OFF CALENDAR ROW WHOSE DATE HAS PASSED RETIRES ITSELF. A one-off only
// matches its own date and used to retire only when it fired, so one that
// missed its day (disarmed, dispatcher down) sat enabled forever. GET /next
// now retires it; a recurring row and a one-off still ahead are untouched.
//
// Same harness as plan-night.test.mjs (a running server on a throwaway DB):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   node server/test/stale-oneoff.test.mjs

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = 'stale-oneoff-test';

let failed = 0;
function check(name, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

const call = async (path, opts = {}) => {
  const r = await fetch(`${API}/api${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};

(async () => {
  await call('/ingest', {
    method: 'POST',
    body: { project: { slug: SLUG, name: 'Stale one-off test' }, session: { summary: 'seed' } },
  });
  const book = (body) => call('/autopilot/schedule', { method: 'POST', body: { slug: SLUG, atTime: '03:00', ...body } });
  const past = await book({ runDate: '2026-08-01' });
  const ahead = await book({ runDate: '2026-12-01' });
  const weekly = await book({ days: [1] });

  // Disarmed on purpose: retiring a dead row is housekeeping, not a run.
  await call('/settings', { method: 'PATCH', body: { autopilotEnabled: false } });
  await call('/autopilot/next?local=2026-09-28T12:00&dow=1');

  const rows = await call('/autopilot/schedule');
  const byId = (id) => rows.find((r) => r.id === id);
  check('a one-off whose date passed is retired', byId(past.id)?.enabled, false);
  check('a one-off still ahead stays enabled', byId(ahead.id)?.enabled, true);
  check('a recurring row stays enabled', byId(weekly.id)?.enabled, true);

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
