import { Router } from 'express';
import { q } from '../db.js';
import { relativeTime, computeProgress, PRESENCE_TTL_MINUTES } from '../util.js';
import { readSettings } from '../settings.js';
import { termAgentConnected, termSessions } from '../term.js';
import { scheduleShapeRows, jobShapeRows } from './autopilot.js';

// GET /api/control — Mission Control: every project's automation state in one
// payload, computed in aggregate queries (never one request per project).
//
// Response shape:
// {
//   autopilot: { enabled, minutes },        // the global arm switch + session cap
//   projects: [ {
//     slug, name, tint, status, automode, progress, lastPush,
//     live: { count, branches[] } | null,   // presence inside the TTL window
//     claims: [ { id, title, lane } ],      // open lane-claimed items
//     reviewCount,                          // hook items awaiting review
//     bugs: { serious, open },
//     blockers: [ "…" ],
//     nextPick: { id, bucket, title } | null,  // what the autopilot would pick tonight
//     lastAuto: { branch, summary, when } | null // most recent auto/* push
//   } ],
//   totals: { automode, liveSessions, claims, review }
// }
export const control = Router();

const asList = (v) => (Array.isArray(v) ? v : []);
const ms = (ts) => (ts ? new Date(ts).getTime() : -1);

control.get('/', async (_req, res) => {
  const appSettings = await readSettings();

  const [projectsR, roadR, bugsR, reviewR, presenceR, autoR, schedR, jobsR] = await Promise.all([
    q(`SELECT id, slug, name, tint, status, automode, autopilot_area, blockers, last_session_at, updated_at
         FROM projects WHERE deleted_at IS NULL`),
    q(`SELECT project_id, id, bucket, title, done, skipped, claimed_by, source,
              reviewed_at, position, created_at, area
         FROM roadmap_items WHERE bucket IN ('must','should') OR claimed_by IS NOT NULL`),
    q(`SELECT project_id,
              count(*) FILTER (WHERE severity IN ('critical','high') AND status <> 'fixed')::int AS serious,
              count(*) FILTER (WHERE status <> 'fixed')::int AS open_all
         FROM bugs GROUP BY project_id`),
    q(`SELECT project_id, count(*)::int AS n FROM (
         SELECT project_id FROM bugs WHERE source = 'hook' AND reviewed_at IS NULL
         UNION ALL
         SELECT project_id FROM roadmap_items WHERE source = 'hook' AND reviewed_at IS NULL
         UNION ALL
         SELECT project_id FROM futures WHERE source = 'hook' AND reviewed_at IS NULL
       ) r GROUP BY project_id`),
    q(`SELECT project_id, branch, last_seen_at FROM presence
        WHERE last_seen_at > now() - interval '${PRESENCE_TTL_MINUTES} minutes'
        ORDER BY last_seen_at DESC`),
    // The most recent autopilot push per project (auto/* is the runner's lane).
    q(`SELECT DISTINCT ON (project_id) project_id, branch, summary, created_at
         FROM sessions WHERE branch LIKE 'auto/%'
        ORDER BY project_id, created_at DESC`),
    // The calendar + the job queue (recent jobs cover the "what happened" strip).
    q(`SELECT s.*, p.slug, p.name AS project_name, p.tint, ri.title AS item_title
         FROM autopilot_schedule s
         JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
         LEFT JOIN roadmap_items ri ON ri.id = s.item_id
        ORDER BY s.enabled DESC, s.at_time, s.id`),
    q(`SELECT j.*, p.slug, p.name AS project_name, ri.title AS item_title
         FROM autopilot_jobs j
         JOIN projects p ON p.id = j.project_id AND p.deleted_at IS NULL
         LEFT JOIN roadmap_items ri ON ri.id = j.item_id
        ORDER BY j.created_at DESC LIMIT 12`),
  ]);

  const roadByP = new Map();
  for (const r of roadR.rows) {
    if (!roadByP.has(r.project_id)) roadByP.set(r.project_id, []);
    roadByP.get(r.project_id).push(r);
  }
  const bugsByP = new Map(bugsR.rows.map((r) => [r.project_id, r]));
  const reviewByP = new Map(reviewR.rows.map((r) => [r.project_id, r.n]));
  const autoByP = new Map(autoR.rows.map((r) => [r.project_id, r]));

  const liveByP = new Map();
  for (const r of presenceR.rows) {
    if (!liveByP.has(r.project_id)) liveByP.set(r.project_id, { count: 0, branches: [] });
    const entry = liveByP.get(r.project_id);
    entry.count++;
    const branch = r.branch || 'main';
    if (!entry.branches.includes(branch)) entry.branches.push(branch);
  }

  // Automode projects first, then recency — the screen is about what agents
  // may touch, so opted-in projects lead.
  const sorted = [...projectsR.rows].sort((a, b) =>
    Number(b.automode) - Number(a.automode)
    || ms(b.last_session_at) - ms(a.last_session_at)
    || ms(b.updated_at) - ms(a.updated_at));

  // Mirrors the autopilot's pick: open, unclaimed, not parked, human-approved
  // (manual, or hook-created + reviewed), inside the project's target area when
  // one is set (#122); must before should, then board order.
  const pickFor = (items, area) => {
    const eligible = items
      .filter((it) => !it.done && !it.skipped && !it.claimed_by
        && (it.source === 'manual' || it.reviewed_at)
        && (!area || (it.area || '') === area))
      .sort((a, b) => (a.bucket === b.bucket
        ? (a.position - b.position || ms(a.created_at) - ms(b.created_at))
        : (a.bucket === 'must' ? -1 : 1)));
    return eligible[0] || null;
  };

  const projects = sorted.map((p) => {
    const road = roadByP.get(p.id) || [];
    const bugRow = bugsByP.get(p.id);
    const pick = pickFor(road, p.autopilot_area || '');
    const lastAuto = autoByP.get(p.id);
    return {
      slug: p.slug,
      name: p.name,
      tint: p.tint || null,
      status: p.status,
      automode: !!p.automode,
      autopilotArea: p.autopilot_area || '',
      // Target options: areas carried by this project's open must/should items.
      areas: [...new Set(road.filter((r) => !r.done && r.area).map((r) => r.area))].sort(),
      // The roadmap query only carries must/should (all computeProgress counts);
      // the aggregated serious count stands in for row-level bugs for the cap.
      progress: computeProgress(
        road.map((r) => ({ bucket: r.bucket, done: r.done })),
        bugRow && bugRow.serious > 0 ? [{ severity: 'high', status: 'open' }] : [],
      ),
      lastPush: relativeTime(p.last_session_at) || '',
      live: liveByP.get(p.id) || null,
      claims: road
        .filter((r) => r.claimed_by && !r.done)
        .map((r) => ({ id: String(r.id), title: r.title, lane: r.claimed_by })),
      reviewCount: reviewByP.get(p.id) || 0,
      bugs: { serious: bugRow ? bugRow.serious : 0, open: bugRow ? bugRow.open_all : 0 },
      blockers: asList(p.blockers).map((b) => String(b).trim()).filter(Boolean),
      nextPick: pick ? { id: String(pick.id), bucket: pick.bucket, title: pick.title } : null,
      lastAuto: lastAuto ? {
        branch: lastAuto.branch,
        summary: lastAuto.summary || '',
        when: relativeTime(lastAuto.created_at) || 'just now',
      } : null,
    };
  });

  res.json({
    autopilot: {
      enabled: appSettings.autopilot_enabled,
      minutes: appSettings.autopilot_minutes,
      tokens: appSettings.autopilot_tokens,     // 0 = unlimited
      time: appSettings.autopilot_time,         // host-local HH:MM
      maxItems: appSettings.autopilot_max_items,
    },
    // The host PTY daemon's agent socket + every open web-terminal session
    // (labels are the ✧ Gemini annotations, '' until asked for).
    terminal: { connected: termAgentConnected(), sessions: termSessions() },
    schedules: scheduleShapeRows(schedR.rows),
    jobs: jobShapeRows(jobsR.rows),
    projects,
    totals: {
      automode: projects.filter((p) => p.automode).length,
      liveSessions: presenceR.rows.length,
      claims: projects.reduce((n, p) => n + p.claims.length, 0),
      review: projects.reduce((n, p) => n + p.reviewCount, 0),
    },
  });
});
