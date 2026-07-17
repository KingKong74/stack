import { Router } from 'express';
import { q } from '../db.js';
import { relativeTime, STALE_DAYS, PRESENCE_TTL_MINUTES } from '../util.js';
import { readSettings } from '../settings.js';

// GET /api/overview — the cross-project command deck, computed server-side in a
// handful of aggregate queries (never one request per project).
//
// Response shape:
// {
//   resume: { slug, name, tint, summary, currentPhase, nextUp[] } | null,
//   keepResumeCard: true,    // false hides the resume hero (settings)
//   presence: [ { slug, name, count, branches[], seen } ],   // live sessions right now
//   claims:   [ { slug, name, lane, title, id } ],           // open lane-claimed roadmap items
//   blockers: [ { slug, name, text } ],
//   stale:    [ { slug, name, since } ],
//   review:   { total, items: [ { kind: 'bug'|'roadmap'|'future', slug, name, id, title, meta, when } ] },
//   bugs:     { total, projects: [ { slug, name, count } ] },
//   activity: [ { slug, name, hash, branch, summary, tags[], when } ],
//   totals:   { byStatus: { live, building, paused, archived },
//               openBugs, pushesThisWeek }
// }
export const overview = Router();

const asList = (v) => (Array.isArray(v) ? v : []);
const ms = (ts) => (ts ? new Date(ts).getTime() : -1);

