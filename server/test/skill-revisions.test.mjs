// DATABASE_URL must point at a fresh throwaway database. No live Stack API used.
import assert from 'node:assert/strict';
import express from 'express';
import { pool, migrate } from '../src/db.js';
import { skills } from '../src/routes/skills.js';
import { installationEvidence, REPORT_TTL_MS } from '../src/skill-installations.js';
if (!process.env.DATABASE_URL) throw Error('A throwaway DATABASE_URL is required');
await migrate();
const app = express(); app.use(express.json()); app.use('/skills', skills);
const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
async function api(method, path, body, status = 200) {
 const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
 assert.equal(r.status, status, await r.clone().text()); return r.json();
}
try {
 const skill = await api('POST', '/skills', { name: 'revision-test', description: 'Test', body: 'Version A' }, 201);
 const first = (await api('GET', '/skills/work')).write[0];
 const observation = { name: first.name, scope: 'global', slug: '', managed: true, skillId: skill.id, runtime: 'claude', path: '/fixture/claude/skills/revision-test', revision: first.revision };
 const now = Date.now();
 await api('POST', '/skills/report', { observedAt: new Date(now).toISOString(), skills: [observation] });
 let data = await api('GET', '/skills');
 assert.equal(data.skills[0].installationState, 'installed');
 await api('PATCH', `/skills/${skill.id}`, { body: 'Version B' });
 const second = (await api('GET', '/skills/work')).write[0]; assert.notEqual(first.revision, second.revision);
 await api('POST', '/skills/report', { observedAt: new Date(now + 1).toISOString(), skills: [observation], installed: [skill.id] });
 data = await api('GET', '/skills'); assert.equal(data.skills[0].installationState, 'pending'); assert.equal(data.skills[0].installedAt, null);
 const current = { ...observation, revision: second.revision };
 await api('POST', '/skills/report', { observedAt: new Date(now + 2).toISOString(), skills: [current] });
 await api('POST', '/skills/report', { observedAt: new Date(now).toISOString(), skills: [observation] });
 data = await api('GET', '/skills'); assert.equal(data.skills[0].installationState, 'installed');
 const other = { ...current, runtime: 'codex', path: '/fixture/codex/skills/revision-test', revision: first.revision };
 const conflict = { ...current, path: '/fixture/worktree/skills/revision-test', managed: false };
 await api('POST', '/skills/report', { observedAt: new Date(now + 3).toISOString(), skills: [current, other, conflict] });
 data = await api('GET', '/skills'); assert.equal(data.skills[0].installationState, 'conflict');
 assert.deepEqual(data.skills[0].installations.map(x => x.state), ['installed', 'pending', 'conflict']);
 assert.equal(data.skills[0].installations[1].runtime, 'codex');
 const row = { ...skill, body: 'Version B' };
 assert.equal(installationEvidence(row, { when: new Date(now - REPORT_TTL_MS - 1).toISOString(), skills: [current] }, now).installationState, 'unknown');
 // use a newer timestamp so the legacy snapshot is actually accepted
 await api('POST', '/skills/report', { observedAt: new Date(now + 4).toISOString(), skills: [{ ...current, revision: undefined, runtime: undefined }], installed: [skill.id] });
 data = await api('GET', '/skills'); assert.equal(data.skills[0].installationState, 'unknown'); assert.equal(data.skills[0].installedAt, null);
 await api('POST', '/skills/report', { skills: [{}] }, 400);
 await api('POST', '/skills/report', { observedAt: 'invalid', skills: [] }, 400);
 await api('PATCH', `/skills/${skill.id}`, { runtimes: ['invalid'] }, 400);
 await api('PATCH', `/skills/${skill.id}`, { runtimes: ['claude', 'codex'] });
 await api('POST', '/skills/report', { observedAt: new Date(now + 5).toISOString(), skills: [current] });
 data = await api('GET', '/skills'); assert.equal(data.skills[0].installationState, 'pending');
 await api('POST', '/skills/report', { observedAt: new Date(now + 6).toISOString(), skills: [current, { ...other, revision: second.revision }] });
 data = await api('GET', '/skills'); assert.equal(data.skills[0].installationState, 'installed');
 assert.deepEqual(data.skills[0].runtimes, ['claude', 'codex']);
 await api('PATCH', `/skills/${skill.id}`, { enabled: false });
 data = await api('GET', '/skills'); assert.equal(data.skills[0].installationState, 'disabled');
 console.log('PASS: exact revisions, delayed and out-of-order reports, independent runtime/path observations, conflicts, stale and legacy evidence, validation and disable.');
} finally { await new Promise(r => server.close(r)); await pool.end(); }
