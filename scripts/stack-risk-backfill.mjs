#!/usr/bin/env node
// stack-risk-backfill.mjs — tier the open board's risk in one pass (#262).
//
// The graduated-trust auto-merge lever (#212) only has rungs to climb once
// items carry a real tier, and a board that predates the pre-pass sits every
// item on the untouched 'normal' default. A plan night gets there one item at
// a time — a full design session apiece — which is hours of session time for
// something a single cheap Gemini pass can do directly against the board.
// This is that pass, run once (or occasionally) rather than every night.
//
//   stack risk-backfill [slug] [--run] [--limit N]
//
// DRY BY DEFAULT — prints exactly what it would write and touches nothing
// until --run (same contract as seed-galaxy). No GEMINI_API_KEY = one line
// saying so, exit 0 — absent key is a silent degrade, never an error.
//
// Candidates: open items (not done) a human has not already tiered
// (riskSource !== 'human') — those are the ones the auto-write guard exists
// for, and are reported as skipped rather than silently dropped, because a
// silent skip reads as "there were none". Sent to Gemini in batches of 20 —
// every batch, so nothing is silently capped — using the SAME conservative
// tiering rule the plan-time pre-pass uses (copied verbatim, so the whole
// board is judged on one rule and not two). Answers are matched back by id,
// so a model inventing an id can never write to the wrong item; each tier is
// normalised through cleanRiskTier before it is sent anywhere.
//
// PATCH risk_source: 'auto' is refused server-side for any item a human has
// tiered since the candidate list was built — that race is real (the board
// is live while this runs) — so every write is checked against the response,
// never assumed from the request.
//
// ORDERING CONSTRAINT: this script must never run --run against a server
// that predates the #262 migration. A pre-migration server has no
// risk_source column and its PATCH handler ignores that key, writing risk
// unconditionally — so a run against it would tier the board with NO
// provenance recorded. Once the #262 branch merges and the schema migrates,
// its convergent backfill (`UPDATE roadmap_items SET risk_source = 'human'
// WHERE risk_source IS NULL AND risk <> 'normal'`) would then claim every one
// of those machine tiers as HUMAN-set — permanently, with nothing able to
// unclaim them. So: the backfill runs AFTER the schema migration, never
// before. A capability check below detects the missing column and refuses
// to write until it's there.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cleanRiskTier, cleanRiskReason, riskLabel } from './lib/risk.mjs';

const BATCH_SIZE = 20;

// Copied verbatim from geminiSpec's tiering paragraph (stack-autopilot.mjs)
// so the board is tiered on one rule, not two.
const RISK_RULE = `Judge the RISK of building this unattended, and be conservative — "low" means an
overnight run of it could land on main without a human reading the diff first.
Reserve "low" for small, reversible, well-fenced work: copy and styling, a chip or
label, a doc, one self-contained pure function with tests. Anything touching the
database schema, auth, money, deletion, migrations, the hooks, or a contract other
code reads is "high". Everything else is "normal" — when in doubt, say normal.`;

// A capped/batched list inside a prompt must say so — a model reasons from
// absence, so silence here reads as "this is the whole board".
function batchPrompt(batch, batchIndex, totalBatches) {
  const lines = batch.map((it) => {
    const note = it.note ? ` — ${it.note.slice(0, 200)}` : '';
    return `#${it.id} [${it.bucket}] ${it.title}${note}`;
  }).join('\n');
  return `You are tiering the RISK of items on a solo side project's roadmap ahead of time, for an overnight autopilot's auto-merge lever.

${RISK_RULE}

This is batch ${batchIndex + 1} of ${totalBatches} of a larger board — judge ONLY the items listed below, and say nothing about items outside this batch.

${lines}

Respond with ONLY this JSON — one entry per item above, in any order:
[{ "id": <the item id>, "risk": "low | normal | high", "reason": "one line — why that tier" }]`;
}

