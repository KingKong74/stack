// "Work goes to: New branch" — a terminal session started on its own branch,
// in its own worktree, so it never shares a dirty tree with the checkout.
//
// The tree goes where every interactive worktree goes (scripts/lib/worktree.mjs:
// ~/.stack/worktrees/<key>), which is inside the $HOME cwd jail; move it out and
// the session cannot start. The branch is `term/<id>`, named off the tmux
// session, so it is unique per session and says where it came from. It is NOT a
// `<kind>/<id>-<summary>` item branch: no roadmap row owns it, and lane.mjs
// parsing it as one would invent a claim.
//
// FAILS LOUD. A branch that could not be made refuses the session with the
// reason, rather than quietly running it in the checkout: the human asked for
// isolation, and work landing on main instead is the outcome they chose against.
import { spawnSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { addWorktree, worktreeKey, worktreesRoot } from '../scripts/lib/worktree.mjs';

const git = (cwd, args, timeout = 15_000) =>
  spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout });

/** Pure: where the tree and branch for this session go. */
export function branchSessionPlan(tmuxName, home) {
  const id = String(tmuxName || '').replace(/^stack-term-/, '');
  const key = worktreeKey(`term-${id}`);
  return { path: join(worktreesRoot(home), key), branch: `term/${key.replace(/^term-/, '')}` };
}

/**
 * Cut the session's branch off origin/main (falling back to HEAD offline) and
 * return the cwd to start in: the same sub-path of the new tree as `cwd` was
 * of its repo. `{ ok:false, reason }` on any failure, never a throw.
 */
export function makeBranchSession({ cwd, tmuxName, root, home }) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  const repo = top.status === 0 ? top.stdout.trim() : '';
  if (!repo) return { ok: false, reason: `${cwd} is not inside a git repository.` };
  if (repo !== root && !repo.startsWith(root + sep)) return { ok: false, reason: 'That repository is outside the terminal root.' };
  // Best effort: an offline host still gets a branch, off what it has.
  git(repo, ['fetch', '--quiet', 'origin', 'main'], 30_000);
  const base = git(repo, ['rev-parse', '--verify', '--quiet', 'origin/main']).status === 0 ? 'origin/main' : 'HEAD';
  const plan = branchSessionPlan(tmuxName, home);
  const r = addWorktree(repo, plan.path, { branch: plan.branch, base });
  if (!r.ok) return { ok: false, reason: r.reason };
  const sub = relative(repo, cwd);
  return {
    ok: true,
    cwd: sub && !sub.startsWith('..') ? join(r.path, sub) : r.path,
    branch: plan.branch,
    project: relative(root, repo),
  };
}
