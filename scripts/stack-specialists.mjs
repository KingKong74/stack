#!/usr/bin/env node
// Install the versioned Stack kit into the existing library. Dry until --run;
// existing user edits are conflicts, never overwritten by a seed operation.
import { loadStackEnv } from '../hook/stack-post.mjs';
import { STACK_SPECIALISTS, specialistSkill, specialistProfile } from './lib/stack-specialists.mjs';
import { skillRevision } from '../server/src/skill-installations.js';
loadStackEnv();
export async function installSpecialists({ request, run = false, roles = STACK_SPECIALISTS } = {}) {
  const [library, room] = await Promise.all([request('GET', '/api/skills'), request('GET', '/api/agent-profiles')]);
  const plan = roles.map(role => {
    const skill = specialistSkill(role);
    const existing = library.skills.find(s => s.name === skill.name && s.scope === 'project' && s.slug === 'stack');
    if (existing && skillRevision(existing) !== skillRevision(skill)) throw Error(`${skill.name}: library content differs; preserve the user's edit and reconcile explicitly.`);
    const profile = room.profiles.find(p => p.key === role.key);
    if (profile) {
      const expected = specialistProfile(role, existing?.id);
      if (!existing || profile.prompt !== expected.prompt || JSON.stringify(profile.tools) !== JSON.stringify(expected.tools)
        || JSON.stringify(profile.skillIds) !== JSON.stringify(expected.skillIds)) throw Error(`${role.key}: existing profile differs; not overwritten.`);
    }
    return { role, skill, existing, profile };
  });
  const result = [];
  for (const p of plan) {
    const skill = p.existing || (run ? await request('POST', '/api/skills', p.skill) : null);
    if (run && !p.profile) {
      const created = await request('POST', '/api/agent-profiles', specialistProfile(p.role, skill.id));
      if (JSON.stringify(created.skillIds) !== JSON.stringify([skill.id])) throw Error('Server does not support explicit skill links; profile configuration is incomplete.');
    }
    result.push({ role: p.role.key, skill: p.skill.name, skillId: skill?.id || null, action: p.profile ? 'kept' : run ? 'created' : 'would create' });
  }
  return result;
}
if (process.argv[1]?.endsWith('stack-specialists.mjs')) {
  const base = (process.env.STACK_API || '').replace(/\/$/, '');
  const request = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${process.env.STACK_TOKEN}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) }); if (!r.ok) throw Error(`HTTP ${r.status} ${path}`); return r.json(); };
  const selected = process.argv.find(a => a.startsWith('--roles='))?.slice(8).split(',');
  const roles = selected ? STACK_SPECIALISTS.filter(r => selected.includes(r.key)) : STACK_SPECIALISTS;
  if (!roles.length) throw Error('No matching specialist roles');
  installSpecialists({ request, run: process.argv.includes('--run'), roles }).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
