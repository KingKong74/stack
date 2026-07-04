#!/usr/bin/env node
// Stack — Claude Code SessionStart hook.
//
// Fires when a Claude Code session starts or resumes. Works out which project
// the cwd belongs to (git remote/branch, falling back to the directory name),
// asks the Stack API for that project's current state, and injects a concise
// "where you left off" block into the session context.
//
// If no matching project exists yet, or the API is unreachable, it emits nothing
// and exits 0 — it never blocks or delays session start.
//
// Output: the documented SessionStart mechanism for adding context —
//   { "hookSpecificOutput": { "hookEventName": "SessionStart",
//                             "additionalContext": "…" } }
// printed to stdout, exit 0.
//
// Config (environment variables, loaded from ~/.stack/env like the end hook):
//   STACK_API     required  e.g. https://stack.example.com
//   STACK_TOKEN   required  must match the server's API_TOKEN
//   STACK_TIMEOUT_MS  optional  fetch budget before giving up (default 2500)
//
// Test against the current repo:  node stack-session-start.mjs --demo

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Load secrets from ~/.stack/env (KEY=VALUE per line) without overriding the
// real environment. Same mechanism as the end hook; the token never leaves here.
(function loadEnvFile() {
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
})();

const DEMO = process.argv.includes('--demo');
const TIMEOUT_MS = parseInt(process.env.STACK_TIMEOUT_MS || '2500', 10);

function log(...a) { process.stderr.write(`[stack] ${a.join(' ')}\n`); }
function done(text) {
  // The only thing we ever write to stdout: the context block, or nothing.
  if (text) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    }));
  }
  process.exit(0); // never block session start
}

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

// Same project derivation as the end hook: git remote first, directory second.
function slugFromGit(cwd) {
  const remote = git(cwd, ['config', '--get', 'remote.origin.url']);
  const m = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  let name = m ? m[1].split('/').pop() : null;
  if (!name) name = (cwd || '').split('/').filter(Boolean).pop() || 'untitled';
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const bullets = (arr, max = 5) =>
  (Array.isArray(arr) ? arr : [])
    .map((x) => String(x).trim()).filter(Boolean).slice(0, max)
    .map((x) => `- ${x}`).join('\n');

// Compose the injected block from a project detail payload.
function buildBlock(p) {
  const lines = [];
  lines.push(`# Stack — where you left off: ${p.name || 'this project'}`);

  const latest = Array.isArray(p.activity) ? p.activity[0] : null;
  const head = [];
  if (latest?.when) head.push(`Last push ${latest.when}${latest.hash && latest.hash !== '—' ? ` (${latest.hash})` : ''}`);
  if (p.currentPhase) head.push(`Phase: ${p.currentPhase}`);
  if (head.length) lines.push(head.join(' · '));

  // Directives are standing instructions set on the dashboard — the highest-
  // priority content in the block, so they land before everything else.
  if (Array.isArray(p.directives) && p.directives.length) {
    lines.push('', '**Directives — honour these first (set on the Stack dashboard)**', bullets(p.directives, 8));
  }

  if (p.northStar) lines.push('', `**North star:** ${String(p.northStar).replace(/\s+/g, ' ').trim().slice(0, 500)}`);

  if (p.summary) lines.push('', p.summary);

  if (Array.isArray(p.inProgress) && p.inProgress.length) lines.push('', '**Currently in progress**', bullets(p.inProgress));
  if (Array.isArray(p.nextUp) && p.nextUp.length) lines.push('', '**Suggested next**', bullets(p.nextUp));
  if (Array.isArray(p.blockers) && p.blockers.length) lines.push('', '**Blockers**', bullets(p.blockers));

  const openBugs = Array.isArray(p.bugs) ? p.bugs.filter((b) => b && b.status !== 'fixed').length : 0;
  lines.push('', `Open bugs: ${openBugs}`);

  const recent = (Array.isArray(p.activity) ? p.activity : []).slice(0, 3);
  if (recent.length) {
    lines.push('', '**Recent activity**');
    for (const a of recent) {
      const tag = a.hash && a.hash !== '—' ? `${a.hash} ` : '';
      const when = a.when ? `(${a.when}) ` : '';
      const sum = String(a.summary || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      lines.push(`- ${tag}${when}${sum}`.trimEnd());
    }
  }

  lines.push('', 'This reflects the live Stack state — trust it rather than reconstructing context from scratch.');
  lines.push(
    'When you wrap up meaningful work, run `/checkpoint` to author a rich resume update ' +
    '(free, no external API). The SessionEnd hook records metadata automatically as a backstop.'
  );
  return lines.join('\n');
}

(async () => {
  const api = process.env.STACK_API;
  const token = process.env.STACK_TOKEN;
  if (!api || !token) done(''); // not configured — stay silent

  let payload = {};
  if (!DEMO) {
    try { payload = JSON.parse(readStdin() || '{}'); } catch { payload = {}; }
  }
  const cwd = DEMO ? process.cwd() : (payload.cwd || process.cwd());
  const slug = slugFromGit(cwd);
  if (!slug) done('');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const base = api.replace(/\/$/, '');

  // Fire the live-now presence ping alongside the state fetch — same budget,
  // same abort, and a failure is silent (presence is a nicety, never a gate).
  // Untracked projects 404 here and simply don't register.
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || null;
  const ping = fetch(`${base}/api/presence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ slug, session_id: payload.session_id || '', branch, cwd }),
    signal: ctrl.signal,
  }).catch(() => {});

  try {
    const res = await fetch(`${base}/api/projects/${encodeURIComponent(slug)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    await ping; // let the ping land before any exit below
    clearTimeout(timer);
    if (res.status === 404) done('');           // not tracked yet — nothing to say
    if (!res.ok) done('');                       // auth/other error — stay silent
    const project = await res.json();
    done(buildBlock(project));
  } catch (e) {
    await ping;
    clearTimeout(timer);
    log(`could not reach ${api}: ${e.message}`);
    done(''); // unreachable — never delay startup
  }
})();
