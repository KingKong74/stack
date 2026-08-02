#!/usr/bin/env node
// The timeline window (#296) — `days`, `graph`, and the three fields the
// Extend button and the Dashboard both depend on: `windowDays`, `hasMore`,
// `capped`.
//
// The property that matters most is the SECOND one below: Extend has to
// genuinely widen the range, not just relabel the same rows.
//
//   • CLAMP — days=0/-5 → windowDays:1, days=9999 → 371, days=abc or a
//     missing days → 30 (the Dashboard's Pushes section hits this same route
//     with no params and its copy says "the last 30 days" — a silent
//     regression there is the whole point of pinning it).
//   • EXTEND WIDENS — a wider `days` is a strict SUPERSET of a narrower one,
//     not a different slice of it.
//   • hasMore — true while an older session exists outside the window,
//     false once the window covers every fixture session.
//   • graph=0 — skips the 371-day aggregate entirely (graph:[], total:0)
//     rather than returning it trimmed; the same request without it is
//     populated. This is what stops Extend re-running the year-long query.
//
// Needs a running server on an EMPTY database (it writes real rows and
// reads `hasMore`/`graph` GLOBALLY, i.e. unfiltered by project — see below):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t node server/test/timeline-window.test.mjs
//
// Override the API with STACK_TEST_API / STACK_TEST_TOKEN.
//
// It needs DATABASE_URL as well as the API: sessions have to be back-dated
// to exact UTC days and there is no ingest field for that, so the fixture
// rows are written directly, the same way workbench.test.mjs stands up its
// 'ai' cards.
//
// `hasMore` and `graph`/`total` are computed by the route ACROSS ALL
// PROJECTS, not scoped to a slug — a shared, non-empty database would make
// those three assertions flaky against whatever else is in it. This test
// chooses the EMPTY-throwaway-database option (same contract the other
// DB-backed tests already require) rather than trying to make those three
// assertions slug-tolerant, so they read as plain global checks below. The
// windowDays/day-membership assertions are still scoped to this fixture's
// commit hashes regardless, since those are cheap to make robust either way.

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = 'timeline-window-test';

let failed = 0;
function check(name, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

async function timeline(qs = '') {
  const r = await fetch(`${API}/api/timeline${qs}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`GET /timeline${qs} → ${r.status}: ${await r.text()}`);
  return r.json();
}

function hashesIn(resp) {
  const set = new Set();
  for (const day of resp.days) for (const e of day.entries) set.add(e.hash);
  return set;
}

(async () => {
  // Seed the project + four sessions, back-dated with `now() - interval`
  // (rather than an absolute timestamp computed in JS) so they stay pinned
  // to the same UTC "now" the route's own CUTOFF_SQL reads.
  if (!process.env.DATABASE_URL) {
    throw new Error('This test back-dates sessions directly — run it with the same DATABASE_URL as the server.');
  }
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  let pid;
  try {
    const { rows } = await db.query(
      `INSERT INTO projects (slug, name) VALUES ($1, $2) RETURNING id`, [SLUG, 'Timeline window test']);
    pid = rows[0].id;
    const mkSession = (hash, agoInterval) => db.query(
      `INSERT INTO sessions (project_id, commit_hash, branch, summary, message_count, created_at)
       VALUES ($1, $2, 'main', $3, 1, now() - $4::interval)`,
      [pid, hash, `fixture ${hash}`, agoInterval]);
    await mkSession('tw-today', '0 days');
    await mkSession('tw-2day', '2 days');
    await mkSession('tw-5day', '5 days');
    await mkSession('tw-40day', '40 days');
  } finally {
    await db.end();
  }

  // 1. days=3 covers only today and the two previous UTC calendar days.
  const win3 = await timeline('?days=3');
  check('days=3 reports windowDays:3', win3.windowDays, 3);
  const hashes3 = hashesIn(win3);
  check('today is in the 3-day window', hashes3.has('tw-today'), true);
  check('2 days ago is in the 3-day window', hashes3.has('tw-2day'), true);
  check('5 days ago is absent from the 3-day window', hashes3.has('tw-5day'), false);
  check('40 days ago is absent from the 3-day window', hashes3.has('tw-40day'), false);

  // 2. Extending to days=7 is a SUPERSET, and pulls in the 5-day-old session.
  const win7 = await timeline('?days=7');
  check('days=7 reports windowDays:7', win7.windowDays, 7);
  const hashes7 = hashesIn(win7);
  check('5 days ago now appears once the window widens', hashes7.has('tw-5day'), true);
  const isSuperset = [...hashes3].every((h) => hashes7.has(h));
  check('the 7-day answer is a superset of the 3-day answer', isSuperset, true);
  check('40 days ago is still outside a 7-day window', hashes7.has('tw-40day'), false);

  // 3. hasMore: true while something older than the window exists, false once
  //    the window covers every fixture session (relies on an empty DB — see
  //    the header comment).
  check('hasMore is true at days=3 (the 40-day fixture is older)', win3.hasMore, true);
  const winWide = await timeline('?days=50');
  check('hasMore is false once the window covers every fixture session', winWide.hasMore, false);

  // 4. graph=0 skips the 371-day aggregate; the same request without it does not.
  const noGraph = await timeline('?days=3&graph=0');
  check('graph=0 returns an empty graph', noGraph.graph.length, 0);
  check('graph=0 returns total:0', noGraph.total, 0);
  const withGraph = await timeline('?days=3');
  check('without graph=0 the graph is populated', withGraph.graph.length > 0, true);
  check('without graph=0 total is positive', withGraph.total > 0, true);

  // 5. The clamp: 1..371, default 30 when missing or not a number.
  check('days=0 clamps to windowDays:1', (await timeline('?days=0')).windowDays, 1);
  check('days=-5 clamps to windowDays:1', (await timeline('?days=-5')).windowDays, 1);
  check('days=9999 clamps to windowDays:371', (await timeline('?days=9999')).windowDays, 371);
  check('days=abc falls back to the 30-day default', (await timeline('?days=abc')).windowDays, 30);
  check('a missing days falls back to the 30-day default', (await timeline('')).windowDays, 30);

  console.log(failed ? `\n${failed} check(s) failed.` : '\nall checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
