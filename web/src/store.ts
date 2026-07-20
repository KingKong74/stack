import type {
  Project, Resume, Activity, Bug, Roadmap, RoadmapItem, Note, Future, Check, Overview,
  ProjectStatus, Priority, Severity, BugStatus, SearchResponse, Settings, AutopilotRun, PlanStep,
  AuthDevice,
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

// ---- export-brief preferences (device-local, like the token) ----

const BRIEF_PREFS_KEY = 'stack.briefPrefs';

export interface BriefPrefs { compact: boolean; directives: string[] }

export function getBriefPrefs(): BriefPrefs {
  try {
    const raw = localStorage.getItem(BRIEF_PREFS_KEY);
    const p = raw ? JSON.parse(raw) : null;
    return { compact: p?.compact === true, directives: Array.isArray(p?.directives) ? p.directives : [] };
  } catch {
    return { compact: false, directives: [] };
  }
}

export function setBriefPrefs(prefs: BriefPrefs) {
  localStorage.setItem(BRIEF_PREFS_KEY, JSON.stringify(prefs));
}

// ---- roadmap draft (device-local): an accidentally-dismissed add-modal keeps
// its text per project, so half-typed items survive a stray click ----

const ROAD_DRAFT_KEY = 'stack.roadDrafts';
// Drafts are a crash pad, not storage — stale ones self-clear after this long.
const ROAD_DRAFT_TTL_MS = 30 * 60 * 1000;

export interface RoadDraft { title: string; note: string; priority: Priority; lane: string; area?: string; savedAt?: number }

function readRoadDrafts(): Record<string, RoadDraft> {
  try { return JSON.parse(localStorage.getItem(ROAD_DRAFT_KEY) || '{}'); } catch { return {}; }
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
  claims: { id: string; title: string; lane: string }[];
  reviewCount: number;
  bugs: { serious: number; open: number };
  blockers: string[];
  nextPick: { id: string; bucket: Priority; title: string } | null;
  lastAuto: { branch: string; summary: string; when: string } | null;
}
export interface AutopilotSchedule {
  id: string; slug: string; name: string; tint: string | null;
  itemId: string | null; itemTitle: string;
  atTime: string;          // host-local HH:MM
  days: number[];          // getDay() ints; [] = one-off on runDate
  runDate: string | null;  // YYYY-MM-DD for one-offs
  note: string; enabled: boolean;
}
export interface AutopilotJob {
  id: string; slug: string; name: string;
  kind: 'manual' | 'nightly' | 'scheduled' | 'revert' | 'resume';
  itemId: string | null; itemTitle: string;
  // 'paused' = hung up (#142): held until a human resumes; never auto-fires.
  status: 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'paused';
  detail: string;
  notBefore?: string | null;  // a resume job's hold — ISO, null once resumed by hand
  when: string;
}
export interface TermSession {
  sid: string; cwd: string; cmd: 'shell' | 'claude';
  startedAt: number;       // epoch ms
  label: string;           // ✧ Gemini's take on what it's doing ('' until asked)
}
export interface ModelEntry { model: string; label: string }

export interface ControlData {
  autopilot: {
    enabled: boolean; minutes: number; tokens: number; time: string; maxItems: number;
    executorModel: string;  // '' = the claude CLI's default model (#153)
    advisorModel: string;   // '' = no advisor subagent
  };
  // Model picker catalogue (#175) — served from the backend so there is one
  // source of truth. Undefined while loading; the frontend falls back to the
  // hardcoded lists in Control.tsx.
  models?: { executors: ModelEntry[]; advisors: ModelEntry[] };
  terminal?: { connected: boolean; sessions?: TermSession[] };  // host daemon + open web terminals
  schedules: AutopilotSchedule[];
  jobs: AutopilotJob[];                // recent first; queued/claimed/running lead the strip
  projects: ControlProject[];
  totals: { automode: number; liveSessions: number; claims: number; review: number };
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
      executorModel: d.autopilot?.executorModel ?? '',
      advisorModel: d.autopilot?.advisorModel ?? '',
    },
    schedules: d.schedules ?? [],
    jobs: d.jobs ?? [],
  };
}

