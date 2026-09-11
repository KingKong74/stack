#!/usr/bin/env node
// #498 — THE TESTS A SESSION SUGGESTS, from the wire to the Auto-ideas pane.
//
// Needs a running server on an EMPTY database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   node server/test/suggested-tests.test.mjs
//
// WHAT IS ACTUALLY UNDER TEST. `extract.next_steps` is switched off in the
// /checkpoint command, and the reason is written there: every follow-up a
// session named became a held roadmap row, held rows were drawn on the BOARD,
// and the board filled with work nobody had chosen. `extract.tests` is the same
// door opened a crack — so the assertions that matter most are the ones that
// keep it a crack:
//
//   • A SUGGESTION IS NEVER BOARD WORK. It lands `source='hook'` and unreviewed,
//     which is what the approval gate (#359) holds and what `homeOf` files into
//     For you → Auto-ideas. If a suggestion could reach the board unanswered,
//     this feature is `next_steps` again under a new name.
//   • IT IS CAPPED, AND THE CAP IS LOW. Six. A session that sends twenty is
//     padding and padding is what shut the door last time.
//   • IT IS DROPPED RATHER THAN GUESSED AT. No kind, an unknown kind, no title
//     — none of those become a row with a default.
//   • IT DOES NOT NAG. A bug a check already covers produces nothing, because
//     the one thing that would get this switched off again is it asking for
//     work already done.
//
// Everything else — fingerprint dedup, tombstones, the never-touch-manual rule
// — is the extractor's existing machinery, and it is asserted here only where a
// test suggestion could have slipped outside it.
//
// VALIDATED BY MUTATION. Four regressions were introduced into ingest.js on
// purpose and this file run against each:
//
//   an unknown kind defaults to 'function'   → 3 fails
//   the six-suggestion cap is lifted         → 2 fails
//   the already-covered skip is removed      → 2 fails
//   a suggestion lands as 'manual'           → 5 fails  (the door, wide open)
import assert from 'node:assert/strict';

const API = process.env.STACK_TEST_API || process.env.STACK_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || process.env.API_TOKEN || 'testtok';
const SLUG = 'suggested-tests-test';

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

let seq = 0;
/** One checkpoint carrying `tests`. A fresh session id each time, so nothing
 *  is deduped by the session's own identity rather than by the suggestions. */
const push = (tests, extra = {}) => api('/api/ingest', {
  method: 'POST',
  body: JSON.stringify({
    project: { slug: SLUG, name: 'Suggested tests' },
    session: { session_id: `st-${++seq}`, summary: 'seed', authored: true, commit_hash: `c${seq}0000` },
    extract: { tests, ...extra },
  }),
});

const rows = async () => {
  const { body } = await api(`/api/projects/${SLUG}/roadmap`);
  const flat = Object.values(body || {}).flat().filter(Boolean);
  return flat.filter((r) => r && typeof r === 'object' && 'title' in r);
};
const byTitle = async (t) => (await rows()).find((r) => r.title === t) || null;

// ---- it lands, held, with what it is about ---------------------------------

{
  const { body } = await push([
    { title: 'A red check keeps its bug link across a re-run', kind: 'bug', target: 'BUG-31' },
    { title: 'The health route answers before the database is up', kind: 'function', target: 'GET /api/health' },
  ]);
  check('the response says how many were filed', body?.tests, { created: 2 });

  const b = await byTitle('A red check keeps its bug link across a re-run');
  const f = await byTitle('The health route answers before the database is up');

  check('a bug-kind suggestion carries its kind and its key',
    [b?.testKind, b?.testTarget], ['bug', 'BUG-31']);
  check('a function-kind suggestion carries the route it names',
    [f?.testKind, f?.testTarget], ['function', 'GET /api/health']);

  // THE ONE THAT KEEPS THE DOOR A CRACK. Unreviewed + 'hook' is what the
  // approval gate holds and what puts the row in Auto-ideas rather than on the
  // board. A suggestion that arrived reviewed would be tonight's work.
  check('it is a HOOK row and NOBODY has signed it off',
    [b?.source, b?.reviewed, f?.source, f?.reviewed], ['hook', false, 'hook', false]);
  check('and it is not done, not claimed and not built',
    [b?.done, b?.claimedBy, b?.builtNote], [false, '', '']);
}

// ---- an ordinary row is untouched by any of this ---------------------------

{
  await push([], { bugs: [{ title: 'An ordinary extracted bug', severity: 'low' }] });
  const { body } = await api(`/api/projects/${SLUG}/bugs`);
  check('the bug extractor still works beside it', body.some((b) => b.title === 'An ordinary extracted bug'), true);

  const { body: made } = await api(`/api/projects/${SLUG}/roadmap`, {
    method: 'POST',
    body: JSON.stringify({ title: 'A row a human typed' }),
  });
  check('a hand-written row is not a test suggestion',
    [made.testKind, made.testTarget, made.source], ['', '', 'manual']);
}

