// Run with a throwaway DATABASE_URL; never uses the live Stack API.
import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { pool, migrate, q } from '../src/db.js';
import { terminal } from '../src/routes/terminal.js';
import { recordTerminalConfiguration } from '../src/terminal-configurations.js';
import { skillRevision } from '../src/skill-installations.js';
if (!process.env.DATABASE_URL) throw Error('Throwaway DATABASE_URL required');
await migrate();
const app = express(); app.use('/terminal', terminal); const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
try {
 const { rows } = await q("INSERT INTO skills (name, body, enabled) VALUES ('configuration-fixture', 'Original', TRUE) RETURNING *");
 const skill = rows[0]; const snapshot = { id: randomUUID(), sessionName: 'stack-term-configfixture', runtime: 'claude', state: 'prepared', contextDelivery: 'supplied', cwd: '/fixture', createdAt: new Date().toISOString(), profiles: [], skills: [{ id: skill.id, name: skill.name, revision: skillRevision(skill), path: '/fixture/skills/fixture' }], blind: [] };
 assert.equal(await recordTerminalConfiguration(snapshot), true);
 assert.equal(await recordTerminalConfiguration({ ...snapshot, sessionName: 'stack-auto-not-allowed' }), false);
 await recordTerminalConfiguration({ ...snapshot, contextDelivery: 'CHANGED' });
 const url = `http://127.0.0.1:${server.address().port}/terminal/configurations/`;
 const first = await (await fetch(url + snapshot.id)).json();
 assert.equal(first.snapshot.contextDelivery, 'supplied'); assert.equal(first.connected, false);
 assert.ok(!first.changes.some(x => x.includes(skill.name)));
 await q('UPDATE skills SET body = $1 WHERE id = $2', ['Updated', skill.id]);
 const second = await (await fetch(url + snapshot.id)).json();
 assert.equal(second.snapshot.skills[0].revision, snapshot.skills[0].revision);
 assert.ok(second.changes.some(x => x.includes(skill.name)));
 assert.equal((await fetch(url + 'invalid')).status, 400);
 assert.equal((await fetch(url + randomUUID())).status, 404);
 console.log('PASS: immutable snapshot storage, library changes, offline visibility, invalid and missing identities.');
} finally { await new Promise(r => server.close(r)); await pool.end(); }
