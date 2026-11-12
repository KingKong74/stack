// Shared immutable manual/loop input validation; no enqueue or model call.
import { q } from './db.js';
import { mergeProfiles } from './agent-profiles.js';
import { resolveProfileSkills } from './profile-skills.js';
import { readSettings } from './settings.js';
export async function prepareSpecialistSpec(b, slug, client) {
  const run = client ? (text,params) => client.query(text,params) : q;
  if (!/^[a-f0-9-]{36}$/.test(b.requestId) || !/^[a-f0-9]{40}$/.test(b.head) || !/^[a-f0-9]{40}$/.test(b.base)) throw Error('Provide requestId and exact base/head commit hashes.');
  const paths = b.paths ?? [];
  if (!Array.isArray(paths) || paths.length > 8 || paths.some(p => typeof p !== 'string' || !/^[a-zA-Z0-9_.\/-]{1,200}$/.test(p) || p.startsWith('/') || p.split('/').some(x => !x || x === '.' || x === '..'))) throw Error('Choose up to eight literal relative file paths.');
  if (b.runtime && b.runtime !== 'claude') throw Error('Diagnostic jobs currently support native Claude only.');
  if (b.profileKey === 'stack-builder' || b.profileKey === 'executor') throw Error('Use a terminal for implementation. Diagnostic jobs only annotate supplied evidence.');
  const stored = await run('SELECT * FROM agent_profiles');
  const library = await run('SELECT s.*, p.slug FROM skills s LEFT JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL');
  const settings = await readSettings(client);
  const p = mergeProfiles(stored.rows.map(p => ({ ...p, skillIds: p.skill_ids || [] }))).find(p => p.key === b.profileKey && p.enabled);
  if (!p) throw Error('Select an enabled diagnostic profile.');
  let prepared; try { prepared = resolveProfileSkills(p, library.rows, { runtime: 'claude', slug: slug }); } catch (e) { throw Error(e.message); }
  const model = p.model || settings.autopilot_executor_model || '';
  if (model && !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(model)) throw Error('This model identifier is not supported by the native diagnostic adapter.');
  return { profileKey: p.key, profileName: p.name, profileRevision: prepared.profileRevision, prompt: prepared.prompt,
    model, skills: prepared.skillRevisions,
    base: b.base, head: b.head, includeWorkingTree: b.includeWorkingTree === true,
    paths, mode: 'evidence-only', grantedTools: [], configuredProfileTools: p.tools,
    maxSeconds: Math.min(180, Math.max(10, Number(b.maxSeconds) || 90)), maxTurns: 1,
    note: String(b.note || '').slice(0, 2000), requestedAt: new Date().toISOString() };
}
