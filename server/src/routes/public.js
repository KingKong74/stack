import { Router } from 'express';
import { q } from '../db.js';
import { computeProgress, relativeTime } from '../util.js';
import { activityShape } from '../shape.js';

// GET /api/public/:slug/:token — the tokenless showcase view. Mounted WITHOUT
// bearer auth (like /api/health), so it must stay strictly read-only and
// strictly limited: project basics + progress + the resume summary + recent
// activity. No bugs, roadmap, notes, futures, directives, blockers or north
// star — those are the owner's workbench, not the shop window.
export const publicShowcase = Router();

publicShowcase.get('/:slug/:token', async (req, res) => {
  const { rows } = await q('SELECT * FROM projects WHERE slug = $1 AND deleted_at IS NULL', [req.params.slug]);
  const p = rows[0];
  // One 404 for both unknown slug and wrong/absent token — don't leak which.
  if (!p || !p.share_token || p.share_token !== req.params.token) {
    return res.status(404).json({ error: 'No such showcase.' });
  }

  const [sessions, road, bugs] = await Promise.all([
    q(
      `SELECT commit_hash, branch, summary, tags, created_at FROM sessions
        WHERE project_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [p.id]
    ),
    q('SELECT bucket, done FROM roadmap_items WHERE project_id = $1', [p.id]),
    q('SELECT severity, status FROM bugs WHERE project_id = $1', [p.id]),
  ]);

  res.json({
    name: p.name,
    subtitle: p.subtitle || '',
    status: p.status,
    tint: p.tint,
    siteUrl: p.site_url || '',
    progress: computeProgress(road.rows, bugs.rows),
    summary: p.summary || '',
    currentPhase: p.current_phase || '',
    techStack: Array.isArray(p.tech_stack) ? p.tech_stack : [],
    lastPush: relativeTime(p.last_session_at) || '',
    activity: sessions.rows.map(activityShape),
  });
});