// ✧ Label the live terminal sessions: one Gemini pass over each session's
// recent output (annotation only; 503 when the server has no key).
export async function labelTerminalSessions(): Promise<TermSession[]> {
  const r = await request<{ sessions: TermSession[] }>('/terminal/label', { method: 'POST' });
  return r.sessions;
}

// The Run-now button: queue a manual job the host dispatcher picks up within
// a minute. An already open job for the project comes back instead.
export async function startAutopilot(slug: string, itemId?: string): Promise<AutopilotJob> {
  return request<AutopilotJob>('/autopilot/start', {
    method: 'POST',
    body: itemId ? { slug, itemId } : { slug },
  });
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

export interface SchedulePayload {
  slug: string; atTime: string; days?: number[]; runDate?: string | null;
  itemId?: string | null; note?: string;
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
  shareToken: string;
  liveBranches: string[];  // branches with a live session right now — backs the board's in-progress lock
}

export async function getProjectDetail(slug: string): Promise<ProjectDetailData> {
  const d = await request<ProjectPayload & {
    activity: Activity[]; bugs: Bug[]; roadmap: Roadmap; notes: Note[]; futures?: Future[];
    checks?: Check[]; keepResumeCard?: boolean; shareToken?: string; liveBranches?: string[];
    auditContext?: string;
  }>(`/projects/${encodeURIComponent(slug)}`);
  return {
    project: toProject(d), currentPhase: d.currentPhase || '', northStar: d.northStar || '',
    auditContext: d.auditContext || '',
    blockers: d.blockers || [], directives: d.directives || [],
    activity: d.activity, bugs: d.bugs, roadmap: d.roadmap, notes: d.notes, futures: d.futures || [],
    checks: d.checks || [],
    keepResumeCard: d.keepResumeCard !== false,
    shareToken: d.shareToken || '',
    liveBranches: d.liveBranches || [],
  };
}

// ---- Gemini re-entry plan (POST .../replan — suggestion only) ----

export async function replanProject(slug: string): Promise<string> {
  const r = await request<{ plan: string }>(`/projects/${encodeURIComponent(slug)}/replan`, { method: 'POST' });
  return r.plan;
}

// ---- Gemini intake sorter (POST .../intake — suggestions only) ----

export interface IntakeSuggestion {
  title: string; note: string;
  dest: 'must' | 'should' | 'could' | 'wont' | 'future';
  alignment: 'on-course' | 'tangent' | 'off-course' | null;
  why: string;
}

export async function sortIntake(slug: string, text: string): Promise<IntakeSuggestion[]> {
  const r = await request<{ items: IntakeSuggestion[] }>(
    `/projects/${encodeURIComponent(slug)}/intake`, { method: 'POST', body: { text } });
  return r.items;
}

// ---- web terminal (ws to /term — the host PTY daemon behind nginx) ----

// The only place the terminal's transport and token live — the Terminal screen
// attaches its handlers to the returned socket but never touches storage. The
// start frame goes out on open; the daemon validates the token against the API
// before anything spawns.
export function openTerminal(opts: { cwd: string; cmd: 'shell' | 'claude'; cols: number; rows: number }): WebSocket {
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
export interface TermStatus { active: boolean; count: number }
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
        if (m.t === 'status') cb({ active: !!m.active, count: Number(m.count) || 0 });
      } catch { /* not a status frame — ignore */ }
    });
    ws.addEventListener('close', () => {
      cb({ active: false, count: 0 });
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
  try { return JSON.parse(localStorage.getItem(TERM_CMDS_KEY) || '[]'); } catch { return []; }
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
  try {
    const p = JSON.parse(localStorage.getItem(TERM_USAGE_KEY) || '{}');
    return {
      dailyLimit: Number(p.dailyLimit) > 0 ? Number(p.dailyLimit) : 10_000_000,
      autoSchedule: !!p.autoSchedule,
      lastAutoKey: typeof p.lastAutoKey === 'string' ? p.lastAutoKey : '',
    };
  } catch { return { dailyLimit: 10_000_000, autoSchedule: false, lastAutoKey: '' }; }
}
export function setTermUsagePrefs(p: TermUsagePrefs) {
  localStorage.setItem(TERM_USAGE_KEY, JSON.stringify(p));
}

// ---- Polaris (POST .../polaris — the Futures tab's Gemini terminal) ----

export interface PolarisTurn { role: 'you' | 'polaris'; text: string }

export async function polarisChat(slug: string, message: string, history: PolarisTurn[]): Promise<string> {
  const r = await request<{ reply: string }>(
    `/projects/${encodeURIComponent(slug)}/polaris`, { method: 'POST', body: { message, history } });
  return r.reply;
}

// ---- Gemini judge assist (POST .../futures/:id/judge — suggestion only) ----

export interface JudgeSuggestion { alignment: 'on-course' | 'tangent' | 'off-course'; why: string }

export async function judgeFuture(slug: string, id: number): Promise<JudgeSuggestion> {
  return request<JudgeSuggestion>(
    `/projects/${encodeURIComponent(slug)}/futures/${id}/judge`, { method: 'POST' });
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
export async function createBug(slug: string, input: { title: string; severity: Severity }): Promise<Bug> {
  return request<Bug>(bugsBase(slug), { method: 'POST', body: input });
}
export async function patchBug(
  slug: string, bugKey: string,
  patch: Partial<{ status: BugStatus; severity: Severity; title: string; reviewed: boolean }>,
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
  slug: string, input: { title: string; note: string; bucket: Priority; claimed_by?: string; area?: string; plan?: PlanStep[] },
): Promise<RoadmapItem> {
  return request<RoadmapItem>(roadmapBase(slug), { method: 'POST', body: input });
}
export async function patchRoadmapItem(
  slug: string, id: number,
  patch: Partial<{
    done: boolean; bucket: Priority; title: string; note: string; reviewed: boolean;
    claimed_by: string; review_tag: string; review_tags: string[]; refine_note: string;
    review_shelved: boolean; skipped: boolean; area: string; position: number;
    built_note: string; plan: PlanStep[];
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
// Gemini titles an item from its note (the modal's ✧ button) — suggestion only.
export async function suggestRoadmapTitle(slug: string, note: string): Promise<string> {
  const r = await request<{ title: string }>(`${roadmapBase(slug)}/suggest-title`, { method: 'POST', body: { note } });
  return r.title;
}

// Gemini fills the whole item from its note — title, tidied note, area, lane,
// priority. Suggestion only: it prefills the modal, the human saves.
export interface RoadmapAssist {
  title: string; note: string; area: string; lane: string; priority: Priority | null;
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
  patch: Partial<{ title: string; note: string; reviewed: boolean; alignment: string; area: string }>,
): Promise<Future> {
  return request<Future>(`${futuresBase(slug)}/${id}`, { method: 'PATCH', body: patch });
}
export async function deleteFuture(slug: string, id: number): Promise<void> {
  await request<void>(`${futuresBase(slug)}/${id}`, { method: 'DELETE' });
}

// ---- checks (the Bugs tab's Audit area) ----

const checksBase = (slug: string) => `/projects/${encodeURIComponent(slug)}/checks`;

// What a check is made of, snake_case as the API takes it (#143): method +
// req_body exercise a function; contains / json_path+json_expect / semantic
// are the assertions.
export interface CheckInput {
  name: string; url: string; method?: string; expect_status?: number;
  req_body?: string; contains?: string; json_path?: string; json_expect?: string; semantic?: string;
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
