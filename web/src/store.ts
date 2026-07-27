import type {
  Project, Resume, Activity, Bug, Roadmap, RoadmapItem, Note, Future, Check, CheckRun, CheckHistory, Overview,
  ProjectStatus, Priority, Severity, BugStatus, SearchResponse, Settings, AutopilotRun, PlanStep,
  AuthDevice, Tip, Tier,
} from './types';

// ---------------------------------------------------------------------------
// This module is the ONLY place that touches the network. Every function is
// async and calls /api/* with a bearer token. The token lives in localStorage
// and is the single thing the token gate manages; nothing else in the UI talks
// to the server or storage directly.
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'stack.token';

let authListeners: Array<() => void> = [];
function notifyAuth() { for (const cb of authListeners) cb(); }

export function getToken(): string | null { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t: string) { localStorage.setItem(TOKEN_KEY, t); notifyAuth(); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); notifyAuth(); }

// App subscribes so a 401 (which clears the token) bounces straight to the gate.
export function onAuthChange(cb: () => void): () => void {
  authListeners.push(cb);
  return () => { authListeners = authListeners.filter((x) => x !== cb); };
}

export class AuthError extends Error {
  constructor() { super('Unauthorised'); this.name = 'AuthError'; }
}

// Typed localStorage reader (#218: #192 + #185) — every device-local
// preference parses through here. `shape` receives the parsed value (null when
// absent) and returns the typed result, so each pref keeps its own defaults;
// a corrupted entry is logged instead of silently swallowed, then shaped from
// null exactly like a missing one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readStoredJSON<T>(key: string, shape: (p: any) => T): T {
  let raw: string | null = null;
  try { raw = localStorage.getItem(key); } catch { /* storage unavailable (private mode) — treat as unset */ }
  if (raw != null) {
    try {
      return shape(JSON.parse(raw));
    } catch (e) {
      console.warn(`[stack] preference ${key} is corrupted — falling back to defaults.`, e);
    }
  }
  return shape(null);
}

// ---- export-brief preferences (device-local, like the token) ----

const BRIEF_PREFS_KEY = 'stack.briefPrefs';

export interface BriefPrefs { compact: boolean; directives: string[] }

export function getBriefPrefs(): BriefPrefs {
  return readStoredJSON(BRIEF_PREFS_KEY, (p) => ({
    compact: p?.compact === true,
    directives: Array.isArray(p?.directives) ? p.directives : [],
  }));
}

export function setBriefPrefs(prefs: BriefPrefs) {
  localStorage.setItem(BRIEF_PREFS_KEY, JSON.stringify(prefs));
}

// ---- roadmap draft (device-local): an accidentally-dismissed add-modal keeps
// its text per project, so half-typed items survive a stray click ----

const ROAD_DRAFT_KEY = 'stack.roadDrafts';
// Drafts are a crash pad, not storage — stale ones self-clear after this long.
const ROAD_DRAFT_TTL_MS = 30 * 60 * 1000;

export interface RoadDraft { title: string; note: string; priority: Priority; branch: string; area?: string; savedAt?: number }

function readRoadDrafts(): Record<string, RoadDraft> {
  return readStoredJSON(ROAD_DRAFT_KEY, (p) => (p && typeof p === 'object' ? p : {}));
}

export function getRoadDraft(slug: string): RoadDraft | null {
  const d = readRoadDrafts()[slug] || null;
  if (d && d.savedAt && Date.now() - d.savedAt > ROAD_DRAFT_TTL_MS) {
    setRoadDraft(slug, null); // expired — quietly bin it
    return null;
  }
  return d;
}

export function setRoadDraft(slug: string, draft: RoadDraft | null) {
  const all = readRoadDrafts();
  if (draft) all[slug] = { ...draft, savedAt: Date.now() }; else delete all[slug];
  localStorage.setItem(ROAD_DRAFT_KEY, JSON.stringify(all));
}

// ---- theme preference (device-local; App applies it to <html data-theme>) ----

const THEME_KEY = 'stack.theme';

export type ThemePref = 'system' | 'light' | 'dark';

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function setThemePref(pref: ThemePref) {
  localStorage.setItem(THEME_KEY, pref);
  notifyTheme();
}

let themeListeners: Array<() => void> = [];
function notifyTheme() { for (const cb of themeListeners) cb(); }
export function onThemeChange(cb: () => void): () => void {
  themeListeners.push(cb);
  return () => { themeListeners = themeListeners.filter((x) => x !== cb); };
}

async function request<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { clearToken(); throw new AuthError(); }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep default */ }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// Probe a protected endpoint with a candidate token (used by the gate).
export async function verifyToken(candidate: string): Promise<boolean> {
  const res = await fetch('/api/projects', { headers: { authorization: `Bearer ${candidate}` } });
  return res.ok;
}

// PIN sign-in (the from-anywhere door): exchanges the access PIN set in
// Settings for a device token of this browser's own, then stores it exactly
// like a pasted API token. Throws with the server's message on failure.
export async function loginWithPin(pin: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin, label: navigator.userAgent.slice(0, 120) }),
  });
  if (!res.ok) {
    let msg = `Sign-in failed (${res.status})`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep default */ }
    throw new Error(msg);
  }
  const { token } = (await res.json()) as { token: string };
  setToken(token);
}

// ---- device manager ----

// List all PIN-issued device tokens. Returns [] when no PIN is set (no rows
// exist yet) or when the API is unreachable.
export async function getAuthDevices(): Promise<AuthDevice[]> {
  return request<AuthDevice[]>('/auth/devices');
}

// Revoke one PIN device token by its row id. If the caller revokes their own
// device (current === true), the calling code should clearToken() to drop back
// to the gate — the next request would 401 anyway since the token is gone.
export async function revokeAuthDevice(id: number): Promise<void> {
  return request<void>(`/auth/devices/${id}`, { method: 'DELETE' });
}

// ---- shaping (server payload -> frontend types) ----

const repoUrl = (repo: string): string =>
  !repo ? '' : /^https?:\/\//.test(repo) ? repo : `https://github.com/${repo}`;

interface ProjectPayload {
  slug: string; name: string; subtitle: string; tint: string | null; status: ProjectStatus;
  progress: number; metaLine: string; pinned: boolean; automode?: boolean;
  siteUrl: string; repo: string; repoUrl: string;
  pushesThisWeek: number;
  // detail-only:
  summary?: string; currentPhase?: string; northStar?: string;
  deployPlatform?: string; logsUrl?: string; techStack?: string[];
  inProgress?: string[]; nextUp?: string[]; workingWell?: string[]; blockers?: string[];
  directives?: string[];
  ref?: string; when?: string;
}

function toResume(d: ProjectPayload): Resume | null {
  const has = d.summary || d.inProgress?.length || d.nextUp?.length || d.workingWell?.length;
  if (!has) return null;
  return {
    when: d.when || '',
    ref: d.ref || '',
    summary: d.summary || '',
    inProgress: d.inProgress || [],
    nextUp: d.nextUp || [],
    liked: d.workingWell || [],
  };
}

function toProject(d: ProjectPayload): Project {
  const isDetail = d.summary !== undefined || d.inProgress !== undefined;
  return {
    id: d.slug,
    name: d.name,
    subtitle: d.subtitle || '',
    tint: d.tint || '#dcdac9',
    status: d.status,
    progress: d.progress ?? 0,
    metaLine: d.metaLine || '',
    automode: !!d.automode,
    siteUrl: d.siteUrl || '',
    repoUrl: d.repoUrl || repoUrl(d.repo || ''),
    deployPlatform: d.deployPlatform || '',
    logsUrl: d.logsUrl || '',
    meta: {
      version: '—',
      lastDeploy: d.metaLine ? d.metaLine.replace(/^pushed /, '') : '—',
      stack: d.techStack || [],
      pushesThisWeek: d.pushesThisWeek ?? 0,
    },
    resume: isDetail ? toResume(d) : null,
  };
}

// ---- cross-project command deck ----

// The server already returns the client shape, so this is a thin pass-through.
// (`review`/`presence` are defaulted so a not-yet-redeployed server can't
// blank the deck.)
export async function getOverview(): Promise<Overview> {
  const o = await request<Overview>('/overview');
  return {
    ...o,
    review: o.review ?? { total: 0, items: [] },
    presence: o.presence ?? [],
    claims: o.claims ?? [],
  };
}

