#!/usr/bin/env node
// PLAN-MODE PLANS — captured by hook/stack-plan.mjs on approval, filed as
// `doc` artifacts by routes/plans.js.
//
//  • THE HOOK FINDS THIS SESSION'S PLAN FILE. ExitPlanMode carries no plan
//    text, so the transcript's last ~/.claude/plans path must beat a newer
//    file another session wrote; an inline `plan` beats both.
//  • A POST NEVER CREATES A PROJECT. A plan from an unknown checkout 404s.
//  • A RETRIED HOOK IS A NO-OP and a revised plan is a new artifact.
//  • IT LANDS IN THIS PROJECT'S ARTIFACTS ONLY, with its origin, and the old
//    plan reads (GET /plans, /plans/:id/items, DELETE) are gone.
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

  const one = await call('POST', base, { body: '# Ship it\n\n1. a', sessionId: 's1', planFile: '/home/x/.claude/plans/a-b.md', branch: 'main' });
  assert.equal(one.status, 201, one.text);
  assert.equal(one.body.type, 'doc');
  assert.equal(one.body.title, 'Ship it');
  assert.deepEqual(one.body.origin, { kind: 'plan-mode', sessionId: 's1', branch: 'main', commit: '', planFile: 'a-b.md' },
    'only the basename is kept');

  const again = await call('POST', base, { body: '# Ship it\n\n1. a', sessionId: 's1' });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, one.body.id, 'a retried hook is a no-op');

  const revised = await call('POST', base, { body: '# Ship it\n\n1. a\n2. b', sessionId: 's1' });
  assert.equal(revised.status, 201);
  const elsewhere = await call('POST', base, { body: '# Ship it\n\n1. a', sessionId: 's2' });
  assert.equal(elsewhere.status, 201, 'the same text from another session is its own plan');

  const arts = await call('GET', `/projects/${slug}/artifacts`);
  assert.equal(arts.body.length, 3);
  assert.equal(arts.body.find((a) => a.id === one.body.id).body, '# Ship it\n\n1. a');
  assert.equal((await call('GET', `/projects/${other}/artifacts`)).body.length, 0, 'one project\'s plan is not another\'s');

  // A hand-made artifact with the same text never collides with a captured one.
  assert.equal((await call('POST', `/projects/${slug}/artifacts`, { title: 'Ship it', body: '# Ship it\n\n1. a' })).status, 201);

  assert.equal((await call('GET', base)).status, 404, 'the old list is gone');
  assert.equal((await call('DELETE', `${base}/${one.body.id}`)).status, 404, 'the old delete is gone');
});
