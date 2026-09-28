#!/usr/bin/env node
// PROJECT AREAS — which area of the Projects page a project sits in
// (`category`, keyed into the owner-named `categories` table), plus the rest
// of /api/spaces: hubs' workflows and the wishlist. A grouping only.
//
//  • A NEW PROJECT IS PERSONAL unless the create says otherwise.
//  • AN UNKNOWN AREA FALLS BACK, on create and on PATCH, rather than storing a
//    key the page has no section for.
//  • AN AREA WITH ANYTHING IN IT CAN'T BE DELETED, and Personal never can.
//  • A WORKFLOW NOTHING HAS REPORTED ON reads 'never', not healthy, and a run
//    report without a real boolean is refused rather than read as a pass.
//
// Needs a running server on a throwaway database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   STACK_API= node server/test/project-category.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

const API = process.env.STACK_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.API_TOKEN || 'testtok';

async function call(method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

const name = `category-test-${Date.now()}`;

test('a new project is personal by default', async () => {
  const r = await call('POST', '/projects', { name });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.category, 'personal');
});

test('create takes professional, and a bad value falls back', async () => {
  const pro = await call('POST', '/projects', { name: `${name}-pro`, category: 'professional' });
  assert.equal(pro.body.category, 'professional');
  const bad = await call('POST', '/projects', { name: `${name}-bad`, category: 'work' });
  assert.equal(bad.body.category, 'personal');
});

test('PATCH moves a project between halves, and the list carries it', async () => {
  const slug = (await call('GET', '/projects')).body.find((p) => p.name === name).slug;
  const moved = await call('PATCH', `/projects/${slug}`, { category: 'professional' });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.body.category, 'professional');
  const listed = (await call('GET', '/projects')).body.find((p) => p.slug === slug);
  assert.equal(listed.category, 'professional');
  const bad = await call('PATCH', `/projects/${slug}`, { category: 'nonsense' });
  assert.equal(bad.body.category, 'personal');
});

test('an owner-named area is created, takes projects, and refuses deletion while full', async () => {
  const a = await call('POST', '/spaces/areas', { name: 'Finance Test' });
  assert.equal(a.status, 201, a.text);
  const p = await call('POST', '/projects', { name: `${name}-fin`, category: a.body.key });
  assert.equal(p.body.category, a.body.key);
  assert.equal((await call('DELETE', `/spaces/areas/${a.body.key}`)).status, 409);
  assert.equal((await call('DELETE', '/spaces/areas/personal')).status, 409);
  await call('PATCH', `/projects/${p.body.slug}`, { category: 'personal' });
  assert.equal((await call('DELETE', `/spaces/areas/${a.body.key}`)).status, 200);
  const moved = await call('PATCH', `/projects/${p.body.slug}`, { category: a.body.key });
  assert.equal(moved.body.category, 'personal', 'a deleted area falls back');
});

test('a hub hosts workflows whose health is derived from reported runs', async () => {
  const app = await call('POST', '/projects', { name: `${name}-app` });
  assert.equal(app.body.kind, 'app');
  const notHub = await call('POST', '/spaces/workflows', { hub: app.body.slug, name: 'x' });
  assert.equal(notHub.status, 400);
  const hub = await call('POST', '/projects', { name: `${name}-hub`, kind: 'hub' });
  assert.equal(hub.body.kind, 'hub');
  const w = await call('POST', '/spaces/workflows', { hub: hub.body.slug, name: 'Bank Sync', trigger: 'cron · 06:00' });
  assert.equal(w.status, 201, w.text);
  assert.equal(w.body.name, 'bank-sync');
  assert.equal(w.body.status, 'never');
  assert.equal((await call('POST', `/spaces/workflows/${w.body.id}/runs`, {})).status, 400);
  const bad = await call('POST', `/spaces/workflows/${w.body.id}/runs`, { ok: false, note: 'timeout' });
  assert.equal(bad.body.status, 'failing');
  const paused = await call('PATCH', `/spaces/workflows/${w.body.id}`, { enabled: false });
  assert.equal(paused.body.status, 'paused');
  const all = await call('GET', '/spaces');
  assert.ok(all.body.workflows.some((x) => x.id === w.body.id && x.hub === hub.body.slug));
});

test('a wishlist idea is filed in an area, cycles stage, and is deleted', async () => {
  const i = await call('POST', '/spaces/ideas', { title: 'Reading log', area: 'nope' });
  assert.equal(i.status, 201, i.text);
  assert.equal(i.body.area, 'personal');
  assert.equal(i.body.stage, 'spark');
  const s = await call('PATCH', `/spaces/ideas/${i.body.id}`, { stage: 'ready' });
  assert.equal(s.body.stage, 'ready');
  assert.equal((await call('DELETE', `/spaces/ideas/${i.body.id}`)).status, 200);
});
