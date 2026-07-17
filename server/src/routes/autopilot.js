import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { relativeTime } from '../util.js';

// Mounted at /api/projects/:slug/autopilot — the overnight runner's history.
// The runner POSTs one row per item attempt; the dashboard's morning digest
// and this project's panel GET them back. Rows are the runner's account of
// itself — humans never write here.
export const autopilot = Router({ mergeParams: true });

const OUTCOMES = ['landed', 'no-commits', 'failed', 'limit'];

autopilot.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

export function runShape(r) {
  return {
    id: r.id,
    itemId: r.item_id,
    itemTitle: r.item_title || '',
    branch: r.branch || '',
    outcome: r.outcome,
    commits: r.commits,
    tokens: Number(r.tokens) || 0,
    costUsd: Number(r.cost_usd) || 0,
    checksFailing: r.checks_failing,
    summary: r.summary || '',
    when: relativeTime(r.finished_at) || 'just now',
    finishedAt: r.finished_at,
  };
}

// GET /runs -> recent run history, newest first
autopilot.get('/runs', async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const { rows } = await q(
    'SELECT * FROM autopilot_runs WHERE project_id = $1 ORDER BY finished_at DESC LIMIT $2',
    [req.project.id, limit]
  );
  res.json(rows.map(runShape));
});

// POST /runs -> the runner records an item attempt
autopilot.post('/runs', async (req, res) => {
  const b = req.body || {};
  const outcome = OUTCOMES.includes(b.outcome) ? b.outcome : 'landed';
  const { rows } = await q(
    `INSERT INTO autopilot_runs
       (project_id, item_id, item_title, branch, outcome, commits, tokens, cost_usd, checks_failing, summary, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11, now())) RETURNING *`,
    [
      req.project.id,
      Number.isFinite(Number(b.item_id)) ? Number(b.item_id) : null,
      String(b.item_title || '').slice(0, 300),
      String(b.branch || '').slice(0, 120),
      outcome,
      Math.max(0, parseInt(b.commits, 10) || 0),
      Math.max(0, parseInt(b.tokens, 10) || 0),
      Math.max(0, Number(b.cost_usd) || 0),
      Number.isFinite(Number(b.checks_failing)) ? Number(b.checks_failing) : null,
      String(b.summary || '').slice(0, 2000),
      b.started_at ? new Date(b.started_at) : null,
    ]
  );
  res.status(201).json(runShape(rows[0]));
});
