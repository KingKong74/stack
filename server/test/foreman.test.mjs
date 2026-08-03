#!/usr/bin/env node
// The FOREMAN is the Review room's agent, and the room is its only surface
// (#375).
//
// What this pins, in the order it matters:
//
//   • A BUILT CHANGE IS READABLE. Every op here used to open with
//     `if (!item.done) 400`, which was correct only while the queue held ticked
//     work exclusively. After #374 the room's whole subject is a change still
//     on its branch, so ✧ Brief and ✦ Draft answered "Only completed items get
//     a review brief" on precisely the changes the room was showing. The
//     predicate is now the queue's own: built OR ticked.
//   • IN PROGRESS IS STILL NOT READABLE. A claim with nothing built behind it
//     is a session starting, not a change — the same half of the #374
//     predicate, applied on the way in rather than on the way out.
//   • ONE ROOM, ONE SWITCH. `reviewbrief` and `refinedraft` were the Curator's
//     and lived on the roadmap routes; switching the Foreman off has to stop
//     them too, or the room cannot be switched off at all.
//   • THE ROOM SAYS WHETHER ITS AGENT CAN ACT. The payload carries `agents`
//     (it carried `geminiReady`, which stopped meaning anything when the ops
//     moved onto Claude on the host), and every ✧ is absent-with-a-reason
//     rather than a button that 409s.
//   • A `where` PATH IS SAME-ORIGIN OR IT IS DROPPED. It is the one field of an
//     agent answer that becomes something the owner clicks, so it is checked
//     as a pure function, here, rather than trusted.
//
// The model itself is never called: with no host daemon on the line the gate
// refuses with 503, and that refusal IS the assertion — it proves the request
// got past the predicate and the switch to the point where only the backend
// was missing. Which is why this needs no daemon and no key.
//
// Needs a running server on an EMPTY database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t node server/test/foreman.test.mjs
//
// Override the API with STACK_TEST_API / STACK_TEST_TOKEN.

import { cleanPath } from '../src/routes/review.js';

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = 'foreman-test';

