#!/usr/bin/env node
// BRANCH REPORT — the read side of the host's snapshot (GET /branches), which
// the board's Development tab draws.
//
//  • NO REPORT IS NOT NO BRANCHES: before the host posts, `reportedAt` is null,
//    so the client can say "Stack cannot see" rather than "nothing here".
//  • `mergeClean` null SURVIVES the round trip. Unprobed is not clean, and a
//    read that coerced it to false or true would manufacture a merge state.
//  • A POST WITHOUT `worktrees` LEAVES THE LAST LIST ALONE, and the read says
//    so by keeping `worktreesAt` too.
//
// Needs a running server on a throwaway database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   STACK_API= node server/test/branch-report.test.mjs

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

let slug;

test.before(async () => {
  const r = await call('POST', '/projects', { name: `branch-report-${Date.now()}` });
  assert.equal(r.status, 201, r.text);
  slug = r.body.slug;
});

test('an unknown project 404s', async () => {
  const r = await call('GET', '/projects/no-such-project-here/branches');
  assert.equal(r.status, 404);
});

test('before any report, reportedAt is null and the lists are empty', async () => {
  const r = await call('GET', `/projects/${slug}/branches`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body, { reportedAt: null, branches: [], worktreesAt: null, worktrees: [] });
});

test('a posted report reads back, unprobed stays null', async () => {
  const post = await call('POST', `/projects/${slug}/branches`, {
    branches: [
      { branch: 'feat/12-thing', ahead: 2, behind: 1, mergeClean: true, itemId: 12, adds: 5, dels: 1, files: 1,
        topFiles: [{ path: 'a.js', adds: 5, dels: 1 }] },
      { branch: 'fix/bug-3-oops', ahead: 1, behind: 0, mergeClean: 'yes' },
    ],
    worktrees: [{ path: '/tmp/wt', branch: 'feat/12-thing', dirty: 3, unpushed: null }],
  });
  assert.equal(post.status, 200, post.text);
  const r = await call('GET', `/projects/${slug}/branches`);
  assert.ok(r.body.reportedAt && r.body.worktreesAt);
  assert.equal(r.body.branches.length, 2);
  assert.equal(r.body.branches[0].mergeClean, true);
  assert.equal(r.body.branches[0].itemId, 12);
  assert.equal(r.body.branches[1].mergeClean, null, 'a non-boolean probe is unprobed, not clean');
  assert.equal(r.body.worktrees[0].dirty, 3);
  assert.equal(r.body.worktrees[0].unpushed, null);
});

test('a report without worktrees keeps the last worktree list', async () => {
  const before = (await call('GET', `/projects/${slug}/branches`)).body;
  await call('POST', `/projects/${slug}/branches`, { branches: [] });
  const r = (await call('GET', `/projects/${slug}/branches`)).body;
  assert.deepEqual(r.branches, []);
  assert.equal(r.worktrees.length, 1);
  assert.equal(r.worktreesAt, before.worktreesAt);
});
