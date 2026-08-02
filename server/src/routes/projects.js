import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { q } from '../db.js';
import {
  slugify, oneOf, relativeTime, computeProgress, TINTS, PROJECT_STATUSES,
  PRESENCE_TTL_MINUTES,
} from '../util.js';
import {
  bugShape, groupRoadmap, noteShape, futureShape, checkShape, activityShape,
  projectListShape, projectDetailShape, resumeSince,
} from '../shape.js';
import { readSettings, sessionDefaultLines } from '../settings.js';
import { geminiEnabled } from '../gemini.js';

export const projects = Router();

const metaLineFor = (lastSessionAt) =>
  lastSessionAt ? `pushed ${relativeTime(lastSessionAt)}` : 'no pushes yet';

// GET /api/projects  -> all projects with computed progress, resume-order
projects.get('/', async (_req, res) => {
  const { rows: ps } = await q(
    `SELECT * FROM projects WHERE deleted_at IS NULL
      ORDER BY pinned DESC, last_session_at DESC NULLS LAST, updated_at DESC`
  );
  if (!ps.length) return res.json([]);

  const ids = ps.map((p) => p.id);
  const [{ rows: road }, { rows: bugs }, { rows: weekly }] = await Promise.all([
    q('SELECT project_id, bucket, done FROM roadmap_items WHERE project_id = ANY($1)', [ids]),
    q('SELECT project_id, severity, status FROM bugs WHERE project_id = ANY($1)', [ids]),
    q(
      `SELECT project_id, count(*)::int AS n FROM sessions
        WHERE project_id = ANY($1) AND created_at > now() - interval '7 days'
        GROUP BY project_id`,
      [ids]
    ),
  ]);

  const byProject = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.project_id)) m.set(r.project_id, []);
      m.get(r.project_id).push(r);
    }
    return m;
  };
  const roadByP = byProject(road);
  const bugByP = byProject(bugs);
  const weekByP = new Map(weekly.map((w) => [w.project_id, w.n]));

  res.json(
    ps.map((p) =>
      projectListShape(p, {
        progress: computeProgress(roadByP.get(p.id) || [], bugByP.get(p.id) || []),
        metaLine: metaLineFor(p.last_session_at),
        pushesThisWeek: weekByP.get(p.id) || 0,
      })
    )
  );
});

// POST /api/projects  -> manually create a project (the "New project" modal)
projects.post('/', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 200);
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const subtitle = String(req.body?.subtitle || '').trim().slice(0, 300) || null;
  const status = oneOf(req.body?.status, PROJECT_STATUSES, 'building');

  // Unique slug: append -2, -3, ... if the base is taken.
  const base = slugify(name);
  let slug = base;
  for (let i = 2; ; i++) {
    const exists = await q('SELECT 1 FROM projects WHERE slug = $1', [slug]);
    if (!exists.rows.length) break;
    slug = `${base}-${i}`;
  }

  const { rows: cnt } = await q('SELECT count(*)::int AS n FROM projects');
  const tint = TINTS[cnt[0].n % TINTS.length];

  const { rows } = await q(
    `INSERT INTO projects (slug, name, subtitle, status, tint)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [slug, name, subtitle, status, tint]
  );
  const p = rows[0];
  res.status(201).json(
    projectListShape(p, { progress: 0, metaLine: metaLineFor(p.last_session_at), pushesThisWeek: 0 })
  );
});

// GET /api/projects/deleted  -> the soft-deleted bin (restore / purge targets).
// Registered before /:slug so the literal path wins.
projects.get('/deleted', async (_req, res) => {
  const { rows } = await q(
    'SELECT slug, name, deleted_at FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'
  );
  res.json(rows.map((r) => ({ slug: r.slug, name: r.name, when: relativeTime(r.deleted_at) || 'just now' })));
});

// GET /api/projects/:slug  -> project + activity + collections + progress
projects.get('/:slug', async (req, res) => {
  const { rows } = await q('SELECT * FROM projects WHERE slug = $1 AND deleted_at IS NULL', [req.params.slug]);
  if (!rows.length) return res.status(404).json({ error: 'No such project.' });
  const p = rows[0];

  const appSettings = await readSettings();
  const [sessions, bugs, road, notes, futures, checks, weekly, live] = await Promise.all([
    q(
      // `authored` rides along for resumeSince(): which of these pushes actually
      // wrote the resume card, and what has landed since.
      `SELECT commit_hash, branch, summary, tags, gemini_note, authored, tokens_used, created_at
         FROM sessions
        WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [p.id]
    ),
    q('SELECT * FROM bugs WHERE project_id = $1 ORDER BY created_at DESC', [p.id]),
    q('SELECT * FROM roadmap_items WHERE project_id = $1 ORDER BY bucket, position, created_at', [p.id]),
    q('SELECT * FROM notes WHERE project_id = $1 ORDER BY created_at DESC', [p.id]),
    q('SELECT * FROM futures WHERE project_id = $1 ORDER BY created_at DESC', [p.id]),
    q('SELECT * FROM checks WHERE project_id = $1 ORDER BY created_at', [p.id]),
    q(
      `SELECT count(*)::int AS n FROM sessions
        WHERE project_id = $1 AND created_at > now() - interval '7 days'`,
      [p.id]
    ),
    // Live branches back the board's in-progress lock: a claim only dims/locks
    // its item while a session on that lane is actually alive (BUG-2).
    q(
      `SELECT DISTINCT branch FROM presence
        WHERE project_id = $1 AND last_seen_at > now() - interval '${PRESENCE_TTL_MINUTES} minutes'`,
      [p.id]
    ),
  ]);

  res.json(
    projectDetailShape(p, {
      progress: computeProgress(road.rows, bugs.rows),
      metaLine: metaLineFor(p.last_session_at),
      pushesThisWeek: weekly.rows[0].n,
      activity: sessions.rows.map(activityShape),
      bugs: bugs.rows.map(bugShape),
      roadmap: groupRoadmap(road.rows),
      notes: notes.rows.map(noteShape),
      futures: futures.rows.map(futureShape),
      checks: checks.rows.map(checkShape),
      keepResumeCard: appSettings.keep_resume_card,
      sessionDefaults: sessionDefaultLines(appSettings.session_defaults),
      // The parked-item stale threshold (#247) rides the detail payload so the
      // Roadmap tab's Parked view ages items without a second settings fetch.
      staleItemDays: appSettings.stale_item_days,
      liveBranches: live.rows.map((r) => r.branch || 'main'),
      // #278 — the Quality page hides its Gemini surfaces entirely when keyless.
      geminiReady: geminiEnabled(),
      // The resume card's provenance: pushes that landed after the checkpoint
      // that wrote it, so a stale card reads as stale.
      since: resumeSince(sessions.rows),
    })
  );
});

