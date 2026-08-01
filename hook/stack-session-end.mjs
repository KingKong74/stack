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
  loadStackEnv, logStderr, projectFromGit, fetchSettings, postIngest, endPresence, git,
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

// ---- the commit THIS session made ----
// HEAD is the wrong answer whenever sessions run in parallel in one checkout:
// by the time this one ends another session has pushed, so posting HEAD files
// this session's work under someone else's commit — and before the ingest match
// order was fixed, under someone else's activity row.
//
// The honest source is the session's own `git commit` calls: the hashes that
// came back from a Bash command that actually committed. Not every hash in the
// transcript — a session reads plenty of other commits — and not a bare
// `[branch hash]` scrape either, since a committing command is just as likely
// to be `git commit -q … && git log --oneline -1`. So: pair each tool result
// with the command that produced it, keep the hashes only from the committing
// ones, and take the last that still resolves in the repo.
const HEX = /\b([0-9a-f]{7,40})\b/g;
const COMMITTING = /\bgit\b(?![^\n]*--dry-run)[^\n]*\bcommit\b/;

function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && b.type === 'text' ? b.text : '')).join('\n');
  return '';
}

function parseTranscript(path, cwd) {
  let raw = '';
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  const turns = [];      // { role, text }
  const tools = new Set();
  const files = new Set();
  let model = null;
  // Real token usage (#178): each assistant event carries message.usage —
  // summed here (deduped by message id, same rule as the terminal's
  // usage-meter) so manual sessions report usage like autopilot runs do.
  let tokens = 0;
  const seenUsage = new Set();
  // Per-model usage for an INTERACTIVE session. Same shape the autopilot
  // persists for its runs (`model_usage`), so the Roles room reads one shape
  // for both populations — minus costUSD, which a transcript never carries.
  // A session that switches model mid-flight (⇥ fast mode, /model) genuinely
  // ran two, and this is the only record that it did.
  const modelUsage = {};
  // Agent delegations. The parent transcript records the CALL and its result
  // but never the subagent's own usage — there is no isSidechain row to sum —
  // so this is a count of delegations and the types used, and must never be
  // presented as spend.
  let agentCalls = 0;
  const agentTypes = {};
  const bump = (id, u) => {
    // '<synthetic>' marks a message the CLI generated rather than a model call.
    if (!id || id === '<synthetic>') return;
    const m = modelUsage[id] || (modelUsage[id] = {
      inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    });
    m.inputTokens += Number(u.input_tokens) || 0;
    m.outputTokens += Number(u.output_tokens) || 0;
    m.cacheReadInputTokens += Number(u.cache_read_input_tokens) || 0;
    m.cacheCreationInputTokens += Number(u.cache_creation_input_tokens) || 0;
  };
  const committing = new Set();   // tool_use ids of Bash calls that ran `git commit`
  const commitHits = [];          // hashes those calls printed, in order
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const msg = ev.message || ev;
    const role = msg.role || ev.type;
    if (ev.model) model = ev.model;
    if (msg.model) model = msg.model;

    const u = msg.usage;
    if (u && typeof u === 'object' && (!msg.id || !seenUsage.has(msg.id))) {
      if (msg.id) seenUsage.add(msg.id);
      tokens += (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
        + (Number(u.cache_creation_input_tokens) || 0);
      // Attributed to THIS message's model, not the last one seen: `model`
      // above is the session's headline and moves as the session switches.
      bump(msg.model || ev.model, u);
    }

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
        // Both names: Task is what the tool was called before Agent.
        if (block.name === 'Agent' || block.name === 'Task') {
          agentCalls += 1;
          const t = String(block.input?.subagent_type || 'claude').slice(0, 40);
          agentTypes[t] = (agentTypes[t] || 0) + 1;
        }
        const fp = block.input?.file_path || block.input?.path || block.input?.notebook_path;
        if (fp && EDIT_TOOLS.has(block.name)) files.add(String(fp));
        const cmd = block.input?.command;
        if (block.id && typeof cmd === 'string' && COMMITTING.test(cmd)) committing.add(block.id);
      } else if (block.type === 'tool_result' && !block.is_error && committing.has(block.tool_use_id)) {
        for (const m of resultText(block).matchAll(HEX)) commitHits.push(m[1]);
      }
    }
  }

  // Last hash that still resolves to a real commit — a rewritten or discarded
  // one simply doesn't, and we fall further back rather than posting a hash the
  // repo has never heard of.
  let commit = null;
  for (let i = commitHits.length - 1; i >= 0 && !commit; i--) {
    commit = git(cwd, ['rev-parse', '--short', `${commitHits[i]}^{commit}`]) || null;
  }

  return {
    turns, tools: [...tools], files: [...files], model, messageCount: turns.length, tokens, commit,
    modelUsage, agentCalls, agentTypes,
  };
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
    // Still proceed on bad stdin (the hook must never block), but say so —
    // a silent {} here made hook-payload issues invisible (#185/#218).
    try { payload = JSON.parse(readStdin() || '{}'); } catch { logStderr('hook stdin was not valid JSON — proceeding without it.'); payload = {}; }
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
      tokens: 0,
      modelUsage: {},
      agentCalls: 0,
      agentTypes: {},
    };
  } else {
    t = parseTranscript(payload.transcript_path, cwd);
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
      // this session's own commit; HEAD only when it committed nothing
      commit_hash: t.commit || project.commit,
      branch: project.branch,
      cwd,
      model: t.model,
      reason: payload.reason || (DEMO ? 'demo' : 'exit'),
      message_count: t.messageCount,
      tokens_used: t.tokens || 0, // real transcript usage (#178)
      // Per-model usage + delegations, so the Roles room can show what an
      // INTERACTIVE session ran on. Only the hook can know either — it is the
      // only thing that reads the transcript — so /checkpoint never sends them.
      model_usage: t.modelUsage && Object.keys(t.modelUsage).length ? t.modelUsage : null,
      agent_calls: t.agentCalls || 0,
      agent_types: t.agentTypes && Object.keys(t.agentTypes).length ? t.agentTypes : null,
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
  const posted = body.session.commit_hash;
  logStderr(`metadata checkpoint saved for ${project.slug}${posted ? ` @ ${posted}` : ''}`);
  process.exit(0);
})();
