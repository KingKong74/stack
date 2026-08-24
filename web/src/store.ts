import type {
  Project, Resume, Activity, Bug, Roadmap, RoadmapItem, Note, Check, CheckRun, CheckHistory, Overview,
  ProjectStatus, Priority, Severity, BugStatus, SearchResponse, Settings, AutopilotRun, PlanStep,
  AuthDevice, Tier, ResumeSince, ProjectDebrief,
  WorkbenchData, WorkbenchCard, WorkbenchEdge, WorkbenchBody, WorkbenchOp,
  WorkbenchDebrief, SchedSpan, BoardShape, BoardArea, BoardLabel, BoardList, ProjectPulse,
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

// Carries the HTTP status alongside the server's message, so a caller that
// needs to tell "not found" apart from any other failure (#276 — the
// terminal's debrief panel) can check `.status` instead of pattern-matching
// message text, which is exactly the fragility that broke it the first time.
// #321 arrived with an identical class named ApiError, for the same reason on
// a different caller (a 409 meaning "already there" is an outcome, not a
// failure). One class, one name: this is it.
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'HttpError'; }
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

// ---- auto refresh (#312, device-local like the theme) ----
//
// How often a screen that watches something MOVING re-reads it: the terminal's
// running sessions, the branch previews, Mission Control's queue, the skill
// tree. All four change on the HOST's clock — a preview goes queued → starting
// → live, a session is reaped, a night's job finishes — so without a re-read
// the only way to learn about it was to reload the page.
//
// Device-local, deliberately: the polling is done by the BROWSER, so it is a
// property of the device doing it rather than of the system being watched. A
// phone on mobile data and the desktop beside the terminal want different
// answers, and a server-side setting could not give them one. (Contrast
// `termIdleHours`, which is app-wide because the HOST does that killing.)
//
// 0 = off — nothing polls, and the screens fall back to what they already did:
// re-read on arrival and after an action. Every recurring re-fetch in the app
// goes through `lib/autoRefresh.ts`, so this one control governs the lot;
// don't add a bare setInterval beside it.
export const AUTO_REFRESH_CHOICES = [0, 10, 30, 60] as const;
export type AutoRefreshSeconds = (typeof AUTO_REFRESH_CHOICES)[number];
const AUTO_REFRESH_KEY = 'stack.autoRefresh';

export function getAutoRefreshSeconds(): AutoRefreshSeconds {
  const n = Number(localStorage.getItem(AUTO_REFRESH_KEY));
  return (AUTO_REFRESH_CHOICES as readonly number[]).includes(n)
    ? n as AutoRefreshSeconds
    : 30; // the cadence the hardcoded polls used before this was a choice
}

export function setAutoRefreshSeconds(s: AutoRefreshSeconds) {
  localStorage.setItem(AUTO_REFRESH_KEY, String(s));
  for (const cb of refreshListeners) cb();
}

// Changing the setting takes hold on every open screen at once — the hook
// re-arms on this rather than waiting for the reload it exists to avoid.
let refreshListeners: Array<() => void> = [];
export function onAutoRefreshChange(cb: () => void): () => void {
  refreshListeners.push(cb);
  return () => { refreshListeners = refreshListeners.filter((x) => x !== cb); };
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
    throw new HttpError(res.status, msg);
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
  weekZero?: string | null;   // the Roadmap timeline's week zero; absent on an older server
  siteUrl: string; repo: string; repoUrl: string;
  pushesThisWeek: number;
  // detail-only:
  summary?: string; currentPhase?: string; northStar?: string;
  deployPlatform?: string; logsUrl?: string; techStack?: string[];
  inProgress?: string[]; nextUp?: string[]; workingWell?: string[]; blockers?: string[];
  directives?: string[];
  ref?: string; when?: string; resumeSince?: ResumeSince | null;
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
    since: d.resumeSince ?? null,
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
    weekZero: d.weekZero ?? null,
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
  return request<SearchResponse>(`/search?q=${encodeURIComponent(query)}`);
}

// #363 — 'auto': ▶ Run queues this project's mergeable branches; 'plan': they
// are named in the proposed plan but merge one press each; 'off': out of the
// plan. The Merge room that pressed the button is culled; the COLUMN is the
// autopilot's and outlived it.
export type MergeAutonomy = 'auto' | 'plan' | 'off';

// A permission prompt a host session has stopped on. `fingerprint` is the
// handle answerPrompt() sends back: the host re-reads the pane and refuses
// unless the prompt it finds is still this exact one, so a stale row cannot
// approve something the human never read. Rides on DetachedSession — a
// terminal concern, not one of the culled rooms'.
export interface BlockedPrompt {
  question: string;
  title: string;
  detail: string;        // the command, the file, the URL — what it is ABOUT
  options: { n: number; label: string }[];
  yes: number;           // the plain Yes, never "and don't ask again"
  fingerprint: string;
  since: number;         // epoch ms the relay first saw this question
}

// ---- the autopilot's jobs and schedules ----
//
// The NIGHTLY RUNNER outlived Mission Control. Its rooms were the console, but
// the queue itself is the host dispatcher's and is read from two surviving
// places: the Terminal screen's pending-resume chip, and the session planner.
// So these types and calls stayed while the rooms' own payload (`/api/control`)
// went — a job is not a room.

