export type ProjectStatus = 'live' | 'building' | 'paused' | 'archived';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type BugStatus = 'open' | 'investigating' | 'fixing' | 'fixed';
export type Priority = 'must' | 'should' | 'could' | 'wont';
// Where a tracker row came from. hook = auto-extracted from a push, manual =
// hand-entered, fly = opened by a live Claude session for its own work (#381).
// 'fly' is ROADMAP-ONLY — a bug cannot hold it — but the type is shared, so
// the renderers that switch on it must not assume all three.
export type Source = 'hook' | 'manual' | 'fly';

// What has pushed since the checkpoint that wrote the resume card. The card's
// content only moves on an authored /checkpoint, while its timestamp moves on
// every push — so a session that ended without one (reaped, limit-hit, closed)
// used to leave a FRESH time over OLD content and last night read as empty.
// null = the card is current. Optional on both payloads so a not-yet-redeployed
// server just renders the old card rather than breaking.
export interface ResumeSince {
  authoredWhen: string;   // when the card's content was written ('' = never checkpointed)
  count: number;          // pushes since then (only meaningful when authoredWhen is set)
  hash: string;           // the newest of those pushes
  branch: string;
  when: string;
  summary: string;        // that session's own sign-off, capped server-side
}
export interface Resume {
  when: string;
  ref: string;
  summary: string;
  inProgress: string[];
  nextUp: string[];
  liked: string[];
  since?: ResumeSince | null;
}

export interface ProjectMeta {
  version: string;
  lastDeploy: string;
  stack: string[];
  pushesThisWeek: number;
}

export interface Project {
  id: string;              // the slug
  name: string;
  subtitle: string;
  tint: string;
  status: ProjectStatus;
  progress: number;        // 0–100, computed server-side from roadmap/bug completion
  metaLine: string;        // dashboard card meta e.g. "pushed 2h ago"
  automode: boolean;       // open to the overnight autopilot — shows the AUTO badge
  siteUrl: string;
  repoUrl: string;
  deployPlatform: string;  // hand-set label on the Deployment panel ("Dokploy", "Vercel", …)
  logsUrl: string;         // where "View logs" points
  meta: ProjectMeta;
  resume: Resume | null;
  // The Monday the Roadmap timeline counts weeks from (YYYY-MM-DD). null = this
  // project has no start date: the Gantt still works on week indices, and the
  // calendar view says why it cannot draw rather than inventing a year.
  weekZero: string | null;
}

export interface Bug {
  id: string;              // BUG-N
  title: string;
  severity: Severity;
  status: BugStatus;
  meta: string;            // "reported 2h ago"
  linkRef: string | null;  // commit hash
  checkId: number | null;  // #278 — the check that caught it (null = filed by hand)
  source: Source;
  reviewed: boolean;       // hook items with false await review
}

// One implementation-plan step (#75) — larger items carry an ordered list,
// ticked off by whoever builds them (the autopilot works them top-down).
export interface PlanStep { text: string; done: boolean }

// The desire tier (#227): how much the owner wants an item NEXT, deliberately
// distinct from the MoSCoW bucket's sizing. '' = unranked and sorts last, so a
// board nobody has ranked keeps its existing order everywhere.
export type Tier = '' | 'S' | 'A' | 'B' | 'C';
export const TIERS: Exclude<Tier, ''>[] = ['S', 'A', 'B', 'C'];
export const TIER_RANK: Record<string, number> = { S: 0, A: 1, B: 2, C: 3 };
export const tierRank = (t: string) => TIER_RANK[t] ?? 4;

