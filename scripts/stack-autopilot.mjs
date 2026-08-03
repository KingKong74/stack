#!/usr/bin/env node
// Stack — the overnight autopilot (phase 2).
//
// Multiple eligible roadmap items per night, each on its own reviewable
// branch, inside a shared night budget: a wall-clock cap (Settings'
// autopilotMinutes), a token budget metered from each session's real
// usage (`claude -p --output-format json`), AND a plan-step budget — the
// governor paces by STEPS REMAINING on each item's plan, not item count, so
// a night spends roughly the same effort whether it lands one big item or
// five small ones. Before each session a Gemini
// spec pre-pass (free tier) expands the item's title/note into a small spec —
// goal, acceptance criteria, out-of-scope — so the unattended session builds
// to a target instead of a title. No key = the pre-pass silently skips.
//
// The human keeps final say: the autopilot NEVER touches main, never ticks an
// item done, never merges — each item leaves a pushed `<kind>/<id>-<slug>` branch, a
// Gemini second-model review in the review inbox, a checks run, a checkpoint
// on the activity feed, and a `built_note` stamped on the item (so the
// Reviews view shows what landed when the human ticks it).
//
// Per item: pick → claim the lane → spec pre-pass → worktree branch →
// `claude -p` (bounded) → push → built_note → checks → Gemini diff review →
// keep or release the claim. Then the next item, while budget remains.
//
// The claim doubles as the "don't re-pick" marker: a successful run leaves
// `<kind>/<id>-<slug>` claimed until the human merges and ticks the item done; a
// run that produced no commits releases it so the next night retries.
//
// The ARM SWITCH lives in the app: Settings → Autopilot, and each project
// must also be on automode (the ⚙ badge). Unreachable settings = no run —
// the autopilot spends tokens and acts, so unlike the hooks it fails SAFE.
//
// Usage:
//   node scripts/stack-autopilot.mjs --project stack --repo /home/bailey/stack
//     [--minutes N]     the NIGHT's wall-clock cap (default: Settings' autopilotMinutes)
//     [--tokens N]      the night's token budget; 0 = unlimited
//                       (default: env STACK_AUTOPILOT_TOKENS, else Settings' autopilotTokens)
//     [--max-items N]   most items attempted per night (default: Settings' autopilotMaxItems)
//     [--max-steps N]   the night's budget in PLAN STEPS REMAINING (0 = unlimited; default:
//                       max-items × the nominal size of an item that carries no plan yet, so a
//                       board with no plans paces exactly as item-count pacing did before)
//     [--item N]        work exactly this roadmap item and stop (scheduled/manual runs)
//     [--plan-only]     a PLAN night (#219): no branches, no builds — each picked item
//                       (must/should with no plan steps yet; --item pins one) gets a
//                       short design session whose output is PATCHed onto the item as
//                       its plan steps + a design section in the note. Cheap to run
//                       (pair with --executor-model haiku), reviewable in minutes —
//                       build nights then execute against agreed designs.
//     [--kind K]        session kind (#228 — the session planner's modes):
//                       build (default) | plan (= --plan-only) | debug | audit | refine.
//                       debug = fix bugs (each on branch fix/bug-N-<slug>, never
//                       marked fixed — status moves to 'fixing', the human closes);
//                       audit = one hardening session that runs the suites, hunts
//                       verified defects, files them as bugs via the API and
//                       commits test hardening on test/audit-<date>;
//                       refine = a follow-up round on an item that was sent back
//                       with a refine note (#274); it builds the delta on the
//                       item's existing branch.
//     [--items a,b,c]   an ORDERED agenda of roadmap item ids — the session works
//                       exactly these in order (done/claimed skipped), instead of
//                       the board's own priority order
//     [--bugs K1,K2]    a debug session's agenda of bug keys (BUG-3,…); without it
//                       open bugs are taken serious-first
//     [--area A]        scope the general pick to one product area (overrides the
//                       project's autopilot_area; pins and agendas bypass it)
//     [--executor-model M]  claude model alias the session runs as (default: Settings'
//                           autopilotExecutorModel; '' = the claude CLI's own default)
//     [--advisor-model M]   the model the session RUNS AS — the director (#285).
//                           (default: Settings' autopilotAdvisorModel; '' = no
//                           director, so the session runs single-model on the
//                           executor exactly as it did before #153)
//     [--dry]           print what tonight would pick and exit (no claim, no session)
//     [--force]         run even while the Settings switch / automode is off
//
// Dual-model sessions (#153, inverted by #285): the strong ADVISOR model runs the session as the DIRECTOR
// (claude --model) and delegates the building to a cheap EXECUTOR subagent with
// write access (claude --agents). Context accumulates in the main loop and
// subagent contexts are isolated, so this puts judgement on the strong model and
// the bulk — file reads, retries, test output — on the cheap one. It only pays
// off if the director delegates instead of building; the prompt says so plainly.
//
// Env (~/.stack/env): STACK_API + STACK_TOKEN (required), GEMINI_API_KEY
// (optional — skips the spec pre-pass + second-model review when absent).
// Never printed.
//
// Normally invoked by scripts/stack-autopilot-dispatch.mjs (the every-minute
// cron line), which polls the app's job queue — the nightly time, manual
// Run-now presses and the Mission Control calendar all arrive that way.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadStackEnv, logStderr, git } from '../hook/stack-post.mjs';
import { laneFor, bugLaneFor, auditLaneFor } from './lib/lane.mjs';
import { refineTargetBranch, autoMergeAllowed, isRefineRound } from './lib/refine.mjs';

loadStackEnv();

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
// #228 — session kinds: build (default) | plan | debug | audit | refine.
// An unrecognised --kind falls back to 'build'. `refine` (#274) rides the
// SAME build loop below (runItem) rather than getting its own debug/audit-
// style night — the only thing that changes is which items are eligible
// (only ones carrying a refine note) and which branch runItem builds on
// (the item's own branch, continued, when one still exists on origin —
// see scripts/lib/refine.mjs).
const KIND_RAW = String(arg('kind') || '').toLowerCase();
const PLAN_ONLY = process.argv.includes('--plan-only') || KIND_RAW === 'plan';
const KIND = KIND_RAW === 'debug' ? 'debug'
  : KIND_RAW === 'audit' ? 'audit'
  : KIND_RAW === 'refine' ? 'refine'
  : PLAN_ONLY ? 'plan' : 'build';
const SLUG = arg('project');
const REPO = arg('repo');
const MINUTES_ARG = arg('minutes');
// null = no override; 0 is a real value (unlimited), so no || chains here.
const intArg = (v) => { const n = parseInt(v ?? '', 10); return Number.isFinite(n) ? n : null; };
const TOKENS_OVERRIDE = intArg(arg('tokens')) ?? intArg(process.env.STACK_AUTOPILOT_TOKENS);
const MAX_ITEMS_ARG = intArg(arg('max-items'));
const STEP_BUDGET_ARG = intArg(arg('max-steps'));
const ITEM_ID = intArg(arg('item'));
// #228 — ordered agendas from the session planner.
const AGENDA = String(arg('items') || '').split(',')
  .map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0).slice(0, 20);
const BUG_AGENDA = String(arg('bugs') || '').split(',')
  .map((s) => s.trim().toUpperCase()).filter((s) => /^BUG-\d+$/.test(s)).slice(0, 20);
const AREA_ARG = arg('area'); // null = no override; '' = whole board
const MIN_SESSION_MIN = 15; // not worth starting a session with less than this

const API = process.env.STACK_API;
const TOKEN = process.env.STACK_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// Free-tier quotas are per model, so a 429 on the primary is retried once on
// the fallback (same convention as the server's gemini.js). '' disables.
const GEMINI_FALLBACK = process.env.GEMINI_FALLBACK_MODEL !== undefined
  ? process.env.GEMINI_FALLBACK_MODEL
  : 'gemini-flash-lite-latest'; // the alias — Google retires pinned lite models for new users (404)

function die(msg) { logStderr(`autopilot: ${msg}`); process.exit(1); }

if (!SLUG || !REPO) die('usage: stack-autopilot.mjs --project <slug> --repo <path> [--minutes N] [--tokens N] [--max-items N] [--dry]');
if (!API || !TOKEN) die('STACK_API and STACK_TOKEN must be set in ~/.stack/env.');
if (!existsSync(REPO)) die(`repo path not found: ${REPO}`);

const stamp = () => new Date().toISOString();
const log = (msg) => logStderr(`autopilot ${stamp()} · ${msg}`);

