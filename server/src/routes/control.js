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
//   totals: { automode, liveSessions, claims, review },
//   fleet: {                                // (#268) the worker slots
//     capacity,                             // how many jobs may run at once
//     slots: [ { jobId, slug, name, tint, status, kind, sessionKind,
//                itemId, itemTitle, branch, startedAt, since,
//                tokens, costUsd, tmux,
//                exec, adv,                 // (#280) the two roles on this lane
//                spend: [ { model, label, role, tokens, costUsd, share,
//                           inferred } ],   // banked spend, split by role
//                execCostUsd, advCostUsd, advShare, advisorSeen,
//                ledger: [ { itemId, itemTitle, outcome, when,
//                            tokens, costUsd, advCostUsd, models } ] } ],
//     roles: { executor, advisor, note },   // (#280) the app-wide role policy
//     status: { code, tone, text, hint, fix },   // (#270) why it is/isn't running
//     heartbeat: { ageSec, silent, hostLocal }   // (#270) the dispatcher's pulse
//   }
// }
export const control = Router();

const asList = (v) => (Array.isArray(v) ? v : []);
const ms = (ts) => (ts ? new Date(ts).getTime() : -1);

// (#268) How many autopilot jobs the host may have in flight at once. The
// dispatcher serialises today — GET /next refuses to hand out a second job
// while one is claimed or running — so the fleet is one worker wide. #265
// turns this into a real setting; this constant becomes its default, and the
// strip below already renders N slots the moment N grows.
const FLEET_CAPACITY = 1;

// (#268) The dispatcher's tmux name for a job, mirroring the one
// scripts/stack-autopilot-dispatch.mjs builds (`stack-auto-<safe>-j<id>`).
// Kept in step with that file — it is the only other place this shape exists.
const tmuxNameFor = (slug, jobId) =>
  `stack-auto-${String(slug).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 30)}-j${jobId}`;

// ---- (#280 / design 23a) Roles inside a session -------------------------
// Who is executing, who advised, and what the advice cost. The two roles are
// app-wide settings (#153), but the SPEND split is per session and real: the
// runner persists `model_usage` per run, so the advisor's own line in that
// object is the proof it was consulted and the price of the counsel.
//
// The join is the awkward part. Usage is recorded under the CLI's real model
// ids (`claude-opus-4-5-20251101`) while the settings hold aliases (`opus`,
// `claude-opus-5`, '' = the CLI's own default). They are matched by FAMILY
// and, when the alias names one, GENERATION — and the more specific alias
// wins, which is what makes executor `opus` + advisor `claude-opus-5` resolve
// correctly against a run that carries both. A model matching neither stays
// unattributed rather than being guessed into a role; the client renders that
// as its own bucket, so the split never asserts more than it knows.
const MODEL_FAMILY_RE = /(haiku|sonnet|opus|fable)/i;
const modelFamily = (s) => {
  const m = MODEL_FAMILY_RE.exec(String(s || ''));
  return m ? m[1].toLowerCase() : '';
};
// The generation directly after the family word: 'claude-opus-5' → '5',
// 'claude-opus-4-5-20251101' → '4', bare 'opus' → '' (family-only alias).
const modelGen = (s) => {
  const fam = modelFamily(s);
  if (!fam) return '';
  const m = new RegExp(`${fam}[-_ ]?(\\d+)`, 'i').exec(String(s));
  return m ? m[1] : '';
};
// 0 = no claim on this model, 1 = family-only alias, 2 = family + generation.
const aliasScore = (alias, modelId) => {
  if (!alias) return 0; // '' = the CLI's default: no identity to match on
  const fam = modelFamily(modelId);
  if (!fam || modelFamily(alias) !== fam) return 0;
  const ag = modelGen(alias);
  if (!ag) return 1;
  return ag === modelGen(modelId) ? 2 : 0;
};
const roleOfModel = (modelId, execAlias, advAlias) => {
  const e = aliasScore(execAlias, modelId);
  const a = aliasScore(advAlias, modelId);
  if (e === 0 && a === 0) return '';   // neither role claims it
  if (e === a) return '';              // both claim it equally — genuinely ambiguous
  return a > e ? 'adv' : 'exec';
};
// `claude-opus-4-5-20251101` → `opus-4-5`: enough to recognise the model,
// short enough to sit in a lane row.
const shortModel = (id) => {
  const s = String(id || '');
  const t = s.replace(/^(us|eu|apac)\./, '').replace(/^anthropic\./, '')
    .replace(/^claude-/, '').replace(/-\d{8}$/, '');
  return t || s;
};
const catalogueLabel = (catalogue, model, fallback) => {
  if (!model) return fallback;
  const hit = catalogue.find((m) => m.model === model);
  return hit ? hit.label : model;
};

