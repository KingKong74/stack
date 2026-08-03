import { Router } from 'express';
import { q } from '../db.js';
import { relativeTime } from '../util.js';
import { agentReads, runCore } from '../shape.js';
import { projectBySlug } from '../resolve.js';
import { buildPrompt } from '../prompts.js';
import { agentClient, agentsForClient } from '../agents.js';

// GET /api/review — the Review room's payload (#282, design 24b + 24a).
//
// Review used to live inside ONE project's Roadmap tab, which is the wrong shape
// for a fleet: the nights run across projects, so the morning's queue does too.
// This is the cross-project read, computed in three aggregate queries — never
// one per project:
//
//   queue    every change nobody has verdicted yet, newest first, with the run
//            that built it and the REVIEWER's stored read (#282) so a change
//            arrives pre-verdicted rather than blank.
//   settled  the same rows after a verdict — the archive, capped.
//   nights   runs grouped by the day they finished, for the debrief (24a).
//
// Everything here is a read. Verdicts, refinements, shelving and undo all go
// through the existing per-project roadmap/autopilot routes, so this route can
// never be the thing that mutates a tracker.
//
// #374 — A CHANGE IS WAITING FROM THE MOMENT IT IS BUILT, NOT FROM THE MOMENT
// IT IS TICKED. The queue used to be `done = true`, and nothing ticks: the
// runner stamps `built_note`, pushes the branch and says so in its own log
// ("claim stays until you merge + tick it"), the merge job finishes with "tick
// #N when you've verified it", and the interactive sessions leave the item
// unticked on purpose. So every overnight change sat at `done = false` with a
// branch, a run and a reviewer's read behind it — and the room whose whole job
// is to show you exactly that read "Nothing waiting on you". A queue that can
// only be reached by hand is not a queue.
//
// The fix is NOT to make the runner tick. `done` means shipped — it is what
// `computeProgress` weighs — and an unmerged branch has not shipped. So the
// queue widens instead, and each row carries the STAGE it is at:
//
//   built   done = false, but there is a built_note AND a branch claim. The
//           work exists on a branch and is asking to be read BEFORE it lands,
//           which is the order you actually want.
//   ticked  done = true. What the queue has always held.
//
// Both halves of that `built` predicate matter. `built_note` alone would let a
// half-built claim in; `claimed_by` alone would let any in-progress item in.
// Requiring both is also what keeps a SENT-BACK item out: un-ticking clears
// `claimed_by` (roadmap.js) while leaving `built_note` on record, so a change
// you rejected drops out of the queue and only returns when something rebuilds
// it and re-claims a branch.

export const review = Router();

// #375 — every ✧ surface in this room is the FOREMAN's, and it is bound once
// here. Two of its four ops (`reviewbrief`, `refinedraft`) used to be the
// Curator's and lived on the roadmap routes; they moved with the agent, because
// this room was always their only surface and a room whose buttons answer to
// two different switches cannot be switched off.
const foreman = agentClient('foreman');

// How much history the room carries. The queue is unbounded on purpose (a
// backlog you cannot see is a backlog you will not clear); the archive and the
// night list are windows.
const SETTLED_CAP = 40;
const NIGHT_DAYS = 14;