async function api(method, path, body) {
  const res = await fetch(`${API.replace(/\/$/, '')}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
}

// The run ledger: one row per item attempt lands in the app (the dashboard's
// morning digest + Mission Control read it). Best effort — a failed POST only
// costs the record, never the night.
async function postRun(payload) {
  try { return await api('POST', `/api/projects/${SLUG}/autopilot/runs`, payload); }
  catch (e) { log(`run record skipped (${e.message})`); return null; }
}

// #282 — attach the reviewer's read to a run already recorded. The run row goes
// in before the Gemini review so a crash mid-review costs only the review; this
// is the narrow second write that stops the verdict evaporating the moment the
// auto-merge gate has read it. Best effort, like the record itself.
async function attachReview(runId, verdict, architect) {
  if (!runId || (!verdict && !architect)) return;
  try {
    await api('PATCH', `/api/projects/${SLUG}/autopilot/runs/${runId}`, {
      ...(verdict ? {
        review_verdict: verdict.verdict || (verdict.bugs === 0 ? 'clean' : 'concerns'),
        review_note: verdict.summary || '',
        review_findings: verdict.bugs ?? null,
      } : {}),
      // #284 — the architect's structural read rides the same write.
      ...(architect ? {
        architect_verdict: architect.verdict || '',
        architect_note: architect.note || '',
        architect_obs: architect.observations || [],
      } : {}),
    });
  } catch (e) { log(`agent verdicts not stored (${e.message})`); }
}

// #284 — the ARCHITECT pass: the same diff, a different question. Where the
// reviewer asks whether the change is correct, this asks where the codebase is
// going — duplication, boundaries, drift from what is already there. It files
// nothing and gates nothing; it is a second opinion for the morning's review.
// Keyless = skipped silently, like every other Gemini surface here.
function runArchitect(wt, tag, range = 'main..HEAD') {
  if (!GEMINI_KEY) return null;
  const file = join(lockDir, 'autopilot', `${SLUG}-${tag}-architect.json`);
  try { rmSync(file); } catch { /* none from a previous attempt */ }
  const pass = spawnSync('node', [join(REPO, 'hook', 'stack-gemini-review.mjs'),
    '--architect', '--range', range, '--verdict-file', file], {
    cwd: wt, stdio: ['ignore', 'inherit', 'inherit'], timeout: 120_000,
  });
  if (pass.status !== 0) { log('architect pass did not complete (see above).'); return null; }
  try {
    const read = JSON.parse(readFileSync(file, 'utf8'));
    rmSync(file);
    log(`architect: ${read.verdict || 'no verdict'}${read.note ? ` — ${read.note}` : ''}`);
    return read;
  } catch { return null; }
}

// Night-end notification (#79) via ntfy.sh — free, keyless, no account: set
// STACK_NTFY_TOPIC in ~/.stack/env and subscribe to that topic on your phone.
// Unset = silent skip.
async function notify(title, body) {
  const topic = process.env.STACK_NTFY_TOPIC;
  if (!topic) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: title, Click: API },
      body,
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    log('notification sent.');
  } catch (e) { log(`notification skipped (${e.message})`); }
}

// Token-limit grace (#102/#98): when a session dies on the usage limit, the
// night stops burning items and schedules its own resume — at the reset time
// when the message names one ("resets 2:10am"), else a few hours out. The
// resume is a plain re-run: released items get re-picked, the arm switch and
// automode still gate it, and the per-project lockfile keeps this project's
// own overlap impossible (a different project's resume runs alongside it).
const LIMIT_RE = /(hit|reached).{0,40}(session|usage|token|rate).{0,20}limit|limit.{0,30}resets/i;
function minutesUntilReset(text) {
  const m = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text || '');
  if (!m) return 240; // no named time — try again in 4h
  const now = new Date();
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toLowerCase() === 'pm') h += 12;
  const target = new Date(now);
  target.setHours(h, parseInt(m[2] || '0', 10), 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return Math.max(30, Math.round((target - now) / 60_000) + 10); // land just past the reset
}
// #142 — the resume is a DURABLE job in the app's queue, not a detached sleep:
// it survives host reboots, shows in Mission Control / the Terminal with its
// resume time, and a human can ▶ Resume now, hang it up or dismiss it. A
// pinned run carries its pin. Only when the API can't take the job does the
// old in-memory sleep step back in, so a flaky API still gets its resume.
async function scheduleResume(minutes) {
  try {
    // #255 — the resume must come back as the SAME kind of session. A plan
    // session that resumed as a build night would start writing code nobody
    // asked for, so the kind rides the job and the dispatcher re-derives
    // --plan-only from it.
    const job = await api('POST', '/api/autopilot/resume', {
      slug: SLUG, minutes, kind: KIND,
      ...(ITEM_ID != null ? { itemId: ITEM_ID } : {}),
    });
    log(`resume queued as job #${job.id} in ~${Math.round(minutes / 60 * 10) / 10}h — `
      + 'resume it early or hang it up from Mission Control (the arm switch still gates an automatic resume).');
    return;
  } catch (e) {
    log(`resume job not queued (${e.message}) — falling back to a detached sleep.`);
  }
  const kindFlag = KIND === 'plan' ? ' --plan-only' : (KIND !== 'build' ? ` --kind ${KIND}` : '');
  const cmd = `sleep ${minutes * 60} && ${process.execPath} ${process.argv[1]} --project ${SLUG} --repo ${REPO}${kindFlag}`;
  spawn('bash', ['-c', cmd], { detached: true, stdio: 'ignore' }).unref();
  log(`resume scheduled in ~${Math.round(minutes / 60 * 10) / 10}h (detached; the arm switch still gates it).`);
}

