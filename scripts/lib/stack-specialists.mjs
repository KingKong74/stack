// Project-specific roles; generic fleet-wide executor/reviewer stay independent.
import { readFileSync } from 'node:fs';
export const STACK_SPECIALISTS = [
  { key: 'stack-devils-advocate', name: "Stack Devil's Advocate", skill: 'stack-challenge', description: 'Challenge open assumptions and recovery paths with concrete counterexamples, without relitigating settled owner choices.', tools: ['Read', 'Grep', 'Glob'] },
  { key: 'stack-architect', name: 'Stack Code Architect', skill: 'stack-architecture', description: 'Trace package boundaries, shared contracts and migration behaviour in a Stack design or change.', tools: ['Read', 'Grep', 'Glob'] },
  { key: 'stack-builder', name: 'Stack Builder', skill: 'stack-build', description: 'Implement an owner-scoped Stack change and return verification evidence.', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] },
  { key: 'stack-reviewer', name: 'Stack Reviewer', skill: 'stack-review', description: 'Read a supplied Stack change and report grounded correctness or verification gaps. No shell or file-writing tools.', tools: ['Read', 'Grep', 'Glob'] },
];
export function specialistSkill(role) {
  const text = readFileSync(new URL(`../../skills/${role.skill}/SKILL.md`, import.meta.url), 'utf8');
  const fm = /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/.exec(text);
  if (!fm || fm[1] !== role.skill) throw Error(`Invalid specialist skill ${role.skill}`);
  return { name: role.skill, description: JSON.parse(fm[2]), body: text.slice(fm[0].length).trim(), scope: 'project', slug: 'stack', runtimes: ['claude', 'codex'], resources: [], enabled: true };
}
export function specialistProfile(role, skillId) {
  return { key: role.key, name: role.name, description: role.description,
    prompt: `You are ${role.name}, working only on the Stack project. Follow the linked workflow and the parent's bounded task. Preserve the owner's scope. Report actual evidence, read scope and blind spots. Do not give a human verdict or write Ready membership.`,
    model: '', tools: role.tools, enabled: true, skillIds: [skillId] };
}
