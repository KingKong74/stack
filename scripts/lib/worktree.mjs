// Shared git-worktree management — #229. Autopilot has shelled `git worktree
// add/remove` inline for a long time (stack-autopilot.mjs); this module gives
// the interactive side (a claimed roadmap item worked from a terminal, not a
// nightly run) the SAME semantics rather than a second, drifting copy.
//
// Two things every caller has to get right, because a repo's .git/worktrees
// is shared state:
//   - DESYNC: git refuses to check one branch out in two worktrees at once,
//     and the raw error just names a path — branchWorktree() answers "where"
//     up front so a caller can say something a human can act on.
//   - CONCURRENCY: several sessions (autopilot + one or more interactive
//     terminals) can touch one repo's worktree metadata within the same
//     second. Every WRITE (add/remove/prune) retries on a lock failure
//     instead of surfacing a transient "index.lock" as a hard error.
//
// removeWorktree() fails SAFE (CLAUDE.md "Fail-safe direction"): it will
// only ever remove a path git itself vouches for as a worktree of this repo,
// and it refuses a dirty tree unless told to force — a live session may be
// sitting in it. Nothing here throws; every function returns a value (or, on
// a git failure, [] / null / an { ok:false, reason } result) so a caller
// never needs a try/catch around this module.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import os from 'node:os';

// ---- internal helpers -------------------------------------------------

function isLockError(stderr) {
  return /index\.lock|\.git[\\/]worktrees.*lock|File exists/i.test(String(stderr || ''));
}