// ---- search (the ⌘K command palette) ----

export async function getSearch(query: string): Promise<SearchResponse> {
  const r = await request<SearchResponse>(`/search?q=${encodeURIComponent(query)}`);
  // Default the futures group so a not-yet-redeployed server can't break the palette.
  return {
    ...r,
    groups: { ...r.groups, futures: r.groups.futures ?? [] },
    counts: { ...r.counts, futures: r.counts.futures ?? 0 },
  };
}

// ---- mission control ----

export interface ControlProject {
  slug: string; name: string; tint: string | null; status: ProjectStatus;
  automode: boolean; progress: number; lastPush: string;
  autopilotArea: string;   // '' = whole board; else the nightly pick's area filter
  areas: string[];         // target options — areas on this project's open must/should items
  live: { count: number; branches: string[] } | null;
  claims: { id: string; title: string; branch: string }[];
  // #154 — open branches with the item each one owns; powers the merge strip.
  // #207 — the host's git branch report enriches each chip where it exists:
  // ahead/behind vs main, the merge-tree conflict probe and the last subject.
  // Claim-only chips (no report yet) carry just the first three fields.
  branches: {
    branch: string; itemId: string; itemTitle: string;
    ahead?: number; behind?: number;
    mergeClean?: boolean | null;  // false = conflicts with main; null/absent = not probed
    subject?: string; when?: string;
  }[];
  // #207 — fully-merged origin branches never deleted (prune hint) + report age.
  absorbedBranches?: number;
  branchesWhen?: string;
  reviewCount: number;
  // #255 — open must/should with no design, and plan jobs already standing by.
  planCoverage?: { unplanned: number; queued: number };
  bugs: { serious: number; open: number };
  // #206 — audit pass rate from the checks' stored results; null/absent = never run.
  audit?: { run: number; passing: number } | null;
  blockers: string[];
  nextPick: { id: string; bucket: Priority; title: string } | null;
  lastAuto: { branch: string; summary: string; when: string } | null;
}
// #228 — the session planner: what a scheduled session IS, beyond a time slot.
export type SessionKind = 'build' | 'plan' | 'debug' | 'audit';

export interface AutopilotSchedule {
  id: string; slug: string; name: string; tint: string | null;
  itemId: string | null; itemTitle: string;
  atTime: string;          // host-local HH:MM
  days: number[];          // getDay() ints; [] = one-off on runDate
  runDate: string | null;  // YYYY-MM-DD for one-offs
  note: string; enabled: boolean;
  kind: SessionKind;             // #228 — runner mode
  agenda: (number | string)[];   // ordered work list: item ids, or bug keys (debug)
  area: string;                  // scope the general pick ('' = whole board)
}
export interface AutopilotJob {
  id: string; slug: string; name: string;
  kind: 'manual' | 'nightly' | 'scheduled' | 'revert' | 'resume' | 'merge';
  itemId: string | null; itemTitle: string;
  // 'paused' = hung up (#142): held until a human resumes; never auto-fires.
  status: 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'paused';
  detail: string;
  notBefore?: string | null;  // a resume job's hold — ISO, null once resumed by hand
  sessionKind?: SessionKind;           // #228 — the session plan the job carries
  agenda?: (number | string)[];
  area?: string;
  when: string;
}
export interface TermSession {
  sid: string; cwd: string; cmd: 'shell' | 'claude';
  startedAt: number;       // epoch ms
  label: string;           // ✧ Gemini's take on what it's doing ('' until asked)
  tmux?: string;           // the host tmux session behind a claude tab ('' for
                           // shells / pre-tmux daemons) — the jump-in target
  polaris?: boolean;       // a Polaris planning session (#213) — the strip
                           // labels it planning and jumps to the studio
}
export interface ModelEntry { model: string; label: string }

// (#194) Weekly + today token/cost summary for Mission Control's usage card.
export interface UsageSummary {
  weekTokens: number;
  weekCostUsd: number;
  weekRuns: number;
  weekNights: number;      // distinct calendar nights that had at least one run
  todayTokens: number;
  todayCostUsd: number;
  budgetPerNight: number;  // echo of settings.autopilot_tokens; 0 = unlimited
  models: { model: string; tokens: number; costUsd: number }[];
  // #200 — month-to-date rollup (calendar month, UTC), across all projects.
  monthTokens?: number;
  monthCostUsd?: number;
  monthRuns?: number;
  // #177 — the newest runs with their per-model (agent) split for the breakdown.
  // `day` (#14a) = the UTC calendar date, so the Nights room can place each run.
  recentRuns?: RunRow[];
}

// One row of the run ledger. #286 added what the run PRODUCED (branch, commits,
// its own account, the checks it left red) and the item's current `verdict` —
// '' meaning nobody has dispositioned it, which is what the night debrief asks
// you to do. All optional: an older server sends the #177 shape alone.
export interface RunRow {
  slug: string; name: string; itemId: string | null; itemTitle: string;
  outcome: string; day?: string; when: string; tokens: number; costUsd: number;
  models: { model: string; tokens: number; costUsd: number }[];
  branch?: string;
  commits?: number;
  summary?: string;              // the session's own account of the item
  checksFailing?: number | null; // null = the run never ran the checks
  verdict?: string;              // '' = awaiting your verdict
  itemDone?: boolean;
  // (#282) The reviewer's stored read on this run: clean | concerns | blocked.
  // '' = no review ran — keyless, no diff, or a row from before it was kept.
  // That is NOT the same as "nothing found", and the debrief says so.
  reviewVerdict?: string;
  reviewNote?: string;
  reviewFindings?: number | null;
  // (#284) The architect's structural read: aligned | drifting | concerning.
  // '' = no pass ran. A change can be correct and still drift, which is why
  // this is a separate verdict from the reviewer's rather than folded into it.
  architectVerdict?: string;
  architectNote?: string;
  architectObs?: string[];
}

// (#286) The reviewer's per-push line — the second model's take on one auto/*
// push, and the only durable trace of the diff review (its structured verdict
// is consumed by the auto-merge gate and deleted). Empty list = no reviewer
// ran, which the debrief states rather than drawing an empty reviewer.
export interface ReviewNote {
  slug: string; hash: string; branch: string;
  day: string; when: string;
  summary: string; note: string;
}

// Account-level Plan windows (#220) — the daemon's cached snapshot of the
// same session/week percentages the Terminal strip shows (#195).
export interface PlanUsageSnapshot {
  plan: {
    session?: { pct: number; resetAt: number | null } | null;
    week?: { pct: number; resetAt: number | null } | null;
    weekModel?: { pct: number; resetAt: number | null; model?: string } | null;
  };
  tokens: number; // today's fresh transcript tokens at snapshot time
  at: number;     // epoch ms the relay cached it — staleness gate
}

// (#268) A worker slot — one in-flight autopilot job. `branch` is the lane
// claim the runner holds ('' until a general night claims its first item);
// `tokens`/`costUsd` are spend BANKED by items this job already finished, so
// the first in-flight item honestly reads 0. `tmux` is the host session name
// (#171) — not browser-attachable, offered as a `tmux attach -t` hint.
export interface FleetSlot {
  jobId: string; slug: string; name: string; tint: string | null;
  status: 'claimed' | 'running';
  kind: AutopilotJob['kind'];
  sessionKind: SessionKind;
  itemId: string; itemTitle: string;
  branch: string;
  startedAt: string | null;
  since: string;
  tokens: number; costUsd: number;
  tmux: string;
  // (#280) The roles on this lane. `exec`/`adv` are the app-wide policy (the
  // runner takes its models from settings); everything below is this session's
  // own spend, so the pair reads as "who was meant to run it" beside "what it
  // actually cost". Optional throughout — a pre-#280 server sends none.
  exec?: RoleModel;
  adv?: RoleModel | null;
  spend?: RoleSpend[];
  execCostUsd?: number; advCostUsd?: number;
  advShare?: number;        // advisor's % of the attributed total
  advisorSeen?: boolean;    // the advisor's model appears in the banked usage
  ledger?: RoleLedgerEntry[];
}

