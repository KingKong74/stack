#!/usr/bin/env node
// Stack — optional second-model review via Gemini.
//
// Free-tier Gemini is sanctioned app-wide (owner's decision, 2026-07-16 —
// only PAID external AI APIs are banned). This script runs on demand or from
// the autopilot (scripts/stack-autopilot.mjs) after an unattended session;
// findings are suggestions only, landing in the review inbox for a human verdict.
//
// What it does: reads a commit range's diff from the CURRENT repo, asks Gemini
// to review it as a second model, and posts the findings to Stack via the
// normal ingest path — so bugs/next-steps/ideas land in the review inbox,
// deduped by fingerprint and honouring tombstones, exactly like hook extracts.
//
// Usage (from a project directory):
//   node ~/.stack/stack-gemini-review.mjs               # review the last commit
//   node ~/.stack/stack-gemini-review.mjs --range A..B  # review a range
//   node ~/.stack/stack-gemini-review.mjs --dry         # print, don't post
//
// Env (~/.stack/env — never printed, never committed):
//   GEMINI_API_KEY  required   an AI Studio key (free tier is fine)
//   GEMINI_MODEL    optional   default gemini-2.5-flash
//   STACK_API / STACK_TOKEN    the usual Stack pair (for the ingest post)

import { loadStackEnv, logStderr, git, projectFromGit, postIngest } from './stack-post.mjs';

loadStackEnv();

const DRY = process.argv.includes('--dry');
const rangeIdx = process.argv.indexOf('--range');
const RANGE = rangeIdx > -1 ? process.argv[rangeIdx + 1] : null;

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// Free-tier quotas are per model, so a 429 on the primary is retried once on
// the fallback (same convention as the server's gemini.js). '' disables.
const FALLBACK = process.env.GEMINI_FALLBACK_MODEL !== undefined
  ? process.env.GEMINI_FALLBACK_MODEL
  : 'gemini-2.5-flash-lite';
const KEY = process.env.GEMINI_API_KEY;
const DIFF_CAP = 60_000; // chars of diff we send; beyond this the tail is cut

function die(msg) { logStderr(msg); process.exit(1); }

if (!KEY) die('GEMINI_API_KEY is not set in ~/.stack/env — add it to enable second-model reviews.');

const cwd = process.cwd();
const commit = git(cwd, ['rev-parse', '--short', 'HEAD']);
if (!commit) die('Not a git repository (or no commits yet).');
const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
const subject = git(cwd, ['log', '-1', '--format=%s']) || '';

// Default range: the last commit (fall back to the root-commit diff).
const range = RANGE || (git(cwd, ['rev-parse', 'HEAD~1']) ? 'HEAD~1..HEAD' : commit);
let diff = git(cwd, ['diff', range]);
if (!diff) die(`Nothing to review in ${range}.`);
if (diff.length > DIFF_CAP) diff = `${diff.slice(0, DIFF_CAP)}\n… (diff truncated at ${DIFF_CAP} chars)`;

const prompt = `You are a senior software engineer doing a second-opinion code review.
Review the following git diff (commit "${subject}", range ${range}). Be precise and only
report findings the diff actually evidences — no speculation, no style nitpicks.
Use en-AU spelling. Titles at most 15 words.

Respond with ONLY a JSON object, no markdown fences, in exactly this shape:
{
  "summary": "one or two sentences on the overall quality of the change",
  "bugs": [{ "title": "…", "severity": "critical|high|medium|low" }],
  "improvements": [{ "title": "…", "priority": "must|should|could" }],
  "ideas": [{ "title": "…", "note": "why it might matter" }]
}
Empty arrays are the correct answer when there is nothing real to report.

DIFF:
${diff}`;

async function askGemini() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
        signal: ctrl.signal,
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      die(`Gemini API error ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    try {
      return JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/); // fence/preamble fallback
      if (m) return JSON.parse(m[0]);
      die('Gemini returned something that was not JSON — nothing posted.');
    }
  } finally {
    clearTimeout(timer);
  }
}

const cap = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : []);

const review = await askGemini();
const bugs = cap(review.bugs, 10).filter((b) => b?.title);
const improvements = cap(review.improvements, 10).filter((s) => s?.title);
const ideas = cap(review.ideas, 5).filter((f) => f?.title);
const summaryLine = String(review.summary || '').trim();

const project = projectFromGit(cwd);
const body = {
  project,
  session: {
    session_id: `gemini-review-${commit}`,
    commit_hash: commit,
    branch,
    authored: false, // metadata-class: never clobbers an authored checkpoint
    summary: `Gemini second-model review of ${commit}: ${summaryLine || 'no summary'} ` +
      `(${bugs.length} bug${bugs.length === 1 ? '' : 's'}, ${improvements.length} improvement${improvements.length === 1 ? '' : 's'}, ${ideas.length} idea${ideas.length === 1 ? '' : 's'})`,
    tags: ['review', 'gemini'],
  },
  extract: {
    bugs: bugs.map((b) => ({ title: b.title, severity: b.severity })),
    next_steps: improvements.map((s) => ({ title: s.title, priority: s.priority || 'could' })),
    futures: ideas.map((f) => ({ title: f.title, note: f.note || '' })),
  },
};

if (DRY) {
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  logStderr(`dry run — nothing posted (model: ${MODEL})`);
  process.exit(0);
}

const result = await postIngest(body);
if (!result?.ok) die(`Posting the review to Stack failed${result?.reason ? ` (${result.reason})` : ''}.`);
logStderr(
  `gemini review posted for ${project.slug} @ ${commit} — sent ` +
  `${bugs.length} bug${bugs.length === 1 ? '' : 's'}, ${improvements.length} improvement${improvements.length === 1 ? '' : 's'}, ` +
  `${ideas.length} idea${ideas.length === 1 ? '' : 's'} (model: ${MODEL}; dedup may drop repeats)`
);