// Who built it — the same read the old Reviews view used, kept identical so the
// origin chips mean what they always meant.
function originOf(row) {
  if (row.claimed_by && /^auto\//.test(row.claimed_by)) return 'auto';
  if (row.run_branch && /^auto\//.test(row.run_branch)) return 'auto';
  if (row.claimed_by) return 'branch';
  return 'manual';
}

// The host's branch report (#207), folded in for the `built` rows only — a
// ticked change is on main and its branch is usually deleted, so a merge state
// beside it would be noise at best and a lie at worst.
//
// `merge: null` is deliberately its OWN answer, not a green one: no report
// names this branch, which may mean the host has not reported since it was
// pushed, or that somebody merged it and never ticked. The client says which
// possibilities that leaves rather than drawing it as clean. Same rule as a
// NULL `review_verdict` — nothing ran is not nothing found.
function mergeShape(rep) {
  if (!rep) return null;
  return {
    branch: rep.branch,
    ahead: Number(rep.ahead) || 0,
    behind: Number(rep.behind) || 0,
    // true = merges into main, false = conflicts, null = no probe ran. The
    // client's `mergeStateOf` derives the four-valued state off exactly this.
    mergeClean: typeof rep.mergeClean === 'boolean' ? rep.mergeClean : null,
    subject: String(rep.subject || ''),
    when: relativeTime(rep.committedAt) || '',
  };
}

function itemShape(row, reports) {
  const hasRun = row.run_id != null;
  // The claim is the branch (#277); the run's branch is the fallback for a
  // change whose claim was cleared but whose run still names where it went.
  const branch = row.claimed_by || row.run_branch || '';
  const stage = row.done ? 'ticked' : 'built';
  return {
    slug: row.slug,
    name: row.name,
    tint: row.tint || null,
    id: String(row.id),
    title: row.title,
    bucket: row.bucket,
    note: row.note || '',
    builtNote: row.built_note || '',
    refineNote: row.refine_note || '',
    reviewTags: Array.isArray(row.review_tags) ? row.review_tags : [],
    reviewTag: row.review_tag || '',
    shelved: !!row.review_shelved,
    branch: row.claimed_by || '',   // #277 — the claim IS a branch name
    origin: originOf(row),
    when: relativeTime(row.updated_at) || 'just now',
    doneAt: row.updated_at,
    risk: row.risk || 'normal',
    // #374 — where this change is. 'built' = on a branch, read it before it
    // lands; 'ticked' = the human has already closed it out.
    stage,
    merge: stage === 'built' && branch
      ? mergeShape(reports.get(row.project_id)?.get(branch))
      : null,
    // The run that built it, when there was one. `reviewVerdict` is the stored
    // second-model read: '' means no review ran, which is deliberately NOT the
    // same as "nothing found".
    run: hasRun ? {
      id: Number(row.run_id),
      branch: row.run_branch || '',
      outcome: row.run_outcome,
      commits: row.run_commits || 0,
      tokens: Number(row.run_tokens) || 0,
      costUsd: Number(row.run_cost) || 0,
      checksFailing: row.run_checks,
      summary: row.run_summary || '',
      // Both second-model reads (#282/#284), shaped once in shape.js. The run's
      // own columns wear `run_` aliases here (it is LEFT JOINed beside the item,
      // so `branch` and `summary` would collide) — the agent columns are not
      // aliased, so this half of the shape is shared and the rest is local.
      ...agentReads(row),
      when: relativeTime(row.run_finished) || '',
      finishedAt: row.run_finished,
    } : null,
  };
}

// What it means to be waiting on a verdict — see the header. Built OR ticked,
// and the built half needs BOTH the account of what landed and the branch it
// landed on.
const AWAITING = `(i.done = true
    OR (COALESCE(i.built_note, '') <> '' AND COALESCE(i.claimed_by, '') <> ''))`;

// One SELECT for both the queue and the archive: changes joined to the newest
// run that mentions them. DISTINCT ON keeps a re-run item to one row.
const ITEM_SQL = `
  SELECT i.id, i.title, i.bucket, i.note, i.built_note, i.refine_note, i.review_tag,
         i.review_tags, i.review_shelved, i.claimed_by, i.updated_at, i.risk, i.done,
         i.project_id::int AS project_id,
         p.slug, p.name, p.tint,
         r.id AS run_id, r.branch AS run_branch, r.outcome AS run_outcome,
         r.commits AS run_commits, r.tokens AS run_tokens, r.cost_usd AS run_cost,
         r.checks_failing AS run_checks, r.summary AS run_summary,
         r.review_verdict, r.review_note, r.review_findings,
         r.architect_verdict, r.architect_note, r.architect_obs,
         r.finished_at AS run_finished
    FROM roadmap_items i
    JOIN projects p ON p.id = i.project_id AND p.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT * FROM autopilot_runs ar
       WHERE ar.project_id = i.project_id AND ar.item_id = i.id
       ORDER BY ar.finished_at DESC LIMIT 1
    ) r ON true
   WHERE ${AWAITING} AND %WHERE%
   ORDER BY i.updated_at DESC %LIMIT%`;

review.get('/', async (req, res) => {
  const [pending, settled, nights, reportRows] = await Promise.all([
    q(ITEM_SQL.replace('%WHERE%', 'i.review_tag IS NULL').replace('%LIMIT%', '')),
    // The archive tests the verdict and NOTHING about `done` — a change you
    // approved before it merged must not fall out of both lists on its way
    // through. It leaves the queue and lands here, exactly like a ticked one.
    q(ITEM_SQL.replace('%WHERE%', "i.review_tag IS NOT NULL AND i.review_tag <> ''")
      .replace('%LIMIT%', `LIMIT ${SETTLED_CAP}`)),
    // The debrief's raw material: every run of the last fortnight with its
    // project, so the client can group by night without a second round trip.
    q(
      `SELECT r.*, p.slug, p.name, p.tint
         FROM autopilot_runs r
         JOIN projects p ON p.id = r.project_id AND p.deleted_at IS NULL
        WHERE r.finished_at > now() - interval '${NIGHT_DAYS} days'
        ORDER BY r.finished_at DESC`
    ),
    // #207's snapshot, all projects in one read — the same shape Mission
    // Control's merge strip folds in, and read here for the same reason: the
    // server cannot run git, so the host's probe is the only thing that knows
    // whether a branch waiting for a verdict can actually land.
    q(`SELECT project_id::int AS project_id, report FROM branch_reports`),
  ]);

  const reports = new Map();
  for (const r of reportRows.rows) {
    const byBranch = new Map();
    for (const b of (Array.isArray(r.report) ? r.report : [])) {
      if (b && b.branch) byBranch.set(b.branch, b);
    }
    reports.set(r.project_id, byBranch);
  }

  const queue = pending.rows.map((r) => itemShape(r, reports));
  const active = queue.filter((it) => !it.shelved);

  res.json({
    // #375 — which agents may act, and which of their ops, so every ✧ in the
    // room renders ABSENT with a reason rather than as a button that 409s. This
    // replaced `geminiReady`: the room's ops are the Foreman's now and the
    // Foreman runs Claude on the host, so a Gemini key says nothing about
    // whether they can run. Same shape the project detail payload carries.
    agents: await agentsForClient(),
    queue,
    settled: settled.rows.map((r) => itemShape(r, reports)),
    nights: nights.rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      tint: r.tint || null,
      id: Number(r.id),
      itemId: r.item_id != null ? String(r.item_id) : '',
      itemTitle: r.item_title || '',
      ...runCore(r),
      // The UTC calendar day the run finished — the client groups nights on it,
      // the same convention Mission Control's week strip already uses.
      day: r.finished_at ? new Date(r.finished_at).toISOString().slice(0, 10) : '',
      when: relativeTime(r.finished_at) || 'just now',
      finishedAt: r.finished_at,
    })),
    totals: {
      pending: active.length,
      shelved: queue.length - active.length,
      // What the reviewer wants looked at first: it said blocked, or the run
      // finished with checks red. Both are evidence, not opinion.
      flagged: active.filter((it) => it.run?.reviewVerdict === 'blocked' || (it.run?.checksFailing ?? 0) > 0).length,
      // #374 — how much of the queue is still on a branch. Deliberately NOT
      // folded into `flagged`: unmerged is the normal state of overnight work,
      // not a problem with it, and flagged means evidence of something wrong.
      unmerged: active.filter((it) => it.stage === 'built').length,
      projects: new Set(active.map((it) => it.slug)).size,
      settled: settled.rows.length,
    },
  });
});

