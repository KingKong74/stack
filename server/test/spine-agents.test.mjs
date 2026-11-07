#!/usr/bin/env node
// #626 — AGENTS READ AND WRITE THE SPINE.
//
//  • A /checkpoint may name its slice (`session.slice`): recorded when it is a
//    slice on this board, reported back and ignored when it is not.
//  • It may propose decisions: filed as ADRs with status PROPOSED, never
//    accepted, at most three. A re-proposal changes nothing; a proposal the
//    owner deleted is tombstoned and never comes back.
//  • An approved plan-mode plan lands on the slice of the item its branch has
//    claimed, and becomes that slice's spec only when the spec is empty.
//
// Same harness as spine.test.mjs (a running server on a fresh database):
//   DATABASE_URL=… API_TOKEN=testtok PORT=4599 node server/src/index.js &
//   node server/test/spine-agents.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = `agents-${Date.now()}`;
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
const checkpoint = (session, extract = {}) =>
  call('POST', '/ingest', { project: { slug: SLUG, name: SLUG }, session: { summary: 'cp', ...session }, extract });
const adrs = async () => (await call('GET', `${P}/artifacts?types=adr`)).body;

let slice; let other;

test('setup', async () => {
  assert.ok((await checkpoint({})).status < 300);
  slice = (await call('POST', `${P}/slices`, { title: 'Sign-up' })).body;
  other = (await call('POST', `/projects/${SLUG}-x/slices`, { title: 'not here' }));
  if (other.status === 404) {
    await call('POST', '/ingest', { project: { slug: `${SLUG}-x`, name: 'x' }, session: { summary: 's' } });
    other = await call('POST', `/projects/${SLUG}-x/slices`, { title: 'not here' });
  }
  other = other.body;
});

test('a checkpoint names its slice; a stranger\'s slice is reported, not recorded', async () => {
  let r = await checkpoint({ commit_hash: 'aaa1111', slice: slice.id });
  assert.deepEqual(r.body.slice, { sent: slice.id, recorded: slice.id });
  const p = (await call('GET', P)).body;
  assert.equal(p.activity[0].sliceId, slice.id);
  r = await checkpoint({ commit_hash: 'bbb2222', slice: other.id });
  assert.deepEqual(r.body.slice, { sent: other.id, recorded: null });
});

test('decisions file as PROPOSED ADRs on the session\'s slice, at most three', async () => {
  const r = await checkpoint({ commit_hash: 'ccc3333', slice: slice.id }, {
    decisions: [
      { title: 'Magic links over passwords', context: 'Solo users.', decision: 'Links only.', consequences: 'Email must work.' },
      { title: 'No decision text', context: 'x' },
      { title: 'Two', decision: 'b' }, { title: 'Three', decision: 'c' }, { title: 'Four', decision: 'd' },
    ],
  });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.decisions, { proposed: 3, sent: 3 }, 'an entry with no decision is dropped; the rest capped at 3');
  const log = await adrs();
  const magic = log.find((a) => a.title === 'Magic links over passwords');
  assert.equal(magic.status, 'proposed', 'a session never accepts a decision');
  assert.equal(magic.sliceId, slice.id);
  assert.equal(magic.origin.kind, 'checkpoint');
  assert.match(magic.body, /## Decision\n\nLinks only\./);
  assert.ok(!log.some((a) => a.title === 'Four'));
});

test('a re-proposal changes nothing, even after the owner accepted it', async () => {
  const magic = (await adrs()).find((a) => a.title === 'Magic links over passwords');
  await call('PATCH', `${P}/artifacts/${magic.id}`, { status: 'accepted' });
  const r = await checkpoint({ commit_hash: 'ddd4444' }, { decisions: [{ title: 'Magic links over passwords', decision: 'Changed my mind.' }] });
  assert.equal(r.body.decisions.proposed, 0);
  const again = (await adrs()).find((a) => a.id === magic.id);
  assert.equal(again.status, 'accepted', 'the owner\'s word stands');
  assert.match(again.body, /Links only/);
});

test('a proposal the owner deleted is never proposed again', async () => {
  const two = (await adrs()).find((a) => a.title === 'Two');
  assert.equal((await call('DELETE', `${P}/artifacts/${two.id}`)).status, 204);
  const r = await checkpoint({ commit_hash: 'eee5555' }, { decisions: [{ title: 'Two', decision: 'again' }] });
  assert.equal(r.body.decisions.proposed, 0);
  assert.ok(!(await adrs()).some((a) => a.title === 'Two'));
});

test('a plan-mode plan lands on its branch\'s slice and fills an EMPTY spec only', async () => {
  const it = (await call('POST', `${P}/roadmap`, { title: 'build sign-up', sliceId: slice.id })).body;
  await call('PATCH', `${P}/roadmap/${it.id}`, { claimed_by: 'feat/1-signup' });
  let r = await call('POST', `${P}/plans`, { body: '# Sign-up plan\n\nDo the thing.', sessionId: 's1', branch: 'feat/1-signup' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.sliceId, slice.id);
  assert.equal(r.body.specFilled, true);
  let s = (await call('GET', `${P}/slices`)).body.find((x) => x.id === slice.id);
  assert.match(s.spec, /Sign-up plan/);

  r = await call('POST', `${P}/plans`, { body: '# A second plan\n\nOther.', sessionId: 's2', branch: 'feat/1-signup' });
  assert.equal(r.body.sliceId, slice.id, 'still linked');
  assert.equal(r.body.specFilled, false, 'a spec already written is never replaced');
  s = (await call('GET', `${P}/slices`)).body.find((x) => x.id === slice.id);
  assert.doesNotMatch(s.spec, /second plan/);

  r = await call('POST', `${P}/plans`, { body: '# Loose plan', sessionId: 's3', branch: 'feat/nothing-claimed' });
  assert.equal(r.body.sliceId, null, 'no claimed item, no slice: a plain doc, as before');
  r = await call('POST', `${P}/plans`, { body: '# Pointed plan', sessionId: 's4', sliceId: other.id });
  assert.equal(r.body.sliceId, null, 'a slice from another project is ignored');
});