// A synchronous sleep for the retry backoff — the rest of this module is
// synchronous (spawnSync), matching lane.mjs and the host scripts, so an
// async sleep would force every caller to await this one thing.
function sleepMs(ms) {
  try {
    const ia = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(ia, 0, 0, ms);
  } catch {
    // SharedArrayBuffer/Atomics unavailable — fall back to a short spin.
    // Only reached on lock contention, which is rare and clears fast.
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

// Runs `git -C cwd ...args`, never throws. WRITE operations (worktree
// add/remove/prune) pass retry:true and get up to 4 retries, ~150ms apart,
// when git's stderr names a lock — a parallel worktree op finishing mid-flight.
function runGit(cwd, args, { retry = false } = {}) {
  let attempt = 0;
  for (;;) {
    const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    if (res.error) return { code: 1, stdout: '', stderr: String(res.error.message || res.error) };
    const stderr = res.stderr || '';
    if (res.status === 0) return { code: 0, stdout: res.stdout || '', stderr };
    if (retry && attempt < 4 && isLockError(stderr)) {
      attempt++;
      sleepMs(150);
      continue;
    }
    return { code: res.status ?? 1, stdout: res.stdout || '', stderr };
  }
}

function realOrResolved(p) {
  const r = resolve(p);
  try { return realpathSync(r); } catch { return r; }
}

// ---- exports ------------------------------------------------------------

// Where INTERACTIVE session worktrees live. Autopilot's own live under
// ~/.stack/autopilot/ — this module makes no assumption about either and
// just needs somewhere to root the "am I an orphan" scan.
export function worktreesRoot(home = process.env.HOME || process.env.USERPROFILE || os.homedir()) {
  return resolve(home, '.stack', 'worktrees');
}

// Sanitises an arbitrary label (a claim name, a session id, …) into a single
// safe path segment: never '.', '..', empty, or containing a separator.
export function worktreeKey(name) {
  const key = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return key || 'session';
}

// All worktrees git knows about for repo, parsed from --porcelain. Returns
// [] on any git failure (repo missing, not a repository, …) — never throws.
export function listWorktrees(repo) {
  const res = runGit(repo, ['worktree', 'list', '--porcelain']);
  if (res.code !== 0) return [];

  const entries = [];
  let cur = null;
  const flush = () => { if (cur) entries.push(cur); cur = null; };
  for (const line of res.stdout.split('\n')) {
    if (line === '') { flush(); continue; }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      flush();
      cur = { path: val, head: null, branch: null, detached: false, locked: false, prunable: false };
    } else if (!cur) {
      continue;
    } else if (key === 'HEAD') {
      cur.head = val;
    } else if (key === 'branch') {
      cur.branch = val.replace(/^refs\/heads\//, '');
    } else if (key === 'detached') {
      cur.detached = true;
    } else if (key === 'locked') {
      cur.locked = true;
    } else if (key === 'prunable') {
      cur.prunable = true;
    }
  }
  flush();
  return entries;
}

// The registered worktree at path, or null. Compares REAL paths so a
// symlinked or relative path still matches the entry git reports.
export function worktreeAt(repo, path) {
  const real = realOrResolved(path);
  return listWorktrees(repo).find((w) => realOrResolved(w.path) === real) || null;
}

// The worktree currently checking branch out, or null. The desync guard: a
// caller uses this to say WHERE a branch already lives rather than let git's
// raw "already checked out" error surface with no actionable path.
export function branchWorktree(repo, branch) {
  if (!branch) return null;
  return listWorktrees(repo).find((w) => w.branch === branch) || null;
}

// Creates (or, with reuse:true, adopts) a worktree. Never throws — always
// returns { ok:true, path, branch, created, reason:'' } or
// { ok:false, reason }. See the module header for the ordering rules.
export function addWorktree(repo, path, opts = {}) {
  const { branch = null, base = null, detach = false, reuse = false } = opts;
  const target = resolve(path);

  // Rule 1 — a worktree is already registered at this path. Never
  // force-remove it here: a live parallel session may be sitting in it.
  const existing = worktreeAt(repo, target);
  if (existing) {
    if (reuse && (!branch || existing.branch === branch)) {
      return { ok: true, path: existing.path, branch: existing.branch, created: false, reason: '' };
    }
    return {
      ok: false,
      reason: `${target} is already a worktree (branch: ${existing.branch || 'detached'}) — refusing to disturb it.`,
    };
  }

  // Rule 2 — the desync guard: this branch is checked out somewhere else.
  if (branch) {
    const elsewhere = branchWorktree(repo, branch);
    if (elsewhere) {
      return { ok: false, reason: `branch ${branch} is already checked out at ${elsewhere.path}.` };
    }
  }

  // Rule 3 — create it. An existing ref is checked out plain (no -b, which
  // is a plain error on a branch that already exists).
  mkdirSync(dirname(target), { recursive: true });
  const branchExists = branch
    ? runGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0
    : false;

  const args = ['worktree', 'add'];
  if (detach) args.push('--detach');
  if (branch) {
    if (branchExists) {
      args.push(target, branch);
    } else {
      args.push('-b', branch, target);
      if (base) args.push(base);
    }
  } else {
    args.push(target);
  }

  const res = runGit(repo, args, { retry: true });

  // Rule 4 — verify. `worktree add` can fail while still exiting 0-ish.
  if (!existsSync(resolve(target, '.git'))) {
    return { ok: false, reason: (res.stderr || res.stdout || 'git worktree add failed').trim() };
  }
  return { ok: true, path: target, branch: branch || null, created: true, reason: '' };
}

// Removes a worktree. Fails SAFE: refuses a path git doesn't vouch for as a
// worktree of repo, and refuses a dirty tree unless force is set.
export function removeWorktree(repo, path, opts = {}) {
  const { force = false } = opts;
  const target = resolve(path);

  const existing = worktreeAt(repo, target);
  if (!existing) {
    return {
      ok: false,
      reason: `${target} is not a registered worktree of this repo — refusing to remove a directory git does not vouch for.`,
    };
  }

  if (!force) {
    const status = runGit(existing.path, ['status', '--porcelain']);
    if (status.code === 0 && status.stdout.trim() !== '') {
      return { ok: false, reason: `${existing.path} has uncommitted changes — refusing to remove without force.` };
    }
  }

  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(existing.path);
  const res = runGit(repo, args, { retry: true });
  if (res.code !== 0) {
    return { ok: false, reason: (res.stderr || res.stdout || 'git worktree remove failed').trim() };
  }
  runGit(repo, ['worktree', 'prune'], { retry: true });
  return { ok: true, reason: '' };
}

// Plain `git worktree prune`. Returns true on success, false on any failure.
export function pruneWorktrees(repo) {
  return runGit(repo, ['worktree', 'prune'], { retry: true }).code === 0;
}

// Registered worktrees rooted under worktreesRoot(home) whose final path
// segment isn't a live session key. REPORTS only — callers decide whether
// and how to remove what comes back (e.g. through removeWorktree).
export function orphanWorktrees(repo, liveKeys, home) {
  const live = new Set(Array.isArray(liveKeys) ? liveKeys : Array.from(liveKeys || []));
  const root = resolve(worktreesRoot(home));
  return listWorktrees(repo).filter((w) => {
    const p = resolve(w.path);
    if (p !== root && !p.startsWith(root + sep)) return false;
    return !live.has(basename(p));
  });
}