// (#280) One of the two roles: the configured model, catalogue-labelled.
export interface RoleModel { model: string; label: string }

// (#280) One model's share of a session's banked spend. `role` is '' when
// neither alias claims the model — the split shows it as unattributed rather
// than guessing. `inferred` marks the one documented inference: a lone
// unattributed model while the executor is on the CLI's default IS the executor.
export interface RoleSpend {
  model: string; label: string;
  role: 'exec' | 'adv' | '';
  tokens: number; costUsd: number;
  share: number; inferred: boolean;
}

// (#280) One item this session has already banked, with the roles that were on
// it. Stack records role spend, not the advisor conversation — so an item is
// the honest granularity for "what the advice cost".
export interface RoleLedgerEntry {
  itemId: string; itemTitle: string;
  outcome: string; when: string;
  tokens: number; costUsd: number;
  advCostUsd: number;
  models: { model: string; label: string; role: 'exec' | 'adv' | ''; tokens: number; costUsd: number }[];
}

// (#270) Loud idle — the honest reason the fleet is or is not running, resolved
// server-side most-fundamental-first. `tone` drives the colour; `fix` is the
// one-click remedy where one exists; `hint` is the host-side instruction when
// it doesn't. 'dispatcher-silent' outranks everything: if nobody is polling,
// no amount of correct configuration matters.
export type FleetStatusCode =
  | 'dispatcher-silent' | 'working' | 'disarmed' | 'no-automode'
  | 'paused' | 'nothing-eligible' | 'waiting';

export interface FleetStatus {
  code: FleetStatusCode;
  tone: 'good' | 'warn' | 'bad';
  text: string;
  hint: string;
  fix: { kind: 'arm' | 'resume' | 'plan'; label: string } | null;
}

// (#269) The throughput ledger — is the automation getting better? Every metric
// is a pair: `now` (last 7 days) against `prev` (the 7 before), so the rail can
// render a direction rather than a table. Plan nights are excluded throughout —
// they never commit by design.
export interface LedgerWindow {
  landed: number;
  perNight: number;       // landed items per ACTIVE night (idle nights excluded)
  tokensPerItem: number;
  costPerItem: number;
  noCommitRate: number;   // 0–1
}

export interface Ledger {
  // 14 daily buckets, oldest first; empty days are present as zeroes.
  days: { day: string; landed: number; runs: number; tokens: number; costUsd: number }[];
  now: LedgerWindow;
  prev: LedgerWindow;
  // Completed merge jobs split by who queued them — the runner's own low-risk
  // auto-merges (#212) vs a human ⇥ Merge.
  merges: { now: { total: number; auto: number }; prev: { total: number; auto: number } };
  reverts: { now: number; prev: number };
  // Of items a run landed and a human has since verdicted, how many were called
  // solid. Current state, so a refined-then-passed item counts — this is the
  // CEILING of the true first-pass rate.
  firstPass: { solid: number; verdicted: number };
  // Executor vs advisor spend (#153), attributed by the SAME alias match the
  // lane split (#280) and the fleet table (#281) use. `assumed` is the slice
  // the fallback placed — models the current policy names for neither role,
  // split the old highest-token way — so the client can qualify the claim
  // rather than present a partly-guessed total as measured.
  roles: {
    executor: { tokens: number; costUsd: number };
    advisor: { tokens: number; costUsd: number };
    assumed?: { tokens: number; costUsd: number };
  };
}

// (#281 / design 23b) Roles across the fleet. `models` is the week per model,
// `assignments` is what ACTUALLY ran per project — compared against the
// configured policy rather than assumed equal to it, which is the only way
// drift becomes visible. `worth` is numbers only; the sentences are composed
// in the Roles room, the same way a lane's read is.
export interface FleetRoleModel {
  model: string; label: string;
  role: 'exec' | 'adv' | '';
  runs: number; tokens: number; costUsd: number;
  todayTokens: number; todayCostUsd: number;
  share: number; lastSeen: string;
}

// drift: '' = the runs match the policy · 'no-runs' = quiet, not drift ·
// 'off-policy' = a model ran that neither current role claims (a changed
// setting, or a host-side --executor-model override) · 'advisor-unused' = an
// advisor is configured but never appeared in this project's runs.
export type RoleDrift = '' | 'no-runs' | 'off-policy' | 'advisor-unused';

export interface FleetRoleAssignment {
  slug: string; name: string; tint: string | null; automode: boolean;
  runs: number;
  exec: string; execExtra: number;
  adv: string; advExtra: number;
  drift: RoleDrift;
  driftModel: string;
  lastRun: string;
}

export interface FleetRoleWorth {
  advisedRuns: number; advisedLanded: number;
  plainRuns: number; plainLanded: number;
  advCostUsd: number; execCostUsd: number; totalCostUsd: number;
  advShare: number; execShare: number; avgAdvPerRun: number;
  costBasis: boolean;   // false = no cost reported, the shares are token-based
}

export interface FleetRoles {
  days: number;
  models: FleetRoleModel[];
  assignments: FleetRoleAssignment[];
  worth: FleetRoleWorth;
}

export interface ControlData {
  // (#269) The throughput ledger; absent on a server that pre-dates it.
  ledger?: Ledger;
  // (#268) The fleet: how many workers the host may run at once, and what each
  // busy one holds. Slots below capacity are idle — the strip renders them.
  // (#270) …plus why it is or is not running, and the dispatcher's pulse.
  fleet?: {
    capacity: number;
    slots: FleetSlot[];
    // (#280) The role policy stated once above the lanes. Undefined on a
    // pre-#280 server — the roles strip hides rather than inventing one.
    roles?: {
      executor: RoleModel;
      advisor: RoleModel | null;   // null = no advisor: single-model sessions
      note: string;
    };
    status?: FleetStatus;
    // ageSec null = no heartbeat recorded (a pre-#270 server) — reads as
    // unknown, never as silent.
    heartbeat?: { ageSec: number | null; silent: boolean; hostLocal: string };
  };
  autopilot: {
    enabled: boolean; minutes: number; tokens: number; time: string; maxItems: number;
    planSweep: boolean;     // #255 — auto-plan unplanned must/should work
    executorModel: string;  // '' = the claude CLI's default model (#153)
    advisorModel: string;   // '' = no advisor subagent
  };
  // Model picker catalogue (#175) — served from the backend so there is one
  // source of truth. Undefined while loading; the frontend falls back to the
  // hardcoded lists in Control.tsx.
  models?: { executors: ModelEntry[]; advisors: ModelEntry[] };
  terminal?: { connected: boolean; sessions?: TermSession[]; detached?: DetachedSession[] };  // host daemon + open web terminals + orphaned tmux survivors
  schedules: AutopilotSchedule[];
  jobs: AutopilotJob[];                // recent first; queued/claimed/running lead the strip
  projects: ControlProject[];
  totals: { automode: number; liveSessions: number; claims: number; review: number };
  usage?: UsageSummary | null;
  planUsage?: PlanUsageSnapshot | null; // Plan windows via the daemon (#220)
  // (#281) Undefined on a pre-#281 server — the Roles room says so rather than
  // rendering an empty fleet as if nothing had ever run.
  roles?: FleetRoles | null;
  // (#286) The reviewer's per-push notes, for the night debrief, and whether a
  // Gemini key exists at all — false lets the debrief say "no reviewer ran"
  // instead of drawing a reviewer with nothing to say.
  reviewNotes?: ReviewNote[];
  geminiReady?: boolean;
}

export async function getControl(): Promise<ControlData> {
  const d = await request<ControlData>('/control');
  // Defaults so a not-yet-redeployed server can't blank Mission Control.
  return {
    ...d,
    autopilot: {
      enabled: d.autopilot?.enabled ?? false,
      minutes: d.autopilot?.minutes ?? 120,
      tokens: d.autopilot?.tokens ?? 1_500_000,
      time: d.autopilot?.time ?? '23:05',
      maxItems: d.autopilot?.maxItems ?? 3,
      // An older server that does not send it reads as ON, matching the
      // server-side default — the switch then simply has nothing to gate.
      planSweep: d.autopilot?.planSweep ?? true,
      executorModel: d.autopilot?.executorModel ?? '',
      advisorModel: d.autopilot?.advisorModel ?? '',
    },
    schedules: d.schedules ?? [],
    jobs: d.jobs ?? [],
    // #154 — default branches so a pre-deploy server can't break the strip.
    projects: (d.projects ?? []).map((p) => ({ ...p, branches: p.branches ?? [] })),
    // #194 — null when the server pre-dates this feature; the usage card hides.
    usage: d.usage ?? null,
    // #268 — a pre-deploy server sends no fleet; one idle slot is the honest
    // default, since the dispatcher has always been one worker wide.
    fleet: d.fleet ?? { capacity: 1, slots: [] },
    // #281 — null when the server pre-dates the fleet roles block; the Roles
    // room draws its own "this server has no roles data" state.
    roles: d.roles ?? null,
  };
}

