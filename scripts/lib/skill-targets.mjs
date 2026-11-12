// Local runtime adapters. Only verified repositories and their registered Git
// worktrees are targets; every filesystem component under a target is guarded.
import { lstatSync, realpathSync, readdirSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { listWorktrees } from './worktree.mjs';
export const SKILL_RUNTIMES = Object.freeze({ claude: '.claude', codex: '.agents' });
const git = (cwd, args) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 }); return r.status === 0 ? r.stdout.trim() : ''; };
const repoKey = (value) => String(value || '').replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
const inside = (root, path) => path === root || path.startsWith(root + sep);
export function safeSkillPath(base, ...parts) {
  const root = realpathSync(base);
  const dest = resolve(root, ...parts);
  if (!inside(root, dest) || parts.some(p => isAbsolute(p) || p.split(/[\\/]/).some(x => !x || x === '.' || x === '..'))) throw Error('Unsafe skill path');
  let current = root;
  for (const part of relative(root, dest).split(sep)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw Error('Symlink target refused'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return dest;
}
export function discoverSkillTargets(projects, registrations = [], { repoRoot = homedir(), home = homedir() } = {}) {
  const targets = Object.entries(SKILL_RUNTIMES).map(([runtime, folder]) => ({ runtime, base: home, root: join(home, folder), scope: 'global', slug: '' }));
  let children = []; try { children = readdirSync(repoRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(repoRoot, e.name)); } catch { /* no checkout discovery */ }
  const allowed = [realpathSync(home), realpathSync(repoRoot)];
  const candidates = [...new Set([...children, ...registrations.flatMap(r => [r.repo, r.path])].filter(x => typeof x === 'string' && isAbsolute(x)))];
  const checkouts = candidates.flatMap(candidate => {
    let primary; try { primary = realpathSync(candidate); } catch { return []; }
    if (!allowed.some(a => inside(a, primary)) || git(primary, ['rev-parse', '--show-toplevel']) !== primary) return [];
    return [{ primary, remote: git(primary, ['remote', 'get-url', 'origin']) }];
  });
  for (const p of projects) {
    for (const { primary, remote } of checkouts) {
      if (p.repo ? repoKey(remote) !== repoKey(p.repo) : primary !== join(resolve(repoRoot), p.slug)) continue;
      const common = git(primary, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      for (const wt of listWorktrees(primary)) {
        let path; try { path = realpathSync(wt.path); } catch { continue; }
        if (wt.prunable || !allowed.some(a => inside(a, path)) || git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== common) continue;
        for (const [runtime, folder] of Object.entries(SKILL_RUNTIMES)) {
          if (!targets.some(t => t.runtime === runtime && t.base === path && t.slug === p.slug)) targets.push({ runtime, base: path, root: join(path, folder), scope: 'project', slug: p.slug });
        }
      }
    }
  }
  return targets;
}
