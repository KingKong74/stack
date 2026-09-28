#!/usr/bin/env node
// THE INBOX READ, and POST /ready/add, the append its bulk approval uses.
//
//  • BUILT means the mirrored predicate (done, OR a built_note AND a claim)
//    with no verdict yet; a verdict takes a row out. Its latest run rides along.
//  • Held 'plan' rows are PLANS; other held rows are IDEAS; a worked held row
//    is neither.
//  • /ready/add appends in order, keeps already-queued rows where they are, and
//    refuses a held row out loud.
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
const mine = (list) => list.filter((it) => it.projectSlug === SLUG).map((it) => it.id);

let built; let claimedOnly; let parent; let piece; let fly;
test('setup', async () => {
  await call('POST', '/ingest', { project: { slug: SLUG, name: SLUG }, session: { summary: 'seed' } });
  built = await post({ title: 'built' });
  await call('PATCH', `/projects/${SLUG}/roadmap/${built.id}`, { claimed_by: 'feat/x', built_note: 'did it' });
  await call('POST', `/projects/${SLUG}/autopilot/runs`, { item_id: built.id, item_title: 'built', branch: 'feat/x', outcome: 'landed', commits: 2 });
  claimedOnly = await post({ title: 'in progress', claimed_by: 'feat/y' });
  parent = await post({ title: 'feature' });
  piece = await post({ title: 'piece', source: 'plan', parentId: parent.id });
  fly = await post({ title: 'a session idea', source: 'fly' });
});

test('the read sorts rows into built, plans and ideas', async () => {
  const r = await call('GET', '/inbox');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(mine(r.body.built), [built.id], 'claimed without a built note is not built');
  assert.equal(r.body.built.find((it) => it.id === built.id).run.commits, 2);
  assert.deepEqual(mine(r.body.plans), [piece.id]);
  assert.equal(r.body.plans.find((it) => it.id === piece.id).parentTitle, 'feature');
  assert.deepEqual(mine(r.body.ideas), [fly.id]);
  assert.equal(typeof r.body.loop.hold, 'string');
  const n = (await call('GET', '/inbox/count')).body;
  assert.ok(n.waiting >= 3);
});

test('a verdict takes a built row out', async () => {
  await call('PATCH', `/projects/${SLUG}/roadmap/${built.id}`, { review_tag: 'solid' });
  assert.deepEqual(mine((await call('GET', '/inbox')).body.built), []);
});

test('/ready/add appends in order, keeps the queue, and refuses a held row', async () => {
  const a = await post({ title: 'a' }); const b = await post({ title: 'b' });
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
  assert.deepEqual(mine((await call('GET', '/inbox')).body.plans), [], 'an approved piece leaves the plans');
  void claimedOnly;
});
