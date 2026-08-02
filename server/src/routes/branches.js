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

const nat = (v) => Math.max(0, Math.trunc(Number(v)) || 0);

// #363 — the heaviest paths the branch touches, for the Merge room's expanded
// row. Capped HERE as well as on the host so a rogue report can't grow the
// jsonb without bound; `files` above is the true total, and the room reads the
// difference as "… N more" rather than presenting the cap as the whole diff.
const TOP_FILES = 8;
const cleanFiles = (v) => (Array.isArray(v) ? v : []).slice(0, TOP_FILES).map((f) => ({
  path: String(f?.path || '').slice(0, 160),
  adds: nat(f?.adds),
  dels: nat(f?.dels),
  binary: !!f?.binary,
})).filter((f) => f.path);

const cleanEntry = (b) => {
  if (!b || typeof b !== 'object') return null;
  const name = String(b.branch || '').trim().slice(0, 120);
  if (!name) return null;
  return {
    branch: name,
    ahead: nat(b.ahead),
    behind: nat(b.behind),
    // true = merges clean into main, false = conflicts, null = not probed
    mergeClean: typeof b.mergeClean === 'boolean' ? b.mergeClean : null,
    subject: String(b.subject || '').slice(0, 200),
    committedAt: b.committedAt && !Number.isNaN(Date.parse(b.committedAt))
      ? new Date(b.committedAt).toISOString() : null,
    itemId: Number.isInteger(Number(b.itemId)) && Number(b.itemId) > 0 ? Number(b.itemId) : null,
    // (#363) The diff, from the host's `git diff --numstat origin/main...ref`.
    // A report from an older dispatcher carries none of these; they land as
    // zeroes and the room draws no size bar rather than a bar reading nothing.
    adds: nat(b.adds),
    dels: nat(b.dels),
    files: nat(b.files),
    area: String(b.area || '').slice(0, 80),
    topFiles: cleanFiles(b.topFiles),
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
