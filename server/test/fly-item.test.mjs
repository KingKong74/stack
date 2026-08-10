#!/usr/bin/env node
// #381 — FLY: a card a live Claude session opened for its own ad-hoc work.
//
// The three rules this pins are each a thing the feature is worthless without,
// or dangerous with:
//
//  • 'fly' is ACCEPTED and 'hook' is REFUSED on POST /roadmap. Downgrading a
//    'hook' request to 'manual' silently would be worse than refusing it: that
//    source carries the extractor's dedup index and the dismissed_items
//    tombstone contract, so a caller who could claim it could resurrect an item
//    the owner dismissed.
//  • A fly card is HELD from the auto runner until a human signs it off, and it
//    is IN THE INBOX where that signing happens. Held-but-invisible is work
//    with no way ever to be approved.
//  • `fly_session` SURVIVES the claim being released and the card being
//    un-ticked. It is a separate column from `claimed_by` for exactly this
//    reason — provenance that evaporates the first time the board is tidied
//    cannot answer "what did last Tuesday's sessions start".
//
// Needs a running server on an EMPTY database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   API=http://127.0.0.1:4599 TOKEN=testtok node server/test/fly-item.test.mjs

const API = process.env.API || 'http://127.0.0.1:4599';
const TOKEN = process.env.TOKEN || 'testtok';
const SLUG = 'fly-test';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const api = async (path, opts = {}) => {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
};

// A project to hang the cards off. Ingest is the only thing that creates one.
await api('/api/ingest', {
  method: 'POST',
  body: JSON.stringify({
    project: { slug: SLUG, name: 'Fly test' },
    session: { session_id: 'fly-seed', summary: 'seed', authored: true, commit_hash: 'abc1234' },
  }),
});

const post = (body) => api(`/api/projects/${SLUG}/roadmap`, { method: 'POST', body: JSON.stringify(body) });

// ---- the source gate --------------------------------------------------------

{
  const r = await post({ title: 'Plain hand-written card' });
  check('a POST with no source is manual, as it always was', r.body?.source, 'manual');
}

{
  const r = await post({ title: 'Fix the console strip flicker', source: 'fly', session: 'stack-term-a1b2' });
  check('a fly POST is created', r.status, 201);
  check('…and carries the fly source', r.body?.source, 'fly');
  check('…and names the session that opened it', r.body?.flySession, 'stack-term-a1b2');
  check('…and is NOT signed off on arrival', r.body?.reviewed, false);
}

{
  const r = await post({ title: 'Smuggled extraction', source: 'hook' });
  check('a POST claiming source=hook is REFUSED, not downgraded', r.status, 400);
  check('…and the refusal names the two it will take', /manual.+fly/.test(String(r.body?.error)), true);
}

{
  const r = await post({ title: 'Nonsense source', source: 'wharrgarbl' });
  check('an unrecognised source is refused too', r.status, 400);
}

{
  const r = await post({ title: 'Session that did not name itself', source: 'fly' });
  check('a fly card with no session is still created — the work is not lost', r.status, 201);
  check('…with an empty session rather than a fabricated one', r.body?.flySession, '');
}

{
  const r = await post({ title: 'Bad session name', source: 'fly', session: 'not a session name' });
  check('a session name that could not be a tmux one is dropped, not stored', r.body?.flySession, '');
}

// ---- the same-session guard -------------------------------------------------

{
  const a = await post({ title: 'Repeated after a compaction', source: 'fly', session: 'stack-term-dupe' });
  const b = await post({ title: 'Repeated after a compaction', source: 'fly', session: 'stack-term-dupe' });
  check('a session posting the same card twice gets the FIRST one back', b.body?.id, a.body?.id);
  check('…with 200, not 201 — nothing new was created', b.status, 200);

  const c = await post({ title: 'Repeated after a compaction', source: 'fly', session: 'stack-term-other' });
  check('a DIFFERENT session working the same thing is a real state, and gets its own card',
    c.body?.id !== a.body?.id, true);
  check('…created, not deduped', c.status, 201);

  const d = await post({ title: 'Repeated after a compaction' });
  check('and a HUMAN writing the same title by hand is never deduped',
    d.status === 201 && d.body?.id !== a.body?.id, true);
}

// ---- held from the runner, and visible where it is signed off ---------------

const held = (await post({ title: 'Work a session commissioned', source: 'fly', session: 'stack-term-held' })).body;

// Run now is the gate that must refuse OUT LOUD — a silent drop under a button
// looks like the press did nothing.
const runNow = () => api('/api/autopilot/start', {
  method: 'POST', body: JSON.stringify({ slug: SLUG, itemId: held.id }),
});

{
  const r = await runNow();
  check('Run now REFUSES a fly card that has not been signed off', r.status, 409);
  check('…and says it was a SESSION that opened it, not that it was auto-found',
    /live session/.test(JSON.stringify(r.body)), true);
}

{
  const r = await api('/api/overview');
  const items = r.body?.review?.items || [];
  check('an unsigned fly card is IN the review inbox — held and invisible is unapprovable',
    items.some((i) => i.kind === 'roadmap' && String(i.id) === String(held.id)), true);
}

{
  await api(`/api/projects/${SLUG}/roadmap/${held.id}`, {
    method: 'PATCH', body: JSON.stringify({ reviewed: true }),
  });
  const r = await runNow();
  check('once signed off, the same card is no longer refused on approval grounds',
    r.status === 409 && /live session/.test(JSON.stringify(r.body)), false);

  const ov = await api('/api/overview');
  const items = ov.body?.review?.items || [];
  check('…and it leaves the inbox, so the queue empties as it is worked',
    items.some((i) => i.kind === 'roadmap' && String(i.id) === String(held.id)), false);
}

// ---- provenance outlives the claim ------------------------------------------

{
  const id = held.id;
  const patch = (body) => api(`/api/projects/${SLUG}/roadmap/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  const read = async () => {
    const r = await api(`/api/projects/${SLUG}/roadmap`);
    const all = ['must', 'should', 'could', 'wont'].flatMap((b) => r.body?.[b] || []);
    return all.find((it) => it.id === id);
  };

  await patch({ claimed_by: 'term:stack-term-held' });
  check('the card can be claimed by its session', (await read())?.claimedBy, 'term:stack-term-held');

  await patch({ claimed_by: '' });
  const released = await read();
  check('releasing the claim clears claimed_by…', released?.claimedBy, '');
  check('…and fly_session SURVIVES it — this is why it is its own column',
    released?.flySession, 'stack-term-held');

  await patch({ done: true });
  await patch({ done: false });
  const untick = await read();
  check('un-ticking clears the claim (as it always did)…', untick?.claimedBy, '');
  check('…and fly_session survives that too', untick?.flySession, 'stack-term-held');
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
