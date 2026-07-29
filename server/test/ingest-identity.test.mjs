#!/usr/bin/env node
// Ingest identity — one activity row per SESSION, not per commit hash.
//
// The bug this pins: parallel sessions in one checkout all end at the same
// `git rev-parse HEAD`, so when ingest matched the commit BEFORE the session id
// three sessions ending together collapsed into a single row and two real
// pushes disappeared from the overview. The two properties that have to hold
// together are easy to break in either direction:
//
//   • different sessions, same commit  → three rows (nothing is lost)
//   • same session, posted twice       → one row  (nothing is duplicated)
//   • an authored /checkpoint posts no session_id, and the SessionEnd backstop
//     that follows it must claim THAT row rather than open a second one — but
//     only while it is unclaimed, or the next session at the same HEAD claims
//     it right back.
//
// Needs a running server on an EMPTY database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   node server/test/ingest-identity.test.mjs
//
// Override with STACK_TEST_API / STACK_TEST_TOKEN.

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = 'ingest-identity-test';

let failed = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (got ${got}, want ${want})`}`);
}

async function post(session) {
  const r = await fetch(`${API}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ project: { slug: SLUG, name: 'Ingest identity test' }, session }),
  });
  if (!r.ok) throw new Error(`ingest ${r.status}: ${await r.text()}`);
}

async function rowsFor(commit) {
  const r = await fetch(`${API}/api/projects/${SLUG}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`detail ${r.status}`);
  const d = await r.json();
  return (d.activity || []).filter((a) => a.hash === commit);
}

(async () => {
  // 1. Three sessions, one shared HEAD — the reaper ending a checkout's worth
  //    of sessions at once is exactly this shape.
  for (const sid of ['sess-a', 'sess-b', 'sess-c']) {
    await post({ session_id: sid, commit_hash: 'aaa1111', branch: 'main', summary: `from ${sid}`, message_count: 5 });
  }
  check('three sessions at one commit keep three rows', (await rowsFor('aaa1111')).length, 3);

  // 2. The same session posting twice still updates its own row.
  await post({ session_id: 'sess-a', commit_hash: 'aaa1111', branch: 'main', summary: 'from sess-a again', message_count: 9 });
  check('a session re-posting does not duplicate', (await rowsFor('aaa1111')).length, 3);

  // 3. An authored checkpoint (no session_id) then the backstop for that session.
  await post({ commit_hash: 'bbb2222', branch: 'main', authored: true, summary: 'the authored account', message_count: 12 });
  await post({ session_id: 'sess-d', commit_hash: 'bbb2222', branch: 'main', summary: 'thin metadata', message_count: 12 });
  const claimed = await rowsFor('bbb2222');
  check('the backstop claims its own checkpoint row', claimed.length, 1);
  check('and never clobbers the authored summary', claimed[0]?.summary, 'the authored account');

  // 4. A second session ending at that same HEAD gets its own row — the claimed
  //    checkpoint above is not up for grabs a second time.
  await post({ session_id: 'sess-e', commit_hash: 'bbb2222', branch: 'main', summary: 'a different session', message_count: 4 });
  check('the next session at that HEAD opens its own row', (await rowsFor('bbb2222')).length, 2);

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