// One bounded Gemini JSON call — the spec pre-pass. Absent key / any failure
// returns null and the night simply runs spec-less (phase 1 behaviour).
async function geminiSpec(item, northStar) {
  if (!GEMINI_KEY) return null;
  // Ground the spec in the real project structure (#158): a compact listing of
  // top-level directories and the actual DB table names from schema.sql stop
  // Gemini from inventing files and tables for vague items. Keep it brief —
  // the context block is a few hundred chars, not a full code dump.
  let projectCtx = '';
  try {
    const { readdirSync, readFileSync } = await import('node:fs');
    const skip = new Set(['.git', '.claude', 'node_modules', 'dist', '.env']);
    const entries = readdirSync(REPO)
      .filter((e) => !skip.has(e) && !e.startsWith('.') && !e.endsWith('.lock'))
      .slice(0, 30)
      .join(', ');
    let tables = '';
    try {
      const sql = readFileSync(join(REPO, 'server', 'src', 'schema.sql'), 'utf8');
      const names = [...sql.matchAll(/^CREATE TABLE IF NOT EXISTS (\w+)/gm)].map((m) => m[1]);
      if (names.length) tables = `\nDB tables: ${names.join(', ')}`;
    } catch { /* no schema.sql — project may be a frontend-only repo */ }
    projectCtx = `\nProject layout (top-level): ${entries}${tables}\n`;
  } catch { /* can't read the repo — skip */ }

  const prompt = `You are the planning pre-pass for an UNATTENDED overnight coding session on a solo
side project. Turn this roadmap item into a tight build spec the session can verify itself
against. Be concrete and conservative — unattended means no one to ask.
${northStar ? `\nThe project's north star: "${northStar.slice(0, 500)}"\n` : ''}${projectCtx}
IMPORTANT: acceptance criteria must only reference files, directories, tables or APIs that are
visible in the project context above, or that are named explicitly in the author's note below.
Do not invent table names, file paths or package names that aren't present in either.
If the item is too vague to be concrete, write generic criteria (e.g. "the build passes",
"no TypeScript errors") rather than guessing at specifics.

Roadmap item #${item.id} (${item.bucket}): ${item.title}
${item.note ? `The author's note (what they actually want): ${item.note.slice(0, 1200)}` : '(no note)'}
${item.plan?.length ? `The author's own implementation plan (the spec must serve it, not replace it):\n${item.plan.map((s) => `  ${s.done ? '[x]' : '[ ]'} ${s.text}`).join('\n')}` : ''}

Respond with ONLY this JSON:
{ "goal": "one sentence — the outcome",
  "acceptance": ["3-6 verifiable criteria, each checkable from the terminal"],
  "outOfScope": ["what NOT to touch tonight"],
  "risks": ["traps to avoid — max 3"] }`;
  const models = [GEMINI_MODEL];
  if (GEMINI_FALLBACK && GEMINI_FALLBACK !== GEMINI_MODEL) models.push(GEMINI_FALLBACK);
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
      // 429 = quota exhausted, 404 = model retired — either way the next model may still answer.
      if ((res.status === 429 || res.status === 404) && i < models.length - 1) {
        log(`spec pre-pass: ${model} ${res.status === 429 ? 'quota exhausted' : 'unavailable (404)'}, trying ${models[i + 1]}`);
        continue;
      }
      if (!res.ok) throw new Error(`Gemini ${res.status}`);
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      const spec = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
      if (!spec?.goal || !Array.isArray(spec.acceptance)) return null;
      return spec;
    } catch (e) {
      log(`spec pre-pass skipped (${e.message})`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

const specBlock = (spec) => !spec ? '' : `
The build spec (from the planning pre-pass — verify yourself against it before finishing):
- Goal: ${spec.goal}
- Acceptance criteria:
${spec.acceptance.map((a) => `  • ${a}`).join('\n')}
${spec.outOfScope?.length ? `- Out of scope tonight:\n${spec.outOfScope.map((o) => `  • ${o}`).join('\n')}` : ''}
${spec.risks?.length ? `- Watch out for:\n${spec.risks.map((r) => `  • ${r}`).join('\n')}` : ''}
`;

// ---- 0a. The in-app arm switch (Settings → Autopilot) ----
let appSettings;
try { appSettings = await api('GET', '/api/settings'); }
catch (e) { die(`could not read settings (${e.message}) — not running blind.`); }
if (!appSettings.autopilotEnabled && !FORCE) {
  log('autopilot is switched OFF in Settings — nothing run. (--force overrides for a manual test.)');
  process.exit(0);
}
const MINUTES = Math.max(15, parseInt(MINUTES_ARG ?? '', 10) || appSettings.autopilotMinutes || 120);
// Budgets come from Mission Control unless the CLI/env overrides; a token
// budget of 0 means UNLIMITED — the wall clock is then the only governor.
const rawTokens = TOKENS_OVERRIDE ?? (Number.isFinite(appSettings.autopilotTokens) ? appSettings.autopilotTokens : 1_500_000);
const TOKEN_BUDGET = rawTokens === 0 ? Infinity : Math.max(50_000, rawTokens);
// A plan night defaults to a bigger batch — designs are cheap and the point
// is reviewing five in minutes, not building three. An agenda (#228) sets the
// batch to exactly its own length; an audit is always one session.
// The Settings items-per-night is UNLIMITED at 0 (#260), exactly like the token
// budget above: the wall clock and the token budget are then the only governors.
// `?? 3` (not `|| 3`) so a stored 0 survives as a real value.
const settingsMaxItems = Number.isFinite(appSettings.autopilotMaxItems) ? appSettings.autopilotMaxItems : 3;
const capItems = (v) => (v === 0 ? Infinity : Math.max(1, v));
const MAX_ITEMS = KIND === 'audit' ? 1
  : ITEM_ID != null ? 1
  : KIND === 'debug' ? (BUG_AGENDA.length || capItems(MAX_ITEMS_ARG ?? settingsMaxItems))
  : AGENDA.length ? AGENDA.length
  : capItems(MAX_ITEMS_ARG ?? (PLAN_ONLY ? 5 : settingsMaxItems));
// The build/plan night's real governor (#325): plan STEPS REMAINING, not item
// count, because a plan is unevenly sized — one item can be a one-liner and
// another a ten-step rebuild, and item count can't tell them apart. An item
// with no plan yet (or one worked all the way to ticked) is priced at this
// nominal stand-in size so it still costs something.
const NOMINAL_STEPS_PER_ITEM = 4;
const stepsLeft = (item) => (Array.isArray(item?.plan) ? item.plan.filter((s) => !s.done).length : 0);
const stepCost = (item) => stepsLeft(item) || NOMINAL_STEPS_PER_ITEM;
// 0 = UNLIMITED, exactly like TOKEN_BUDGET and capItems above — `??` not `||`
// so a stored/explicit 0 survives as a real value rather than falling through
// to the default. INVARIANT: the default budget is MAX_ITEMS × NOMINAL, and an
// unplanned item costs exactly NOMINAL — so a board with no plan steps yet
// paces EXACTLY as item-count pacing did before this change. Steps only start
// to change the pacing once items actually carry plans.
const rawStepBudget = STEP_BUDGET_ARG ?? (MAX_ITEMS === Infinity ? Infinity : MAX_ITEMS * NOMINAL_STEPS_PER_ITEM);
const STEP_BUDGET = rawStepBudget === 0 ? Infinity : Math.max(1, rawStepBudget);
// Dual-model config (#153/#168): CLI override beats Settings; anything that
// isn't a safe model alias coerces to '' (default / off) so shell
// metacharacters never reach the claude CLI. Allowed charset: alphanumerics
// plus . : / _ - to cover real aliases (e.g. claude-sonnet-4-6,
// us.anthropic.claude-opus-4, vendor/model). The executor is the model the
// session runs as; the advisor is a stronger model it consults ('' = none).
const cleanModel = (v) => {
  const s = String(v ?? '').trim();
  return s === '' || /^[a-z0-9][a-z0-9.:/_-]{0,99}$/i.test(s) ? s : '';
};
const EXECUTOR_MODEL = cleanModel(arg('executor-model') ?? appSettings.autopilotExecutorModel);
const ADVISOR_MODEL = cleanModel(arg('advisor-model') ?? appSettings.autopilotAdvisorModel);
const nightStart = Date.now();
const elapsedMin = () => (Date.now() - nightStart) / 60_000;
const remainingMin = () => MINUTES - elapsedMin();

// ---- 0b. One run at a time PER PROJECT (#335 — a crashed run's stale lock is
// cleared by age) ----
// A project's runs share one checkout: worktrees, fetches and ref updates all
// go through it, so two runs on the SAME project would race each other. Two
// DIFFERENT projects share nothing, so a single global lock only ever cost
// the fleet its parallelism. The server's GET /next enforces the identical
// per-project rule; this lockfile is just the host-side backstop for the
// paths that bypass the queue (a hand-run `node scripts/stack-autopilot.mjs`).
const lockDir = join(homedir(), '.stack');
const lockSlug = String(SLUG).replace(/[^A-Za-z0-9_-]/g, '_');
const lock = join(lockDir, `autopilot-${lockSlug}.lock`);
mkdirSync(lockDir, { recursive: true });
if (existsSync(lock)) {
  const { statSync } = await import('node:fs');
  const ageMin = (Date.now() - statSync(lock).mtimeMs) / 60_000;
  if (ageMin < MINUTES + 30) die(`another run for ${SLUG} appears live (lock ${Math.round(ageMin)}m old) — bailing.`);
  log(`clearing stale lock for ${SLUG} (${Math.round(ageMin)}m old)`);
}
writeFileSync(lock, `${process.pid} ${stamp()}\n`);
const unlock = () => { try { rmSync(lock); } catch { /* gone is fine */ } };
process.on('exit', unlock);

// Eligibility: open, unclaimed, not parked, human-approved — and inside the
// project's target area when one is set (Mission Control's #122 picker).
// --item pins bypass the area filter: an explicit human choice wins.
// A refine session (#274) narrows further: it works a ROUND, so only items
// the owner actually sent back with a delta are eligible — a refine-noteless
// item has nothing for it to do.
const eligible = (targetArea) => (it) =>
  !it.done && !it.skipped && !it.claimedBy && (it.source === 'manual' || it.reviewed)
  && (!targetArea || (it.area || '') === targetArea)
  && (KIND !== 'refine' || !!it.refineNote);
// The desire tier (#227): S/A/B/C is the owner's ranking of what they want
// next, sorted ahead of the MoSCoW bucket. Unranked = 4, so it lands after
// every ranked item and a board nobody has tiered is untouched.
const TIER_RANK = { S: 0, A: 1, B: 2, C: 3 };
const tierRank = (t) => TIER_RANK[String(t || '').toUpperCase()] ?? 4;
let tokensSpent = 0;
let costSpent = 0;

// #285 — the roles, inverted. The ADVISOR now runs the session: the strong model
// holds the main loop as the DIRECTOR (it plans, delegates, reads results and
// commits) and the cheap EXECUTOR model does the actual code in subagents.
//
// Why this way round: the main loop is where context accumulates — every file
// read, every test run, every retry — and subagent contexts are isolated. With
// the cheap model in the loop, all that bulk was billed cheaply but every
// judgement was cheap too. With the strong model in the loop, judgement is
// strong and the bulk moves into executor subagents at the cheap rate — but ONLY
// if the director actually delegates. A director that reads and edits files
// itself is the most expensive arrangement of all, so the contract below says so
// in as many words.
//
// No advisor set = no strong model to direct with, so the session runs
// single-model on the executor exactly as it did before #153.
const directorBlock = !ADVISOR_MODEL ? '' : `
YOU ARE THE DIRECTOR. You are the expensive model; the cheap work is not yours to do.
A subagent named "executor" (a cheaper model, with full write access to this worktree)
does the building. How to work:
- PLAN first: read only what you need to decide the approach, then write the plan as
  concrete, commit-sized units of work.
- DELEGATE each unit to the executor in one Agent call: give it the exact files, the
  intended change, the constraints, and how to verify. Ask it to report back briefly
  what it changed and anything it could not do.
- Do NOT write or edit code yourself, and do not read files the executor has already
  summarised for you. Every token you spend on bulk is spent at the expensive rate.
- VERIFY what comes back: read \`git diff --stat\`, then only the hunks that matter.
  If it is wrong, send it back with specifics rather than fixing it yourself.
- COMMIT and push the units yourself, and write the checkpoint. Judgement, sequencing
  and the record are yours; typing is not.
An executor that is stuck is your problem to unstick with a better instruction — not a
reason to take over.
`;
// Kept under the old name so the #228 session kinds read unchanged.
const advisorPromptBlock = directorBlock;

// The executor subagent (#285): the cheap model with the write access. Defined
// once so every session kind spawns the same worker. Tools are deliberately the
// full building set — a read-only executor could not build anything, which was
// the point of the old arrangement and is not the point of this one.
const executorAgent = () => ({
  executor: {
    description: 'The executor — a cheaper model that does the building. Delegate each commit-sized unit of work to it with the exact files, the intended change and how to verify.',
    prompt: 'You are the executor working under a director model on one unit of work in a git worktree. '
      + 'Do exactly what you are asked and nothing more: no refactors nobody asked for, no scope you were not given. '
      + 'Read what you need, make the change, run whatever verifies it, and report back BRIEFLY — what you changed, '
      + 'what you verified, and anything you could not do. Do not commit; the director commits. '
      + 'If the instruction is ambiguous or wrong, say so in your report instead of guessing.',
    model: EXECUTOR_MODEL || undefined,
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  },
});

// One bounded claude session (#228 — shared by the debug/audit kinds): spawn,
// meter real usage into the night budget, hand back the parsed result.
function execSession(prompt, cwd, capMin) {
  // #285 — same inversion for the debug and audit kinds: the advisor directs,
  // the executor subagent builds.
  const claudeArgs = ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'json'];
  if (ADVISOR_MODEL) claudeArgs.push('--model', ADVISOR_MODEL);
  else if (EXECUTOR_MODEL) claudeArgs.push('--model', EXECUTOR_MODEL);
  if (ADVISOR_MODEL) claudeArgs.push('--agents', JSON.stringify(executorAgent()));
  log(ADVISOR_MODEL
    ? `starting claude session (director ${ADVISOR_MODEL}, executor subagent ${EXECUTOR_MODEL || 'CLI default'})…`
    : `starting claude session (single model ${EXECUTOR_MODEL || 'CLI default'})…`);
  const run = spawnSync('claude', claudeArgs, {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: capMin * 60_000,
    killSignal: 'SIGTERM',
  });
  if (run.error) log(`claude session ended with error: ${run.error.message}`);
  let resultText = '';
  let usedTokens = 0;
  let usedCost = 0;
  let modelUsage = null;
  try {
    const out = JSON.parse(run.stdout || '{}');
    const u = out.usage || {};
    usedTokens = (u.input_tokens || 0) + (u.output_tokens || 0)
      + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    usedCost = out.total_cost_usd || 0;
    tokensSpent += usedTokens;
    costSpent += usedCost;
    resultText = String(out.result || '').trim();
    log(`session finished: ${out.num_turns ?? '?'} turns, ~${Math.round(usedTokens / 1000)}k tokens`
      + (usedCost ? ` ($${usedCost.toFixed(2)})` : ''));
    if (out.modelUsage && typeof out.modelUsage === 'object') modelUsage = out.modelUsage;
  } catch {
    log(`session finished (status ${run.status ?? 'killed at cap'}) — usage unreadable, wall clock still governs.`);
  }
  return { resultText, usedTokens, usedCost, modelUsage, limitHit: LIMIT_RE.test(resultText) };
}

