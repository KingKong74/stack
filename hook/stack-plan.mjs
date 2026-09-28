#!/usr/bin/env node
// Stack — Claude Code PostToolUse hook on ExitPlanMode.
//
// When a human APPROVES a plan-mode plan, this posts it to
// /api/projects/<slug>/plans so the Plans tab can show it. PostToolUse fires
// only after the tool ran, and ExitPlanMode only runs on approval, so a
// rejected plan never lands. It records and nothing else: it writes no
// roadmap row (routes/plans.js says why).
//
// WHERE THE PLAN IS. ExitPlanMode takes no plan as input — Claude writes the
// plan to ~/.claude/plans/<random-slug>.md first and the tool reads it from
// there. So the text is found, in order of trust:
//   1. `tool_input.plan` / `tool_response.plan`, if this Claude Code version
//      puts it there (undocumented; read defensively, never required);
//   2. a `planFilePath` in either of those;
//   3. the LAST ~/.claude/plans/*.md path the session's own transcript names
//      (the plan-mode system message names the file) — this session's file,
//      even when another session planned more recently;
//   4. the newest file in ~/.claude/plans touched in the last 30 minutes.
// Step 4 can pick another session's plan when two plan at once; it is the
// backstop, not the answer, and the post names which file it used.
//
// Always exits 0, logs only to stderr, never prints the token. Fails open like
// the other hooks: an unreachable settings read means "record".
//
// Test without a session:  node stack-plan.mjs --demo [path/to/plan.md]

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { loadStackEnv, logStderr, projectFromGit, fetchSettings } from './stack-post.mjs';

loadStackEnv();

const DEMO = process.argv.includes('--demo');
const PLANS_DIR = join(homedir(), '.claude', 'plans');
const RECENT_MS = 30 * 60 * 1000;

function die0(msg) { if (msg) logStderr(msg); process.exit(0); }

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function readFile(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

// The last plans-dir path this session's transcript mentions.
export function planFileFromTranscript(raw, dir = PLANS_DIR) {
  const esc = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hits = raw.match(new RegExp(`${esc}/[A-Za-z0-9._-]+\\.md`, 'g'));
  return hits ? hits[hits.length - 1] : '';
}

function newestRecentPlan(dir = PLANS_DIR) {
  let best = '', bestAt = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const at = statSync(join(dir, f)).mtimeMs;
      if (at > bestAt) { best = join(dir, f); bestAt = at; }
    }
  } catch { return ''; }
  return Date.now() - bestAt <= RECENT_MS ? best : '';
}

// -> { body, file } or null.
export function findPlan(payload, { dir = PLANS_DIR } = {}) {
  const input = payload.tool_input || {};
  const resp = typeof payload.tool_response === 'object' && payload.tool_response ? payload.tool_response : {};
  for (const src of [input, resp]) {
    if (typeof src.plan === 'string' && src.plan.trim()) {
      return { body: src.plan, file: String(src.planFilePath || src.filePath || '') };
    }
  }
  const named = [input.planFilePath, resp.planFilePath, resp.filePath].find((p) => typeof p === 'string' && p);
  const fromTranscript = payload.transcript_path
    ? planFileFromTranscript(readFile(payload.transcript_path), dir) : '';
  for (const f of [named, fromTranscript, newestRecentPlan(dir)]) {
    if (!f || !existsSync(f)) continue;
    const body = readFile(f);
    if (body.trim()) return { body, file: f };
  }
  return null;
}

async function main() {
  let payload = {};
  if (DEMO) {
    const f = process.argv.slice(2).find((a) => !a.startsWith('--'));
    payload = { tool_name: 'ExitPlanMode', cwd: process.cwd(), session_id: 'demo', tool_input: f ? { planFilePath: f } : {} };
  } else {
    try { payload = JSON.parse(readStdin() || '{}'); } catch { die0('stack-plan: unreadable hook input'); }
  }
  if (payload.tool_name && payload.tool_name !== 'ExitPlanMode') die0();

  const settings = await fetchSettings();
  if (settings.autoRecord === false) die0();

  const plan = findPlan(payload);
  if (!plan) die0('stack-plan: approved a plan but could not find its text; nothing posted');

  const cwd = payload.cwd || process.cwd();
  const project = projectFromGit(cwd);
  const api = process.env.STACK_API;
  const token = process.env.STACK_TOKEN;
  if (!api || !token) die0('stack-plan: STACK_API and STACK_TOKEN must be set in ~/.stack/env');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${api.replace(/\/$/, '')}/api/projects/${encodeURIComponent(project.slug)}/plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        body: plan.body,
        planFile: plan.file ? basename(plan.file) : '',
        sessionId: payload.session_id || '',
        branch: project.branch || '',
        commit: project.commit || '',
      }),
      signal: ctrl.signal,
    });
    if (res.status === 404) die0(`stack-plan: Stack has no project "${project.slug}" yet; plan not recorded`);
    if (!res.ok) die0(`stack-plan: post failed (${res.status})`);
    if (DEMO) logStderr(`stack-plan: recorded ${plan.file ? basename(plan.file) : 'inline plan'} on ${project.slug}`);
  } catch (e) {
    die0(`stack-plan: post failed (${e.message})`);
  } finally {
    clearTimeout(timer);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => die0(`stack-plan: ${e.message}`));