export interface RoadmapItem {
  id: number;
  title: string;
  note: string;
  done: boolean;
  bucket: Priority;
  source: Source;
  reviewed: boolean;
  // #381 — the live session that opened this card ('' = not a fly card, or a
  // fly card whose session did not name itself). Outlives claimedBy on purpose:
  // the claim is released and cleared, the provenance is not.
  flySession: string;
  claimedBy: string;   // #277 — the BRANCH owning this item ('' = free)
  area: string;        // product-area tag ('' = untagged) — filters the board
  // #411 — an optional second level under `area` ('' = none). A finer label
  // for finding work; NOT part of the area lane, which stays (project, area).
  subArea: string;
  builtNote: string;   // what actually landed — shown on the Reviews view
  reviewTag: string;   // archive verdict: '' | solid | needs-work | rethink
  reviewTags: string[]; // review annotations ('fix', 'needs-more', …) — #146
  refineNote: string;  // the refine delta — what to change on top ('' = none) — #146
  reviewShelved: boolean; // review set aside for later — off the To-verify list — #148
  skipped: boolean;    // parked — planned, but not to be picked up yet
  skippedAt: string | null; // ISO — when it was parked; ages the Parked view (#247)
  risk: 'low' | 'normal' | 'high'; // graduated trust (#212): low auto-merges a green run
  riskSource: 'human' | 'auto' | ''; // who set the tier (#262) — '' = the default nobody chose
  riskReason: string;                // one line: why the auto tier is what it is ('' when none)
  tier: Tier;          // desire tier (#227) — what the owner wants NEXT; '' = unranked (sorts last)
  plan: PlanStep[];    // the implementation plan ([] = none)
  updatedAt: string | null; // ISO — latest-first ordering in the archive
  agentProfile: string; // '' = the default executor; else the agent profile that should build it

  // ---- the Roadmap tab v2 ----
  parentId: number | null;  // the feature this ticket belongs to (null = it IS a feature)
  // The scheduled bar, in MINUTES from the project's week zero (#401). null =
  // UNSCHEDULED, a real state (the tray) and never minute 0.
  sched: SchedSpan | null;
  // What was committed to, written once when the bar was first scheduled. null =
  // never committed to, which is NOT "on plan" — see lib/plan.ts slipOf().
  baseline: SchedSpan | null;
  labels: string[];         // ids from the fixed registry in lib/labels.ts
  listKey: string;          // '' = derived from the row's own state (lib/plan.ts listKeyOf)
  archived: boolean;        // off the board but recoverable — not parked, not deleted
  // Size in WEEKS; null = UNSIZED, which is not zero. Deliberately NOT in the
  // minutes `sched` uses: an estimate is a size somebody typed, a schedule is a
  // position on a chart, and `defaultLen` in lib/plan.ts is the one place the
  // two units are allowed to meet.
  estimate: number | null;
}

/** A position on the timeline, both fields in MINUTES from week zero (#401). */
export interface SchedSpan { start: number; len: number }

// The Roadmap tab's furniture (GET /api/projects/:slug/board).
export interface BoardArea {
  id: number | null;   // null = mentioned by an item but never registered
  name: string;
  dot: string;
  registered: boolean;
}
// EVERY LANE RENAMES AND DELETES (#428) — there is no `locked`, because there
// is no locked lane. The four keys `listKeyOf` derives into are still wiring,
// and what keeps deleting one safe is the board's catch-all lane rather than a
// flag on the row (server/src/lists.js, and RoadmapPlan.tsx's header).
export interface BoardList { id: number; key: string; name: string; position: number }
// A label the owner has defined for THIS project (#382 — was a code registry).
// `tone` is one of the closed Atlas set, because styles.css needs a rule for it.
export interface BoardLabel { key: string; name: string; tone: string }

export interface BoardShape {
  areas: BoardArea[];
  lists: BoardList[];
  // Optional so a not-yet-redeployed server can't blank the label filter — the
  // client falls back to DEFAULT_LABELS, the same five the server seeds.
  labels?: BoardLabel[];
  // The colours an area may wear, and the tones a label may wear. Served rather
  // than duplicated client-side so a picker can only offer what will store.
  palette?: string[];
  tones?: string[];
}
export interface Roadmap { must: RoadmapItem[]; should: RoadmapItem[]; could: RoadmapItem[]; wont: RoadmapItem[] }

// Per-model token/cost breakdown for dual-model sessions (#167).
export interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

// One autopilot item attempt (the run ledger) — the Reviews view joins these
// onto completed items so a verdict is made against what the session reported.
export interface AutopilotRun {
  id: string;
  itemId: string | null;
  itemTitle: string;
  branch: string;
  outcome: 'landed' | 'no-commits' | 'failed' | 'limit' | 'planned';
  commits: number;
  tokens: number;
  costUsd: number;
  checksFailing: number | null;
  summary: string;
  // Per-model breakdown for dual-model sessions (#167); null on single-model runs.
  modelUsage: Record<string, ModelUsageEntry> | null;
  // Named tmux session (#171); set when the run was started inside tmux.
  // The web terminal can attach to it while the session is active.
  tmuxSession: string | null;
  when: string;
  finishedAt: string | null;
}

