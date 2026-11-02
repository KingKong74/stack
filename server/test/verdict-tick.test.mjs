#!/usr/bin/env node
// Approve AND tick in ONE PATCH (`{ review_tag, done: true }`) — the owner's
// "approve #n and tick it done". Both the verdict path and the tick path set
// `review_shelved = false`; when both ran, Postgres refused the UPDATE
// ("multiple assignments to same column") and the request HUNG until the
// tunnel cut it at ~100s, writing nothing. Each request here carries its own
// timeout, so a hang fails loud rather than stalling the run.
//
// Needs a running server on an EMPTY database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   API=http://127.0.0.1:4599 TOKEN=testtok node server/test/verdict-tick.test.mjs

const API = process.env.API || 'http://127.0.0.1:4599';
const TOKEN = process.env.TOKEN || 'testtok';
const SLUG = 'verdict-tick-test';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const api = async (path, body, method = body ? 'POST' : 'GET') => {
  try {
    const r = await fetch(`${API}${path}`, {
      method, signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  } catch (e) {
    return { status: e.name === 'TimeoutError' ? 'HUNG' : String(e), json: null };
  }
};

await api('/api/projects', { name: 'Verdict tick test', slug: SLUG });
const mk = async (title) => (await api(`/api/projects/${SLUG}/roadmap`, { title, note: '', bucket: 'medium' })).json.id;

{
  const id = await mk('approve and tick in one go');
  await api(`/api/projects/${SLUG}/roadmap/${id}`, { claimed_by: 'main', built_note: 'landed' }, 'PATCH');
  const r = await api(`/api/projects/${SLUG}/roadmap/${id}`, { review_tag: 'solid', done: true }, 'PATCH');
  check('verdict + tick in one PATCH answers', r.status, 200);
  check('it ticks', r.json?.done, true);
  check('it keeps the verdict', r.json?.reviewTag, 'solid');
  check('the verdict is the human\'s', r.json?.verdictSource, 'human');
  check('it leaves the review shelf', r.json?.reviewShelved, false);
}
{
  // An explicit shelf value in the same PATCH still wins over both defaults.
  const id = await mk('approve, tick and shelve');
  const r = await api(`/api/projects/${SLUG}/roadmap/${id}`, { review_tag: 'solid', done: true, review_shelved: true }, 'PATCH');
  check('verdict + tick + explicit shelf answers', r.status, 200);
  check('the explicit shelf wins', r.json?.reviewShelved, true);
}
{
  const id = await mk('tick alone');
  const r = await api(`/api/projects/${SLUG}/roadmap/${id}`, { done: true }, 'PATCH');
  check('a tick alone still answers', r.status, 200);
  check('and ticks', r.json?.done, true);
}

console.log(fails ? `\n${fails} failing` : '\nall passing');
process.exit(fails ? 1 : 0);