// #228 — the session planner: what a scheduled session IS, beyond a time slot.
export type SessionKind = 'build' | 'plan' | 'debug' | 'audit' | 'refine';

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
  id: string; slug: string; name: string; tint: string | null;
  kind: 'manual' | 'nightly' | 'scheduled' | 'revert' | 'resume' | 'merge' | 'plan' | 'advise';
  itemId: string | null; itemTitle: string;
  // 'paused' = hung up (#142): held until a human resumes; never auto-fires.
  status: 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'paused';
  detail: string;
  notBefore?: string | null;  // a resume job's hold — ISO, null once resumed by hand
  sessionKind?: SessionKind;           // #228 — the session plan the job carries
  agenda?: (number | string)[];
  area?: string;
  branch: string;
  adviceReady: boolean;
  when: string;
  nightDate: string | null;   // (#266) the night this job's fan-out belongs to, or null
  tokenBudget: number | null; // (#266) this job's share of the night's token budget, or null
}

export interface TermSession {
  sid: string; cwd: string; cmd: 'shell' | 'claude';
  startedAt: number;       // epoch ms
  label: string;           // ✧ Gemini's take on what it's doing ('' until asked)
  tmux?: string;           // the host tmux session behind a claude tab ('' for
                           // shells / pre-tmux daemons) — the jump-in target
}

// ✧ Label the terminal sessions — live ones AND the detached tmux survivors —
// in one Gemini pass over each session's recent output (annotation only; 503
// when the server has no key).
export async function labelTerminalSessions(): Promise<{ sessions: TermSession[]; detached: DetachedSession[] }> {
  const r = await request<{ sessions: TermSession[]; detached?: DetachedSession[] }>('/terminal/label', { method: 'POST' });
  return { sessions: r.sessions, detached: r.detached ?? [] };
}

// #142 — the paused-session controls. A session that hit the usage limit sits
// in the queue as a kind='resume' job holding until the reset: Resume clears
// the hold (the dispatcher then treats it as a manual press), hang-up parks it
// until resumed by hand.
export async function resumeAutopilotJob(id: string): Promise<AutopilotJob> {
  return request<AutopilotJob>(`/autopilot/jobs/${id}`, {
    method: 'PATCH', body: { status: 'queued', notBefore: null },
  });
}
export async function hangupAutopilotJob(id: string): Promise<AutopilotJob> {
  return request<AutopilotJob>(`/autopilot/jobs/${id}`, { method: 'PATCH', body: { status: 'paused' } });
}

// The job queue, read per project by the Terminal's pending-resume chip.
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
  blockers: string[];
  directives: string[];
  activity: Activity[];
  bugs: Bug[];
  roadmap: Roadmap;
  notes: Note[];
  checks: Check[];
  keepResumeCard: boolean;
  staleItemDays: number;   // parked-item stale threshold in days (#247) — ages the Parked view
  geminiReady: boolean;    // #278 — a key is configured; keyless hides the Quality page's AI surfaces
  agents: TabAgentState;   // #361 — which tab agent may act on this project's tabs, and which of its ops
  shareToken: string;
  liveBranches: string[];  // branches with a live session right now — backs the board's in-progress lock
  // The Overview spine's cadence strip: 28 UTC days, oldest first, zero-filled
  // server-side. EMPTY means an older server did not measure it — the strip is
  // then absent, never drawn as 28 quiet days.
  cadence: { day: string; n: number }[];
  lastPushAt: string | null; // raw stamp behind "quiet for N days"; null = never pushed
}

export async function getProjectDetail(slug: string): Promise<ProjectDetailData> {
  const d = await request<ProjectPayload & {
    activity: Activity[]; bugs: Bug[]; roadmap: Roadmap; notes: Note[];
    checks?: Check[]; keepResumeCard?: boolean; shareToken?: string; liveBranches?: string[];
    staleItemDays?: number; geminiReady?: boolean; agents?: TabAgentState;
    cadence?: { day: string; n: number }[]; lastPushAt?: string | null;
  }>(`/projects/${encodeURIComponent(slug)}`);
  return {
    project: toProject(d), currentPhase: d.currentPhase || '', northStar: d.northStar || '',
    blockers: d.blockers || [], directives: d.directives || [],
    activity: d.activity, bugs: d.bugs, roadmap: d.roadmap, notes: d.notes,
    checks: d.checks || [],
    keepResumeCard: d.keepResumeCard !== false,
    // An older server that doesn't send it falls back to the same default (#247).
    staleItemDays: Number.isFinite(d.staleItemDays) ? Number(d.staleItemDays) : 21,
    // Default TRUE: an older server that doesn't report it keeps the AI surfaces
    // visible (they 503 honestly), rather than hiding features that do work.
    geminiReady: d.geminiReady !== false,
    // #361 — same default direction one level down: an older server sends no
    // agent state, and `agentCan()` reads an absent agent as able to act, so a
    // tab never hides a feature the server would happily have run.
    agents: d.agents || {},
    shareToken: d.shareToken || '',
    liveBranches: d.liveBranches || [],
    cadence: d.cadence || [],
    lastPushAt: d.lastPushAt || null,
  };
}

// The terminal's "Jump back in" debrief: current resume state plus the last
// few commits (#276), shown so a session opened from the terminal screen
// arrives already briefed. NOT the autopilot's night debrief (GET /api/review).
export async function getProjectDebrief(slug: string): Promise<ProjectDebrief> {
  return request<ProjectDebrief>(`/projects/${encodeURIComponent(slug)}/debrief`);
}

// The Overview tab's three measured bands — model spend, the test suite, and
// how the autopilot's runs came out, over twelve weeks. A SECOND trip on
// purpose: it is the heaviest read on a project and no other tab needs it, so
// it must not sit in front of the detail payload every tab renders from.
// The Overview draws each band absent when its `measured` is false.
export async function getProjectPulse(slug: string): Promise<ProjectPulse> {
  return request<ProjectPulse>(`/projects/${encodeURIComponent(slug)}/pulse`);
}

