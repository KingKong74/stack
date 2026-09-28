#!/usr/bin/env node
// THE READY QUEUE — the build lane. The sprint in progress is the planning
// lane and is never built from.
//
//  • PUT /ready takes the WHOLE queue: listed ids are ranked by their index,
//    anything Ready the body leaves out leaves the queue.
//  • A HELD item is refused out loud, naming it, and nothing is written.
//  • The nightly fan-out enqueues Ready rows only: a row in the active sprint
//    that is not Ready gets no build job.
//
// Same harness as plan-night.test.mjs (a running server on a FRESH database —
// it arms the autopilot and reads every queued job):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   node server/test/ready-queue.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = `ready-${Date.now()}`;

async function call(method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
const item = async (title, extra = {}) =>
  (await call('POST', `/projects/${SLUG}/roadmap`, { title, ...extra })).body;
const rows = async () => Object.values((await call('GET', `/projects/${SLUG}`)).body.roadmap).flat();

let a; let b; let c; let sprinted;

test('setup', async () => {
  const r = await call('POST', '/ingest', { project: { slug: SLUG, name: SLUG }, session: { summary: 'seed' } });
  assert.ok(r.status < 300, r.text);
  a = await item('a'); b = await item('b'); c = await item('c'); sprinted = await item('in the sprint only');
});

test('PUT /ready ranks the listed ids and drops the rest', async () => {
  let r = await call('PUT', `/projects/${SLUG}/ready`, { items: [b.id, a.id, c.id] });
  assert.equal(r.status, 200, r.text);
  let all = await rows();
  const rank = (id) => all.find((it) => it.id === id);
  assert.equal(rank(b.id).ready, true);
  assert.deepEqual([rank(b.id).readyRank, rank(a.id).readyRank, rank(c.id).readyRank], [0, 1, 2]);
  r = await call('PUT', `/projects/${SLUG}/ready`, { items: [a.id] });
  all = await rows();
  assert.equal(rank(a.id).readyRank, 0);
  assert.equal(rank(b.id).ready, false, 'left out = out of the queue');
  assert.equal(rank(sprinted.id).ready, false);
});

test('a held item is refused out loud and nothing is written', async () => {
  const parent = await item('feature');
  const held = (await call('POST', `/projects/${SLUG}/roadmap`, { title: 'unapproved piece', source: 'plan', parentId: parent.id })).body;
  const r = await call('PUT', `/projects/${SLUG}/ready`, { items: [b.id, held.id] });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(r.body.held, [held.id]);
  assert.match(r.body.error, /unapproved piece/);
  const all = await rows();
  assert.equal(all.find((it) => it.id === b.id).ready, false, 'the batch was rolled back');
  assert.equal(all.find((it) => it.id === a.id).ready, true, 'the old queue is untouched');
  // Approving it is what lets it in.
  await call('PATCH', `/projects/${SLUG}/roadmap/${held.id}`, { reviewed: true });
  assert.equal((await call('PUT', `/projects/${SLUG}/ready`, { items: [a.id, held.id] })).status, 200);
});

test('the nightly builds Ready rows only, never the sprint', async () => {
  const sp = (await call('POST', `/projects/${SLUG}/sprints`, { name: 'planning' })).body;
  await call('PUT', `/projects/${SLUG}/sprints/${sp.id}/order`, { items: [sprinted.id] });
  await call('PATCH', `/projects/${SLUG}/sprints/${sp.id}`, { status: 'active' });
  await call('PATCH', `/projects/${SLUG}`, { automode: true });
  await call('PATCH', '/settings', { autopilotEnabled: true, autopilotTime: '03:00', autopilotMaxItems: 8 });
  await call('GET', '/autopilot/next?local=2026-09-29T03:01&dow=2');
  const jobs = (await call('GET', `/autopilot/jobs?slug=${SLUG}&limit=50`)).body;
  const list = Array.isArray(jobs) ? jobs : jobs.jobs;
  const built = list.filter((j) => j.kind === 'nightly').map((j) => Number(j.itemId)).sort();
  assert.ok(built.includes(a.id), `a Ready row gets a build job (got ${JSON.stringify(built)})`);
  assert.ok(!built.includes(sprinted.id), 'a sprint-only row gets no build job');
  await call('PATCH', '/settings', { autopilotEnabled: false });
});
