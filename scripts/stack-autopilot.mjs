#!/usr/bin/env node
// Stack — the overnight autopilot (phase 2).
//
// Multiple eligible roadmap items per night, each on its own reviewable
// branch, inside a shared night budget: a wall-clock cap (Settings'
// autopilotMinutes) AND a token budget metered from each session's real
// usage (`claude -p --output-format json`). Before each session a Gemini
// spec pre-pass (free tier) expands the item's title/note into a small spec —
// goal, acceptance criteria, out-of-scope — so the unattended session builds
// to a target instead of a title. No key = the pre-pass silently skips.
//
// The human keeps final say: the autopilot NEVER touches main, never ticks an
// item done, never merges — each item leaves a pushed `auto/item-N` branch, a
// Gemini second-model review in the review inbox, a checks run, a checkpoint
// on the activity feed, and a `built_note` stamped on the item (so the
// Reviews view shows what landed when the human ticks it).
//
// Per item: pick → claim the lane → spec pre-pass → worktree branch →
// `claude -p` (bounded) → push → built_note → checks → Gemini diff review →
// keep or release the claim. Then the next item, while budget remains.
//
// The claim doubles as the "don't re-pick" marker: a successful run leaves
// `auto/item-N` claimed until the human merges and ticks the item done; a
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
//     [--item N]        work exactly this roadmap item and stop (scheduled/manual runs)
//     [--dry]           print what tonight would pick and exit (no claim, no session)
//     [--force]         run even while the Settings switch / automode is off
//
// Env (~/.stack/env): STACK_API + STACK_TOKEN (required), GEMINI_API_KEY
// (optional — skips the spec pre-pass + second-model review when absent).
// Never printed.
//
// Normally invoked by scripts/stack-autopilot-dispatch.mjs (the every-minute
// cron line), which polls the app's job queue — the nightly time, manual
// Run-now presses and the Mission Control calendar all arrive that way.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadStackEnv, logStderr, git } from '../hook/stack-post.mjs';

loadStackEnv();

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const SLUG = arg('project');
const REPO = arg('repo');
const MINUTES_ARG = arg('minutes');
// null = no override; 0 is a real value (unlimited), so no || chains here.
const intArg = (v) => { const n = parseInt(v ?? '', 10); return Number.isFinite(n) ? n : null; };
const TOKENS_OVERRIDE = intArg(arg('tokens')) ?? intArg(process.env.STACK_AUTOPILOT_TOKENS);
const MAX_ITEMS_ARG = intArg(arg('max-items'));
const ITEM_ID = intArg(arg('item'));
const MIN_SESSION_MIN = 15; // not worth starting a session with less than this

const API = process.env.STACK_API;
const TOKEN = process.env.STACK_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

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
  try { await api('POST', `/api/projects/${SLUG}/autopilot/runs`, payload); }
  catch (e) { log(`run record skipped (${e.message})`); }
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
// automode still gate it, and the lockfile keeps overlap impossible.
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
function scheduleResume(minutes) {
  const cmd = `sleep ${minutes * 60} && ${process.execPath} ${process.argv[1]} --project ${SLUG} --repo ${REPO}`;
  spawn('bash', ['-c', cmd], { detached: true, stdio: 'ignore' }).unref();
  log(`resume scheduled in ~${Math.round(minutes / 60 * 10) / 10}h (detached; the arm switch still gates it).`);
}