// GET /api/projects/:slug/debrief  -> the per-project RESUME debrief: current
// status plus the last few commits, shown on the terminal screen when "Jump
// back in" drops the owner into a Claude session, so they can resume without
// reconstructing context. NOT the same thing as the autopilot's NIGHT debrief
// (routes/review.js's GET /api/review/ — one night's runs across every
// project); this one is a single project's live resume state. Don't collapse
// the two.
projects.get('/:slug/debrief', async (req, res) => {
  const { rows } = await q('SELECT * FROM projects WHERE slug = $1 AND deleted_at IS NULL', [req.params.slug]);
  if (!rows.length) return res.status(404).json({ error: 'No such project.' });
  const p = rows[0];

  const [bugCounts, bugTop, road, sessions] = await Promise.all([
    q(
      `SELECT count(*) FILTER (WHERE status <> 'fixed')::int AS open,
              count(*) FILTER (WHERE status <> 'fixed' AND severity = 'critical')::int AS critical,
              count(*) FILTER (WHERE status <> 'fixed' AND severity = 'high')::int AS high,
              count(*) FILTER (WHERE status <> 'fixed' AND severity = 'medium')::int AS medium,
              count(*) FILTER (WHERE status <> 'fixed' AND severity = 'low')::int AS low
         FROM bugs WHERE project_id = $1`,
      [p.id]
    ),
    q(
      `SELECT bug_key, title, severity FROM bugs
        WHERE project_id = $1 AND status <> 'fixed'
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at
        LIMIT 3`,
      [p.id]
    ),
    q(
      `SELECT id, title, bucket, tier, claimed_by FROM roadmap_items
        WHERE project_id = $1 AND NOT done AND bucket IN ('must', 'should')
        ORDER BY CASE tier WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 ELSE 4 END,
                 CASE bucket WHEN 'must' THEN 0 WHEN 'should' THEN 1 ELSE 2 END,
                 position
        LIMIT 5`,
      [p.id]
    ),
    q(
      `SELECT commit_hash, branch, summary, tags, gemini_note, tokens_used, created_at
         FROM sessions WHERE project_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [p.id]
    ),
  ]);
  const bc = bugCounts.rows[0];

  res.json({
    slug: p.slug,
    name: p.name,
    status: p.status,
    phase: p.current_phase || '',
    summary: p.summary || '',
    when: relativeTime(p.last_session_at),
    inProgress: Array.isArray(p.in_progress) ? p.in_progress : [],
    nextUp: Array.isArray(p.next_up) ? p.next_up : [],
    blockers: Array.isArray(p.blockers) ? p.blockers : [],
    bugs: {
      open: bc.open,
      critical: bc.critical,
      high: bc.high,
      medium: bc.medium,
      low: bc.low,
      top: bugTop.rows.map((b) => ({ key: b.bug_key, title: b.title, severity: b.severity })),
    },
    roadmap: road.rows.map((r) => ({
      id: r.id,
      title: r.title,
      bucket: r.bucket,
      tier: r.tier || '',
      claimedBy: r.claimed_by || '',
    })),
    commits: sessions.rows.map(activityShape),
  });
});

// Fields the client may PATCH directly on a project.
const PATCHABLE = new Set([
  'name', 'repo', 'repo_url', 'subtitle', 'site_url', 'status', 'pinned', 'automode', 'autopilot_area',
  'current_phase', 'summary', 'next_steps', 'blockers',
  'in_progress', 'next_up', 'working_well', 'tint', 'north_star', 'directives',
  'deploy_platform', 'logs_url', 'tech_stack', 'audit_context',
]);
const JSON_FIELDS = new Set(['next_steps', 'blockers', 'in_progress', 'next_up', 'working_well', 'directives', 'tech_stack']);

// PATCH /api/projects/:slug  -> manual override of live state
projects.patch('/:slug', async (req, res) => {
  const fields = [];
  const values = [];
  let i = 1;
  for (const [key, val] of Object.entries(req.body || {})) {
    if (!PATCHABLE.has(key)) continue;
    if (JSON_FIELDS.has(key)) {
      fields.push(`${key} = $${i}::jsonb`);
      values.push(JSON.stringify(Array.isArray(val) ? val : []));
    } else if (key === 'pinned' || key === 'automode') {
      fields.push(`${key} = $${i}`);
      values.push(Boolean(val));
    } else if (key === 'status') {
      fields.push(`status = $${i}`);
      values.push(oneOf(val, PROJECT_STATUSES, 'building'));
    } else {
      fields.push(`${key} = $${i}`);
      values.push(val === '' ? null : val);
    }
    i++;
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

  values.push(req.params.slug);
  const { rows } = await q(
    `UPDATE projects SET ${fields.join(', ')}, updated_at = now()
      WHERE slug = $${i} AND deleted_at IS NULL RETURNING *`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: 'No such project.' });

  // Return the list shape with fresh progress so the dashboard updates in place.
  const p = rows[0];
  const [road, bugs, weekly] = await Promise.all([
    q('SELECT bucket, done FROM roadmap_items WHERE project_id = $1', [p.id]),
    q('SELECT severity, status FROM bugs WHERE project_id = $1', [p.id]),
    q(
      `SELECT count(*)::int AS n FROM sessions
        WHERE project_id = $1 AND created_at > now() - interval '7 days'`,
      [p.id]
    ),
  ]);
  res.json(
    projectListShape(p, {
      progress: computeProgress(road.rows, bugs.rows),
      metaLine: metaLineFor(p.last_session_at),
      pushesThisWeek: weekly.rows[0].n,
    })
  );
});

// POST /api/projects/:slug/share  -> enable the public showcase (mint a token).
// Idempotent-ish: re-posting rotates the token, invalidating the old link.
projects.post('/:slug/share', async (req, res) => {
  const token = randomBytes(12).toString('base64url');
  const { rows } = await q(
    'UPDATE projects SET share_token = $1, updated_at = now() WHERE slug = $2 AND deleted_at IS NULL RETURNING slug',
    [token, req.params.slug]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such project.' });
  res.json({ shareToken: token });
});

// DELETE /api/projects/:slug/share  -> disable the showcase (kill the link)
projects.delete('/:slug/share', async (req, res) => {
  const { rowCount } = await q(
    'UPDATE projects SET share_token = NULL, updated_at = now() WHERE slug = $1',
    [req.params.slug]
  );
  if (!rowCount) return res.status(404).json({ error: 'No such project.' });
  res.json({ ok: true });
});

// POST /api/projects/:slug/restore  -> bring a soft-deleted project back whole
projects.post('/:slug/restore', async (req, res) => {
  const { rowCount } = await q(
    'UPDATE projects SET deleted_at = NULL, updated_at = now() WHERE slug = $1 AND deleted_at IS NOT NULL',
    [req.params.slug]
  );
  if (!rowCount) return res.status(404).json({ error: 'No such deleted project.' });
  res.json({ ok: true });
});

// DELETE /api/projects/:slug/purge  -> the real delete (cascades) — only for
// projects already in the bin, so a purge is always a deliberate second step.
projects.delete('/:slug/purge', async (req, res) => {
  const { rowCount } = await q(
    'DELETE FROM projects WHERE slug = $1 AND deleted_at IS NOT NULL',
    [req.params.slug]
  );
  if (!rowCount) return res.status(404).json({ error: 'No such deleted project.' });
  res.json({ ok: true });
});

// DELETE /api/projects/:slug  -> soft delete: stamp deleted_at, kill any share
// link, keep every row. Restore/purge live in Settings.
projects.delete('/:slug', async (req, res) => {
  const { rowCount } = await q(
    'UPDATE projects SET deleted_at = now(), share_token = NULL WHERE slug = $1 AND deleted_at IS NULL',
    [req.params.slug]
  );
  if (!rowCount) return res.status(404).json({ error: 'No such project.' });
  res.json({ ok: true });
});