// ---- #228: one bug, one branch, one bounded DEBUG session ----
// Mirrors runItem's shape without the roadmap machinery: no claim, no spec
// pre-pass (the bug IS the spec), branch fix/bug-N-<slug>. The bug is never
// marked fixed — a pushed fix moves its status to 'fixing'; the human closes.
async function runBug(bug, capMin) {
  const key = String(bug.id); // client shape: id IS the bug key (BUG-N)
  const branch = bugLaneFor(bug);
  const startedAt = new Date().toISOString();
  log(`picked ${key} [${bug.severity}] ${bug.title} (cap ${Math.round(capMin)}m)`);

  const wt = join(lockDir, 'autopilot', `${SLUG}-${key.toLowerCase()}`);
  git(REPO, ['worktree', 'remove', '--force', wt]);
  git(REPO, ['branch', '-D', branch]);
  mkdirSync(join(lockDir, 'autopilot'), { recursive: true });
  const added = git(REPO, ['worktree', 'add', wt, '-b', branch]);
  if (!existsSync(join(wt, '.git'))) throw new Error(`worktree add failed (${added || 'no output'})`);

  const prompt = `You are Stack's overnight DEBUGGER, working unattended in a dedicated git worktree on branch ${branch}.

Your single task tonight is bug ${key} (severity: ${bug.severity}):

  ${bug.title}
${bug.linkRef ? `  First seen around commit ${bug.linkRef} — start the hunt there.\n` : ''}${advisorPromptBlock}
Rules for this run:
- REPRODUCE the bug first — find the failing path and prove it (a failing test where the project has tests, else a script or a documented manual trace). If you cannot reproduce it, stop early: leave the tree clean and say exactly what you tried in the checkpoint.
- Fix the ROOT CAUSE, not the symptom; keep the fix minimal and in keeping with the codebase.
- Add or update a test/check that would have caught this, where the project has any testing surface.
- Commit in small complete units with clear messages. Push the branch with \`git push -u origin ${branch}\`. NEVER push or merge main — a human reviews and merges.
- Verify before finishing: run the project's build/typecheck (and tests) and fix what you broke.
- Do NOT mark the bug fixed — once the fix is pushed, PATCH {"status":"fixing"} to /api/projects/${SLUG}/bugs/${key} (base URL + bearer from ~/.stack/env, never print the token); the human verifies and closes it.
- When you finish (or must stop), author a rich checkpoint (see ~/.claude/commands/checkpoint.md) and pipe it to \`node ~/.stack/stack-checkpoint.mjs\`, naming the branch and ${key} in the summary.`;

  const r = execSession(prompt, wt, capMin);
  const tmuxSession = process.env.STACK_TMUX_SESSION || null;
  const runRecord = {
    item_id: null, item_title: `${key}: ${bug.title}`.slice(0, 300), branch,
    tokens: r.usedTokens, cost_usd: r.usedCost, started_at: startedAt,
    ...(r.modelUsage ? { model_usage: r.modelUsage } : {}),
    ...(tmuxSession ? { tmux_session: tmuxSession } : {}),
  };

  const nCommits = parseInt(git(wt, ['rev-list', '--count', 'main..HEAD']) || '0', 10) || 0;
  if (nCommits === 0) {
    git(REPO, ['worktree', 'remove', '--force', wt]);
    git(REPO, ['branch', '-D', branch]);
    log(`${key}: no commits — worktree removed. Check the checkpoint for what it tried.`);
    await postRun({ ...runRecord, outcome: r.limitHit ? 'limit' : 'no-commits', commits: 0,
      summary: r.resultText.slice(0, 1800) });
    return { landed: false, limitHit: r.limitHit };
  }

  git(wt, ['push', '-u', 'origin', branch]);
  log(`${key}: ${nCommits} commit(s) on ${branch}, pushed — the human verifies and closes the bug.`);
  try { await api('PATCH', `/api/projects/${SLUG}/bugs/${key}`, { status: 'fixing' }); }
  catch (e) { log(`bug status not updated (${e.message})`); }

  let checksFailing = null;
  try {
    const checks = await api('POST', `/api/projects/${SLUG}/checks/run`, {});
    const rows = Array.isArray(checks) ? checks : (checks.checks || []);
    checksFailing = rows.filter((c) => c.lastStatus === 'fail').length;
    log(`checks run: ${rows.length} total, ${checksFailing} failing.`);
  } catch (e) { log(`checks run skipped (${e.message})`); }

  await postRun({ ...runRecord, outcome: r.limitHit ? 'limit' : 'landed', commits: nCommits,
    checks_failing: checksFailing,
    summary: (r.resultText || `${nCommits} commit(s) on ${branch}.`).slice(0, 1800) });

  if (GEMINI_KEY) {
    const review = spawnSync('node', [join(REPO, 'hook', 'stack-gemini-review.mjs'), '--range', 'main..HEAD'], {
      cwd: wt, stdio: ['ignore', 'inherit', 'inherit'], timeout: 120_000,
    });
    log(review.status === 0 ? 'gemini review posted to the inbox.' : 'gemini review did not post (see above).');
  }
  return { landed: true, limitHit: r.limitHit, resultText: r.resultText };
}

// ---- #228: the DEBUG night — bugs instead of roadmap items ----
async function debugNight() {
  const attempted = new Set();
  const nightLines = [];
  let landed = 0;
  let nightLimited = false;
  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  log(`DEBUG session: ${BUG_AGENDA.length ? `agenda ${BUG_AGENDA.join(' → ')}` : 'open bugs, serious first'} — `
    + `budget ${MINUTES}m, ${MAX_ITEMS === Infinity ? 'unlimited bugs (the clock governs)' : `up to ${MAX_ITEMS} bug(s)`}.`);

  for (let n = 0; n < MAX_ITEMS; n++) {
    if (remainingMin() < MIN_SESSION_MIN) { log(`wall clock nearly spent (${Math.round(remainingMin())}m left) — stopping.`); break; }
    if (tokensSpent >= TOKEN_BUDGET) { log(`token budget spent (~${Math.round(tokensSpent / 1000)}k) — stopping.`); break; }

    const detail = await api('GET', `/api/projects/${SLUG}`);
    if (!detail.automode && !FORCE) {
      log(`${SLUG} is not on automode — nothing run. (Toggle it in the app, or --force for a manual test.)`);
      break;
    }
    const open = (detail.bugs || []).filter((b) => b.status !== 'fixed' && !attempted.has(String(b.id)));
    let bug = null;
    if (BUG_AGENDA.length) {
      for (const key of BUG_AGENDA) {
        if (attempted.has(key)) continue;
        const cand = open.find((b) => String(b.id) === key);
        if (!cand) { log(`agenda bug ${key} not found or already fixed — skipping.`); attempted.add(key); continue; }
        bug = cand;
        break;
      }
      if (!bug) { log(n === 0 ? 'nothing on the bug agenda is open — nothing to do.' : 'bug agenda exhausted — session complete.'); break; }
    } else {
      bug = [...open].sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9))[0] || null;
      if (!bug) { log(n === 0 ? `no open bugs on ${SLUG} — nothing to fix tonight.` : 'no more open bugs — session complete.'); break; }
    }

    if (DRY) { log(`dry run — would debug ${bug.id} "${bug.title}" (then keep going while budget lasts).`); process.exit(0); }

    attempted.add(String(bug.id));
    try {
      const r = await runBug(bug, remainingMin());
      if (r.landed) landed++;
      nightLines.push(`${bug.id} ${bug.title}: ${r.landed ? 'fix pushed' : 'no commits'}${r.limitHit ? ' (hit the usage limit)' : ''}`);
      if (r.limitHit) {
        nightLimited = true;
        log('usage limit hit — closing the session gracefully.');
        break;
      }
    } catch (e) {
      log(`${bug.id} failed (${e.message}) — moving on.`);
      nightLines.push(`${bug.id} ${bug.title}: failed (${e.message})`);
      await postRun({ item_id: null, item_title: `${bug.id}: ${bug.title}`.slice(0, 300), branch: '',
        outcome: 'failed', summary: String(e.message || '').slice(0, 500) });
    }
  }

  const closing = `${landed} fix branch(es) awaiting review, ${attempted.size} bug(s) attempted, `
    + `~${Math.round(tokensSpent / 1000)}k tokens${costSpent ? ` ($${costSpent.toFixed(2)})` : ''}, ${Math.round(elapsedMin())}m elapsed.`;
  log(`debug session over: ${closing}`);
  if (attempted.size > 0) {
    await notify(
      nightLimited ? `Stack autopilot (${SLUG}): debug paused on the usage limit` : `Stack autopilot (${SLUG}): debug session done`,
      `${nightLines.join('\n')}\n\n${closing}`);
  }
}