// One bounded Gemini JSON call — the spec pre-pass. Absent key / any failure
// returns null and the night simply runs spec-less (phase 1 behaviour).
async function geminiSpec(item, northStar) {
  if (!GEMINI_KEY) return null;
  const prompt = `You are the planning pre-pass for an UNATTENDED overnight coding session on a solo
side project. Turn this roadmap item into a tight build spec the session can verify itself
against. Be concrete and conservative — unattended means no one to ask.
${northStar ? `\nThe project's north star: "${northStar.slice(0, 500)}"\n` : ''}
Roadmap item #${item.id} (${item.bucket}): ${item.title}
${item.note ? `The author's note (what they actually want): ${item.note.slice(0, 1200)}` : '(no note)'}

Respond with ONLY this JSON:
{ "goal": "one sentence — the outcome",
  "acceptance": ["3-6 verifiable criteria, each checkable from the terminal"],
  "outOfScope": ["what NOT to touch tonight"],
  "risks": ["traps to avoid — max 3"] }`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
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
const MAX_ITEMS = ITEM_ID != null ? 1 : Math.max(1, MAX_ITEMS_ARG ?? (appSettings.autopilotMaxItems || 3));
const nightStart = Date.now();
const elapsedMin = () => (Date.now() - nightStart) / 60_000;
const remainingMin = () => MINUTES - elapsedMin();

// ---- 0b. One run at a time (a crashed run's stale lock is cleared by age) ----
const lockDir = join(homedir(), '.stack');
const lock = join(lockDir, 'autopilot.lock');
mkdirSync(lockDir, { recursive: true });
if (existsSync(lock)) {
  const { statSync } = await import('node:fs');
  const ageMin = (Date.now() - statSync(lock).mtimeMs) / 60_000;
  if (ageMin < MINUTES + 30) die(`another run appears live (lock ${Math.round(ageMin)}m old) — bailing.`);
  log(`clearing stale lock (${Math.round(ageMin)}m old)`);
}
writeFileSync(lock, `${process.pid} ${stamp()}\n`);
const unlock = () => { try { rmSync(lock); } catch { /* gone is fine */ } };
process.on('exit', unlock);

// Eligibility: open, unclaimed, not parked, human-approved — and inside the
// project's target area when one is set (Mission Control's #122 picker).
// --item pins bypass the area filter: an explicit human choice wins.
const eligible = (targetArea) => (it) =>
  !it.done && !it.skipped && !it.claimedBy && (it.source === 'manual' || it.reviewed)
  && (!targetArea || (it.area || '') === targetArea);
let tokensSpent = 0;
let costSpent = 0;

// ---- one item, one branch, one bounded session ----
async function runItem(item, northStar, capMin) {
  const lane = `auto/item-${item.id}`;
  const branch = lane;
  const startedAt = new Date().toISOString();
  log(`picked #${item.id} [${item.bucket}] ${item.title} (cap ${Math.round(capMin)}m)`);

  // Claim the lane (visible on the deck's lanes strip immediately).
  await api('PATCH', `/api/projects/${SLUG}/roadmap/${item.id}`, { claimed_by: lane });

  // The spec pre-pass — Gemini plans, the session builds, the human disposes.
  const spec = await geminiSpec(item, northStar);
  if (spec) log(`spec ready: ${spec.goal}`);

  // A fresh worktree so the human's checkout is never disturbed.
  const wt = join(lockDir, 'autopilot', `${SLUG}-item-${item.id}`);
  git(REPO, ['worktree', 'remove', '--force', wt]); // clear a previous attempt's tree
  git(REPO, ['branch', '-D', branch]);              // (branch survives on origin if pushed)
  mkdirSync(join(lockDir, 'autopilot'), { recursive: true });
  const added = git(REPO, ['worktree', 'add', wt, '-b', branch]);
  if (!existsSync(join(wt, '.git'))) throw new Error(`worktree add failed (${added || 'no output'})`);

  const prompt = `You are Stack's overnight autopilot, working unattended in a dedicated git worktree on branch ${branch}.

Your single task tonight is roadmap item #${item.id} (bucket: ${item.bucket}):

  ${item.title}
${item.note ? `  Context: ${item.note}\n` : ''}${specBlock(spec)}
Rules for this run:
- Work ONLY on this item; do not pick up other roadmap items or ideas.
- Commit in small complete units with clear messages. Push the branch with \`git push -u origin ${branch}\`. NEVER push or merge main — a human reviews and merges in the morning.
- Verify before finishing: run the project's build/typecheck (and tests where they exist) and fix what you broke.
- Do NOT mark the roadmap item done — that is the human's call after review.
- When you finish (or must stop), author a rich checkpoint: compose the checkpoint JSON described in ~/.claude/commands/checkpoint.md (summary, current_phase, in_progress, next_up, blockers, tags, extract) and pipe it to \`node ~/.stack/stack-checkpoint.mjs\`. Mention the branch name in the summary.
- If the item proves impossible or unsafe to do unattended, stop early: leave the tree clean, and say why in the checkpoint summary and blockers.`;

  // Bounded session; JSON output so real token usage lands in the night ledger.
  log(`starting claude session…`);
  const run = spawnSync('claude', ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'json'], {
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
  } catch {
    log(`session finished (status ${run.status ?? 'killed at cap'}) — usage unreadable, wall clock still governs.`);
  }
  // The graceful close: a session that died on the usage limit is not a
  // failure of the item — flag it so the night stops and resumes itself.
  const limitHit = LIMIT_RE.test(resultText);
  const runRecord = {
    item_id: item.id, item_title: item.title, branch,
    tokens: usedTokens, cost_usd: usedCost, started_at: startedAt,
  };

  // What did it produce?
  const nCommits = parseInt(git(wt, ['rev-list', '--count', 'main..HEAD']) || '0', 10) || 0;
  if (nCommits === 0) {
    // Nothing landed — release the claim so tomorrow (or the scheduled
    // resume) retries, tidy the tree.
    await api('PATCH', `/api/projects/${SLUG}/roadmap/${item.id}`, { claimed_by: '' });
    git(REPO, ['worktree', 'remove', '--force', wt]);
    git(REPO, ['branch', '-D', branch]);
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
  try {
    const checks = await api('POST', `/api/projects/${SLUG}/checks/run`, {});
    const rows = Array.isArray(checks) ? checks : (checks.checks || []);
    checksFailing = rows.filter((c) => c.lastStatus === 'fail').length;
    log(`checks run: ${rows.length} total, ${checksFailing} failing.`);
  } catch (e) { log(`checks run skipped (${e.message})`); }

  await postRun({ ...runRecord, outcome: limitHit ? 'limit' : 'landed', commits: nCommits,
    checks_failing: checksFailing,
    summary: (resultText || `${nCommits} commit(s) on ${branch}.`).slice(0, 1800) });

  // Gemini second-model review of the branch diff → review inbox.
  if (GEMINI_KEY) {
    const review = spawnSync('node', [join(REPO, 'hook', 'stack-gemini-review.mjs'), '--range', 'main..HEAD'], {
      cwd: wt, stdio: ['ignore', 'inherit', 'inherit'], timeout: 120_000,
    });
    log(review.status === 0 ? 'gemini review posted to the inbox.' : 'gemini review did not post (see above).');
  }
  return { landed: true, limitHit, resultText };
}

// ---- the night loop: items until a budget runs dry ----
try {
  const attempted = new Set();
  const nightLines = [];
  let landed = 0;
  let nightLimited = false;
  log(`night budget: ${MINUTES}m wall clock, `
    + `${TOKEN_BUDGET === Infinity ? 'UNLIMITED tokens' : `${Math.round(TOKEN_BUDGET / 1000)}k tokens`}, `
    + `up to ${MAX_ITEMS} item(s)${ITEM_ID != null ? ` (pinned to #${ITEM_ID})` : ''}.`);

  for (let n = 0; n < MAX_ITEMS; n++) {
    if (remainingMin() < MIN_SESSION_MIN) { log(`wall clock nearly spent (${Math.round(remainingMin())}m left) — stopping.`); break; }
    if (tokensSpent >= TOKEN_BUDGET) { log(`token budget spent (~${Math.round(tokensSpent / 1000)}k) — stopping.`); break; }

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
    } else {
      const targetArea = detail.autopilotArea || '';
      item = [...(detail.roadmap?.must || []), ...(detail.roadmap?.should || [])]
        .filter((it) => !attempted.has(it.id))
        .find(eligible(targetArea));
      if (!item && targetArea && n === 0) log(`(target area "${targetArea}" — items outside it are ignored)`);
    }
    if (!item) { log(n === 0 ? `no eligible must/should item on ${SLUG} — nothing to do tonight.` : 'no more eligible items — night complete.'); break; }

    if (DRY) {
      log(`dry run — would claim auto/item-${item.id} for "${item.title}" (then keep going while budget lasts).`);
      process.exit(0);
    }

    attempted.add(item.id);
    try {
      const r = await runItem(item, detail.northStar || '', remainingMin());
      if (r.landed) landed++;
      nightLines.push(`#${item.id} ${item.title}: ${r.landed ? `auto/item-${item.id} pushed` : 'no commits'}${r.limitHit ? ' (hit the usage limit)' : ''}`);
      if (r.limitHit) {
        // Graceful close: stop starting work, tell the human, and come back
        // when the allocation does. Partial branches are already pushed.
        nightLimited = true;
        log('usage limit hit — closing the night gracefully.');
        scheduleResume(minutesUntilReset(r.resultText || ''));
        break;
      }
    } catch (e) {
      log(`#${item.id} failed (${e.message}) — releasing the lane and moving on.`);
      nightLines.push(`#${item.id} ${item.title}: failed (${e.message})`);
      try { await api('PATCH', `/api/projects/${SLUG}/roadmap/${item.id}`, { claimed_by: '' }); } catch { /* best effort */ }
      await postRun({ item_id: item.id, item_title: item.title, branch: `auto/item-${item.id}`,
        outcome: 'failed', summary: String(e.message || '').slice(0, 500) });
    }
  }

  const closing = `${landed} branch(es) awaiting the morning verdict, ${attempted.size} item(s) attempted, `
    + `~${Math.round(tokensSpent / 1000)}k tokens${costSpent ? ` ($${costSpent.toFixed(2)})` : ''}, ${Math.round(elapsedMin())}m elapsed.`;
  log(`night over: ${closing}`);
  if (attempted.size > 0) {
    await notify(
      nightLimited ? `Stack autopilot (${SLUG}): paused on the usage limit` : `Stack autopilot (${SLUG}): night done`,
      `${nightLines.join('\n')}\n\n${closing}${nightLimited ? '\nA resume is scheduled for after the reset.' : ''}`);
  }
} catch (err) {
  die(err.message);
}
