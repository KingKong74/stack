import { createHash } from 'node:crypto';
import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { artifactShape, ARTIFACT_COLS } from './artifacts.js';

// PLAN-MODE PLANS — posted by `hook/stack-plan.mjs` when a human approves one,
// and filed as a `doc` ARTIFACT (routes/artifacts.js) with `origin` saying
// where it came from. Mounted at /api/projects/:slug/plans; POST is the only
// route, kept at this path because every installed copy of the hook in
// ~/.stack posts here.
//
// A POST NEVER CREATES A PROJECT. Ingest does that, on a real push; a plan
// from a checkout Stack has never heard of 404s and the hook says so on
// stderr. Otherwise any directory a plan was approved in becomes a project.
//
// NOTHING HERE WRITES THE ROADMAP. A plan usually spans several items, and a
// row born from a capture would be approved-to-run by its source: a plan the
// fleet could build from without anyone looking is what the gate forbids.
export const plans = Router({ mergeParams: true });

const BODY_CAP = 200_000;

// The first `# ` heading, else the first non-empty line. Never empty: a plan
// with no text is refused before this runs.
export function planTitle(body) {
  const lines = String(body).split('\n').map((l) => l.trim()).filter(Boolean);
  const h1 = lines.find((l) => /^#\s+/.test(l));
  return (h1 ? h1.replace(/^#\s+/, '') : lines[0] || '').replace(/[#*`]/g, '').trim().slice(0, 200);
}

// POST / -> file an approved plan. Idempotent on (session, body): a retried
// hook answers 200 with the artifact it already made, a revised plan is a new one.
plans.post('/', async (req, res) => {
  const p = await projectBySlug(req.params.slug);
  if (!p) return res.status(404).json({ error: 'No such project.' });
  const b = req.body ?? {};
  const body = String(b.body ?? '').replace(/\r\n/g, '\n').trim();
  if (!body) return res.status(400).json({ error: 'A plan needs a body.' });
  if (body.length > BODY_CAP) {
    return res.status(413).json({ error: `A plan is capped at ${BODY_CAP} characters.` });
  }
  const str = (k, cap) => String(b[k] ?? '').trim().slice(0, cap);
  const sessionId = str('sessionId', 100);
  const origin = {
    kind: 'plan-mode', sessionId, branch: str('branch', 200), commit: str('commit', 40),
    planFile: str('planFile', 200).split('/').pop(),
  };
  const fingerprint = createHash('sha256').update(`${sessionId}\n${body}`).digest('hex');
  const ins = await q(
    `INSERT INTO artifacts (project_id, type, title, body, origin, fingerprint)
     VALUES ($1, 'doc', $2, $3, $4, $5)
     ON CONFLICT (project_id, fingerprint) WHERE fingerprint <> '' DO NOTHING
     RETURNING ${ARTIFACT_COLS}`,
    [p.id, planTitle(body), body, JSON.stringify(origin), fingerprint]
  );
  if (ins.rows.length) return res.status(201).json(artifactShape(ins.rows[0]));
  const { rows } = await q(
    `SELECT ${ARTIFACT_COLS} FROM artifacts WHERE project_id = $1 AND fingerprint = $2`, [p.id, fingerprint]);
  res.json(artifactShape(rows[0]));
});
