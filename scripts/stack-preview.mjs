#!/usr/bin/env node
// Stack — the branch preview worker (#208). A mirror site for pushed work.
//
// Brings ONE branch up as an isolated, publicly reachable stack so it can be
// looked at before it is merged — then tears it back down.
//
//   node scripts/stack-preview.mjs --start <previewId>
//   node scripts/stack-preview.mjs --stop  <previewId>
//
// Never run by hand in normal use: stack-autopilot-dispatch.mjs claims a queued
// preview and spawns this DETACHED, so a five-minute docker build never blocks
// the every-minute cron poll or the one-job-at-a-time autopilot queue.
//
// ---------------------------------------------------------------------------
// Why a Cloudflare quick tunnel, and not a port or a path
// ---------------------------------------------------------------------------
// This host has exactly one public entry: projects.bkos.dev, a token-managed
// Cloudflare Tunnel to port 8787. There is no wildcard DNS (*.bkos.dev is
// NXDOMAIN), and the tunnel's ingress rules live in Cloudflare's dashboard
// rather than a file on disk — so neither "give each preview a hostname" nor
// "publish another port" is available without work outside this repo.
//
// Serving previews under a PATH on the existing origin was the other option,
// and it fails on contact with real apps: a Vite/CRA build emits root-absolute
// asset URLs (`/assets/index-abc.js`), so under `/preview/7/` the browser asks
// the parent origin for them and gets Stack's own bundle back. Fixing that
// needs per-app rebuilds with a matching `base`, which is exactly the kind of
// per-app special-casing a generic preview must not require.
//
// A quick tunnel (`cloudflared tunnel --url`) needs no DNS record, no dashboard
// access and no account config, and it serves the app at the ROOT of its own
// random hostname — so the app is byte-for-byte what it will be in production.
//
// The trade, stated plainly: that URL is PUBLIC and unauthenticated while it
// lives. It is unguessable and never listed, but it is not access-controlled —
// which is why every preview carries an expiry the server enforces, and why the
// default life is hours rather than days.
// ---------------------------------------------------------------------------

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, openSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadStackEnv, logStderr } from '../hook/stack-post.mjs';

loadStackEnv();
const API = (process.env.STACK_API || '').replace(/\/$/, '');
const TOKEN = process.env.STACK_TOKEN;
if (!API || !TOKEN) process.exit(0); // unconfigured host = never acts

const log = (msg) => logStderr(`preview ${new Date().toISOString()} · ${msg}`);

async function api(method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 600_000, ...opts });
const ok = (r) => r && r.status === 0;

const ROOT = process.env.STACK_AUTOPILOT_ROOT || homedir();
const PREVIEW_DIR = join(homedir(), '.stack', 'previews');
// Ports are internal only — the tunnel is what the outside world sees — but
// they still have to not collide with the host's real services.
const PORT_LO = 8790;
const PORT_HI = 8809;

// A branch name has to become a docker compose project name (lowercase,
// [a-z0-9_-]) and a directory. Keep it recognisable but boring.
const safeName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

