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


// ONE definition of what a night's "debrief" is (#286/#24a). The Review room's
// nights list and Mission Control's NightDebrief panel had each grown their own
// copy of this arithmetic — landed/failed/planned counts, the reviewer/architect
// rollup, where the two disagree, what the night is still waiting on — and the
// copies were already drifting on the two rules that are easy to get wrong by
// guessing:
//
//   - A PLAN night is the advisor working, not the advisor idle (CLAUDE.md).
//     `outcome:'planned'` is counted on its own axis and is NEVER landed and
//     NEVER failed — folding it into either scores a night that did exactly
//     what it was asked to do as having produced nothing, or as broken.
//   - An empty second-model read means NO PASS RAN, not "nothing found". A
//     night with zero reviewed runs must come back `{ran: 0, clean: 0, ...}`,
//     never something a caller could mistake for a clean sweep. Same for the
//     architect.
//
// The five outcomes (schema.sql: landed | no-commits | failed | limit |
// planned) are partitioned across FOUR stats buckets — landed, failed
// (failed + limit), planned, noCommits — so those four always sum to
// `stats.runs`. `noCommits` gets its own bucket rather than folding into
// `failed`: a run that legitimately found nothing to do is not a failure,
// and letting it fall through every bucket is the same absence-reads-as-
// good-news mistake as an unrun reviewer — a night that ran and produced
// nothing must not disappear from the count.
//
// Pure and DB-free by design (no import from db.js, no I/O) so it can be
// pinned without a server:
//   node server/test/debrief.test.mjs
//
// Callers pass it the ALREADY-SHAPED run rows (the Workbench's debrief pull,
// built from shape.js's runCore()/agentReads()) plus the per-push Gemini
// notes — this module only does the arithmetic, never the shaping.

// BIGINT/NUMERIC arrive from pg as STRINGS; a run passed in from anywhere
// other than review.js's already-coerced shape must not be trusted to be a
// number. Never let a bad value turn a sum into NaN or a concatenated string.
const num = (x) => Number(x) || 0;

// reviewFindings is an INT count (schema.sql), but guard the same way for a
// caller that hands through something array-shaped — either way, absent
// counts as zero, never as NaN.
const findingsOf = (r) => (Array.isArray(r.reviewFindings) ? r.reviewFindings.length : num(r.reviewFindings));

// A short, stable reference to the run's own item or, failing that, its
// branch — every decision sentence names WHAT it is about.
const refOf = (r) => (r.itemId ? `#${r.itemId} ${r.itemTitle || 'item'}` : r.branch || 'this run');

// A push note attaches to the run it was written about, and ONLY by branch
// (plus slug, when both sides carry one) — never by array position, since the
// two lists are not parallel. The LAST matching note wins, matching how the
// notes list itself is ordered (newest appended last).
function pushNoteFor(run, notes) {
  let found = '';
  for (const n of notes) {
    if (!run.branch || n.branch !== run.branch) continue;
    if (n.slug && run.slug && n.slug !== run.slug) continue;
    found = n.note || '';
  }
  return found;
}

// One line, at most, per run — in this precedence, first match wins. A run
// can be blocked AND red AND paused; only the most actionable of those is
// worth a row, or the debrief reads as louder than the decision actually is.
const DECISION_KINDS = [
  {
    kind: 'blocked',
    tag: 'BLOCKED',
    test: (r) => r.reviewVerdict === 'blocked',
    sentence: (r) => `${refOf(r)} was blocked by the reviewer — it needs a look before it goes any further.`,
  },
  {
    kind: 'checks',
    tag: 'CHECKS',
    test: (r) => num(r.checksFailing) > 0,
    sentence: (r) => {
      const n = num(r.checksFailing);
      return `${refOf(r)} left ${n} check${n === 1 ? '' : 's'} red — worth closing before the next night.`;
    },
  },
  {
    kind: 'paused',
    tag: 'PAUSED',
    test: (r) => r.outcome === 'limit',
    sentence: (r) => `${refOf(r)} stopped on the usage limit and is waiting to resume.`,
  },
  {
    kind: 'failed',
    tag: 'FAILED',
    test: (r) => r.outcome === 'failed',
    sentence: (r) => `${refOf(r)} failed outright and needs a look.`,
  },
];

