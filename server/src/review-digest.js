// The board's REVIEW ALL digest — what a human needs in front of them to tick a
// column of built changes done in one press, gathered in one read.
//
// THERE IS NO item↔test TABLE, and this does not pretend there is one. What a
// row's tests are is assembled from the three places that actually say:
//
//   • the BUILT NOTE — the completing session writes what landed, and a note
//     that names `server/test/foo.test.mjs` is the most direct claim anything
//     makes about which test pins the item. Extracted by `testRefsOf` below.
//   • the SESSIONS that cite `#<id>` in their summary, and the test files in
//     their `files_touched`. A session that built six items touched the tests
//     of all six, so this half is "tests near the work", said as such.
//   • the RUNS the overnight runner logged against the item (`autopilot_runs`),
//     with `checks_failing` and the reviewer's read. NULL review = NO REVIEW
//     RAN, never clean (CLAUDE.md).
//
// Plus the project's last SUITE run, which is the one number about the app as a
// whole, and the branch report's view of any unmerged branch carrying the item —
// ticking done a change whose branch is still ahead of main is the one mistake
// this screen can make that nothing else catches.
//
// "When was it implemented" has no column either. The earliest session citing
// the item is the best answer; the latest run is the next; `updated_at` is the
// last resort and the client says it is only "last touched".

// A path that LOOKS like a test: a `.test.` / `.spec.` file, anything under a
// test directory, or a smoke script. File-shaped only — the bare word "tests"
// in a note names nothing.
const TEST_PATH = /(?:[\w@.-]+\/)*[\w@.-]*(?:\.test|\.spec|smoke)[\w.-]*\.(?:mjs|cjs|js|jsx|ts|tsx|sh|py)\b|(?:[\w@.-]+\/)*(?:test|tests|__tests__)\/[\w@./-]+\.(?:mjs|cjs|js|jsx|ts|tsx|py)\b/g;

/** Test file paths named in free text, deduped, in order of first mention. Pure. */
export function testRefsOf(text) {
  const out = [];
  for (const m of String(text || '').matchAll(TEST_PATH)) {
    const p = m[0].replace(/^\.\//, '');
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * The test files in a session's `files_touched`, made relative to its `cwd` so
 * the same file named in a built note and touched by a session is ONE entry.
 * Pure.
 */
export function testFilesOf(files, cwd = '') {
  const root = String(cwd || '').replace(/\/+$/, '');
  const out = [];
  for (const f of Array.isArray(files) ? files : []) {
    let path = String(f);
    if (root && path.startsWith(root + '/')) path = path.slice(root.length + 1);
    const refs = testRefsOf(path);
    for (const r of refs) if (!out.includes(r)) out.push(r);
  }
  return out;
}

/**
 * Does this summary cite item `id` — `#509`, not `#5090` or `#50`? Pure; the
 * SQL below is the same rule, and this exists so the rule has a test.
 */
export const citesItem = (summary, id) =>
  new RegExp(`#${Number(id)}(?![0-9])`).test(String(summary || ''));

const iso = (d) => (d ? new Date(d).toISOString() : null);

/**
 * Gather the digest for `ids` in project `projectId`. Four aggregate queries
 * whatever the number of items — never one per row (CLAUDE.md, read layers).
 */
export async function reviewDigest(q, projectId, ids) {
  const want = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
  const items = {};
  for (const id of want) items[id] = { builtAt: null, builtFrom: 'touched', sessions: [], runs: [], testFiles: [], namedInNote: [], unmerged: [] };

  const [rows, sessions, runs, suite, branches] = await Promise.all([
    q(`SELECT id, built_note, updated_at FROM roadmap_items WHERE project_id = $1 AND id = ANY($2::bigint[])`,
      [projectId, want]),
    // `~` with a trailing non-digit (or end) so #50 never matches #509. Most
    // recent first, five per item — enough to say where the work happened.
    q(`SELECT * FROM (
         SELECT ids.id AS item_id, s.created_at, s.commit_hash, s.branch, s.cwd, s.files_touched,
                row_number() OVER (PARTITION BY ids.id ORDER BY s.created_at DESC) AS rn,
                min(s.created_at) OVER (PARTITION BY ids.id) AS first_at
           FROM unnest($2::bigint[]) AS ids(id)
           JOIN sessions s ON s.project_id = $1 AND s.summary ~ ('#' || ids.id || '([^0-9]|$)')
       ) t WHERE rn <= 5 ORDER BY item_id, created_at DESC`, [projectId, want]),
    q(`SELECT item_id, finished_at, outcome, branch, commits, checks_failing, review_verdict, review_note
         FROM autopilot_runs WHERE project_id = $1 AND item_id = ANY($2::bigint[])
        ORDER BY finished_at DESC`, [projectId, want]),
    q(`SELECT total, passed, failed, run_at FROM check_runs WHERE project_id = $1 ORDER BY run_at DESC LIMIT 1`,
      [projectId]),
    q(`SELECT report, reported_at FROM branch_reports WHERE project_id = $1`, [projectId]),
  ]);

  const firstAt = {};
  for (const s of sessions.rows) {
    const it = items[s.item_id];
    if (!it) continue;
    firstAt[s.item_id] = s.first_at;
    it.sessions.push({
      at: iso(s.created_at),
      commit: s.commit_hash || '',
      branch: s.branch || '',
      testFiles: testFilesOf(s.files_touched, s.cwd),
    });
  }
  for (const r of runs.rows) {
    const it = items[r.item_id];
    if (!it || it.runs.length >= 5) continue;
    it.runs.push({
      at: iso(r.finished_at),
      outcome: r.outcome,
      branch: r.branch || '',
      commits: Number(r.commits) || 0,
      // null = the runner did not run the suite, NOT zero failing.
      checksFailing: r.checks_failing === null ? null : Number(r.checks_failing),
      // null = no review ran — never "clean".
      reviewVerdict: r.review_verdict || null,
      reviewNote: r.review_note || '',
    });
  }
  for (const b of (branches.rows[0]?.report || [])) {
    const it = items[b?.itemId];
    if (it && Number(b.ahead) > 0) it.unmerged.push({ branch: String(b.branch || ''), ahead: Number(b.ahead) });
  }
  for (const r of rows.rows) {
    const it = items[r.id];
    if (!it) continue;
    const sessionTests = it.sessions.flatMap((s) => s.testFiles);
    it.testFiles = [...new Set([...testRefsOf(r.built_note), ...sessionTests])];
    it.namedInNote = testRefsOf(r.built_note);
    // Earliest evidence of the build, and WHICH evidence, so the client can say it.
    const run = it.runs[it.runs.length - 1]?.at || null;
    if (firstAt[r.id]) { it.builtAt = iso(firstAt[r.id]); it.builtFrom = 'session'; }
    else if (run) { it.builtAt = run; it.builtFrom = 'run'; }
    else { it.builtAt = iso(r.updated_at); it.builtFrom = 'touched'; }
  }

  const s = suite.rows[0];
  return {
    suite: s ? { total: s.total, passed: s.passed, failed: s.failed, at: iso(s.run_at) } : null,
    branchesAt: iso(branches.rows[0]?.reported_at),
    items,
  };
}