// ---- web terminal (ws to /term — the host PTY daemon behind nginx) ----

// The only place the terminal's transport and token live — the Terminal screen
// attaches its handlers to the returned socket but never touches storage. The
// start frame goes out on open; the daemon validates the token against the API
// before anything spawns.
// #380 — `prime` is a tab agent's briefing, appended to the spawned session's
// system prompt by the daemon (see terminal/console-launch.mjs), and `model`
// the alias that agent is pinned to. Both are ignored on a re-attach, because
// there is nothing to spawn: an already-running session keeps the identity it
// was started with.
export function openTerminal(opts: {
  cwd: string; cmd: 'shell' | 'claude'; cols: number; rows: number;
  tmuxSession?: string; skipPerms?: boolean; prime?: string; model?: string;
}): WebSocket {
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
// usage prefs above: the cockpit rail's collapse, how many terminals are on
// screen at once, and (25b) which of the rail's two segments it opens on.
//
// `panes` REPLACED the old `wide` boolean. Wide mode answered "give the
// terminal the whole viewport", which turned out to be the consequence of a
// question rather than the question: you widen the screen because you want to
// see more than one session. So the count is the control now, and panes > 1
// takes the full width by itself — the thing wide mode did, asked for the
// reason people actually wanted it.
export const TERM_PANE_CHOICES = [1, 2, 3, 4] as const;
export type TermPaneCount = (typeof TERM_PANE_CHOICES)[number];
// `railStyle` picks which reading of the Session rail is on screen. They are two
// layouts over the SAME list, never two lists: `tiers` makes the tier the shape
// of the rail and the tab a single scope; `upnext` promotes one item to send and
// reaches the rest by typing. Device-local because it is a way of looking, not a
// property of the project.
export type TermRailStyle = 'tiers' | 'upnext';
export interface TermViewPrefs {
  railOpen: boolean; panes: TermPaneCount; railSeg: 'session' | 'runbook' | 'debrief'; railStyle: TermRailStyle;
}
const TERM_VIEW_KEY = 'stack.termView';
export function getTermViewPrefs(): TermViewPrefs {
  // Rail defaults COLLAPSED — the terminal canvas is the point of the screen;
  // expand it when you want the cockpit (the choice sticks per device).
  return readStoredJSON(TERM_VIEW_KEY, (p) => ({
    railOpen: p?.railOpen === true,
    // A device that stored the old `wide: true` keeps its full-width screen by
    // landing on two panes, which is the nearest honest reading of what it was
    // asking for. Anything unrecognised falls back to a single pane.
    panes: TERM_PANE_CHOICES.includes(p?.panes) ? p.panes as TermPaneCount : (p?.wide ? 2 : 1),
    // #276 — 'debrief' is the third segment: the "Jump back in" button lands
    // here so it opens already showing it, but the choice is still sticky
    // per device like the other two.
    railSeg: p?.railSeg === 'runbook' ? 'runbook' as const
      : p?.railSeg === 'debrief' ? 'debrief' as const : 'session' as const,
    railStyle: p?.railStyle === 'upnext' ? 'upnext' as const : 'tiers' as const,
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
  keep?: boolean;      // #292 — pinned: the host's idle reaper leaves it alone
  blocked?: BlockedPrompt | null;  // stopped on a permission prompt right now
}

export async function getDetachedSessions(): Promise<DetachedSession[]> {
  const r = await request<{ sessions: DetachedSession[] }>('/terminal/detached');
  return r.sessions;
}
export async function killDetachedSession(name: string): Promise<void> {
  await request<{ ok: boolean }>('/terminal/detached/kill', { method: 'POST', body: { name } });
}
// #292 — pin a session so the host's idle reaper (#287) never takes it. The
// state lives on the tmux session itself, so this only ASKS; the new value
// arrives with the daemon's next advertisement, which is why callers refresh
// the detached list rather than assuming the write landed.
export async function keepSession(name: string, keep: boolean): Promise<void> {
  await request<{ ok: boolean }>('/terminal/keep', { method: 'POST', body: { name, keep } });
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

// The open TABS themselves, device-local, so a page reload brings the whole
// screen back rather than one session. The cwd → tmux map above can only ever
// remember ONE session per directory, which is why four panes used to come
// back as one: the other three were still running on the host but nothing on
// this device remembered that this browser had them open.
//
// A claude tab restores by re-attaching its tmux session (the process really
// did survive); a shell tab restores as a fresh shell in the same directory —
// its process died with the socket, so the pane comes back and the shell is
// new. Order is the tab order, so the grid comes back the way it was left.
export interface TermOpenTab { cwd: string; cmd: 'shell' | 'claude'; tmux?: string }
const TERM_TABS_KEY = 'stack.termTabs';
const TERM_TABS_MAX = 8;
export function getTermOpenTabs(): TermOpenTab[] {
  return readStoredJSON(TERM_TABS_KEY, (v) => (Array.isArray(v) ? v : [])
    .filter((t: unknown): t is TermOpenTab =>
      !!t && typeof t === 'object'
      && typeof (t as TermOpenTab).cwd === 'string'
      && ((t as TermOpenTab).cmd === 'shell' || (t as TermOpenTab).cmd === 'claude'))
    .slice(0, TERM_TABS_MAX)
    .map((t: TermOpenTab) => ({
      cwd: t.cwd, cmd: t.cmd, tmux: typeof t.tmux === 'string' && t.tmux ? t.tmux : undefined,
    })));
}
export function setTermOpenTabs(tabs: TermOpenTab[]) {
  localStorage.setItem(TERM_TABS_KEY, JSON.stringify(tabs.slice(0, TERM_TABS_MAX)));
}

// ---- timeline (GET /api/timeline — cross-project pushes + contribution graph) ----

export interface TimelineEntry {
  slug: string; name: string; tint: string | null; hash: string; branch: string;
  summary: string; tags: string[]; geminiNote: string; authored: boolean; time: string;
}
// #381 — a card a live session opened that day. A separate feed from `entries`
// rather than a member of it: entries are work that LANDED (a commit behind
// each), these are work that BEGAN, and every count and cap already built on
// `entries` means pushes.
export interface TimelineFly {
  kind: 'fly';
  slug: string; name: string; tint: string | null;
  id: number; title: string; note: string;
  session: string;      // '' = a session that did not name itself
  bucket: string; area: string;
  reviewed: boolean;    // signed off, so the runner may take it
  done: boolean;
  time: string;
}
// `flies` is optional so a client running against a server that predates #381
// renders the push feed exactly as before rather than throwing on undefined.
export interface TimelineDay {
  date: string; label: string; entries: TimelineEntry[]; flies?: TimelineFly[];
}
export interface TimelineData {
  days: TimelineDay[]; graph: { date: string; count: number }[]; total: number;
  windowDays: number; hasMore: boolean; capped: boolean;
}

export async function getTimeline(opts?: { days?: number; graph?: boolean }): Promise<TimelineData> {
  const parts: string[] = [];
  if (opts?.days) parts.push(`days=${opts.days}`);
  if (opts?.graph === false) parts.push('graph=0');
  return request<TimelineData>(`/timeline${parts.length ? `?${parts.join('&')}` : ''}`);
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
    automode: boolean; autopilot_area: string; merge_autonomy: MergeAutonomy;
    name: string; north_star: string; directives: string[]; deploy_platform: string; logs_url: string;
    tech_stack: string[];
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
  slug: string,
  // #425 — `sched` is optional and the caller decides. Omitted means the row is
  // born unscheduled, which stays the right answer for anything the owner did
  // not place by hand.
  input: {
    title: string; note: string; bucket: Priority; claimed_by?: string; area?: string; subArea?: string;
    plan?: PlanStep[]; risk?: RoadmapItem['risk']; tier?: RoadmapItem['tier'];
    sched?: { start: number; len: number };
  },
): Promise<RoadmapItem> {
  return request<RoadmapItem>(roadmapBase(slug), { method: 'POST', body: input });
}
export async function patchRoadmapItem(
  slug: string, id: number,
  patch: Partial<{
    done: boolean; bucket: Priority; title: string; note: string; reviewed: boolean;
    claimed_by: string; review_tag: string; review_tags: string[]; refine_note: string;
    review_shelved: boolean; skipped: boolean; area: string; subArea: string; position: number;
    built_note: string; plan: PlanStep[]; risk: RoadmapItem['risk'];
    // #262 — omitting risk_source means the server records the write as human,
    // which is exactly what an edit from the modal is.
    risk_source: 'human' | 'auto'; risk_reason: string;
    tier: RoadmapItem['tier'];   // #227 — desire rank; '' unranks it
    // ---- the Roadmap tab v2 ----
    // null returns the bar to the tray. The server writes the BASELINE only if
    // there isn't one, so a drag can never erase the slip it is showing.
    sched: SchedSpan | null;
    rebaseline: boolean;         // "this is the plan now" — the one way to move the ghost
    parentId: number | null;     // one level deep; an invalid target leaves the row alone
    labels: string[];            // unknown ids are dropped server-side
    listKey: string;             // '' returns the card to the derived column
    archived: boolean;
    estimate: number | null;     // null = unsized, which is not zero
  }>,
): Promise<RoadmapItem> {
  return request<RoadmapItem>(`${roadmapBase(slug)}/${id}`, { method: 'PATCH', body: patch });
}

// ---- the Roadmap tab's furniture: areas (the timeline's lanes) and Plan lists.
// Every writer returns the fresh collection, so the caller never has to guess
// what a rename did to the rows that carried the old name.
const boardBase = (slug: string) => `/projects/${encodeURIComponent(slug)}/board`;

export async function getBoardShape(slug: string): Promise<BoardShape> {
  return request<BoardShape>(boardBase(slug));
}
export async function addArea(slug: string, name: string): Promise<BoardArea[]> {
  const r = await request<{ areas: BoardArea[] }>(`${boardBase(slug)}/areas`, { method: 'POST', body: { name } });
  return r.areas;
}
/** Set an area's dot. Only a colour the server's palette knows is stored. */
export async function setAreaColour(slug: string, name: string, dot: string): Promise<BoardArea[]> {
  const r = await request<{ areas: BoardArea[] }>(
    `${boardBase(slug)}/areas/${encodeURIComponent(name)}`, { method: 'PATCH', body: { dot } });
  return r.areas;
}
// The Curator's read of the timeline: what must come BEFORE what. Proposes only
// — the caller ghosts the moves and applies them itself.
//
// `scope` narrows it to one area, so the read acts on the same rows the Arrange
// panel's arithmetic does. `untagged` is a flag rather than the client's
// UNALLOCATED sentinel: the sentinel is safe only under the client's own rules
// (lib/plan.ts), and a second spelling of it on the wire is a rule the server
// would have to keep in step with by discipline alone.
export interface ArrangeMove { id: number; title: string; sched: SchedSpan; why: string }
export async function arrangeRoadmap(
  slug: string, scope: { area?: string; untagged?: boolean } = {},
): Promise<{ moves: ArrangeMove[]; note?: string }> {
  return request<{ moves: ArrangeMove[]; note?: string }>(
    `${roadmapBase(slug)}/arrange`, { method: 'POST', body: scope });
}
// The Curator's other read of the board: WHERE each untagged item belongs.
// Proposes only, exactly like arrangeRoadmap — the caller ghosts the picks and
// writes the areas itself, one ordinary PATCH each.
//
// NO SCOPE ARGUMENT, and that is the contract: untagged IS the population, so
// there is nothing for an area filter to narrow it to. `seen` is how many
// untagged rows the read was shown (the server caps the list) and `total` how
// many there are, so the caller can say "9 of 12" rather than implying it saw
// the lot. `isNew` marks an area the project has never used — a coined lane is
// something the owner should have to notice before applying it.
export interface AllocatePick { id: number; title: string; area: string; isNew: boolean; why: string }
export async function allocateRoadmap(
  slug: string,
): Promise<{ picks: AllocatePick[]; seen: number; total: number; note?: string }> {
  return request<{ picks: AllocatePick[]; seen: number; total: number; note?: string }>(
    `${roadmapBase(slug)}/allocate`, { method: 'POST', body: {} });
}
export async function renameArea(slug: string, from: string, name: string): Promise<BoardArea[]> {
  const r = await request<{ areas: BoardArea[] }>(
    `${boardBase(slug)}/areas/${encodeURIComponent(from)}`, { method: 'PATCH', body: { name } });
  return r.areas;
}
export async function deleteArea(slug: string, name: string): Promise<BoardArea[]> {
  const r = await request<{ areas: BoardArea[] }>(
    `${boardBase(slug)}/areas/${encodeURIComponent(name)}`, { method: 'DELETE' });
  return r.areas;
}
/**
 * The project's labels (#382). Both writers answer with the WHOLE set, like the
 * area writers: a delete takes the label off every card server-side, so the
 * caller must never assume the collection it had is still current.
 */
export async function addLabel(slug: string, name: string, tone: string): Promise<BoardLabel[]> {
  const r = await request<{ labels: BoardLabel[] }>(
    `${boardBase(slug)}/labels`, { method: 'POST', body: { name, tone } });
  return r.labels;
}
export async function deleteLabel(slug: string, key: string): Promise<BoardLabel[]> {
  const r = await request<{ labels: BoardLabel[] }>(
    `${boardBase(slug)}/labels/${encodeURIComponent(key)}`, { method: 'DELETE' });
  return r.labels;
}
export async function addList(slug: string, name: string): Promise<BoardList> {
  const r = await request<{ list: BoardList }>(`${boardBase(slug)}/lists`, { method: 'POST', body: { name } });
  return r.list;
}
export async function renameList(slug: string, key: string, name: string): Promise<BoardList> {
  const r = await request<{ list: BoardList }>(
    `${boardBase(slug)}/lists/${encodeURIComponent(key)}`, { method: 'PATCH', body: { name } });
  return r.list;
}
export async function deleteList(slug: string, key: string): Promise<void> {
  await request<void>(`${boardBase(slug)}/lists/${encodeURIComponent(key)}`, { method: 'DELETE' });
}
export async function deleteRoadmapItem(slug: string, id: number): Promise<void> {
  await request<void>(`${roadmapBase(slug)}/${id}`, { method: 'DELETE' });
}
// The autopilot's run ledger — the Reviews view labels completed items with
// the session that built them (branch, commits, tokens, the run's own summary).
export async function getAutopilotRuns(slug: string): Promise<AutopilotRun[]> {
  return request<AutopilotRun[]>(`/projects/${encodeURIComponent(slug)}/autopilot/runs`);
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
  // #298 — S never arrives as a fill. The top of the desire queue is the
  // owner's own call, so the server hands an S back here instead, for the
  // modal to OFFER; everything below it fills an empty tier as usual.
  tierSuggested?: RoadmapItem['tier'];
  // #298 — '' when the assist has no read on it or the field is switched off.
  risk?: RoadmapItem['risk'] | '';
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

// ---- checks (the Quality tab's Suite segment) ----

const checksBase = (slug: string) => `/projects/${encodeURIComponent(slug)}/checks`;

// What a check is made of, snake_case as the API takes it (#143): method +
// req_body exercise a function; contains / json_path+json_expect / semantic
// are the assertions.
export interface CheckInput {
  name: string; url: string; method?: string; expect_status?: number;
  req_body?: string; contains?: string; json_path?: string; json_expect?: string; semantic?: string;
  feature?: string;    // what it tests — the Quality page's grouping ('' = ungrouped)
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
// Run all checks, or one by id, or one feature's worth. `feature` is passed as a
// KEY rather than a value because '' is a real feature (the ungrouped bucket).
export async function runChecks(slug: string, scope?: { id: number } | { feature: string }): Promise<Check[]> {
  return request<Check[]>(`${checksBase(slug)}/run`, { method: 'POST', body: scope ?? {} });
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

// #297 — the last project a detail page loaded successfully, device-local:
// the BROWSER is what did the viewing, so a phone and the desktop may
// legitimately answer differently (same reasoning as `stack.autoRefresh`).
// It is the fallback the "Open Roadmap" link reaches for when no app is
// selected — a nicety, never a blocker.
const LAST_PROJECT_KEY = 'stack.lastProject';

export function getLastViewedProject(): string {
  return readStoredJSON(LAST_PROJECT_KEY, (p) => (typeof p === 'string' ? p : ''));
}
export function setLastViewedProject(slug: string) {
  if (!slug) return; // never store an empty key
  try { localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify(slug)); }
  catch { /* storage full or unavailable — a nicety, never a blocker */ }
}

// ---- what the corner ＋ just filed ----
//
// The quick-add dock is a SIBLING of every screen (App.tsx renders it outside
// the page tree), so an item it writes into the project you are looking at has
// no props path back to that screen — it would sit saved and invisible, which
// reads as a press that did nothing. Same one-line pub/sub as `onAuthChange`:
// the dock announces the slug it wrote to and the open project re-reads.
// The GET /api/tips recipe routes are still served and their rows untouched;
// nothing in the client calls them since the library left the corner.
let filedListeners: Array<(slug: string) => void> = [];

export function emitItemFiled(slug: string) {
  for (const cb of [...filedListeners]) cb(slug);
}
export function onItemFiled(cb: (slug: string) => void): () => void {
  filedListeners.push(cb);
  return () => { filedListeners = filedListeners.filter((x) => x !== cb); };
}

// ---- the skill tree (#228) ----
//
// A managed library of Claude Code skills. The server holds the library; the
// HOST writes the files (it is the only side that can see ~/.claude) and
// reports back what is really on disk — so `installedAt` is a fact from the
// host, and a skill can be in the library without being anywhere yet.

export interface Skill {
  id: number;
  name: string;                 // kebab-case; it IS the directory name
  scope: 'global' | 'project';  // ~/.claude, or <repo>/.claude
  slug: string;                 // the project, '' for global
  description: string;          // the frontmatter line that decides relevance
  body: string;
  enabled: boolean;             // off = the host removes it from disk
  installedAt: string | null;   // null = not on disk (yet, or any more)
  updatedAt: string | null;
}
// One skill directory the host found, managed by Stack or not. An UNMANAGED
// one is reported and never touched — it is somebody else's file, and the tree
// shows it so it can be adopted rather than silently overwritten.
export interface SkillOnDisk {
  name: string; scope: 'global' | 'project'; slug: string;
  path: string; managed: boolean; description: string; body: string;
}
export interface SkillReport { skills: SkillOnDisk[]; detail: string; when: string | null }
export interface SkillsData { skills: Skill[]; report: SkillReport }
export type SkillInput = Partial<Pick<Skill, 'name' | 'scope' | 'slug' | 'description' | 'body' | 'enabled'>>;

export async function getSkills(): Promise<SkillsData> {
  return request<SkillsData>('/skills');
}
export async function createSkill(input: SkillInput): Promise<Skill> {
  return request<Skill>('/skills', { method: 'POST', body: input });
}
export async function patchSkill(id: number, input: SkillInput): Promise<Skill> {
  return request<Skill>(`/skills/${id}`, { method: 'PATCH', body: input });
}
export async function deleteSkill(id: number): Promise<void> {
  await request<{ ok: boolean }>(`/skills/${id}`, { method: 'DELETE' });
}

// ---- the TAB AGENTS (#361) ----
//
// Named specialists, each bound to one project tab: the Auditor (Quality),
// the Curator (Roadmap) and the Drafter (Workbench). The binding is the
// SERVER's — agents.js owns which agent may run which op — so nothing here
// invents an agent or widens one; this is the read of that registry plus the
// things the owner may tune.
// The cull took three with their surfaces: 'polaris' (the Futures tab),
// 'merger' (Mission Control's Merge room) and 'foreman' (the Review room).
// ONE SURFACE, ONE SWITCH cuts both ways — an agent whose only surface is gone
// has nothing left to switch, so it leaves the registry rather than lingering
// as a toggle that governs nothing. 'scribe' went with the instructions tree
// for the same reason.
export type TabAgentKey = 'auditor' | 'curator' | 'drafter';

export interface TabAgentOp {
  op: string;
  label: string;
  hint: string;
  enabled: boolean;
}

// #418 — the same per-op readiness map the project detail payload carries, on
// its own so an APP-WIDE surface can read it. The corner ＋ has no project
// loaded and pulling a whole detail payload (activity, bugs, board, funnel,
// checks) to decide whether to draw two buttons would be absurd. Same shape,
// same `agentCan`/`agentOffReason` below — never a second answer.
export async function getAgentState(): Promise<TabAgentState> {
  return request<TabAgentState>('/agents/state');
}

// The compact per-project read that rides the detail payload: which agents may
// act, and which of their ops. Keyed by agent.
export type TabAgentState = Partial<Record<TabAgentKey, {
  name: string; tab: string; enabled: boolean; ready?: boolean; ops: string[];
  /**
   * The ops whose BACKEND is up. An agent with ops on two backends has no
   * single answer to "is it ready" — the Curator's two reads run on Gemini
   * while its console needs the host daemon — so anything asking about one op
   * reads this and not `ready`. Absent from an older server, which is what
   * makes `ready` still the fallback rather than dead code.
   */
  opsReady?: string[];
  /** Which of them are Gemini-backed, so a refusal names the right backend. */
  opsGemini?: string[];
  // #379 — three states, not two: null/absent = this agent has no live session,
  // false = it has one and the owner switched it off, true = it may open.
  console?: boolean | null;
}>>;

// May this tab's agent run this op right now? UNKNOWN MEANS YES — an older
// server sends no agent state at all, and hiding a working feature because the
// payload is quiet would be worse than offering one that answers honestly.
// Only an agent the server has actually reported as off (or an op it has
// reported as off) hides anything.
export function agentCan(state: TabAgentState | undefined, key: TabAgentKey, op: string): boolean {
  const a = state?.[key];
  if (!a) return true;
  // #364 — `ready` is the BACKEND, `enabled` is the owner's switch. Both are
  // required to offer a ✧, and they are kept apart so the reason below can say
  // which one is missing.
  //
  // PER-OP FIRST. `ready` is one boolean for the host daemon, and an agent
  // whose ops sit on two backends cannot be described by one boolean: with the
  // daemon down, the Curator's Gemini reads are fine and only its console is
  // not. `opsReady` is the answer for the op actually being asked about; the
  // agent-wide `ready` is the fallback for a server that predates it.
  return a.enabled
    && (a.opsReady ? a.opsReady.includes(op) : a.ready !== false)
    && a.ops.includes(op);
}

// What to say instead. Reads the same state, so the reason is never invented:
// '' when the agent can act.
export function agentOffReason(state: TabAgentState | undefined, key: TabAgentKey, op: string): string {
  const a = state?.[key];
  if (!a || agentCan(state, key, op)) return '';
  // Order matches the server's gate: the owner's switch is reported before the
  // backend, so somebody who turned an agent off is not sent to investigate a
  // host that is fine.
  if (!a.enabled) return `The ${a.name} is switched off.`;
  // The op is registered but its BACKEND is down — and which backend it is
  // decides where the owner goes to fix it, so it has to be named. Same order
  // and same two sentences as the server's gateDecision.
  if (a.opsReady && a.ops.includes(op) && !a.opsReady.includes(op)) {
    return a.opsGemini?.includes(op)
      ? `This pass runs on Gemini, and Gemini is not configured on this server (GEMINI_API_KEY is unset).`
      : `The ${a.name} runs Claude on the host, and the host daemon is not connected.`;
  }
  if (!a.opsReady && a.ready === false) {
    return `The ${a.name} runs Claude on the host, and the host daemon is not connected.`;
  }
  return `The ${a.name} can still work here, but this one is switched off.`;
}

// ---- the tab agents' CONSOLES (#379) ----
//
// The same two-function shape as agentCan/agentOffReason, and for the same
// reason: what may be drawn and what to say instead are read off ONE state, so
// a tab can never print a reason it has not checked.
//
// The unknown-means-yes rule holds for an agent the server has not reported at
// all — an older server hiding a working feature is the worse failure. But an
// agent it HAS reported, with no `console` field, is the server saying this
// agent has no live session, and that is not a refusal to explain: there is
// nothing to draw and nothing to say.
export function agentConsoleCan(state: TabAgentState | undefined, key: TabAgentKey): boolean {
  const a = state?.[key];
  if (!a) return true;
  return a.console === true && a.enabled && a.ready !== false;
}

// '' both when the console may open AND when this agent has none — a tab asks
// for the sentence only after `agentConsoleCan` said no, and an empty answer
// means there is nothing here to explain.
export function agentConsoleOffReason(state: TabAgentState | undefined, key: TabAgentKey): string {
  const a = state?.[key];
  if (!a || a.console == null || agentConsoleCan(state, key)) return '';
  if (!a.enabled) return `The ${a.name} is switched off.`;
  if (a.ready === false) {
    return `The ${a.name}'s session runs on the host, and the host daemon is not connected.`;
  }
  return `The ${a.name} can still work here, but its live session is switched off.`;
}

// #380 — the briefing a console is SPAWNED with, composed server-side from the
// agent's registry entry, the owner's standing guidance and a snapshot of the
// tab. `partial` is non-empty when the snapshot could not be read: the session
// still opens (fail open — an unprimed console is a working terminal), and the
// strip says so rather than letting the owner believe the agent can see the tab.
export interface AgentConsolePrime {
  agent: TabAgentKey;
  name: string;
  model: string;
  prime: string;
  partial: string;
  // What this tab is usually opened for — the buttons beside the console, in
  // the order the session was told them, so a press and a bare number ask for
  // the same thing. It comes from the server because it is registry state; a
  // client-side copy would be a menu drifting from the one the agent has.
  // Absent on an older server, so it is read as a list that may not be there.
  openers?: { label: string; ask: string }[];
}
export async function getAgentConsolePrime(slug: string, key: TabAgentKey): Promise<AgentConsolePrime> {
  return request<AgentConsolePrime>(
    `/projects/${encodeURIComponent(slug)}/console/${encodeURIComponent(key)}`);
}

// How each tab agent's console is left on this DEVICE: open or shut, and how
// tall. Device-local for the same reason the terminal's own view prefs are —
// it is a way of looking at a screen, not a property of the project — and
// keyed by agent so opening the Roadmap's session does not open four.
export interface TabTermPrefs { open: boolean; tall: boolean }
const TAB_TERM_KEY = 'stack.tabTerm';
type TabTermStore = Partial<Record<string, TabTermPrefs>>;
const readTabTerms = (): TabTermStore => readStoredJSON(TAB_TERM_KEY, (p) => (p && typeof p === 'object' ? p : {}));

export function getTabTermPrefs(key: TabAgentKey): TabTermPrefs {
  // SHUT by default. A console that opened itself on four tabs would spawn four
  // Claude sessions on the host the first time somebody clicked through a
  // project — the session is real work and real spend, so it waits to be asked.
  const p = readTabTerms()[key];
  return { open: p?.open === true, tall: p?.tall === true };
}

export function setTabTermPrefs(key: TabAgentKey, prefs: TabTermPrefs) {
  localStorage.setItem(TAB_TERM_KEY, JSON.stringify({ ...readTabTerms(), [key]: prefs }));
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

// ---- the Workbench canvas ----
//
// Positions travel from here, not the server: only the client knows how tall a
// card actually rendered, and stacking an op's output under the last one needs
// that. Every write returns the server's row, so the canvas never guesses what
// it just saved.

const wbBase = (slug: string) => `/projects/${encodeURIComponent(slug)}/workbench`;

export async function getWorkbench(slug: string): Promise<WorkbenchData> {
  return request<WorkbenchData>(wbBase(slug));
}

// A note card writes a REAL note — it shows up in ⌘K and promotes to a bug
// like any other. `parentId` is which folder the card is born in; null (or
// omitted) is the root, which is what every caller predating folders means
// (#414).
export async function addWorkbenchCard(
  slug: string,
  input: { kind: 'note'; text: string; x: number; y: number; parentId?: number | null },
): Promise<WorkbenchCard> {
  return request<WorkbenchCard>(`${wbBase(slug)}/cards`, { method: 'POST', body: input });
}

// `title` writes THROUGH to the note the card wraps — there is no second copy
// of the text to drift.
// `parentId` refiles the card: a folder id, or null for the root. The server
// refuses a target that would make a loop and leaves the card where it was, so
// a caller must take the RETURNED parentId as the truth rather than assuming
// the one it sent stuck (#414).
export async function patchWorkbenchCard(
  slug: string, id: number,
  patch: Partial<{
    x: number; y: number; w: number; title: string; body: WorkbenchBody;
    parentId: number | null;
  }>,
): Promise<WorkbenchCard> {
  return request<WorkbenchCard>(`${wbBase(slug)}/cards/${id}`, { method: 'PATCH', body: patch });
}

// A new folder inside `parentId` (null = the root). Folders are cards, so the
// answer slots straight into `data.cards` beside everything else.
export async function addWorkbenchFolder(
  slug: string,
  input: { title: string; parentId: number | null; x: number; y: number },
): Promise<WorkbenchCard> {
  return request<WorkbenchCard>(`${wbBase(slug)}/folders`, { method: 'POST', body: input });
}

// `dropped` is every card that went with it: an op's output takes the branch it
// fed.
// Deleting a FOLDER reports `lifted` — the cards that were inside it — and
// `liftedTo`, the folder they went to. They are NOT in `dropped`: a folder
// delete never deletes what it held (#414).
export async function deleteWorkbenchCard(
  slug: string, id: number,
): Promise<{
  dropped: number[];
  lifted?: number[]; liftedTo?: number | null;
}> {
  return request<{
    dropped: number[];
    lifted?: number[]; liftedTo?: number | null;
  }>(`${wbBase(slug)}/cards/${id}`, { method: 'DELETE' });
}

export async function linkWorkbenchCards(slug: string, a: number, b: number): Promise<WorkbenchEdge> {
  return request<WorkbenchEdge>(`${wbBase(slug)}/edges`, { method: 'POST', body: { a, b } });
}

export async function cutWorkbenchEdge(slug: string, id: number): Promise<{ dropped: number[] }> {
  return request<{ dropped: number[] }>(`${wbBase(slug)}/edges/${id}`, { method: 'DELETE' });
}

// ✧ Run an op. Gemini proposes: the answer lands as a card to keep, edit or
// cut — it never writes tracker state. 503 when the server has no key, which
// is why the rail hides the ops rather than disabling them.
export async function runWorkbenchOp(
  slug: string,
  input: { op: WorkbenchOp; cardId: number; x: number; y: number; question?: string; model?: string },
): Promise<{ card: WorkbenchCard; edge: WorkbenchEdge }> {
  return request<{ card: WorkbenchCard; edge: WorkbenchEdge }>(
    `${wbBase(slug)}/ops`, { method: 'POST', body: input });
}

// #418 — the Drafter's pass over a thought that has NOT been filed yet (the
// corner ＋'s Thought composer). It writes nothing and returns a proposal; an
// empty `text` is the honest answer for a scrap that already reads well, not a
// failure, and the composer says so rather than replacing the words with the
// same words.
export async function sharpenThought(slug: string, text: string): Promise<{ text: string; why: string }> {
  return request<{ text: string; why: string }>(
    `${wbBase(slug)}/sharpen`, { method: 'POST', body: { text } });
}

// A night's own account of itself, pulled onto the canvas the same way an idea
// is: `days` narrows the window (server default 21) and is only put on the
// query string when the caller actually wants something other than that.
export async function getWorkbenchDebrief(slug: string, days?: number): Promise<WorkbenchDebrief> {
  const qs = days ? `?days=${encodeURIComponent(days)}` : '';
  return request<WorkbenchDebrief>(`${wbBase(slug)}/debrief${qs}`);
}

// Picks travel as KEYS, never text — the server re-reads the words out of the
// debrief itself, so the canvas can never hold a copy that drifted from the
// record. `skipped` is why a caller must not assume every pick landed (a key
// already imported elsewhere, or one that no longer matches, comes back here
// instead of as a card).
export async function importWorkbenchDebrief(
  slug: string,
  input: {
    as: 'note' | 'idea';
    picks: { key: string; x: number; y: number }[];
    parentId?: number | null;   // the folder the picker was opened from (#414)
  },
): Promise<{ cards: WorkbenchCard[]; skipped: { key: string; why: string }[] }> {
  return request<{ cards: WorkbenchCard[]; skipped: { key: string; why: string }[] }>(
    `${wbBase(slug)}/debrief`, { method: 'POST', body: input });
}
