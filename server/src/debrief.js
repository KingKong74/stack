// Turns an autopilot run's debrief material into a flat list of actionable
// insights a human can pull onto the Workbench canvas or into the idea
// funnel. Two very different sources feed it, and they are NOT treated
// alike:
//
//   • the STRUCTURED half — the session's own `next_steps`/`blockers`
//     (checkpointed by the session itself) and the advisor's stored reads
//     (`review_note` / `architect_note` / `architect_obs`) — is trustworthy.
//     It was written to be read as a list of items, so it is taken close to
//     verbatim.
//   • the PROSE half — `run.summary`, the model's own free-text closing
//     account of the night — is not a list at all. It is a paragraph a model
//     wrote for a human, and `actionableLines()` is a salvage pass over it:
//     structural cues (headings, list markers) plus a small keyword net, no
//     clever NLP. That is why it sorts last and lands as kind 'note' rather
//     than 'next-step' — it is a guess, not a record.
//
// This module PROPOSES only. Nothing here writes to the database or the
// network — it is pure, takes rows the caller already fetched, and returns
// data for the caller to show. What lands on the canvas is the human's call.

import { fingerprint } from './util.js';

export const INSIGHT_KINDS = ['blocker', 'next-step', 'advisor', 'note'];

// ---------------------------------------------------------------------------
// The prose parser — structured extraction + keyword matching only.
// ---------------------------------------------------------------------------

const ACTIONABLE_HEADING_RE =
  /next|follow[- ]?up|todo|to do|remaining|not done|left|outstanding|blocked|blocker|out of scope|suggest|recommend|open question/i;

const ACTIONABLE_VERBS = [
  'add', 'wire', 'fix', 'build', 'split', 'move', 'rename', 'extend', 'expose',
  'replace', 'remove', 'drop', 'teach', 'make', 'write', 'check', 'verify',
  'test', 'cover', 'document', 'refactor', 'migrate', 'land', 'ship', 'handle',
  'guard', 'cap', 'surface', 'hook', 'port', 'tidy', 'unify', 'delete',
  'consider', 'review',
];
const ACTIONABLE_VERB_RE = new RegExp(`^(?:${ACTIONABLE_VERBS.join('|')})\\b`, 'i');

const CONTAINS_RE =
  /should be|needs to|needs a|worth |could be|next move|follow-up|still to|not attempted|was not|would be better|todo/i;

const PAST_TENSE_RE = /^(?:built|added|landed|shipped|fixed|committed|pushed|wrote|ran|done)\b/i;

// A heading is tracked but never itself an insight: a markdown heading, a
// short line ending in ':', or a bold-only line.
function isHeading(line) {
  if (/^#{1,6}(?:\s|$)/.test(line)) return true;
  if (line.length <= 80 && line.endsWith(':')) return true;
  if (/^(?:\*\*|__)[^*_]+(?:\*\*|__)$/.test(line)) return true;
  return false;
}

// Strip leading list markers (possibly stacked, e.g. "- [ ] ") and any
// wrapping markdown emphasis around what's left.
function stripMarker(line) {
  let s = line;
  let changed = true;
  while (changed) {
    const before = s;
    s = s.replace(/^\s*(?:[-*•–]|\d+[.)]|\[[ xX]\])\s*/, '');
    changed = s !== before;
  }
  s = s.trim();
  const m = s.match(/^(\*\*|__|\*|_)([\s\S]*)\1$/);
  if (m && m[2]) s = m[2];
  return s.trim();
}

// The prose parser. Reads a free-text block (typically `run.summary`) and
// returns the lines worth surfacing as insights, in document order,
// de-duplicated, capped at 8.
export function actionableLines(text) {
  const s = String(text || '');
  if (!s.trim()) return [];

  const lines = s.split('\n');
  let heading = '';
  let inFence = false;
  const seen = new Set();
  const out = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) continue;

    if (isHeading(line)) {
      heading = line;
      continue;
    }

    const stripped = stripMarker(line);
    if (!stripped) continue;
    if (stripped.length < 12 || stripped.length > 300) continue;
    if ((stripped.match(/ /g) || []).length < 2) continue;

    const headingActionable = ACTIONABLE_HEADING_RE.test(heading);
    const keep =
      headingActionable ||
      ACTIONABLE_VERB_RE.test(stripped) ||
      CONTAINS_RE.test(stripped);
    if (!keep) continue;

    if (PAST_TENSE_RE.test(stripped) && !headingActionable) continue;

    const key = stripped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(stripped);
    if (out.length >= 8) break;
  }

  return out;
}

