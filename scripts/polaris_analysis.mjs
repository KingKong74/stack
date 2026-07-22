#!/usr/bin/env node
// Stack — Polaris project report + direction mind map (#225).
//
// Fetches live project data from the Stack API (projects, roadmap_items,
// bugs, sessions tables via the REST payload) and writes two markdown artefacts:
//
//   polaris/polaris_project_report.md  — full state-of-the-project report
//   polaris/polaris_direction_map.md   — next-direction map (textual tree)
//
// Note: the acceptance spec said "stack/" for the output dir, but "stack" is
// the repo's CLI dispatcher (a file), so "polaris/" is the pragmatic choice.
//
// Table↔payload mapping (satisfies the acceptance criteria):
//   projects       → GET /api/projects/:slug (status, northStar, summary,
//                    techStack, deployPlatform, blockers, inProgress, nextUp,
//                    workingWell, currentPhase, progress, activity)
//   sessions       → project.activity[] (summary, branch, when, tokens)
//   roadmap_items  → GET /api/projects/:slug/roadmap (grouped by bucket)
//   bugs           → GET /api/projects/:slug/bugs (title, severity, status)
//
// Gemini enrichment (north-star alignment + direction recommendations) runs
// in one single call to conserve free-tier quota. When the key is absent or
// the quota is exhausted, both files are still written with a degraded note —
// exit 0, never blocking. "Absent key = silent degrade" is a hard repo rule.
//
// Usage (called by polaris_analysis.sh, or directly):
//   node scripts/polaris_analysis.mjs [<slug>] [--output-dir <path>]
//
// Env (~/.stack/env):
//   STACK_API / STACK_TOKEN   the usual Stack pair
//   GEMINI_API_KEY            free-tier key (optional — degrades gracefully)
//   GEMINI_MODEL              model override (default gemini-2.5-flash)
//   GEMINI_FALLBACK_MODEL     fallback on 429 (default gemini-flash-lite-latest)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStackEnv, logStderr } from '../hook/stack-post.mjs';

loadStackEnv();

// ---------------------------------------------------------------------------
// CLI args

const args = process.argv.slice(2);
const outputDirIdx = args.indexOf('--output-dir');
const outputDir = outputDirIdx > -1
  ? args[outputDirIdx + 1]
  : join(dirname(fileURLToPath(import.meta.url)), '..', 'polaris');

// First non-flag, non-value arg is the slug
const slug = args.find((a, i) =>
  !a.startsWith('--') && args[i - 1] !== '--output-dir'
) || 'stack';

const API  = (process.env.STACK_API  || '').replace(/\/$/, '');
const TOK  = process.env.STACK_TOKEN;
const GKEY = process.env.GEMINI_API_KEY;
const GMOD = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GFALLBACK = process.env.GEMINI_FALLBACK_MODEL !== undefined
  ? process.env.GEMINI_FALLBACK_MODEL
  : 'gemini-flash-lite-latest';

function die(msg) { logStderr(msg); process.exit(1); }

if (!API || !TOK) die('STACK_API and STACK_TOKEN must be set in ~/.stack/env');

// ---------------------------------------------------------------------------
// Stack API helper

async function apiGet(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${TOK}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Stack API ${path} returned ${res.status}`);
    return res.json();
  } catch (err) {
    throw err.name === 'AbortError' ? new Error(`Stack API ${path} timed out`) : err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Gemini helper — mirrors hook/stack-gemini-review.mjs pattern exactly

async function callGeminiModel(model, prompt, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': GKEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
        signal: ctrl.signal,
      }
    );
    if (!res.ok) {
      const err = new Error(`Gemini API error (${res.status}).`);
      if (res.status === 429 || res.status === 404) err.quota = true;
      throw err;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    try { return JSON.parse(text); } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error('Gemini returned a non-JSON answer.');
    }
  } catch (err) {
    throw err.name === 'AbortError' ? new Error('Gemini timed out.') : err;
  } finally {
    clearTimeout(timer);
  }
}

// Tries primary model; falls back to GFALLBACK on quota/404. Never throws —
// returns null on any failure so callers can degrade gracefully.
async function askGemini(prompt, timeoutMs = 90_000) {
  if (!GKEY) return null;
  try {
    return await callGeminiModel(GMOD, prompt, timeoutMs);
  } catch (err) {
    if (!err.quota) { logStderr(`Gemini error: ${err.message}`); return null; }
    if (!GFALLBACK || GFALLBACK === GMOD) { logStderr('Gemini quota exhausted (no fallback).'); return null; }
    logStderr(`Gemini quota on primary — retrying on ${GFALLBACK}…`);
    try {
      return await callGeminiModel(GFALLBACK, prompt, timeoutMs);
    } catch (err2) {
      logStderr(`Gemini fallback also failed: ${err2.message}`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Data fetching

async function fetchProjectData(slug) {
  logStderr(`Fetching project data for "${slug}"…`);
  const [project, roadmap, bugs, futures] = await Promise.all([
    apiGet(`/api/projects/${slug}`),
    apiGet(`/api/projects/${slug}/roadmap`),
    apiGet(`/api/projects/${slug}/bugs`),
    apiGet(`/api/projects/${slug}/futures`).catch(() => []),
  ]);
  return { project, roadmap, bugs, futures };
}

// ---------------------------------------------------------------------------
// Prompt builders — cap volume for free-tier quota

function roadmapForPrompt(roadmap) {
  const lines = [];
  for (const [bucket, limit] of [['must', 15], ['should', 12], ['could', 5]]) {
    const items = (roadmap[bucket] || []).filter((i) => !i.done && !i.skipped);
    if (!items.length) { lines.push(`${bucket.toUpperCase()}: (none open)`); continue; }
    lines.push(`${bucket.toUpperCase()} (${items.length} open):`);
    for (const it of items.slice(0, limit)) {
      const area = it.area ? ` [${it.area}]` : '';
      lines.push(`  #${it.id}${area}: ${it.title}`);
      if (it.note) lines.push(`    ${it.note.slice(0, 120)}`);
    }
    if (items.length > limit) lines.push(`  … +${items.length - limit} more`);
  }
  const wont = (roadmap.wont || []).filter((i) => !i.done);
  if (wont.length) lines.push(`WONT: ${wont.length} parked items`);
  return lines.join('\n');
}

