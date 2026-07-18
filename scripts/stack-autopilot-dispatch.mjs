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
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
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
if (!job) process.exit(0);

const log = (msg) => logStderr(`dispatch ${new Date().toISOString()} · ${msg}`);
const report = (status, detail) =>
  api('PATCH', `/api/autopilot/jobs/${job.id}`, detail === undefined ? { status } : { status, detail })
    .catch((e) => log(`job report failed (${e.message})`));

const root = process.env.STACK_AUTOPILOT_ROOT || homedir();
const repo = join(root, job.slug);
log(`job #${job.id}: ${job.kind} run on ${job.slug}${job.itemId ? ` (item #${job.itemId})` : ''}`);
if (!existsSync(join(repo, '.git'))) {
  log(`no repo at ${repo} — job failed.`);
  await report('failed', `no repo at ${repo}`);
  process.exit(0);
}

await report('running');
const runner = join(dirname(fileURLToPath(import.meta.url)), 'stack-autopilot.mjs');
const args = ['--project', job.slug, '--repo', repo];
if (job.itemId) args.push('--item', String(job.itemId));
// A manual press or a calendar row is explicit human config — it runs even
// while the arm switch / automode are off. The nightly keeps both gates.
if (job.kind !== 'nightly') args.push('--force');
const run = spawnSync(process.execPath, [runner, ...args], { stdio: ['ignore', 'inherit', 'inherit'] });

const ok = run.status === 0;
await report(ok ? 'done' : 'failed', ok ? '' : `runner exited ${run.status ?? `on ${run.signal || 'error'}`}`);
log(`job #${job.id}: ${ok ? 'done' : `failed (exit ${run.status ?? run.signal})`}.`);