// ✧ Label the terminal sessions — live ones AND the detached tmux survivors —
// in one Gemini pass over each session's recent output (annotation only; 503
// when the server has no key).
export async function labelTerminalSessions(): Promise<{ sessions: TermSession[]; detached: DetachedSession[] }> {
  const r = await request<{ sessions: TermSession[]; detached?: DetachedSession[] }>('/terminal/label', { method: 'POST' });
  return { sessions: r.sessions, detached: r.detached ?? [] };
}

// The Run-now button: queue a manual job the host dispatcher picks up within
// a minute. An already open job for the project comes back instead.
// A session plan can ride along (#228/#255): `kind` picks the runner mode
// (build | plan | debug | audit), `agenda` is the ORDERED list of roadmap ids
// (or BUG-N keys for debug) it must work, `area` scopes an agenda-less pick.
export interface SessionPlanInput {
  itemId?: string;
  kind?: 'build' | 'plan' | 'debug' | 'audit';
  agenda?: (string | number)[];
  area?: string;
}
export async function startAutopilot(
  slug: string, opts?: string | SessionPlanInput,
): Promise<AutopilotJob> {
  const plan: SessionPlanInput = typeof opts === 'string' ? { itemId: opts } : (opts ?? {});
  const body: Record<string, unknown> = { slug };
  if (plan.itemId) body.itemId = plan.itemId;
  if (plan.kind) body.kind = plan.kind;
  if (plan.agenda?.length) body.agenda = plan.agenda.map(String);
  if (plan.area) body.area = plan.area;
  return request<AutopilotJob>('/autopilot/start', { method: 'POST', body });
}

// #142 — the paused-session controls. A session that hit the usage limit sits
// in the queue as a kind='resume' job holding until the reset: Resume clears
// the hold (the dispatcher then treats it as a manual press), hang-up parks it
// until resumed by hand, dismiss drops it entirely.
export async function resumeAutopilotJob(id: string): Promise<AutopilotJob> {
  return request<AutopilotJob>(`/autopilot/jobs/${id}`, {
    method: 'PATCH', body: { status: 'queued', notBefore: null },
  });
}
export async function hangupAutopilotJob(id: string): Promise<AutopilotJob> {
  return request<AutopilotJob>(`/autopilot/jobs/${id}`, { method: 'PATCH', body: { status: 'paused' } });
}
export async function dismissAutopilotJob(id: string): Promise<void> {
  await request(`/autopilot/jobs/${id}`, { method: 'DELETE' });
}
// The job queue without the full Mission Control payload — the Terminal's
// pending-resume chip reads it per project.
export async function getAutopilotJobs(slug?: string, limit = 20): Promise<AutopilotJob[]> {
  const qs = `${slug ? `slug=${encodeURIComponent(slug)}&` : ''}limit=${limit}`;
  return request<AutopilotJob[]>(`/autopilot/jobs?${qs}`);
}

// Token usage for the terminal header: autopilot_runs total for the last 24h
// and the nightly token budget from settings (0 = unlimited).
export interface TerminalUsageData { tokensToday: number; tokenBudget: number }
export async function getTerminalUsage(): Promise<TerminalUsageData> {
  return request<TerminalUsageData>('/terminal/usage');
}

export interface SchedulePayload {
  slug: string; atTime: string; days?: number[]; runDate?: string | null;
  itemId?: string | null; note?: string;
  kind?: SessionKind; agenda?: (number | string)[]; area?: string; // #228
}
export async function createAutopilotSchedule(payload: SchedulePayload): Promise<AutopilotSchedule> {
  return request<AutopilotSchedule>('/autopilot/schedule', { method: 'POST', body: payload });
}
export async function patchAutopilotSchedule(
  id: string, patch: Partial<Omit<SchedulePayload, 'slug'>> & { enabled?: boolean },
): Promise<AutopilotSchedule> {
  return request<AutopilotSchedule>(`/autopilot/schedule/${id}`, { method: 'PATCH', body: patch });
}
export async function deleteAutopilotSchedule(id: string): Promise<void> {
  await request(`/autopilot/schedule/${id}`, { method: 'DELETE' });
}

// ---- settings ----

export async function getSettings(): Promise<Settings> {
  return request<Settings>('/settings');
}
// accessPin is write-only: '' disables PIN sign-in, any change signs out all
// PIN-connected devices. It never appears in the returned Settings.
export async function patchSettings(patch: Partial<Settings> & { accessPin?: string }): Promise<Settings> {
  return request<Settings>('/settings', { method: 'PATCH', body: patch });
}

// ---- projects ----

export async function getProjects(): Promise<Project[]> {
  const rows = await request<ProjectPayload[]>('/projects');
  return rows.map(toProject);
}

export interface ProjectDetailData {
  project: Project;
  currentPhase: string;
  northStar: string;
  auditContext: string;  // the audit brief (#144) — the Testing panel's steer for the bug audit
  blockers: string[];
  directives: string[];
  activity: Activity[];
  bugs: Bug[];
  roadmap: Roadmap;
  notes: Note[];
  futures: Future[];
  checks: Check[];
  keepResumeCard: boolean;
  staleItemDays: number;   // parked-item stale threshold in days (#247) — ages the Parked view
  geminiReady: boolean;    // #278 — a key is configured; keyless hides the Quality page's AI surfaces
  shareToken: string;
  liveBranches: string[];  // branches with a live session right now — backs the board's in-progress lock
}

export async function getProjectDetail(slug: string): Promise<ProjectDetailData> {
  const d = await request<ProjectPayload & {
    activity: Activity[]; bugs: Bug[]; roadmap: Roadmap; notes: Note[]; futures?: Future[];
    checks?: Check[]; keepResumeCard?: boolean; shareToken?: string; liveBranches?: string[];
    auditContext?: string; staleItemDays?: number; geminiReady?: boolean;
  }>(`/projects/${encodeURIComponent(slug)}`);
  return {
    project: toProject(d), currentPhase: d.currentPhase || '', northStar: d.northStar || '',
    auditContext: d.auditContext || '',
    blockers: d.blockers || [], directives: d.directives || [],
    activity: d.activity, bugs: d.bugs, roadmap: d.roadmap, notes: d.notes, futures: d.futures || [],
    checks: d.checks || [],
    keepResumeCard: d.keepResumeCard !== false,
    // An older server that doesn't send it falls back to the same default (#247).
    staleItemDays: Number.isFinite(d.staleItemDays) ? Number(d.staleItemDays) : 21,
    // Default TRUE: an older server that doesn't report it keeps the AI surfaces
    // visible (they 503 honestly), rather than hiding features that do work.
    geminiReady: d.geminiReady !== false,
    shareToken: d.shareToken || '',
    liveBranches: d.liveBranches || [],
  };
}

// ---- the Review room (#282, GET /api/review) ----
//
// Cross-project, because the nights are: one payload holds every completed item
// nobody has verdicted yet (with the run that built it and the reviewer's stored
// read), the settled archive, and a fortnight of runs grouped by night for the
// debrief. Read-only — every verdict still goes through the per-project roadmap
// routes, so nothing here can mutate a tracker.

export interface ReviewRun {
  id: number;
  branch: string;
  outcome: string;
  commits: number;
  tokens: number;
  costUsd: number;
  checksFailing: number | null;
  summary: string;
  reviewVerdict: '' | 'clean' | 'concerns' | 'blocked';  // '' = no review ran
  reviewNote: string;
  reviewFindings: number | null;
  // #284 — the architect's structural read, beside the reviewer's correctness one.
  // '' = no architect pass ran (keyless, or a run that predates it).
  architectVerdict: '' | 'aligned' | 'drifting' | 'concerning';
  architectNote: string;
  architectObs: string[];
  when: string;
  finishedAt: string;
}

