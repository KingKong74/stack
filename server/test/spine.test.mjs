#!/usr/bin/env node
// #608 — THE SPINE's routes: milestones, slices, item → slice, and the Ready
// gate. The migration has its own file (spine-migration.test.mjs).
//
//  • A first slice in a project with no milestone makes "Current" for it.
//  • At most one milestone is active; making one current finishes the other.
//  • A milestone with slices cannot be deleted; a deleted slice ICES its items
//    and takes them out of Ready first.
//  • A part with no sliceId takes its parent's slice.
//  • Ready refuses an iced item out loud; icing a Ready item takes it out.
//  • Progress counts sliced work only.
//
// Same harness as ready-queue.test.mjs (a running server on a fresh database):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   node server/test/spine.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = `spine-${Date.now()}`;
const P = `/projects/${SLUG}`;

async function call(method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
const project = async () => (await call('GET', P)).body;
const rowOf = async (id) => Object.values((await project()).roadmap).flat().find((r) => r.id === id);

let first; let slice;

test('setup', async () => {
  const r = await call('POST', '/ingest', { project: { slug: SLUG, name: SLUG }, session: { summary: 'seed' } });
  assert.ok(r.status < 300, r.text);
});

test('the first slice of a board with no milestone makes "Current" for it', async () => {
  const r = await call('POST', `${P}/slices`, { title: 'Board by slice', areas: ['Board', 'board', ' web '] });
  assert.equal(r.status, 201, r.text);
  slice = r.body;
  assert.deepEqual(slice.areas, ['board', 'web'], 'areas normalise like roadmap_items.area, deduped');
  const ms = (await call('GET', `${P}/milestones`)).body;
  assert.equal(ms.length, 1);
  assert.equal(ms[0].name, 'Current');
  assert.equal(ms[0].status, 'active');
  assert.equal(slice.milestoneId, ms[0].id);
  first = ms[0];
});

test('the payload carries milestones and slices', async () => {
  const p = await project();
  assert.deepEqual(p.milestones.map((m) => m.id), [first.id]);
  assert.deepEqual(p.slices.map((s) => s.id), [slice.id]);
});

test('making a milestone current finishes the incumbent, in one write', async () => {
  const next = (await call('POST', `${P}/milestones`, { name: 'Beta', goal: 'ship it', targetOn: '2026-12-01' })).body;
  assert.equal(next.status, 'planned');
  assert.equal(next.targetOn, '2026-12-01', 'a DAY, not shifted by a zone');
  const r = await call('PATCH', `${P}/milestones/${next.id}`, { status: 'active' });
  assert.equal(r.status, 200, r.text);
  const ms = (await call('GET', `${P}/milestones`)).body;
  assert.deepEqual(ms.filter((m) => m.status === 'active').map((m) => m.id), [next.id]);
  assert.equal(ms.find((m) => m.id === first.id).status, 'done');
  assert.ok(ms.find((m) => m.id === first.id).endedAt);
});

test('a milestone with slices cannot be deleted; an empty one can', async () => {
  const r = await call('DELETE', `${P}/milestones/${first.id}`);
  assert.equal(r.status, 409, r.text);
  assert.match(r.body.error, /1 slice/);
  const spare = (await call('POST', `${P}/milestones`, { name: 'Spare' })).body;
  assert.equal((await call('DELETE', `${P}/milestones/${spare.id}`)).status, 200);
});

test('a slice is refused a milestone from nowhere, and one with no name', async () => {
  assert.equal((await call('POST', `${P}/slices`, { title: 'x', milestoneId: 99999 })).status, 400);
  assert.equal((await call('POST', `${P}/slices`, { title: '  ' })).status, 400);
  assert.equal((await call('PATCH', `${P}/slices/${slice.id}`, { milestoneId: null })).status, 400,
    'moving a slice is explicit; null is not "the current one"');
});

test('items: filed into a slice, iced by default, parts inherit', async () => {
  const inSlice = (await call('POST', `${P}/roadmap`, { title: 'in the slice', sliceId: slice.id })).body;
  assert.equal(inSlice.sliceId, slice.id);
  const second = (await call('POST', `${P}/roadmap`, { title: 'second in', sliceId: slice.id })).body;
  assert.equal(second.sliceRank, inSlice.sliceRank + 1, 'a create lands at the bottom of the slice');
  const iced = (await call('POST', `${P}/roadmap`, { title: 'an idea' })).body;
  assert.equal(iced.sliceId, null, 'no slice = the Icebox');
  const part = (await call('POST', `${P}/roadmap`, { title: 'a part', parentId: inSlice.id, source: 'plan' })).body;
  assert.equal(part.sliceId, slice.id, 'a part takes its parent\'s slice');
  const bad = await call('POST', `${P}/roadmap`, { title: 'nope', sliceId: 99999 });
  assert.equal(bad.status, 400, 'a bad slice is refused, not dropped into the Icebox');
});

test('Ready refuses an iced item out loud, and icing a Ready item takes it out', async () => {
  const iced = (await call('POST', `${P}/roadmap`, { title: 'iced build' })).body;
  let r = await call('PUT', `${P}/ready`, { items: [iced.id] });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(r.body.unsliced, [iced.id]);
  assert.match(r.body.error, /Icebox/);
  r = await call('POST', `${P}/ready/add`, { items: [iced.id] });
  assert.equal(r.status, 409, 'the append route has the same gate');

  r = await call('PATCH', `${P}/roadmap/${iced.id}`, { sliceId: slice.id });
  assert.equal(r.status, 200, r.text);
  r = await call('PUT', `${P}/ready`, { items: [iced.id] });
  assert.equal(r.status, 200, r.text);
  assert.equal((await rowOf(iced.id)).ready, true);

  r = await call('PATCH', `${P}/roadmap/${iced.id}`, { sliceId: null });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.sliceId, null);
  assert.equal(r.body.ready, false, 'iced = out of the build lane, in the same write');

  r = await call('PATCH', `${P}/roadmap/${iced.id}`, { sliceId: 99999 });
  assert.equal(r.status, 400, 'a slice from nowhere is refused, not resolved to the Icebox');
});

test('deleting a slice ices its items and takes them out of Ready first', async () => {
  const doomed = (await call('POST', `${P}/slices`, { title: 'doomed' })).body;
  const it = (await call('POST', `${P}/roadmap`, { title: 'in doomed', sliceId: doomed.id })).body;
  assert.equal((await call('PUT', `${P}/ready`, { items: [it.id] })).status, 200);
  const r = await call('DELETE', `${P}/slices/${doomed.id}`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.iced, [it.id]);
  const after = await rowOf(it.id);
  assert.equal(after.sliceId, null);
  assert.equal(after.ready, false);
});

test('progress counts sliced work only', async () => {
  const fresh = `${SLUG}-p`;
  await call('POST', '/ingest', { project: { slug: fresh, name: fresh }, session: { summary: 'seed' } });
  const s = (await call('POST', `/projects/${fresh}/slices`, { title: 's' })).body;
  const a = (await call('POST', `/projects/${fresh}/roadmap`, { title: 'done one', sliceId: s.id })).body;
  await call('PATCH', `/projects/${fresh}/roadmap/${a.id}`, { done: true });
  await call('POST', `/projects/${fresh}/roadmap`, { title: 'iced one' });
  await call('POST', `/projects/${fresh}/roadmap`, { title: 'iced two' });
  assert.equal((await call('GET', `/projects/${fresh}`)).body.progress, 100, 'two iced rows do not drag 100% down');
});