const portFree = (port) => {
  // ss is the cheapest reliable check on this host; if it isn't there, fall
  // back to assuming free and let docker fail loudly rather than silently.
  const r = sh('ss', ['-ltn'], { timeout: 10_000 });
  if (!ok(r)) return true;
  return !new RegExp(`[:.]${port}\\s`).test(r.stdout || '');
};
const pickPort = () => {
  for (let p = PORT_LO; p <= PORT_HI; p++) if (portFree(p)) return p;
  return null;
};

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------
async function start(id) {
  const say = (detail, extra = {}) =>
    api('PATCH', `/api/previews/${id}`, { detail, ...extra }).catch(() => {});
  const fail = async (detail) => {
    log(`#${id} failed — ${detail}`);
    await api('PATCH', `/api/previews/${id}`, { status: 'failed', detail }).catch(() => {});
    process.exit(0);
  };

  const list = await api('GET', '/api/previews');
  const pv = (Array.isArray(list) ? list : []).find((r) => r.id === String(id));
  if (!pv) return fail('the preview row vanished before it started');

  const repo = join(ROOT, pv.slug);
  if (!existsSync(join(repo, '.git'))) return fail(`no repo at ${repo}`);

  const composeProject = `stack-preview-${safeName(pv.slug)}-${safeName(pv.branch)}`.slice(0, 60);
  const worktree = join(PREVIEW_DIR, composeProject);
  mkdirSync(PREVIEW_DIR, { recursive: true });

  // Always start from a clean worktree — a leftover from a crashed run would
  // otherwise be checked out at the wrong commit and preview the wrong code,
  // which is worse than not previewing at all.
  await teardown({ composeProject, worktree, tunnelPid: null }, { quiet: true });

  await say('fetching the branch');
  sh('git', ['-C', repo, 'fetch', 'origin', '--prune', '--quiet'], { timeout: 120_000 });
  const ref = `origin/${pv.branch}`;
  if (!ok(sh('git', ['-C', repo, 'rev-parse', '--verify', ref], { timeout: 30_000 }))) {
    return fail(`origin/${pv.branch} not found — has it been pushed?`);
  }
  const add = sh('git', ['-C', repo, 'worktree', 'add', '--detach', worktree, ref], { timeout: 180_000 });
  if (!ok(add)) return fail(`worktree add failed: ${(add.stderr || '').slice(0, 180)}`);

  const compose = join(worktree, 'docker-compose.yml');
  if (!existsSync(compose)) {
    await teardown({ composeProject, worktree, tunnelPid: null }, { quiet: true });
    return fail('that branch has no docker-compose.yml — nothing to bring up');
  }

  // The worktree has no .env (gitignored), and Stack's own compose *requires*
  // POSTGRES_PASSWORD and API_TOKEN. Copy the main checkout's, so the preview
  // gets the same shape of config the real stack runs with — then override the
  // published port below so the two can coexist.
  if (existsSync(join(repo, '.env'))) copyFileSync(join(repo, '.env'), join(worktree, '.env'));

  const port = pickPort();
  if (!port) {
    await teardown({ composeProject, worktree, tunnelPid: null }, { quiet: true });
    return fail(`no free port in ${PORT_LO}-${PORT_HI} — stop another preview first`);
  }

  await say(`building on port ${port} — this can take a few minutes`, {
    port, composeProject, worktree,
  });

  // The compose PROJECT NAME is what buys isolation: docker namespaces the
  // containers AND the named volumes under it, so the preview gets its own
  // empty database rather than sharing (or worse, migrating) the real one.
  // WEB_PORT is Stack's own knob for the published port; PORT is passed too
  // for projects that spell it that way.
  const env = { ...process.env, WEB_PORT: String(port), PORT: String(port), COMPOSE_PROJECT_NAME: composeProject };
  const up = sh('docker', ['compose', '-p', composeProject, 'up', '-d', '--build'],
    { cwd: worktree, env, timeout: 900_000 });
  if (!ok(up)) {
    const why = (up.stderr || up.stdout || '').trim().split('\n').filter(Boolean).slice(-3).join(' · ');
    await teardown({ composeProject, worktree, tunnelPid: null }, { quiet: true });
    return fail(`docker compose up failed: ${why.slice(0, 220)}`);
  }

  // Wait for something to actually answer before exposing it — a tunnel onto a
  // still-booting stack shows the reviewer a connection error and reads as "the
  // branch is broken" when it is merely slow.
  await say('waiting for the stack to answer');
  let answered = false;
  for (let i = 0; i < 60; i++) {
    const probe = sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '4',
      `http://127.0.0.1:${port}/`], { timeout: 10_000 });
    const code = parseInt((probe.stdout || '').trim(), 10);
    if (Number.isFinite(code) && code > 0 && code < 500) { answered = true; break; }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  if (!answered) {
    await teardown({ composeProject, worktree, tunnelPid: null }, { quiet: true });
    return fail(`the stack came up but nothing answered on :${port} within 3 minutes`);
  }

  // The public URL. cloudflared prints the hostname to stderr on startup; it
  // has to keep running for the tunnel to live, so it is detached and its pid
  // recorded for teardown.
  await say('opening the public tunnel');
  mkdirSync(join(homedir(), '.stack'), { recursive: true });
  const tunnelLog = join(PREVIEW_DIR, `${composeProject}.tunnel.log`);
  const out = openSync(tunnelLog, 'a');
  const tunnel = spawn('cloudflared',
    ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`],
    { detached: true, stdio: ['ignore', out, out] });
  tunnel.unref();

  let url = '';
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1_500));
    try {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(readFileSync(tunnelLog, 'utf8'));
      if (m) { url = m[0]; break; }
    } catch { /* not written yet */ }
  }
  if (!url) {
    await teardown({ composeProject, worktree, tunnelPid: tunnel.pid }, { quiet: true });
    return fail('the tunnel did not come up — cloudflared printed no URL');
  }

  await api('PATCH', `/api/previews/${id}`, {
    status: 'live', url, port, composeProject, worktree, tunnelPid: tunnel.pid,
    detail: `live on ${pv.branch}`,
  }).catch(() => {});
  log(`#${id} live: ${url} (${pv.slug}/${pv.branch} on :${port})`);
}

