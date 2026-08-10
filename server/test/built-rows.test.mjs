#!/usr/bin/env node
// #174 — `extract.built`: the checkpoint files the board row for what a session
// just built, instead of somebody having to remember to make one.
//
// The rules with teeth, each here because getting it wrong loses something:
//
//  • IT NEVER TICKS. A row lands as BUILT — a `built_note` plus a claim, which
//    is #374's Review-queue predicate — and never as `done`. A session
//    declaring its own work finished is exactly the judgement the Review room
//    exists to make, and ticking belongs to the merge job with a human verdict
//    stored beside it.
//  • AN EXISTING ROW IS FOUND, NOT DUPLICATED. By id, and failing that by
//    fingerprint against ANY source — including the fly card (#381) the same
//    session very likely opened when it started. One row for the whole life of
//    a piece of work, not two describing its ends.
//  • A WRONG ID IS REPORTED, NEVER COERCED. An id on another project (or long
//    deleted) is counted in `missed` and nothing is written. Silently creating
//    a row because a number was wrong is how a board fills with near-duplicates
//    of work already on it — and #174 exists BECAUSE twenty-two citations
//    pointed at another item's number with nothing to catch it.
//  • AN EXISTING CLAIM IS NEVER STOLEN, and a dismissed fingerprint never
//    returns as a by-product of a checkpoint.
//
// Needs a running server on an EMPTY database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   API=http://127.0.0.1:4599 TOKEN=testtok node server/test/built-rows.test.mjs

const API = process.env.API || 'http://127.0.0.1:4599';
const TOKEN = process.env.TOKEN || 'testtok';
const SLUG = 'built-test';

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
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
};

// One checkpoint. `n` keeps the session id unique so each call is its own row
// rather than an idempotent re-post of the last one.
let n = 0;
const checkpoint = (built, extra = {}) => api('/api/ingest', {
  method: 'POST',
  body: JSON.stringify({
    project: { slug: SLUG, name: 'Built test' },
    session: {
      session_id: `built-${++n}`, authored: true, summary: 'a session',
      commit_hash: `c${String(n).padStart(6, '0')}`, branch: 'feat/9-thing', ...extra,
    },
    extract: { built },
  }),
});

const roadmap = async () => {
  const r = await api(`/api/projects/${SLUG}/roadmap`);
  return ['must', 'should', 'could', 'wont'].flatMap((b) => r.body?.[b] || []);
};
const byId = async (id) => (await roadmap()).find((it) => it.id === id);

await checkpoint([]);   // seeds the project

// ---- the precise form: an id ------------------------------------------------

const made = (await api(`/api/projects/${SLUG}/roadmap`, {
  method: 'POST', body: JSON.stringify({ title: 'A planned piece of work', bucket: 'must' }),
})).body;

{
  const r = await checkpoint([{ item: made.id, note: 'Landed as X. Lives in y.js. Verified by the suite.' }]);
  check('a built entry with an id links, creating nothing',
    r.body?.built, { linked: 1, created: 0, missed: 0 });

  const row = await byId(made.id);
  check('…and the note becomes the row\'s built_note',
    row?.builtNote, 'Landed as X. Lives in y.js. Verified by the suite.');
  check('…and the row is claimed, which is what makes it QUEUE in the Review room',
    row?.claimedBy, 'feat/9-thing');
  check('…and it is NOT ticked — the verdict is the human\'s', row?.done, false);
}

{
  const r = await checkpoint([{ item: made.id, note: 'A second, fuller account after more work.' }]);
  check('checkpointing the same row again UPDATES the note rather than duplicating',
    r.body?.built, { linked: 1, created: 0, missed: 0 });
  check('…to the latest account', (await byId(made.id))?.builtNote,
    'A second, fuller account after more work.');
  check('…and the row count has not moved', (await roadmap()).length, 1);
}

// ---- a wrong id is reported, never coerced ----------------------------------

{
  const before = (await roadmap()).length;
  const r = await checkpoint([{ item: 999999, note: 'An account with nowhere to go.' }]);
  check('an id that is not on this board is MISSED, not turned into a new row',
    r.body?.built, { linked: 0, created: 0, missed: 1 });
  check('…and nothing was written', (await roadmap()).length, before);
}

// ---- a number is not a name, and this repo's numbers collide ----------------
//
// Roadmap items and futures are separate id sequences and both are cited as
// "#N" throughout the repo, the SessionStart block and the idea funnel. A
// session that means future #174 and sends `item: 174` lands on an unrelated
// roadmap row. That is not hypothetical — it happened while this feature was
// being filed, and it overwrote the built_note of an archived, human-verdicted
// item, which could not be recovered.

{
  const r = await checkpoint([{
    item: made.id, title: 'A title that is not that row at all',
    note: 'An account that must not land.',
  }]);
  check('an id whose TITLE disagrees is refused, not obeyed',
    r.body?.built, { linked: 0, created: 0, missed: 1 });
  check('…and the row it pointed at is untouched', (await byId(made.id))?.builtNote,
    'A second, fuller account after more work.');
}

{
  const r = await checkpoint([{
    item: made.id, title: 'A planned piece of work', note: 'The matching title lands.',
  }]);
  check('an id whose title MATCHES still links, as the checkpoint command asks for',
    r.body?.built, { linked: 1, created: 0, missed: 0 });
  check('…and writes', (await byId(made.id))?.builtNote, 'The matching title lands.');
}

