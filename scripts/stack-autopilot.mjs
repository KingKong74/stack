#!/usr/bin/env node
// Stack — the overnight autopilot (phase 1).
//
// One eligible roadmap item, one unattended Claude session, one reviewable
// branch. The human keeps final say: the autopilot NEVER touches main, never
// ticks the item done, never merges — it leaves a pushed `auto/item-N` branch,
// a Gemini second-model review in the review inbox, a checks run and a
// checkpoint on the activity feed, all waiting for the morning verdict.
//
// Flow: pick → claim the lane → worktree branch → `claude -p` (bounded) →
// checks run → Gemini diff review → keep or release the claim.
//
// The claim doubles as the "don't re-pick" marker: a successful run leaves
// `auto/item-N` claimed until the human merges and ticks the item done; a
// run that produced no commits releases it so the next night retries.
//
// The ARM SWITCH lives in the app: Settings → Autopilot. The cron line fires
// every night regardless; unless autopilotEnabled is on (or --force is given)
// the runner exits without doing anything. Unreachable settings = no run —
// the autopilot spends tokens and acts, so unlike the hooks it fails SAFE.
//
// Usage:
//   node scripts/stack-autopilot.mjs --project stack --repo /home/bailey/stack
//     [--minutes N]     wall-clock cap (default: Settings' autopilotMinutes)
//     [--dry]           print the picked item and exit (no claim, no session)
//     [--force]         run even while the Settings switch is off
//
// Env (~/.stack/env): STACK_API + STACK_TOKEN (required), GEMINI_API_KEY
// (optional — skips the second-model review when absent). Never printed.
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

const API = process.env.STACK_API;
const TOKEN = process.env.STACK_TOKEN;

function die(msg) { logStderr(`autopilot: ${msg}`); process.exit(1); }

if (!SLUG || !REPO) die('usage: stack-autopilot.mjs --project <slug> --repo <path> [--minutes N] [--dry]');
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

// ---- 0a. The in-app arm switch (Settings → Autopilot) ----
let appSettings;
try { appSettings = await api('GET', '/api/settings'); }
catch (e) { die(`could not read settings (${e.message}) — not running blind.`); }
if (!appSettings.autopilotEnabled && !FORCE) {
  log('autopilot is switched OFF in Settings — nothing run. (--force overrides for a manual test.)');
  process.exit(0);
}
const MINUTES = Math.max(15, parseInt(MINUTES_ARG ?? '', 10) || appSettings.autopilotMinutes || 120);

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

