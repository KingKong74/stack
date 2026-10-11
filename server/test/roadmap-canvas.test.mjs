#!/usr/bin/env node
// THE ROADMAP CANVAS — where a kept idea sits, and how shaped it is.
//
//  • A CANVAS IS CLEANED, NOT TRUSTED: unknown keys dropped, a stage outside
//    raw|exploring|shaped dropped, positions clamped, and raw is stored as no
//    stage at all. A new row's canvas is {} (unplaced: the canvas's inbox).
//  • A WRITE IS A MERGE: a partial keeps the keys it does not name, and a null
//    removes one, so a drag never clobbers a stage or a vote.
//  • ALL OR NOTHING, AND THIS PROJECT ONLY: one id from another project makes
//    the whole call 404 and writes nothing.
//  • IT IS NOT MOVEMENT: updated_at does not change.
//
// Needs a running server on a throwaway database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   node server/test/roadmap-canvas.test.mjs
//
// Override with STACK_TEST_API / STACK_TEST_TOKEN.

import assert from 'node:assert/strict';
import test from 'node:test';

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = `canvas-${Date.now()}`;
const OTHER = `${SLUG}-other`;

async function call(method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
const rm = (slug) => `/projects/${slug}/roadmap`;
const put = (slug, items) => call('PUT', `${rm(slug)}/canvas`, { items });
const ids = {};

test('setup', async () => {
  for (const slug of [SLUG, OTHER]) {
    const r = await call('POST', '/ingest', { project: { slug, name: slug }, session: { summary: 'seed' } });
    assert.ok(r.status < 300, r.text);
  }
  for (const k of ['a', 'b']) {
    const r = await call('POST', rm(SLUG), { title: `idea ${k}` });
    assert.equal(r.status, 201, r.text);
    ids[k] = r.body.id;
    assert.deepEqual(r.body.canvas, {}, 'a new row is unplaced');
  }
  const o = await call('POST', rm(OTHER), { title: 'elsewhere' });
  ids.other = o.body.id;
});

test('a canvas is cleaned: junk dropped, positions clamped, raw stored as no stage', async () => {
  const r = await put(SLUG, [
    { id: ids.a, canvas: { stage: 'shaped', c: { x: 12.4, y: -50 }, pinned: true, votes: 3, junk: 1 } },
    { id: ids.b, canvas: { stage: 'promoted', l: { x: 'no', y: 1 }, group: '  Overnight  ', votes: -2 } },
  ]);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.items[0].canvas, { stage: 'shaped', c: { x: 12, y: 0 }, pinned: true, votes: 3 });
  assert.deepEqual(r.body.items[1].canvas, { group: 'Overnight' });
});

test('a write merges, and null removes a key', async () => {
  const before = (await call('GET', rm(SLUG))).body;
  const flat = Object.values(before).flat();
  const stamp = flat.find((it) => it.id === ids.a).updatedAt;

  const r = await put(SLUG, [{ id: ids.a, canvas: { c: { x: 400, y: 300 }, pinned: null } }]);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.items[0].canvas, { stage: 'shaped', c: { x: 400, y: 300 }, votes: 3 });

  const after = (await call('GET', rm(SLUG))).body;
  const row = Object.values(after).flat().find((it) => it.id === ids.a);
  assert.deepEqual(row.canvas, { stage: 'shaped', c: { x: 400, y: 300 }, votes: 3 }, 'the payload serves it');
  assert.equal(row.updatedAt, stamp, 'moving a note is not movement on the work');

  const raw = await put(SLUG, [{ id: ids.a, canvas: { stage: 'raw' } }]);
  assert.equal(raw.body.items[0].canvas.stage, undefined, 'raw is the absence of a stage');
});

test('another project\'s row fails the whole call and writes nothing', async () => {
  const r = await put(SLUG, [{ id: ids.b, canvas: { votes: 9 } }, { id: ids.other, canvas: { votes: 1 } }]);
  assert.equal(r.status, 404, r.text);
  const again = await put(SLUG, [{ id: ids.b, canvas: {} }]);
  assert.equal(again.body.items[0].canvas.votes, undefined, 'the first item was rolled back');
});

test('a malformed call is refused', async () => {
  assert.equal((await put(SLUG, [])).status, 400);
  assert.equal((await put(SLUG, [{ id: 'x', canvas: {} }])).status, 400);
  assert.equal((await put(SLUG, [{ id: ids.a, canvas: [] }])).status, 400);
});