{
  const arch = (await api(`/api/projects/${SLUG}/roadmap`, {
    method: 'POST', body: JSON.stringify({ title: 'Finished long ago', bucket: 'should' }),
  })).body;
  await api(`/api/projects/${SLUG}/roadmap/${arch.id}`, {
    method: 'PATCH', body: JSON.stringify({ done: true, built_note: 'The real account of it.', archived: true }),
  });

  const r = await checkpoint([{ item: arch.id, note: 'A checkpoint rewriting history.' }]);
  check('an ARCHIVED row is refused — a checkpoint may not rewrite finished history',
    r.body?.built, { linked: 0, created: 0, missed: 1 });
  const row = await byId(arch.id);
  check('…and its account survives', row?.builtNote, 'The real account of it.');
}

// ---- the fallback: a title ---------------------------------------------------

{
  const r = await checkpoint([{
    title: 'The thing that shipped with no row', note: 'What landed, and how it was checked.',
    bucket: 'must', area: 'Terminal',
  }]);
  check('a built entry with no matching row FILES one', r.body?.built,
    { linked: 0, created: 1, missed: 0 });

  const row = (await roadmap()).find((it) => it.title === 'The thing that shipped with no row');
  check('…marked as a session\'s own row (#381), not as a hook extraction', row?.source, 'fly');
  check('…carrying the account', row?.builtNote, 'What landed, and how it was checked.');
  check('…claimed, so it reaches the Review room', row?.claimedBy, 'feat/9-thing');
  check('…NOT ticked', row?.done, false);
  check('…in the bucket it was given', row?.bucket, 'must');
  check('…with the area lowercased like every other write', row?.area, 'terminal');
}

{
  const before = (await roadmap()).length;
  const r = await checkpoint([{ title: 'The thing that shipped with no row', note: 'Said again next session.' }]);
  check('the same title next session LINKS to that row instead of filing a second',
    r.body?.built, { linked: 1, created: 0, missed: 0 });
  check('…and the board did not grow', (await roadmap()).length, before);
}

// ---- one row for the whole life of a piece of work ---------------------------
//
// The case that makes #381 and #174 one feature: a session opens a FLY card
// when it starts, and its checkpoint attaches the account to THAT card.

{
  const fly = (await api(`/api/projects/${SLUG}/roadmap`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Work opened at the start', source: 'fly', session: 'stack-term-abcd' }),
  })).body;
  check('the fly card starts with no built_note', fly.builtNote, '');

  const r = await checkpoint([{ title: 'Work opened at the start', note: 'And this is what it became.' }]);
  check('the checkpoint lands on the SAME card, not a second one',
    r.body?.built, { linked: 1, created: 0, missed: 0 });

  const row = await byId(fly.id);
  check('…the fly card now carries the account', row?.builtNote, 'And this is what it became.');
  check('…and keeps its own session provenance', row?.flySession, 'stack-term-abcd');
}

// ---- an existing claim is a fact about the fleet, not ours to overwrite -------

{
  const claimed = (await api(`/api/projects/${SLUG}/roadmap`, {
    method: 'POST', body: JSON.stringify({ title: 'Held by a lane', claimed_by: 'auto/item-7-x' }),
  })).body;
  await checkpoint([{ item: claimed.id, note: 'An account written from elsewhere.' }]);
  const row = await byId(claimed.id);
  check('a row already claimed by a lane KEEPS that claim', row?.claimedBy, 'auto/item-7-x');
  check('…and still gets the note', row?.builtNote, 'An account written from elsewhere.');
}

// ---- dismissal still means dismissed ----------------------------------------

{
  const r1 = await checkpoint([{ title: 'A row the owner will bin', note: 'first account' }]);
  check('the row is filed', r1.body?.built?.created, 1);
  const row = (await roadmap()).find((it) => it.title === 'A row the owner will bin');
  await api(`/api/projects/${SLUG}/roadmap/${row.id}`, { method: 'DELETE' });

  const r2 = await checkpoint([{ title: 'A row the owner will bin', note: 'second account' }]);
  check('and a later checkpoint does NOT resurrect it — a dismissal is not undone by a by-product',
    r2.body?.built, { linked: 0, created: 0, missed: 0 });
  check('…nothing came back',
    (await roadmap()).some((it) => it.title === 'A row the owner will bin'), false);
}

// ---- the shape of what is accepted -------------------------------------------

{
  const before = (await roadmap()).length;
  const r = await checkpoint([
    { title: 'No note at all' },                       // nothing to say = nothing to write
    { note: 'No id and no title' },                    // nowhere to land
    { item: made.id },                                 // an id with no account
  ]);
  check('an entry with no note, or nowhere to land, is dropped',
    r.body?.built, { linked: 0, created: 0, missed: 0 });
  check('…and no row was filed for any of them', (await roadmap()).length, before);
}

{
  const r = await checkpoint([{ title: 'Claimed by a tmux session', note: 'x' }], { session: 'stack-term-9f9f' });
  check('a checkpoint naming its tmux session claims the row as that session',
    r.body?.built?.created, 1);
  const row = (await roadmap()).find((it) => it.title === 'Claimed by a tmux session');
  check('…using the term: spelling the Terminal screen already uses',
    row?.claimedBy, 'term:stack-term-9f9f');
  check('…and stamps it as that session\'s row', row?.flySession, 'stack-term-9f9f');
}

// ---- the metadata backstop must never file rows -----------------------------
//
// The SessionEnd hook cannot know what was built; it posts bare metadata. It
// has never sent `built` and this is what keeps it that way if it ever grows a
// bug that does.

{
  const before = (await roadmap()).length;
  const r = await api('/api/ingest', {
    method: 'POST',
    body: JSON.stringify({
      project: { slug: SLUG },
      session: { session_id: 'backstop-1', authored: false, commit_hash: 'deadbee' },
      extract: {},
    }),
  });
  check('a metadata backstop with no built block writes no rows',
    r.body?.built, { linked: 0, created: 0, missed: 0 });
  check('…and the board is untouched', (await roadmap()).length, before);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
