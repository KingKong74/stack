import { createHash } from 'node:crypto';
import { Router } from 'express';
import { q } from '../db.js';
import { sessionPlanShape } from '../shape.js';
import { numericId } from '../params.js';
import { projectBySlug } from '../resolve.js';

// SESSION PLANS — Claude Code plan-mode plans, posted by `hook/stack-plan.mjs`
// when a human approves one. Mounted at /api/projects/:slug/plans.
//
// A POST NEVER CREATES A PROJECT. Ingest does that, on a real push; a plan
// from a checkout Stack has never heard of 404s and the hook says so on
// stderr. Otherwise any directory a plan was approved in becomes a project.
//
// NOTHING HERE WRITES THE ROADMAP. Turning a plan into items is a human's
// action on the Plans tab; capture only records (schema.sql says why).
export const plans = Router({ mergeParams: true });

plans.param('id', numericId);

const BODY_CAP = 200_000;

async function resolve(req, res) {
  const p = await projectBySlug(req.params.slug);
  if (!p) res.status(404).json({ error: 'No such project.' });
  return p;
}

// The first `# ` heading, else the first non-empty line. Never empty: a plan
// with no text is refused before this runs.
export function planTitle(body) {
  const lines = String(body).split('\n').map((l) => l.trim()).filter(Boolean);
  const h1 = lines.find((l) => /^#\s+/.test(l));
  return (h1 ? h1.replace(/^#\s+/, '') : lines[0] || '').replace(/[#*`]/g, '').trim().slice(0, 200);
}

// GET / -> newest first, without bodies.
plans.get('/', async (req, res) => {
  const p = await resolve(req, res);
  if (!p) return;
  const { rows } = await q(
    `SELECT id, session_id, title, plan_file, branch, commit_hash, created_at, length(body) AS size
       FROM session_plans WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`,
    [p.id]
  );
  res.json(rows.map((r) => sessionPlanShape(r)));
});

// GET /:id -> one plan, with its markdown.
plans.get('/:id', async (req, res) => {
  const p = await resolve(req, res);
  if (!p) return;
  const { rows } = await q('SELECT * FROM session_plans WHERE id = $1 AND project_id = $2',
    [Number(req.params.id), p.id]);
  if (!rows.length) return res.status(404).json({ error: 'No such plan.' });
  res.json(sessionPlanShape(rows[0], { withBody: true }));
});

// POST / -> record an approved plan. Idempotent on (session, body): a retried
// hook answers 200 with the row it already made, a revised plan is a new row.
plans.post('/', async (req, res) => {
  const p = await resolve(req, res);
  if (!p) return;
  const b = req.body ?? {};
  const body = String(b.body ?? '').replace(/\r\n/g, '\n').trim();
  if (!body) return res.status(400).json({ error: 'A plan needs a body.' });
  if (body.length > BODY_CAP) {
    return res.status(413).json({ error: `A plan is capped at ${BODY_CAP} characters.` });
  }
  const str = (k, cap) => String(b[k] ?? '').trim().slice(0, cap);
  const sessionId = str('sessionId', 100);
  const fingerprint = createHash('sha256').update(body).digest('hex');
  const ins = await q(
    `INSERT INTO session_plans (project_id, session_id, title, body, plan_file, branch, commit_hash, fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (project_id, session_id, fingerprint) DO NOTHING
     RETURNING *`,
    [p.id, sessionId, planTitle(body), body,
      str('planFile', 200).split('/').pop(), str('branch', 200), str('commit', 40), fingerprint]
  );
  if (ins.rows.length) return res.status(201).json(sessionPlanShape(ins.rows[0]));
  const { rows } = await q(
    'SELECT * FROM session_plans WHERE project_id = $1 AND session_id = $2 AND fingerprint = $3',
    [p.id, sessionId, fingerprint]
  );
  res.json(sessionPlanShape(rows[0]));
});

// DELETE /:id -> a human discarding a plan. Nothing else refers to one.
plans.delete('/:id', async (req, res) => {
  const p = await resolve(req, res);
  if (!p) return;
  const { rowCount } = await q('DELETE FROM session_plans WHERE id = $1 AND project_id = $2',
    [Number(req.params.id), p.id]);
  if (!rowCount) return res.status(404).json({ error: 'No such plan.' });
  res.json({ ok: true });
});
