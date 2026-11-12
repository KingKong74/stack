// Installation evidence is scoped to a runtime and exact directory. A file
// hash proves bytes on disk, not discovery or invocation by a running agent.
import { createHash } from 'node:crypto';
export const REPORT_TTL_MS = 15 * 60_000;
export const contentRevision = (content) => createHash('sha256').update(content).digest('hex');
export const skillFile = (s) => {
  const desc = (s.description || '').replace(/\s+/g, ' ').trim();
  return `---\nname: ${s.name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${(s.body || '').trim()}\n`;
};
export function installationEvidence(skill, report, now = Date.now()) {
  const revision = skillRevision(skill);
  const age = now - Date.parse(report.when);
  const fresh = Number.isFinite(age) && age >= -60_000 && age <= REPORT_TTL_MS;
  const matching = report.skills.filter((s) => s.name === skill.name && s.scope === skill.scope && s.slug === (skill.slug || ''));
  const installations = matching.map((s) => ({
    runtime: s.runtime || 'unknown', path: s.path, revision: s.revision || null,
    requestedRevision: revision, observedAt: report.when,
    state: !fresh || !s.runtime || s.runtime === 'unknown' || s.status === 'error' ? 'unknown'
      : s.status === 'missing' ? 'pending'
      : !s.revision ? 'unknown'
      : !s.managed || s.skillId !== skill.id ? 'conflict'
      : s.revision === revision ? 'installed' : 'pending',
  }));
  // Every requested runtime needs evidence; one runtime cannot certify another.
  const runtimes = skill.runtimes || ['claude'];
  const targets = installations.filter((s) => runtimes.includes(s.runtime));
  const installationState = !skill.enabled ? 'disabled' : !fresh ? 'unknown'
    : targets.some((s) => s.state === 'conflict') ? 'conflict'
    : targets.some((s) => s.state === 'unknown') || (!targets.length && installations.some((s) => s.state === 'unknown')) ? 'unknown'
    : runtimes.every(r => targets.some(t => t.runtime === r)) && targets.every((s) => s.state === 'installed') ? 'installed' : 'pending';
  return { revision, installations, installationState,
    installedAt: installationState === 'installed' ? report.when : null };
}

// Text resources only; no absolute paths, traversal, reserved files or binary payloads.
export function cleanSkillResources(value = []) {
  if (!Array.isArray(value) || value.length > 20) throw Error('A skill supports up to 20 text resources.');
  const seen = new Set(); let size = 0;
  return value.map(r => {
    if (!r || typeof r.path !== 'string' || !/^(scripts|references|assets)\/[a-zA-Z0-9_./-]+$/.test(r.path)
      || r.path.length > 200 || r.path.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))
      || seen.has(r.path) || typeof r.content !== 'string' || Buffer.byteLength(r.content) > 32768) throw Error('Invalid or duplicate skill resource path/content.');
    seen.add(r.path); size += Buffer.byteLength(r.content);
    if (size > 262144) throw Error('Skill resources exceed 256 KiB.');
    return { path: r.path, content: r.content };
  }).sort((a, b) => a.path.localeCompare(b.path));
}
export const bundleRevision = (content, resources = []) => resources.length
  ? contentRevision(JSON.stringify([content, cleanSkillResources(resources)])) : contentRevision(content);
export const skillRevision = s => bundleRevision(skillFile(s), s.resources || []);
