// The shared git-worktree module (scripts/lib/worktree.mjs) pinned against a
// REAL throwaway repo — #229. Needs no database and no server; it may use
// real git because a fake porcelain fixture would only prove the parser
// agrees with itself, not with what git actually emits.
//
//   node server/test/worktree.test.mjs
//
// Both directions matter and are not symmetric. A missed collision lets two
// sessions write into the same checkout at once — the exact desync this
// module exists to prevent. A FALSE collision blocks a legitimate parallel
// session from ever getting a worktree. Fail-safe direction matters too:
// removeWorktree() must never delete a directory git doesn't vouch for as
// ITS worktree, or one that is dirty, unless told to force — a live session
// may be sitting in it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  worktreesRoot, worktreeKey, listWorktrees, worktreeAt, branchWorktree,
  addWorktree, removeWorktree, pruneWorktrees, orphanWorktrees,
} from '../../scripts/lib/worktree.mjs';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ---- pure: worktreeKey / worktreesRoot -------------------------------------

check('worktreeKey: normal label', worktreeKey('My Session'), 'my-session');
check('worktreeKey: slashes and dots collapse to one hyphen', worktreeKey('feat/foo..bar'), 'feat-foo-bar');
check('worktreeKey: over-length truncates to 40 then re-trims', worktreeKey('a'.repeat(50) + '---'), 'a'.repeat(40));
check('worktreeKey: empty input falls back to "session"', worktreeKey(''), 'session');
check('worktreeKey: ".." never survives', worktreeKey('..'), 'session');
check('worktreeKey: never contains a path separator', /[\\/]/.test(worktreeKey('a/b\\c')), false);
check('worktreeKey: never equals "." or ".."', ['.', '..'].includes(worktreeKey('.')), false);

check('worktreesRoot: honours an explicit home', worktreesRoot('/tmp/fake-home'), '/tmp/fake-home/.stack/worktrees');

// ---- listWorktrees never throws on a non-repo ------------------------------

check('listWorktrees: not a repository returns []', listWorktrees('/definitely/not/a/repo/xyz-229'), []);

// ---- git-backed assertions --------------------------------------------------

let gitOk = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitOk = false; }

if (!gitOk) {
  console.log('skip  git not on PATH — skipping git-backed assertions');
} else {
  const tmp = mkdtempSync(join(tmpdir(), 'stack-worktree-test-'));
  const repo = join(tmp, 'repo');
  mkdirSync(repo, { recursive: true });
  const g = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

  try {
    g(repo, ['init', '-q', '-b', 'main']);
    g(repo, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test',
      'commit', '--allow-empty', '-q', '-m', 'init']);

    // listWorktrees on a fresh repo returns the main worktree.
    const mainList = listWorktrees(repo);
    check('listWorktrees: fresh repo has exactly one entry', mainList.length, 1);
    check('listWorktrees: main entry is on branch main', mainList[0]?.branch, 'main');

    // addWorktree creates one on a new branch.
    const wtA = join(tmp, 'wt-a');
    const added = addWorktree(repo, wtA, { branch: 'feature-a' });
    check('addWorktree: ok', added.ok, true);
    check('addWorktree: created', added.created, true);
    check('addWorktree: .git exists', existsSync(join(wtA, '.git')), true);

    // reuse:true on the same path+branch adopts it instead of erroring.
    const reused = addWorktree(repo, wtA, { branch: 'feature-a', reuse: true });
    check('addWorktree: reuse same path+branch', [reused.ok, reused.created], [true, false]);

    // same path, a DIFFERENT branch — collision, existing tree undisturbed.
    const collide = addWorktree(repo, wtA, { branch: 'feature-b' });
    check('addWorktree: same path different branch refuses', collide.ok, false);
    check('addWorktree: collision names the branch that IS there', collide.reason.includes('feature-a'), true);
    check('addWorktree: collision leaves the existing tree alone', existsSync(join(wtA, '.git')), true);
    check('addWorktree: collision leaves the branch checkout unchanged', branchWorktree(repo, 'feature-a')?.path, wtA);

    // branch already checked out elsewhere — the desync guard.
    const wtB = join(tmp, 'wt-b');
    const desync = addWorktree(repo, wtB, { branch: 'feature-a' });
    check('addWorktree: branch checked out elsewhere refuses', desync.ok, false);
    check('addWorktree: desync names the existing path', desync.reason.includes(wtA), true);
    check('addWorktree: desync does not create wt-b', existsSync(wtB), false);

    // branchWorktree / worktreeAt resolve it.
    check('branchWorktree: finds feature-a at wt-a', branchWorktree(repo, 'feature-a')?.path, wtA);
    check('worktreeAt: resolves wt-a', worktreeAt(repo, wtA)?.branch, 'feature-a');
    check('worktreeAt: an unregistered path is null', worktreeAt(repo, join(tmp, 'nope')), null);

    // removeWorktree on a path that is not a worktree of this repo.
    const notWt = join(tmp, 'not-a-worktree');
    mkdirSync(notWt, { recursive: true });
    const badRemove = removeWorktree(repo, notWt);
    check('removeWorktree: refuses an unregistered path', badRemove.ok, false);
    check('removeWorktree: unregistered path is left alone', existsSync(notWt), true);

    // dirty worktree — refused without force, removed with it.
    writeFileSync(join(wtA, 'dirty.txt'), 'uncommitted\n');
    const dirtyNoForce = removeWorktree(repo, wtA);
    check('removeWorktree: refuses a dirty tree without force', dirtyNoForce.ok, false);
    check('removeWorktree: dirty refusal names it', dirtyNoForce.reason.toLowerCase().includes('uncommitted'), true);
    check('removeWorktree: dirty tree survives without force', existsSync(wtA), true);

    const dirtyForce = removeWorktree(repo, wtA, { force: true });
    check('removeWorktree: force removes a dirty tree', dirtyForce.ok, true);
    check('removeWorktree: force actually removed it', existsSync(wtA), false);

    // clean worktree — removed outright.
    const wtC = join(tmp, 'wt-c');
    addWorktree(repo, wtC, { branch: 'feature-c' });
    const cleanRemove = removeWorktree(repo, wtC);
    check('removeWorktree: clean tree ok', cleanRemove.ok, true);
    check('removeWorktree: clean tree gone', existsSync(wtC), false);

    check('pruneWorktrees: runs cleanly', pruneWorktrees(repo), true);

    // orphanWorktrees: a dead session's worktree is reported, a live one isn't.
    const root = worktreesRoot(tmp);
    const liveWt = join(root, 'live-session');
    const deadWt = join(root, 'dead-session');
    addWorktree(repo, liveWt, { branch: 'live-branch' });
    addWorktree(repo, deadWt, { branch: 'dead-branch' });
    const orphans = orphanWorktrees(repo, ['live-session'], tmp);
    check('orphanWorktrees: reports the dead one', orphans.some((w) => w.path === deadWt), true);
    check('orphanWorktrees: does not report the live one', orphans.some((w) => w.path === liveWt), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
