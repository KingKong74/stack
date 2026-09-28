#!/usr/bin/env node
// SESSION PLANS — plan-mode plans captured by hook/stack-plan.mjs on approval.
//
//  • THE HOOK FINDS THIS SESSION'S PLAN FILE. ExitPlanMode carries no plan
//    text, so the transcript's last ~/.claude/plans path must beat a newer
//    file another session wrote; an inline `plan` beats both.
//  • A POST NEVER CREATES A PROJECT. A plan from an unknown checkout 404s.
//  • A RETRIED HOOK IS A NO-OP and a revised plan is a new row.
//  • THE LIST CARRIES NO BODIES, and one project's plan is not another's.
//  • /:id/items RECORDS ONLY THIS PROJECT'S ROWS, once each, in order.
//
// Needs a running server on a throwaway database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   env -u STACK_API node server/test/session-plans.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPlan, planFileFromTranscript } from '../../hook/stack-plan.mjs';
import { planTitle } from '../src/routes/plans.js';

const API = process.env.STACK_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.API_TOKEN || 'testtok';

async function call(method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* the text is the assertion */ }
  return { status: res.status, body: json, text };
}

test('the hook prefers the transcript\'s plan file over a newer stranger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plans-'));
  const mine = join(dir, 'mine-plan.md');
  const theirs = join(dir, 'their-plan.md');
  writeFileSync(mine, '# Mine\n\nstep');
  writeFileSync(theirs, '# Theirs\n\nstep');
  const old = Date.now() / 1000 - 60;
  utimesSync(mine, old, old);
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, `{"x":"plan file is ${theirs}"}\n{"x":"now ${mine}"}\n`);
  assert.equal(planFileFromTranscript(`a ${theirs} b ${mine}`, dir), mine);
  assert.equal(findPlan({ transcript_path: transcript }, { dir }).file, mine);
  assert.equal(findPlan({}, { dir }).file, theirs, 'backstop: newest recent file');
  assert.equal(findPlan({ tool_input: { plan: '# Inline' }, transcript_path: transcript }, { dir }).body, '# Inline');
  assert.equal(findPlan({}, { dir: join(dir, 'nope') }), null);
});

test('a title is the first heading, else the first line', () => {
  assert.equal(planTitle('intro\n# The **plan**\n## sub'), 'The plan');
  assert.equal(planTitle('\n\nJust text\nmore'), 'Just text');
});

test('the route', async () => {
  const slug = `plans-test-${Date.now()}`;
  const other = `${slug}-other`;
  for (const s of [slug, other]) {
    const r = await call('POST', '/ingest', { project: { slug: s, name: s }, session: { summary: 'seed' } });
    assert.ok(r.status < 300, `seed ${s}: ${r.text}`);
  }
  const base = `/projects/${slug}/plans`;

  assert.equal((await call('POST', `/projects/${slug}-never/plans`, { body: '# x' })).status, 404);
  assert.equal((await call('POST', base, { body: '   ' })).status, 400);

  const one = await call('POST', base, { body: '# Ship it\n\n1. a', sessionId: 's1', planFile: '/home/x/.claude/plans/a-b.md' });
  assert.equal(one.status, 201, one.text);
  assert.equal(one.body.title, 'Ship it');
  assert.equal(one.body.planFile, 'a-b.md', 'only the basename is kept');

  const again = await call('POST', base, { body: '# Ship it\n\n1. a', sessionId: 's1' });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, one.body.id, 'a retried hook is a no-op');

  const revised = await call('POST', base, { body: '# Ship it\n\n1. a\n2. b', sessionId: 's1' });
  assert.equal(revised.status, 201);

  const list = await call('GET', base);
  assert.equal(list.body.length, 2);
  assert.equal(list.body[0].id, revised.body.id, 'newest first');
  assert.equal(list.body[0].body, undefined, 'the list carries no bodies');
  assert.ok(list.body[0].size > 0);

  const full = await call('GET', `${base}/${one.body.id}`);
  assert.equal(full.body.body, '# Ship it\n\n1. a');
  assert.equal((await call('GET', `/projects/${other}/plans/${one.body.id}`)).status, 404);
  assert.equal((await call('DELETE', `/projects/${other}/plans/${one.body.id}`)).status, 404);

  const mine = [];
  for (const t of ['a', 'b']) {
    const r = await call('POST', `/projects/${slug}/roadmap`, { title: `from plan ${t}` });
    assert.equal(r.status, 201, r.text);
    mine.push(r.body.id);
  }
  const theirs = (await call('POST', `/projects/${other}/roadmap`, { title: 'not mine' })).body.id;
  const linked = await call('POST', `${base}/${one.body.id}/items`, { ids: [mine[1], theirs, mine[1], 'x', 999999999] });
  assert.equal(linked.status, 200, linked.text);
  assert.deepEqual(linked.body.itemIds, [mine[1]], 'a foreign, junk or repeated id is dropped');
  const again2 = await call('POST', `${base}/${one.body.id}/items`, { ids: [mine[0], mine[1]] });
  assert.deepEqual(again2.body.itemIds, [mine[1], mine[0]], 'appended, never repeated');
  assert.equal((await call('POST', `/projects/${other}/plans/${one.body.id}/items`, { ids: [theirs] })).status, 404);
  assert.deepEqual((await call('GET', base)).body.find((x) => x.id === one.body.id).itemIds, [mine[1], mine[0]]);

  assert.equal((await call('DELETE', `${base}/${one.body.id}`)).status, 200);
  assert.equal((await call('GET', base)).body.length, 1);
});
