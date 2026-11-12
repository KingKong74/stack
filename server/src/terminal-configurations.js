// Immutable host-reported launch evidence. A snapshot describes what was
// supplied, not what a model loaded, invoked or spent.
import { q } from './db.js';
import { resolveProfileSkills } from './profile-skills.js';
import { skillRevision } from './skill-installations.js';
export function validConfiguration(s) {
  return s && /^[a-f0-9-]{36}$/.test(s.id) && /^stack-term-[A-Za-z0-9_-]{1,64}$/.test(s.sessionName)
    && ['claude', 'codex'].includes(s.runtime) && ['prepared', 'unknown'].includes(s.state)
    && typeof s.cwd === 'string' && typeof s.createdAt === 'string' && Number.isFinite(Date.parse(s.createdAt))
    && Array.isArray(s.profiles) && s.profiles.length <= 7 && Array.isArray(s.skills) && s.skills.length <= 200
    && Array.isArray(s.blind) && JSON.stringify(s).length <= 64000;
}
export async function recordTerminalConfiguration(snapshot) {
  if (!validConfiguration(snapshot)) return false;
  await q(`INSERT INTO terminal_configurations (id, session_name, snapshot) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO NOTHING`, [snapshot.id, snapshot.sessionName, JSON.stringify(snapshot)]);
  return true;
}
export function configurationChanges(snapshot, profiles, skills, executorModel = '') {
  const changes = [];
  for (const old of snapshot.skills) {
    const now = skills.find(s => s.id === old.id);
    if (!now || !now.enabled || !(now.runtimes || ['claude']).includes(snapshot.runtime) || (now.scope === 'project' && now.slug !== snapshot.project) || skillRevision(now) !== old.revision) changes.push(`Skill ${old.name} changed or is unavailable.`);
  }
  for (const skill of skills) {
    if (skill.enabled && (skill.runtimes || ['claude']).includes(snapshot.runtime) && (skill.scope === 'global' || skill.slug === snapshot.project)
      && !snapshot.skills.some(s => s.id === skill.id)) changes.push(`Skill ${skill.name} is now available in the library.`);
  }
  for (const old of snapshot.profiles) {
    const now = profiles.find(p => p.key === old.key);
    try {
      if (!now || !now.enabled) throw Error('unavailable');
      const current = resolveProfileSkills(now, skills, { runtime: snapshot.runtime, slug: snapshot.project });
      if (current.profileRevision !== old.revision || (now.model || executorModel || null) !== old.model) changes.push(`Profile ${old.key} changed.`);
    } catch { changes.push(`Profile ${old.key} or a required skill is unavailable.`); }
  }
  return changes;
}
