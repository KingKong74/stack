// In-memory library only; no model calls or live library writes.
import assert from 'node:assert/strict';
import { installSpecialists } from './stack-specialists.mjs';
import { STACK_SPECIALISTS, specialistSkill } from './lib/stack-specialists.mjs';
import { resolveProfileSkills } from '../server/src/profile-skills.js';
import { resolveSpawn, BUILTIN_PROFILES } from '../server/src/agent-profiles.js';
const skills = [], profiles = []; let writes = 0;
const request = async (method, path, body) => {
 if (method === 'GET') return path === '/api/skills' ? { skills } : { profiles };
 writes++;
 if (path === '/api/skills') { const s = { ...body, id: skills.length + 1 }; skills.push(s); return s; }
 profiles.push(body); return body;
};
await installSpecialists({ request }); assert.equal(writes, 0);
await installSpecialists({ request, run: true }); assert.equal(writes, STACK_SPECIALISTS.length * 2);
const count = writes; await installSpecialists({ request, run: true }); assert.equal(writes, count);
for (const p of profiles) {
 const prepared = resolveProfileSkills(p, skills, { runtime: 'claude', slug: 'stack' });
 assert.equal(prepared.skillRevisions.length, 1);
 assert.throws(() => resolveProfileSkills(p, skills, { runtime: 'claude', slug: 'other' }), /belongs to project/);
}
const reviewer = profiles.find(p => p.key === 'stack-reviewer');
assert.deepEqual(reviewer.tools, ['Read', 'Grep', 'Glob']);
const spawn = resolveSpawn({ profiles: [{ ...reviewer, key: 'reviewer' }], requested: 'reviewer' });
assert.ok(spawn.agents.executor.tools.includes('Write'), 'a review-only selection must retain a writable builder');
assert.equal(BUILTIN_PROFILES.find(p => p.key === 'executor').skillIds, undefined, 'generic fleet executor must not inherit project-only skills');
skills[0].body += '\nHuman edit';
await assert.rejects(() => installSpecialists({ request, run: true }), /library content differs/);
assert.equal(writes, count);
assert.equal(specialistSkill(STACK_SPECIALISTS[0]).scope, 'project');
console.log('PASS: dry/actual/idempotent kit install, explicit scope and links, reviewer permissions, builder fallback and human-edit preservation.');