// ---- #228: the AUDIT session — one hardening pass, findings filed as bugs ----
async function auditNight() {
  const detail = await api('GET', `/api/projects/${SLUG}`);
  if (!detail.automode && !FORCE) {
    log(`${SLUG} is not on automode — nothing run. (Toggle it in the app, or --force for a manual test.)`);
    return;
  }
  const scope = AREA_ARG ? String(AREA_ARG).toLowerCase() : '';
  if (DRY) { log(`dry run — would run an audit session${scope ? ` scoped to "${scope}"` : ''}.`); process.exit(0); }
  log(`AUDIT session${scope ? ` (area "${scope}")` : ''}: budget ${MINUTES}m.`);

  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const branch = auditLaneFor(day);
  const startedAt = new Date().toISOString();
  const wt = join(lockDir, 'autopilot', `${SLUG}-audit`);
  git(REPO, ['worktree', 'remove', '--force', wt]);
  git(REPO, ['branch', '-D', branch]);
  mkdirSync(join(lockDir, 'autopilot'), { recursive: true });
  const added = git(REPO, ['worktree', 'add', wt, '-b', branch]);
  if (!existsSync(join(wt, '.git'))) throw new Error(`worktree add failed (${added || 'no output'})`);

  const prompt = `You are Stack's overnight AUDITOR, working unattended in a dedicated git worktree on branch ${branch}. Tonight is an AUDIT session: hunt for real defects and harden the safety net — no feature work.
${scope ? `\nScope: the "${scope}" product area — audit that surface first and stay close to it.\n` : ''}${detail.northStar ? `The project's north star: "${detail.northStar.slice(0, 400)}"\n` : ''}${advisorPromptBlock}
Work through, in order:
1. Run the project's build/typecheck and tests; note anything red.
2. Read the code for REAL defects — error handling, auth gaps, race conditions, data-loss paths, broken flows. Verify every suspicion against the actual code before calling it a bug; no speculative findings.
3. File each VERIFIED bug via the Stack API: POST /api/projects/${SLUG}/bugs with {"title":"<what breaks, where>","severity":"critical|high|medium|low"} (base URL + bearer from ~/.stack/env — never print the token). Honest severities; skip anything already tracked in the bug list.
4. Where the project has a test surface, add or strengthen tests/checks covering what you found — commit those in small complete units on this branch and push with \`git push -u origin ${branch}\`. NEVER push or merge main.
5. Author a rich checkpoint (see ~/.claude/commands/checkpoint.md) piped to \`node ~/.stack/stack-checkpoint.mjs\`: what was checked, what was filed, what was hardened.`;

  const r = execSession(prompt, wt, remainingMin());
  const nCommits = parseInt(git(wt, ['rev-list', '--count', 'main..HEAD']) || '0', 10) || 0;
  if (nCommits > 0) {
    git(wt, ['push', '-u', 'origin', branch]);
    log(`audit: ${nCommits} hardening commit(s) on ${branch}, pushed.`);
  } else {
    git(REPO, ['worktree', 'remove', '--force', wt]);
    git(REPO, ['branch', '-D', branch]);
    log('audit: no commits — findings (if any) were filed straight to the bug tracker.');
  }
  const tmuxSession = process.env.STACK_TMUX_SESSION || null;
  await postRun({
    item_id: null, item_title: `Audit session${scope ? ` — ${scope}` : ''}`,
    branch: nCommits ? branch : '',
    outcome: r.limitHit ? 'limit' : nCommits ? 'landed' : 'no-commits', commits: nCommits,
    tokens: r.usedTokens, cost_usd: r.usedCost, started_at: startedAt,
    checks_failing: null,
    summary: (r.resultText || 'Audit session finished.').slice(0, 1800),
    ...(r.modelUsage ? { model_usage: r.modelUsage } : {}),
    ...(tmuxSession ? { tmux_session: tmuxSession } : {}),
  });
  await notify(`Stack autopilot (${SLUG}): audit ${r.limitHit ? 'paused on the usage limit' : 'done'}`,
    (r.resultText || 'Audit session finished.').slice(0, 800));
}

// ---- #219: one item, one bounded DESIGN session (plan night) ----
// No branch, no claim, no commits: the session reads the code from a detached
// throwaway worktree (so stray edits can never touch the human's checkout or
// any branch) and answers with a design doc as JSON. The RUNNER does the
// write — plan steps + a design section appended to the note — so the
// "saved as plan steps + note" contract holds even when the model waffles.
async function runPlanItem(item, northStar, capMin) {
  const startedAt = new Date().toISOString();
  log(`planning #${item.id} [${item.bucket}] ${item.title} (cap ${Math.round(capMin)}m)`);

  const wt = join(lockDir, 'autopilot', `${SLUG}-plan`);
  git(REPO, ['worktree', 'remove', '--force', wt]);
  mkdirSync(join(lockDir, 'autopilot'), { recursive: true });
  const added = git(REPO, ['worktree', 'add', '--detach', wt]);
  if (!existsSync(join(wt, '.git'))) throw new Error(`plan worktree add failed (${added || 'no output'})`);

  const prompt = `You are Stack's overnight PLANNER on a design-doc night. Do NOT write or change any code, do NOT commit, do NOT touch the tracker — you read the codebase and author a short design doc for ONE roadmap item, so a later build session executes against an agreed design instead of a title.

Roadmap item #${item.id} (bucket: ${item.bucket}): ${item.title}
${item.note ? `The author's note: ${item.note.slice(0, 1500)}\n` : ''}${northStar ? `The project's north star: "${northStar.slice(0, 400)}"\n` : ''}
Read the relevant code first — real file paths, real tables, real routes. Then answer with ONLY this JSON as your final output (no prose around it):
{ "approach": "2-4 sentences — how to build it and where it hooks in",
  "interfaces": ["the routes/functions/props touched or added — file paths included"],
  "dataChanges": ["schema/storage changes, or 'none'"],
  "risks": ["what could bite — max 3"],
  "steps": ["4-8 ordered implementation steps, each one commit-sized"] }`;

  // #285 — a plan night writes a design and nothing else: all judgement, no
  // typing. So it runs on the advisor when there is one (and spawns no executor
  // — there is nothing to delegate), falling back to the executor model.
  const claudeArgs = ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'json'];
  const planModel = ADVISOR_MODEL || EXECUTOR_MODEL;
  if (planModel) claudeArgs.push('--model', planModel);
  const run = spawnSync('claude', claudeArgs, {
    cwd: wt,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: capMin * 60_000,
    killSignal: 'SIGTERM',
  });
  if (run.error) log(`plan session ended with error: ${run.error.message}`);
  git(REPO, ['worktree', 'remove', '--force', wt]);

  let resultText = '';
  let usedTokens = 0;
  let usedCost = 0;
  let modelUsage = null; // per-model breakdown (#167), same as the build path
  try {
    const out = JSON.parse(run.stdout || '{}');
    const u = out.usage || {};
    usedTokens = (u.input_tokens || 0) + (u.output_tokens || 0)
      + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    usedCost = out.total_cost_usd || 0;
    tokensSpent += usedTokens;
    costSpent += usedCost;
    resultText = String(out.result || '').trim();
    log(`plan session finished: ${out.num_turns ?? '?'} turns, ~${Math.round(usedTokens / 1000)}k tokens`
      + (usedCost ? ` ($${usedCost.toFixed(2)})` : ''));
    // A plan night runs on the advisor and spawns no executor, so its breakdown
    // is the cleanest evidence the advisor exists at all. Omitting it is what
    // made the Roles room read a week of plan nights as "advisor configured but
    // never consulted" — the one arrangement where that is certainly false.
    if (out.modelUsage && typeof out.modelUsage === 'object') {
      modelUsage = out.modelUsage;
      const perModel = Object.entries(out.modelUsage).map(([model, mu]) => {
        const t = (mu.inputTokens || 0) + (mu.outputTokens || 0)
          + (mu.cacheReadInputTokens || 0) + (mu.cacheCreationInputTokens || 0);
        return `${model} ~${Math.round(t / 1000)}k${mu.costUSD ? ` ($${mu.costUSD.toFixed(2)})` : ''}`;
      });
      if (perModel.length) log(`model usage: ${perModel.join(' · ')}`);
    }
  } catch {
    log(`plan session finished (status ${run.status ?? 'killed at cap'}) — output unreadable.`);
  }
  const limitHit = LIMIT_RE.test(resultText);
  const runRecord = {
    item_id: item.id, item_title: item.title, branch: '',
    tokens: usedTokens, cost_usd: usedCost, started_at: startedAt,
    ...(modelUsage ? { model_usage: modelUsage } : {}), // per-model breakdown (#167)
  };

  let design = null;
  try {
    design = JSON.parse(resultText.match(/\{[\s\S]*\}/)?.[0] || '');
  } catch { /* no parseable design */ }
  const steps = Array.isArray(design?.steps)
    ? design.steps.map((s) => String(s).trim()).filter(Boolean).slice(0, 12) : [];
  if (!design?.approach || steps.length === 0) {
    log(`#${item.id}: no usable design came back — item left untouched.`);
    await postRun({ ...runRecord, outcome: limitHit ? 'limit' : 'failed', commits: 0,
      summary: (resultText || 'plan session produced no design').slice(0, 1800) });
    return { landed: false, limitHit };
  }

  const list = (v) => (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
  const docLines = [
    `— Design (plan night ${startedAt.slice(0, 10)}):`,
    `Approach: ${String(design.approach).trim()}`,
    ...(list(design.interfaces).length ? [`Interfaces: ${list(design.interfaces).join('; ')}`] : []),
    ...(list(design.dataChanges).length ? [`Data: ${list(design.dataChanges).join('; ')}`] : []),
    ...(list(design.risks).length ? [`Risks: ${list(design.risks).join('; ')}`] : []),
  ];
  const note = `${(item.note || '').trim()}\n\n${docLines.join('\n')}`.trim().slice(0, 4000);
  await api('PATCH', `/api/projects/${SLUG}/roadmap/${item.id}`, {
    note,
    plan: steps.map((text) => ({ text, done: false })),
  });
  log(`#${item.id}: design saved — ${steps.length} plan step(s) + design note. Review it on the board, then a build night executes it.`);
  await postRun({ ...runRecord, outcome: limitHit ? 'limit' : 'planned', commits: 0,
    summary: `Design authored: ${String(design.approach).trim()}`.slice(0, 1800) });
  return { landed: true, limitHit };
}

