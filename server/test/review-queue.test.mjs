#!/usr/bin/env node
// The Review queue holds a change from the moment it is BUILT (#374).
//
// The bug this pins was invisible from the screen, which is what made it
// expensive: the queue was `done = true`, and nothing in Stack ticks. The
// runner pushes the branch and logs "claim stays until you merge + tick it";
// the merge job ends with "tick #N when you've verified it"; the interactive
// sessions leave the item unticked on purpose. So every overnight change sat
// at done = false with a branch, a run and a reviewer's read behind it, and
// the room whose entire job is to show you that read said "Nothing waiting on
// you" — correctly, emptily, every morning.
//
// The five cases below are the whole predicate. Two of them are the ones a
// later session breaks by "tidying" it:
//
//   • SENT BACK MUST NOT COME BACK. Un-ticking clears `claimed_by` and leaves
//     `built_note` on record, so a predicate that tests built_note ALONE
//     re-queues every change you already rejected — and it re-queues them
//     looking exactly like fresh work.
//   • IN PROGRESS IS NOT BUILT. A predicate that tests `claimed_by` alone
//     queues items the moment a session claims a branch, so you are asked to
//     verdict work that does not exist yet.
//
// And one that is quieter but worse: approving a change BEFORE it merges must
// move it to Settled, not out of both lists. `settled` therefore tests the
// verdict and nothing about `done`.
//
// Needs a running server on an EMPTY database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t node server/test/review-queue.test.mjs
//
// DATABASE_URL as well as the API: `built_note` + `claimed_by` + the host's
// branch report is the state an overnight run leaves behind, and the API alone
// cannot stand up a branch report for a project (that route is the host
// dispatcher's write side, which is the point — the server cannot see git).
//
// Override the API with STACK_TEST_API / STACK_TEST_TOKEN.

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = 'review-queue-test';