export interface ReviewItem {
  slug: string; name: string; tint: string | null;
  id: string; title: string; bucket: Priority;
  note: string; builtNote: string; refineNote: string;
  reviewTags: string[]; reviewTag: string; shelved: boolean;
  branch: string; origin: 'auto' | 'branch' | 'manual';
  when: string; doneAt: string; risk: string;
  run: ReviewRun | null;
}

export interface ReviewNightRun extends ReviewRun {
  slug: string; name: string; tint: string | null;
  itemId: string; itemTitle: string;
  day: string;   // UTC calendar day the run finished — the debrief groups on it
}

export interface ReviewData {
  queue: ReviewItem[];
  settled: ReviewItem[];
  nights: ReviewNightRun[];
  totals: { pending: number; shelved: number; flagged: number; projects: number; settled: number };
}

export async function getReview(): Promise<ReviewData> {
  return request<ReviewData>('/review');
}

// The one-shot hand-off behind the Review room's ＋ Bug / ＋ Audit: the room has
// no modals of its own (and no project loaded), so it stashes the prefill and
// opens the project, where ProjectDetail picks it up exactly once — the same
// pattern as the terminal brief and the Polaris thought.
export interface ReviewPrefill { kind: 'bug' | 'audit'; slug: string; itemId: string; title: string }
const REVIEW_PREFILL_KEY = 'stack.review.prefill';

export function setReviewPrefill(p: ReviewPrefill) {
  try { sessionStorage.setItem(REVIEW_PREFILL_KEY, JSON.stringify(p)); }
  catch { /* private mode — the modal just won't open prefilled */ }
}
export function takeReviewPrefill(slug: string): ReviewPrefill | null {
  try {
    const raw = sessionStorage.getItem(REVIEW_PREFILL_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as ReviewPrefill;
    if (p?.slug !== slug) return null;      // meant for a different project
    sessionStorage.removeItem(REVIEW_PREFILL_KEY);
    return p;
  } catch { return null; }
}

// ---- Gemini re-entry plan (POST .../replan — suggestion only) ----

export async function replanProject(slug: string): Promise<string> {
  const r = await request<{ plan: string }>(`/projects/${encodeURIComponent(slug)}/replan`, { method: 'POST' });
  return r.plan;
}

// ---- web terminal (ws to /term — the host PTY daemon behind nginx) ----

// The only place the terminal's transport and token live — the Terminal screen
// attaches its handlers to the returned socket but never touches storage. The
// start frame goes out on open; the daemon validates the token against the API
// before anything spawns.
export function openTerminal(opts: { cwd: string; cmd: 'shell' | 'claude'; cols: number; rows: number; tmuxSession?: string; skipPerms?: boolean; polaris?: boolean }): WebSocket {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${window.location.host}/term`);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ t: 'start', token: getToken() || '', ...opts }));
  });
  return ws;
}

// Global terminal presence (#121): one lightweight ws per tab watching the
// relay's live-session count, so every open Stack instance shows whether a
// web terminal is running anywhere. The relay pushes {t:'status'} on connect
// and on every session start/end — no polling. While disconnected the status
// reads as quiet (server restarts aren't persisted, by design); a slow retry
// keeps long-lived tabs current.
// claude = browser-attached claude tabs; unattended = claude running on the
// host with no client anywhere (the pill shows it so a walked-away session is
// never invisible).
export interface TermStatus { active: boolean; count: number; claude: number; unattended: number }
export function watchTermStatus(cb: (s: TermStatus) => void): () => void {
  let ws: WebSocket | null = null;
  let retry: number | undefined;
  let closed = false;
  const connect = () => {
    if (closed) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${window.location.host}/term-status`);
    ws.addEventListener('open', () => {
      ws?.send(JSON.stringify({ t: 'watch', token: getToken() || '' }));
    });
    ws.addEventListener('message', (e) => {
      try {
        const m = JSON.parse(String(e.data));
        if (m.t === 'status') {
          cb({
            active: !!m.active,
            count: Number(m.count) || 0,
            claude: Number(m.claude) || 0,
            unattended: Number(m.unattended) || 0,
          });
        }
      } catch { /* not a status frame — ignore */ }
    });
    ws.addEventListener('close', () => {
      cb({ active: false, count: 0, claude: 0, unattended: 0 });
      if (!closed) retry = window.setTimeout(connect, 15_000);
    });
  };
  connect();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}

// Quick commands on the Terminal screen — device-local, like brief prefs.
export interface TermCmd { label: string; cmd: string }
const TERM_CMDS_KEY = 'stack.termCmds';
export function getTermCmds(): TermCmd[] {
  return readStoredJSON(TERM_CMDS_KEY, (p) => (Array.isArray(p) ? p : []));
}
export function setTermCmds(list: TermCmd[]) {
  localStorage.setItem(TERM_CMDS_KEY, JSON.stringify(list));
}

// The Terminal screen's usage strip — device-local, like the quick commands.
// dailyLimit is the token budget the bar fills against (a personal estimate;
// Anthropic doesn't publish the real number). lastAutoKey remembers the last
// booked reset slot so neither a reload nor the next usage frame double-books.
export interface TermUsagePrefs { dailyLimit: number; autoSchedule: boolean; lastAutoKey: string }
const TERM_USAGE_KEY = 'stack.termUsage';
export function getTermUsagePrefs(): TermUsagePrefs {
  return readStoredJSON(TERM_USAGE_KEY, (p) => ({
    dailyLimit: Number(p?.dailyLimit) > 0 ? Number(p.dailyLimit) : 10_000_000,
    autoSchedule: !!p?.autoSchedule,
    lastAutoKey: typeof p?.lastAutoKey === 'string' ? p.lastAutoKey : '',
  }));
}
export function setTermUsagePrefs(p: TermUsagePrefs) {
  localStorage.setItem(TERM_USAGE_KEY, JSON.stringify(p));
}

// The Terminal screen's view preferences (#136) — device-local, like the
// usage prefs above: the cockpit rail's collapse, wide mode, and (25b) which
// of the rail's two segments it opens on.
export interface TermViewPrefs { railOpen: boolean; wide: boolean; railSeg: 'session' | 'runbook' }
const TERM_VIEW_KEY = 'stack.termView';
export function getTermViewPrefs(): TermViewPrefs {
  // Rail defaults COLLAPSED — the terminal canvas is the point of the screen;
  // expand it when you want the cockpit (the choice sticks per device).
  return readStoredJSON(TERM_VIEW_KEY, (p) => ({
    railOpen: p?.railOpen === true,
    wide: !!p?.wide,
    railSeg: p?.railSeg === 'runbook' ? 'runbook' as const : 'session' as const,
  }));
}
export function setTermViewPrefs(p: TermViewPrefs) {
  localStorage.setItem(TERM_VIEW_KEY, JSON.stringify(p));
}

// 25b — what the terminal session was handed to work on, device-local and
// keyed by cwd. Stack has no server-side notion of "the item this TAB is on"
// (a claim belongs to a BRANCH, not a browser tab — #277), so pinning it here is
// the honest version: it records what YOU sent to the prompt, and nothing
// downstream reads it. Cleared by passing null.
const TERM_WORKING_KEY = 'stack.termWorking';
function readWorkingMap(): Record<string, number> {
  return readStoredJSON(TERM_WORKING_KEY, (m) => (m && typeof m === 'object' ? m : {}));
}
export function getTermWorkingItem(cwd: string): number | null {
  const v = readWorkingMap()[cwd];
  return typeof v === 'number' && v > 0 ? v : null;
}
export function setTermWorkingItem(cwd: string, id: number | null) {
  const m = readWorkingMap();
  if (id) m[cwd] = id; else delete m[cwd];
  localStorage.setItem(TERM_WORKING_KEY, JSON.stringify(m));
}

