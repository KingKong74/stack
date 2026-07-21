import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';

// Mounted at /api/projects/:slug/branches — the host dispatcher's branch
// report (#207). The server can't see git (the repos live on the host, behind
// the firewall), so the dispatcher pushes a snapshot every ~10 minutes: every
// origin branch with ahead/behind counts vs origin/main, a merge-tree conflict
// probe and the item id parsed from the lane name. Write side only — Mission
// Control reads the report folded into the control payload's merge strip.
export const branches = Router({ mergeParams: true });

const cleanEntry = (b) => {
  if (!b || typeof b !== 'object') return null;
  const name = String(b.branch || '').trim().slice(0, 120);
  if (!name) return null;
  return {
    branch: name,
    ahead: Math.max(0, Math.trunc(Number(b.ahead)) || 0),
    behind: Math.max(0, Math.trunc(Number(b.behind)) || 0),
    // true = merges clean into main, false = conflicts, null = not probed
    mergeClean: typeof b.mergeClean === 'boolean' ? b.mergeClean : null,
    subject: String(b.subject || '').slice(0, 200),
    committedAt: b.committedAt && !Number.isNaN(Date.parse(b.committedAt))
      ? new Date(b.committedAt).toISOString() : null,
    itemId: Number.isInteger(Number(b.itemId)) && Number(b.itemId) > 0 ? Number(b.itemId) : null,
  };
};

// POST / — replace the project's report whole (the dispatcher's snapshot).
branches.post('/', async (req, res) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  const list = (Array.isArray(req.body?.branches) ? req.body.branches : [])
    .map(cleanEntry).filter(Boolean).slice(0, 50);
  await q(
    `INSERT INTO branch_reports (project_id, report, reported_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (project_id) DO UPDATE SET report = EXCLUDED.report, reported_at = now()`,
    [project.id, JSON.stringify(list)]);
  res.json({ ok: true, count: list.length });
});
