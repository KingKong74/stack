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
  const revision = contentRevision(skillFile(skill));
  const age = now - Date.parse(report.when);
  const fresh = Number.isFinite(age) && age >= -60_000 && age <= REPORT_TTL_MS;
  const matching = report.skills.filter((s) => s.name === skill.name && s.scope === skill.scope && s.slug === (skill.slug || ''));
  const installations = matching.map((s) => ({
    runtime: s.runtime || 'unknown', path: s.path, revision: s.revision || null,
    requestedRevision: revision, observedAt: report.when,
    state: !fresh || !s.runtime || !s.revision ? 'unknown'
      : !s.managed || s.skillId !== skill.id ? 'conflict'
      : s.revision === revision ? 'installed' : 'pending',
  }));
  // Currently Stack installs Claude skills only. Other runtime observations
  // remain separate evidence; they cannot certify the Claude target.
  const targets = installations.filter((s) => s.runtime === 'claude');
  const installationState = !skill.enabled ? 'disabled' : !fresh ? 'unknown'
    : targets.some((s) => s.state === 'conflict') ? 'conflict'
    : targets.some((s) => s.state === 'unknown') || (!targets.length && installations.some((s) => s.state === 'unknown')) ? 'unknown'
    : targets.length && targets.every((s) => s.state === 'installed') ? 'installed' : 'pending';
  return { revision, installations, installationState,
    installedAt: installationState === 'installed' ? report.when : null };
}
