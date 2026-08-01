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
//   queue    every completed item nobody has verdicted yet, newest first, with
//            the run that built it and the REVIEWER's stored read (#282) so a
//            change arrives pre-verdicted rather than blank.
//   settled  the same rows after a verdict — the archive, capped.
//   nights   runs grouped by the day they finished, for the debrief (24a).
//
// Everything here is a read. Verdicts, refinements, shelving and undo all go
// through the existing per-project roadmap/autopilot routes, so this route can
// never be the thing that mutates a tracker.

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

function itemShape(row) {
  const hasRun = row.run_id != null;
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
    riskSource: row.risk_source || '',
    riskReason: row.risk_reason || '',
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

// One SELECT for both the queue and the archive: completed items joined to the
// newest run that mentions them. DISTINCT ON keeps a re-run item to one row.
const ITEM_SQL = `
  SELECT i.id, i.title, i.bucket, i.note, i.built_note, i.refine_note, i.review_tag,
         i.review_tags, i.review_shelved, i.claimed_by, i.updated_at, i.risk,
         i.risk_source, i.risk_reason,
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
   WHERE i.done = true AND %WHERE%
   ORDER BY i.updated_at DESC %LIMIT%`;

review.get('/', async (req, res) => {
  const [pending, settled, nights] = await Promise.all([
    q(ITEM_SQL.replace('%WHERE%', 'i.review_tag IS NULL').replace('%LIMIT%', '')),
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
  ]);

  const queue = pending.rows.map(itemShape);
  const active = queue.filter((it) => !it.shelved);

  res.json({
    // Turn 3 — is a key configured at all. The Refine dialog's ✦ draft button
    // is ABSENT without one rather than disabled, the same absent-not-broken
    // rule the Quality page follows (#278).
    geminiReady: geminiEnabled(),
    queue,
    settled: settled.rows.map(itemShape),
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
      projects: new Set(active.map((it) => it.slug)).size,
      settled: settled.rows.length,
    },
  });
});
