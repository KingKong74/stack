#!/usr/bin/env node
// ARTIFACTS — routes/artifacts.js.
//
//  • A WRITE IS CLEANED: an unknown type reads as doc, tags are deduped, and
//    a link to another project's row (or none at all) is dropped.
//  • THE BYTES NEVER RIDE A LIST, OR THE PROJECT PAYLOAD.
//  • A FILE IS SERVED AS DATA: a raster image keeps its type, anything else
//    (SVG and HTML included) is an octet-stream attachment.
//  • A DELETED ROADMAP ROW DROPS OUT OF `links` ON READ.
//
// Needs a running server on a throwaway database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   node server/test/artifacts.test.mjs
//
// Override with STACK_TEST_API / STACK_TEST_TOKEN.

import assert from 'node:assert/strict';
import test from 'node:test';

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = `art-${Date.now()}`;
const OTHER = `${SLUG}-other`;

async function call(method, path, body, headers = {}) {
  const raw = body instanceof Uint8Array;
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(raw || body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* bytes */ }
  return { status: res.status, body: json, text, headers: res.headers };
}
const base = (slug) => `/projects/${slug}/artifacts`;
const ids = {};

test('setup', async () => {
  for (const slug of [SLUG, OTHER]) {
    const r = await call('POST', '/ingest', { project: { slug, name: slug }, session: { summary: 'seed' } });
    assert.ok(r.status < 300, r.text);
  }
  ids.mine = (await call('POST', `/projects/${SLUG}/roadmap`, { title: 'an idea' })).body.id;
  ids.gone = (await call('POST', `/projects/${SLUG}/roadmap`, { title: 'doomed idea' })).body.id;
  ids.theirs = (await call('POST', `/projects/${OTHER}/roadmap`, { title: 'not mine' })).body.id;
});

test('a write is cleaned', async () => {
  const r = await call('POST', base(SLUG), {
    type: 'nonsense', title: 'Spec', body: 'Goal\n- [ ] a step',
    tags: ['board', 'board', ' ', 'plans'], links: [ids.mine, ids.theirs, 999999, 'x', ids.gone],
  });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.type, 'doc');
  assert.deepEqual(r.body.tags, ['board', 'plans']);
  assert.deepEqual(r.body.links, [ids.mine, ids.gone], 'another project\'s row is never linked');
  assert.equal(r.body.file, null);
  ids.doc = r.body.id;

  const p = await call('PATCH', `${base(SLUG)}/${ids.doc}`, { title: 'Spec v2' });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.body.title, 'Spec v2');
  assert.deepEqual(p.body.tags, ['board', 'plans'], 'a partial keeps what it does not name');
  assert.equal((await call('PATCH', `${base(SLUG)}/${ids.doc}`, {})).status, 400);
  assert.equal((await call('PATCH', `${base(OTHER)}/${ids.doc}`, { title: 'x' })).status, 404, 'another project cannot edit it');
});

test('a deleted roadmap row drops out of links on read', async () => {
  assert.equal((await call('DELETE', `/projects/${SLUG}/roadmap/${ids.gone}`)).status < 300, true);
  const l = await call('GET', base(SLUG));
  assert.deepEqual(l.body.find((a) => a.id === ids.doc).links, [ids.mine]);
});

test('a file is served as data, and never rides a list or the payload', async () => {
  const png = (await call('POST', base(SLUG), { type: 'design', title: 'mock' })).body.id;
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const up = await call('PUT', `${base(SLUG)}/${png}/file`, bytes,
    { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('mock up.png') });
  assert.equal(up.status, 200, up.text);
  assert.deepEqual(up.body.file, { name: 'mock up.png', size: 7, mime: 'image/png', image: true });
  const got = await call('GET', `${base(SLUG)}/${png}/file`);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');

  const svg = (await call('POST', base(SLUG), { type: 'file', title: 'x.svg' })).body.id;
  await call('PUT', `${base(SLUG)}/${svg}/file`, new TextEncoder().encode('<svg onload="alert(1)"/>'),
    { 'content-type': 'image/svg+xml', 'x-file-name': 'x.svg' });
  const s = await call('GET', `${base(SLUG)}/${svg}/file`);
  assert.equal(s.headers.get('content-type'), 'application/octet-stream', 'SVG is never served as a page');
  assert.match(s.headers.get('content-disposition'), /^attachment/);

  const list = await call('GET', base(SLUG));
  assert.ok(!list.text.includes('file_data') && !list.text.includes('alert(1)'), 'a list carries no bytes');
  const payload = await call('GET', `/projects/${SLUG}`);
  assert.ok(!payload.text.includes('mock up.png'), 'the SessionStart payload carries no artifact');

  assert.equal((await call('GET', `${base(OTHER)}/${png}/file`)).status, 404, 'another project cannot read it');
  assert.equal((await call('PUT', `${base(SLUG)}/${png}/file`, new Uint8Array(0), { 'content-type': 'image/png' })).status, 400);
});

test('delete', async () => {
  assert.equal((await call('DELETE', `${base(OTHER)}/${ids.doc}`)).status, 404);
  assert.equal((await call('DELETE', `${base(SLUG)}/${ids.doc}`)).status, 204);
  assert.equal((await call('DELETE', `${base(SLUG)}/${ids.doc}`)).status, 404);
  assert.equal((await call('GET', `${base(SLUG)}/abc/file`)).status, 400);
});