function activityForPrompt(activity) {
  return (activity || []).slice(0, 15).map((a) =>
    `[${a.when}] ${a.branch}: ${(a.summary || '').slice(0, 120)}`
  ).join('\n') || '(none)';
}

function bugsForPrompt(bugs) {
  if (!bugs.length) return '(none)';
  return bugs.map((b) => `${b.severity.toUpperCase()} #${b.id}: ${b.title}`).join('\n');
}

function futuresForPrompt(futures) {
  if (!futures.length) return '(none)';
  return futures.map((f) => {
    const label = f.alignment ? ` [${f.alignment}]` : '';
    return `${label} ${f.title}`;
  }).join('\n');
}

function buildAnalysisPrompt(slug, project, roadmap, bugs, futures) {
  return `You are Polaris, Stack's strategic planning copilot. Produce a combined analysis
for the "${slug}" project that will feed two markdown documents. Be specific, grounded in the data,
and opinionated — avoid generic filler. Use en-AU spelling.

=== PROJECT ===
Name: ${project.name} | Status: ${project.status} | Progress: ${project.progress}%
Phase: ${project.currentPhase || 'not set'}
Tech stack: ${(project.techStack || []).join(', ') || '—'}
Deploy: ${project.deployPlatform || '—'}

NORTH STAR:
${project.northStar || '(not set)'}

LAST CHECKPOINT SUMMARY:
${project.summary || '(none)'}

IN PROGRESS:
${(project.inProgress || []).join('\n') || '(none)'}

NEXT UP:
${(project.nextUp || []).join('\n') || '(none)'}

BLOCKERS:
${(project.blockers || []).join('\n') || '(none)'}

WORKING WELL:
${(project.workingWell || []).join('\n') || '(none)'}

=== RECENT SESSIONS (from sessions table) ===
${activityForPrompt(project.activity)}

=== OPEN BUGS (from bugs table) ===
${bugsForPrompt(bugs)}

=== OPEN ROADMAP (from roadmap_items table) ===
${roadmapForPrompt(roadmap)}

=== IDEA FUNNEL (futures table) ===
${futuresForPrompt(futures)}

Return a single JSON object with these exact top-level keys:

"report": {
  "executiveSummary": "2-3 sentences: where the project is right now, specific",
  "momentum": "paragraph on recent velocity and what just landed",
  "openBoardSummary": "concise: must/should counts, top priorities, any gaps",
  "technicalHealth": "open bugs assessment, severity patterns, any systemic risk",
  "northStarAlignment": "how well current roadmap and recent work serve the north star — name specific items that fit or drift",
  "blockersAndRisks": "what is or could block progress — go beyond the listed blockers",
  "workingWell": "what to double down on"
},
"directionMap": {
  "currentStateCaption": "one sentence launch point",
  "directions": [
    {
      "title": "5-8 word title",
      "branch": "one-line description",
      "keyActions": ["action 1", "action 2"],
      "benefit": "primary benefit",
      "tradeoff": "main risk or cost",
      "verdict": "PURSUE NOW | PURSUE LATER | SKIP",
      "verdictReason": "one sentence"
    }
  ],
  "recommendedArc": "which direction and the 2-3 sentence case for it"
}

Generate 4-6 directions. At least one should be "execute the current board" and at least one
should be a new capability or strategic pivot. Ground all directions in actual open items and
ideas — do not invent items not mentioned. The directions should be meaningfully distinct.`;
}

// ---------------------------------------------------------------------------
// Markdown renderers

