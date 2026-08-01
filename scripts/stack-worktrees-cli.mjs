#!/usr/bin/env node
// Stack — see and reap the interactive worktrees under ~/.stack/worktrees
// (#229 unit 3).
//
// `stack term <dir> --worktree` cuts these; nothing else tidies them up.
// This is the other half of that pair: list what's actually on disk against
// what's still live in tmux, and prune the ones nobody's session claims any
// more.
//
//   stack worktrees [--repo <path>] [--json]
//   stack worktrees --prune [--repo <path>] [--run]
//
// An ORPHAN is a worktree under the root whose stack-term-wt-<key> tmux
// session no longer exists. It is only ever removed when it is CLEAN and has
// nothing unpushed — a dirty or ahead orphan is listed with the reason and
// left alone, because the work sitting in it may be the only copy (CLAUDE.md
// "Fail-safe direction": an action that destroys fails SAFE). `--prune`
// alone is always a dry run and changes nothing; `--run` is what actually
// calls removeWorktree() (never with force) and then releases the row
// through the API for each one actually removed.
//
// Liveness comes from tmux, so an unreachable tmux (not installed, no
// server running) would make every worktree LOOK orphaned — the same trap
// #287's idle reaper guards against. `--prune` refuses to touch (or even
// list as orphaned) anything unless tmuxAvailable() is true first: an
// unknown liveness threshold reaps nothing.
//
// The register POST/release is a report, not a gate — an unreachable API or
// missing token logs a note and the on-disk removal still stands.

import { fileURLToPath } from 'node:url';
import { resolve, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { git, loadStackEnv, logStderr } from '../hook/stack-post.mjs';
import { listWorktrees, worktreesRoot, orphanWorktrees, removeWorktree } from './lib/worktree.mjs';
import { tmuxAvailable, sessionExists, listStackSessions } from '../terminal/tmux-session.mjs';

const log = (msg) => logStderr(`worktrees ${msg}`);

// Same convention as stack-skills.mjs's REPO_ROOT: STACK_AUTOPILOT_ROOT if
// set, else $HOME. `--repo <path>` overrides both.
function repoFromArgs(args) {
  const i = args.indexOf('--repo');
  if (i !== -1 && args[i + 1]) return resolve(args[i + 1]);
  return process.env.STACK_AUTOPILOT_ROOT || homedir();
}

function underRoot(path, root) {
  const p = resolve(path);
  return p === root || p.startsWith(root + sep);
}

function isDirty(path) {
  return git(path, ['status', '--porcelain']).length > 0;
}

// Commits on HEAD not yet on its upstream, or — with no upstream set — not
// yet on the repo's own trunk (main, then master; same order stack-tree.mjs
// uses). 0 when neither exists: nothing to compare against, so nothing
// reports as ahead.
function aheadCount(path) {
  const upstream = git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const base = upstream || ['main', 'master'].find((b) => git(path, ['rev-parse', '--verify', '--quiet', b]));
  if (!base) return 0;
  return parseInt(git(path, ['rev-list', '--count', `${base}..HEAD`]) || '0', 10) || 0;
}

// The <key> half of every live stack-term-wt-<key> tmux session.
function liveSessionKeys() {
  const keys = new Set();
  for (const s of listStackSessions()) {
    const m = /^stack-term-wt-(.+)$/.exec(s.name);
    if (m) keys.add(m[1]);
  }
  return keys;
}

// One row per registered worktree under worktreesRoot(), whatever repo it
// was cut from — listWorktrees(repo) also returns repo's OWN checkout (the
// main worktree) and any worktree cut elsewhere (e.g. autopilot's own
// throwaway trees), which underRoot() filters out.
function rows(repo) {
  const root = resolve(worktreesRoot());
  return listWorktrees(repo)
    .filter((w) => underRoot(w.path, root))
    .map((w) => {
      const key = basename(resolve(w.path));
      const session = `stack-term-wt-${key}`;
      return {
        key,
        path: w.path,
        branch: w.branch || (w.detached ? '(detached)' : ''),
        session,
        live: sessionExists(session),
        dirty: isDirty(w.path),
        ahead: aheadCount(w.path),
      };
    });
}

function printTable(list) {
  if (!list.length) {
    process.stdout.write(`No worktrees under ${worktreesRoot()}.\n`);
    return;
  }
  for (const r of list) {
    const bits = [
      r.key.padEnd(24),
      (r.branch || '—').padEnd(28),
      r.live ? 'session live' : 'session gone',
      r.dirty ? 'dirty' : 'clean',
      r.ahead ? `↑${r.ahead}` : 'in sync',
    ];
    process.stdout.write(`${bits.join('  ')}\n`);
  }
}

async function releaseOnApi(path) {
  loadStackEnv();
  const API = (process.env.STACK_API || '').replace(/\/+$/, '');
  const TOKEN = process.env.STACK_TOKEN || '';
  if (!API || !TOKEN) {
    log(`no API/token in ~/.stack/env — ${path} removed on disk only`);
    return;
  }
  try {
    const res = await fetch(`${API}/api/worktrees/release`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log(`release ${path} → API ${res.status} — removal on disk still stands`);
  } catch (e) {
    log(`release ${path} failed (${e.message}) — removal on disk still stands`);
  }
}

async function prune(repo, run) {
  // Fail SAFE: liveness is read off tmux, so an unreachable tmux can't be
  // told apart from "everything is orphaned". Reap nothing rather than guess.
  if (!tmuxAvailable()) {
    log('tmux is unreachable — liveness cannot be determined, reaping nothing.');
    process.stdout.write('tmux is unreachable — cannot tell live sessions from dead ones, so nothing is touched.\n');
    return 0;
  }

  const orphans = orphanWorktrees(repo, liveSessionKeys());
  if (!orphans.length) {
    process.stdout.write('No orphaned worktrees.\n');
    return 0;
  }

  let removed = 0;
  for (const w of orphans) {
    const dirty = isDirty(w.path);
    const ahead = aheadCount(w.path);
    if (dirty || ahead > 0) {
      const reason = dirty ? 'uncommitted changes' : `${ahead} unpushed commit(s)`;
      process.stdout.write(`KEEP          ${w.path} — ${reason}, refusing to remove.\n`);
      continue;
    }
    if (!run) {
      process.stdout.write(`WOULD REMOVE  ${w.path} (branch ${w.branch || '(detached)'})\n`);
      continue;
    }
    const r = removeWorktree(repo, w.path);
    if (!r.ok) {
      process.stdout.write(`FAILED        ${w.path} — ${r.reason}\n`);
      continue;
    }
    process.stdout.write(`REMOVED       ${w.path}\n`);
    removed++;
    await releaseOnApi(w.path);
  }
  return removed;
}

export async function main(args = []) {
  const json = args.includes('--json');
  const doPrune = args.includes('--prune');
  const run = args.includes('--run');
  const repo = repoFromArgs(args);

  if (doPrune) {
    await prune(repo, run);
    return 0;
  }

  const list = rows(repo);
  if (json) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
  } else {
    printTable(list);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