let failed = 0;
function check(name, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

const call = async (path, opts = {}) => {
  const r = await fetch(`${API}/api${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
};

// Only this project's rows — the queue is cross-project by design, so a shared
// database would otherwise make every count here depend on what else is in it.
const mine = async () => {
  const d = await call('/review');
  return {
    queue: d.queue.filter((it) => it.slug === SLUG),
    settled: d.settled.filter((it) => it.slug === SLUG),
    totals: d.totals,
  };
};
const byTitle = (list, t) => list.find((it) => it.title === t) || null;

(async () => {
  await call('/ingest', {
    method: 'POST',
    body: {
      project: { slug: SLUG, name: 'Review queue test' },
      session: { session_id: 'rq-1', commit_hash: 'rq00001', branch: 'main', summary: 'seed', message_count: 1 },
    },
  });
  await seed();

  const { queue, settled } = await mine();

  // 1. THE WHOLE POINT — built on a branch, never ticked, and it is waiting.
  const built = byTitle(queue, 'built on a branch');
  check('a built, unticked change is in the queue', !!built, true);
  check('and it is flagged as still on its branch', built?.stage, 'built');

  // 2. The stage a ticked change is at is unchanged — this is what the queue
  //    used to hold exclusively, and it must keep holding it.
  const ticked = byTitle(queue, 'ticked, no verdict');
  check('a ticked change is still in the queue', !!ticked, true);
  check('and it is not reported as on a branch', ticked?.stage, 'ticked');
  check('a change on main carries no merge state', ticked?.merge, null);

  // 3. SENT BACK MUST NOT COME BACK. built_note survives an un-tick; the claim
  //    does not. Testing built_note alone re-queues everything you rejected.
  check('a sent-back change stays out of the queue', byTitle(queue, 'sent back to the board'), null);

  // 4. IN PROGRESS IS NOT BUILT. A claim on its own is a session starting, not
  //    a change to read.
  check('a claim with nothing built yet stays out', byTitle(queue, 'claimed, nothing built'), null);

  // 5. Approving before the merge moves it to Settled — it must not fall out
  //    of the queue and the archive both. `settled` tests the VERDICT only.
  check('a change approved before merging is archived', !!byTitle(settled, 'approved, not yet merged'), true);
  check('and the archive still holds the ticked ones', !!byTitle(settled, 'ticked and verdicted'), true);
  check('an approved-but-unmerged change is out of the queue', byTitle(queue, 'approved, not yet merged'), null);

  // 6. The host's probe rides along, because the verdict you are being asked
  //    for is on work that has to land somewhere. `mergeClean` passes through
  //    three-valued: true, false, and NULL for a branch nobody probed.
  check('the probe comes through on the built change', built?.merge?.mergeClean, true);
  check('with the behind count the room reads', built?.merge?.behind, 4);
  const unprobed = byTitle(queue, 'built, branch never probed');
  check('an unprobed branch is not reported as clean', unprobed?.merge?.mergeClean, null);
  // Absence of a report is its OWN answer, not a clean one — same rule as a
  // NULL review_verdict. The client draws `merge: null` neutral and says what
  // it could mean; folding it in with the probed branches is the bug.
  const unreported = byTitle(queue, 'built, no report at all');
  check('a branch no report names comes through null', unreported?.merge, null);
  check('but it is still in the queue', unreported?.stage, 'built');

  // 7. The count the header reads. A subset of `pending`, never of `flagged` —
  //    being unmerged is the normal state of overnight work, not evidence that
  //    anything is wrong with it.
  // Three, not four: 'approved, not yet merged' is built too, but a verdict
  // has already moved it to Settled and it is no longer waiting on anyone.
  check('every unverdicted built change counts as unmerged',
    queue.filter((it) => it.stage === 'built').length, 3);
  check('and none of them is counted as flagged', queue.filter((it) => it.run?.reviewVerdict === 'blocked').length, 0);

  console.log(failed ? `\n${failed} check(s) failed.` : '\nall checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// The state an overnight run leaves behind, written directly: `built_note` +
// `claimed_by` with `done` still false is precisely what the runner produces
// and what no API route sets in one go. The branch report is the host
// dispatcher's write, stood up here the same way.
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
    // Re-runnable: a second run against the same database would otherwise seed
    // a second copy of every case and every count below would silently double.
    await db.query('DELETE FROM roadmap_items WHERE project_id = $1', [pid]);
    const item = (title, fp, built, claim, done, tag) => db.query(
      `INSERT INTO roadmap_items (project_id, bucket, title, fingerprint, built_note, claimed_by, done, review_tag)
       VALUES ($1,'must',$2,$3,$4,$5,$6,$7)`, [pid, title, fp, built, claim, done, tag]);

    await item('built on a branch', 'rq-a', '[feat/1-a] three commits', 'feat/1-a', false, null);
    await item('ticked, no verdict', 'rq-b', 'landed', 'feat/2-b', true, null);
    await item('sent back to the board', 'rq-c', 'what it built last round', null, false, null);
    await item('claimed, nothing built', 'rq-d', null, 'feat/4-d', false, null);
    await item('approved, not yet merged', 'rq-e', 'landed', 'feat/5-e', false, 'solid');
    await item('ticked and verdicted', 'rq-f', 'landed', null, true, 'solid');
    await item('built, branch never probed', 'rq-g', 'landed', 'feat/7-g', false, null);
    await item('built, no report at all', 'rq-h', 'landed', 'feat/8-h', false, null);

    // feat/7-g is IN the report with no probe result (git < 2.38, or a report
    // written before the probe ran); feat/8-h is in no report at all. Those are
    // different absences and the payload keeps them apart.
    await db.query(
      `INSERT INTO branch_reports (project_id, report) VALUES ($1, $2::jsonb)
       ON CONFLICT (project_id) DO UPDATE SET report = EXCLUDED.report`,
      [pid, JSON.stringify([
        { branch: 'feat/1-a', ahead: 3, behind: 4, mergeClean: true, subject: 'built it' },
        { branch: 'feat/5-e', ahead: 1, behind: 0, mergeClean: false, subject: 'conflicts with main' },
        { branch: 'feat/7-g', ahead: 2, behind: 0, mergeClean: null, subject: 'never probed' },
      ])]);
  } finally {
    await db.end();
  }
}
