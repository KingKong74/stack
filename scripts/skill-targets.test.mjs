// Real temporary Git repo/worktree; filesystem writes never touch user skills.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverSkillTargets } from './lib/skill-targets.mjs';
import { syncSkills } from './stack-skills.mjs';
import { skillFile, contentRevision } from '../server/src/skill-installations.js';
const home = mkdtempSync(join(tmpdir(), 'stack-targets-'));
const repos = join(home, 'repos'); const repo = join(repos, 'different-folder'); const wt = join(home, 'worktrees', 'one');
const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
try {
 mkdirSync(repo, { recursive: true }); git(['init']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture']);
 git(['remote', 'add', 'origin', 'git@github.com:owner/example.git']); git(['worktree', 'add', '-b', 'fixture', wt]);
 const projects = [{ slug: 'example-project', repo: 'owner/example' }];
 const targets = discoverSkillTargets(projects, [], { home, repoRoot: repos });
 assert.equal(targets.length, 6); assert.ok(targets.some(t => t.base === wt && t.runtime === 'codex'));
 const content = skillFile({ name: 'fixture', body: 'Test' });
 let work = { projects, checkouts: [], write: ['claude', 'codex'].map(runtime => ({ runtime, id: 99, name: 'fixture', scope: 'project', slug: 'example-project', content, revision: contentRevision(content) })), keep: ['claude', 'codex'].map(runtime => ({ runtime, name: 'fixture', scope: 'project', slug: 'example-project' })) };
 let report; const request = async (method, path, body) => path.endsWith('/work') ? work : (report = body);
 const run = () => syncSkills({ request, resolveTargets: () => targets });
 await run(); assert.equal(report.skills.filter(s => s.revision).length, 4);
 assert.equal(readFileSync(join(wt, '.agents/skills/fixture/SKILL.md'), 'utf8'), content);
 // Runtime deselection removes only the managed Codex copies.
 work.write = work.write.filter(s => s.runtime === 'claude'); work.keep = work.keep.filter(s => s.runtime === 'claude'); await run();
 assert.ok(!existsSync(join(wt, '.agents/skills/fixture'))); assert.ok(existsSync(join(wt, '.claude/skills/fixture')));
 // An external link must not be traversed, written or removed.
 rmSync(join(wt, '.claude'), { recursive: true }); const outside = join(home, 'outside'); mkdirSync(outside); symlinkSync(outside, join(wt, '.claude'));
 await run(); assert.ok(!existsSync(join(outside, 'skills'))); assert.ok(report.skills.some(s => s.path.startsWith(wt) && s.status === 'error'));
 console.log('PASS: remote identity checkout resolution, Git worktrees, both runtimes, deselection and symlink refusal.');
} finally { rmSync(home, { recursive: true, force: true }); }