// How the Terminal screen opens sessions — device-local, edited from the
// Settings screen's Terminal card (like the theme). autoStart is what the
// screen opens on arrival and what a Mission Control ⌨ press opens;
// skipPermissions runs claude sessions with --dangerously-skip-permissions
// (the daemon allow-lists the flag — the browser only ever sends a boolean).
export interface TermSessionPrefs { autoStart: 'claude' | 'shell'; skipPermissions: boolean }
const TERM_SESSION_KEY = 'stack.termSession';
export function getTermSessionPrefs(): TermSessionPrefs {
  return readStoredJSON(TERM_SESSION_KEY, (p) => ({
    autoStart: p?.autoStart === 'shell' ? 'shell' as const : 'claude' as const,
    skipPermissions: p?.skipPermissions !== false,
  }));
}
export function setTermSessionPrefs(p: TermSessionPrefs) {
  localStorage.setItem(TERM_SESSION_KEY, JSON.stringify(p));
}

// ✧ Gemini command help in the terminal rail — describe what you want to do,
// get one shell command back. Suggestion only: nothing runs until the human
// types it into the terminal themselves. 503 when the server has no key.
export interface TermAssistSuggestion { command: string; label: string; explanation: string }
export async function termAssist(prompt: string, cwd: string): Promise<TermAssistSuggestion> {
  return request<TermAssistSuggestion>('/terminal/assist', { method: 'POST', body: { prompt, cwd } });
}

// Detached tmux sessions (#188 follow-up) — claude sessions still running on
// the host with no browser attached (what a page reload orphans). The list
// comes from the relay's cache of the daemon's advertisements; killing goes
// back through the same channel, and the daemon refuses names that aren't
// actually detached.
export interface DetachedSession {
  name: string; cwd: string; created: number;
  attached?: boolean;  // a client holds it elsewhere (another browser / laptop ssh) — attach mirrors it
  label?: string;      // ✧ Gemini's take on what it's doing
}
export async function getDetachedSessions(): Promise<DetachedSession[]> {
  const r = await request<{ sessions: DetachedSession[] }>('/terminal/detached');
  return r.sessions;
}
export async function killDetachedSession(name: string): Promise<void> {
  await request<{ ok: boolean }>('/terminal/detached/kill', { method: 'POST', body: { name } });
}

// Device-local cwd → tmux session name memory, so a page reload re-attaches
// the same claude session automatically instead of spawning a fresh one.
// Written on the daemon's ready frame, cleared when the session really ends
// (an exit frame while attached — a detach never sends one).
const TERM_TMUX_KEY = 'stack.termTmux';
function readTmuxMap(): Record<string, string> {
  return readStoredJSON(TERM_TMUX_KEY, (m) => (m && typeof m === 'object' ? m : {}));
}
export function getTermTmuxName(cwd: string): string | null {
  return readTmuxMap()[cwd] || null;
}
export function setTermTmuxName(cwd: string, name: string) {
  const m = readTmuxMap();
  m[cwd] = name;
  localStorage.setItem(TERM_TMUX_KEY, JSON.stringify(m));
}
// Clears only when the mapping still points at this name — a newer session in
// the same cwd must not lose its entry to an older tab's exit.
export function clearTermTmuxName(cwd: string, name: string) {
  const m = readTmuxMap();
  if (m[cwd] !== name) return;
  delete m[cwd];
  localStorage.setItem(TERM_TMUX_KEY, JSON.stringify(m));
}

// Polaris (#209) is no longer a server chat route — it's a claude session over
// openTerminal() above (components/PolarisTerm.tsx); the Gemini polaris/intake
// routes were culled with it.

// ---- Gemini judge assist (POST .../futures/:id/judge — suggestion only) ----

export interface JudgeSuggestion { alignment: 'on-course' | 'tangent' | 'off-course'; why: string }

export async function judgeFuture(slug: string, id: number): Promise<JudgeSuggestion> {
  return request<JudgeSuggestion>(
    `/projects/${encodeURIComponent(slug)}/futures/${id}/judge`, { method: 'POST' });
}

// ---- Gemini theme clustering (POST .../futures/cluster — suggestions only;
// the human applies each through the normal PATCH) ----

export interface ClusterSuggestion { id: number; currentTitle: string; area: string }

export async function clusterFutures(slug: string): Promise<ClusterSuggestion[]> {
  const r = await request<{ items: ClusterSuggestion[] }>(
    `/projects/${encodeURIComponent(slug)}/futures/cluster`, { method: 'POST' });
  return r.items;
}

// ---- converge (POST .../futures/converge — Gemini drafts tickets from picked
// ideas; drafts only, the client creates through the normal roadmap POST) ----

export interface ConvergeDraft {
  title: string;
  note: string;
  bucket: 'must' | 'should' | 'could';
  area: string;
  plan: string[];
  sources: number[];
}

export async function convergeFutures(
  slug: string, ids: number[], mode: 'tickets' | 'epic',
): Promise<ConvergeDraft[]> {
  const r = await request<{ items: ConvergeDraft[] }>(
    `/projects/${encodeURIComponent(slug)}/futures/converge`, { method: 'POST', body: { ids, mode } });
  return r.items;
}

// ---- timeline (GET /api/timeline — cross-project pushes + contribution graph) ----

export interface TimelineEntry {
  slug: string; name: string; tint: string | null; hash: string; branch: string;
  summary: string; tags: string[]; geminiNote: string; authored: boolean; time: string;
}
export interface TimelineDay { date: string; label: string; entries: TimelineEntry[] }
export interface TimelineData { days: TimelineDay[]; graph: { date: string; count: number }[]; total: number }

export async function getTimeline(): Promise<TimelineData> {
  return request<TimelineData>('/timeline');
}

// ---- deleted projects (the soft-delete bin: restore or purge from Settings) ----

export interface DeletedProject { slug: string; name: string; when: string }

export async function getDeletedProjects(): Promise<DeletedProject[]> {
  return request<DeletedProject[]>('/projects/deleted');
}

export async function restoreProject(slug: string): Promise<void> {
  await request<void>(`/projects/${encodeURIComponent(slug)}/restore`, { method: 'POST' });
}

export async function purgeProject(slug: string): Promise<void> {
  await request<void>(`/projects/${encodeURIComponent(slug)}/purge`, { method: 'DELETE' });
}

// ---- public showcase (tokenless — guarded by its own per-project key) ----

export interface Showcase {
  name: string; subtitle: string; status: ProjectStatus; tint: string | null;
  siteUrl: string; progress: number; summary: string; currentPhase: string;
  techStack: string[]; lastPush: string; activity: Activity[];
}

export async function getShowcase(slug: string, share: string): Promise<Showcase> {
  const res = await fetch(`/api/public/${encodeURIComponent(slug)}/${encodeURIComponent(share)}`);
  if (!res.ok) {
    throw new Error(res.status === 404
      ? 'This showcase link is no longer live.' : `Request failed (${res.status})`);
  }
  return (await res.json()) as Showcase;
}

export async function createShareLink(slug: string): Promise<string> {
  const r = await request<{ shareToken: string }>(`/projects/${encodeURIComponent(slug)}/share`, { method: 'POST' });
  return r.shareToken;
}

export async function deleteShareLink(slug: string): Promise<void> {
  await request<void>(`/projects/${encodeURIComponent(slug)}/share`, { method: 'DELETE' });
}

export async function createProject(input: { name: string; subtitle: string; status: ProjectStatus }): Promise<Project> {
  return toProject(await request<ProjectPayload>('/projects', { method: 'POST', body: input }));
}

export async function patchProject(
  slug: string,
  patch: Partial<{
    subtitle: string; site_url: string; repo_url: string; status: ProjectStatus; pinned: boolean;
    automode: boolean; autopilot_area: string;
    name: string; north_star: string; directives: string[]; deploy_platform: string; logs_url: string;
    tech_stack: string[]; audit_context: string;
  }>,
): Promise<Project> {
  return toProject(await request<ProjectPayload>(`/projects/${encodeURIComponent(slug)}`, { method: 'PATCH', body: patch }));
}

export async function deleteProject(slug: string): Promise<void> {
  await request<void>(`/projects/${encodeURIComponent(slug)}`, { method: 'DELETE' });
}

// ---- bugs ----

const bugsBase = (slug: string) => `/projects/${encodeURIComponent(slug)}/bugs`;

