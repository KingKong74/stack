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
    reviewed: !!row.reviewed_at,
    // #381 — the live session that opened this card ('' = not a fly item, or a
    // fly item whose session did not name itself). Kept after the claim is
    // released, which is exactly why it is not read off claimed_by.
    flySession: row.fly_session || '',
    claimedBy: row.claimed_by || '',   // lane owning this item ('' = free)
    area: row.area || '',              // product-area tag ('' = untagged) — filters the board
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
    riskReason: row.risk_reason || '', // one line: why the auto tier is what it is
    tier: row.tier || '',              // desire tier S|A|B|C ('' = unranked, sorts last) — #227
    plan: cleanPlan(row.plan),         // implementation steps [{text, done}] (#75)
    agentProfile: row.agent_profile || '', // '' = default executor; else the agent_profiles key to build this
    updatedAt: row.updated_at || null, // ISO — the archive sorts latest-touched first

    // ---- the Roadmap tab v2 ----
    parentId: row.parent_id ?? null,   // the feature this ticket belongs to (null = a feature itself)
    // The scheduled bar, in WEEKS from the project's week zero. null = UNSCHEDULED,
    // which is a state (the tray), never week 0 — see schema.sql's header.
    sched: row.sched_start === null || row.sched_start === undefined ? null
      : { start: Number(row.sched_start), len: Math.max(1, Number(row.sched_len) || 1) },
    // The BASELINE, written once when a bar is first scheduled. The timeline
    // draws the difference as a ghost, so this must never follow a drag.
    baseline: row.plan_start === null || row.plan_start === undefined ? null
      : { start: Number(row.plan_start), len: Math.max(1, Number(row.plan_len) || 1) },
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
// MoSCoW shape the UI renders.
export function groupRoadmap(rows) {
  const out = { must: [], should: [], could: [], wont: [] };
  for (const r of rows) {
    if (out[r.bucket]) out[r.bucket].push(roadmapItemShape(r));
  }
  return out;
}

export function futureShape(row) {
  return {
    id: row.id,
    title: row.title,
    note: row.note || '',
    when: relativeTime(row.created_at) || 'just now',
    createdAt: row.created_at,       // raw ISO — the sky's time scrub buckets on it
    source: row.source,
    reviewed: !!row.reviewed_at,
    alignment: row.alignment || '',  // north-star verdict: on-course | tangent | off-course
    area: row.area || '',            // product-area tag ('' = untagged) — filters the funnel
    canvasX: row.x_coord ?? null,   // visual canvas position (null = auto-layout)
    canvasY: row.y_coord ?? null,
    // The galaxy (#312): shape is derived from these two, never stored as a kind.
    parentId: row.parent_id ?? null, // the idea this one orbits (null = loose)
    isStar: !!row.is_star,           // promoted to its own orbit
    magnitude: row.magnitude ?? null,// 1–5 how much work; null = not sized yet
  };
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

export function noteShape(row) {
  return {
    id: row.id,
    text: row.text,
    colour: row.colour,
    when: relativeTime(row.created_at) || 'just now',
    source: row.source,
  };
}

// One Workbench card. The route joins the row it wraps, so `title` here is
// always the text the canvas should DRAW — read through from notes/futures for
// those kinds, and the card's own only for 'ai'. The client never has to know
// which table a card's words came from.
export function workbenchCardShape(row) {
  const ai = row.kind === 'ai';
  // Age is the WRAPPED row's, not the card's: a note filed months ago that only
  // got a card when the Workbench backfilled would otherwise read as brand new.
  const born = row.note_created_at || row.future_created_at || row.created_at;
  return {
    id: row.id,
    kind: row.kind,
    op: row.op || '',
    noteId: row.note_id ?? null,
    futureId: row.future_id ?? null,
    title: ai ? row.title : (row.note_text ?? row.future_title ?? row.title),
    // The sticky's palette colour, so a note keeps the tint it was filed with.
    colour: row.note_colour || '',
    // The corner stamp: an idea's P-number, an op's name, or a note's age.
    meta: row.kind === 'polaris' ? `P-${row.future_id}` : ai ? (row.op || 'ai') : (relativeTime(born) || 'now'),
    body: row.body && typeof row.body === 'object' ? row.body : {},
    x: row.x,
    y: row.y,
    w: row.w,
    when: relativeTime(born) || 'just now',
  };
}

export const workbenchEdgeShape = (row) => ({
  id: row.id, a: row.a_id, b: row.b_id, ai: Boolean(row.ai),
});

// One row in the Workbench's Polaris picker. `days` is sent alongside `age`
// because the picker's "Recent" filter has to compare, and re-parsing "3w ago"
// on the client to get a number back would be inventing precision the string
// already threw away. `links` is how many ideas orbit this one in the galaxy —
// a rough "how developed is this thought", visible before you pull it.
export function workbenchIdeaShape(row) {
  const created = new Date(row.created_at);
  return {
    id: row.id,
    title: row.title,
    meta: `P-${row.id}`,
    area: row.area || '',
    links: row.links || 0,
    age: relativeTime(row.created_at) || 'just now',
    days: Math.max(0, Math.floor((Date.now() - created.getTime()) / 86_400_000)),
    onCanvas: Boolean(row.on_canvas),
    isStar: !!row.is_star,
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

export function projectDetailShape(p, { progress, metaLine, pushesThisWeek, cadence, activity, bugs, roadmap, notes, futures, checks, keepResumeCard, sessionDefaults, staleItemDays, liveBranches, geminiReady, agents, since }) {
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
    notes,
    futures: futures || [],
    checks: checks || [],
  };
}

// ---- the run ledger's shared shapes --------------------------------------
// Four places read an `autopilot_runs` row and hand it to a client: the job
// ledger (routes/autopilot.js), the Review room's queue and its nights list
// (routes/review.js), and Mission Control's recentRuns (routes/control.js).
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
