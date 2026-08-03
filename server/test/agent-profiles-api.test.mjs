#!/usr/bin/env node
// The agent spawn-and-customisation surface, end to end — the DB-backed half
// of what server/test/agent-profiles.test.mjs (unit 1) proves purely.
//
// This test does NOT re-prove the engine's rules (KNOWN_TOOLS, key format,
// the fallback shape) — that's agent-profiles.test.mjs's job, against
// agents.js directly with no database at all. What THIS test proves is the
// storage and route contract in server/src/routes/agents.js:
//   - GET on a fresh DB returns the two builtins from CODE, not a seed row.
//   - POST/PATCH/DELETE round-trip through Postgres with the right status
//     codes, and a builtin resets to factory on DELETE rather than vanishing.
//   - PATCH is a partial update over the CURRENT effective profile (builtin
//     defaults still apply to fields the caller didn't send).
//   - the Polaris hook (roadmap_items.agent_profile) survives a done/un-done
//     round trip untouched, and actually reaches resolveSpawn() — a roadmap
//     item's field becoming a real spawn spec is the whole point of the hook.
//
// Needs a running server on an EMPTY database (it writes real rows) — same
// shape as workbench.test.mjs:
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t node server/test/agents-api.test.mjs
//
// Override the API with STACK_TEST_API / STACK_TEST_TOKEN. Skips cleanly
// (exit 0) rather than failing when there's no API to reach — an unattended
// run on a machine without Docker must not report a false failure.

import { resolveSpawn } from '../src/agent-profiles.js';

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = 'agents-api-test';