// The methods a check may use — GET probes a page, the rest exercise an API
// function (#143, the Quality tab).
export type CheckMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

// A check: an HTTP test against the project's live application, run from the
// Quality tab's Suite segment — a plain probe or a function call (method +
// body) with optional assertions. lastStatus '' = never run.
export interface Check {
  id: number;
  name: string;
  url: string;
  method: CheckMethod;
  expectStatus: number;
  reqBody: string;     // request payload for non-GET methods ('' = none)
  contains: string;
  jsonPath: string;    // dot-path assertion into a JSON response ('' = none)
  jsonExpect: string;  // expected value at that path ('' = just exist)
  semantic: string;    // plain-language expectation, judged by Gemini on run
  // What this check is testing, as a label — the Quality page groups the suite
  // by it. '' = ungrouped, which is a real answer and sorts last. It is not part
  // of the definition: regrouping keeps the result and the history.
  feature: string;
  auth: boolean;       // #261 — run with the app's own token (same-origin only)
  external: boolean;   // #291 — result REPORTED by something outside Stack (POST
                        // /report); Stack never probes it and offers no Run button
  lastStatus: '' | 'pass' | 'fail';
  lastCode: number | null;
  lastMs: number | null;
  lastError: string;
  when: string;
}


// One Audit-tab run-history row — the summary of a Run-all (or run-one),
// newest first from the API. Feeds the dashboard's trend strip.
export interface CheckRun {
  id: number;
  // all = the whole suite, one = a single check, feature = one feature's worth.
  // Only 'all' may be charted as the pass-rate trend — a partial run beside the
  // full ones reads as a dip that never happened.
  scope: 'all' | 'one' | 'feature';
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  at: string;    // ISO timestamp
  when: string;  // relative, server-rendered
}

// #279 — one past result for one check. The Suite rows sparkline from these and
// a red row reads its diagnosis out of them ("failed 4 of the last 6 runs").
export interface CheckResult {
  status: 'pass' | 'fail';
  code: number | null;
  ms: number | null;
  error: string;
  at: string;    // ISO timestamp
  when: string;  // relative, server-rendered
}
// Keyed by check id, newest result first.
export type CheckHistory = Record<number, CheckResult[]>;

export interface Activity {
  hash: string;
  branch: string;
  when: string;
  summary: string;
  tags: string[];
  geminiNote: string; // the second model's one-line take on the push ('' until stamped)
  tokens?: number;    // real session usage from the transcript (#178); 0/absent = unknown
}

// ---- terminal "Jump back in" debrief (GET /api/projects/:slug/debrief) ----
export interface DebriefBugTop { key: string; title: string; severity: Severity }
export interface DebriefRoadmapItem {
  id: number; title: string; bucket: Priority; tier: Tier; claimedBy: string;
}
export interface ProjectDebrief {
  slug: string;
  name: string;
  status: ProjectStatus;
  phase: string;
  summary: string;
  when: string | null; // relative; null = never pushed
  inProgress: string[];
  nextUp: string[];
  blockers: string[];
  bugs: {
    open: number; critical: number; high: number; medium: number; low: number;
    top: DebriefBugTop[];
  };
  roadmap: DebriefRoadmapItem[];
  commits: Activity[];
}

