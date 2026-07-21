#!/usr/bin/env node
// Stack — the autopilot dispatcher. The every-minute cron line.
//
// The server can't reach the host (the firewall drops container→host), so this
// tiny script dials OUT — same pattern as the terminal daemon: it polls
// GET /api/autopilot/next with the HOST's local clock, and the server decides
// what (if anything) has come due — the armed nightly per automode project,
// a Mission Control calendar row, or a manual Run-now press. At most one job
// comes back; the dispatcher runs it to completion and reports the outcome.
//
// Quiet by design: nothing due (or an unreachable API — fail SAFE) exits
// silently, so the shared autopilot.log stays readable. It only speaks when it
// actually dispatches.
//
// Repos are resolved as $STACK_AUTOPILOT_ROOT/<slug> (default: the home dir),
// matching the terminal's jail convention. No repo at that path = the job
// fails with a note, visible in Mission Control's job strip.
//
// Cron (this line is the master on/off switch — remove it to disable):
//   * * * * * /usr/bin/node /home/bailey/stack/scripts/stack-autopilot-dispatch.mjs \
//     >> ~/.stack/autopilot.log 2>&1
//
// Overlap is safe three ways: the server hands out one job at a time, the
// next minute's poll sees it "running" and gets nothing, and the runner's own
// lockfile refuses a second night.

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStackEnv, logStderr } from '../hook/stack-post.mjs';

loadStackEnv();
const API = (process.env.STACK_API || '').replace(/\/$/, '');
const TOKEN = process.env.STACK_TOKEN;
if (!API || !TOKEN) process.exit(0); // unconfigured host = never acts (and never spams the log)

async function api(method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const p2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const local = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}T${p2(now.getHours())}:${p2(now.getMinutes())}`;

let job = null;
try {
  ({ job } = await api('GET', `/api/autopilot/next?local=${local}&dow=${now.getDay()}`));
} catch {
  process.exit(0); // unreachable API = no run, silently (fail safe)
}

const root = process.env.STACK_AUTOPILOT_ROOT || homedir();

// Branch report (#207) — every ~10 minutes, push each repo's git branch state
// up to the server: every origin branch with ahead/behind counts vs
// origin/main, a merge-tree conflict probe (git ≥2.38 — exit 0 clean, 1
// conflicts; anything else = null, unprobed) and the item id parsed from the
// lane name. Mission Control's merge strip renders it. Quiet by design: the
// stamp file is written up front so a wedged repo can't make every minute's
// poll retry, and any failure just waits for the next cycle.
async function reportBranches() {
  const gitq = (dir, ...a) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', timeout: 60_000 });
    return { ok: r.status === 0, status: r.status, out: (r.stdout || '').trim() };
  };
  const projects = await api('GET', '/api/projects');
  for (const p of Array.isArray(projects) ? projects : []) {
    const dir = join(root, p.slug);
    if (!existsSync(join(dir, '.git'))) continue;
    gitq(dir, 'fetch', 'origin', '--prune', '--quiet'); // best effort — stale refs still report
    if (!gitq(dir, 'rev-parse', '--verify', 'origin/main').ok) continue;
    const refs = gitq(dir, 'for-each-ref', 'refs/remotes/origin', '--sort=-committerdate',
      '--format=%(refname:short)\t%(committerdate:iso8601-strict)\t%(contents:subject)');
    if (!refs.ok) continue;
    const list = [];
    for (const line of refs.out.split('\n').filter(Boolean)) {
      const [ref, committedAt, ...rest] = line.split('\t');
      const branch = ref.replace(/^origin\//, '');
      if (!branch || branch === 'origin' || branch === 'HEAD' || branch === 'main') continue;
      const counts = gitq(dir, 'rev-list', '--left-right', '--count', `origin/main...${ref}`);
      if (!counts.ok) continue;
      const [behind, ahead] = counts.out.split(/\s+/).map((n) => parseInt(n, 10) || 0);
      let mergeClean = null;
      if (ahead > 0) {
        const probe = gitq(dir, 'merge-tree', '--write-tree', 'origin/main', ref);
        if (probe.status === 0) mergeClean = true;
        else if (probe.status === 1) mergeClean = false;
      }
      const item = /(?:^|\/)item-(\d+)/.exec(branch);
      list.push({ branch, ahead, behind, mergeClean, subject: rest.join('\t'),
        committedAt, itemId: item ? Number(item[1]) : null });
      if (list.length >= 50) break;
    }
    await api('POST', `/api/projects/${p.slug}/branches`, { branches: list });
  }
}

const REPORT_EVERY_MS = 10 * 60 * 1000;
const reportStamp = join(homedir(), '.stack', 'branch-report.stamp');
const reportDue = (() => {
  try { return Date.now() - statSync(reportStamp).mtimeMs > REPORT_EVERY_MS; } catch { return true; }
})();
if (reportDue) {
  try { writeFileSync(reportStamp, new Date().toISOString()); } catch { /* best effort */ }
  try { await reportBranches(); } catch { /* next cycle retries */ }
}

if (!job) process.exit(0);

const log = (msg) => logStderr(`dispatch ${new Date().toISOString()} · ${msg}`);
const report = (status, detail) =>
  api('PATCH', `/api/autopilot/jobs/${job.id}`, detail === undefined ? { status } : { status, detail })
    .catch((e) => log(`[report] job #${job.id} status=${status} — PATCH failed (${e.message})`));

