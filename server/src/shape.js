// Row -> client shape mappers. The frontend types (web/src/types.ts) are the
// contract; these keep every route returning the same shapes so store.ts stays
// a thin mapping layer.

import { relativeTime, cleanPlan } from './util.js';

// ---- the resume card's provenance ----------------------------------------
// The resume fields (summary / current_phase / the three sub-lists) are written
// ONLY by an authored /checkpoint (ingest invariant 3), while `last_session_at`
// is bumped by every push, the metadata backstop included. So a run of sessions
// that ended without /checkpoint — reaped, limit-hit, or simply closed — leaves
// the card wearing a FRESH timestamp over OLD content, which reads as "last
// night produced nothing" when the pushes are sitting right there in the feed.
//
// This states the gap instead of hiding it: when the resume content came from a
// checkpoint and how many pushes have landed since, plus the newest of those
// pushes and its own sign-off (the backstop's parsed last message). Read-time
// only — nothing here writes, so invariant 3 stands untouched.
//
// `sessions` is the project's session rows, NEWEST FIRST, each with `authored`.
const SINCE_SUMMARY_CAP = 360; // keep the deck payload lean; the feed has it all

export function resumeSince(sessions) {
  const rows = Array.isArray(sessions) ? sessions : [];
  if (!rows.length) return null;
  const idx = rows.findIndex((s) => s.authored);
  // No authored row in the window at all: the card has never been checkpointed
  // (or not within the fetched history). authoredWhen '' is what the UI keys on.
  const count = idx === -1 ? rows.length : idx;
  if (!count) return null; // the newest push IS the checkpoint — card is current
  const latest = rows[0];
  const summary = String(latest.summary || '');
  return {
    authoredWhen: idx === -1 ? '' : relativeTime(rows[idx].created_at) || '',
    count,
    hash: latest.commit_hash || '',
    branch: latest.branch || 'main',
    when: relativeTime(latest.created_at) || 'just now',
    summary: summary.length > SINCE_SUMMARY_CAP
      ? `${summary.slice(0, SINCE_SUMMARY_CAP).trimEnd()}…`
      : summary,
  };
}

export function bugShape(row) {
  return {
    id: row.bug_key,
    title: row.title,
    severity: row.severity,
    status: row.status,
    meta: `reported ${relativeTime(row.created_at) || 'recently'}`,
    linkRef: row.link_ref || null,
    checkId: row.check_id ?? null, // #278 — the check that caught it (null = filed by hand)
    source: row.source, // 'hook' | 'manual' — drives the "auto" cue
    reviewed: !!row.reviewed_at, // hook items with false await the review inbox
  };
}