// ---------------------------------------------------------------------------
// extractInsights
// ---------------------------------------------------------------------------

// Coerce an array that may hold plain strings or `{ title }` objects (the
// shape `sessions.next_steps`/`blockers` jsonb columns tolerate) into trimmed
// strings.
function normalizeList(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      if (typeof x === 'string') return x;
      if (x && typeof x === 'object') return String(x.title ?? '');
      return '';
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

// Walk sessions newest-first and take the FIRST one with any content in the
// given list field — later sessions' lists are stale restatements of the
// same checkpoint, not additional items.
function firstNonEmptyList(sessions, field) {
  for (const s of sessions || []) {
    const list = normalizeList(s?.[field]);
    if (list.length) return list;
  }
  return [];
}

// review_note / architect_note: the advisor's own stored read. It is already
// curated — not narration to salvage — so the default is to keep it whole as
// one insight. Only when it is visibly multi-line/bulleted do we split it,
// reusing the prose parser's heading-tracking and marker-stripping (but not
// its actionability keyword filter, which the advisor's own words don't need
// to pass).
function splitAdvisorNote(text) {
  const s = String(text || '').trim();
  if (!s) return [];

  const looksMultiline = /\n/.test(s) || /^\s*(?:[-*•–]|\d+[.)]|\[[ xX]\])\s*/.test(s);
  if (!looksMultiline) return [s.slice(0, 300)];

  let inFence = false;
  const seen = new Set();
  const out = [];
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) continue;
    if (isHeading(line)) continue;
    const stripped = stripMarker(line);
    if (!stripped) continue;
    const key = stripped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(stripped.slice(0, 300));
  }
  return out.length ? out : [s.slice(0, 300)];
}

// An architect_obs element may be a bare string or an object carrying the
// text under one of a few possible keys.
function obsText(el) {
  if (typeof el === 'string') return el;
  if (el && typeof el === 'object') {
    const v = el.text ?? el.t ?? el.title ?? el.note;
    return v != null ? String(v) : '';
  }
  return '';
}

function mk(kind, from, rawText) {
  const text = String(rawText || '').trim().slice(0, 300);
  if (!text) return null;
  return { key: fingerprint(text), kind, from, text };
}

// run: an autopilot_runs row (snake_case). sessions: the sessions rows for
// the SAME branch, newest first. Returns { insights, truncated }.
export function extractInsights(run = {}, sessions = [], opts = {}) {
  const cap = opts.cap ?? 12;
  const r = run || {};
  const candidates = [];

  for (const text of firstNonEmptyList(sessions, 'blockers')) {
    const ins = mk('blocker', 'session', text);
    if (ins) candidates.push(ins);
  }
  for (const text of firstNonEmptyList(sessions, 'next_steps')) {
    const ins = mk('next-step', 'session', text);
    if (ins) candidates.push(ins);
  }
  for (const text of splitAdvisorNote(r.review_note)) {
    const ins = mk('advisor', 'reviewer', text);
    if (ins) candidates.push(ins);
  }
  for (const text of splitAdvisorNote(r.architect_note)) {
    const ins = mk('advisor', 'architect', text);
    if (ins) candidates.push(ins);
  }
  if (Array.isArray(r.architect_obs)) {
    for (const el of r.architect_obs) {
      const ins = mk('advisor', 'architect', obsText(el));
      if (ins) candidates.push(ins);
    }
  }
  for (const text of actionableLines(r.summary)) {
    const ins = mk('note', 'debrief', text);
    if (ins) candidates.push(ins);
  }

  const seen = new Set();
  const deduped = [];
  for (const c of candidates) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    deduped.push(c);
  }

  const truncated = Math.max(0, deduped.length - cap);
  const insights = deduped.slice(0, cap);
  return { insights, truncated };
}