export async function getBugs(slug: string): Promise<Bug[]> {
  return request<Bug[]>(bugsBase(slug));
}
// `check_id` (#278) links the bug to the check that caught it — set when the
// Quality page files a bug straight off a red check.
export async function createBug(
  slug: string, input: { title: string; severity: Severity; check_id?: number | null },
): Promise<Bug> {
  return request<Bug>(bugsBase(slug), { method: 'POST', body: input });
}
export async function patchBug(
  slug: string, bugKey: string,
  patch: Partial<{ status: BugStatus; severity: Severity; title: string; reviewed: boolean; check_id: number | null }>,
): Promise<Bug> {
  return request<Bug>(`${bugsBase(slug)}/${encodeURIComponent(bugKey)}`, { method: 'PATCH', body: patch });
}
export async function deleteBug(slug: string, bugKey: string): Promise<void> {
  await request<void>(`${bugsBase(slug)}/${encodeURIComponent(bugKey)}`, { method: 'DELETE' });
}

// ---- roadmap ----

const roadmapBase = (slug: string) => `/projects/${encodeURIComponent(slug)}/roadmap`;

export async function getRoadmap(slug: string): Promise<Roadmap> {
  return request<Roadmap>(roadmapBase(slug));
}
export async function createRoadmapItem(
  slug: string, input: { title: string; note: string; bucket: Priority; claimed_by?: string; area?: string; plan?: PlanStep[]; risk?: RoadmapItem['risk']; tier?: RoadmapItem['tier'] },
): Promise<RoadmapItem> {
  return request<RoadmapItem>(roadmapBase(slug), { method: 'POST', body: input });
}
export async function patchRoadmapItem(
  slug: string, id: number,
  patch: Partial<{
    done: boolean; bucket: Priority; title: string; note: string; reviewed: boolean;
    claimed_by: string; review_tag: string; review_tags: string[]; refine_note: string;
    review_shelved: boolean; skipped: boolean; area: string; position: number;
    built_note: string; plan: PlanStep[]; risk: RoadmapItem['risk'];
    tier: RoadmapItem['tier'];   // #227 — desire rank; '' unranks it
  }>,
): Promise<RoadmapItem> {
  return request<RoadmapItem>(`${roadmapBase(slug)}/${id}`, { method: 'PATCH', body: patch });
}
export async function deleteRoadmapItem(slug: string, id: number): Promise<void> {
  await request<void>(`${roadmapBase(slug)}/${id}`, { method: 'DELETE' });
}
// The autopilot's run ledger — the Reviews view labels completed items with
// the session that built them (branch, commits, tokens, the run's own summary).
export async function getAutopilotRuns(slug: string): Promise<AutopilotRun[]> {
  return request<AutopilotRun[]>(`/projects/${encodeURIComponent(slug)}/autopilot/runs`);
}
// ✧ Reviewer's brief for a completed item (#134): Gemini reads the item, its
// built_note, the run that built it and the project's checks — returns what
// shipped, hands-on test steps and likely risks. Annotation only, never stored.
export interface ReviewBrief { summary: string; test: string[]; risks: string[] }
export async function getReviewBrief(slug: string, id: number): Promise<ReviewBrief> {
  return request<ReviewBrief>(`${roadmapBase(slug)}/${id}/review-brief`, { method: 'POST' });
}
// ⎌ Undo a completed item (#128): queues a revert job — the host dispatcher
// reverts the item's #N-tagged commits on main in a throwaway worktree, pushes,
// and un-ticks the item so it returns to the board fresh.
export async function queueUndo(slug: string, itemId: number): Promise<AutopilotJob> {
  return request<AutopilotJob>('/autopilot/undo', { method: 'POST', body: { slug, itemId } });
}
// ⇥ Merge a claim branch (#154): queues a merge job — the host dispatcher fetches,
// merges origin/<branch> into main with --no-ff in a throwaway worktree, pushes
// main, and deletes the remote branch on success. Conflicts fail safely.
// itemId is advisory metadata only — the dispatcher does NOT tick the item.
// #193: other queued merges never block a new one (trains run sequentially via
// /next, each from the fresh main the last one pushed); aiResolve opts a dirty
// branch into the dispatcher's claude conflict-resolution pass.
export async function queueMerge(slug: string, branch: string, itemId?: string, aiResolve?: boolean): Promise<AutopilotJob> {
  return request<AutopilotJob>('/autopilot/merge', {
    method: 'POST',
    body: { slug, branch, ...(itemId ? { itemId } : {}), ...(aiResolve ? { aiResolve: true } : {}) },
  });
}
// Gemini titles an item from its note (the modal's ✧ button) — suggestion only.
export async function suggestRoadmapTitle(slug: string, note: string): Promise<string> {
  const r = await request<{ title: string }>(`${roadmapBase(slug)}/suggest-title`, { method: 'POST', body: { note } });
  return r.title;
}

// Gemini fills the whole item from its note — title, tidied note, area, branch
// claim, priority. Suggestion only: it prefills the modal, the human saves.
// #277 — the assist may also propose a desire tier. Like every other field it
// is a SUGGESTION: the modal only takes it into an empty tier, so a tier set by
// hand is never re-decided.
export interface RoadmapAssist {
  title: string; note: string; area: string; branch: string; priority: Priority | null;
  tier: RoadmapItem['tier'];   // #277 — '' when the assist has no opinion or the field is off
}
export async function assistRoadmapItem(slug: string, note: string): Promise<RoadmapAssist> {
  return request<RoadmapAssist>(`${roadmapBase(slug)}/assist`, { method: 'POST', body: { note } });
}

// Gemini reviews the open board and proposes fixes (areas, titles, buckets).
// Suggestions only — applied per-row by the human through the normal PATCH.
export interface RoadmapCleanupSuggestion {
  id: number; currentTitle: string; area?: string; title?: string; bucket?: Priority; why: string;
}
export async function cleanupRoadmap(slug: string): Promise<RoadmapCleanupSuggestion[]> {
  const r = await request<{ items: RoadmapCleanupSuggestion[] }>(`${roadmapBase(slug)}/cleanup`, { method: 'POST', body: {} });
  return r.items;
}

// ---- futures ----

const futuresBase = (slug: string) => `/projects/${encodeURIComponent(slug)}/futures`;

export async function getFutures(slug: string): Promise<Future[]> {
  return request<Future[]>(futuresBase(slug));
}
export async function createFuture(slug: string, input: { title: string; note?: string }): Promise<Future> {
  return request<Future>(futuresBase(slug), { method: 'POST', body: input });
}
export async function patchFuture(
  slug: string, id: number,
  patch: Partial<{ title: string; note: string; reviewed: boolean; alignment: string; area: string; canvasX: number | null; canvasY: number | null }>,
): Promise<Future> {
  return request<Future>(`${futuresBase(slug)}/${id}`, { method: 'PATCH', body: patch });
}
export async function deleteFuture(slug: string, id: number): Promise<void> {
  await request<void>(`${futuresBase(slug)}/${id}`, { method: 'DELETE' });
}

// ---- checks (the Audit tab) ----

const checksBase = (slug: string) => `/projects/${encodeURIComponent(slug)}/checks`;

// What a check is made of, snake_case as the API takes it (#143): method +
// req_body exercise a function; contains / json_path+json_expect / semantic
// are the assertions.
export interface CheckInput {
  name: string; url: string; method?: string; expect_status?: number;
  req_body?: string; contains?: string; json_path?: string; json_expect?: string; semantic?: string;
  auth?: boolean;      // #261 — the server attaches its own bearer token (same-origin URLs only)
}

