import { Router } from 'express';
import { q } from '../db.js';
import { relativeTime, computeProgress, PRESENCE_TTL_MINUTES } from '../util.js';
import { readSettings, EXECUTOR_CATALOGUE, ADVISOR_CATALOGUE } from '../settings.js';
import { termAgentConnected, termSessions, termDetached, termPlanUsage } from '../term.js';
import { scheduleShapeRows, jobShapeRows } from './autopilot.js';

// GET /api/control — Mission Control: every project's automation state in one
// payload, computed in aggregate queries (never one request per project).
//
// Response shape:
// {
//   autopilot: { enabled, minutes },        // the global arm switch + session cap
//   usage: {                                // (#194) 7-day + today token/cost totals
//     weekTokens, weekCostUsd, weekRuns,
//     todayTokens, todayCostUsd,
//     budgetPerRun,                         // echo of settings.autopilot_tokens; 0 = unlimited
//     models: [ { model, tokens, costUsd } ] // per-model agg; '' model = single-model runs
//   },
//   projects: [ {
//     slug, name, tint, status, automode, progress, lastPush,
//     live: { count, branches[] } | null,   // presence inside the TTL window
//     claims: [ { id, title, lane } ],      // open lane-claimed items
//     branches: [ { branch, itemId, itemTitle,      // the merge strip (#154);
//                   ahead?, behind?, mergeClean?,   // git state via the host's
//                   subject?, when? } ],            // branch report (#207)
//     absorbedBranches, branchesWhen,       // prune count + report freshness
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

  const [projectsR, roadR, bugsR, reviewR, presenceR, autoR, schedR, jobsR, usageR, branchR, checksR, monthR] = await Promise.all([
    q(`SELECT id, slug, name, tint, status, automode, autopilot_area, blockers, last_session_at, updated_at
         FROM projects WHERE deleted_at IS NULL`),
    // claimed_by that starts with 'auto/' or 'lane/' is an open lane branch; we
    // also need must/should for progress + pick, so pull everything that's
    // relevant in one query.
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
         SELECT project_id FROM roadmap_items WHERE source = 'hook' AND reviewed_at IS NULL AND NOT done
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
    // Open + paused rows lead so a long-parked hung-up resume (#142) can't be
    // pushed off the strip by newer finished jobs.
    q(`SELECT j.*, p.slug, p.name AS project_name, ri.title AS item_title
         FROM autopilot_jobs j
         JOIN projects p ON p.id = j.project_id AND p.deleted_at IS NULL
         LEFT JOIN roadmap_items ri ON ri.id = j.item_id
        ORDER BY (j.status IN ('queued','claimed','running','paused')) DESC,
                 j.created_at DESC LIMIT 12`),
    // (#194) Usage aggregation — last 7 days of autopilot runs for the weekly
    // summary card. Aggregate in JS to avoid JSONB gymnastics. Rows are tiny.
    // BIGINT/NUMERIC come back as strings from node-postgres; use Number().
    // (#177) item/project identity rides along so the newest rows can double
    // as the per-session agent breakdown — no second query.
    q(`SELECT r.tokens, r.cost_usd, r.model_usage, r.finished_at,
              r.item_id, r.item_title, r.outcome, p.slug, p.name AS project_name
         FROM autopilot_runs r JOIN projects p ON p.id = r.project_id
        WHERE r.finished_at > now() - interval '7 days'
        ORDER BY r.finished_at DESC`),
    // (#207) The host dispatcher's git branch report per project — the merge
    // strip's real state (ahead/behind, conflict probe). Missing rows are fine:
    // the strip falls back to claim-derived chips until the first report lands.
    // ::int so the BIGINT key matches projects.id as a JS number in the Map.
    q(`SELECT project_id::int AS project_id, report, reported_at FROM branch_reports`),
    // (#206) Audit pass rate per project — the checks' stored last results.
    // never-run rows don't count against the rate; zero run rows = no rate.
    q(`SELECT project_id,
              count(*) FILTER (WHERE last_status IS NOT NULL)::int AS run,
              count(*) FILTER (WHERE last_status = 'pass')::int AS passing
         FROM checks GROUP BY project_id`),
    // (#200) Month-to-date rollup across all projects (calendar month, UTC —
    // same convention as every server-side date bucket).
    q(`SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost, count(*)::int AS runs
         FROM autopilot_runs WHERE finished_at >= date_trunc('month', now())`),
  ]);

  const roadByP = new Map();
  for (const r of roadR.rows) {
    if (!roadByP.has(r.project_id)) roadByP.set(r.project_id, []);
    roadByP.get(r.project_id).push(r);
  }
  const bugsByP = new Map(bugsR.rows.map((r) => [r.project_id, r]));
  const reviewByP = new Map(reviewR.rows.map((r) => [r.project_id, r.n]));
  const autoByP = new Map(autoR.rows.map((r) => [r.project_id, r]));
  const branchesByP = new Map(branchR.rows.map((r) => [r.project_id, r]));

  const liveByP = new Map();
  for (const r of presenceR.rows) {
    if (!liveByP.has(r.project_id)) liveByP.set(r.project_id, { count: 0, branches: [] });
    const entry = liveByP.get(r.project_id);
    entry.count++;
    const branch = r.branch || 'main';
    if (!entry.branches.includes(branch)) entry.branches.push(branch);
  }

  // (#194) — aggregate last-7-days usage in JS; model_usage is already parsed
  // as an object by node-postgres. Rows with null model_usage (single-model runs)
  // contribute to an unattributed bucket so the total always reconciles.
  const todayCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let weekTokens = 0, weekCost = 0, todayTokens = 0, todayCost = 0;
  const modelTotals = new Map();
  const nightSet = new Set(); // distinct YYYY-MM-DD dates — the bar denominator
  let unattribTokens = 0, unattribCost = 0;
  for (const r of usageR.rows) {
    const tok = Number(r.tokens || 0);
    const cost = Number(r.cost_usd || 0);
    weekTokens += tok;
    weekCost += cost;
    if (new Date(r.finished_at) > todayCutoff) { todayTokens += tok; todayCost += cost; }
    // Count distinct nights by the UTC calendar date of the finish time
    // (#218: #201 — deliberate: every server-side date bucket uses UTC, so the
    // denominator can't drift with the server's timezone; an AEST night run
    // finishes mid-UTC-day, so nights never split across the UTC midnight).
    nightSet.add(new Date(r.finished_at).toISOString().slice(0, 10));
    if (r.model_usage && typeof r.model_usage === 'object') {
      for (const [model, entry] of Object.entries(r.model_usage)) {
        const t = (Number(entry.inputTokens) || 0) + (Number(entry.outputTokens) || 0)
                + (Number(entry.cacheReadInputTokens) || 0) + (Number(entry.cacheCreationInputTokens) || 0);
        const c = Number(entry.costUSD) || 0;
        if (!modelTotals.has(model)) modelTotals.set(model, { tokens: 0, costUsd: 0 });
        const m = modelTotals.get(model);
        m.tokens += t;
        m.costUsd += c;
      }
    } else {
      unattribTokens += tok;
      unattribCost += cost;
    }
  }
  const usageModels = [...modelTotals.entries()]
    .map(([model, v]) => ({ model, tokens: v.tokens, costUsd: v.costUsd }))
    .sort((a, b) => b.tokens - a.tokens);
  if (unattribTokens > 0) {
    usageModels.push({ model: '', tokens: unattribTokens, costUsd: unattribCost });
  }
  const usage = {
    weekTokens,
    weekCostUsd: weekCost,
    weekRuns: usageR.rows.length,
    weekNights: nightSet.size,
    todayTokens,
    todayCostUsd: todayCost,
    // autopilot_tokens is a PER-NIGHT budget (shared across all items that night).
    // Use budgetPerNight × weekNights for the bar so a multi-item night doesn't
    // appear over-budget against a per-run denominator.
    budgetPerNight: appSettings.autopilot_tokens, // 0 = unlimited
    models: usageModels,
    // (#200) Month-to-date rollup, calendar month UTC. NUMERIC/BIGINT arrive
    // as strings from node-postgres.
    monthTokens: Number(monthR.rows[0]?.tokens) || 0,
    monthCostUsd: Number(monthR.rows[0]?.cost) || 0,
    monthRuns: monthR.rows[0]?.runs || 0,
    // (#177) Agent breakdown — the newest runs with their per-model split
    // (executor vs advisor when dual-model; one entry for single-model runs).
    recentRuns: usageR.rows.slice(0, 12).map((r) => ({
      slug: r.slug,
      name: r.project_name,
      itemId: r.item_id != null ? String(r.item_id) : null,
      itemTitle: r.item_title || '',
      outcome: r.outcome,
      when: relativeTime(r.finished_at) || 'just now',
      tokens: Number(r.tokens) || 0,
      costUsd: Number(r.cost_usd) || 0,
      models: r.model_usage && typeof r.model_usage === 'object'
        ? Object.entries(r.model_usage).map(([model, u]) => ({
            model,
            tokens: (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0)
              + (Number(u.cacheReadInputTokens) || 0) + (Number(u.cacheCreationInputTokens) || 0),
            costUsd: Number(u.costUSD) || 0,
          })).sort((a, b) => b.tokens - a.tokens)
        : [],
    })),
  };
  const checksByP = new Map(checksR.rows.map((r) => [r.project_id, r]));

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
    // The merge strip (#154, git-aware since #207). The host's branch report
    // is the truth where it exists: every unmerged origin branch (ahead > 0)
    // gets a chip with real state — ahead/behind, the merge-tree conflict
    // probe, last subject — and its item resolved via the open claim on that
    // branch name, else the id parsed from the lane name. Claims the report
    // hasn't seen (stale/missing report, or a local-only lane) keep the old
    // claim-derived chip. Fully-absorbed branches (ahead 0, no open claim)
    // surface only as a prune count.
    const rep = branchesByP.get(p.id);
    const repList = asList(rep && rep.report);
    const claimByBranch = new Map(
      road.filter((r) => r.claimed_by && !r.done).map((r) => [r.claimed_by, r]));
    const itemById = new Map(road.map((r) => [String(r.id), r]));
    const gitBranches = repList
      .filter((b) => b.ahead > 0 || claimByBranch.has(b.branch))
      .map((b) => {
        const owner = claimByBranch.get(b.branch)
          || (b.itemId != null ? itemById.get(String(b.itemId)) : null);
        return {
          branch: b.branch,
          itemId: owner ? String(owner.id) : (b.itemId != null ? String(b.itemId) : ''),
          itemTitle: owner ? owner.title : '',
          ahead: b.ahead,
          behind: b.behind,
          mergeClean: b.mergeClean, // true | false (conflicts) | null (not probed)
          subject: b.subject || '',
          when: relativeTime(b.committedAt) || '',
        };
      });
    const seenBranches = new Set(gitBranches.map((b) => b.branch));
    const branches = [
      ...gitBranches,
      ...[...claimByBranch.entries()]
        .filter(([branch]) => !seenBranches.has(branch))
        .map(([branch, r]) => ({ branch, itemId: String(r.id), itemTitle: r.title })),
    ];
    const absorbedBranches = repList
      .filter((b) => b.ahead === 0 && !claimByBranch.has(b.branch)).length;
    return {
      slug: p.slug,
      name: p.name,
      tint: p.tint || null,
      status: p.status,
      automode: !!p.automode,
      autopilotArea: p.autopilot_area || '',
      // Target options: areas carried by this project's open must/should items.
      areas: [...new Set(road.filter((r) => !r.done && r.area).map((r) => r.area))].sort(),
      // Open lane branches with the item they own — for the merge strip (#154).
      branches,
      // (#207) fully-merged origin branches never deleted, and report freshness.
      absorbedBranches,
      branchesWhen: rep ? relativeTime(rep.reported_at) || '' : '',
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
      // (#206) Audit pass rate from the checks' stored results; null = no
      // checks have ever run on this project (nothing to rate).
      audit: (() => {
        const c = checksByP.get(p.id);
        return c && c.run > 0 ? { run: c.run, passing: c.passing } : null;
      })(),
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
      executorModel: appSettings.autopilot_executor_model, // '' = CLI default (#153)
      advisorModel: appSettings.autopilot_advisor_model,   // '' = no advisor
    },
    // Model picker catalogue (#175) — the single source of truth for what the
    // Executor / Advisor pickers show. Served here so the frontend never has a
    // second hardcoded list to keep in sync.
    models: { executors: EXECUTOR_CATALOGUE, advisors: ADVISOR_CATALOGUE },
    usage,
    // The host PTY daemon's agent socket + every open web-terminal session
    // (labels are the ✧ Gemini annotations, '' until asked for).
    terminal: { connected: termAgentConnected(), sessions: termSessions(), detached: termDetached() },
    // Account-level Plan windows (#220): the daemon's cached session/week usage
    // snapshot ({plan, tokens, at}) — null until the daemon has pushed one.
    planUsage: termPlanUsage(),
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
