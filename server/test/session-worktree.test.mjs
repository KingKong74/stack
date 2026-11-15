// A refused own-branch launch gives back its tree and branch, and never more than it made.
// Pure: a throwaway git repo with no remote (the best-effort fetch fails fast). Run: node server/test/session-worktree.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeBranchSession, discardBranchSession } from '../../terminal/session-worktree.mjs';

const home = mkdtempSync(join(tmpdir(), 'stack-sessionwt-'));
const repo = join(home, 'project'); mkdirSync(repo);
const git = (cwd, args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=f@f', ...args], { encoding: 'utf8' });
const hasBranch = b => git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).status === 0;
git(repo, ['init', '-q', '-b', 'main']); git(repo, ['commit', '-q', '--allow-empty', '-m', 'base']);
const make = name => { const r = makeBranchSession({ cwd: repo, tmuxName: name, root: home, home }); assert.ok(r.ok, r.reason); return r; };

try {
  // Clean refusal: tree and branch both go.
  const a = make('stack-term-aaaa0001');
  assert.ok(a.made?.branchCreated && existsSync(a.made.path));
  assert.ok(discardBranchSession(a.made).ok);
  assert.ok(!existsSync(a.made.path), 'tree removed'); assert.ok(!hasBranch(a.branch), 'branch removed');

  // Dirty tree: nothing is touched (fail safe).
  const b = make('stack-term-aaaa0002');
  writeFileSync(join(b.made.path, 'work.txt'), 'unsaved');
  assert.equal(discardBranchSession(b.made).ok, false);
  assert.ok(existsSync(b.made.path) && hasBranch(b.branch), 'dirty tree and its branch kept');

  // Branch moved since the cut: the clean tree goes, the commit's branch stays.
  const c = make('stack-term-aaaa0003');
  git(c.made.path, ['commit', '-q', '--allow-empty', '-m', 'real work']);
  const rc = discardBranchSession(c.made);
  assert.ok(rc.ok && /kept/.test(rc.reason)); assert.ok(!existsSync(c.made.path)); assert.ok(hasBranch(c.branch), 'moved branch kept');

  // A branch that existed before the launch is never deleted.
  git(repo, ['branch', 'term/aaaa0004']);
  const d = make('stack-term-aaaa0004');
  assert.equal(d.made.branchCreated, false);
  assert.ok(discardBranchSession(d.made).ok); assert.ok(hasBranch('term/aaaa0004'), 'pre-existing branch kept');

  // Nothing made, nothing done.
  assert.ok(discardBranchSession(null).ok);
  console.log('PASS: refused own-branch launches discard only a clean tree and a branch they cut and left unmoved.');
} finally { rmSync(home, { recursive: true, force: true }); }
