#!/usr/bin/env node
// THE LEDGER — the Development tab's audit trail (GET /projects/:slug/ledger).
//
//  • SESSIONS AND RUNS SHARE ONE TIMELINE, newest first, and each keeps its
//    own spend: nothing in the payload sums the two populations.
//  • A RUN WITH NO REVIEW CARRIES '' AND A SUITE THAT NEVER RAN CARRIES null,
//    so the client can say NO REVIEW / suite not run, never green.
//  • `kind` narrows to one population, and `before` pages exactly.
//  • `now` lists recent presence and unfinished jobs, on the first page only.
//
// Needs a running server on a throwaway database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   STACK_API= node server/test/ledger.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

const API = process.env.STACK_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.API_TOKEN || 'testtok';

async function call(method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

const slug = `ledger-test-${Date.now()}`;
const session = (n, extra = {}) => call('POST', '/ingest', {
  project: { slug, name: slug },
  session: { session_id: `s-${n}`, commit_hash: `c0ffee${n}`, summary: `Session ${n} did #${n}`,
    model: 'claude-opus-5-5', message_count: 10 + n, tokens_used: 1000 * n,
    files_touched: [`/home/u/stack/web/f${n}.ts`], tools_used: ['Bash'], ...extra },
});

test.before(async () => {
  assert.equal((await session(1)).status < 300, true);
  const run = await call('POST', `/projects/${slug}/autopilot/runs`,
    { item_title: 'A run', outcome: 'failed', tokens: 5000, cost_usd: 1.25 });
  assert.equal(run.status, 201, run.text);
  assert.equal((await session(2, { authored: true })).status < 300, true);
  await call('POST', '/presence', { slug, session_id: 'live-1', branch: 'main', cwd: '/home/u/stack' });
});

test('an unknown project 404s', async () => {
  assert.equal((await call('GET', '/projects/no-such-project-here/ledger')).status, 404);
});

test('sessions and runs interleave newest first, each with its own spend', async () => {
  const r = await call('GET', `/projects/${slug}/ledger`);
  assert.equal(r.status, 200, r.text);
  const kinds = r.body.entries.map((e) => e.kind);
  assert.deepEqual(kinds, ['session', 'run', 'session']);
  const [s2, run, s1] = r.body.entries;
  assert.equal(s2.authored, true);
  assert.equal(s1.authored, false);
  assert.equal(typeof s2.tokens, 'number');
  assert.equal(s2.tokens, 2000);
  assert.deepEqual(s1.files, ['/home/u/stack/web/f1.ts']);
  assert.equal(s1.filesTotal, 1);
  assert.equal(run.tokens, 5000);
  assert.equal(run.costUsd, 1.25);
  assert.equal(run.reviewVerdict, '', 'no review ran: empty, never a verdict');
  assert.equal(run.checksFailing, null, 'the suite did not run: null, never zero');
  assert.equal(r.body.nextBefore, null);
});

test('kind narrows to one population', async () => {
  const runs = (await call('GET', `/projects/${slug}/ledger?kind=run`)).body.entries;
  assert.deepEqual(runs.map((e) => e.kind), ['run']);
  const sess = (await call('GET', `/projects/${slug}/ledger?kind=session`)).body.entries;
  assert.deepEqual(sess.map((e) => e.kind), ['session', 'session']);
});

test('before pages exactly, and only the first page carries now', async () => {
  const p1 = (await call('GET', `/projects/${slug}/ledger?limit=2`)).body;
  assert.equal(p1.entries.length, 2);
  assert.ok(p1.nextBefore);
  const p2 = (await call('GET', `/projects/${slug}/ledger?limit=2&before=${encodeURIComponent(p1.nextBefore)}`)).body;
  assert.deepEqual(p2.entries.map((e) => e.sessionId), ['s-1']);
  assert.equal(p2.now, null);
});

test('now lists the live session', async () => {
  const now = (await call('GET', `/projects/${slug}/ledger`)).body.now;
  assert.deepEqual(now.sessions.map((s) => s.sessionId), ['live-1']);
  assert.ok(Array.isArray(now.jobs));
});