export async function main(argv = process.argv.slice(2)) {
  const flag = (n) => argv.includes(`--${n}`);
  const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const slug = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--limit') || 'stack';
  const limitArg = parseInt(arg('limit') ?? '', 10);
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : Infinity;
  const DRY = !flag('run');

  // Token + API base + Gemini key from ~/.stack/env — never printed, like
  // every other tool here (same read as seed-galaxy).
  let API; let TOKEN; let GEMINI_KEY; let GEMINI_MODEL; let GEMINI_FALLBACK;
  try {
    const env = readFileSync(join(homedir(), '.stack', 'env'), 'utf8');
    const get = (k) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
    API = (get('STACK_API') || '').replace(/\/$/, '');
    TOKEN = get('STACK_TOKEN');
    GEMINI_KEY = get('GEMINI_API_KEY') || '';
    GEMINI_MODEL = get('GEMINI_MODEL') || 'gemini-2.5-flash';
    GEMINI_FALLBACK = get('GEMINI_FALLBACK_MODEL') ?? 'gemini-flash-lite-latest';
  } catch {
    process.stderr.write('Could not read ~/.stack/env — is this the Stack host?\n');
    return 1;
  }
  if (!API || !TOKEN) {
    process.stderr.write('STACK_API or STACK_TOKEN missing from ~/.stack/env.\n');
    return 1;
  }
  // Absent key = silent degrade, never an error.
  if (!GEMINI_KEY) {
    process.stdout.write('No GEMINI_API_KEY in ~/.stack/env — risk backfill skipped.\n');
    return 0;
  }

  const api = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return null; }
  };

  // Free-tier quotas are per model — a 429 on the primary retries once on the
  // fallback, same convention as geminiSpec / the server's gemini.js.
  async function askGemini(prompt) {
    const models = [GEMINI_MODEL];
    if (GEMINI_FALLBACK && GEMINI_FALLBACK !== GEMINI_MODEL) models.push(GEMINI_FALLBACK);
    let lastErr = null;
    for (const [i, model] of models.entries()) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45_000);
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
            }),
            signal: ctrl.signal,
          }
        );
        if ((res.status === 429 || res.status === 404) && i < models.length - 1) {
          lastErr = new Error(`${model} ${res.status === 429 ? 'quota exhausted' : 'unavailable (404)'}`);
          continue;
        }
        if (!res.ok) throw new Error(`Gemini ${res.status}`);
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
        const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || text);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        lastErr = e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error('Gemini call failed');
  }

  const roadmap = await api('GET', `/api/projects/${encodeURIComponent(slug)}/roadmap`);
  const all = [...roadmap.must, ...roadmap.should, ...roadmap.could, ...roadmap.wont];

  // Capability check — does THIS server carry the #262 column at all? '' is
  // a legitimate riskSource value ("the default nobody chose"), so this has
  // to test for the property's presence, not its truthiness.
  const hasRiskSource = all.some((it) => Object.prototype.hasOwnProperty.call(it, 'riskSource'));
  const provenanceWarning = 'This server predates #262: it has no risk_source column, so it would record\n'
    + 'these tiers with no provenance, and the migration would then claim them all as\n'
    + 'human-set. Merge the #262 branch, let the schema migrate on boot, then re-run.';
  // Fail SAFE — do nothing — because this action writes (CLAUDE.md). A DRY
  // pass still runs in full below and prints the warning at the end; --run
  // stops here, before a single PATCH.
  if (!hasRiskSource && !DRY) {
    process.stderr.write(`${provenanceWarning}\n`);
    return 1;
  }
  const printProvenanceWarning = () => { if (!hasRiskSource) process.stdout.write(`\n${provenanceWarning}\n`); };

  const open = all.filter((it) => !it.done);
  const humanTiered = open.filter((it) => it.riskSource === 'human');
  let candidates = open.filter((it) => it.riskSource !== 'human');
  if (candidates.length > limit) candidates = candidates.slice(0, limit);

  process.stdout.write(`${all.length} item(s) on the board, ${open.length} open. `
    + `${humanTiered.length} already tiered by a human — skipped, never overwritten. `
    + `${candidates.length} candidate(s) for an auto tier${candidates.length < open.length - humanTiered.length ? ' (--limit applied)' : ''}.\n`);

  if (!candidates.length) {
    process.stdout.write('Nothing to tier.\n');
    printProvenanceWarning();
    return 0;
  }

  const batches = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) batches.push(candidates.slice(i, i + BATCH_SIZE));

  const proposals = new Map(); // id -> { risk, reason }
  for (const [i, batch] of batches.entries()) {
    process.stdout.write(`\nBatch ${i + 1}/${batches.length} (${batch.length} item(s))…\n`);
    let answers;
    try {
      answers = await askGemini(batchPrompt(batch, i, batches.length));
    } catch (e) {
      process.stdout.write(`  Gemini call failed (${e.message}) — this batch produced no proposals.\n`);
      continue;
    }
    const batchIds = new Set(batch.map((it) => it.id));
    for (const a of answers) {
      const id = Number(a?.id);
      if (!batchIds.has(id)) continue; // an invented id must not write to a random item
      proposals.set(id, { risk: cleanRiskTier(a.risk), reason: cleanRiskReason(a.reason) });
    }
  }

  let written = 0; let keptHuman = 0; let failed = 0;
  const tierCounts = { low: 0, normal: 0, high: 0 };
  for (const it of candidates) {
    const p = proposals.get(it.id);
    if (!p) { process.stdout.write(`#${it.id} ${it.title.slice(0, 60)} — no proposal came back.\n`); continue; }
    tierCounts[p.risk]++;
    process.stdout.write(`${DRY ? '[dry] ' : ''}#${it.id} [${it.bucket}] ${it.title.slice(0, 60)} → ${riskLabel(p.risk, p.reason)}\n`);
    if (DRY) continue;
    try {
      // Trust the response over what we sent — the server refuses an 'auto'
      // write over a human tier and hands its own tier back instead.
      const updated = await api('PATCH', `/api/projects/${encodeURIComponent(slug)}/roadmap/${it.id}`,
        { risk: p.risk, risk_reason: p.reason, risk_source: 'auto' });
      if (updated?.riskSource === 'human') {
        keptHuman++;
        process.stdout.write(`  kept the human's own tier (${updated.risk}) — ours was ignored.\n`);
      } else {
        written++;
      }
    } catch (e) {
      failed++;
      process.stdout.write(`  PATCH failed (${e.message}) — left untouched.\n`);
    }
  }

  process.stdout.write(`\n${DRY ? '[dry] ' : ''}${proposals.size} proposed / ${written} written / ${keptHuman} kept-by-human / ${failed} failed. `
    + `Per tier (proposed): low ${tierCounts.low}, normal ${tierCounts.normal}, high ${tierCounts.high}.\n`);
  printProvenanceWarning();
  // The provenance warning already IS the closing instruction when the
  // column is missing — telling the operator to "re-run with --run" right
  // under a paragraph that just refused --run would contradict itself.
  if (DRY && hasRiskSource) process.stdout.write('\nNothing was written. Re-run with --run to apply.\n');
  return 0;
}

// Direct run (node scripts/stack-risk-backfill.mjs) as well as `stack risk-backfill`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c ?? 0)).catch((e) => {
    process.stderr.write(`risk-backfill failed: ${e.message}\n`);
    process.exit(1);
  });
}
