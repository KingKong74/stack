#!/usr/bin/env node
// PROJECT CATEGORY — which half of the Projects page a project sits in
// (personal | professional). A grouping only: nothing gates on it.
//
//  • A NEW PROJECT IS PERSONAL unless the create says otherwise, and every
//    existing row migrates to personal, so the page never has an orphan.
//  • A BAD VALUE FALLS BACK, on create and on PATCH, rather than storing a
//    third category the page has no half for.
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