export async function getChecks(slug: string): Promise<Check[]> {
  return request<Check[]>(checksBase(slug));
}
export async function createCheck(slug: string, input: CheckInput): Promise<Check> {
  return request<Check>(checksBase(slug), { method: 'POST', body: input });
}
// Edit a check in place; changing anything but the name clears its stored result.
export async function patchCheck(slug: string, id: number, patch: Partial<CheckInput>): Promise<Check> {
  return request<Check>(`${checksBase(slug)}/${id}`, { method: 'PATCH', body: patch });
}
export async function deleteCheck(slug: string, id: number): Promise<void> {
  await request<void>(`${checksBase(slug)}/${id}`, { method: 'DELETE' });
}
// Run all checks (or one, by id); returns the updated rows.
export async function runChecks(slug: string, id?: number): Promise<Check[]> {
  return request<Check[]>(`${checksBase(slug)}/run`, { method: 'POST', body: id ? { id } : {} });
}
// The run history, newest first — the Quality page's pass-rate trend + ledger.
export async function getCheckRuns(slug: string, limit = 40): Promise<CheckRun[]> {
  return request<CheckRun[]>(`${checksBase(slug)}/runs?limit=${limit}`);
}
// #279 — each check's own last N results, keyed by check id, newest first. One
// query behind one fetch; the Suite sparklines and the red-row diagnosis are
// both derived from it client-side. An older server 404s → an empty history,
// which every consumer already reads as "no memory yet".
export async function getCheckHistory(slug: string, limit = 20): Promise<CheckHistory> {
  return request<CheckHistory>(`${checksBase(slug)}/history?limit=${limit}`);
}

// #260 — how many sessions the Plan room assumes you run in parallel. A
// PLANNING lens, not a runner setting: the overnight autopilot is one lane, the
// rest are sessions you (or another machine) start, and Stack's branch claims
// already keep them off each other's items. Device-local, because it describes
// how you intend to work rather than what the server does.
const PLAN_LANES_KEY = 'stack.planLanes';
export const PLAN_LANE_CHOICES = [1, 2, 3, 4] as const;

export function getPlanLanes(): number {
  return readStoredJSON(PLAN_LANES_KEY, (v) =>
    (typeof v === 'number' && PLAN_LANE_CHOICES.includes(v as 1 | 2 | 3 | 4) ? v : 1));
}
export function setPlanLanes(n: number) {
  localStorage.setItem(PLAN_LANES_KEY, JSON.stringify(n));
}

// #251 — the Roadmap board's layout, per project. Which bucket column is
// FOCUSED (fills the board, the others fold away), which columns are folded to
// their header, and which tier rows are folded on the Tiers view. Device-local
// and keyed by slug, because it describes how you like to look at THIS board,
// not anything about the work. Absent or corrupt storage falls back to the
// all-sections-open default, so a wiped browser behaves exactly as before.
export interface BoardLayout {
  focus: Priority | null;
  collapsed: Priority[];
  foldedTiers: Tier[];
}
const BOARD_LAYOUT_KEY = (slug: string) => `stack.boardLayout.${slug}`;
const BUCKETS: Priority[] = ['must', 'should', 'could', 'wont'];
const TIER_KEYS: Tier[] = ['S', 'A', 'B', 'C', ''];

export function getBoardLayout(slug: string): BoardLayout {
  return readStoredJSON(BOARD_LAYOUT_KEY(slug), (p) => {
    const o = (p && typeof p === 'object') ? p as Record<string, unknown> : {};
    const list = <T,>(v: unknown, allowed: readonly T[]): T[] =>
      Array.isArray(v) ? [...new Set(v.filter((x): x is T => allowed.includes(x as T)))] : [];
    const focus = BUCKETS.includes(o.focus as Priority) ? o.focus as Priority : null;
    return { focus, collapsed: list(o.collapsed, BUCKETS), foldedTiers: list(o.foldedTiers, TIER_KEYS) };
  });
}
export function setBoardLayout(slug: string, layout: BoardLayout) {
  try { localStorage.setItem(BOARD_LAYOUT_KEY(slug), JSON.stringify(layout)); }
  catch { /* storage full or unavailable — the layout is a nicety, never a blocker */ }
}

// ---- tips (the app-wide recipe library — the Tips tab) ----

// The recipe rail's collapsed state — device-local, like the theme. Collapsed
// = the detail pane takes the full width; a slim strip re-opens the list.
const TIPS_RAIL_KEY = 'stack.tipsRail';

export function getTipsRailCollapsed(): boolean {
  return readStoredJSON(TIPS_RAIL_KEY, (p) => p === true);
}
export function setTipsRailCollapsed(collapsed: boolean) {
  localStorage.setItem(TIPS_RAIL_KEY, JSON.stringify(collapsed));
}

// What a recipe is made of, as the API takes it. `best` is the whole
// "works best when" list; PATCH takes any subset (incl. { pinned }).
export interface TipInput {
  name: string; stage?: string; surface?: string; blurb?: string;
  when?: string; prompt: string; best?: string[]; who?: string; pinned?: boolean;
}

export async function getTips(): Promise<Tip[]> {
  return request<Tip[]>('/tips');
}
export async function createTip(input: TipInput): Promise<Tip> {
  return request<Tip>('/tips', { method: 'POST', body: input });
}
export async function patchTip(id: number, patch: Partial<TipInput>): Promise<Tip> {
  return request<Tip>(`/tips/${id}`, { method: 'PATCH', body: patch });
}
export async function deleteTip(id: number): Promise<void> {
  await request<void>(`/tips/${id}`, { method: 'DELETE' });
}
// Record a run (uses + last-run stamp); the run itself is the terminal
// session the caller opens with the recipe's prompt.
export async function runTip(id: number): Promise<Tip> {
  return request<Tip>(`/tips/${id}/run`, { method: 'POST', body: {} });
}

// ---- automated bug audit (#144) ----

// One audit finding and what happened to it: 'logged' = a new review-inbox bug
// (carried in `bug`), 'duplicate' = already tracked, 'dismissed' = tombstoned.
export interface AuditFinding {
  title: string;
  severity: Severity;
  evidence: string;
  outcome: 'logged' | 'duplicate' | 'dismissed';
  bug: Bug | null;
}
export interface AuditResult { findings: AuditFinding[]; logged: number; skipped: number }

// Gemini audits the project (brief + checks + tracked bugs + the live page)
// and files suspected bugs straight into the review inbox — the human keeps
// or dismisses each one from there.
export async function runAudit(slug: string): Promise<AuditResult> {
  return request<AuditResult>(`/projects/${encodeURIComponent(slug)}/audit`, { method: 'POST' });
}
// The deep-audit hand-off: the same context composed as a prompt for a Claude
// session (keyless — the client copies it to the clipboard).
export async function getAuditPrompt(slug: string): Promise<string> {
  const r = await request<{ prompt: string }>(`/projects/${encodeURIComponent(slug)}/audit/prompt`);
  return r.prompt;
}

// ---- inbox triage (#76 — Gemini's cross-project review assist) ----

// One annotation entry in the triage result, keyed by ref (kind:slug:id).
export interface TriageAnnotation {
  action?: 'keep' | 'dismiss' | null;  // Gemini's suggestion
  reason?: string;                       // one-liner for that suggestion
  clusterLabel?: string;                 // near-duplicate cluster this item belongs to
  currentSeverity?: string;             // bug's current severity (when flagged)
  suggestedSeverity?: string;           // Gemini's suggested severity
  severityReason?: string;              // why the severity looks wrong
}

export interface TriageResult {
  clusters: { label: string; refs: string[] }[];
  severityFlags: { ref: string; current: string; suggested: string; reason: string }[];
  suggestions: { ref: string; action: 'keep' | 'dismiss'; reason: string }[];
  annotations: Record<string, TriageAnnotation>;
}

// Gathers the current review inbox (up to 40 items) and asks Gemini for
// clusters, severity sanity flags and keep/dismiss suggestions. Never writes
// state — all annotations are in-memory, the human applies them via the
// existing Keep/Dismiss handlers. 503 when the server has no Gemini key.
export async function triageInbox(): Promise<TriageResult> {
  return request<TriageResult>('/triage', { method: 'POST' });
}

// ---- notes ----

const notesBase = (slug: string) => `/projects/${encodeURIComponent(slug)}/notes`;

export async function getNotes(slug: string): Promise<Note[]> {
  return request<Note[]>(notesBase(slug));
}
export async function createNote(slug: string, input: { text: string; colour?: string }): Promise<Note> {
  return request<Note>(notesBase(slug), { method: 'POST', body: input });
}
export async function patchNote(slug: string, id: number, patch: { text: string }): Promise<Note> {
  return request<Note>(`${notesBase(slug)}/${id}`, { method: 'PATCH', body: patch });
}
export async function deleteNote(slug: string, id: number): Promise<void> {
  await request<void>(`${notesBase(slug)}/${id}`, { method: 'DELETE' });
}