export function composeDebrief({ day, slug = null, runs = [], notes = [] }) {
  const list = Array.isArray(runs) ? runs : [];
  const noteList = Array.isArray(notes) ? notes : [];

  const landedRuns = list.filter((r) => r.outcome === 'landed');
  const plannedRuns = list.filter((r) => r.outcome === 'planned');
  // "failed" reads the real outcome vocabulary (schema.sql): landed |
  // no-commits | failed | limit | planned. `limit` is a stop, not a plan, and
  // it is NOT a landed run either — it counts alongside 'failed' here, and
  // gets its own, gentler 'paused' decision below rather than a 'failed' tag.
  const failedRuns = list.filter((r) => r.outcome === 'failed' || r.outcome === 'limit');
  const noCommitsRuns = list.filter((r) => r.outcome === 'no-commits');

  const tokens = list.reduce((n, r) => n + num(r.tokens), 0);
  const costUsd = list.reduce((n, r) => n + num(r.costUsd), 0);
  const landed = landedRuns.length;
  const projects = new Set(list.map((r) => r.slug).filter(Boolean)).size;

  const reviewedRuns = list.filter((r) => r.reviewVerdict);
  const archedRuns = list.filter((r) => r.architectVerdict);
  const aligned = archedRuns.filter((r) => r.architectVerdict === 'aligned').length;

  // Both verdicts present AND pointed the opposite way on the SAME run — the
  // only honest basis for "where they disagree".
  const disagree = list
    .filter((r) => r.reviewVerdict && r.architectVerdict
      && ((r.reviewVerdict !== 'clean' && r.architectVerdict === 'aligned')
        || (r.reviewVerdict === 'clean' && r.architectVerdict !== 'aligned')))
    .map((r) => ({
      slug: r.slug ?? null,
      itemId: r.itemId ?? null,
      itemTitle: r.itemTitle || '',
      branch: r.branch || '',
      reviewVerdict: r.reviewVerdict,
      architectVerdict: r.architectVerdict,
    }));

  // At most one decision per run — the FIRST kind (in DECISION_KINDS order)
  // it qualifies for, so a run that is both blocked and red yields BLOCKED
  // alone rather than two rows arguing for the same attention. One pass over
  // the runs, bucketed by kind, so the output stays kind-precedence-then-
  // input-order without re-scanning DECISION_KINDS per run.
  const buckets = new Map(DECISION_KINDS.map((d) => [d.kind, []]));
  for (const r of list) {
    const def = DECISION_KINDS.find((d) => d.test(r));
    if (!def) continue;
    buckets.get(def.kind).push({
      kind: def.kind,
      tag: def.tag,
      slug: r.slug ?? null,
      itemId: r.itemId ?? null,
      itemTitle: r.itemTitle || '',
      branch: r.branch || '',
      sentence: def.sentence(r),
    });
  }
  const decisionsOnce = DECISION_KINDS.flatMap((d) => buckets.get(d.kind));

  return {
    day,
    scope: slug || null,
    ran: list.length > 0,
    stats: {
      runs: list.length,
      landed,
      failed: failedRuns.length,
      planned: plannedRuns.length,
      noCommits: noCommitsRuns.length,
      projects,
      tokens,
      costUsd,
      costPerLanded: landed > 0 ? costUsd / landed : null,
    },
    runs: list.map((r) => ({ ...r, pushNote: pushNoteFor(r, noteList) })),
    reviewer: {
      ran: reviewedRuns.length,
      clean: reviewedRuns.filter((r) => r.reviewVerdict === 'clean').length,
      flagged: reviewedRuns.filter((r) => r.reviewVerdict === 'concerns').length,
      blocked: reviewedRuns.filter((r) => r.reviewVerdict === 'blocked').length,
      findings: reviewedRuns.reduce((n, r) => n + findingsOf(r), 0),
    },
    architect: {
      ran: archedRuns.length,
      aligned,
      drifted: archedRuns.length - aligned,
    },
    disagree,
    decisions: decisionsOnce,
  };
}
