import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';

// Mounted at /api/projects/:slug/branches — the host dispatcher's branch
// report (#207). The server can't see git (the repos live on the host, behind
// the firewall), so the dispatcher pushes a snapshot every ~10 minutes: every
// origin branch with ahead/behind counts vs origin/main, a merge-tree conflict
// probe and the item id parsed from the lane name. Write side only — Mission
// Control reads the report folded into the control payload's merge strip.
// #365 — the same post can carry the host's git WORKTREES, surfacing work
// sitting uncommitted or unpushed in a parallel autopilot checkout that no
// pushed ref would ever reveal.
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

// #365 — a git WORKTREE on the host: work sitting uncommitted or unpushed in a
// parallel autopilot checkout, which no pushed ref can ever surface. Mirrors
// cleanEntry's style; `unpushed` deliberately preserves null (never pushed
// anywhere / no upstream) rather than nat()-ing it to 0.
const cleanTree = (w) => {
  if (!w || typeof w !== 'object') return null;
  const path = String(w.path || '').trim().slice(0, 200);
  if (!path) return null;
  return {
    path,
    name: String(w.name || '').slice(0, 80),
    branch: String(w.branch || '').slice(0, 120),
    head: String(w.head || '').slice(0, 12),
    subject: String(w.subject || '').slice(0, 200),
    committedAt: w.committedAt && !Number.isNaN(Date.parse(w.committedAt))
      ? new Date(w.committedAt).toISOString() : null,
    dirty: nat(w.dirty),
    ahead: nat(w.ahead),
    // null = no upstream (never pushed) — a real, distinct fact from 0 ahead
    // of an upstream that exists. Do not nat() this away.
    unpushed: w.unpushed === null || w.unpushed === undefined ? null : nat(w.unpushed),
    itemId: Number.isInteger(Number(w.itemId)) && Number(w.itemId) > 0 ? Number(w.itemId) : null,
    main: !!w.main,
    prunable: !!w.prunable,
  };
};

// POST / — replace the project's report whole (the dispatcher's snapshot).
branches.post('/', async (req, res) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  const list = (Array.isArray(req.body?.branches) ? req.body.branches : [])
    .map(cleanEntry).filter(Boolean).slice(0, 50);
  // #365 — worktrees are reported only when the key is an array; an old
  // dispatcher that only sends branches (or a host git failure — see
  // worktreesOf() in stack-autopilot-dispatch.mjs) omits the key entirely, and
  // that omission must leave the previously-reported worktree list untouched
  // rather than blanking it. $3 carries either the JSON array or NULL, and the
  // COALESCE below reads the OLD row on conflict, not EXCLUDED.
  const hasTrees = Array.isArray(req.body?.worktrees);
  const trees = hasTrees ? req.body.worktrees.map(cleanTree).filter(Boolean).slice(0, 40) : null;
  await q(
    `INSERT INTO branch_reports (project_id, report, reported_at, worktrees, worktrees_at)
     VALUES ($1, $2::jsonb, now(), $3::jsonb, CASE WHEN $3::jsonb IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (project_id) DO UPDATE SET
       report = $2::jsonb,
       reported_at = now(),
       worktrees = COALESCE($3::jsonb, branch_reports.worktrees),
       worktrees_at = CASE WHEN $3::jsonb IS NULL THEN branch_reports.worktrees_at ELSE now() END`,
    [project.id, JSON.stringify(list), trees === null ? null : JSON.stringify(trees)]);
  res.json({ ok: true, count: list.length, worktrees: trees === null ? null : trees.length });
});