// ---- cross-project command deck (GET /api/overview) ----
export interface OverviewResume {
  slug: string; name: string; tint: string | null;
  summary: string; currentPhase: string;
  when: string;              // last session, relative ('' = never pushed)
  inProgress: string[];      // the three resume sub-lists, so the deck can render
  nextUp: string[];          // the full "pick up where you left off" card rather
  workingWell: string[];     // than only its headline
  since?: ResumeSince | null; // pushes since the checkpoint that wrote this card
}
export interface OverviewBlocker { slug: string; name: string; text: string }
// A project with at least one Claude session open right now.
export interface PresenceItem {
  slug: string; name: string;
  count: number;           // live sessions on this project
  branches: string[];      // distinct branches those sessions are on
  seen: string;            // most recent ping, relative
}
export interface ReviewItem {
  kind: 'bug' | 'roadmap';
  slug: string; name: string;
  id: string;              // bug key (BUG-N) or row id (roadmap)
  title: string;
  meta: string;            // severity (bug) / bucket (roadmap)
  when: string;
  batch?: string;          // one ingest's extractions share it — the session group key (#140)
}
export interface OverviewStale { slug: string; name: string; since: string }
export interface OverviewBugProject { slug: string; name: string; count: number }
// One open bug, anywhere — the dashboard's Audit section lists these directly.
export interface OverviewBug {
  slug: string; name: string; key: string; title: string;
  severity: Severity; status: BugStatus; linkRef: string; when: string;
}
// Every project's bug standing, quiet ones included — the per-app health panel.
export interface OverviewBugCount { slug: string; name: string; serious: number; open: number }
// One card in the cross-project MoSCoW rollup.
export interface OverviewRoadmapItem {
  slug: string; name: string; id: string; title: string; note: string;
  done: boolean; auto: boolean; claimedBy: string;
}
export interface OverviewRoadmapBucket {
  bucket: Priority;
  open: number;                     // open items in this bucket across everything
  items: OverviewRoadmapItem[];     // capped; open first, in run-queue order
}
export interface OverviewActivity {
  slug: string; name: string; hash: string; branch: string;
  summary: string; tags: string[]; geminiNote: string; when: string;
}
// An open roadmap item claimed by a branch, surfaced on the deck (#277).
export interface ClaimItem { slug: string; name: string; branch: string; title: string; id: string }
// One overnight autopilot item attempt — the deck's morning digest.
export interface OverviewRun {
  slug: string; name: string; itemId: number | null; itemTitle: string; branch: string;
  outcome: 'landed' | 'no-commits' | 'failed' | 'limit' | 'planned'; commits: number; tokens: number;
  summary: string; when: string;
  day: string; // (#266) the night this run belongs to — night_key, YYYY-MM-DD
  // #263 — the run's own auto-verdict evidence. '' = no auto-verdict was given,
  // which is NOT the same as one refused, so never render a negative from it.
  autoVerdict: string;
}


export interface Overview {
  resume: OverviewResume | null;
  keepResumeCard: boolean;
  presence: PresenceItem[];
  claims: ClaimItem[];
  blockers: OverviewBlocker[];
  stale: OverviewStale[];
  review: { total: number; items: ReviewItem[] };
  bugs: {
    total: number;                    // open critical + high, everywhere
    projects: OverviewBugProject[];   // only the projects with something serious
    open: OverviewBug[];              // the rows themselves, worst severity first
    byProject: OverviewBugCount[];    // every project with bugs on the books
  };
  roadmap: { closedThisWeek: number; buckets: OverviewRoadmapBucket[] };
  activity: OverviewActivity[];
  autopilotRuns: OverviewRun[]; // last night's runner, per item ([] = quiet night)
  graph: { date: string; count: number }[]; // a year of daily push counts (contribution strip)
  totals: {
    byStatus: Record<ProjectStatus, number>;
    openBugs: number;
    pushesThisWeek: number;
    pushesToday: number;
    projectsTouchedThisWeek: number;
    roadmapClosedThisWeek: number;
    bugsFixedThisWeek: number;
  };
}

// ---- ⌘K command palette search (GET /api/search) ----
export type SearchKind = 'project' | 'bug' | 'roadmap' | 'activity';
export interface SearchTarget { slug: string; tab: string; highlight: string | null }
export interface SearchResult {
  kind: SearchKind;
  slug: string; name: string; tint: string | null;
  title: string; meta: string;
  target: SearchTarget;
}
export interface SearchGroups {
  projects: SearchResult[]; bugs: SearchResult[]; roadmap: SearchResult[];
  activity: SearchResult[];
}
export interface SearchResponse {
  query: string;
  groups: SearchGroups;
  counts: { projects: number; bugs: number; roadmap: number; activity: number; total: number };
  projectCount: number;
}