export function roadmapItemShape(row) {
  return {
    id: row.id,
    title: row.title,
    note: row.note || '',
    done: row.done,
    bucket: row.bucket,
    source: row.source,                // 'hook' | 'manual' | 'fly' (#381)
    // #500 — a test a session suggested: '' = an ordinary row, which is nearly
    // all of them. 'bug' = a test that would have caught a defect, 'function' =
    // a check on a named route or function. `testTarget` is what it is about —
    // a bug key, or the route's own name — and is what lets the Quality tab
    // open its composer straight onto it.
    testKind: row.test_kind || '',
    testTarget: row.test_target || '',
    reviewed: !!row.reviewed_at,
    // #381 — the live session that opened this card ('' = not a fly item, or a
    // fly item whose session did not name itself). Kept after the claim is
    // released, which is exactly why it is not read off claimed_by.
    flySession: row.fly_session || '',
    claimedBy: row.claimed_by || '',   // lane owning this item ('' = free)
    area: row.area || '',              // product-area tag ('' = untagged) — filters the board
    // #411 — the optional second level under `area` ('' = none). A finer
    // label for finding work; it is NOT part of the area lane, which stays
    // (project, area) — see schema.sql.
    subArea: row.sub_area || '',
    builtNote: row.built_note || '',   // what actually landed — shown on the Reviews view
    reviewTag: row.review_tag || '',   // archive verdict: solid | needs-work | rethink
    // #263 — who gave the verdict above and on what evidence. '' evidence on
    // an auto verdict would mean a row that predates the column, not a
    // verdict given for no reason.
    verdictSource: row.verdict_source || 'human',
    verdictAt: row.verdict_at || null,
    verdictEvidence: row.verdict_evidence || '',
    reviewTags: Array.isArray(row.review_tags) ? row.review_tags : [], // review annotations (#146)
    refineNote: row.refine_note || '', // the refine delta — what to change on top (#146)
    reviewShelved: !!row.review_shelved, // review set aside for later — off the To-verify list (#148)
    skipped: !!row.skipped,            // parked — planned, but not to be picked up yet
    skippedAt: row.skipped_at || null, // ISO — when it was parked; ages the Parked view (#247)
    risk: row.risk || 'normal',        // graduated trust (#212): low auto-merges a green run
    riskSource: row.risk_source || '', // 'human' | 'auto' | '' — '' = the default nobody chose (#262)
    riskReason: row.risk_reason || '', // one line: why the auto level is what it is
    // THE SPRINT (#477), which is what replaced the desire tier. `sprintId`
    // null = the BACKLOG, and that is the majority state: an item is in a
    // sprint only because somebody dragged it there. `sprintRank` is its place
    // in that box top-to-bottom (0 = the top, the first thing the night takes)
    // and means NOTHING while sprintId is null — read the pair, never the rank
    // alone. The NAME and STATUS are deliberately NOT here: every screen that
    // draws a sprint chip has already loaded the project's sprints to draw the
    // boxes themselves, so it resolves the id against that one list — and a
    // name carried on the item as well would be a second copy, stale from the
    // moment somebody renames a sprint, on the very screen that renamed it.
    sprintId: row.sprint_id ?? null,
    sprintRank: Number(row.sprint_rank) || 0,
    plan: cleanPlan(row.plan),         // implementation steps [{text, done}] (#75)
    agentProfile: row.agent_profile || '', // '' = default executor; else the agent_profiles key to build this
    updatedAt: row.updated_at || null, // ISO — the archive sorts latest-touched first

    // ---- the Roadmap tab v2 ----
    parentId: row.parent_id ?? null,   // the feature this ticket belongs to (null = a feature itself)
    // #496 — HAS SOMEBODY COMMITTED TO THIS? false = a signed-off idea, kept on
    // the Roadmap rather than the board. The THIRD leg of which screen a row is
    // on (the other two are `reviewed` and `parentId`), and true is the safe
    // default: a row nobody has said anything about is board work. `!== false`
    // rather than `!!` on purpose: a row read before the migration must not
    // silently vanish off the board.
    committed: row.committed !== false,
    // The scheduled bar, in MINUTES from the project's week zero (#401). null =
    // UNSCHEDULED, which is a state (the tray), never minute 0 — see schema.sql's
    // header. BIGINT comes back from pg as a STRING, so both fields need
    // Number() and not just their null preserved; that is this file's whole job.
    sched: row.sched_start_min === null || row.sched_start_min === undefined ? null
      : { start: Number(row.sched_start_min), len: Math.max(1, Number(row.sched_len_min) || 1) },
    // The BASELINE, written once when a bar is first scheduled. The timeline
    // draws the difference as a ghost, so this must never follow a drag.
    baseline: row.plan_start_min === null || row.plan_start_min === undefined ? null
      : { start: Number(row.plan_start_min), len: Math.max(1, Number(row.plan_len_min) || 1) },
    labels: Array.isArray(row.labels) ? row.labels : [],
    // '' = derived from the row's own state (server/src/lists.js listFor), NOT
    // "the first list" — an untouched board must open already sorted.
    listKey: row.list_key || '',
    archived: !!row.archived,          // off the board but recoverable — not parked, not deleted
    // NUMERIC comes back from pg as a STRING, and null must survive as null:
    // an unsized ticket is not a zero-week one, and the drawer says so.
    estimate: row.estimate === null || row.estimate === undefined ? null : Number(row.estimate),
  };
}

// Group flat roadmap rows (already ordered by bucket, position) into the
// five-priority shape the UI renders (#469). The KEY ORDER is the contract:
// every client concatenates these four... five arrays in this order and
// `queueOrder` uses the result's own order as its last sort key.
export function groupRoadmap(rows) {
  const out = { highest: [], high: [], medium: [], low: [], lowest: [] };
  for (const r of rows) {
    if (out[r.bucket]) out[r.bucket].push(roadmapItemShape(r));
  }
  return out;
}


