// No agents or real skills are launched. All files and API responses are fixtures.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareSessionConfiguration, saveSessionConfiguration, readSessionConfiguration } from '../../terminal/session-configuration.mjs';
import { skillRevision } from '../src/skill-installations.js';
const home = mkdtempSync(join(tmpdir(), 'stack-config-')); const cwd = join(home, 'project'); mkdirSync(cwd);
const g = args => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
g(['init']); g(['remote', 'add', 'origin', 'https://github.com/fixture/project.git']);
g(['-c', 'user.name=Fixture', '-c', 'user.email=f@f', 'commit', '--allow-empty', '-m', 'fixture']);
const skill = { id: 1, name: 'fixture', scope: 'project', slug: 'fixture', body: 'Verify evidence', enabled: true, runtimes: ['claude', 'codex'] };
const profiles = [{ key: 'executor', name: 'Builder', description: 'Build', prompt: 'Implement scoped changes', model: '', enabled: true, tools: ['Read', 'Write'], skillIds: [1] }];
const request = async (_method, path) => path === '/api/skills/work' ? { projects: [{ slug: 'fixture', repo: 'fixture/project' }], checkouts: [] }
 : path === '/api/skills' ? { skills: [skill] } : path === '/api/agent-profiles' ? { profiles, policy: { executorModel: 'sonnet' } } : null;
const sync = async () => ({ observations: [{ skillId: 1, runtime: 'claude', managed: true, revision: skillRevision(skill), path: join(cwd, '.claude/skills/fixture') }, { skillId: 1, runtime: 'codex', managed: true, revision: skillRevision(skill), path: join(cwd, '.agents/skills/fixture') }] });
try {
 const prepared = await prepareSessionConfiguration({ name: 'stack-term-fixture', runtime: 'claude', cwd, profileKeys: ['executor'], home, repoRoot: home, request, sync });
 assert.equal(prepared.snapshot.project, 'fixture'); assert.equal(prepared.snapshot.dirty, false);
 assert.equal(prepared.snapshot.profiles[0].model, 'sonnet'); assert.ok(prepared.agents.executor.prompt.includes('Verify evidence'));
 assert.equal('brief' in prepared, false); assert.equal(prepared.snapshot.contextDelivery, 'none');
 saveSessionConfiguration(prepared.snapshot, home);
 assert.deepEqual(readSessionConfiguration('stack-term-fixture', home, prepared.snapshot.id), prepared.snapshot);
 assert.equal(readSessionConfiguration('stack-term-fixture', home, 'different-launch-id'), null);
 const unknown = await prepareSessionConfiguration({ name: 'stack-term-unknown', runtime: 'codex', cwd, home, request: async () => { throw Error('offline'); } });
 assert.equal(unknown.snapshot.state, 'unknown');
 await assert.rejects(() => prepareSessionConfiguration({ name: 'stack-term-x', runtime: 'claude', cwd, profileKeys: ['executor'], request: async () => { throw Error('offline'); } }), /Required configuration unavailable/);
 await assert.rejects(() => prepareSessionConfiguration({ name: 'stack-term-x', runtime: 'codex', cwd, profileKeys: ['executor'], request }), /Claude only/);
 await assert.rejects(() => prepareSessionConfiguration({ name: 'stack-term-x', runtime: 'claude', cwd, profileKeys: ['executor'], home, repoRoot: home, request, sync: async () => null }), /not installed/);
 const codex = await prepareSessionConfiguration({ name: 'stack-term-codex', runtime: 'codex', cwd, home, repoRoot: home, request, sync });
 assert.equal(codex.snapshot.skills.length, 1); assert.equal(codex.agents, null); assert.ok(codex.snapshot.blind.some(x => x.includes('not supplied')));
 console.log('PASS: exact snapshots, no injected starting context, persisted identity, offline/required failures and explicit Codex limitations.');
} finally { rmSync(home, { recursive: true, force: true }); }
