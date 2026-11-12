// End-to-end local configuration fixture. No real model, live API or user skill
// directory is used; both runtime adapters install actual files in temp worktrees.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { STACK_SPECIALISTS, specialistSkill, specialistProfile } from './lib/stack-specialists.mjs';
import { skillFile, skillRevision } from '../server/src/skill-installations.js';
import { prepareSessionConfiguration, saveSessionConfiguration, readSessionConfiguration } from '../terminal/session-configuration.mjs';
import { runSpecialistJob } from './lib/specialist-run.mjs';
const home = mkdtempSync(join(tmpdir(), 'stack-roundtrip-')), repo = join(home, 'stack'), wt = join(home, 'review'); mkdirSync(repo);
const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
try {
 git(['init']); git(['remote', 'add', 'origin', 'https://github.com/fixture/stack.git']);
 writeFileSync(join(repo, 'fixture.ts'), 'export const value = 1;\n'); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=f@f', 'commit', '-m', 'before']); const base = git(['rev-parse', 'HEAD']);
 writeFileSync(join(repo, 'fixture.ts'), 'export const value = 2;\n'); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=f@f', 'commit', '-m', 'after']); const head = git(['rev-parse', 'HEAD']); git(['worktree', 'add', '-b', 'review', wt]);
 const skills = STACK_SPECIALISTS.map((role, i) => ({ ...specialistSkill(role), id: i + 1 }));
 const profiles = STACK_SPECIALISTS.map((role, i) => specialistProfile(role, i + 1));
 const work = () => ({ projects: [{ slug: 'stack', repo: 'fixture/stack' }], checkouts: [{ repo, path: wt }],
   write: skills.flatMap(s => s.runtimes.map(runtime => ({ ...s, runtime, content: skillFile(s), revision: skillRevision(s) }))),
   keep: skills.flatMap(s => s.runtimes.map(runtime => ({ runtime, name: s.name, scope: s.scope, slug: s.slug }))) });
 const request = async (_method, path) => path === '/api/skills/work' ? work() : path === '/api/skills' ? { skills } : path === '/api/agent-profiles' ? { profiles, policy: {} } : { summary: 'Fixture', roadmap: { medium: [] }, directives: [] };
 const launch = { name: 'stack-term-roundtrip', runtime: 'claude', cwd: wt, home, repoRoot: home, profileKeys: ['stack-reviewer'], request };
 const claude = await prepareSessionConfiguration(launch);
 assert.equal(claude.snapshot.cwd, wt); assert.equal(claude.snapshot.head, head); assert.equal(claude.snapshot.dirty, false);
 assert.ok(claude.agents.executor.tools.includes('Write')); assert.deepEqual(claude.agents['stack-reviewer'].tools, ['Read', 'Grep', 'Glob']);
 assert.equal(claude.snapshot.skills.length, 5); saveSessionConfiguration(claude.snapshot, home);
 const codex = await prepareSessionConfiguration({ ...launch, name: 'stack-term-codexroundtrip', runtime: 'codex', profileKeys: [] });
 assert.equal(codex.snapshot.skills.length, 5); assert.equal(codex.agents, null);
 assert.ok(readFileSync(join(wt, '.agents/skills/stack-review/SKILL.md'), 'utf8').includes('stack-review'));
 const spec = { base, head, prompt: claude.agents['stack-reviewer'].prompt, note: 'Fixture review', includeWorkingTree: false };
 const report = await runSpecialistJob({ repo: wt, spec, invoke: async () => ({ text: JSON.stringify({ summary: 'No defect evidenced in supplied change', findings: [], read: [], blind: ['No runtime execution'] }) }) });
 assert.equal(report.provenance.head, head); assert.ok(report.blind.includes('No runtime execution'));
 const old = claude.snapshot.skills.find(s => s.name === 'stack-review').revision;
 skills.find(s => s.name === 'stack-review').body += '\nA later library edit.';
 const later = await prepareSessionConfiguration({ ...launch, name: 'stack-term-later' });
 assert.notEqual(later.snapshot.skills.find(s => s.name === 'stack-review').revision, old);
 assert.equal(readSessionConfiguration(launch.name, home, claude.snapshot.id).skills.find(s => s.name === 'stack-review').revision, old);
 console.log('PASS: installed kit → actual worktree files → Claude/Codex launch snapshots → bounded review → immutable handoff across later edits.');
} finally { rmSync(home, { recursive: true, force: true }); }