export function checkShape(row) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: row.method || 'GET',         // #143 — the Audit area: exercise functions, not just pages
    expectStatus: row.expect_status,
    reqBody: row.req_body || '',         // request payload for non-GET methods
    contains: row.contains || '',
    jsonPath: row.json_path || '',       // dot-path assertion into a JSON response
    jsonExpect: row.json_expect || '',   // expected value at that path ('' = just exist)
    semantic: row.semantic || '',        // plain-language expectation, judged by Gemini
    feature: row.feature || '',          // what it tests, as a label — '' = ungrouped, never a lie
    auth: !!row.auth,                    // #261 — run with the app's own bearer token (same-origin only)
    external: !!row.external,            // #291 — result REPORTED from outside Stack; POST /run skips it
    lastStatus: row.last_status || '',   // '' = never run
    lastCode: row.last_code ?? null,
    lastMs: row.last_ms ?? null,
    lastError: row.last_error || '',
    when: relativeTime(row.last_run_at) || '',
  };
}

// One Audit-tab run-history row: the summary of a Run-all (or run-one).
export function checkRunShape(row) {
  return {
    id: row.id,
    scope: row.scope,                    // all | one
    total: row.total,
    passed: row.passed,
    failed: row.failed,
    durationMs: row.duration_ms,
    at: row.run_at,
    when: relativeTime(row.run_at) || '',
  };
}

// #279 — one past result for one check. The Quality page's Suite sparklines and
// the plain-language diagnosis on a red row are both derived from these.
export function checkResultShape(row) {
  return {
    status: row.status,                  // pass | fail
    code: row.code ?? null,
    ms: row.ms ?? null,
    error: row.error || '',
    at: row.run_at,                      // raw ISO — the client buckets on it
    when: relativeTime(row.run_at) || '',
  };
}

// One Tips-library recipe: a kept Claude prompt plus the context of when to
// reach for it. `when`/`who` are the human framing; `best` the checklist.
export function tipShape(row) {
  return {
    id: row.id,
    name: row.name,
    stage: row.stage,           // diverge | converge | judge | ship
    surface: row.surface || '', // where it runs best (Polaris / Roadmap / …)
    blurb: row.blurb || '',
    when: row.when_note || '',
    prompt: row.prompt,
    best: Array.isArray(row.best) ? row.best : [],
    who: row.who_note || '',
    pinned: !!row.pinned,
    uses: row.uses,
    lastRun: relativeTime(row.last_run_at) || '',
  };
}

// A worktree row (#229) — the register of git worktrees the host has checked
// out for parallel interactive sessions. No numerics beyond `id`; the rest is
// text and timestamps, so this stays a plain camelCase pass-through.
export function worktreeShape(row) {
  return {
    id: row.id,
    path: row.path,
    repo: row.repo || '',
    branch: row.branch || '',
    sessionName: row.session_name || '',
    kind: row.kind || 'term',
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    releasedAt: row.released_at,
  };
}

// A session row mapped to the activity-feed shape: hash, branch, summary, tags,
// relative time. The hash is the commit the push landed on, so a bug's linkRef
// (also the commit) matches an activity row's hash and the chip resolves.
export function activityShape(row) {
  return {
    hash: row.commit_hash || '—',
    branch: row.branch || 'main',
    when: relativeTime(row.created_at) || 'just now',
    summary: row.summary || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    geminiNote: row.gemini_note || '', // the second model's take, '' until stamped
    tokens: Number(row.tokens_used) || 0, // real session usage (#178); 0 = unknown
  };
}

// Per-week push count helper input is just a number; metaLine/progress are
// computed by the caller (they need cross-table data).
export function projectListShape(p, { progress, metaLine, pushesThisWeek }) {
  return {
    slug: p.slug,
    name: p.name,
    subtitle: p.subtitle || '',
    tint: p.tint || null,
    status: p.status,
    progress,
    metaLine,
    pinned: p.pinned,
    automode: !!p.automode,  // open to the overnight autopilot — drives the AUTO badge
    autopilotArea: p.autopilot_area || '',  // '' = whole board; else the nightly pick's area filter
    siteUrl: p.site_url || '',
    repo: p.repo || '',
    repoUrl: p.repo_url || '',
    pushesThisWeek,
  };
}

