#!/usr/bin/env node
// Host-only skill synchronisation. Desired state comes from the API; actual
// disk hashes go back. Unknown/malformed work deletes nothing. Unmanaged or
// symlinked files are never adopted or traversed by a background sync.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { contentRevision } from '../server/src/skill-installations.js';
import { discoverSkillTargets, safeSkillPath } from './lib/skill-targets.mjs';
import { loadStackEnv, logStderr } from '../hook/stack-post.mjs';
loadStackEnv();
const API = (process.env.STACK_API || '').replace(/\/+$/, '');
const TOKEN = process.env.STACK_TOKEN || '';
const MARKER = '.stack-managed';
const log = (msg) => logStderr(`skills ${new Date().toISOString()} · ${msg}`);
const api = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw Error(`${method} ${path} → ${r.status}`);
  return r.status === 204 ? null : r.json();
};
const runtimeOf = s => s.runtime || 'claude';
const key = s => `${runtimeOf(s)}:${s.scope}:${s.slug || ''}:${s.name}`;
const valid = s => s && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s.name) && ['claude', 'codex'].includes(runtimeOf(s))
  && ['global', 'project'].includes(s.scope) && (s.scope === 'global' ? !s.slug
    : typeof s.slug === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(s.slug) && !s.slug.includes('..'));
const targetPath = (t, ...parts) => safeSkillPath(t.base, ...[relative(t.base, t.root), 'skills', ...parts].filter(Boolean));
const markerId = path => { try { return Number(/^stack skill #(\d+)\s*$/.exec(readFileSync(path, 'utf8'))?.[1]) || null; } catch { return null; } };
function scan(t) {
  let entries; try { entries = readdirSync(targetPath(t), { withFileTypes: true }); } catch { return []; }
  return entries.filter(e => e.isDirectory() && /^[a-z0-9][a-z0-9-]{0,63}$/.test(e.name)).flatMap(e => {
    try {
      const path = targetPath(t, e.name); const bytes = readFileSync(targetPath(t, e.name, 'SKILL.md'));
      const text = bytes.toString('utf8'); const skillId = markerId(targetPath(t, e.name, MARKER));
      return [{ name: e.name, runtime: t.runtime, scope: t.scope, slug: t.slug, path,
        managed: !!skillId, skillId, revision: contentRevision(bytes),
        description: /^description:\s*(.+)$/m.exec(text)?.[1]?.replace(/^"|"$/g, '').slice(0, 1000) || '',
        body: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim().slice(0, 16_000) }];
    } catch { return []; }
  });
}
export async function syncSkills({ dry = false, request = api, resolveRoot, resolveTargets = discoverSkillTargets, onlyCwd } = {}) {
  if (request === api && (!API || !TOKEN)) { log('no API/token — nothing done'); return null; }
  let work; try { work = await request('GET', '/api/skills/work'); } catch (e) { log(`library unavailable (${e.message}) — nothing done`); return null; }
  if (!work || !Array.isArray(work.write) || !Array.isArray(work.keep)
    || !work.keep.every(valid) || !work.write.every(s => valid(s) && Number.isSafeInteger(s.id) && s.id > 0
      && typeof s.content === 'string' && (!s.revision || s.revision === contentRevision(s.content)))
    || work.write.some(s => !work.keep.some(k => key(k) === key(s)))) { log('invalid work — nothing done'); return null; }
  let targets;
  try {
    if (resolveRoot) {
      targets = [{ scope: 'global', slug: '', runtime: 'claude' }, ...work.keep].map(s => ({ ...s, runtime: runtimeOf(s), root: resolveRoot(s.scope, s.slug), base: resolveRoot(s.scope, s.slug) })).filter(t => t.root);
    } else {
      const projects = work.projects || [...new Set(work.keep.filter(s => s.scope === 'project').map(s => s.slug))].map(slug => ({ slug, repo: '' }));
      targets = resolveTargets(projects, work.checkouts || [], { repoRoot: process.env.STACK_AUTOPILOT_ROOT || homedir(), home: homedir() });
    }
  } catch (e) { log(`target discovery failed (${e.message}) — nothing done`); return null; }
  targets = targets.filter((t, i, all) => all.findIndex(x => x.root === t.root && x.runtime === t.runtime && x.slug === t.slug) === i);
  if (onlyCwd) targets = targets.filter(t => t.scope === 'global' || t.base === onlyCwd);
  const report = []; let wrote = 0, removed = 0;
  const keep = new Set(work.keep.map(key));
  for (const t of targets) {
    const wanted = work.write.filter(s => runtimeOf(s) === t.runtime && s.scope === t.scope && (s.slug || '') === t.slug);
    const errors = new Map();
    for (const s of wanted) {
      try {
        const dir = targetPath(t, s.name); const file = targetPath(t, s.name, 'SKILL.md'); const marker = targetPath(t, s.name, MARKER);
        if (existsSync(dir) && !markerId(marker)) { errors.set(s.name, 'Unmanaged directory; not overwritten.'); continue; }
        let current; try { current = readFileSync(file, 'utf8'); } catch { /* new file */ }
        if (current === s.content && markerId(marker) === s.id) continue;
        if (!dry) { mkdirSync(dir, { recursive: true }); writeFileSync(file, s.content, { mode: 0o600 }); writeFileSync(marker, `stack skill #${s.id}\n`, { mode: 0o600 }); }
        wrote++;
      } catch (e) { errors.set(s.name, e.message); }
    }
    for (const found of scan(t)) {
      if (!found.managed || keep.has(key(found))) continue;
      try {
        const path = targetPath(t, found.name); const marker = targetPath(t, found.name, MARKER);
        if (markerId(marker) !== found.skillId || !lstatSync(path).isDirectory()) continue;
        if (!dry) rmSync(path, { recursive: true, force: true }); removed++;
      } catch { /* fail safe */ }
    }
    const observed = scan(t);
    report.push(...observed);
    for (const s of wanted) if (!observed.some(o => o.name === s.name)) report.push({ name: s.name, scope: s.scope, slug: s.slug || '', runtime: t.runtime,
      path: join(t.root, 'skills', s.name), managed: false, skillId: s.id, revision: null,
      status: errors.has(s.name) ? 'error' : 'missing', error: errors.get(s.name) || '' });
  }
  const detail = `${dry ? 'dry run: ' : ''}${wrote} written, ${removed} removed, ${targets.length} runtime targets`;
  if (!dry && !onlyCwd) { try { await request('POST', '/api/skills/report', { skills: report, observedAt: new Date().toISOString(), detail }); } catch (e) { log(`report failed (${e.message})`); } }
  log(detail); return { wrote, removed, onDisk: report.filter(s => s.revision).length, detail, observations: report };
}
export async function main(argv = []) { await syncSkills({ dry: argv.includes('--dry') }); return 0; }
if (process.argv[1]?.endsWith('stack-skills.mjs')) main(process.argv.slice(2)).catch(e => { log(e.message); process.exitCode = 1; });
