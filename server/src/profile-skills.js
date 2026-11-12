// Runtime-neutral preparation: explicit links are required workflows, not
// permission grants or proof that a model invoked a skill.
import { skillRevision, contentRevision } from './skill-installations.js';
export function resolveProfileSkills(profile, library, { runtime, slug } = {}) {
  const selected = (profile.skillIds || []).map(id => {
    const s = library.find(s => s.id === id);
    if (!s) throw Error(`${profile.name}: linked skill #${id} is missing. Relink or remove it.`);
    if (!s.enabled) throw Error(`${profile.name}: skill ${s.name} is disabled. Enable it or unlink it.`);
    if (!(s.runtimes || ['claude']).includes(runtime)) throw Error(`${profile.name}: skill ${s.name} does not support ${runtime}.`);
    if (s.scope === 'project' && s.slug !== slug) throw Error(`${profile.name}: skill ${s.name} belongs to project ${s.slug}.`);
    return s;
  });
  const context = selected.map(s => `Required workflow: ${s.name} (#${s.id}, revision ${skillRevision(s)})\n${s.body}\n`
    + (s.resources || []).map(r => `Resource ${r.path} (relative to the skill directory):\n${r.content}`).join('\n')).join('\n\n');
  if (context.length > 64000) throw Error(`${profile.name}: linked skill context exceeds 64,000 characters. Reduce the linked resources.`);
  return { ...profile, prompt: context ? `${profile.prompt}\n\n${context}` : profile.prompt,
    skillRevisions: selected.map(s => ({ id: s.id, name: s.name, revision: skillRevision(s) })),
    profileRevision: contentRevision(JSON.stringify({ key: profile.key, description: profile.description || '', enabled: profile.enabled, prompt: profile.prompt, model: profile.model, tools: profile.tools, skillIds: profile.skillIds || [] })) };
}
