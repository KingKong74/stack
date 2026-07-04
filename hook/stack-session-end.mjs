#!/usr/bin/env node
// Stack — Claude Code SessionEnd hook.
//
// A clean automatic backstop. When a session ends it parses the transcript for
// the commit, branch, files touched, tools used, message count and the last
// substantive assistant message, and POSTs that as a *metadata* checkpoint to
// the Stack API. It calls NO external API — rich resume summaries are authored
// by Claude via the /checkpoint command (free, no API). This hook's only job is
// to guarantee the activity feed never has gaps.
//
// It is idempotent and COALESCE-safe: a metadata post never overwrites a richer
// Claude-authored checkpoint for the same commit/session (the server keeps the
// authored summary and the resume card untouched). It always exits 0, so it can
// never block or delay Claude Code stopping.
//
// Config (environment variables, loaded from ~/.stack/env):
//   STACK_API     required  e.g. https://stack.example.com
//   STACK_TOKEN   required  must match the server's API_TOKEN
//   STACK_MIN_MESSAGES  optional  skip sessions shorter than this (default 2)
//
// Behaviour also bends to the server-side settings (fetched, bounded, default-on):
//   auto_record    off  → the hook posts nothing
//   include_chores off  → a session that edited no files is treated as a chore
//                         and skipped (nothing substantive to record)
//
// Test without a real session:  node stack-session-end.mjs --demo

import { readFileSync } from 'node:fs';
import {
  loadStackEnv, logStderr, projectFromGit, fetchSettings, postIngest, endPresence,
} from './stack-post.mjs';

loadStackEnv();

const DEMO = process.argv.includes('--demo');
const MIN_MESSAGES = parseInt(process.env.STACK_MIN_MESSAGES || '2', 10);

function die0(msg) { if (msg) logStderr(msg); process.exit(0); } // never block Claude Code

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

// ---- transcript parsing ----
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'str_replace', 'create_file']);

function parseTranscript(path) {
  let raw = '';
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  const turns = [];      // { role, text }
  const tools = new Set();
  const files = new Set();
  let model = null;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const msg = ev.message || ev;
    const role = msg.role || ev.type;
    if (ev.model) model = ev.model;
    if (msg.model) model = msg.model;

    const content = msg.content;
    if (typeof content === 'string') {
      if (role === 'user' || role === 'assistant') turns.push({ role, text: content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && block.text) {
        if (role === 'user' || role === 'assistant') turns.push({ role, text: block.text });
      } else if (block.type === 'tool_use' && block.name) {
        tools.add(block.name);
        const fp = block.input?.file_path || block.input?.path || block.input?.notebook_path;
        if (fp && EDIT_TOOLS.has(block.name)) files.add(String(fp));
      }
    }
  }
  return { turns, tools: [...tools], files: [...files], model, messageCount: turns.length };
}

// The last assistant message with real substance (not a one-line tool ack),
// collapsed to a single paragraph and capped. This is the activity-feed summary.
function lastSubstantiveMessage(turns) {
  const assistant = turns.filter((t) => t.role === 'assistant');
  for (let i = assistant.length - 1; i >= 0; i--) {
    const text = assistant[i].text.replace(/\s+/g, ' ').trim();
    if (text.length >= 40) return text.slice(0, 700);
  }
  const last = assistant[assistant.length - 1];
  return (last?.text || '').replace(/\s+/g, ' ').trim().slice(0, 700) || null;
}

// ---- main ----
(async () => {
  if (!process.env.STACK_API || !process.env.STACK_TOKEN) {
    die0('STACK_API and STACK_TOKEN must be set; skipping.');
  }

  let payload = {};
  if (!DEMO) {
    try { payload = JSON.parse(readStdin() || '{}'); } catch { payload = {}; }
  }

  const cwd = DEMO ? process.cwd() : (payload.cwd || process.cwd());
  const project = projectFromGit(cwd);

  // The session is over regardless of the gates below — clear its live-now
  // presence row first (bounded, silent; the server TTL is the backstop).
  await endPresence({ slug: project.slug, session_id: payload.session_id });

  // Settings gate — bounded, defaults to on if the API is unreachable.
  const settings = await fetchSettings();
  if (!settings.autoRecord) die0('auto_record is off; skipping the metadata backstop.');

  // Parse the transcript (or synthesise for --demo).
  let t;
  if (DEMO) {
    t = {
      turns: [{ role: 'assistant', text: 'Recorded a metadata checkpoint for this push: commit, branch, files touched and tools used. Rich summaries come from /checkpoint.' }],
      tools: ['Write', 'Edit', 'Bash'],
      files: ['web/src/store.ts', 'server/src/routes/ingest.js'],
      model: null,
      messageCount: 12,
    };
  } else {
    t = parseTranscript(payload.transcript_path);
    if (!t || t.messageCount < MIN_MESSAGES) {
      die0('transcript missing or too short; skipping.');
    }
  }

  // include_chores off → skip a session that edited no files (nothing of
  // substance to record beyond bare metadata).
  if (!settings.includeChores && t.files.length === 0 && !DEMO) {
    die0('no files edited and include_chores is off; skipping chore-only session.');
  }

  const summary = lastSubstantiveMessage(t.turns);

  // A metadata-only checkpoint: authored = false, no extraction. The server
  // keeps any richer authored summary/resume for the same commit untouched.
  const body = {
    project: { slug: project.slug, name: project.name, repo: project.repo, repo_url: project.repo_url },
    session: {
      session_id: payload.session_id || null,
      commit_hash: project.commit,
      branch: project.branch,
      cwd,
      model: t.model,
      reason: payload.reason || (DEMO ? 'demo' : 'exit'),
      message_count: t.messageCount,
      authored: false,
      summary,
      files_touched: t.files,
      tools_used: t.tools,
      tags: [],
      // resume sub-lists intentionally empty — only /checkpoint writes those
      current_phase: null, next_steps: [], blockers: [],
      in_progress: [], next_up: [], working_well: [],
    },
    extract: { bugs: [], next_steps: [] },
  };

  const result = await postIngest(body);
  if (!result.ok) {
    die0(`could not record metadata checkpoint${result.status ? ` (HTTP ${result.status})` : ''}${result.reason ? `: ${result.reason}` : ''}`);
  }
  logStderr(`metadata checkpoint saved for ${project.slug}${project.commit ? ` @ ${project.commit}` : ''}`);
  process.exit(0);
})();