export function projectDetailShape(p, { progress, metaLine, pushesThisWeek, cadence, activity, bugs, roadmap, checks, sprints, keepResumeCard, sessionDefaults, staleItemDays, liveBranches, geminiReady, agents, since }) {
  const latest = activity[0];
  return {
    ...projectListShape(p, { progress, metaLine, pushesThisWeek }),
    keepResumeCard: keepResumeCard !== false, // global flag; false hides the resume card
    sessionDefaults: sessionDefaults || [],   // global standing-preference lines for the start hook
    staleItemDays: Number.isFinite(staleItemDays) ? staleItemDays : 21, // parked-item stale line (#247)
    // #278 — is a Gemini key configured on this server. The Quality page reads
    // it to make its AI surfaces ABSENT rather than dead when there's no key:
    // no error, no button that can only 503.
    geminiReady: geminiReady !== false,
    // #361 — the TAB AGENTS' live state, keyed by agent: { name, tab, enabled,
    // ops[] }. Same job as geminiReady one level down: a tab reads its own
    // agent here and renders its ✧ surfaces absent-with-a-reason rather than
    // offering a button whose only possible answer is a 409. Absent (an older
    // server) reads as "no agent switches", i.e. everything on, which is what
    // the missing-row default means server-side too.
    agents: agents || {},
    liveBranches: liveBranches || [],         // branches with a live session now (board lock, BUG-2)
    // #477 — the project's SPRINTS, in board order, riding the one payload
    // every tab already renders from. The board needs them to draw its boxes,
    // and the host runner needs the ACTIVE one to know what it may touch at
    // all; both were otherwise a second fetch against a list that has to agree
    // with the items in this very response. At most one carries status
    // 'active', which the database guarantees and no reader should re-check.
    sprints: sprints || [],
    // The Monday the Roadmap timeline counts weeks from. null = no start date,
    // which the calendar view states rather than inventing one.
    weekZero: p.week_zero ? new Date(p.week_zero).toISOString().slice(0, 10) : null,
    shareToken: p.share_token || '',          // non-empty = the public showcase link is live
    summary: p.summary || '',
    currentPhase: p.current_phase || '',
    northStar: p.north_star || '',
    deployPlatform: p.deploy_platform || '',
    logsUrl: p.logs_url || '',
    techStack: Array.isArray(p.tech_stack) ? p.tech_stack : [],
    inProgress: Array.isArray(p.in_progress) ? p.in_progress : [],
    nextUp: Array.isArray(p.next_up) ? p.next_up : [],
    workingWell: Array.isArray(p.working_well) ? p.working_well : [],
    blockers: Array.isArray(p.blockers) ? p.blockers : [],
    directives: Array.isArray(p.directives) ? p.directives : [],
    ref: latest ? latest.hash : '',
    when: latest ? latest.when : relativeTime(p.last_session_at) || '',
    // What has pushed since the checkpoint that wrote the resume fields above
    // (null = the card is current). See resumeSince().
    resumeSince: since || null,
    // The Overview spine's cadence strip: 28 UTC days, oldest first, zero-filled
    // (util.pushCadence). Absent on an older server, which the client reads as
    // "not measured" and renders as an absent strip — never as 28 quiet days.
    cadence: cadence || [],
    // When the last push actually landed, raw. The strip's "quiet for N days"
    // needs a real stamp: `when` above is already a rendered phrase.
    lastPushAt: p.last_session_at ? new Date(p.last_session_at).toISOString() : null,
    activity,
    bugs,
    roadmap,
    checks: checks || [],
  };
}

// ---- the run ledger's shared shapes --------------------------------------
// Four places read an `autopilot_runs` row and hand it to a client: the job
// ledger (routes/autopilot.js), the Review room's queue and its nights list
// and the culled review/control read layers.
// They had each grown their own copy, and the copies had already drifted on
// the numeric coercions — which matters, because node-postgres returns BIGINT
// and NUMERIC as STRINGS. `tokens` and `cost_usd` must go through Number();
// INT columns (commits, checks_failing, review_findings) arrive as numbers and
// only need their null preserved.
//
// Split in two on purpose. `runCore` needs the columns under their own names,
// so it does not fit the Review room's item query, where the run is LEFT
// JOINed alongside the item and its columns wear `run_` aliases to avoid
// colliding with the item's. `agentReads` uses columns that are never aliased,
// so it fits all four — and the agent reads were the actual duplication.

