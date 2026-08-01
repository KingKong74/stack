import { Router } from 'express';
import { q } from '../db.js';
import { relativeTime, STALE_DAYS, PRESENCE_TTL_MINUTES } from '../util.js';
import { readSettings } from '../settings.js';
import { resumeSince } from '../shape.js';

// GET /api/overview — the cross-project command deck, computed server-side in a
// handful of aggregate queries (never one request per project).
//
// Response shape:
// {
//   resume: { slug, name, tint, summary, currentPhase, when,
//             inProgress[], nextUp[], workingWell[],
//             // null = current; else the pushes since the checkpoint that wrote it
//             since: { authoredWhen, count, hash, branch, when, summary } | null } | null,
//   keepResumeCard: true,    // false hides the resume hero (settings)
//   presence: [ { slug, name, count, branches[], seen } ],   // live sessions right now
//   claims:   [ { slug, name, branch, title, id } ],         // open branch-claimed roadmap items
//   blockers: [ { slug, name, text } ],
//   stale:    [ { slug, name, since } ],
//   review:   { total, items: [ { kind: 'bug'|'roadmap'|'future', slug, name, id, title, meta, when } ] },
//   bugs:     { total, projects: [ { slug, name, count } ],
//               open: [ { slug, name, key, title, severity, status, when, linkRef } ],   // the rows
//               byProject: [ { slug, name, serious, open } ] },                          // every project
//   roadmap:  { closedThisWeek, buckets: [ { bucket, open, items: [ … ] } ] }, // cross-project MoSCoW
//   activity: [ { slug, name, hash, branch, summary, tags[], when } ],
//   totals:   { byStatus: { live, building, paused, archived },
//               openBugs, pushesThisWeek, pushesToday,
//               projectsTouchedThisWeek, roadmapClosedThisWeek, bugsFixedThisWeek }
// }
export const overview = Router();

const asList = (v) => (Array.isArray(v) ? v : []);
const ms = (ts) => (ts ? new Date(ts).getTime() : -1);

