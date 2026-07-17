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
//     [--tokens N]      the night's token budget (default: env STACK_AUTOPILOT_TOKENS or 1500000)
//     [--max-items N]   most items attempted per night (default 3)
//     [--dry]           print what tonight would pick and exit (no claim, no session)
//     [--force]         run even while the Settings switch / automode is off
//
// Env (~/.stack/env): STACK_API + STACK_TOKEN (required), GEMINI_API_KEY
// (optional — skips the spec pre-pass + second-model review when absent).
// Never printed.
//
// Cron (the schedule IS the on/off switch — remove the line to disable):
//   5 23 * * * /usr/bin/node /home/bailey/stack/scripts/stack-autopilot.mjs \
//     --project stack --repo /home/bailey/stack >> ~/.stack/autopilot.log 2>&1

import { spawnSync } from 'node:child_process';
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
const TOKEN_BUDGET = Math.max(50_000,
  parseInt(arg('tokens') ?? '', 10) || parseInt(process.env.STACK_AUTOPILOT_TOKENS ?? '', 10) || 1_500_000);
const MAX_ITEMS = Math.max(1, parseInt(arg('max-items') ?? '', 10) || 3);
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

const eligible = (it) => !it.done && !it.skipped && !it.claimedBy && (it.source === 'manual' || it.reviewed);
let tokensSpent = 0;
let costSpent = 0;

// ---- one item, one branch, one bounded session ----
async function runItem(item, northStar, capMin) {
  const lane = `auto/item-${item.id}`;
  const branch = lane;
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
  try {
    const out = JSON.parse(run.stdout || '{}');
    const u = out.usage || {};
    const used = (u.input_tokens || 0) + (u.output_tokens || 0)
      + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    tokensSpent += used;
    costSpent += out.total_cost_usd || 0;
    resultText = String(out.result || '').trim();
    log(`session finished: ${out.num_turns ?? '?'} turns, ~${Math.round(used / 1000)}k tokens`
      + (out.total_cost_usd ? ` ($${out.total_cost_usd.toFixed(2)})` : ''));
  } catch {
    log(`session finished (status ${run.status ?? 'killed at cap'}) — usage unreadable, wall clock still governs.`);
  }

  // What did it produce?
  const nCommits = parseInt(git(wt, ['rev-list', '--count', 'main..HEAD']) || '0', 10) || 0;
  if (nCommits === 0) {
    // Nothing landed — release the claim so tomorrow retries, tidy the tree.
    await api('PATCH', `/api/projects/${SLUG}/roadmap/${item.id}`, { claimed_by: '' });
    git(REPO, ['worktree', 'remove', '--force', wt]);
    git(REPO, ['branch', '-D', branch]);
    log(`#${item.id}: no commits — lane released, worktree removed. Check the checkpoint/blockers for why.`);
    return false;
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
  try {
    const checks = await api('POST', `/api/projects/${SLUG}/checks/run`, {});
    const rows = Array.isArray(checks) ? checks : (checks.checks || []);
    const failing = rows.filter((c) => c.lastStatus === 'fail').length;
    log(`checks run: ${rows.length} total, ${failing} failing.`);
  } catch (e) { log(`checks run skipped (${e.message})`); }

  // Gemini second-model review of the branch diff → review inbox.
  if (GEMINI_KEY) {
    const review = spawnSync('node', [join(REPO, 'hook', 'stack-gemini-review.mjs'), '--range', 'main..HEAD'], {
      cwd: wt, stdio: ['ignore', 'inherit', 'inherit'], timeout: 120_000,
    });
    log(review.status === 0 ? 'gemini review posted to the inbox.' : 'gemini review did not post (see above).');
  }
  return true;
}

// ---- the night loop: items until a budget runs dry ----
try {
  const attempted = new Set();
  let landed = 0;
  log(`night budget: ${MINUTES}m wall clock, ${Math.round(TOKEN_BUDGET / 1000)}k tokens, up to ${MAX_ITEMS} item(s).`);

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
    const item = [...(detail.roadmap?.must || []), ...(detail.roadmap?.should || [])]
      .filter((it) => !attempted.has(it.id))
      .find(eligible);
    if (!item) { log(n === 0 ? `no eligible must/should item on ${SLUG} — nothing to do tonight.` : 'no more eligible items — night complete.'); break; }

    if (DRY) {
      log(`dry run — would claim auto/item-${item.id} for "${item.title}" (then keep going while budget lasts).`);
      process.exit(0);
    }

    attempted.add(item.id);
    try {
      if (await runItem(item, detail.northStar || '', remainingMin())) landed++;
    } catch (e) {
      log(`#${item.id} failed (${e.message}) — releasing the lane and moving on.`);
      try { await api('PATCH', `/api/projects/${SLUG}/roadmap/${item.id}`, { claimed_by: '' }); } catch { /* best effort */ }
    }
  }

  log(`night over: ${landed} branch(es) awaiting the morning verdict, ${attempted.size} item(s) attempted, `
    + `~${Math.round(tokensSpent / 1000)}k tokens${costSpent ? ` ($${costSpent.toFixed(2)})` : ''}, ${Math.round(elapsedMin())}m elapsed.`);
} catch (err) {
  die(err.message);
}