// ---- dropped rather than guessed at ----------------------------------------

{
  const before = (await rows()).length;
  const { body } = await push([
    { title: 'No kind at all' },
    { title: 'A kind nobody has taught it', kind: 'smoke' },
    { title: 'An empty kind', kind: '' },
    { kind: 'bug', target: 'BUG-1' },            // no title
    { title: '   ', kind: 'function' },          // a title of nothing
  ]);
  check('none of the five malformed entries filed anything', body?.tests, { created: 0 });
  check('and the board did not grow', (await rows()).length, before);
  check('an unknown kind is not silently turned into a bug',
    await byTitle('A kind nobody has taught it'), null);
}

// ---- capped at six ---------------------------------------------------------

{
  const many = Array.from({ length: 20 }, (_, i) => ({
    title: `Capped suggestion number ${i}`, kind: 'function', target: `fn${i}`,
  }));
  const { body } = await push(many);
  check('twenty suggestions file six', body?.tests, { created: 6 });
  check('and it is the FIRST six, not a random six',
    await byTitle('Capped suggestion number 5') !== null
    && await byTitle('Capped suggestion number 6') === null, true);
}

// ---- it does not nag -------------------------------------------------------

{
  // A bug with a check linked to it — #278's own data change, and the record
  // that this particular gap is already closed.
  const { body: chk } = await api(`/api/projects/${SLUG}/checks`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Covers BUG-COVERED', url: 'http://127.0.0.1:1/none' }),
  });
  const { body: bug } = await api(`/api/projects/${SLUG}/bugs`, {
    method: 'POST',
    body: JSON.stringify({ title: 'A defect that already has a check', severity: 'high', check_id: chk.id }),
  });
  check('the bug wears the check that covers it', bug.checkId, chk.id);

  const { body } = await push([
    { title: 'Write the check that would have caught the covered one', kind: 'bug', target: bug.id },
    { title: 'Write the check for one nothing covers', kind: 'bug', target: 'BUG-9999' },
  ]);
  check('a suggestion for a bug a check ALREADY covers is dropped', body?.tests, { created: 1 });
  check('…and it is the covered one that was dropped',
    await byTitle('Write the check that would have caught the covered one'), null);
  check('…while the uncovered one lands',
    (await byTitle('Write the check for one nothing covers'))?.testTarget, 'BUG-9999');
}

{
  // The match is on a real key, not on free text that happens to contain one.
  const { body } = await push([
    { title: 'A target that is prose, not a key', kind: 'bug', target: 'something about BUG-1 maybe' },
  ]);
  check('a free-text target is never matched loosely against a bug key', body?.tests, { created: 1 });
}

// ---- the extractor's existing machinery still applies ----------------------

{
  const title = 'A suggestion sent twice in one push';
  const { body } = await push([
    { title, kind: 'function', target: 'a' },
    { title, kind: 'function', target: 'b' },
  ]);
  check('the same title twice in ONE push files once', body?.tests, { created: 1 });

  const { body: again } = await push([{ title, kind: 'bug', target: 'BUG-77' }]);
  check('and re-sending it on the next push files nothing new', again?.tests, { created: 0 });
  const row = await byTitle(title);
  check('but it RE-STATES what it is about — a session that has since filed the bug can say so',
    [row?.testKind, row?.testTarget], ['bug', 'BUG-77']);
}

{
  const title = 'A suggestion the owner dismissed';
  await push([{ title, kind: 'function', target: 'x' }]);
  const row = await byTitle(title);
  check('it exists before the dismissal', !!row, true);
  await api(`/api/projects/${SLUG}/roadmap/${row.id}`, { method: 'DELETE' });

  const { body } = await push([{ title, kind: 'function', target: 'x' }]);
  check('DISMISS TOMBSTONES IT — the next push cannot bring it back', body?.tests, { created: 0 });
  check('and it is really gone', await byTitle(title), null);
}

// ---- absent is absent ------------------------------------------------------

{
  const { body } = await api('/api/ingest', {
    method: 'POST',
    body: JSON.stringify({
      project: { slug: SLUG },
      session: { session_id: 'st-none', summary: 's', authored: true, commit_hash: 'dead000' },
    }),
  });
  check('a checkpoint with no extract at all files nothing and does not fail',
    [body?.ok, body?.tests], [true, { created: 0 }]);

  for (const junk of [null, 'nope', 42, {}]) {
    const { body: b } = await push(junk);
    check(`tests: ${JSON.stringify(junk)} is ignored, not fatal`, [b?.ok, b?.tests], [true, { created: 0 }]);
  }
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