overview.get('/', async (_req, res) => {
  const appSettings = await readSettings();

  // Aggregate queries, run together — no per-project fan-out.
  const [projectsR, bugsR, recentR, weekR, reviewR, presenceR, claimsR, graphR, runsR,
         bugRowsR, roadR, closedR] = await Promise.all([
    q(`SELECT id, slug, name, tint, status, summary, current_phase,
              in_progress, next_up, working_well, blockers, last_session_at, updated_at
         FROM projects WHERE deleted_at IS NULL`),
    q(`SELECT project_id,
              count(*) FILTER (WHERE severity IN ('critical','high') AND status <> 'fixed')::int AS serious,
              count(*) FILTER (WHERE status <> 'fixed')::int AS open_all
         FROM bugs GROUP BY project_id`),
    q(`SELECT project_id, commit_hash, branch, summary, tags, gemini_note, created_at
         FROM sessions ORDER BY created_at DESC LIMIT 12`),
    // One pass over the week's pushes: the count, how many projects they touched
    // and how many landed today (the sub-nav's live strip reads the last one).
    q(`SELECT count(*)::int AS n,
              count(DISTINCT s.project_id)::int AS projects,
              count(*) FILTER (WHERE s.created_at >= date_trunc('day', now()))::int AS today
         FROM sessions s
         JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
        WHERE s.created_at > now() - interval '7 days'`),
    // The review inbox: auto-extracted items no human has looked at yet.
    // `batch` clusters one ingest's extractions (same push, same minute) so
    // the deck can group them as a session (#140).
    q(`SELECT 'bug' AS kind, project_id, bug_key AS ref, title, severity AS meta, created_at,
              to_char(date_trunc('minute', created_at), 'YYYY-MM-DD HH24:MI') AS batch
         FROM bugs WHERE source = 'hook' AND reviewed_at IS NULL
       UNION ALL
       SELECT 'roadmap', project_id, id::text, title, bucket, created_at,
              to_char(date_trunc('minute', created_at), 'YYYY-MM-DD HH24:MI')
         FROM roadmap_items WHERE source = 'hook' AND reviewed_at IS NULL AND NOT done
       UNION ALL
       SELECT 'future', project_id, id::text, title, 'idea', created_at,
              to_char(date_trunc('minute', created_at), 'YYYY-MM-DD HH24:MI')
         FROM futures WHERE source = 'hook' AND reviewed_at IS NULL
       ORDER BY created_at DESC`),
    // Live sessions: presence pings still inside the TTL window.
    q(`SELECT project_id, branch, last_seen_at FROM presence
        WHERE last_seen_at > now() - interval '${PRESENCE_TTL_MINUTES} minutes'
        ORDER BY last_seen_at DESC`),
    // Open branch-claimed roadmap items — which branches hold what, across everything.
    q(`SELECT project_id, id, title, claimed_by FROM roadmap_items
        WHERE claimed_by IS NOT NULL AND NOT done
        ORDER BY updated_at DESC LIMIT 10`),
    // A year of daily push counts — the deck's contribution strip.
    q(`SELECT to_char(s.created_at, 'YYYY-MM-DD') AS d, count(*)::int AS n
         FROM sessions s JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
        WHERE s.created_at > now() - interval '371 days'
        GROUP BY 1`),
    // Last night's autopilot runs — the morning digest card. 20h keeps one
    // night in view through the whole next day without dragging in the last.
    // (#266) A fanned night is now N rows for one project, not one — a silent
    // slice at 12 would drop part of a night while looking complete, so this
    // is raised to 40.
    q(`SELECT r.*, p.slug, p.name,
              to_char(COALESCE(r.night_date, (r.finished_at AT TIME ZONE 'UTC')::date), 'YYYY-MM-DD') AS night_key
        FROM autopilot_runs r
        JOIN projects p ON p.id = r.project_id AND p.deleted_at IS NULL
       WHERE r.finished_at > now() - interval '20 hours'
       ORDER BY r.finished_at DESC LIMIT 40`),
    // The serious bugs themselves, not just their count — the dashboard's Audit
    // section lists rows across every project, worst severity first.
    q(`SELECT b.project_id, b.bug_key, b.title, b.severity, b.status, b.link_ref, b.created_at
         FROM bugs b JOIN projects p ON p.id = b.project_id AND p.deleted_at IS NULL
        WHERE b.status <> 'fixed'
        ORDER BY CASE b.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                                 WHEN 'medium' THEN 2 ELSE 3 END,
                 b.created_at DESC
        LIMIT 12`),
    // The cross-project MoSCoW rollup. Open, unparked work plus anything closed
    // in the last week (so the board shows movement, not only what's left).
    q(`SELECT r.id, r.project_id, r.bucket, r.title, r.note, r.done, r.source, r.tier,
              r.position, r.claimed_by, r.updated_at
         FROM roadmap_items r
         JOIN projects p ON p.id = r.project_id AND p.deleted_at IS NULL
        WHERE NOT r.skipped
          AND (NOT r.done OR r.updated_at > now() - interval '7 days')`),
    // This week's closures. Both lean on updated_at, which is the only stamp
    // either table carries for "when it changed" — an edit to an already-done
    // item counts too, so read these as movement rather than an exact ledger.
    q(`SELECT
         (SELECT count(*) FROM roadmap_items r
            JOIN projects p ON p.id = r.project_id AND p.deleted_at IS NULL
           WHERE r.done AND r.updated_at > now() - interval '7 days')::int AS roadmap_closed,
         (SELECT count(*) FROM bugs b
            JOIN projects p ON p.id = b.project_id AND p.deleted_at IS NULL
           WHERE b.status = 'fixed' AND b.updated_at > now() - interval '7 days')::int AS bugs_fixed`),
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
  // One targeted follow-up query, and only for the ONE picked project: which of
  // its pushes actually wrote the resume fields, and what has landed since. It
  // can't join the batch above because it needs `pick`, and it can't be read off
  // `recentR` because that list is global and capped. See shape.resumeSince().
  const sinceRows = (appSettings.keep_resume_card && pick)
    ? (await q(
        `SELECT commit_hash, branch, summary, authored, created_at FROM sessions
          WHERE project_id = $1 ORDER BY created_at DESC LIMIT 40`,
        [pick.id]
      )).rows
    : [];
  // The three resume sub-lists ride along so the deck can render the full
  // "pick up where you left off" card, not just its headline.
  const lines = (v, n) => asList(v).map((s) => String(s)).filter(Boolean).slice(0, n);
  const resume = (appSettings.keep_resume_card && pick) ? {
    slug: pick.slug,
    name: pick.name,
    tint: pick.tint || null,
    summary: pick.summary || '',
    currentPhase: pick.current_phase || '',
    when: relativeTime(pick.last_session_at) || '',
    inProgress: lines(pick.in_progress, 4),
    nextUp: lines(pick.next_up, 4),
    workingWell: lines(pick.working_well, 4),
    // null = the card is current; otherwise the pushes that landed after the
    // checkpoint that wrote it, newest one included.
    since: resumeSince(sinceRows),
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

  // claims: open branch-claimed items, flat, tagged with their project.
  const claims = claimsR.rows.flatMap((r) => {
    const p = byId.get(r.project_id);
    return p ? [{ slug: p.slug, name: p.name, branch: r.claimed_by, title: r.title, id: String(r.id) }] : [];
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
  // (absent from byId) are dropped. The cap is generous now the deck renders
  // collapsed session groups (#140), not a flat list.
  const REVIEW_CAP = 40;
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
        batch: r.batch, // one ingest's extractions share it — the group key
      };
    }),
  };

  // bugs: cross-project critical/high open count + per-project breakdown.
  let seriousTotal = 0;
  let openBugs = 0;
  const bugProjects = [];
  const bugsByProject = [];
  for (const r of bugsR.rows) {
    if (!byId.has(r.project_id)) continue; // soft-deleted project
    openBugs += r.open_all;
    const p = byId.get(r.project_id);
    // Every project with bugs on the books — the dashboard's per-app health
    // panel needs the quiet ones too, not only the ones with something serious.
    bugsByProject.push({ slug: p.slug, name: p.name, serious: r.serious, open: r.open_all });
    if (r.serious > 0) {
      seriousTotal += r.serious;
      bugProjects.push({ slug: p.slug, name: p.name, count: r.serious });
    }
  }
  bugProjects.sort((a, b) => b.count - a.count);

  // The open bugs themselves, worst first (already ordered by the query).
  const openBugRows = bugRowsR.rows.flatMap((r) => {
    const p = byId.get(r.project_id);
    return p ? [{
      slug: p.slug,
      name: p.name,
      key: r.bug_key,
      title: r.title,
      severity: r.severity,
      status: r.status,
      linkRef: r.link_ref || '',
      when: relativeTime(r.created_at) || 'just now',
    }] : [];
  });

  // The cross-project MoSCoW rollup. Within a bucket the order mirrors the run
  // queue — desire tier first, then board position — so the column reads as
  // what would actually be worked next; done items sink to the bottom.
  const BUCKETS = ['must', 'should', 'could', 'wont'];
  const ROLLUP_CAP = 6;
  const tierRank = (t) => ({ S: 0, A: 1, B: 2, C: 3 }[t] ?? 4);
  const roadRows = roadR.rows.filter((r) => byId.has(r.project_id));
  const roadmapBuckets = BUCKETS.map((bucket) => {
    const inBucket = roadRows.filter((r) => r.bucket === bucket);
    const ordered = [...inBucket].sort((a, b) =>
      Number(a.done) - Number(b.done)
      || tierRank(a.tier) - tierRank(b.tier)
      || (a.position - b.position)
      || (a.id - b.id));
    return {
      bucket,
      open: inBucket.filter((r) => !r.done).length,
      items: ordered.slice(0, ROLLUP_CAP).map((r) => {
        const p = byId.get(r.project_id);
        return {
          slug: p.slug,
          name: p.name,
          id: String(r.id),
          title: r.title,
          note: r.note || '',
          done: !!r.done,
          auto: r.source === 'hook',
          claimedBy: r.claimed_by || '',
        };
      }),
    };
  });

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

  // (#266) Make the digest read as ONE night: within the rolling 20h window,
  // keep only rows from the most recent night_date, PLUS every row with no
  // night_date at all. That NULL passthrough is deliberate — historical rows
  // and non-night runs (a manual press, a scheduled session) have no night to
  // belong to and keep appearing exactly as they do today; without it, one
  // fanned night would hide them. Compared as raw Date values (not strings)
  // so nothing shifts a day with the server's timezone.
  const maxNightDate = runsR.rows.reduce((max, r) => {
    if (!r.night_date) return max;
    const t = new Date(r.night_date).getTime();
    return max === null || t > max ? t : max;
  }, null);
  const digestRuns = runsR.rows.filter((r) =>
    r.night_date == null || new Date(r.night_date).getTime() === maxNightDate);

  // last night's autopilot, per item — the deck's morning digest ([] = quiet night)
  const autopilotRuns = digestRuns.map((r) => ({
    slug: r.slug,
    name: r.name,
    itemId: r.item_id,
    itemTitle: r.item_title || '',
    branch: r.branch || '',
    outcome: r.outcome,
    commits: r.commits,
    tokens: Number(r.tokens) || 0,
    summary: r.summary || '',
    day: r.night_key,
    when: relativeTime(r.finished_at) || 'just now',
  }));

  res.json({
    resume,
    keepResumeCard: appSettings.keep_resume_card,
    presence: livePresence,
    claims,
    blockers,
    stale,
    review,
    bugs: { total: seriousTotal, projects: bugProjects, open: openBugRows, byProject: bugsByProject },
    roadmap: { closedThisWeek: closedR.rows[0].roadmap_closed, buckets: roadmapBuckets },
    activity,
    autopilotRuns,
    graph: graphR.rows.map((r) => ({ date: r.d, count: r.n })),
    totals: {
      byStatus,
      openBugs,
      pushesThisWeek: weekR.rows[0].n,
      pushesToday: weekR.rows[0].today,
      projectsTouchedThisWeek: weekR.rows[0].projects,
      roadmapClosedThisWeek: closedR.rows[0].roadmap_closed,
      bugsFixedThisWeek: closedR.rows[0].bugs_fixed,
    },
  });
});