// ---- settings (GET/PATCH /api/settings) ----
export type CheckpointDetail = 'brief' | 'standard' | 'detailed';
export interface Settings {
  autoRecord: boolean;
  keepResumeCard: boolean;
  checkpointDetail: CheckpointDetail;
  includeChores: boolean;
  sessionDefaults: string[];  // DIRECTIVES keys — standing preferences injected into every session
  autopilotEnabled: boolean;  // the overnight runner's arm switch (the dispatcher no-ops while off)
  autopilotMinutes: number;   // wall-clock cap per unattended session
  autopilotWorkers: number;   // #335 — fleet-wide concurrency cap; 0 = unlimited
  autopilotTokens: number;    // token budget per run; 0 = unlimited
  autopilotTime: string;      // nightly start, host-local HH:MM
  autopilotMaxItems: number;  // most items attempted per night
  autopilotPlanSweep: boolean; // #255 — stand up a plan session for unplanned must/should work
  staleItemDays: number;      // a parked roadmap item reads as stale past this many days (#247)
  termIdleHours: number;      // #287 — terminate a silent terminal session after this long; 0 = never
  autopilotExecutorModel: string; // model alias sessions run as; '' = CLI default (#153)
  autopilotAdvisorModel: string;  // stronger model exposed as the advisor subagent; '' = off
  assistGuidance: string;     // ✧ Fill from note — standing steer folded into the prompt
  assistFields: string[];     // which fields the assist may fill (title always)
  accessPinSet: boolean;      // PIN sign-in available (the PIN itself never leaves the server)
}

// ---- device manager (GET /api/auth/devices) ----
export interface AuthDevice {
  id: number;
  label: string | null;
  lastUsed: string | null;   // relativeTime string, e.g. "2h ago"
  createdAt: string | null;  // ISO timestamp
  current: boolean;          // true = this is the session's own device token
}

// ---- a project's PULSE (GET /api/projects/:slug/pulse) ----
// The Overview tab's three MEASURED bands, over a twelve-week window. The
// arithmetic is server-side and pure (server/src/pulse.js); everything here is
// read-only. The rule that governs every field: `measured: false` means NOTHING
// IN THE WINDOW CARRIED THIS, and the band is drawn ABSENT — never as a row of
// zeroes. A suite that never ran is not a suite at 0% passing, and a nullable
// number here is always that distinction rather than a missing value.
export interface PulseWeek {
  week: string;        // ISO date of the Monday (UTC) that starts the week
  interactive: number; // tokens from human-driven sessions
  auto: number;        // tokens from autopilot runs
}
export interface PulseModel {
  model: string;
  label: string;       // the id, shortened for display
  tokens: number;
  costUsd: number | null; // null = UNPRICED — a transcript carries no cost
  sessions: number;    // interactive sessions this model appeared in
  runs: number;        // autopilot runs this model appeared in
  share: number;       // 0-100, TOKEN-based (only half the population has a price)
  lastAt: string;      // ISO
}
export interface PulseRecent {
  kind: 'session' | 'run';
  at: string;          // ISO
  models: string[];    // which models this row attributed tokens to
  text: string;        // the session's summary, or the run's item title
  tokens: number;
}
export interface PulseUsage {
  measured: boolean;
  weeks: PulseWeek[];
  sessions: number;
  runs: number;
  tokens: number;
  interactiveTokens: number;
  autoTokens: number;
  medianSessionTokens: number | null;
  costUsd: number;     // priced runs ONLY — read it beside pricedRuns
  pricedRuns: number;
  // A delegation whose transcript was lost is UNPRICED, not free, which is why
  // both numbers are reported rather than one.
  delegations: { calls: number; recorded: number };
  models: PulseModel[];
  recent: PulseRecent[];
}
export interface PulseTests {
  measured: boolean;   // false = this project has no checks, so it has no suite
  checks: number;
  failing: number;
  never: number;       // never run — its own state, not a pass
  external: number;
  suite: {
    runs: number;
    passRate: number | null;   // null = NO RUN in the window, never 0%
    medianMs: number | null;
    lastAt: string | null;
    lastPassed: number | null;
    lastTotal: number | null;
  };
  flaky: { name: string; flips: number; of: number }[];
}
export interface PulseRuns {
  measured: boolean;
  total: number;
  landed: number;
  failed: number;      // failed + limit
  planned: number;     // a plan night commits nothing BY DESIGN
  noCommits: number;
  commits: number;
  landRate: number | null;  // over the runs that COULD land; plan nights excluded
  // `none` is NO PASS RAN and is never folded into `clean`.
  verdicts: { clean: number; concerns: number; blocked: number; none: number };
  autoVerdictRuns: number;  // #263 fired; NULL there is not a refusal
}
export interface ProjectPulse {
  windowDays: number;
  usage: PulseUsage;
  tests: PulseTests;
  runs: PulseRuns;
}
