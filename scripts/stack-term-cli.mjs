// `stack term [dir]` — a claude session in a named stack-term-* tmux session,
// from any real terminal (typically a laptop over ssh).
//
// Same lifecycle as the web terminal's claude tabs (#188): the session runs
// inside tmux, so closing the laptop lid / dropping ssh only detaches — the
// process keeps running, and because the name wears the daemon's own
// stack-term- prefix it shows up on Mission Control's running-sessions strip
// (Gemini-labelled) where any browser can jump in. The web and the laptop can
// mirror the same session: tmux fans one session out to every client.
//
// The name is stable per directory (stack-term-<dir>), so `stack term stack`
// from the laptop always lands back in the same session. Detach with ctrl-b d.
//
//   stack term            claude in $HOME (session stack-term-home)
//   stack term stack      claude in ~/stack (session stack-term-stack)
//   stack term --safe …   without --dangerously-skip-permissions
//   stack term --shell …  a plain shell instead of claude
//
// --worktree (#229): a tree of ITS OWN instead of the shared checkout, so a
// second interactive session in the same repo never fights the first one's
// dirty tree. Branch term/<label>; the tree lives under worktreesRoot(), i.e.
// ~/.stack/worktrees/<key> — deliberately still inside the $HOME jail below,
// which is what lets the web daemon (same jail) reach these trees too.
//
//   stack term stack --worktree            a tree of its own, branch term/stack-<n>
//   stack term stack --worktree fix-auth   a tree of its own, branch term/fix-auth

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmuxAvailable, sessionArgv } from '../terminal/tmux-session.mjs';
import { git, loadStackEnv } from '../hook/stack-post.mjs';
import { worktreesRoot, worktreeKey, branchWorktree, worktreeAt, addWorktree } from './lib/worktree.mjs';

// POST /api/worktrees — a report, not a gate (CLAUDE.md "Fail-safe
// direction": this call only RECORDS). An unreachable API or missing token
// logs a short note and the session starts regardless; the token is never
// printed.
async function registerWorktree({ path, repo, branch, sessionName }) {
  loadStackEnv();
  const API = (process.env.STACK_API || '').replace(/\/+$/, '');
  const TOKEN = process.env.STACK_TOKEN || '';
  if (!API || !TOKEN) {
    process.stderr.write('[stack term] no API/token in ~/.stack/env — worktree not registered, starting anyway.\n');
    return;
  }
  try {
    const res = await fetch(`${API}/api/worktrees`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path, repo, branch, sessionName, kind: 'term' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) process.stderr.write(`[stack term] register worktree → API ${res.status} — starting anyway.\n`);
  } catch (e) {
    process.stderr.write(`[stack term] could not register worktree (${e.message}) — starting anyway.\n`);
  }
}

export async function main(args = []) {
  const safe = args.includes('--safe');
  const shell = args.includes('--shell');
  const wtIdx = args.indexOf('--worktree');
  const worktree = wtIdx !== -1;
  // The label following --worktree, if any ("stack term stack --worktree
  // fix-auth"). Excluded from the positional-dir scan below so it's never
  // mistaken for the directory argument regardless of flag order.
  let labelIdx = -1;
  let rawLabel = '';
  if (worktree && args[wtIdx + 1] && !args[wtIdx + 1].startsWith('--')) {
    rawLabel = args[wtIdx + 1];
    labelIdx = wtIdx + 1;
  }
  const dir = args.filter((a, i) => i !== labelIdx && !a.startsWith('--'))[0] || '';

  if (!tmuxAvailable()) {
    process.stderr.write('[stack term] tmux is not installed — install it or run claude directly.\n');
    return 1;
  }

  // Same jail as the web daemon: bare names resolve under $HOME, nothing above it.
  const root = homedir();
  const cwd = resolve(root, dir);
  if (cwd !== root && !cwd.startsWith(root + sep)) {
    process.stderr.write(`[stack term] ${dir} escapes ${root} — sessions stay under home.\n`);
    return 1;
  }

  const slug = (dir.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'home').slice(0, 40);

  let sessionCwd = cwd;
  let name = `stack-term-${slug}`;

  if (worktree) {
    // The resolved dir IS the repo a worktree is cut FROM — never cut one
    // from something that isn't a git repository.
    if (!git(cwd, ['rev-parse', '--git-dir'])) {
      process.stderr.write(`[stack term] ${cwd} is not a git repository — refusing to cut a worktree.\n`);
      return 1;
    }

    const sanitizedLabel = rawLabel
      ? (rawLabel.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'session')
      : '';

    let branchLabel = sanitizedLabel;
    if (!branchLabel) {
      // No label given — derive <dirslug>-<n> for the lowest n for which
      // neither the branch nor the worktree path already exists.
      let n = 1;
      for (;;) {
        const candidate = `${slug}-${n}`;
        const candidatePath = resolve(worktreesRoot(), worktreeKey(candidate));
        if (!branchWorktree(cwd, `term/${candidate}`) && !worktreeAt(cwd, candidatePath)) {
          branchLabel = candidate;
          break;
        }
        n++;
      }
    }

    const branch = `term/${branchLabel}`;
    const key = worktreeKey(branchLabel);
    const wtPath = resolve(worktreesRoot(), key);

    const added = addWorktree(cwd, wtPath, { branch, reuse: true });
    if (!added.ok) {
      // The module's reasons are already written for a human to read — print
      // them verbatim, never re-worded or swallowed. This is the collision
      // case and it must be visible.
      process.stderr.write(`[stack term] ${added.reason}\n`);
      return 1;
    }

    // stack-term- stays the prefix so Mission Control's running-sessions
    // strip (and listStackSessions/reapIdleSessions on the host) still picks
    // this session up — that prefix is load-bearing, not cosmetic.
    name = `stack-term-wt-${key}`;
    sessionCwd = wtPath;

    process.stderr.write(`[stack term] worktree ${wtPath} on branch ${branch}\n`);

    await registerWorktree({ path: wtPath, repo: cwd, branch, sessionName: name });
  }

  const cmd = shell ? 'exec bash -l'
    : `exec claude${safe ? '' : ' --dangerously-skip-permissions'}`;

  process.stderr.write(`[stack term] session ${name} in ${sessionCwd} — detach with ctrl-b d, it keeps running\n`);
  const argv = sessionArgv(name, sessionCwd, `/bin/bash -lc "${cmd}"`);
  const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
  return r.status ?? 0;
}

// Direct invocation (node scripts/stack-term-cli.mjs) — the dispatcher calls main().
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
