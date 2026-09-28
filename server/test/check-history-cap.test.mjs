#!/usr/bin/env node
// #502 — GET /api/projects/:slug/checks/history caps each check at
// CHECK_HISTORY_KEEP (util.js), and nothing pinned it.
//
// The cap is TWO mechanisms that have to agree, and either alone passes a
// casual look:
//
//  • the WRITE side prunes. POST /run and POST /report both call
//    pruneCheckHistory, so check_results never holds more than KEEP rows per
//    check — the nightly suite would otherwise grow the table without bound.
//    It PARTITIONS BY check: one busy check must not evict a quiet one's rows.
//  • the READ side clamps `?limit=` into 1..KEEP, and keeps NEWEST first. A
//    clamp alone would hide an unpruned table; a prune alone would let a
//    `limit=1000` read return whatever an older, unpruned row left behind.
//
// So this drives BOTH write paths past the cap (a reported check and a probed
// one, in one project), reads the history back with an oversized limit, and —
// when DATABASE_URL is set — counts the table itself, which is the only way to
// tell a prune from a clamp.
//
// Needs a running server on a throwaway database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   STACK_API=http://127.0.0.1:4599 API_TOKEN=testtok \
//     DATABASE_URL=postgres://t:t@127.0.0.1:55432/t node server/test/check-history-cap.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { CHECK_HISTORY_KEEP as KEEP } from '../src/util.js';

const API = process.env.STACK_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.API_TOKEN || 'testtok';

async function call(method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* a non-JSON body is the assertion */ }
  return { status: res.status, body: json, text };
}

const slug = `check-cap-${Date.now()}`;
const base = `/projects/${slug}/checks`;
const OVER = KEEP + 5;
let reported = null; // external check, fed through POST /report
let probed = null;   // ordinary check, fed through POST /run
let quiet = null;    // a check with 3 rows — the cap must not touch it

test('the cap is a real number, not 0 or unbounded', () => {
  assert.ok(Number.isInteger(KEEP) && KEEP > 1, `CHECK_HISTORY_KEEP = ${KEEP}`);
});

test('setup: a project', async () => {
  const r = await call('POST', '/projects', { slug, name: slug });
  assert.ok(r.status === 201 || r.status === 200, r.text);
});

test(`POST /report, ${OVER} times: the reported path prunes to ${KEEP}`, async () => {
  // `code` numbers each report 1..OVER, so what survives says WHICH rows it kept.
  for (let i = 1; i <= OVER; i++) {
    const r = await call('POST', `${base}/report`, { name: 'reported', status: i % 2 ? 'pass' : 'fail', code: i });
    assert.equal(r.status, 200, r.text);
    reported = r.body;
  }
  for (let i = 1; i <= 3; i++) {
    const r = await call('POST', `${base}/report`, { name: 'quiet', status: 'pass', code: 1000 + i });
    assert.equal(r.status, 200, r.text);
    quiet = r.body;
  }
});

test(`POST /run, ${OVER} times: the probing path prunes to ${KEEP}`, async () => {
  const c = await call('POST', base, { name: 'probed', url: `${API}/api/health`, expect_status: 200 });
  assert.equal(c.status, 201, c.text);
  probed = c.body;
  for (let i = 0; i < OVER; i++) {
    const r = await call('POST', `${base}/run`, { id: probed.id });
    assert.equal(r.status, 200, r.text);
  }
});

test('an oversized ?limit= is clamped to the cap, per check, newest first', async () => {
  const r = await call('GET', `${base}/history?limit=${KEEP * 10}`);
  assert.equal(r.status, 200, r.text);
  const h = r.body;
  assert.equal(h[reported.id].length, KEEP, 'reported check');
  assert.equal(h[probed.id].length, KEEP, 'probed check');
  // The cap is PER CHECK: the busy ones did not evict the quiet one's rows.
  assert.equal(h[quiet.id].length, 3, 'quiet check');
  // Newest first, and the ones kept are the newest KEEP — codes OVER down to 6.
  const codes = h[reported.id].map((x) => x.code);
  assert.deepEqual(codes, Array.from({ length: KEEP }, (_, i) => OVER - i));
});

test('the default is 20, and a small limit is honoured', async () => {
  const d = await call('GET', `${base}/history`);
  assert.equal(d.body[reported.id].length, 20);
  const five = await call('GET', `${base}/history?limit=5`);
  assert.deepEqual(five.body[reported.id].map((x) => x.code), [OVER, OVER - 1, OVER - 2, OVER - 3, OVER - 4]);
  // limit is floored at 1, never 0 — a zero would read as "no history".
  const zero = await call('GET', `${base}/history?limit=-3`);
  assert.equal(zero.body[reported.id].length, 1);
});

test('the TABLE holds the cap, not just the read (a prune, not only a clamp)', { skip: !process.env.DATABASE_URL && 'DATABASE_URL unset — cannot count the table' }, async () => {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      'SELECT check_id, count(*)::int AS n FROM check_results WHERE check_id = ANY($1::int[]) GROUP BY check_id',
      [[reported.id, probed.id, quiet.id]]
    );
    const n = Object.fromEntries(rows.map((r) => [r.check_id, r.n]));
    assert.equal(n[reported.id], KEEP);
    assert.equal(n[probed.id], KEEP);
    assert.equal(n[quiet.id], 3);
  } finally {
    await client.end();
  }
});

test('teardown: the project is binned and purged', async () => {
  await call('DELETE', `/projects/${slug}`);
  await call('DELETE', `/projects/${slug}/purge`);
});