// ---- one item, one branch, one bounded session ----
async function runItem(item, northStar, capMin) {
  const startedAt = new Date().toISOString();
  log(`picked #${item.id} [${item.bucket}] ${item.title} (cap ${Math.round(capMin)}m)`);

  // A refine round (#274) continues the item's OWN branch when one still
  // exists on origin — the delta belongs on top of the work it corrects, not
  // beside it (scripts/lib/refine.mjs). Every other kind cuts fresh, exactly
  // as before.
  let branch = laneFor(item);
  let continuing = false;
  if (KIND === 'refine') {
    const heads = git(REPO, ['ls-remote', '--heads', 'origin']).split('\n')
      .map((l) => l.split('\t')[1] || '')
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length));
    // `git()` catches and returns '' on any failure, so a network problem, a
    // missing remote or a bad credential is indistinguishable from "origin
    // has no branches for this item" — and an origin that answers at all
    // always has at least one head. Reading that ambiguity the wrong way
    // would cut a FRESH branch, abandoning the previous round's commits and
    // dooming the eventual push to a non-fast-forward failure after the
    // whole session is spent. Fail SAFE: an unreadable origin means do
    // nothing, not build (CLAUDE.md's fail-safe direction).
    if (heads.length === 0) {
      log(`#${item.id}: could not read origin's branches — not cutting a fresh branch for a refine round, since that would abandon the previous round.`);
      try { await api('PATCH', `/api/projects/${SLUG}/roadmap/${item.id}`, { claimed_by: '' }); } catch { /* best effort */ }
      await postRun({ item_id: item.id, item_title: item.title, branch, outcome: 'failed', commits: 0,
        summary: 'refine round skipped: ls-remote returned no heads (origin unreachable, missing, or a credential problem).' });
      return { landed: false, limitHit: false };
    }
    const target = refineTargetBranch(item, heads);
    if (target) { branch = target; continuing = true; }
  }

  // Claim the RESOLVED branch (visible on the deck's lanes strip immediately) —
  // not laneFor(item), so Mission Control's ledger points at the branch that
  // actually moves.
  await api('PATCH', `/api/projects/${SLUG}/roadmap/${item.id}`, { claimed_by: branch });

  // The spec pre-pass — Gemini plans, the session builds, the human disposes.
  // A refined item (#146) skips it: the owner's refine_note IS the spec — a
  // fresh full-item spec would drown the delta in re-derived scope.
  const spec = item.refineNote ? null : await geminiSpec(item, northStar);
  if (spec) log(`spec ready: ${spec.goal}`);

  // A fresh worktree so the human's checkout is never disturbed.
  const wt = join(lockDir, 'autopilot', `${SLUG}-item-${item.id}`);
  mkdirSync(join(lockDir, 'autopilot'), { recursive: true });
  git(REPO, ['worktree', 'remove', '--force', wt]); // clear a previous attempt's tree
  let added;
  if (continuing) {
    // Start from origin's tip so the previous round's commits are the base
    // and this session's push is a fast-forward — never `branch -D` here,
    // that is the line that would throw the previous round away.
    log(`refine round: continuing ${branch} — its previous commits are the base for this round.`);
    git(REPO, ['fetch', 'origin', branch]);
    added = git(REPO, ['worktree', 'add', wt, '-B', branch, `origin/${branch}`]);
    if (!existsSync(join(wt, '.git'))) {
      // Most likely a parallel session already has this branch checked out
      // elsewhere — never force it. Release the claim and move on; the
      // branch on origin is untouched either way.
      log(`#${item.id}: could not check out ${branch} for the refine round (${added || 'no output'}) — skipping rather than forcing it.`);
      try { await api('PATCH', `/api/projects/${SLUG}/roadmap/${item.id}`, { claimed_by: '' }); } catch { /* best effort */ }
      await postRun({ item_id: item.id, item_title: item.title, branch, outcome: 'failed', commits: 0,
        summary: `worktree add failed for the refine round on ${branch} (${added || 'no output'}).` });
      return { landed: false, limitHit: false };
    }
  } else {
    if (KIND === 'refine') log(`refine round: no branch found for #${item.id} on origin — the previous work already landed on main; building fresh on ${branch}.`);
    git(REPO, ['branch', '-D', branch]); // (branch survives on origin if pushed)
    added = git(REPO, ['worktree', 'add', wt, '-b', branch]);
    if (!existsSync(join(wt, '.git'))) throw new Error(`worktree add failed (${added || 'no output'})`);
  }

  // A run row is this SESSION's own account of itself. The previous round
  // already has its own row, its own commit count and its own second-model
  // read, so for a continuing refine round the base for "what did THIS
  // session do" is the commit the worktree was checked out at — not main —
  // captured HERE, before the session commits anything. Counting the
  // previous round's commits again would report work this session didn't
  // do; re-reviewing them would spend a review on a diff a human has
  // already seen. Every non-refine run, and a refine round with no branch
  // to continue, bases off `main` and nothing changes.
  let base = 'main';
  if (continuing) {
    const head = git(wt, ['rev-parse', 'HEAD']);
    if (head) base = head;
    else log(`#${item.id}: could not read HEAD on ${branch} to base the refine range on — falling back to main..HEAD.`);
  }

  // The owner's implementation plan (#75), worked top-down — ticked steps are
  // already done from an earlier pass, so the session starts at the first open one.
  const planBlock = !item.plan?.length ? '' : `
The owner's implementation plan — work the unticked steps IN ORDER (ticked ones are already done):
${item.plan.map((s, idx) => `  ${s.done ? '[x]' : '[ ]'} ${idx + 1}. ${s.text}`).join('\n')}
As each step lands, record it: PATCH {"plan":[the full updated list with that step's "done":true]}
to the Stack API at /api/projects/${SLUG}/roadmap/${item.id} (base URL + bearer from ~/.stack/env —
never print the token). Finishing only some steps is fine; say where you stopped in the checkpoint.
`;

  // The plan-before-build gate (#219): a Must item arriving with no plan gets
  // its design authored FIRST, in-session, and saved back — so even unplanned
  // work leaves an agreed-shape record and the build follows a written design.
  const designFirstBlock = (item.plan?.length || item.refineNote || item.bucket !== 'must') ? '' : `
This is a Must item with NO implementation plan yet. BEFORE you write any code:
1. Read the relevant code and author a short design — approach, interfaces touched, data changes, risks — plus 4-8 ordered commit-sized steps.
2. Save it to the item so the design outlives tonight: PATCH {"plan":[{"text":"…","done":false}, …]} (and append the design summary to the note via {"note":"…"}) at /api/projects/${SLUG}/roadmap/${item.id} — base URL + bearer token from ~/.stack/env, never print the token.
3. Then build against your own design, ticking steps off as they land (re-send the full plan list with "done":true).
`;

  // A refinement round (#146, #274): the item landed before and came back
  // with a delta — the session changes what the note asks for, not a rebuild.
  const refineBlock = !item.refineNote ? '' : `
This item was BUILT BEFORE and sent back for refinement.${item.builtNote ? `
What landed last time (already merged or on its branch — do not redo it):
  ${item.builtNote}` : ''}
The owner's refinement — change ONLY what this asks for, on top of what already landed:
  ${item.refineNote}
Do NOT treat the title/note above as a fresh spec and rebuild from scratch — the previous work stands. Apply only the delta the refinement describes.
${continuing
  ? `This branch already carries the previous round's commits — commit your delta ON TOP of them. Never rebase, amend or force-push what is already on origin: a human is reviewing that history.`
  : `The previous round's work is already on main (its branch was merged and deleted), so you are building on a fresh branch off main.`}
`;

  // #285 — the build session's copy of the director contract. Same inversion:
  // the strong model directs, the cheap executor subagent builds.
  const advisorBlock = directorBlock;

  const prompt = `You are Stack's overnight autopilot, working unattended in a dedicated git worktree on branch ${branch}.

Your single task tonight is roadmap item #${item.id} (bucket: ${item.bucket}):

  ${item.title}
