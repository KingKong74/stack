import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { fingerprint, oneOf, SEVERITIES, BUG_STATUSES } from '../util.js';
import { bugShape } from '../shape.js';

// Mounted at /api/projects/:slug/bugs (mergeParams to see :slug).
export const bugs = Router({ mergeParams: true });

// Resolve the project once for every route under here.
bugs.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

// GET  /  -> list
bugs.get('/', async (req, res) => {
  const { rows } = await q(
    'SELECT * FROM bugs WHERE project_id = $1 ORDER BY created_at DESC',
    [req.project.id]
  );
  res.json(rows.map(bugShape));
});

// #278 — resolve a bug↔check link. Only this project's checks are linkable, so a
// bogus (or another project's) id lands as NULL rather than a cross-project link.
async function ownCheckId(projectId, raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await q('SELECT id FROM checks WHERE id = $1 AND project_id = $2', [id, projectId]);
  return rows.length ? id : null;
}

// POST /  -> create a manual bug
bugs.post('/', async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 300);
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const severity = oneOf(req.body?.severity, SEVERITIES, 'medium');
  // The check this bug was filed from (the Quality page's → Bug on a red check).
  const checkId = req.body?.check_id == null ? null : await ownCheckId(req.project.id, req.body.check_id);

  const { rows: maxr } = await q(
    `SELECT COALESCE(MAX((substring(bug_key from '^BUG-([0-9]+)$'))::int), 0) AS n
       FROM bugs WHERE project_id = $1`,
    [req.project.id]
  );
  const bugKey = `BUG-${maxr[0].n + 1}`;

  const { rows } = await q(
    `INSERT INTO bugs (project_id, bug_key, title, severity, status, source, fingerprint, check_id)
     VALUES ($1,$2,$3,$4,'open','manual',$5,$6) RETURNING *`,
    [req.project.id, bugKey, title, severity, fingerprint(title), checkId]
  );
  res.status(201).json(bugShape(rows[0]));
});

// PATCH /:bugKey  -> status / severity / title / reviewed (the review inbox)
bugs.patch('/:bugKey', async (req, res) => {
  const sets = [];
  const vals = [];
  let i = 1;
  if (req.body?.reviewed !== undefined) {
    sets.push(`reviewed_at = ${req.body.reviewed ? 'now()' : 'NULL'}`);
  }
  if (req.body?.status !== undefined) {
    sets.push(`status = $${i++}`); vals.push(oneOf(req.body.status, BUG_STATUSES, 'open'));
  }
  if (req.body?.severity !== undefined) {
    sets.push(`severity = $${i++}`); vals.push(oneOf(req.body.severity, SEVERITIES, 'medium'));
  }
  if (req.body?.title !== undefined) {
    const title = String(req.body.title).trim().slice(0, 300);
    if (title) { sets.push(`title = $${i++}`); vals.push(title); }
  }
  // #278 — link or unlink the check that caught this bug (null/'' unlinks).
  if (req.body?.check_id !== undefined) {
    const checkId = req.body.check_id === null || req.body.check_id === ''
      ? null : await ownCheckId(req.project.id, req.body.check_id);
    sets.push(`check_id = $${i++}`); vals.push(checkId);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

  vals.push(req.project.id, req.params.bugKey);
  const { rows } = await q(
    `UPDATE bugs SET ${sets.join(', ')}, updated_at = now()
      WHERE project_id = $${i++} AND bug_key = $${i} RETURNING *`,
    vals
  );
  if (!rows.length) return res.status(404).json({ error: 'No such bug.' });
  res.json(bugShape(rows[0]));
});

// DELETE /:bugKey  -> remove; auto (hook) bugs leave a tombstone
bugs.delete('/:bugKey', async (req, res) => {
  const { rows } = await q(
    'DELETE FROM bugs WHERE project_id = $1 AND bug_key = $2 RETURNING source, fingerprint',
    [req.project.id, req.params.bugKey]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such bug.' });
  if (rows[0].source === 'hook') {
    await q(
      `INSERT INTO dismissed_items (project_id, kind, fingerprint)
       VALUES ($1,'bug',$2) ON CONFLICT DO NOTHING`,
      [req.project.id, rows[0].fingerprint]
    );
  }
  res.json({ ok: true });
});