overview.get('/', async (_req, res) => {
  const appSettings = await readSettings();

  // Seven aggregate queries, run together — no per-project fan-out.
  const [projectsR, bugsR, recentR, weekR, reviewR, presenceR, claimsR, graphR] = await Promise.all([
    q(`SELECT id, slug, name, tint, status, summary, current_phase,
              next_up, blockers, last_session_at, updated_at
         FROM projects WHERE deleted_at IS NULL`),
    q(`SELECT project_id,
              count(*) FILTER (WHERE severity IN ('critical','high') AND status <> 'fixed')::int AS serious,
              count(*) FILTER (WHERE status <> 'fixed')::int AS open_all
         FROM bugs GROUP BY project_id`),
    q(`SELECT project_id, commit_hash, branch, summary, tags, gemini_note, created_at
         FROM sessions ORDER BY created_at DESC LIMIT 12`),
    q(`SELECT count(*)::int AS n FROM sessions s
        JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
       WHERE s.created_at > now() - interval '7 days'`),
    // The review inbox: auto-extracted items no human has looked at yet.
    q(`SELECT 'bug' AS kind, project_id, bug_key AS ref, title, severity AS meta, created_at
         FROM bugs WHERE source = 'hook' AND reviewed_at IS NULL
       UNION ALL
       SELECT 'roadmap', project_id, id::text, title, bucket, created_at
         FROM roadmap_items WHERE source = 'hook' AND reviewed_at IS NULL
       UNION ALL
       SELECT 'future', project_id, id::text, title, 'idea', created_at
         FROM futures WHERE source = 'hook' AND reviewed_at IS NULL
       ORDER BY created_at DESC`),
    // Live sessions: presence pings still inside the TTL window.
    q(`SELECT project_id, branch, last_seen_at FROM presence
        WHERE last_seen_at > now() - interval '${PRESENCE_TTL_MINUTES} minutes'
        ORDER BY last_seen_at DESC`),
    // Open lane-claimed roadmap items — which lanes hold what, across everything.
    q(`SELECT project_id, id, title, claimed_by FROM roadmap_items
        WHERE claimed_by IS NOT NULL AND NOT done
        ORDER BY updated_at DESC LIMIT 10`),
    // A year of daily push counts — the deck's contribution strip.
    q(`SELECT to_char(s.created_at, 'YYYY-MM-DD') AS d, count(*)::int AS n
         FROM sessions s JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
        WHERE s.created_at > now() - interval '371 days'
        GROUP BY 1`),
  ]);

  const projects = projectsR.rows;
  const byId = new Map(projects.map((p) => [p.id, p]));
  const isActive = (p) => p.status === 'live' || p.status === 'building';

  // Most-recently-touched first (recency, not pin order); updated_at breaks ties.
  const sorted = [...projects].sort((a, b) =>
    ms(b.last_session_at) - ms(a.last_session_at) || ms(b.updated_at) - ms(a.updated_at));

  // resume: most-recent active project, else most-recent of any status. When
  // keep_resume_card is off the hero is hidden cleanly (resume = null and the
  // flag below lets the deck skip the block entirely).
  const pick = sorted.find(isActive) || sorted[0] || null;
  const resume = (appSettings.keep_resume_card && pick) ? {
    slug: pick.slug,
    name: pick.name,
    tint: pick.tint || null,
    summary: pick.summary || '',
    currentPhase: pick.current_phase || '',
    nextUp: asList(pick.next_up).map((s) => String(s)).slice(0, 3),
  } : null;

  // presence: live sessions grouped per project, most recently seen first.
  const liveByProject = new Map();
  for (const r of presenceR.rows) {
    const p = byId.get(r.project_id);
    if (!p) continue;
    if (!liveByProject.has(r.project_id)) {
      liveByProject.set(r.project_id, { slug: p.slug, name: p.name, count: 0, branches: [], seen: relativeTime(r.last_seen_at) || 'just now' });
    }
    const entry = liveByProject.get(r.project_id);
    entry.count++;
    const branch = r.branch || 'main';
    if (!entry.branches.includes(branch)) entry.branches.push(branch);
  }
  const livePresence = [...liveByProject.values()];

  // claims: open lane-claimed items, flat, tagged with their project.
  const claims = claimsR.rows.flatMap((r) => {
    const p = byId.get(r.project_id);
    return p ? [{ slug: p.slug, name: p.name, lane: r.claimed_by, title: r.title, id: String(r.id) }] : [];
  });

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

  // review: the needs-review queue, newest first, capped for the deck (total
  // still reflects everything outstanding). Rows from soft-deleted projects
  // (absent from byId) are dropped.
  const REVIEW_CAP = 8;
  const reviewRows = reviewR.rows.filter((r) => byId.has(r.project_id));
  const review = {
    total: reviewRows.length,
    items: reviewRows.slice(0, REVIEW_CAP).map((r) => {
      const p = byId.get(r.project_id);
      return {
        kind: r.kind,
        slug: p ? p.slug : '',
        name: p ? p.name : '(removed)',
        id: r.ref,
        title: r.title,
        meta: r.meta,
        when: relativeTime(r.created_at) || 'just now',
      };
    }),
  };

  // bugs: cross-project critical/high open count + per-project breakdown.
  let seriousTotal = 0;
  let openBugs = 0;
  const bugProjects = [];
  for (const r of bugsR.rows) {
    if (!byId.has(r.project_id)) continue; // soft-deleted project
    openBugs += r.open_all;
    if (r.serious > 0) {
      seriousTotal += r.serious;
      const p = byId.get(r.project_id);
      if (p) bugProjects.push({ slug: p.slug, name: p.name, count: r.serious });
    }
  }
  bugProjects.sort((a, b) => b.count - a.count);

  // activity: merged recent checkpoints, newest first (already ordered by the
  // query); soft-deleted projects' pushes are dropped.
  const activity = recentR.rows.filter((s) => byId.has(s.project_id)).map((s) => {
    const p = byId.get(s.project_id);
    return {
      slug: p ? p.slug : '',
      name: p ? p.name : '(removed)',
      hash: s.commit_hash || '—',
      branch: s.branch || 'main',
      summary: s.summary || '',
      tags: asList(s.tags),
      geminiNote: s.gemini_note || '',
      when: relativeTime(s.created_at) || 'just now',
    };
  });

  // totals
  const byStatus = { live: 0, building: 0, paused: 0, archived: 0 };
  for (const p of projects) if (byStatus[p.status] !== undefined) byStatus[p.status]++;

  res.json({
    resume,
    keepResumeCard: appSettings.keep_resume_card,
    presence: livePresence,
    claims,
    blockers,
    stale,
    review,
    bugs: { total: seriousTotal, projects: bugProjects },
    activity,
    graph: graphR.rows.map((r) => ({ date: r.d, count: r.n })),
    totals: { byStatus, openBugs, pushesThisWeek: weekR.rows[0].n },
  });
});
