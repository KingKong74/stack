#!/usr/bin/env node
// STARRED — routes/starred.js.
//
//  • A STAR LANDS ON THE ROW: a card and a doc each come back starred, in the
//    list newest first, and in the project payload's `starredCount`.
//  • A STAR IS NOT AN EDIT: `updated_at` does not move, and a re-star keeps
//    the first time.
//  • ONLY THIS ROUTE WRITES IT: PATCH on the card or the doc ignores it.
//  • A BAD BODY IS REFUSED, never read as an unstar; another project's row
//    is a 404; a deleted row takes its star with it.
//  • THE LIST CAPS A DOC'S TEXT.
//
// Needs a running server on a throwaway database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   node server/test/starred.test.mjs
//
// Override with STACK_TEST_API / STACK_TEST_TOKEN. Unset STACK_API: it points
// at production.

import assert from 'node:assert/strict';
import test from 'node:test';

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = `star-${Date.now()}`;
const OTHER = `${SLUG}-other`;

async function call(method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const star = (kind, id, starred, slug = SLUG) => call('PUT', `/projects/${slug}/starred/${kind}/${id}`, starred === undefined ? {} : { starred });
const list = () => call('GET', `/projects/${SLUG}/starred`);
const ids = {};

test('setup', async () => {
  for (const slug of [SLUG, OTHER]) {
    const r = await call('POST', '/ingest', { project: { slug, name: slug }, session: { summary: 'seed' } });
    assert.ok(r.status < 300, r.text);
  }
  ids.card = (await call('POST', `/projects/${SLUG}/roadmap`, { title: 'a card' })).body.id;
  ids.card2 = (await call('POST', `/projects/${SLUG}/roadmap`, { title: 'another card' })).body.id;
  ids.note = (await call('POST', `/projects/${SLUG}/artifacts`, { type: 'note', title: '', body: `Idea\n${'x'.repeat(2000)}` })).body.id;
  assert.ok(ids.card && ids.card2 && ids.note);
});

test('nothing is starred at first', async () => {
  const l = await list();
  assert.equal(l.status, 200, l.text);
  assert.deepEqual(l.body, { cards: [], docs: [] });
  assert.equal((await call('GET', `/projects/${SLUG}`)).body.starredCount, 0);
});

test('a star lands on the row and is not an edit', async () => {
  const before = (await call('GET', `/projects/${SLUG}/artifacts?types=note`)).body.find((a) => a.id === ids.note);
  const s = await star('docs', ids.note, true);
  assert.equal(s.status, 200, s.text);
  assert.ok(s.body.starredAt);
  const after = (await call('GET', `/projects/${SLUG}/artifacts?types=note`)).body.find((a) => a.id === ids.note);
  assert.equal(after.updatedAt, before.updatedAt, 'starring a doc does not make it edited');
  assert.equal(after.starredAt, s.body.starredAt);

  const first = (await star('cards', ids.card, true)).body.starredAt;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await star('cards', ids.card, true)).body.starredAt, first, 're-starring keeps the first time');
  await star('cards', ids.card2, true);

  const l = (await list()).body;
  assert.deepEqual(l.cards.map((c) => c.id), [ids.card2, ids.card], 'newest star first');
  assert.equal(l.docs[0].id, ids.note);
  assert.ok(l.docs[0].body.length <= 600, 'the list caps a doc');
  const p = (await call('GET', `/projects/${SLUG}`)).body;
  assert.equal(p.starredCount, 3);
  const row = Object.values(p.roadmap).flat().find((r) => r.id === ids.card);
  assert.equal(row?.starredAt, first, 'the board sees the star in the payload');
});

test('only this route writes it', async () => {
  await call('PATCH', `/projects/${SLUG}/roadmap/${ids.card}`, { starredAt: null, starred_at: null, title: 'a card, renamed' });
  await call('PATCH', `/projects/${SLUG}/artifacts/${ids.note}`, { starredAt: null, starred_at: null, title: 'renamed' });
  const l = (await list()).body;
  assert.ok(l.cards.some((c) => c.id === ids.card), 'a card PATCH cannot unstar');
  assert.ok(l.docs.some((d) => d.id === ids.note), 'a doc PATCH cannot unstar');
});

test('a bad body is refused; another project is a 404', async () => {
  assert.equal((await star('cards', ids.card)).status, 400, 'no body is not an unstar');
  assert.equal((await star('cards', ids.card, 'false')).status, 400, 'a string is not a boolean');
  assert.equal((await star('cards', ids.card, false, OTHER)).status, 404);
  assert.equal((await star('docs', ids.note, false, OTHER)).status, 404);
  assert.equal((await list()).body.cards.length, 2, 'none of that unstarred anything');
});

test('unstar, and a deleted row takes its star with it', async () => {
  const u = await star('cards', ids.card2, false);
  assert.equal(u.status, 200, u.text);
  assert.equal(u.body.starredAt, null);
  assert.equal((await call('DELETE', `/projects/${SLUG}/artifacts/${ids.note}`)).status, 204);
  const l = (await list()).body;
  assert.deepEqual(l.cards.map((c) => c.id), [ids.card]);
  assert.deepEqual(l.docs, []);
  assert.equal((await call('GET', `/projects/${SLUG}`)).body.starredCount, 1);
});
