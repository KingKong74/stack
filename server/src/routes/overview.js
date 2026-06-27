import { Router } from 'express';
import { q } from '../db.js';
import { relativeTime, STALE_DAYS } from '../util.js';

// GET /api/overview — the cross-project command deck, computed server-side in a
// handful of aggregate queries (never one request per project).
//
// Response shape:
// {
//   resume: { slug, name, tint, summary, currentPhase, nextUp[] } | null,
//   blockers: [ { slug, name, text } ],
//   stale:    [ { slug, name, since } ],
//   bugs:     { total, projects: [ { slug, name, count } ] },
//   activity: [ { slug, name, hash, branch, summary, tags[], when } ],
//   totals:   { byStatus: { live, building, paused, archived },
//               openBugs, pushesThisWeek }
// }
export const overview = Router();

const asList = (v) => (Array.isArray(v) ? v : []);
const ms = (ts) => (ts ? new Date(ts).getTime() : -1);

overview.get('/', async (_req, res) => {
  // Four aggregate queries, run together — no per-project fan-out.
  const [projectsR, bugsR, recentR, weekR] = await Promise.all([
    q(`SELECT id, slug, name, tint, status, summary, current_phase,
              next_up, blockers, last_session_at, updated_at
         FROM projects`),
    q(`SELECT project_id,
              count(*) FILTER (WHERE severity IN ('critical','high') AND status <> 'fixed')::int AS serious,
              count(*) FILTER (WHERE status <> 'fixed')::int AS open_all
         FROM bugs GROUP BY project_id`),
    q(`SELECT project_id, commit_hash, branch, summary, tags, created_at
         FROM sessions ORDER BY created_at DESC LIMIT 12`),
    q(`SELECT count(*)::int AS n FROM sessions WHERE created_at > now() - interval '7 days'`),
  ]);

  const projects = projectsR.rows;
  const byId = new Map(projects.map((p) => [p.id, p]));
  const isActive = (p) => p.status === 'live' || p.status === 'building';

  // Most-recently-touched first (recency, not pin order); updated_at breaks ties.
  const sorted = [...projects].sort((a, b) =>
    ms(b.last_session_at) - ms(a.last_session_at) || ms(b.updated_at) - ms(a.updated_at));

  // resume: most-recent active project, else most-recent of any status.
  const pick = sorted.find(isActive) || sorted[0] || null;
  const resume = pick ? {
    slug: pick.slug,
    name: pick.name,
    tint: pick.tint || null,
    summary: pick.summary || '',
    currentPhase: pick.current_phase || '',
    nextUp: asList(pick.next_up).map((s) => String(s)).slice(0, 3),
  } : null;

  // blockers: every stored blocker line, flat, tagged with its project.
  const blockers = [];
  for (const p of sorted) {
    for (const line of asList(p.blockers)) {
      const text = String(line).trim();
      if (text) blockers.push({ slug: p.slug, name: p.name, text });
    }
  }

  // stale: active projects whose last push is older than STALE_DAYS.
  const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
  const stale = sorted
    .filter((p) => isActive(p) && p.last_session_at && ms(p.last_session_at) < cutoff)
    .map((p) => ({ slug: p.slug, name: p.name, since: relativeTime(p.last_session_at) }));

  // bugs: cross-project critical/high open count + per-project breakdown.
  let seriousTotal = 0;
  let openBugs = 0;
  const bugProjects = [];
  for (const r of bugsR.rows) {
    openBugs += r.open_all;
    if (r.serious > 0) {
      seriousTotal += r.serious;
      const p = byId.get(r.project_id);
      if (p) bugProjects.push({ slug: p.slug, name: p.name, count: r.serious });
    }
  }
  bugProjects.sort((a, b) => b.count - a.count);

  // activity: merged recent checkpoints, newest first (already ordered by the query).
  const activity = recentR.rows.map((s) => {
    const p = byId.get(s.project_id);
    return {
      slug: p ? p.slug : '',
      name: p ? p.name : '(removed)',
      hash: s.commit_hash || '—',
      branch: s.branch || 'main',
      summary: s.summary || '',
      tags: asList(s.tags),
      when: relativeTime(s.created_at) || 'just now',
    };
  });

  // totals
  const byStatus = { live: 0, building: 0, paused: 0, archived: 0 };
  for (const p of projects) if (byStatus[p.status] !== undefined) byStatus[p.status]++;

  res.json({
    resume,
    blockers,
    stale,
    bugs: { total: seriousTotal, projects: bugProjects },
    activity,
    totals: { byStatus, openBugs, pushesThisWeek: weekR.rows[0].n },
  });
});
