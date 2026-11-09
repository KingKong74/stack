#!/usr/bin/env node
// Removed Inbox endpoints and the retained POST /ready/add contract.
//
// Same harness as plan-night.test.mjs:
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   node server/test/inbox.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = `inbox-${Date.now()}`;

async function call(method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
const post = async (b) => (await call('POST', `/projects/${SLUG}/roadmap`, b)).body;

// #608 — Ready ⇒ sliced, so the rows this file queues live in a slice; the
// plan piece takes it from its parent, which is the path a planning run uses.
let piece; let slice;
test('setup', async () => {
  await call('POST', '/ingest', { project: { slug: SLUG, name: SLUG }, session: { summary: 'seed' } });
  const milestone = (await call('POST', `/projects/${SLUG}/milestones`, { name: 'Test milestone' })).body;
  slice = (await call('POST', `/projects/${SLUG}/slices`, { title: 'test slice', milestoneId: milestone.id })).body;
  const parent = await post({ title: 'feature', sliceId: slice.id });
  piece = await post({ title: 'piece', source: 'plan', parentId: parent.id });
});

test('removed inbox endpoints return 404', async () => {
  for (const path of ['/inbox', '/inbox/count']) {
    const res = await fetch(`${API}/api${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 404);
  }
});

test('/ready/add appends in order, keeps the queue, and refuses a held row', async () => {
  const a = await post({ title: 'a', sliceId: slice.id }); const b = await post({ title: 'b', sliceId: slice.id });
  assert.equal(piece.sliceId, slice.id, 'a plan piece inherits its parent\'s slice, so it can be queued');
  await call('PUT', `/projects/${SLUG}/ready`, { items: [a.id] });
  const held = await call('POST', `/projects/${SLUG}/ready/add`, { items: [b.id, piece.id] });
  assert.equal(held.status, 409, held.text);
  await call('PATCH', `/projects/${SLUG}/roadmap/${piece.id}`, { reviewed: true });
  const ok = await call('POST', `/projects/${SLUG}/ready/add`, { items: [piece.id, a.id, b.id] });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.body.added, [piece.id, b.id], 'already-queued a is left alone');
  const rows = Object.values((await call('GET', `/projects/${SLUG}`)).body.roadmap).flat();
  const rank = (id) => rows.find((it) => it.id === id).readyRank;
  assert.deepEqual([rank(a.id), rank(piece.id), rank(b.id)], [0, 1, 2]);
});