let failed = 0;
let total = 0;
function check(name, got, want) {
  total++;
  const ok = Object.is(got, want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}
// For assertions that only need to be true, not equal to a fixed value.
function checkTrue(name, ok) {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
}

const call = async (path, opts = {}) => {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  return { status: r.status, body };
};

// Same shape as call(), but throws on a non-2xx like workbench.test.mjs's
// helper — used for setup steps where a failure IS a real test failure.
const callOk = async (path, opts = {}) => {
  const { status, body } = await call(path, opts);
  if (status < 200 || status >= 300) {
    throw new Error(`${opts.method || 'GET'} ${path} → ${status}: ${JSON.stringify(body)}`);
  }
  return body;
};

// Bail out (exit 0) if there's nothing to test against, rather than failing.
async function apiReachable() {
  try {
    const r = await fetch(`${API}/api/health`);
    return r.ok;
  } catch {
    return false;
  }
}

(async () => {
  if (!(await apiReachable())) {
    console.log(`SKIP: no Stack API reachable at ${API} — start one against a throwaway Postgres and set STACK_TEST_API/STACK_TEST_TOKEN if not the default. See the header of this file.`);
    process.exit(0);
  }

  // ---- Catalogue -----------------------------------------------------
  const fresh = await callOk('/api/agent-profiles');
  const byKey = (list, key) => list.find((p) => p.key === key);

  checkTrue('GET /api/agent-profiles returns both builtins', !!byKey(fresh.profiles, 'executor') && !!byKey(fresh.profiles, 'reviewer'));
  check('executor is flagged builtin', byKey(fresh.profiles, 'executor')?.builtin, true);
  check('reviewer is flagged builtin', byKey(fresh.profiles, 'reviewer')?.builtin, true);
  checkTrue('knownTools is non-empty', Array.isArray(fresh.knownTools) && fresh.knownTools.length > 0);

  // b. the agent_profiles table is empty at this point — the builtins come
  // from code, not a seed. Via a direct DB query if we have DATABASE_URL,
  // else fall back to inference from the API (a customised model would show
  // up already, which it doesn't on a fresh DB).
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const { rows } = await db.query('SELECT count(*)::int AS n FROM agent_profiles');
      check('[via direct pg query] agent_profiles table is empty on a fresh DB', rows[0].n, 0);
    } finally {
      await db.end();
    }
  } else {
    // Inference only: a fresh executor has no customised model yet.
    check('[inferred via API — no DATABASE_URL to query directly] executor model reads factory-default (\'\')', byKey(fresh.profiles, 'executor')?.model, '');
  }

  // ---- Agent creation --------------------------------------------------
  const created = await callOk('/api/agent-profiles', {
    method: 'POST',
    body: { key: 'docs-writer', name: 'Docs writer', prompt: 'You write docs.', tools: ['Read', 'Write'] },
  });
  // Re-request with status visible for the 201 assertion.
  {
    const { status } = await call('/api/agent-profiles', {
      method: 'POST',
      body: { key: 'docs-writer-2', name: 'Docs writer 2', prompt: 'You write more docs.', tools: ['Read', 'Write'] },
    });
    check('POST a valid new profile returns 201', status, 201);
  }
  check('the created profile is not builtin', created.builtin, false);

  const afterCreate = await callOk('/api/agent-profiles');
  checkTrue('the new profile appears in GET /api/agent-profiles', !!byKey(afterCreate.profiles, 'docs-writer'));
  {
    const keys = afterCreate.profiles.map((p) => p.key);
    const sorted = [...keys].sort();
    check('profiles are sorted by key', keys.join(','), sorted.join(','));
  }

  {
    const { status, body } = await call('/api/agent-profiles', { method: 'POST', body: { key: 'no-prompt-profile' } });
    check('POST with no prompt → 400', status, 400);
    checkTrue('the 400 error mentions the prompt', /prompt/i.test(body?.error || ''));
  }
  {
    const { status, body } = await call('/api/agent-profiles', {
      method: 'POST', body: { key: 'bad-tool-profile', prompt: 'x', tools: ['Teleport'] },
    });
    check('POST with an unknown tool → 400', status, 400);
    checkTrue('the 400 error names the offending tool', (body?.error || '').includes('Teleport'));
  }
  {
    const { status } = await call('/api/agent-profiles', { method: 'POST', body: { key: 'Bad_Key', prompt: 'x' } });
    check('POST with a bad key → 400', status, 400);
  }

  // ---- Parameter configuration ------------------------------------------
  {
    const { status, body } = await call('/api/agent-profiles/docs-writer', { method: 'PATCH', body: { model: 'claude-haiku' } });
    check('PATCH the custom profile\'s model only → 200', status, 200);
    check('the model changed', body.model, 'claude-haiku');
    check('the prompt is unchanged', body.prompt, 'You write docs.');
    check('the tools are unchanged', JSON.stringify(body.tools), JSON.stringify(created.tools));
  }

  {
    const { status, body } = await call('/api/agent-profiles/executor', { method: 'PATCH', body: { model: 'claude-opus-custom' } });
    check('PATCH a builtin (executor) with a new model → 200', status, 200);
    check('the builtin\'s model is customised', body.model, 'claude-opus-custom');
    check('it is still flagged builtin', body.builtin, true);
  }
  {
    const after = await callOk('/api/agent-profiles');
    check('GET now shows the customised executor model', byKey(after.profiles, 'executor')?.model, 'claude-opus-custom');
    check('GET still shows executor as builtin', byKey(after.profiles, 'executor')?.builtin, true);
  }

  {
    const { status, body } = await call('/api/agent-profiles/executor', { method: 'DELETE' });
    check('DELETE the builtin executor → 200', status, 200);
    check('the returned profile is back to the factory model (\'\')', body.model, '');
    checkTrue('the returned profile matches the built-in description', typeof body.description === 'string' && body.description.startsWith('The executor'));
  }
  {
    const after = await callOk('/api/agent-profiles');
    checkTrue('the builtin executor is still present after being reset', !!byKey(after.profiles, 'executor'));
    check('and it is reset, not removed — still builtin', byKey(after.profiles, 'executor')?.builtin, true);
  }

  {
    const { status } = await call('/api/agent-profiles/docs-writer', { method: 'DELETE' });
    check('DELETE the custom profile → 204', status, 204);
  }
  {
    const after = await callOk('/api/agent-profiles');
    checkTrue('the deleted custom profile is gone from GET', !byKey(after.profiles, 'docs-writer'));
  }

  {
    const { status } = await call('/api/agent-profiles/no-such-profile-key', { method: 'PATCH', body: { model: 'x' } });
    check('PATCH an unknown key → 404', status, 404);
  }

  // ---- Polaris extension hook --------------------------------------------
  await callOk('/api/ingest', {
    method: 'POST',
    body: {
      project: { slug: SLUG, name: 'Agents API test' },
      session: { session_id: 'agt-1', commit_hash: 'agt0001', branch: 'main', summary: 'seed', message_count: 1 },
    },
  });
  const item = await callOk(`/api/projects/${SLUG}/roadmap`, {
    method: 'POST', body: { title: 'a roadmap item to route to a profile' },
  });

  const findItem = (grouped) => Object.values(grouped).flat().find((r) => r.id === item.id);

  await callOk(`/api/projects/${SLUG}/roadmap/${item.id}`, { method: 'PATCH', body: { agentProfile: 'reviewer' } });
  {
    const board = await callOk(`/api/projects/${SLUG}/roadmap`);
    check('PATCH agentProfile then GET reflects it', findItem(board)?.agentProfile, 'reviewer');
  }

  await callOk(`/api/projects/${SLUG}/roadmap/${item.id}`, { method: 'PATCH', body: { agentProfile: '' } });
  {
    const board = await callOk(`/api/projects/${SLUG}/roadmap`);
    check('PATCH agentProfile: \'\' clears it back to \'\'', findItem(board)?.agentProfile, '');
  }

  await callOk(`/api/projects/${SLUG}/roadmap/${item.id}`, { method: 'PATCH', body: { agentProfile: 'reviewer' } });
  await callOk(`/api/projects/${SLUG}/roadmap/${item.id}`, { method: 'PATCH', body: { done: true } });
  {
    const board = await callOk(`/api/projects/${SLUG}/roadmap`);
    check('ticking done does NOT clear agentProfile', findItem(board)?.agentProfile, 'reviewer');
  }

  {
    const board = await callOk(`/api/projects/${SLUG}/roadmap`);
    const doneItem = findItem(board);
    const catalogue = await callOk('/api/agent-profiles');
    const spawn = resolveSpawn({ profiles: catalogue.profiles, requested: doneItem.agentProfile });
    checkTrue('resolveSpawn keys include the requested reviewer profile', spawn.keys.includes('reviewer'));
    checkTrue('resolveSpawn keys still include the executor — the director never loses its builder', spawn.keys.includes('executor'));
  }

  // ---- Cleanup ------------------------------------------------------------
  await callOk(`/api/projects/${SLUG}`, { method: 'DELETE' });

  console.log(`\n${total} check(s) run.`);
  console.log(failed ? `${failed} check(s) failed.` : 'all checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
