// Stack — shared posting helpers.
//
// One implementation of the bits the SessionEnd hook and the /checkpoint poster
// both need: loading ~/.stack/env, deriving the project from git, fetching
// settings (bounded, default-on) and POSTing a checkpoint to /api/ingest.
//
// Zero dependencies. NEVER prints, echoes or logs the token.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Load secrets from ~/.stack/env (KEY=VALUE per line) without overriding the
// real environment. Keeps the token out of shell profiles and settings.json.
export function loadStackEnv() {
  const f = join(homedir(), '.stack', 'env');
  if (!existsSync(f)) return;
  try {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      const v = s.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  } catch { /* ignore */ }
}

export function logStderr(...a) { process.stderr.write(`[stack] ${a.join(' ')}\n`); }

export function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

// Normalise a git remote (ssh or https, with/without .git) into a browseable
// https URL for the app's "Repo" button. Returns null if unknown.
export function browseUrl(remote) {
  if (!remote) return null;
  const ssh = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = remote.match(/^https?:\/\/(.+?)(?:\.git)?$/);
  if (https) return `https://${https[1]}`;
  return null;
}

// Derive { repo, repo_url, name, slug, branch, commit } from git, falling back
// to the directory name. Identical derivation in the hook and the poster.
export function projectFromGit(cwd) {
  const remote = git(cwd, ['config', '--get', 'remote.origin.url']);
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || null;
  let repo = null, name = null, slug = null;
  const m = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (m) {
    repo = m[1];
    name = repo.split('/').pop();
    slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  if (!name) {
    name = (cwd || '').split('/').filter(Boolean).pop() || 'untitled';
    slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  const commit = git(cwd, ['rev-parse', '--short', 'HEAD']) || null;
  return { repo, repo_url: browseUrl(remote), name, slug, branch, commit };
}

// The settings defaults — used whenever the API is unreachable so the hook and
// poster degrade to "on" rather than going silent.
export const SETTINGS_DEFAULTS = {
  autoRecord: true, keepResumeCard: true, checkpointDetail: 'standard', includeChores: false,
};

// Fetch app settings, bounded. Returns the defaults on any failure (so a flaky
// API never blocks a checkpoint and never silently turns recording off).
export async function fetchSettings({ timeoutMs = 2500 } = {}) {
  const api = process.env.STACK_API;
  const token = process.env.STACK_TOKEN;
  if (!api || !token) return { ...SETTINGS_DEFAULTS };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${api.replace(/\/$/, '')}/api/settings`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ...SETTINGS_DEFAULTS };
    const s = await res.json();
    return { ...SETTINGS_DEFAULTS, ...s };
  } catch {
    clearTimeout(timer);
    return { ...SETTINGS_DEFAULTS };
  }
}

// Clear a session's live-now presence row. Bounded and silent — presence is a
// nicety; failing to clear it never blocks anything (the server-side TTL is
// the backstop). Never throws.
export async function endPresence({ slug, session_id }, { timeoutMs = 2000 } = {}) {
  const api = process.env.STACK_API;
  const token = process.env.STACK_TOKEN;
  if (!api || !token) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(`${api.replace(/\/$/, '')}/api/presence/end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ slug, session_id: session_id || '' }),
      signal: ctrl.signal,
    });
  } catch { /* silent */ } finally {
    clearTimeout(timer);
  }
}

// POST a checkpoint package to STACK_API/api/ingest. Bounded; returns a small
// result object and never throws. Never includes the token in any return value.
export async function postIngest(body, { timeoutMs = 8000 } = {}) {
  const api = process.env.STACK_API;
  const token = process.env.STACK_TOKEN;
  if (!api || !token) return { ok: false, reason: 'STACK_API and STACK_TOKEN must be set' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${api.replace(/\/$/, '')}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, reason: e.message };
  }
}
