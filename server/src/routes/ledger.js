import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { PRESENCE_TTL_MINUTES } from '../util.js';
import { ledgerSessionShape } from '../shape.js';
import { runShape } from './autopilot.js';

// Mounted at /api/projects/:slug/ledger — the Development tab's audit trail.
// Two populations, one timeline: interactive Claude Code sessions (`sessions`,
// written by the hooks and /checkpoint) and unattended runs (`autopilot_runs`).
// Each entry keeps its own spend; the route never sums the two (root
// CLAUDE.md: spend is two populations that never mix).
//
// `now` is what is happening as of this read: sessions whose hook pinged
// within PRESENCE_TTL_MINUTES, and autopilot jobs not yet finished. Presence is
// a heartbeat, so a session that died without its end hook stays "live" until
// the TTL lapses; the client shows the last ping rather than claiming more.
//
// Paged by `before` (an ISO stamp): each table is read up to `limit` rows
// older than the cursor, merged, and cut to `limit`, so a page is exact even
// when one population is much busier than the other.
export const ledger = Router({ mergeParams: true });

const KINDS = ['session', 'run'];
const OPEN_JOBS = ['queued', 'claimed', 'running', 'paused'];

ledger.get('/', async (req, res) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(req.query.limit)) || 40));
  const before = req.query.before && !Number.isNaN(Date.parse(req.query.before))
    ? new Date(req.query.before).toISOString() : null;
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : '';

  const [sessions, runs, live, jobs] = await Promise.all([
    kind === 'run' ? { rows: [] } : q(
      `SELECT * FROM sessions WHERE project_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
        ORDER BY created_at DESC LIMIT $3`, [project.id, before, limit]),
    kind === 'session' ? { rows: [] } : q(
      `SELECT * FROM autopilot_runs WHERE project_id = $1 AND ($2::timestamptz IS NULL OR finished_at < $2)
        ORDER BY finished_at DESC LIMIT $3`, [project.id, before, limit]),
    // Only the first page carries `now`; a scroll back through history is
    // not a reason to re-read what is live.
    before ? { rows: [] } : q(
      `SELECT session_id, branch, cwd, started_at, last_seen_at FROM presence
        WHERE project_id = $1 AND last_seen_at > now() - interval '${PRESENCE_TTL_MINUTES} minutes'
        ORDER BY last_seen_at DESC`, [project.id]),
    before ? { rows: [] } : q(
      `SELECT j.id, j.kind, j.item_id, j.status, j.detail, j.branch, j.created_at, j.started_at,
              r.title AS item_title
         FROM autopilot_jobs j LEFT JOIN roadmap_items r ON r.id = j.item_id
        WHERE j.project_id = $1 AND j.status = ANY($2::text[])
        ORDER BY j.created_at DESC LIMIT 20`, [project.id, OPEN_JOBS]),
  ]);

  const entries = [
    ...sessions.rows.map(ledgerSessionShape),
    ...runs.rows.map((r) => ({
      ...runShape(r),
      kind: 'run',
      at: r.finished_at ? new Date(r.finished_at).toISOString() : '',
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);

  const iso = (v) => (v ? new Date(v).toISOString() : null);
  res.json({
    entries,
    nextBefore: entries.length === limit ? entries[entries.length - 1].at : null,
    now: before ? null : {
      sessions: live.rows.map((p) => ({
        sessionId: p.session_id || '', branch: p.branch || '', cwd: p.cwd || '',
        startedAt: iso(p.started_at), lastSeenAt: iso(p.last_seen_at),
      })),
      jobs: jobs.rows.map((j) => ({
        id: Number(j.id), kind: j.kind, itemId: j.item_id === null ? null : Number(j.item_id),
        itemTitle: j.item_title || '', status: j.status, detail: j.detail || '', branch: j.branch || '',
        createdAt: iso(j.created_at), startedAt: iso(j.started_at),
      })),
    },
  });
});
