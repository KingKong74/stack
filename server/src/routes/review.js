import { Router } from 'express';
import { q } from '../db.js';
import { relativeTime } from '../util.js';
import { agentReads, runCore } from '../shape.js';
import { geminiEnabled } from '../gemini.js';

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
    // Turn 3 — is a key configured at all. The Refine dialog's ✦ draft button
    // is ABSENT without one rather than disabled, the same absent-not-broken
    // rule the Quality page follows (#278).
    geminiReady: geminiEnabled(),
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