const repo = join(root, job.slug);
log(`job #${job.id}: ${job.kind} run on ${job.slug}${job.itemId ? ` (item #${job.itemId})` : ''}`);
if (!existsSync(join(repo, '.git'))) {
  log(`no repo at ${repo} — job failed.`);
  await report('failed', `no repo at ${repo}`);
  process.exit(0);
}

// A merge job (#154 — Mission Control's ⇥ Merge button) is handled right here,
// not by the runner: fetch, merge --no-ff origin/<branch> into main in a
// throwaway worktree, push main, delete the remote lane branch on success.
// Conflicts abort safely and report `failed`; the human resolves by hand.
// The itemId is carried as advisory metadata only — the dispatcher does NOT
// tick the roadmap item (the human disposes after reviewing what landed).
if (job.kind === 'merge') {
  const git = (dir, ...a) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  };
  const doMerge = async () => {
    // Extract the branch name from the pre-stored detail string
    // ("merge origin/<branch> into main (item #N)") or fall back to itemTitle.
    // But the branch was stored in detail as "merge origin/<branch> into main…"
    // We also look at the job's stored detail to pull the branch out of it.
    const detailMatch = /merge origin\/(\S+) into main/.exec(job.detail || '');
    const branch = detailMatch ? detailMatch[1] : '';
    if (!branch) return { ok: false, detail: `[merge/job #${job.id}] could not determine branch from job detail: ${job.detail}` };

    git(repo, 'fetch', 'origin');
    const refCheck = git(repo, 'rev-parse', '--verify', `origin/${branch}`);
    if (!refCheck.ok) return { ok: false, detail: `[merge/job #${job.id}] origin/${branch} not found — already merged or deleted?` };

    const wt = join(tmpdir(), `stack-merge-${job.id}-${Date.now()}`);
    const base = git(repo, 'rev-parse', '--verify', 'origin/main').ok ? 'origin/main' : 'main';
    const add = git(repo, 'worktree', 'add', '--detach', wt, base);
    if (!add.ok) return { ok: false, detail: `[merge/job #${job.id}] worktree add failed: ${add.err.slice(0, 180)}` };
    try {
      const merge = git(wt, 'merge', '--no-ff', `origin/${branch}`,
        '-m', `Merge ${branch} into main #154`);
      if (!merge.ok) {
        git(wt, 'merge', '--abort');
        return { ok: false, detail: `[merge/job #${job.id}] conflicts merging origin/${branch} into main — merge by hand` };
      }
      const push = git(wt, 'push', 'origin', 'HEAD:main');
      if (!push.ok) return { ok: false, detail: `[merge/job #${job.id}] push to origin/main failed: ${push.err.slice(0, 150)}` };
      // Delete the remote lane branch on success.
      git(repo, 'push', 'origin', '--delete', branch); // best effort — don't fail if it's already gone
    } finally {
      git(repo, 'worktree', 'remove', '--force', wt);
      rmSync(wt, { recursive: true, force: true });
    }
    const itemNote = job.itemId ? ` — tick #${job.itemId} in the roadmap when you've verified it` : '';
    return { ok: true, detail: `merged origin/${branch} into main${itemNote}` };
  };
  await report('running');
  const out = await doMerge();
  await report(out.ok ? 'done' : 'failed', out.detail);
  log(`job #${job.id}: ${out.ok ? 'done' : 'failed'} — ${out.detail}.`);
  process.exit(0);
}

// A revert job (#128 — the Reviews view's ⎌ Undo) is handled right here, not
// by the runner: revert every main commit tagged #<itemId> in a throwaway
// worktree, push, and un-tick the item so it lands back on the board. The
// human asked for it explicitly, so no arm-switch / automode gate applies.
if (job.kind === 'revert') {
  const git = (dir, ...a) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  };
  const revert = async () => {
    const id = String(job.itemId || '');
    if (!id) return { ok: false, detail: `[revert/job #${job.id}] no item id on revert job` };
    git(repo, 'fetch', 'origin', 'main'); // best effort — fall back to local main below
    const base = git(repo, 'rev-parse', '--verify', 'origin/main').ok ? 'origin/main' : 'main';
    const hist = git(repo, 'log', base, '-n', '400', '--format=%H\t%s');
    if (!hist.ok) return { ok: false, detail: `[revert/job #${job.id}] git log on ${base} failed` };
    const tag = new RegExp(`(^|[^0-9])#${id}([^0-9]|$)`);
    const hashes = hist.out.split('\n').filter(Boolean)
      .map((l) => { const [h, ...s] = l.split('\t'); return { h, s: s.join('\t') }; })
      .filter((c) => tag.test(c.s))
      .map((c) => c.h); // newest first — the order git revert wants
    if (!hashes.length) return { ok: false, detail: `[revert/job #${job.id}] no commits tagged #${id} in the last 400 on ${base}` };
    const wt = join(tmpdir(), `stack-undo-${job.id}-${Date.now()}`);
    const add = git(repo, 'worktree', 'add', '--detach', wt, base);
    if (!add.ok) return { ok: false, detail: `[revert/job #${job.id}] worktree add failed: ${add.err.slice(0, 180)}` };
    try {
      const rev = git(wt, 'revert', '--no-edit', ...hashes);
      if (!rev.ok) {
        git(wt, 'revert', '--abort');
        return { ok: false, detail: `[revert/job #${job.id}] revert of ${hashes.length} commit(s) tagged #${id} conflicted — undo by hand` };
      }
      const push = git(wt, 'push', 'origin', 'HEAD:main');
      if (!push.ok) return { ok: false, detail: `[revert/job #${job.id}] push to origin/main failed (HTTP ${push.err.match(/\d{3}/)?.[0] ?? 'unknown'}): ${push.err.slice(0, 150)}` };
    } finally {
      git(repo, 'worktree', 'remove', '--force', wt);
      rmSync(wt, { recursive: true, force: true });
    }
    // Back to the board: done:false clears the verdict + claim (#116 semantics).
    try {
      await api('PATCH', `/api/projects/${job.slug}/roadmap/${id}`, { done: false });
    } catch (e) {
      return { ok: true, detail: `[revert/job #${job.id}] reverted ${hashes.length} commit(s) tagged #${id}, but un-ticking failed (${e.message}) — untick it in the app` };
    }
    return { ok: true, detail: `reverted ${hashes.length} commit(s) tagged #${id} on main` };
  };
  await report('running');
  const out = await revert();
  await report(out.ok ? 'done' : 'failed', out.detail);
  log(`job #${job.id}: ${out.ok ? 'done' : 'failed'} — ${out.detail}.`);
  process.exit(0);
}