let failed = 0;
function check(name, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

// Every op call here is expected to be REFUSED — by the predicate, the switch
// or the missing daemon — so the helper returns the status and the message
// instead of throwing on them.
const call = async (path, opts = {}) => {
  const r = await fetch(`${API}/api${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(opts.noAuth ? {} : { authorization: `Bearer ${TOKEN}` }),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* a non-JSON body is itself the answer */ }
  return { status: r.status, json, text };
};
const ok = async (path, opts) => {
  const r = await call(path, opts);
  if (r.status >= 400) throw new Error(`${opts?.method || 'GET'} ${path} → ${r.status}: ${r.text}`);
  return r.json;
};

console.log('--- a where[] path is same-origin, or it is dropped ---');
check('a hash route passes', cleanPath('/#/control/review'), '/#/control/review');
check('a plain path passes', cleanPath('/p/stack/roadmap?hl=12'), '/p/stack/roadmap?hl=12');
// The one that matters: `//evil.example` is a protocol-relative URL, so a
// "starts with a slash" check alone sends the owner off the mirror entirely.
check('a protocol-relative host is rejected', cleanPath('//evil.example/steal'), '');
check('an absolute URL is rejected', cleanPath('https://evil.example'), '');
check('a relative path is rejected', cleanPath('control/review'), '');
check('a backslash is rejected', cleanPath('/\\evil.example'), '');
check('whitespace is rejected', cleanPath('/#/control review'), '');
check('a javascript: payload is rejected', cleanPath('javascript:alert(1)'), '');
check('an over-long path is rejected', cleanPath(`/${'a'.repeat(300)}`), '');
check('an empty path is rejected', cleanPath(''), '');
check('a null is rejected', cleanPath(null), '');

const ids = {};

(async () => {
  await ok('/ingest', {
    method: 'POST',
    body: {
      project: { slug: SLUG, name: 'Foreman test' },
      session: { session_id: 'fm-1', commit_hash: 'fm00001', branch: 'main', summary: 'seed', message_count: 1 },
    },
  });
  await seed();

  console.log('\n--- the room reports its agent ---');
  const room = await ok('/review');
  check('the payload carries the agent state', typeof room.agents?.foreman?.enabled, 'boolean');
  check('...naming the room it is bound to', room.agents?.foreman?.tab, 'review');
  check('...and whether the backend is there at all', typeof room.agents?.foreman?.ready, 'boolean');
  check('both moved ops are offered from here',
    ['reviewbrief', 'refinedraft'].every((op) => room.agents?.foreman?.ops?.includes(op)), true);
  // It carried `geminiReady` until the ops moved onto Claude on the host. A key
  // now says nothing about whether this room works, so the field is gone rather
  // than left behind meaning something else.
  check('the stale Gemini flag is gone', 'geminiReady' in room, false);

  console.log('\n--- a change is readable from the moment it is BUILT (#374) ---');
  // The refusal is the daemon's, not the predicate's: 503 means the request got
  // all the way to "no backend", so the built change WAS accepted as readable.
  for (const [op, path] of [['read', 'read'], ['brief', 'brief'], ['draft', 'refine-draft']]) {
    const r = await call(`/review/${SLUG}/${ids.built}/${path}`, { method: 'POST' });
    check(`✧ ${op} on a built, unticked change gets past the predicate`, r.status, 503);
    check(`...and refuses on the HOST, not on the item`, /host daemon/.test(r.json?.error || ''), true);
  }
  const ticked = await call(`/review/${SLUG}/${ids.ticked}/read`, { method: 'POST' });
  check('a ticked change is readable too', ticked.status, 503);

  console.log('\n--- but a claim with nothing built is not a change ---');
  const inprog = await call(`/review/${SLUG}/${ids.claimed}/read`, { method: 'POST' });
  check('an in-progress claim is refused', inprog.status, 400);
  check('...and says why in the room\'s own terms',
    /not waiting on a verdict/.test(inprog.json?.error || ''), true);

  console.log('\n--- the ops are the Foreman\'s, and they moved ---');
  // The old per-project routes are gone. A stale client hitting them gets a
  // 404 rather than a working button on the Curator's switch.
  const oldBrief = await call(`/projects/${SLUG}/roadmap/${ids.ticked}/review-brief`, { method: 'POST' });
  check('the Curator no longer serves the brief', oldBrief.status, 404);
  const oldDraft = await call(`/projects/${SLUG}/roadmap/${ids.ticked}/refine-draft`, { method: 'POST' });
  check('...nor the refine draft', oldDraft.status, 404);

  console.log('\n--- one room, one switch ---');
  await ok('/agents/foreman', { method: 'PATCH', body: { enabled: false } });
  try {
    for (const [op, path] of [['read', 'read'], ['brief', 'brief'], ['draft', 'refine-draft']]) {
      const r = await call(`/review/${SLUG}/${ids.built}/${path}`, { method: 'POST' });
      check(`switched off stops ✧ ${op}`, r.status, 409);
      check(`...and the refusal names the Foreman`, /Foreman/.test(r.json?.error || ''), true);
    }
    const t = await call('/review/triage', { method: 'POST' });
    check('...and the queue triage with them', t.status, 409);
    const off = await ok('/review');
    check('the room reports itself off before drawing any ✧', off.agents?.foreman?.enabled, false);
  } finally {
    // Leave the switch as it was found — a test that turns an agent off and
    // dies leaves the room dead for whoever runs the next one.
    await ok('/agents/foreman', { method: 'PATCH', body: { enabled: true } });
  }

  console.log('\n--- the edges ---');
  const noProject = await call(`/review/no-such-project/1/read`, { method: 'POST' });
  check('an unknown project 404s', noProject.status, 404);
  const noItem = await call(`/review/${SLUG}/999999/read`, { method: 'POST' });
  check('an unknown item 404s', noItem.status, 404);
  const noAuth = await call(`/review/${SLUG}/${ids.built}/read`, { method: 'POST', noAuth: true });
  check('the auth gate is closed on the ops', noAuth.status, 401);

  console.log(failed ? `\n${failed} check(s) failed.` : '\nall checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// The three states a change can be in on the way into this room, written
// directly: built_note + claimed_by with done still false is exactly what an
// overnight run leaves behind, and no API route sets it in one go.
async function seed() {
  if (!process.env.DATABASE_URL) {
    throw new Error('This test writes roadmap rows directly — run it with the same DATABASE_URL as the server.');
  }
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { rows: p } = await db.query('SELECT id FROM projects WHERE slug = $1', [SLUG]);
    const pid = p[0].id;
    await db.query('DELETE FROM roadmap_items WHERE project_id = $1', [pid]);
    const item = async (title, fp, built, claim, done) => {
      const { rows } = await db.query(
        `INSERT INTO roadmap_items (project_id, bucket, title, fingerprint, built_note, claimed_by, done)
         VALUES ($1,'must',$2,$3,$4,$5,$6) RETURNING id`, [pid, title, fp, built, claim, done]);
      return rows[0].id;
    };
    ids.built = await item('built on a branch', 'fm-a', '[feat/1-a] three commits', 'feat/1-a', false);
    ids.ticked = await item('ticked and closed out', 'fm-b', 'landed', null, true);
    ids.claimed = await item('claimed, nothing built', 'fm-c', null, 'feat/3-c', false);
  } finally {
    await db.end();
  }
}