// ===========================================================================
// THE FOREMAN'S OPS (#375)
//
// Four ops, one agent, one room. Everything below annotates and NOTHING below
// writes: the verdict, the refinement and the merge are all still the human's
// presses through the routes they always went through. That is the same line
// every other agent holds, and it matters most here — this is the room where
// one keypress signs work off.
//
// What the Foreman is given is the RECORD, never the diff: the server runs in a
// container with no checkout (the repos are on the host behind the firewall).
// Every prompt says so, and `read[]` comes back on the answer so the room can
// print what was actually assembled rather than a caption claiming more.
// ===========================================================================

// Truncation that admits it, same as the Merge agent's.
const clip = (v, max) => {
  const t = String(v ?? '').trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}… (truncated)` : t;
};
const list = (v, cap, len = 300) => (Array.isArray(v) ? v : [])
  .map((s) => clip(s, len)).filter(Boolean).slice(0, cap);

// A path INTO the running mirror site. The Foreman proposes these and the room
// turns them into links against the preview's URL, so this is the one field of
// an agent answer that becomes something the owner clicks. It is therefore
// validated hard and rejected silently: same-origin only (a leading `//` is a
// host, not a path), no backslashes, no whitespace, nothing that is not already
// legal in a URL path/query/fragment.
export const cleanPath = (v) => {
  const p = String(v ?? '').trim();
  if (!p.startsWith('/') || p.startsWith('//') || p.length > 200) return '';
  return /^[A-Za-z0-9/#?&=._~:@!$'()*+,;%-]+$/.test(p) ? p : '';
};

const FILE_CAP = 30;

// Everything the record holds about ONE change, gathered once and shared by
// three of the four ops. Returns { error, status } instead of throwing so each
// route can answer with its own words.
async function loadChange(slug, id) {
  const project = await projectBySlug(slug);
  if (!project) return { error: 'No such project.', status: 404 };
  const { rows } = await q(
    'SELECT * FROM roadmap_items WHERE project_id = $1 AND id = $2', [project.id, Number(id)]);
  const item = rows[0];
  if (!item) return { error: 'No such roadmap item.', status: 404 };

  // #374 — BUILT or ticked, the same predicate the queue above uses. This used
  // to be `if (!item.done) 400`, which was correct only while the queue held
  // ticked work exclusively: after #374 the room's whole point is reading a
  // change ON ITS BRANCH, and every ✧ in it answered "Only completed items get
  // a review brief" on exactly the changes it was showing.
  const built = String(item.built_note || '') !== '' && String(item.claimed_by || '') !== '';
  if (!item.done && !built) {
    return {
      error: 'That change is not waiting on a verdict — nothing has built it on a branch and nobody has ticked it.',
      status: 400,
    };
  }

  const branch = item.claimed_by || '';
  const [{ rows: runRows }, { rows: checkRows }, { rows: reportRows }, { rows: mirrorRows }] =
    await Promise.all([
      q(`SELECT branch, commits, outcome, checks_failing, summary,
                review_verdict, review_note, review_findings,
                architect_verdict, architect_note, architect_obs
           FROM autopilot_runs
          WHERE project_id = $1 AND item_id = $2
          ORDER BY finished_at DESC LIMIT 1`, [project.id, item.id]),
      q('SELECT name, last_status FROM checks WHERE project_id = $1 ORDER BY id LIMIT 12', [project.id]),
      q('SELECT report FROM branch_reports WHERE project_id = $1', [project.id]),
      q(`SELECT id, status, url FROM previews
          WHERE project_id = $1 AND branch = $2 AND status IN ('queued','starting','live')
          ORDER BY created_at DESC LIMIT 1`, [project.id, branch || '']),
    ]);
  const run = runRows[0] || null;

  // The files the work touched, from the sessions recorded against its branch.
  // A list of what was OPENED, not a diff — and every prompt is told which.
  let files = [];
  const runBranch = run?.branch || branch;
  if (runBranch) {
    const { rows: fileRows } = await q(
      `SELECT files_touched FROM sessions
        WHERE project_id = $1 AND branch = $2 AND jsonb_array_length(files_touched) > 0
        ORDER BY created_at DESC LIMIT 8`, [project.id, runBranch]);
    const seen = new Set();
    for (const r of fileRows) {
      for (const f of (Array.isArray(r.files_touched) ? r.files_touched : [])) {
        if (typeof f === 'string' && f) {
          seen.add(f.replace(/^.*?\/(?=(server|web|hook|scripts|terminal|templates)\/)/, ''));
        }
      }
    }
    files = [...seen];
  }

  const report = (Array.isArray(reportRows[0]?.report) ? reportRows[0].report : [])
    .find((b) => b && b.branch === runBranch) || null;

  return { project, item, run, checks: checkRows, files, report, mirror: mirrorRows[0] || null, branch: runBranch };
}

// The prompt blocks the three per-change ops share. Each one states what it is
// — a claim, a stored read, a list of files opened — because the difference
// between those is the whole of what the Foreman is allowed to conclude.
function changeBlocks(c) {
  const shownFiles = c.files.slice(0, FILE_CAP);
  const failing = c.checks.filter((x) => x.last_status === 'fail');
  return {
    ID: String(c.item.id),
    BUCKET: c.item.bucket,
    TITLE: c.item.title,
    NOTE_LINE: c.item.note ? `The item's note: ${clip(c.item.note, 1000)}` : '',
    BUILT_NOTE: clip(c.item.built_note || '(none recorded — the builder left no account)', 2000),
    // #374 — where the change IS. It changes what a verdict means, so it is
    // stated before anything else about quality.
    STAGE_LINE: c.item.done
      ? 'This change has already been ticked off — it is on main.'
      : `This change is STILL ON ITS BRANCH (${c.branch || 'unnamed'}) and has not landed on main. Approving it is approving a merge, not closing it out.`,
    RUN_BLOCK: c.run
      ? `The run: branch ${c.run.branch}, ${c.run.commits} commit${c.run.commits === 1 ? '' : 's'}, outcome ${c.run.outcome}`
        + `${c.run.checks_failing == null ? ', checks never run' : `, ${c.run.checks_failing} check${c.run.checks_failing === 1 ? '' : 's'} failing`}.`
        + `\nThe session's own account:\n${clip(c.run.summary || '(none)', 3000)}`
      : 'No autopilot run recorded — built by hand or by an interactive session, so there is no run log.',
    // An empty verdict means NO PASS RAN, said in those words (the rule the
    // whole app holds): "no reviewer read" is not "the reviewer found nothing".
    REVIEW_BLOCK: c.run?.review_verdict
      ? `The second model reviewed the branch DIFF at push time and returned "${c.run.review_verdict}"`
        + `${c.run.review_findings != null ? ` with ${c.run.review_findings} finding${c.run.review_findings === 1 ? '' : 's'}` : ''}:`
        + `\n${clip(c.run.review_note || '(no note)', 2000)}`
      : 'No second-model review ran on this branch — that is an absence of evidence, not a clean bill.',
    ARCHITECT_BLOCK: c.run?.architect_verdict
      ? `The architect's structural read returned "${c.run.architect_verdict}": ${clip(c.run.architect_note || '', 1500)}`
      : 'No architect read this change either.',
    CHECKS_BLOCK: c.checks.length
      ? `The project's checks: ${c.checks.map((x) => `${x.name} (${x.last_status || 'never run'})`).join(', ')}.`
        + (failing.length
          ? ` The failing ones are project-wide and may long predate this change — only weigh one if this change's own subject plausibly caused it.`
          : '')
      : '',
    FILES_BLOCK: shownFiles.length
      ? `The sessions on that branch touched ${c.files.length} file${c.files.length === 1 ? '' : 's'}`
        + `${c.files.length > FILE_CAP ? ` (the ${FILE_CAP} below are a sample of them)` : ''}: ${shownFiles.join(', ')}`
      : 'No record of which files the work touched.',
    // The host's probe, which is the only thing that knows whether the branch
    // can actually land. Unprobed is its own answer, never a green one (#363).
    MERGE_BLOCK: c.item.done ? '' : c.report
      ? `The host probed the branch: ${c.report.ahead ?? 0} commit${(c.report.ahead ?? 0) === 1 ? '' : 's'} ahead of main, ${c.report.behind ?? 0} behind`
        + `${typeof c.report.mergeClean === 'boolean'
          ? c.report.mergeClean ? ', and it merges into main cleanly.' : ', and it CONFLICTS with main.'
          : ', and whether it merges cleanly was not probed.'}`
      : 'No branch report names this branch, so nothing here says whether it still merges cleanly.',
    MIRROR_BLOCK: `A MIRROR SITE can be brought up from this room: the branch running as its own copy of the`
      + ` application, at its own URL${c.mirror ? ` (one is up for this branch right now)` : ''}. The owner opens it from the`
      + ` change they are reading, so any path you give in "where" is turned into a link they click. The app is`
      + ` hash-routed, so paths look like "/#/p/<project>/<tab>" or "/#/control/<room>".`,
    NORTH_STAR_LINE: c.project.north_star
      ? `For context, the project's north star: "${clip(c.project.north_star, 400)}"`
      : '',
  };
}

// What the server actually put in front of the model. Printed by the room, so
// a change with no run behind it says so rather than wearing a fixed caption.
const readList = (c) => [
  c.run ? 'the run log' : '',
  c.run?.review_verdict ? "the push reviewer's read of the diff" : '',
  c.run?.architect_verdict ? 'the architect' : '',
  c.files.length ? `${c.files.length} file${c.files.length === 1 ? '' : 's'} touched` : '',
  c.report ? 'the branch probe' : '',
  c.checks.length ? `${c.checks.length} check${c.checks.length === 1 ? '' : 's'}` : '',
].filter(Boolean);

// POST /api/review/:slug/:id/read — ✧ Read this change.
//   -> { call, why, test[], where[{path,what}], blind[], read[] }
review.post('/:slug/:id/read', async (req, res) => {
  const c = await loadChange(req.params.slug, req.params.id);
  if (c.error) return res.status(c.status).json({ error: c.error });

  const prompt = buildPrompt('readchange', changeBlocks(c));
  try {
    // 45s was the first cut and it was wrong: these numbers were inherited from
    // the Gemini era, when the backend was an HTTP API answering in seconds.
    // Since #364 the backend is `claude -p` on the host, which spawns a CLI and
    // reads a page of record before it writes a word — the FIRST real press of
    // this button timed out at 45s. `askClaudeOnHost` defaults to 180s for that
    // reason; an op that reads a whole change has no business asking for less.
    const answer = await foreman.ask('readchange', prompt, { timeoutMs: 180_000 });
    const call = ['approve', 'look', 'send-back'].includes(answer?.call) ? answer.call : 'look';
    res.json({
      call,
      why: clip(answer?.why, 600),
      test: list(answer?.test, 5),
      // A path that does not validate is dropped rather than rendered as dead
      // text: the whole promise of this list is that every row opens.
      where: (Array.isArray(answer?.where) ? answer.where : [])
        .map((w) => ({ path: cleanPath(w?.path), what: clip(w?.what, 120) }))
        .filter((w) => w.path && w.what)
        .slice(0, 4),
      blind: list(answer?.blind, 3),
      read: readList(c),
    });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || 'The Foreman could not read this change.' });
  }
});