${item.note ? `  Context: ${item.note}\n` : ''}${refineBlock}${specBlock(spec)}${designFirstBlock}${planBlock}${advisorBlock}
Rules for this run:
- Work ONLY on this item; do not pick up other roadmap items or ideas.
- Commit in small complete units with clear messages. Push the branch with \`git push -u origin ${branch}\`. NEVER push or merge main — a human reviews and merges in the morning.
- Verify before finishing: run the project's build/typecheck (and tests where they exist) and fix what you broke.
- Do NOT mark the roadmap item done — that is the human's call after review.
- When you finish (or must stop), author a rich checkpoint: compose the checkpoint JSON described in ~/.claude/commands/checkpoint.md (summary, current_phase, in_progress, next_up, blockers, tags, extract) and pipe it to \`node ~/.stack/stack-checkpoint.mjs\`. Mention the branch name in the summary.
- If the item proves impossible or unsafe to do unattended, stop early: leave the tree clean, and say why in the checkpoint summary and blockers.`;

  // Bounded session; JSON output so real token usage lands in the night ledger.
  // #285 — the invocation, inverted. `--model` is the ADVISOR: the strong model
  // holds the main loop and directs. `--agents` defines the EXECUTOR subagent on
  // the cheap model, with the write tools it needs to actually build. With no
  // advisor set there is nothing to direct with, so it falls back to exactly the
  // pre-#153 single-model session on the executor model.
  const claudeArgs = ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'json'];
  if (ADVISOR_MODEL) claudeArgs.push('--model', ADVISOR_MODEL);
  else if (EXECUTOR_MODEL) claudeArgs.push('--model', EXECUTOR_MODEL);
  if (ADVISOR_MODEL) claudeArgs.push('--agents', JSON.stringify(executorAgent()));
  log(ADVISOR_MODEL
    ? `starting claude session (director ${ADVISOR_MODEL}, executor subagent ${EXECUTOR_MODEL || 'CLI default'})…`
    : `starting claude session (single model ${EXECUTOR_MODEL || 'CLI default'})…`);
  const run = spawnSync('claude', claudeArgs, {
    cwd: wt,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: capMin * 60_000,
    killSignal: 'SIGTERM',
  });
  if (run.error) log(`claude session ended with error: ${run.error.message}`);

  let resultText = '';
  let usedTokens = 0;
  let usedCost = 0;
  let modelUsage = null; // per-model breakdown (#167): persisted to the run ledger
  try {
    const out = JSON.parse(run.stdout || '{}');
    const u = out.usage || {};
    usedTokens = (u.input_tokens || 0) + (u.output_tokens || 0)
      + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    usedCost = out.total_cost_usd || 0;
    tokensSpent += usedTokens;
    costSpent += usedCost;
    resultText = String(out.result || '').trim();
    log(`session finished: ${out.num_turns ?? '?'} turns, ~${Math.round(usedTokens / 1000)}k tokens`
      + (usedCost ? ` ($${usedCost.toFixed(2)})` : ''));
    // Per-model breakdown (#153/#167): with an advisor in play this is the proof
    // both roles ran on their own models — one line per model in the night log,
    // and the raw object is persisted to the run ledger row (model_usage column).
    if (out.modelUsage && typeof out.modelUsage === 'object') {
      modelUsage = out.modelUsage;
      const perModel = Object.entries(out.modelUsage).map(([model, u]) => {
        const t = (u.inputTokens || 0) + (u.outputTokens || 0)
          + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0);
        return `${model} ~${Math.round(t / 1000)}k${u.costUSD ? ` ($${u.costUSD.toFixed(2)})` : ''}`;
      });
      if (perModel.length) log(`model usage: ${perModel.join(' · ')}`);
    }
  } catch {
    log(`session finished (status ${run.status ?? 'killed at cap'}) — usage unreadable, wall clock still governs.`);
  }
  // The graceful close: a session that died on the usage limit is not a
  // failure of the item — flag it so the night stops and resumes itself.
  const limitHit = LIMIT_RE.test(resultText);
  // Include the monitoring tmux session name (#171) when the dispatcher started
  // us inside one — so the web terminal and Reviews view can re-attach.
  const tmuxSession = process.env.STACK_TMUX_SESSION || null;
  const runRecord = {
    item_id: item.id, item_title: item.title, branch,
    tokens: usedTokens, cost_usd: usedCost, started_at: startedAt,
    ...(modelUsage ? { model_usage: modelUsage } : {}), // per-model breakdown (#167)
    ...(tmuxSession ? { tmux_session: tmuxSession } : {}), // monitoring session (#171)
  };

  // What did it produce? (base..HEAD, not main..HEAD — see `base` above.)
  const nCommits = parseInt(git(wt, ['rev-list', '--count', `${base}..HEAD`]) || '0', 10) || 0;
  if (nCommits === 0) {
    // Nothing landed — release the claim so tomorrow (or the scheduled
    // resume) retries, tidy the tree.
    await api('PATCH', `/api/projects/${SLUG}/roadmap/${item.id}`, { claimed_by: '' });
    git(REPO, ['worktree', 'remove', '--force', wt]);
    git(REPO, ['branch', '-D', branch]); // local ref only — origin/${branch} (and a continuing round's prior commits on it) is untouched
    log(`#${item.id}: no commits — lane released, worktree removed. Check the checkpoint/blockers for why.`);
    await postRun({ ...runRecord, outcome: limitHit ? 'limit' : 'no-commits', commits: 0,
      summary: resultText.slice(0, 1800) });
    return { landed: false, limitHit };
  }

  // Belt-and-braces: make sure the branch is on origin even if the session forgot.
  git(wt, ['push', '-u', 'origin', branch]);
  log(`#${item.id}: ${nCommits} commit(s) on ${branch}, pushed — claim stays until you merge + tick it.`);

  // Stamp what landed on the item (annotation only — done stays the human's
  // call; the Reviews view shows this the moment they tick it).
  const builtNote = (resultText || `Built overnight on ${branch} (${nCommits} commit(s)) — see the branch diff and the checkpoint on the activity feed.`).slice(0, 1800);
  try {
    await api('PATCH', `/api/projects/${SLUG}/roadmap/${item.id}`, { built_note: `[${branch}] ${builtNote}` });
  } catch (e) { log(`built_note skipped (${e.message})`); }

  // Checks run (bounded server-side; failures are morning reading).
  let checksFailing = null;
  let checksRan = 0; // how many actually ran — zero checks is NOT a green signal (#212)
  try {
    const checks = await api('POST', `/api/projects/${SLUG}/checks/run`, {});
    const rows = Array.isArray(checks) ? checks : (checks.checks || []);
    checksRan = rows.length;
    checksFailing = rows.filter((c) => c.lastStatus === 'fail').length;
    log(`checks run: ${rows.length} total, ${checksFailing} failing.`);
  } catch (e) { log(`checks run skipped (${e.message})`); }

  const runRow = await postRun({ ...runRecord, outcome: limitHit ? 'limit' : 'landed', commits: nCommits,
    checks_failing: checksFailing,
    summary: (resultText || `${nCommits} commit(s) on ${branch}.`).slice(0, 1800) });

  // Gemini second-model review of the branch diff → review inbox. The verdict
  // file (#212) is how a clean review becomes machine-readable for auto-merge.
  let reviewVerdict = null;
  if (GEMINI_KEY) {
    const verdictFile = join(lockDir, 'autopilot', `${SLUG}-item-${item.id}-verdict.json`);
    try { rmSync(verdictFile); } catch { /* none from a previous attempt */ }
    const review = spawnSync('node', [join(REPO, 'hook', 'stack-gemini-review.mjs'),
      '--range', `${base}..HEAD`, '--verdict-file', verdictFile], {
      cwd: wt, stdio: ['ignore', 'inherit', 'inherit'], timeout: 120_000,
    });
    log(review.status === 0 ? 'gemini review posted to the inbox.' : 'gemini review did not post (see above).');
    try {
      reviewVerdict = JSON.parse(readFileSync(verdictFile, 'utf8'));
      rmSync(verdictFile);
    } catch { /* no verdict — treated as not-clean below */ }
    // Keep both reads: the morning's review queue starts from them instead of blank.
    await attachReview(runRow?.id, reviewVerdict, runArchitect(wt, `item-${item.id}`, `${base}..HEAD`));
  }

  // Risk-tiered auto-merge (#212) — the graduated-trust lever. A LOW-risk item
  // whose run is green on every signal queues its own merge job (the same
  // dispatcher path as Mission Control's ⇥ Merge — conflicts still abort, the
  // item is never auto-ticked, and the human still verdicts it in Reviews).
  // Every gate is positive evidence; anything absent (no checks, no review,
  // no verdict) means NO auto-merge, with the reason in the night log.
  if ((item.risk || 'normal') === 'low' && !limitHit) {
    const checksGreen = checksRan > 0 && checksFailing === 0;
    const reviewClean = reviewVerdict != null && reviewVerdict.bugs === 0;
    if (isRefineRound(item)) {
      // #274 — a refine round is never machine-closed. The human who sent
      // this item back is the one who closes it; the run being green this
      // time doesn't change what the send-back was asking for.
      log(`#${item.id} is a refine round — the human who sent it back closes it; not auto-merging.`);
    } else if (autoMergeAllowed({ risk: item.risk, limitHit, checksRan, checksFailing, reviewClean, item })) {
      try {
        const job = await api('POST', '/api/autopilot/merge',
          { slug: SLUG, branch, itemId: item.id, auto: true });
        log(`#${item.id} is low risk with green checks + a clean review — auto-merge queued as job #${job.id} (the dispatcher merges after this night ends; ticking stays yours).`);
      } catch (e) { log(`auto-merge not queued (${e.message}) — merge by hand from Mission Control.`); }
    } else {
      log(`#${item.id} is low risk but NOT auto-merging: `
        + `${checksGreen ? 'checks green' : checksRan > 0 ? `${checksFailing} check(s) failing` : 'no checks ran'}, `
        + `${reviewClean ? 'review clean' : reviewVerdict ? `review flagged ${reviewVerdict.bugs} bug(s)` : 'no review verdict'}.`);
    }
  }
  return { landed: true, limitHit, resultText };
}