await report('running');
const runner = join(dirname(fileURLToPath(import.meta.url)), 'stack-autopilot.mjs');
const args = ['--project', job.slug, '--repo', repo];
if (job.itemId) args.push('--item', String(job.itemId));
// A manual press or a calendar row is explicit human config — it runs even
// while the arm switch / automode are off. The nightly keeps both gates, and
// so does a limit-resume that fired on its own clock (#142 — notBefore still
// set); a resume whose hold a human cleared (▶ Resume now) is a manual press.
const autoResume = job.kind === 'resume' && job.notBefore;
if (job.kind !== 'nightly' && !autoResume) args.push('--force');

// Run the autopilot inside a named tmux session (#171) so the web terminal can
// attach for live monitoring while the run is active. The session name is passed
// to the runner via STACK_TMUX_SESSION so it can record it in autopilot_runs.
// Falls back to the direct spawnSync path when tmux is not installed on the host.
const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const safeName = job.slug.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 30);
const tmuxName = `stack-auto-${safeName}-j${job.id}`;
const logFile = join(homedir(), '.stack', 'autopilot.log');
let ok = false;
let usedTmux = false;

if (hasTmux) {
  const tmpBase = join(tmpdir(), tmuxName);
  const wrapperFile = `${tmpBase}.sh`;
  const exitFile = `${tmpBase}.exit`;
  // Shell-quote helper (single-quote wrapping, apostrophe escaped).
  const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  // Wrapper: login shell (bash -l in the tmux invocation, not just the shebang —
  // shebang -l is ignored when running `bash script.sh`) so node/claude resolve
  // via the user's profile. Tee so output appears in the tmux pane for live
  // monitoring AND still lands in the autopilot log. PIPESTATUS captures the
  // runner's exit code through the pipe.
  const nodeCmd = [process.execPath, runner, ...args].map(shq).join(' ');
  writeFileSync(wrapperFile, `#!/bin/bash
export STACK_TMUX_SESSION=${shq(tmuxName)}
${nodeCmd} 2>&1 | tee -a ${shq(logFile)}
echo \${PIPESTATUS[0]} > ${shq(exitFile)}
`, { mode: 0o755 });
  const tmuxStart = spawnSync('tmux', ['new-session', '-d', '-s', tmuxName, `bash -l ${shq(wrapperFile)}`], {
    stdio: 'ignore',
  });
  if (tmuxStart.status === 0) {
    usedTmux = true;
    log(`job #${job.id}: tmux session ${tmuxName} started for monitoring.`);
    // Poll until the session ends (runner exits → bash exits → session destroyed).
    // Cap at 13h as a safety net (the runner itself caps at Settings' autopilotMinutes).
    const deadline = Date.now() + 13 * 60 * 60 * 1000;
    while (spawnSync('tmux', ['has-session', '-t', `=${tmuxName}`], { stdio: 'ignore' }).status === 0) {
      if (Date.now() > deadline) {
        spawnSync('tmux', ['kill-session', '-t', `=${tmuxName}`], { stdio: 'ignore' });
        log(`job #${job.id}: killed tmux session ${tmuxName} at 13h safety cap.`);
        break;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    try { ok = parseInt(readFileSync(exitFile, 'utf8').trim(), 10) === 0; } catch { ok = false; }
    try { unlinkSync(wrapperFile); } catch { /* best effort */ }
    try { unlinkSync(exitFile); } catch { /* best effort */ }
  } else {
    log(`job #${job.id}: tmux session start failed — falling back to direct run.`);
    try { unlinkSync(wrapperFile); } catch { /* best effort */ }
  }
}

if (!usedTmux) {
  const run = spawnSync(process.execPath, [runner, ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  ok = run.status === 0;
}

const failDetail = `[run/job #${job.id}] runner failed (${job.kind} on ${job.slug}${job.itemId ? ` item #${job.itemId}` : ''})`;
await report(ok ? 'done' : 'failed', ok ? '' : failDetail);
log(`job #${job.id}: ${ok ? 'done' : `failed — ${failDetail}`}.`);
