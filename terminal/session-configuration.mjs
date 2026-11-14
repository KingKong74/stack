// A launch snapshot records supplied configuration, never model invocation.
// Stored outside repositories and keyed to a tmux option so an external session
// reusing an old name cannot inherit an unrelated snapshot. No credentials stored.
// It injects no starting prompt: Claude's SessionStart hook already supplies the
// resume card, and a prepended brief reads as a message the owner typed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validName } from './tmux-session.mjs';
import { resolveSpawn } from '../server/src/agent-profiles.js';
import { resolveProfileSkills } from '../server/src/profile-skills.js';
import { contentRevision, skillRevision } from '../server/src/skill-installations.js';
import { discoverSkillTargets, safeSkillPath } from '../scripts/lib/skill-targets.mjs';
import { syncSkills } from '../scripts/stack-skills.mjs';
const git = (cwd, args) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 }); return r.status === 0 ? r.stdout.trim() : ''; };
const dirtyState = cwd => { const r = spawnSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8', timeout: 5000 }); return r.status === 0 ? !!r.stdout.trim() : null; };
const version = runtime => { const r = spawnSync(runtime, ['--version'], { encoding: 'utf8', timeout: 3000 }); return r.status === 0 ? r.stdout.trim().slice(0, 120) : null; };
export async function prepareSessionConfiguration({ name, runtime, cwd, profileKeys = [], request, home = homedir(), repoRoot = process.env.STACK_AUTOPILOT_ROOT || homedir(), sync = syncSkills }) {
  if (!Array.isArray(profileKeys) || profileKeys.length > 6 || profileKeys.some(k => !/^[a-z][a-z0-9-]{1,39}$/.test(k))) throw Error('Choose up to six valid agent profiles.');
  if (runtime === 'codex' && profileKeys.length) throw Error('Stack spawn profiles are currently supported by Claude only. Start Codex without profiles; compatible skills still apply.');
  const root = git(cwd, ['rev-parse', '--show-toplevel']) || cwd;
  const snapshot = { id: randomUUID(), sessionName: name, runtime, runtimeVersion: version(runtime), cwd, checkout: root,
    branch: git(cwd, ['branch', '--show-current']) || null, head: git(cwd, ['rev-parse', 'HEAD']) || null,
    dirty: dirtyState(cwd),
    project: null, createdAt: new Date().toISOString(), state: 'prepared', contextDelivery: 'none', profiles: [], skills: [], blind: [] };
  let work, library, room;
  try {
    [work, library, room] = await Promise.all([request('GET', '/api/skills/work'), request('GET', '/api/skills'), request('GET', '/api/agent-profiles')]);
    if (!Array.isArray(work.projects) || !Array.isArray(library.skills) || !Array.isArray(room.profiles)) throw Error('Configuration API is unavailable or outdated.');
  } catch (e) {
    if (profileKeys.length) throw Error(`Required configuration unavailable: ${e.message}`);
    snapshot.state = 'unknown'; snapshot.blind.push('Stack configuration could not be read; repository/runtime defaults still apply.');
    return { snapshot, agents: null };
  }
  const targets = discoverSkillTargets(work.projects, [...(work.checkouts || []), { repo: root, path: root }], { repoRoot, home });
  snapshot.project = targets.find(t => t.base === root && t.scope === 'project')?.slug || null;
  const result = await sync({ onlyCwd: root, request: (method, path, body) => path === '/api/skills/work' ? Promise.resolve(work) : request(method, path, body), resolveTargets: () => targets });
  const observations = result?.observations || [];
  snapshot.skills = library.skills.filter(s => s.enabled && (s.runtimes || ['claude']).includes(runtime) && (s.scope === 'global' || s.slug === snapshot.project)).flatMap(s => {
    const observed = observations.find(o => o.skillId === s.id && o.runtime === runtime && o.managed && o.revision === skillRevision(s));
    if (!observed) { snapshot.blind.push(`Skill ${s.name} could not be confirmed in this checkout/runtime.`); return []; }
    return [{ id: s.id, name: s.name, revision: skillRevision(s), path: observed.path }];
  });
  let agents = null;
  if (profileKeys.length) {
    for (const key of profileKeys) if (!room.profiles.some(p => p.key === key && p.enabled)) throw Error(`Profile ${key} is missing or disabled.`);
    const chosen = resolveSpawn({ profiles: room.profiles, requested: profileKeys });
    const resolved = chosen.keys.map(key => {
      const profile = chosen.profiles.find(p => p.key === key);
      const ready = resolveProfileSkills(profile, library.skills, { runtime, slug: snapshot.project });
      for (const s of ready.skillRevisions) if (!snapshot.skills.some(x => x.id === s.id && x.revision === s.revision)) throw Error(`${profile.name}: required skill ${s.name} is not installed for this runtime/checkout.`);
      ready.model = ready.model || room.policy?.executorModel || '';
      snapshot.profiles.push({ key, revision: ready.profileRevision, model: ready.model || null, tools: ready.tools, skills: ready.skillRevisions });
      return ready;
    });
    agents = Object.fromEntries(resolved.map(p => [p.key, { description: p.description || '', prompt: p.prompt, ...(p.model ? { model: p.model } : {}), tools: p.tools }]));
    if (JSON.stringify(agents).length > 32000) throw Error('Selected profile definitions exceed 32,000 characters. Select fewer profiles.');
  }
  if (runtime === 'codex') snapshot.blind.push('Stack spawn profiles are not supplied to Codex. Automatic usage/edit tracking is not integrated.');
  snapshot.configurationRevision = contentRevision(JSON.stringify({ profiles: snapshot.profiles, skills: snapshot.skills }));
  return { snapshot, agents };
}
function configPath(name, home) { if (!validName(name)) throw Error('Invalid session name'); return safeSkillPath(home, '.stack/session-config', `${name}.json`); }
export function saveSessionConfiguration(snapshot, home = homedir()) {
  const path = configPath(snapshot.sessionName, home); mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 }); writeFileSync(path, JSON.stringify(snapshot), { mode: 0o600 });
}
export function readSessionConfiguration(name, home = homedir(), option) {
  try {
    const id = option ?? spawnSync('tmux', ['show-options', '-qv', '-t', `=${name}:`, '@stack-configuration'], { encoding: 'utf8', timeout: 3000 }).stdout.trim();
    if (!id) return null;
    const snapshot = JSON.parse(readFileSync(configPath(name, home), 'utf8'));
    return snapshot.id === id ? snapshot : null;
  } catch { return null; }
}
export function tagSessionConfiguration(name, id) {
  if (validName(name) && /^[a-f0-9-]{36}$/.test(id)) spawnSync('tmux', ['set-option', '-t', `=${name}:`, '@stack-configuration', id], { stdio: 'ignore', timeout: 3000 });
}
