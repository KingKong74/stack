// Stable issue identity excludes run provenance and line numbers. Callers still
// keep those as evidence. No proposal is written by this pure triage operation.
import { contentRevision } from './skill-installations.js';
const text = v => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
export function findingIdentity(project, finding) {
  if (!project || !finding.path || !finding.trigger || !finding.title) throw Error('A finding needs project, path, trigger and title.');
  return contentRevision(JSON.stringify([text(project), text(finding.path).replace(/\\/g, '/'), text(finding.trigger)]));
}
export function triageFindings(project, findings, existing = []) {
  const seen = new Map(existing.filter(f => f.path && f.trigger && f.title).map(f => [findingIdentity(project, f), f]));
  const proposed = [], duplicates = [];
  for (const finding of findings) {
    const identity = findingIdentity(project, finding); const prior = seen.get(identity);
    if (prior) duplicates.push({ finding, identity, existingId: prior.id ?? null });
    else { const proposal = { ...finding, identity }; proposed.push(proposal); seen.set(identity, proposal); }
  }
  return { proposed, duplicates };
}
