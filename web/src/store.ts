import type {
  Project, Resume, Activity, Bug, Roadmap, RoadmapItem, Note, Future, Overview,
  ProjectStatus, Priority, Severity, BugStatus, SearchResponse, Settings,
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

// ---- shaping (server payload -> frontend types) ----

const repoUrl = (repo: string): string =>
  !repo ? '' : /^https?:\/\//.test(repo) ? repo : `https://github.com/${repo}`;

interface ProjectPayload {
  slug: string; name: string; subtitle: string; tint: string | null; status: ProjectStatus;
  progress: number; metaLine: string; pinned: boolean; siteUrl: string; repo: string; repoUrl: string;
  pushesThisWeek: number;
  // detail-only:
  summary?: string; currentPhase?: string; northStar?: string;
  inProgress?: string[]; nextUp?: string[]; workingWell?: string[]; blockers?: string[];
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
    siteUrl: d.siteUrl || '',
    repoUrl: d.repoUrl || repoUrl(d.repo || ''),
    meta: {
      version: '—',
      lastDeploy: d.metaLine ? d.metaLine.replace(/^pushed /, '') : '—',
      stack: [],
      pushesThisWeek: d.pushesThisWeek ?? 0,
    },
    resume: isDetail ? toResume(d) : null,
  };
}

// ---- cross-project command deck ----

// The server already returns the client shape, so this is a thin pass-through.
// (`review` is defaulted so a not-yet-redeployed server can't blank the deck.)
export async function getOverview(): Promise<Overview> {
  const o = await request<Overview>('/overview');
  return { ...o, review: o.review ?? { total: 0, items: [] } };
}

// ---- search (the ⌘K command palette) ----

export async function getSearch(query: string): Promise<SearchResponse> {
  return request<SearchResponse>(`/search?q=${encodeURIComponent(query)}`);
}

// ---- settings ----

export async function getSettings(): Promise<Settings> {
  return request<Settings>('/settings');
}
export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
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
  activity: Activity[];
  bugs: Bug[];
  roadmap: Roadmap;
  notes: Note[];
  futures: Future[];
  keepResumeCard: boolean;
}

export async function getProjectDetail(slug: string): Promise<ProjectDetailData> {
  const d = await request<ProjectPayload & {
    activity: Activity[]; bugs: Bug[]; roadmap: Roadmap; notes: Note[]; futures?: Future[];
    keepResumeCard?: boolean;
  }>(`/projects/${encodeURIComponent(slug)}`);
  return {
    project: toProject(d), currentPhase: d.currentPhase || '', northStar: d.northStar || '',
    blockers: d.blockers || [],
    activity: d.activity, bugs: d.bugs, roadmap: d.roadmap, notes: d.notes, futures: d.futures || [],
    keepResumeCard: d.keepResumeCard !== false,
  };
}

export async function createProject(input: { name: string; subtitle: string; status: ProjectStatus }): Promise<Project> {
  return toProject(await request<ProjectPayload>('/projects', { method: 'POST', body: input }));
}

export async function patchProject(
  slug: string,
  patch: Partial<{ subtitle: string; site_url: string; repo_url: string; status: ProjectStatus; pinned: boolean; name: string; north_star: string }>,
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
  slug: string, input: { title: string; note: string; bucket: Priority },
): Promise<RoadmapItem> {
  return request<RoadmapItem>(roadmapBase(slug), { method: 'POST', body: input });
}
export async function patchRoadmapItem(
  slug: string, id: number,
  patch: Partial<{ done: boolean; bucket: Priority; title: string; note: string; reviewed: boolean }>,
): Promise<RoadmapItem> {
  return request<RoadmapItem>(`${roadmapBase(slug)}/${id}`, { method: 'PATCH', body: patch });
}
export async function deleteRoadmapItem(slug: string, id: number): Promise<void> {
  await request<void>(`${roadmapBase(slug)}/${id}`, { method: 'DELETE' });
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
  patch: Partial<{ title: string; note: string; reviewed: boolean }>,
): Promise<Future> {
  return request<Future>(`${futuresBase(slug)}/${id}`, { method: 'PATCH', body: patch });
}
export async function deleteFuture(slug: string, id: number): Promise<void> {
  await request<void>(`${futuresBase(slug)}/${id}`, { method: 'DELETE' });
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
