export type ProjectStatus = 'live' | 'building' | 'paused' | 'archived';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type BugStatus = 'open' | 'investigating' | 'fixing' | 'fixed';
export type Priority = 'must' | 'should' | 'could' | 'wont';
export type Source = 'hook' | 'manual';   // hook = auto-extracted, manual = hand-entered

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
  claimedBy: string;   // #277 — the BRANCH owning this item ('' = free)
  area: string;        // product-area tag ('' = untagged) — filters the board
  builtNote: string;   // what actually landed — shown on the Reviews view
  reviewTag: string;   // archive verdict: '' | solid | needs-work | rethink
  reviewTags: string[]; // review annotations ('fix', 'needs-more', …) — #146
  refineNote: string;  // the refine delta — what to change on top ('' = none) — #146
  reviewShelved: boolean; // review set aside for later — off the To-verify list — #148
  skipped: boolean;    // parked — planned, but not to be picked up yet
  skippedAt: string | null; // ISO — when it was parked; ages the Parked view (#247)
  risk: 'low' | 'normal' | 'high'; // graduated trust (#212): low auto-merges a green run
  tier: Tier;          // desire tier (#227) — what the owner wants NEXT; '' = unranked (sorts last)
  plan: PlanStep[];    // the implementation plan ([] = none)
  updatedAt: string | null; // ISO — latest-first ordering in the archive
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

export interface Note {
  id: number;
  text: string;
  colour: string;
  when: string;
  source: Source;
}

// A future: a loose directional idea, curated against the project's north star
// and promoted into the roadmap when it firms up.
export interface Future {
  id: number;
  title: string;
  note: string;
  when: string;
  createdAt: string;   // raw ISO — the sky's time scrub buckets on it
  source: Source;
  reviewed: boolean;
  alignment: string;   // north-star verdict: '' | on-course | tangent | off-course
  area: string;        // product-area tag ('' = untagged) — filters the funnel
  canvasX: number | null;  // visual canvas position (null = auto-layout)
  canvasY: number | null;
}

// The methods a check may use — GET probes a page, the rest exercise an API
// function (#143, the Audit tab).
export type CheckMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

// A check: an HTTP test against the project's live application, run from the
// Audit tab — a plain probe or a function call (method + body) with optional
// assertions. lastStatus '' = never run.
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
  auth: boolean;       // #261 — run with the app's own token (same-origin only)
  lastStatus: '' | 'pass' | 'fail';
  lastCode: number | null;
  lastMs: number | null;
  lastError: string;
  when: string;
}

// The planning stage a Tips-library recipe belongs to — the left rail's
// filter chips on the Tips tab.
export type TipStage = 'diverge' | 'converge' | 'judge' | 'ship';

// A Tips-library recipe: a kept Claude prompt plus the context of when to
// reach for it. The library is app-wide — every project's Tips tab reads the
// same recipes; Run opens a terminal session in that project with the prompt.
export interface Tip {
  id: number;
  name: string;
  stage: TipStage;
  surface: string;   // where it runs best (Polaris / Roadmap / …; '' = anywhere)
  blurb: string;     // the one-line list-row pitch
  when: string;      // when to reach for it
  prompt: string;    // [square-bracket] slots are fill-ins
  best: string[];    // "works best when" lines
  who: string;       // provenance — who kept it, where output lands
  pinned: boolean;
  uses: number;
  lastRun: string;   // relative, server-rendered ('' = never run)
}

// One Audit-tab run-history row — the summary of a Run-all (or run-one),
// newest first from the API. Feeds the dashboard's trend strip.
export interface CheckRun {
  id: number;
  scope: 'all' | 'one';
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

export interface Collections {
  bugs: Bug[];
  roadmap: Roadmap;
  notes: Note[];
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
  kind: 'bug' | 'roadmap' | 'future';
  slug: string; name: string;
  id: string;              // bug key (BUG-N) or row id (roadmap/future)
  title: string;
  meta: string;            // severity (bug) / bucket (roadmap) / 'idea' (future)
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
export type SearchKind = 'project' | 'bug' | 'roadmap' | 'future' | 'note' | 'activity';
export interface SearchTarget { slug: string; tab: string; highlight: string | null }
export interface SearchResult {
  kind: SearchKind;
  slug: string; name: string; tint: string | null;
  title: string; meta: string;
  target: SearchTarget;
}
export interface SearchGroups {
  projects: SearchResult[]; bugs: SearchResult[]; roadmap: SearchResult[];
  futures: SearchResult[]; notes: SearchResult[]; activity: SearchResult[];
}
export interface SearchResponse {
  query: string;
  groups: SearchGroups;
  counts: { projects: number; bugs: number; roadmap: number; futures: number; notes: number; activity: number; total: number };
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