try {
  // ---- 1. Pick the next eligible item: must before should; open, unclaimed,
  //         not parked, and human-approved (manual, or hook-created + reviewed).
  const detail = await api('GET', `/api/projects/${SLUG}`);
  const eligible = (it) => !it.done && !it.skipped && !it.claimedBy && (it.source === 'manual' || it.reviewed);
  const item = [...(detail.roadmap?.must || []), ...(detail.roadmap?.should || [])].find(eligible);
  if (!item) { log(`no eligible must/should item on ${SLUG} — nothing to do tonight.`); process.exit(0); }

  const lane = `auto/item-${item.id}`;
  log(`picked #${item.id} [${item.bucket}] ${item.title}`);
  if (DRY) { log(`dry run — would claim ${lane} and start a ${MINUTES}m session.`); process.exit(0); }

  // ---- 2. Claim the lane (visible on the deck's lanes strip immediately) ----
  await api('PATCH', `/api/projects/${SLUG}/roadmap/${item.id}`, { claimed_by: lane });
  log(`claimed lane ${lane}`);

  // ---- 3. A fresh worktree so the human's checkout is never disturbed ----
  const branch = lane;
  const wt = join(lockDir, 'autopilot', `${SLUG}-item-${item.id}`);
  git(REPO, ['worktree', 'remove', '--force', wt]); // clear a previous attempt's tree
  git(REPO, ['branch', '-D', branch]);              // (branch survives on origin if pushed)
  mkdirSync(join(lockDir, 'autopilot'), { recursive: true });
  const added = git(REPO, ['worktree', 'add', wt, '-b', branch]);
  if (!existsSync(join(wt, '.git'))) die(`worktree add failed (${added || 'no output'})`);
  log(`worktree ready at ${wt} on ${branch}`);

  // ---- 4. The unattended session ----
  const prompt = `You are Stack's overnight autopilot, working unattended in a dedicated git worktree on branch ${branch}.

Your single task tonight is roadmap item #${item.id} (bucket: ${item.bucket}):

  ${item.title}
${item.note ? `  Context: ${item.note}\n` : ''}
Rules for this run:
- Work ONLY on this item; do not pick up other roadmap items or ideas.
- Commit in small complete units with clear messages. Push the branch with \`git push -u origin ${branch}\`. NEVER push or merge main — a human reviews and merges in the morning.
- Verify before finishing: run the project's build/typecheck (and tests where they exist) and fix what you broke.
- Do NOT mark the roadmap item done — that is the human's call after review.
- When you finish (or must stop), author a rich checkpoint: compose the checkpoint JSON described in ~/.claude/commands/checkpoint.md (summary, current_phase, in_progress, next_up, blockers, tags, extract) and pipe it to \`node ~/.stack/stack-checkpoint.mjs\`. Mention the branch name in the summary.
- If the item proves impossible or unsafe to do unattended, stop early: leave the tree clean, and say why in the checkpoint summary and blockers.`;

  log(`starting claude session (cap ${MINUTES}m)…`);
  const run = spawnSync('claude', ['-p', prompt, '--dangerously-skip-permissions'], {
    cwd: wt,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: MINUTES * 60_000,
    killSignal: 'SIGTERM',
  });
  if (run.error) log(`claude session ended with error: ${run.error.message}`);
  log(`claude session finished (status ${run.status ?? 'killed at cap'})`);

  // ---- 5. What did it produce? ----
  const nCommits = parseInt(git(wt, ['rev-list', '--count', 'main..HEAD']) || '0', 10) || 0;

  if (nCommits === 0) {
    // Nothing landed — release the claim so tomorrow retries, tidy the tree.
    await api('PATCH', `/api/projects/${SLUG}/roadmap/${item.id}`, { claimed_by: '' });
    git(REPO, ['worktree', 'remove', '--force', wt]);
    git(REPO, ['branch', '-D', branch]);
    log(`no commits produced — lane released, worktree removed. Check the checkpoint/blockers for why.`);
    process.exit(0);
  }

  // Belt-and-braces: make sure the branch is on origin even if the session forgot.
  git(wt, ['push', '-u', 'origin', branch]);
  log(`${nCommits} commit(s) on ${branch}, pushed to origin — claim stays until you merge + tick the item.`);

  // ---- 6. Checks run (bounded server-side; failures are morning reading) ----
  try {
    const checks = await api('POST', `/api/projects/${SLUG}/checks/run`, {});
    const rows = Array.isArray(checks) ? checks : (checks.checks || []);
    const failing = rows.filter((c) => c.lastStatus === 'fail').length;
    log(`checks run: ${rows.length} total, ${failing} failing.`);
  } catch (e) { log(`checks run skipped (${e.message})`); }

  // ---- 7. Gemini second-model review of the branch diff → review inbox ----
  if (process.env.GEMINI_API_KEY) {
    const review = spawnSync('node', [join(REPO, 'hook', 'stack-gemini-review.mjs'), '--range', 'main..HEAD'], {
      cwd: wt, stdio: ['ignore', 'inherit', 'inherit'], timeout: 120_000,
    });
    log(review.status === 0 ? 'gemini review posted to the inbox.' : 'gemini review did not post (see above).');
  } else {
    log('GEMINI_API_KEY not set — skipping the second-model review.');
  }

  log(`done. Morning review: merge ${branch} if you like it, tick #${item.id}, and the lane clears.`);
} catch (err) {
  die(err.message);
}
