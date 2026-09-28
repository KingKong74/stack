#!/usr/bin/env node
// SPECS AND BATCH CREATES — how a planning run (or a planning session) files a
// breakdown of work in one go.
//
//  • A SPEC IS CLEANED, NOT TRUSTED: unknown keys dropped, lists capped, and an
//    empty spec is {}.
//  • A BATCH IS ALL OR NOTHING: one bad item (a parent in another project, a
//    source the route refuses) makes none of them.
//  • A BATCH CANNOT COMMISSION WORK: a sprint sent along is ignored, like POST /.
//  • A 'plan' ROW IS HELD until approved, dedups per parent, and a dismissed
//    one is not re-created.
//
// Needs a running server on a throwaway database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   node server/test/roadmap-spec-batch.test.mjs
//
// Override with STACK_TEST_API / STACK_TEST_TOKEN.

import assert from 'node:assert/strict';
import test from 'node:test';

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = `spec-batch-${Date.now()}`;
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

test('setup', async () => {
  for (const slug of [SLUG, OTHER]) {
    const r = await call('POST', '/ingest', { project: { slug, name: slug }, session: { summary: 'seed' } });
    assert.ok(r.status < 300, r.text);
  }
});

test('a spec is cleaned: unknown keys dropped, lists capped, empty is {}', async () => {
  const r = await call('POST', rm(SLUG), {
    title: 'specced',
    spec: { goal: ' do it ', acceptance: ['a', '', 'b', ...Array(20).fill('x')], files: 'nope', junk: 1 },
  });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(Object.keys(r.body.spec).sort(), ['acceptance', 'goal']);
  assert.equal(r.body.spec.goal, 'do it');
  assert.equal(r.body.spec.acceptance.length, 12);
  const bare = await call('POST', rm(SLUG), { title: 'bare' });
  assert.deepEqual(bare.body.spec, {});
  const patched = await call('PATCH', `${rm(SLUG)}/${bare.body.id}`, { spec: { files: ['server/src/x.js'] } });
  assert.equal(patched.status, 200, patched.text);
  const list = await call('GET', `/projects/${SLUG}`);
  const row = Object.values(list.body.roadmap).flat().find((it) => it.id === bare.body.id);
  assert.deepEqual(row.spec, { files: ['server/src/x.js'] });
});

test('a long note survives up to the design-sized cap', async () => {
  const r = await call('POST', rm(SLUG), { title: 'long note', note: 'n'.repeat(5000) });
  assert.equal(r.body.note.length, 4000);
});

test('a batch makes every item, children under their parent, held when plan', async () => {
  const parent = await call('POST', rm(SLUG), { title: 'the feature' });
  const r = await call('POST', `${rm(SLUG)}/batch`, {
    items: [
      { title: 'piece one', source: 'plan', parentId: parent.body.id, spec: { goal: 'one' }, sprintId: 1 },
      { title: 'piece two', source: 'plan', parentId: parent.body.id },
    ],
  });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.items.length, 2);
  for (const it of r.body.items) {
    assert.equal(it.parentId, parent.body.id);
    assert.equal(it.source, 'plan');
    assert.equal(it.reviewed, false, 'a plan row is held');
    assert.equal(it.sprintId, null, 'a batch never sets a sprint');
  }
  // Re-filing the same breakdown returns the open children, not copies.
  const again = await call('POST', `${rm(SLUG)}/batch`, {
    items: [{ title: 'piece one', source: 'plan', parentId: parent.body.id }],
  });
  assert.equal(again.body.items[0].id, r.body.items[0].id);
});

test('one bad item makes none of them', async () => {
  const foreign = await call('POST', rm(OTHER), { title: 'not yours' });
  const before = Object.values((await call('GET', `/projects/${SLUG}`)).body.roadmap).flat().length;
  const r = await call('POST', `${rm(SLUG)}/batch`, {
    items: [{ title: 'fine' }, { title: 'bad parent', parentId: foreign.body.id }],
  });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.body.index, 1);
  const hook = await call('POST', `${rm(SLUG)}/batch`, { items: [{ title: 'sneaky', source: 'hook' }] });
  assert.equal(hook.status, 400);
  const after = Object.values((await call('GET', `/projects/${SLUG}`)).body.roadmap).flat().length;
  assert.equal(after, before, 'nothing from a failed batch was kept');
  assert.equal((await call('POST', `${rm(SLUG)}/batch`, { items: [] })).status, 400);
  assert.equal((await call('POST', `${rm(SLUG)}/batch`, { items: Array(51).fill({ title: 'x' }) })).status, 400);
});

test('a dismissed plan row is not re-created', async () => {
  const parent = await call('POST', rm(SLUG), { title: 'another feature' });
  const made = await call('POST', rm(SLUG), { title: 'unwanted piece', source: 'plan', parentId: parent.body.id });
  assert.equal(made.status, 201, made.text);
  assert.equal((await call('DELETE', `${rm(SLUG)}/${made.body.id}`)).status < 300, true);
  const again = await call('POST', rm(SLUG), { title: 'unwanted piece', source: 'plan', parentId: parent.body.id });
  assert.equal(again.status, 409, again.text);
});