control.get('/', async (_req, res) => {
  const appSettings = await readSettings();

  const [projectsR, roadR, bugsR, reviewR, presenceR, autoR, schedR, jobsR, usageR, branchR, checksR, monthR, hbR,
         ledgerR, ledgerJobsR, verdictR] = await Promise.all([
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
    // (#270) The dispatcher's pulse — its last GET /next poll. A server that
    // pre-dates the table just reports no heartbeat, which reads as unknown
    // rather than as silent (see the resolver below).
    q(`SELECT last_poll_at, host_local FROM dispatcher_heartbeat WHERE id`)
      .catch(() => ({ rows: [] })),
    // (#269) The throughput ledger — 14 days of runs. Mission Control shows
    // what IS; these rows are the only record of whether the machine is
    // getting BETTER, and until now nothing read them.
    q(`SELECT r.item_id, r.outcome, r.tokens, r.cost_usd, r.model_usage, r.finished_at
         FROM autopilot_runs r
         JOIN projects p ON p.id = r.project_id AND p.deleted_at IS NULL
        WHERE r.finished_at > now() - interval '14 days'
        ORDER BY r.finished_at`),
    // Merge + revert jobs over the same window: the auto-merge share and the
    // revert rate are the two signals of whether the machine can be trusted
    // to close its own loop.
    q(`SELECT kind, status, detail, created_at FROM autopilot_jobs
        WHERE created_at > now() - interval '14 days' AND kind IN ('merge','revert')`),
    // Verdicts on items the runner landed in the window — the first-pass rate.
    q(`SELECT DISTINCT ri.id, ri.review_tag
         FROM roadmap_items ri
         JOIN autopilot_runs r ON r.item_id = ri.id
        WHERE r.finished_at > now() - interval '14 days' AND r.outcome = 'landed'
          AND COALESCE(ri.review_tag, '') <> ''`),
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
    // The cap covers a full week of nights so the Nights calendar (14a) can
    // place every run on its day; `day` is the UTC calendar date, the same
    // bucket convention as weekNights above.
    recentRuns: usageR.rows.slice(0, 60).map((r) => ({
      slug: r.slug,
      name: r.project_name,
      itemId: r.item_id != null ? String(r.item_id) : null,
      itemTitle: r.item_title || '',
      outcome: r.outcome,
      day: new Date(r.finished_at).toISOString().slice(0, 10),
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

  // (#268) The fleet strip — the worker slots. Once there are N workers you
  // need to see N workers, so the payload states capacity as well as what is
  // in flight: the client renders every slot and reads an empty one as IDLE
  // rather than as absent. In-flight jobs always lead the jobs query (open
  // rows sort first), so no extra query is needed.
  const projById = new Map(projectsR.rows.map((p) => [p.id, p]));
  // (#280) The role policy every session runs under — the runner reads its two
  // models straight from settings, so these are not per-job guesses.
  const execAlias = appSettings.autopilot_executor_model;
  const advAlias = appSettings.autopilot_advisor_model;
  const execLabel = catalogueLabel(EXECUTOR_CATALOGUE, execAlias, 'CLI default');
  const advLabel = catalogueLabel(ADVISOR_CATALOGUE, advAlias, 'Off');
  const fleetSlots = jobsR.rows
    .filter((j) => j.status === 'claimed' || j.status === 'running')
    .map((j) => {
      const p = projById.get(j.project_id);
      const road = roadByP.get(j.project_id) || [];
      const item = j.item_id != null
        ? road.find((r) => String(r.id) === String(j.item_id)) : null;
      // The lane claim IS the branch the runner is on. A general night that
      // has not claimed its first item yet has none — say so rather than guess.
      const claim = item
        ? item.claimed_by
        : (road.find((r) => r.claimed_by && !r.done) || {}).claimed_by;
      const startedAt = j.started_at || j.claimed_at;
      // Tokens burned so far: the runs this job has already landed. A run row
      // lands per finished item, so the first in-flight item honestly reads 0
      // until it completes — this is spend banked, not spend estimated.
      const since = startedAt ? new Date(startedAt).getTime() : Infinity;
      let tokens = 0;
      let costUsd = 0;
      // (#280) …and the same banked runs, split by ROLE. `banked` is the
      // session's own ledger — one entry per item it has already finished.
      const banked = [];
      for (const r of usageR.rows) {
        if (p && r.slug === p.slug && new Date(r.finished_at).getTime() >= since) {
          tokens += Number(r.tokens || 0);
          costUsd += Number(r.cost_usd || 0);
          banked.push(r);
        }
      }
      // Per-model totals across everything this session banked, each model
      // attributed to a role by the alias match above.
      const byModel = new Map();
      for (const r of banked) {
        if (!r.model_usage || typeof r.model_usage !== 'object') continue;
        for (const [model, u] of Object.entries(r.model_usage)) {
          const t = (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0)
            + (Number(u.cacheReadInputTokens) || 0) + (Number(u.cacheCreationInputTokens) || 0);
          if (!byModel.has(model)) {
            byModel.set(model, {
              model,
              label: shortModel(model),
              role: roleOfModel(model, execAlias, advAlias),
              tokens: 0, costUsd: 0, inferred: false,
            });
          }
          const m = byModel.get(model);
          m.tokens += t;
          m.costUsd += Number(u.costUSD) || 0;
        }
      }
      const spend = [...byModel.values()].sort((a, b) => b.tokens - a.tokens);
      // One documented inference, and only one: when the executor is left on
      // the CLI's own default there is no alias to match, so a single otherwise
      // unattributed model IS the executor — nothing else was running. It is
      // flagged `inferred` so the client can say so rather than assert it.
      if (!execAlias && !spend.some((m) => m.role === 'exec')) {
        const orphans = spend.filter((m) => !m.role);
        if (orphans.length === 1) { orphans[0].role = 'exec'; orphans[0].inferred = true; }
      }
      const modelCost = spend.reduce((n, m) => n + m.costUsd, 0);
      const execCostUsd = spend.filter((m) => m.role === 'exec').reduce((n, m) => n + m.costUsd, 0);
      const advCostUsd = spend.filter((m) => m.role === 'adv').reduce((n, m) => n + m.costUsd, 0);
      // Shares are of the ATTRIBUTED model cost, so the bar's segments and the
      // legend's numbers always describe the same total. Cost can legitimately
      // be 0 (a subscription session reports none) — fall back to tokens so the
      // split still reads rather than collapsing to an empty bar.
      const modelTok = spend.reduce((n, m) => n + m.tokens, 0);
      const basis = modelCost > 0 ? 'costUsd' : 'tokens';
      const total = modelCost > 0 ? modelCost : modelTok;
      for (const m of spend) m.share = total > 0 ? (m[basis] / total) * 100 : 0;
      const advShare = total > 0
        ? (spend.filter((m) => m.role === 'adv').reduce((n, m) => n + m[basis], 0) / total) * 100
        : 0;
      return {
        jobId: String(j.id),
        slug: p ? p.slug : '',
        name: p ? p.name : '',
        tint: (p && p.tint) || null,
        status: j.status,                      // claimed (starting) | running
        kind: j.kind,                          // manual | nightly | scheduled | …
        sessionKind: j.session_kind || 'build', // #228 — build | plan | debug | audit
        itemId: j.item_id != null ? String(j.item_id) : '',
        itemTitle: item ? item.title : '',
        branch: claim || '',
        startedAt: startedAt ? new Date(startedAt).toISOString() : null,
        since: relativeTime(startedAt) || 'just now',
        tokens,
        costUsd,
        // The host tmux session (#171). NOT browser-attachable — the terminal
        // daemon advertises stack-term-* only — so the client offers it as a
        // `tmux attach -t <name>` hint rather than a dead link.
        tmux: p ? tmuxNameFor(p.slug, j.id) : '',
        // (#280) The two roles on this lane. Both are the app-wide policy —
        // the runner takes its models from settings, so a session cannot be on
        // anything else — while everything below is this session's own spend.
        exec: { model: execAlias, label: execLabel },
        adv: advAlias ? { model: advAlias, label: advLabel } : null,
        spend,
        execCostUsd,
        advCostUsd,
        advShare,
        // Did the advisor actually get consulted? Its model appearing in the
        // banked usage is the only proof, and its absence is worth seeing:
        // an advisor configured but never called is spend policy on paper.
        advisorSeen: spend.some((m) => m.role === 'adv'),
        // The role ledger — what each role has been on, item by item. Stack
        // records role SPEND, not the advisor conversation, so this is the
        // honest granularity: one entry per item the session banked.
        ledger: banked.slice(0, 6).map((r) => {
          const models = r.model_usage && typeof r.model_usage === 'object'
            ? Object.entries(r.model_usage).map(([model, u]) => ({
                model,
                label: shortModel(model),
                role: roleOfModel(model, execAlias, advAlias),
                tokens: (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0)
                  + (Number(u.cacheReadInputTokens) || 0) + (Number(u.cacheCreationInputTokens) || 0),
                costUsd: Number(u.costUSD) || 0,
              })).sort((a, b) => b.tokens - a.tokens)
            : [];
          return {
            itemId: r.item_id != null ? String(r.item_id) : '',
            itemTitle: r.item_title || '',
            outcome: r.outcome,
            when: relativeTime(r.finished_at) || 'just now',
            tokens: Number(r.tokens) || 0,
            costUsd: Number(r.cost_usd) || 0,
            advCostUsd: models.filter((m) => m.role === 'adv').reduce((n, m) => n + m.costUsd, 0),
            models,
          };
        }),
      };
    });
  // Deliberately NOT truncated to capacity: if a stale-recovery race ever
  // leaves more in flight than the fleet is meant to hold, the strip must
  // show it. The client pads with idle slots up to capacity instead.

  // (#270) Loud idle — the honest reason nothing is starting. The most
  // important fact about an automation system is whether it is actually
  // running, and a screen of calm green is a lie when the loop is dead.
  // Resolved most-fundamental-first: if nobody is polling, nothing else about
  // the configuration matters, so the heartbeat outranks every other reason.
  const hb = hbR.rows[0];
  const hbAgeSec = hb
    ? Math.max(0, Math.round((Date.now() - new Date(hb.last_poll_at).getTime()) / 1000))
    : null;
  // The dispatcher runs on a one-minute cron, so five minutes of silence is
  // four missed ticks — an outage, not jitter. No heartbeat row at all (a
  // server that pre-dates the table) reads as UNKNOWN, never as silent.
  const DISPATCH_SILENT_SEC = 5 * 60;
  const dispatcherSilent = hbAgeSec !== null && hbAgeSec > DISPATCH_SILENT_SEC;
  const automodeProjects = projects.filter((p) => p.automode);
  const eligibleProjects = automodeProjects.filter((p) => p.nextPick);
  const heldResume = jobsR.rows.find((j) => j.kind === 'resume'
    && (j.status === 'paused' || (j.status === 'queued' && j.not_before)));
  const fleetStatus = (() => {
    if (dispatcherSilent) {
      return {
        code: 'dispatcher-silent', tone: 'bad',
        text: `The host dispatcher has not polled for ${relativeTime(hb.last_poll_at) || 'a while'}. Nothing runs — armed or not — until it comes back.`,
        hint: 'On the host: `crontab -l` should carry the every-minute stack-autopilot-dispatch.mjs line, and `tail ~/.stack/autopilot.log` says why it stopped.',
        fix: null,
      };
    }
    if (fleetSlots.length > 0) {
      return {
        code: 'working', tone: 'good',
        text: fleetSlots.length >= FLEET_CAPACITY
          ? `Every slot is working — new work waits for one to free up.`
          : `${fleetSlots.length} of ${FLEET_CAPACITY} slots working.`,
        hint: '', fix: null,
      };
    }
    if (!appSettings.autopilot_enabled) {
      return {
        code: 'disarmed', tone: 'bad',
        text: 'Autopilot is off — the nightly and every scheduled session are paused. ▶ Run now still works.',
        hint: '', fix: { kind: 'arm', label: 'Arm the autopilot' },
      };
    }
    if (automodeProjects.length === 0) {
      return {
        code: 'no-automode', tone: 'warn',
        text: 'Armed, but no project is in automode — the runner has nothing it is allowed to touch.',
        hint: 'Flip a project switch in the list below.', fix: null,
      };
    }
    if (heldResume) {
      return {
        code: 'paused', tone: 'warn',
        text: heldResume.status === 'paused'
          ? 'A session is hung up — it only resumes when you say so, and it holds the queue.'
          : 'A session is paused on the usage limit and holds the queue until its reset.',
        hint: '', fix: { kind: 'resume', label: '▶ Resume it' },
      };
    }
    if (eligibleProjects.length === 0) {
      return {
        code: 'nothing-eligible', tone: 'warn',
        text: 'Armed with automode on, but nothing is eligible — every open item is parked, claimed, outside the target area, or still awaiting review.',
        hint: 'Approving a found item in the Plan room inbox is usually what unblocks this.',
        fix: { kind: 'plan', label: 'Open the Plan room' },
      };
    }
    return {
      code: 'waiting', tone: 'good',
      text: `Armed and ready — ${eligibleProjects.length} project${eligibleProjects.length === 1 ? '' : 's'} with work queued. The next window is the nightly at ${appSettings.autopilot_time}.`,
      hint: '', fix: null,
    };
  })();

  // (#269) The throughput ledger — is the automation getting better? Every
  // number is current-value-plus-direction (last 7 days against the 7 before),
  // never a table: the question is the trend, not the row.
  const ledger = (() => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10); // UTC, as everywhere
    // Plan nights (#219) never commit by design — counting them as no-commit
    // runs would slander the build throughput. They are excluded throughout.
    const runs = ledgerR.rows.filter((r) => r.outcome !== 'planned');
    const half = (rows, recent) => rows.filter((r) => {
      const age = now - new Date(r.finished_at || r.created_at).getTime();
      return recent ? age <= 7 * DAY_MS : age > 7 * DAY_MS;
    });

    // 14 daily buckets, oldest first — the sparkline's spine. Days with no
    // runs are present as zeroes so the shape reads as time, not as samples.
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const key = dayKey(now - i * DAY_MS);
      const onDay = runs.filter((r) => dayKey(r.finished_at) === key);
      days.push({
        day: key,
        landed: onDay.filter((r) => r.outcome === 'landed').length,
        runs: onDay.length,
        tokens: onDay.reduce((n, r) => n + Number(r.tokens || 0), 0),
        costUsd: onDay.reduce((n, r) => n + Number(r.cost_usd || 0), 0),
      });
    }

    // A metric is {now, prev} — the client renders the delta as direction.
    const window = (rows) => {
      const landed = rows.filter((r) => r.outcome === 'landed');
      const nights = new Set(rows.map((r) => dayKey(r.finished_at))).size;
      const tokens = landed.reduce((n, r) => n + Number(r.tokens || 0), 0);
      const cost = landed.reduce((n, r) => n + Number(r.cost_usd || 0), 0);
      return {
        landed: landed.length,
        // Items landed per ACTIVE night — nights the fleet did not run at all
        // would otherwise drag the average toward zero and hide real gains.
        perNight: nights ? landed.length / nights : 0,
        tokensPerItem: landed.length ? tokens / landed.length : 0,
        costPerItem: landed.length ? cost / landed.length : 0,
        noCommitRate: rows.length
          ? rows.filter((r) => r.outcome === 'no-commits').length / rows.length : 0,
      };
    };

    // Auto-merge share. The runner's own low-risk merges (#212) are recorded
    // by the 'auto-merge …' detail prefix that POST /merge writes; a human
    // ⇥ Merge writes plain 'merge …'. That string IS the only distinguishing
    // record, so it is what we read.
    const merges = ledgerJobsR.rows.filter((j) => j.kind === 'merge');
    const reverts = ledgerJobsR.rows.filter((j) => j.kind === 'revert');
    const mergeSplit = (rows) => {
      const done = rows.filter((j) => j.status === 'done');
      return {
        total: done.length,
        auto: done.filter((j) => String(j.detail || '').startsWith('auto-merge')).length,
      };
    };

    // First pass: of the items a run landed and a human has since verdicted,
    // how many were called solid. Verdicts are current state, so an item
    // refined and later passed counts as solid — this is the ceiling of the
    // true first-pass rate, and the client says so.
    const verdicted = verdictR.rows;
    const solid = verdicted.filter((r) => r.review_tag === 'solid').length;

    // Executor vs advisor spend (#153's "cheap hands, strong minds" claim,
    // finally measurable). Roles are not recorded per run, so within each run
    // the highest-token model is taken as the executor (it runs every turn)
    // and the rest as advisors (consulted). Documented as a heuristic because
    // it is one — historical runs used whatever the settings said at the time.
    const roles = { executor: { tokens: 0, costUsd: 0 }, advisor: { tokens: 0, costUsd: 0 } };
    for (const r of ledgerR.rows) {
      if (!r.model_usage || typeof r.model_usage !== 'object') continue;
      const entries = Object.entries(r.model_usage).map(([model, u]) => ({
        model,
        tokens: (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0)
          + (Number(u.cacheReadInputTokens) || 0) + (Number(u.cacheCreationInputTokens) || 0),
        costUsd: Number(u.costUSD) || 0,
      })).sort((a, b) => b.tokens - a.tokens);
      entries.forEach((e, i) => {
        const bucket = i === 0 ? roles.executor : roles.advisor;
        bucket.tokens += e.tokens;
        bucket.costUsd += e.costUsd;
      });
    }

    return {
      days,
      now: window(half(runs, true)),
      prev: window(half(runs, false)),
      merges: { now: mergeSplit(half(merges, true)), prev: mergeSplit(half(merges, false)) },
      reverts: { now: half(reverts, true).length, prev: half(reverts, false).length },
      firstPass: { solid, verdicted: verdicted.length },
      roles,
    };
  })();

  res.json({
    // (#269) The throughput ledger — the trend behind the numbers.
    ledger,
    // (#268) The fleet: capacity plus every in-flight worker.
    // (#270) …and the honest reason it is or is not running.
    fleet: {
      capacity: FLEET_CAPACITY,
      slots: fleetSlots,
      // (#280) The role policy, stated once above the lanes: who executes, who
      // advises, and what the arrangement is meant to be. The per-lane numbers
      // are what it actually cost.
      roles: {
        executor: { model: execAlias, label: execLabel },
        advisor: advAlias ? { model: advAlias, label: advLabel } : null,
        note: advAlias
          ? 'Cheap hands, strong mind — the advisor is read-only counsel, never a committer.'
          : 'Single-model sessions — no advisor is configured, so nothing is being consulted.',
      },
      status: fleetStatus,
      heartbeat: { ageSec: hbAgeSec, silent: dispatcherSilent, hostLocal: (hb && hb.host_local) || '' },
    },
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
