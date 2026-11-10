#!/usr/bin/env node
// #616 — CHARTER AND ARCHITECTURE: the spine's docs and components.
//
//  • One charter and one architecture doc per project: a second POST is a
//    409 naming the first. The plain artifact list leaves all three spine
//    types out; `?types=` asks for them, oldest first.
//  • An ADR's status is proposed | accepted | superseded (junk → proposed);
//    every other type carries ''. `sliceId` must be a slice in this project.
//  • A `note` (the Notes view's loose idea) is kept off the plain list too,
//    carries no status, and is asked for with `?types=note`.
//  • The payload carries the charter's OPENING, capped and saying so.
//  • An area (component) takes a description and paths; renaming it rewrites
//    every slice naming it, and deleting it strips it off them.
//
// Same harness as spine.test.mjs (a running server on a fresh database):
//   DATABASE_URL=… API_TOKEN=testtok PORT=4599 node server/src/index.js &
//   node server/test/spine-docs.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = `docs-${Date.now()}`;
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

let charter; let slice;

test('setup', async () => {
  const r = await call('POST', '/ingest', { project: { slug: SLUG, name: SLUG }, session: { summary: 'seed' } });
  assert.ok(r.status < 300, r.text);
  slice = (await call('POST', `${P}/slices`, { title: 'S', areas: ['web', 'api'] })).body;
  await call('POST', `${P}/artifacts`, { type: 'doc', title: 'a plain doc', body: 'x' });
});

test('one charter per project; a second is a 409 naming the first', async () => {
  let r = await call('POST', `${P}/artifacts`, { type: 'charter', title: 'Charter', body: 'Why.' });
  assert.equal(r.status, 201, r.text);
  charter = r.body;
  assert.equal(charter.status, '', 'a charter wears no status');
  r = await call('POST', `${P}/artifacts`, { type: 'charter', title: 'Again', body: 'No.' });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.body.id, charter.id);
  const doc = (await call('POST', `${P}/artifacts`, { type: 'doc', title: 'd', body: '' })).body;
  r = await call('PATCH', `${P}/artifacts/${doc.id}`, { type: 'charter' });
  assert.equal(r.status, 409, 'retyping a doc into a second charter is refused too');
  assert.equal((await call('POST', `${P}/artifacts`, { type: 'architecture', title: 'A', body: 'map' })).status, 201);
  const design = await call('POST', `${P}/artifacts`, { type: 'design_doc', title: 'Design', body: '## Colours' });
  assert.equal(design.status, 201, design.text);
  r = await call('POST', `${P}/artifacts`, { type: 'design_doc', title: 'Again', body: '' });
  assert.equal(r.status, 409, 'one design doc per project');
  assert.equal(r.body.id, design.body.id);
});

test('the plain list leaves the spine out; ?types= asks for it', async () => {
  const plain = (await call('GET', `${P}/artifacts`)).body;
  assert.ok(plain.every((a) => !['charter', 'architecture', 'design_doc', 'adr'].includes(a.type)));
  assert.ok(plain.some((a) => a.title === 'a plain doc'));
  const spine = (await call('GET', `${P}/artifacts?types=charter,architecture,design_doc,adr`)).body;
  assert.deepEqual(spine.map((a) => a.type).sort(), ['architecture', 'charter', 'design_doc']);
});

test('a note is its own type, off the plain list, with no status', async () => {
  const r = await call('POST', `${P}/artifacts`, { type: 'note', title: 'An idea', body: 'An idea\nmore', status: 'accepted' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.type, 'note');
  assert.equal(r.body.status, '', 'only an ADR carries a status');
  const plain = (await call('GET', `${P}/artifacts`)).body;
  assert.ok(plain.every((a) => a.type !== 'note'), 'notes stay off the Artifacts tab');
  const notes = (await call('GET', `${P}/artifacts?types=note`)).body;
  assert.deepEqual(notes.map((a) => a.title), ['An idea']);
  const tagged = await call('PATCH', `${P}/artifacts/${r.body.id}`, { tags: ['converted', 'became:milestone:7'] });
  assert.deepEqual(tagged.body.tags, ['converted', 'became:milestone:7']);
});

test('ADR status and slice', async () => {
  let r = await call('POST', `${P}/artifacts`, { type: 'adr', title: 'Use Postgres', body: '', status: 'nonsense' });
  assert.equal(r.status, 201, r.text);
  const adr = r.body;
  assert.equal(adr.status, 'proposed', 'junk is a decision nobody has ruled on');
  r = await call('PATCH', `${P}/artifacts/${adr.id}`, { status: 'accepted', sliceId: slice.id });
  assert.equal(r.body.status, 'accepted');
  assert.equal(r.body.sliceId, slice.id);
  r = await call('PATCH', `${P}/artifacts/${adr.id}`, { sliceId: 99999 });
  assert.equal(r.status, 400, 'a slice from nowhere is refused, not cleared');
  r = await call('PATCH', `${P}/artifacts/${charter.id}`, { status: 'accepted' });
  assert.equal(r.status, 400, 'a status on a charter is dropped, leaving nothing to change');
  r = await call('PATCH', `${P}/artifacts/${adr.id}`, { sliceId: null });
  assert.equal(r.body.sliceId, null);
});

test('the payload carries the charter opening, capped and saying so', async () => {
  let p = (await call('GET', P)).body;
  assert.equal(p.charter.summary, 'Why.');
  assert.equal(p.charter.truncated, false);
  const long = `${'word '.repeat(200)}\n\nend`;
  await call('PATCH', `${P}/artifacts/${charter.id}`, { body: long });
  p = (await call('GET', P)).body;
  assert.equal(p.charter.summary.length <= p.charter.cap, true);
  assert.equal(p.charter.truncated, true);
  assert.equal(p.charter.cap, 600);
});

test('a component takes a description and paths, and survives a rename', async () => {
  let r = await call('PATCH', `${P}/board/areas/web`, { description: 'The client.', paths: ['web/src/**', ' web/src/** ', ''] });
  assert.equal(r.status, 200, r.text);
  let web = r.body.areas.find((a) => a.name === 'web');
  assert.equal(web.description, 'The client.');
  assert.deepEqual(web.paths, ['web/src/**'], 'trimmed and deduped');
  assert.ok(r.body.areas.some((a) => a.name === 'api' && !a.registered), 'a slice naming an area makes it real');

  r = await call('PATCH', `${P}/board/areas/web`, { name: 'client' });
  web = r.body.areas.find((a) => a.name === 'client');
  assert.equal(web.description, 'The client.', 'the words travel with the rename');
  const s = (await call('GET', `${P}/slices`)).body.find((x) => x.id === slice.id);
  assert.deepEqual(s.areas.sort(), ['api', 'client'], 'the slice names the new name');
});

test('deleting a component strips it off every slice', async () => {
  await call('DELETE', `${P}/board/areas/api`);
  const s = (await call('GET', `${P}/slices`)).body.find((x) => x.id === slice.id);
  assert.deepEqual(s.areas, ['client']);
});