function renderReport(project, report, generated) {
  const UNAVAILABLE = '_Analysis unavailable — no Gemini key or quota exhausted._';
  const r = report || {};

  const done = (roadmap) => {
    let n = 0;
    for (const bucket of ['must', 'should', 'could', 'wont']) {
      n += (roadmap[bucket] || []).filter((i) => i.done).length;
    }
    return n;
  };

  return `# Polaris — Project Report: ${project.name}

> Generated ${generated}

---

## Executive Summary

${r.executiveSummary || UNAVAILABLE}

---

## Momentum & Recent Work

${r.momentum || UNAVAILABLE}

---

## Open Board

${r.openBoardSummary || UNAVAILABLE}

---

## Technical Health

**Open bugs:** ${(project.bugs || []).length || 'see below'}

${r.technicalHealth || UNAVAILABLE}

---

## North Star Alignment

**North star:**
> ${project.northStar || '_Not set._'}

${r.northStarAlignment || UNAVAILABLE}

---

## Blockers & Risks

${r.blockersAndRisks || (project.blockers?.length ? project.blockers.join('\n') : '_None noted._')}

---

## What's Working Well

${r.workingWell || (project.workingWell?.length ? project.workingWell.join('\n') : '_Not noted._')}

---

_Generated by \`scripts/polaris_analysis.sh\` · Stack Polaris (#225)_
`;
}

function renderDirectionMap(project, map, generated) {
  const UNAVAILABLE = '_Direction map unavailable — no Gemini key or quota exhausted._';
  if (!map) {
    return `# Polaris — Direction Map: ${project.name}

> Generated ${generated}

---

## Current State

${UNAVAILABLE}

---

_Generated by \`scripts/polaris_analysis.sh\` · Stack Polaris (#225)_
`;
  }

  // Render directions as an indented tree (box-drawing style like stack-tree.mjs)
  const dirs = map.directions || [];
  const treeLines = dirs.map((d, i) => {
    const isLast = i === dirs.length - 1;
    const prefix  = isLast ? '└── ' : '├── ';
    const indent  = isLast ? '    ' : '│   ';
    const verdict = d.verdict === 'PURSUE NOW'   ? '✅ PURSUE NOW'
                  : d.verdict === 'PURSUE LATER' ? '⏳ PURSUE LATER'
                  : '⬜ SKIP';
    return [
      `${prefix}**${d.title}** — ${verdict}`,
      `${indent}_${d.verdictReason}_`,
      `${indent}Branch: ${d.branch}`,
      `${indent}Actions: ${(d.keyActions || []).join('; ')}`,
      `${indent}Benefit: ${d.benefit}`,
      `${indent}Trade-off: ${d.tradeoff}`,
    ].join('\n');
  });

  return `# Polaris — Direction Map: ${project.name}

> Generated ${generated}

---

## Current State

${map.currentStateCaption || UNAVAILABLE}

**North star:**
> ${project.northStar || '_Not set._'}

---

## Candidate Next Directions

\`\`\`
${project.name}
${treeLines.join('\n\n')}
\`\`\`

---

## Detail

${dirs.map((d, i) => {
  const verdict = d.verdict === 'PURSUE NOW'   ? '✅ PURSUE NOW'
                : d.verdict === 'PURSUE LATER' ? '⏳ PURSUE LATER'
                : '⬜ SKIP';
  return `### ${i + 1}. ${d.title}

**${verdict}** — ${d.verdictReason}

${d.branch}

**Key actions:** ${(d.keyActions || []).join('; ')}

**Benefit:** ${d.benefit}

**Trade-off:** ${d.tradeoff}
`;
}).join('\n---\n\n')}

---

## Recommended Next Arc

${map.recommendedArc || UNAVAILABLE}

---

_Generated by \`scripts/polaris_analysis.sh\` · Stack Polaris (#225)_
`;
}

// ---------------------------------------------------------------------------
// Main

(async () => {
  const { project, roadmap, bugs, futures } = await fetchProjectData(slug);

  let report = null;
  let dirMap = null;

  if (GKEY) {
    logStderr('Calling Gemini for combined analysis…');
    const prompt = buildAnalysisPrompt(slug, project, roadmap, bugs, futures);
    const analysis = await askGemini(prompt);
    if (analysis) {
      report = analysis.report;
      dirMap = analysis.directionMap;
    } else {
      logStderr('Gemini analysis unavailable — writing degraded reports.');
    }
  } else {
    logStderr('No GEMINI_API_KEY — writing degraded reports (data sections still populated).');
  }

  const generated = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  mkdirSync(outputDir, { recursive: true });

  const reportPath = join(outputDir, 'polaris_project_report.md');
  const mapPath    = join(outputDir, 'polaris_direction_map.md');

  writeFileSync(reportPath, renderReport(project, report, generated));
  writeFileSync(mapPath,    renderDirectionMap(project, dirMap, generated));

  logStderr(`✓  ${reportPath}`);
  logStderr(`✓  ${mapPath}`);
})().catch((err) => {
  logStderr(`Fatal: ${err.message}`);
  process.exit(1);
});