// The two second-model reads stored on a run. Both follow the same rule, and
// it is the reason they are worth centralising: '' means NO PASS RAN — keyless,
// no diff, or a row predating the column — which is deliberately NOT the same
// as "it looked and found nothing". Every caller must preserve that distinction,
// so it is encoded once here rather than restated at four call sites.
export function agentReads(r) {
  return {
    // #282 — the reviewer: is this change correct? clean | concerns | blocked
    reviewVerdict: r.review_verdict || '',
    reviewNote: r.review_note || '',
    reviewFindings: r.review_findings ?? null,
    // #284 — the architect: where does this take the codebase?
    // aligned | drifting | concerning. It files nothing and closes nothing.
    architectVerdict: r.architect_verdict || '',
    architectNote: r.architect_note || '',
    architectObs: Array.isArray(r.architect_obs) ? r.architect_obs : [],
  };
}

// What a run produced, for callers that select the run's columns unaliased.
// Callers spread this and add their own identity/time fields, which differ:
// the ledger carries model usage and the tmux session, the nights list carries
// the project, recentRuns carries the UTC day and the item's verdict.
export function runCore(r) {
  return {
    branch: r.branch || '',
    outcome: r.outcome,
    commits: r.commits || 0,
    tokens: Number(r.tokens) || 0,       // BIGINT → string from node-postgres
    costUsd: Number(r.cost_usd) || 0,    // NUMERIC → string
    checksFailing: r.checks_failing ?? null,
    summary: r.summary || '',
    // #263 — the run's own verdict evidence, when the risk-tiered gate fired.
    // '' means no auto-verdict was given, which is not the same as one refused.
    autoVerdict: r.auto_verdict || '',
    ...agentReads(r),
  };
}

/**
 * A pg DATE as the bare YYYY-MM-DD day it actually is.
 *
 * THE TRAP, AND IT IS NOT THEORETICAL — the test caught it on the first run.
 * node-postgres parses a DATE column into a JS Date at LOCAL midnight, not UTC
 * midnight. So `new Date(row.starts_on).toISOString().slice(0, 10)` — the
 * obvious spelling, and the one this file shipped for about an hour — converts
 * local midnight to UTC and lands on the PREVIOUS DAY for every host east of
 * Greenwich. On this one (UTC+10) a sprint starting 14 Sep was served as 13 Sep.
 *
 * So the components are read in the same zone the driver built them in, and the
 * value never passes through UTC at all. A DATE is a day somebody named; it has
 * no instant and must never be given one.
 *
 * A string passes through untouched — some drivers and some queries hand the
 * raw text back, and re-parsing it would reintroduce the very conversion this
 * exists to avoid.
 */
export function dayOf(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(v);
  if (!Number.isFinite(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A SPRINT ROW (#477) — the box the backlog draws and the only box the runner
// reads. `status` is the whole contract: exactly one 'active' row per project
// (the partial unique index in schema.sql enforces it, not this file), and
// 'active' is the only status the automation looks at.
//
// NO ITEM COUNT. A sprint's membership lives on the items, which arrive in the
// same payload, so a count served here would be a second answer to "what is in
// this sprint" that the screen could draw beside the first and disagree with.
export function sprintShape(row) {
  return {
    id: row.id,
    name: row.name || '',
    status: row.status || 'planned',    // planned | active | done
    position: Number(row.position) || 0,
    // THE PLANNED WINDOW (what the owner said) and the ACTUAL STAMPS (what
    // happened), side by side and never merged — see schema.sql. Both halves
    // are null far more often than not, and null is a real answer: a sprint
    // with no window is a box of work nobody has dated.
    //
    // `starts_on`/`ends_on` are DATE columns — read through `dayOf`, and read
    // its header before touching either. The first cut of this line was
    // `new Date(v).toISOString().slice(0, 10)` and it moved every date back a
    // day on this very host.
    startsOn: dayOf(row.starts_on),
    endsOn: dayOf(row.ends_on),
    startedAt: row.started_at || null,   // stamped on start, KEPT past the finish
    endedAt: row.ended_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}