// POST /api/review/:slug/:id/brief — ✧ the reviewer's brief (#134, moved here
// from the roadmap routes with the op). What shipped, how to test it, likely
// risks. Annotation only, nothing stored.
review.post('/:slug/:id/brief', async (req, res) => {
  const c = await loadChange(req.params.slug, req.params.id);
  if (c.error) return res.status(c.status).json({ error: c.error });

  const b = changeBlocks(c);
  const prompt = buildPrompt('reviewbrief', b);
  try {
    const answer = await foreman.ask('reviewbrief', prompt, { timeoutMs: 120_000 });
    const summary = clip(answer?.summary, 1200);
    if (!summary) return res.status(502).json({ error: 'The Foreman returned nothing usable.' });
    res.json({ summary, test: list(answer?.test, 6), risks: list(answer?.risks, 3) });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || 'The Foreman could not write the brief.' });
  }
});

// POST /api/review/:slug/:id/refine-draft — ✎ the delta that sends a change
// back (Turn 3, moved here with the op).
//
// An EMPTY draft is a valid answer and often the right one: the prompt asks for
// one whenever the record does not evidence something to change. That escape
// hatch is the difference between an assistant and a complaint generator.
review.post('/:slug/:id/refine-draft', async (req, res) => {
  const c = await loadChange(req.params.slug, req.params.id);
  if (c.error) return res.status(c.status).json({ error: c.error });

  const b = changeBlocks(c);
  const failing = c.checks.filter((x) => x.last_status === 'fail');
  const prompt = buildPrompt('refinedraft', {
    ...b,
    OWNER_BLOCK: failing.length
      ? `Checks currently FAILING on this project: ${failing.map((x) => x.name).join(', ')}.`
      : '',
  });
  try {
    const answer = await foreman.ask('refinedraft', prompt, { timeoutMs: 120_000 });
    res.json({
      draft: clip(answer?.draft, 2000),
      basis: clip(answer?.basis, 60),
      read: readList(c),
    });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || 'The Foreman could not draft the refinement.' });
  }
});