// ---- the night loop: items until a budget runs dry ----
try {
  // #228 — debug and audit sessions have their own loops; build/plan continue below.
  if (KIND === 'debug') { await debugNight(); process.exit(0); }
  if (KIND === 'audit') { await auditNight(); process.exit(0); }

  const attempted = new Set();
  const nightLines = [];
  let landed = 0;
  let stepsSpent = 0;
  // #325 — the night's progress report, distinct from stepsSpent (the START
  // charge that paces the loop): stepsTicked is what BUILD sessions landed,
  // stepsDesigned is what PLAN sessions authored (a plan night's items start
  // plan-less, so its whole product lives here, not in stepsTicked), and
  // stepsRemaining is what's still open on the items this night touched.
  let stepsTicked = 0;
  let stepsDesigned = 0;
  let stepsRemaining = 0;
  let anyPlanned = false; // did any attempted item actually carry (or gain) a plan?
  let nightLimited = false;
  // #325 — a pinned item, an agenda or an audit keep their exact structural
  // cap (there's nothing else TO pick); otherwise the item cap is only a
  // runaway backstop — never fewer items than the step budget could ever
  // need — because the step budget is what actually governs the general pick.
  const ITEM_BACKSTOP = (ITEM_ID != null || AGENDA.length || KIND === 'audit') ? MAX_ITEMS : Math.max(MAX_ITEMS, STEP_BUDGET);
  log(`${PLAN_ONLY ? 'PLAN night (#219 — designs only, no builds): ' : ''}night budget: ${MINUTES}m wall clock, `
    + `${TOKEN_BUDGET === Infinity ? 'UNLIMITED tokens' : `${Math.round(TOKEN_BUDGET / 1000)}k tokens`}, `
    + `${STEP_BUDGET === Infinity ? 'UNLIMITED steps' : `up to ${STEP_BUDGET} plan step(s)`} `
    + `(item cap: ${MAX_ITEMS === Infinity ? 'none — the clock, tokens and steps govern' : `${MAX_ITEMS} as a backstop`})${ITEM_ID != null ? ` (pinned to #${ITEM_ID})`
      : AGENDA.length ? ` (agenda: ${AGENDA.map((i) => `#${i}`).join(' → ')})` : ''}.`);
  log(`models: executor ${EXECUTOR_MODEL || 'CLI default'}, advisor ${ADVISOR_MODEL || 'off'}.`);

  for (let n = 0; n < ITEM_BACKSTOP; n++) {
    if (remainingMin() < MIN_SESSION_MIN) { log(`wall clock nearly spent (${Math.round(remainingMin())}m left) — stopping.`); break; }
    if (tokensSpent >= TOKEN_BUDGET) { log(`token budget spent (~${Math.round(tokensSpent / 1000)}k) — stopping.`); break; }
    if (stepsSpent >= STEP_BUDGET) { log(`step budget spent (~${stepsSpent} of ${STEP_BUDGET} steps) — stopping.`); break; }

    // Re-fetch each round: claims from earlier items (and any human activity)
    // change what's eligible.
    const detail = await api('GET', `/api/projects/${SLUG}`);
    if (!detail.automode && !FORCE) {
      log(`${SLUG} is not on automode — nothing run. (Toggle it in the app, or --force for a manual test.)`);
      break;
    }
    // A pinned run (--item, from a scheduled or Run-now job) targets exactly
    // that item in any bucket — a human chose it, so skipped/unreviewed pass;
    // done or already-claimed still refuse.
    let item;
    if (ITEM_ID != null) {
      const all = ['must', 'should', 'could', 'wont'].flatMap((b) => detail.roadmap?.[b] || []);
      item = all.find((it) => Number(it.id) === ITEM_ID);
      if (!item) { log(`item #${ITEM_ID} not found on ${SLUG} — nothing run.`); break; }
      if (item.done || item.claimedBy) {
        log(`item #${ITEM_ID} is ${item.done ? 'already done' : `claimed by ${item.claimedBy}`} — nothing run.`);
        break;
      }
      // A pinned replan may replace an untouched plan, but never one a session
      // has already worked — ticked steps mean the design is in play.
      if (PLAN_ONLY && item.plan?.some((s) => s.done)) {
        log(`item #${ITEM_ID} has ticked plan steps — not replanning over work in progress.`);
        break;
      }
      // A refine session (#274) works a ROUND on a refine note, never a fresh
      // build — a pinned item with none is a mismatched request, not a silent
      // fall-through to build-from-scratch.
      if (KIND === 'refine' && !item.refineNote) {
        log(`#${ITEM_ID} carries no refine note — nothing to refine; run a build session instead.`);
        break;
      }
    } else if (AGENDA.length) {
      // #228 — an ordered agenda from the session planner: work exactly these,
      // in this order. Unrunnable entries (missing / done / claimed) are
      // skipped with a note rather than sinking the session.
      const all = ['must', 'should', 'could', 'wont'].flatMap((b) => detail.roadmap?.[b] || []);
      for (const id of AGENDA) {
        if (attempted.has(id)) continue;
        const cand = all.find((it) => Number(it.id) === id);
        if (!cand) { log(`agenda item #${id} not found on ${SLUG} — skipping.`); attempted.add(id); continue; }
        if (cand.done || cand.claimedBy) {
          log(`agenda item #${id} is ${cand.done ? 'already done' : `claimed by ${cand.claimedBy}`} — skipping.`);
          attempted.add(id);
          continue;
        }
        if (PLAN_ONLY && cand.plan?.some((s) => s.done)) {
          log(`agenda item #${id} has ticked plan steps — not replanning over work in progress.`);
          attempted.add(id);
          continue;
        }
        if (KIND === 'refine' && !cand.refineNote) {
          log(`agenda item #${id} carries no refine note — nothing to refine; skipping.`);
          attempted.add(id);
          continue;
        }
        item = cand;
        break;
      }
      if (!item) {
        log(n === 0 ? 'nothing on the agenda is runnable — nothing to do.' : 'agenda exhausted — session complete.');
        break;
      }
    } else {
      const targetArea = AREA_ARG != null ? String(AREA_ARG).toLowerCase() : (detail.autopilotArea || '');
      item = [...(detail.roadmap?.must || []), ...(detail.roadmap?.should || [])]
        // The desire tier (#227) is the PRIMARY sort — what the owner actually
        // wants next beats MoSCoW sizing. Unranked items keep their old place
        // (tier rank 4, after every ranked one), and the array arrives already
        // ordered must-then-should within bucket position, so a stable sort by
        // tier alone leaves an unranked board picking exactly as it always did.
        .sort((a, b) => tierRank(a.tier) - tierRank(b.tier))
        .filter((it) => !attempted.has(it.id))
        // A plan night wants the items still missing a design (#219).
        .filter((it) => !PLAN_ONLY || !(it.plan?.length))
        .find(eligible(targetArea));
      if (!item && targetArea && n === 0) log(`(target area "${targetArea}" — items outside it are ignored)`);
    }
    if (!item) {
      log(n === 0
        ? `no eligible ${PLAN_ONLY ? 'plan-less ' : ''}must/should item on ${SLUG} — nothing to do tonight.`
        : 'no more eligible items — night complete.');
      break;
    }

    if (DRY) {
      log(PLAN_ONLY
        ? `dry run — would author a design for #${item.id} "${item.title}" (then keep going while budget lasts).`
        : `dry run — would claim ${laneFor(item)} for "${item.title}" (then keep going while budget lasts).`);
      process.exit(0);
    }

    attempted.add(item.id);
    // Charge the step budget on START, not on landing: like the token budget,
    // a night starts an item while any budget remains and charges after, so a
    // big item is never starved mid-run — but that also means a crash loop
    // cannot run free, since the cost is spent before the try/catch below
    // knows whether the item lands.
    stepsSpent += stepCost(item);
    // #325 — the plan size BEFORE the session touches it, so a re-read after
    // can say how many steps it actually ticked rather than just that it ran.
    const planTotalBefore = item.plan?.length ?? 0;
    const stepsLeftBefore = stepsLeft(item);
    if (planTotalBefore > 0) anyPlanned = true;
    try {
      // Designs are quick — cap each plan session well under the night so one
      // rambler can't eat the batch.
      const r = PLAN_ONLY
        ? await runPlanItem(item, detail.northStar || '', Math.min(remainingMin(), 20))
        : await runItem(item, detail.northStar || '', remainingMin());
      if (r.landed) landed++;
      // Best-effort re-read (same reason as postRun): the item's plan after
      // the session is the ONLY place "steps actually ticked" lives, but a
      // failed read must not sink a run that already landed — fall back to
      // "nothing ticked" and keep going.
      let stepsLeftAfter = stepsLeftBefore;
      try {
        const roadmap = await api('GET', `/api/projects/${SLUG}/roadmap`);
        const all = ['must', 'should', 'could', 'wont'].flatMap((b) => roadmap?.[b] || []);
        const after = all.find((it) => Number(it.id) === item.id);
        if (after) stepsLeftAfter = stepsLeft(after);
      } catch { /* best effort — count it as unticked rather than sink the run */ }
      // Clamp at 0 both ways: a build session that ticks steps must never
      // read as having DESIGNED negative ones, and — the mirror image — a
      // plan session that authors a fresh plan must never read as having
      // TICKED negative ones. A plan night's whole output lives on this
      // second number, since the item it picked started with no plan at all.
      const ticked = Math.max(0, stepsLeftBefore - stepsLeftAfter);
      const designed = Math.max(0, stepsLeftAfter - stepsLeftBefore);
      stepsTicked += ticked;
      stepsDesigned += designed;
      stepsRemaining += stepsLeftAfter;
      // An item that started plan-less but ended with steps counts as
      // "planned" for reporting purposes, same as one that already had a plan.
      if (stepsLeftAfter > 0) anyPlanned = true;
      const stepNote = PLAN_ONLY
        ? (designed > 0 ? ` — ${designed} step(s) designed` : '')
        : (planTotalBefore > 0 ? ` — ${ticked} of ${planTotalBefore} step(s) ticked, ${stepsLeftAfter} left` : '');
      nightLines.push(`#${item.id} ${item.title}: ${r.landed ? (PLAN_ONLY ? 'design saved' : `${laneFor(item)} pushed`) : (PLAN_ONLY ? 'no design' : 'no commits')}${stepNote}${r.limitHit ? ' (hit the usage limit)' : ''}`);
      if (r.limitHit) {
        // Graceful close: stop starting work, tell the human, and come back
        // when the allocation does. Partial branches are already pushed.
        // A plan night just ends — the resume job re-runs as a BUILD night,
        // which is not what was asked for; re-run --plan-only by hand.
        nightLimited = true;
        log('usage limit hit — closing the night gracefully.');
        if (!PLAN_ONLY) await scheduleResume(minutesUntilReset(r.resultText || ''));
        break;
      }
    } catch (e) {
      log(`#${item.id} failed (${e.message}) — releasing the lane and moving on.`);
      nightLines.push(`#${item.id} ${item.title}: failed (${e.message})`);
      try { await api('PATCH', `/api/projects/${SLUG}/roadmap/${item.id}`, { claimed_by: '' }); } catch { /* best effort */ }
      await postRun({ item_id: item.id, item_title: item.title, branch: laneFor(item),
        outcome: 'failed', summary: String(e.message || '').slice(0, 500) });
    }
  }

  // #325 — steps ticked (or, on a PLAN night, steps designed) is the real
  // measure of progress an item count can't give (a one-liner and a
  // ten-step rebuild both count as "1 item"); say "no plan steps" rather
  // than a bare 0 of 0 when nothing attempted had — or gained — one.
  const stepBudgetSpent = STEP_BUDGET === Infinity
    ? `${stepsSpent} step(s) charged (unlimited budget)`
    : `${stepsSpent} of ${STEP_BUDGET} step budget spent`;
  const stepsReport = PLAN_ONLY
    ? (stepsDesigned > 0
        ? `${stepsDesigned} step(s) designed, ${stepBudgetSpent}, `
        : `no plan steps on tonight's items, `)
    : (anyPlanned
        ? `${stepsTicked} step(s) ticked (${stepsRemaining} still open), ${stepBudgetSpent}, `
        : `no plan steps on tonight's items, `);
  const closing = `${landed} ${PLAN_ONLY ? 'design(s) awaiting review' : 'branch(es) awaiting the morning verdict'}, ${attempted.size} item(s) attempted, `
    + `${stepsReport}~${Math.round(tokensSpent / 1000)}k tokens${costSpent ? ` ($${costSpent.toFixed(2)})` : ''}, ${Math.round(elapsedMin())}m elapsed.`;
  log(`night over: ${closing}`);
  if (attempted.size > 0) {
    await notify(
      nightLimited ? `Stack autopilot (${SLUG}): paused on the usage limit` : `Stack autopilot (${SLUG}): night done`,
      `${nightLines.join('\n')}\n\n${closing}${nightLimited && !PLAN_ONLY ? '\nA resume is queued for after the reset — resume it early or hang it up in Mission Control.' : ''}`);
  }
} catch (err) {
  die(err.message);
}
