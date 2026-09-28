#!/usr/bin/env node
// #501 — the ✧ session labeller, POST /api/terminal/label. Nothing covered it,
// and a full UI smoke run kept recording it as a 5xx.
//
// WHY IT 5xx'd: the route itself is right. With no GEMINI_API_KEY it 503s (the
// sanctioned "absent key = silent degrade"), and a spent free-tier quota 503s
// too (gemini.js's quotaError). What was wrong was the CALLER: the Terminal
// screen's gate re-asked every 15s while anything stayed unnamed and ignored the
// label the server already held for a detached session, so every page load and
// every failed ask became another Gemini call. That is pinned, pure, in
// scripts/termname.test.mjs (`labelAskKeys`). This file pins the ROUTE's half —
// the contract the client's quiet catch is written against:
//
//  • keyless → 503 with a JSON `error`, NOT a 500 and not an empty 200. The
//    client catches it and leaves sessions unnamed; a 200 would lie that the
//    labeller ran, a 500 would read as a crash.
//  • it is a POST. The item was filed as "GET" because the smoke logged a URL
//    without its method; a GET is a 404 here, which is the point — nothing
//    should be reading labels off this path (they ride GET /detached).
//  • a detached row carries `label` ('' until named) on GET /detached — the
//    field the client's gate now reads so it never re-asks about a named one.
//  • it sits behind bearer auth like every other terminal route.
//
// Needs a running server started WITHOUT GEMINI_API_KEY and with no terminal
// daemon dialled in (a fresh throwaway database is enough):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   env -u GEMINI_API_KEY DATABASE_URL=postgres://t:t@127.0.0.1:55432/t \
//     API_TOKEN=testtok PORT=4599 node server/src/index.js &
//   STACK_API=http://127.0.0.1:4599 API_TOKEN=testtok node server/test/terminal-label.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

const API = process.env.STACK_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.API_TOKEN || 'testtok';

async function call(method, path, { auth = true } = {}) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: auth ? { authorization: `Bearer ${TOKEN}` } : {},
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* a non-JSON body is the assertion */ }
  return { status: res.status, body: json, text };
}

test('keyless: POST /terminal/label is a 503 with a JSON reason — never a 500 or an empty 200', async () => {
  const r = await call('POST', '/terminal/label');
  assert.equal(r.status, 503, r.text);
  assert.ok(r.body && typeof r.body.error === 'string', `expected a JSON error, got: ${r.text}`);
  assert.match(r.body.error, /Gemini is not configured/);
});

test('it is a POST: GET /terminal/label is not a route', async () => {
  const r = await call('GET', '/terminal/label');
  assert.equal(r.status, 404, r.text);
});

test('it is behind bearer auth', async () => {
  const r = await call('POST', '/terminal/label', { auth: false });
  assert.equal(r.status, 401, r.text);
});

test('GET /terminal/detached is where a label is read, and it answers with no daemon', async () => {
  const r = await call('GET', '/terminal/detached');
  assert.equal(r.status, 200, r.text);
  assert.ok(Array.isArray(r.body?.sessions), r.text);
  // Every row carries `label` as a string ('' until named): the client's gate
  // skips a row with one, which is what stops a page load re-asking about it.
  for (const d of r.body.sessions) assert.equal(typeof d.label, 'string');
});