// POST /api/review/triage — ✧ Triage the queue.
//
// The one op that reads the whole room. It returns an ORDER and nothing else:
// no verdicts, because it has read none of these changes, and a queue that
// arrived pre-decided would be worse than one that arrived unsorted.
const TRIAGE_CAP = 40;

review.post('/triage', async (_req, res) => {
  const { rows } = await q(
    ITEM_SQL.replace('%WHERE%', 'i.review_tag IS NULL AND i.review_shelved IS NOT TRUE').replace('%LIMIT%', ''));
  if (!rows.length) return res.status(400).json({ error: 'Nothing is waiting on a verdict.' });

  const { rows: reportRows } = await q('SELECT project_id::int AS project_id, report FROM branch_reports');
  const reports = new Map();
  for (const r of reportRows) {
    const byBranch = new Map();
    for (const b of (Array.isArray(r.report) ? r.report : [])) if (b?.branch) byBranch.set(b.branch, b);
    reports.set(r.project_id, byBranch);
  }

  const items = rows.map((r) => itemShape(r, reports));
  // A capped list inside a prompt must SAY it is capped, and be capped on the
  // right axis (#239). The rows are already newest-first and the question is
  // "what do I open first", so the OLDEST are the ones a cap must not drop —
  // they are the ones that have been waiting longest. Hence the tail, not the
  // head, and the count says what was left out.
  const shown = items.length > TRIAGE_CAP ? items.slice(-TRIAGE_CAP) : items;
  const line = (it) => [
    `${it.slug}#${it.id}`,
    it.name,
    it.stage,
    it.when,
    it.run?.reviewVerdict || 'no review ran',
    it.run?.checksFailing == null ? 'checks not run' : it.run.checksFailing === 0 ? 'checks green' : `${it.run.checksFailing} checks red`,
    it.stage === 'built'
      ? (it.merge
        ? (it.merge.mergeClean === false ? 'CONFLICTS with main'
          : it.merge.mergeClean === true ? `merges cleanly${it.merge.behind ? `, ${it.merge.behind} behind` : ''}`
            : 'merge not probed')
        : 'no branch report')
      : 'on main',
    clip(it.title, 120),
  ].join(' | ');

  const prompt = buildPrompt('triagequeue', {
    COUNT: String(shown.length),
    PLURAL: shown.length === 1 ? '' : 's',
    QUEUE: shown.map(line).join('\n')
      + (items.length > shown.length
        ? `\n(${items.length} changes are waiting in total; the ${shown.length} above are the longest-waiting of them.)`
        : ''),
  });

  try {
    // The whole queue, up to forty rows of it — the longest read of the four.
    const answer = await foreman.ask('triagequeue', prompt, { timeoutMs: 180_000 });
    const known = new Map(shown.map((it) => [`${it.slug}#${it.id}`, it]));
    const seen = new Set();
    const order = [];
    for (const o of (Array.isArray(answer?.order) ? answer.order : [])) {
      const key = String(o?.key || '').trim();
      if (!known.has(key) || seen.has(key)) continue;   // invented or repeated — drop it
      seen.add(key);
      order.push({ key, why: clip(o?.why, 160), placed: true });
    }
    // Anything the Foreman did not place goes on the end, marked as unplaced.
    // Silently dropping it would leave a change out of the only list the owner
    // is now working from — the #239 rule applied to an ANSWER rather than a
    // prompt: a list that omits something must say it omitted it.
    for (const it of shown) {
      const key = `${it.slug}#${it.id}`;
      if (!seen.has(key)) order.push({ key, why: '', placed: false });
    }
    res.json({
      order,
      note: clip(answer?.note, 300),
      // What it was given, so the room can say "the oldest 40 of 57" rather
      // than presenting a partial order as the whole morning.
      considered: shown.length,
      total: items.length,
    });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || 'The Foreman could not triage the queue.' });
  }
});