// ---------------------------------------------------------------------------
// stop / teardown
// ---------------------------------------------------------------------------
// Every step is best-effort and independent: a preview that is half gone must
// still get the rest of itself cleaned up, so one failure never strands docker
// volumes or a tunnel process on the host.
async function teardown(handles, { quiet = false } = {}) {
  const { composeProject, worktree, tunnelPid } = handles;
  if (tunnelPid) {
    try { process.kill(tunnelPid, 'SIGTERM'); } catch { /* already gone */ }
  }
  if (composeProject) {
    // -v takes the preview's OWN volumes with it (they are namespaced under the
    // project name, so this can never touch the real stack's database).
    sh('docker', ['compose', '-p', composeProject, 'down', '-v', '--remove-orphans'],
      { cwd: existsSync(worktree || '') ? worktree : undefined, timeout: 300_000 });
  }
  // The tunnel log is only useful while the tunnel lives — left behind it just
  // accumulates one file per preview forever.
  if (composeProject) {
    try { rmSync(join(PREVIEW_DIR, `${composeProject}.tunnel.log`), { force: true }); } catch { /* best effort */ }
  }
  if (worktree && existsSync(worktree)) {
    // The worktree belongs to whichever repo created it; prune from the repo
    // side too so git doesn't keep a dangling registration.
    sh('git', ['-C', worktree, 'worktree', 'remove', '--force', worktree], { timeout: 60_000 });
    try { rmSync(worktree, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  // Prune every repo's stale worktree registrations in one pass.
  try {
    for (const dir of [ROOT]) {
      const entries = sh('ls', ['-1', dir], { timeout: 10_000 });
      for (const name of (entries.stdout || '').split('\n').filter(Boolean)) {
        const r = join(dir, name);
        if (existsSync(join(r, '.git'))) sh('git', ['-C', r, 'worktree', 'prune'], { timeout: 30_000 });
      }
    }
  } catch { /* best effort */ }
  if (!quiet) log(`torn down ${composeProject || '(no compose project)'}`);
}

async function stop(id) {
  const work = await api('GET', '/api/previews/work').catch(() => null);
  const row = work?.stop?.find((r) => r.id === String(id));
  // The row may already be gone from the work feed (a concurrent sweep); tear
  // down what we can from the id alone rather than doing nothing.
  const handles = row
    ? { composeProject: row.composeProject, worktree: row.worktree, tunnelPid: row.tunnelPid }
    : { composeProject: '', worktree: '', tunnelPid: null };
  await teardown(handles);
  await api('PATCH', `/api/previews/${id}`, {
    status: 'stopped',
    detail: row?.expired ? 'expired — torn down automatically' : 'stopped',
  }).catch(() => {});
  log(`#${id} stopped`);
}

const startId = arg('start');
const stopId = arg('stop');
try {
  if (startId) await start(Number(startId));
  else if (stopId) await stop(Number(stopId));
  else log('nothing to do — pass --start <id> or --stop <id>');
} catch (e) {
  log(`unhandled: ${e?.message || e}`);
}
process.exit(0);
