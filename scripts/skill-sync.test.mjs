// Uses a temporary directory and in-memory API; never syncs real user skills.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncSkills } from './stack-skills.mjs';
import { skillFile, contentRevision, bundleRevision } from '../server/src/skill-installations.js';
const root = mkdtempSync(join(tmpdir(), 'stack-skill-test-'));
const content = skillFile({ name: 'example', body: 'Original' });
let work = { write: [{ id: 81, name: 'example', scope: 'global', slug: '', runtime: 'claude', content, revision: contentRevision(content) }], keep: [{ name: 'example', scope: 'global', slug: '' }] };
let report;
const request = async (method, path, body) => {
 if (path === '/api/skills/work') return work;
 if (method === 'POST') { report = body; return { ok: true }; }
 return { report: { skills: [] } };
};
const run = () => syncSkills({ request, resolveRoot: () => root });
try {
 await run();
 assert.equal(report.skills[0].revision, contentRevision(readFileSync(join(root, 'skills/example/SKILL.md'))));
 assert.equal(report.skills[0].skillId, 81); assert.equal(report.skills[0].runtime, 'claude');
 assert.ok(report.observedAt); assert.equal(report.installed, undefined);
 report = null; const steady = await run(); assert.equal(steady.wrote, 0); assert.ok(report.skills[0].revision);
 const resources = [{ path: 'references/check.md', content: 'Verify the actual diff' }];
 work.write[0] = { ...work.write[0], resources, revision: bundleRevision(content, resources) };
 await run(); assert.equal(readFileSync(join(root, 'skills/example/references/check.md'), 'utf8'), resources[0].content);
 assert.equal(report.skills[0].revision, bundleRevision(content, resources));
 work.write[0] = { ...work.write[0], resources: [], revision: contentRevision(content) };
 await run(); assert.equal(existsSync(join(root, 'skills/example/references/check.md')), false);
 writeFileSync(join(root, 'skills/example/SKILL.md'), 'Hand edit'); await run();
 assert.equal(report.skills[0].revision, contentRevision(content));
 mkdirSync(join(root, 'skills/foreign')); writeFileSync(join(root, 'skills/foreign/SKILL.md'), 'Keep me');
 work = { write: [{ ...work.write[0], name: 'foreign' }], keep: [{ name: 'foreign', scope: 'global', slug: '' }, { name: 'example', scope: 'global', slug: '' }] };
 await run(); assert.equal(readFileSync(join(root, 'skills/foreign/SKILL.md'), 'utf8'), 'Keep me');
 assert.equal(report.skills.find(x => x.name === 'foreign').managed, false);
 work = { write: [], keep: [{ name: '../escape', scope: 'global', slug: '' }] };
 assert.equal(await run(), null); assert.ok(existsSync(join(root, 'skills/example')));
 assert.equal(await syncSkills({ request: async () => { throw Error('offline'); }, resolveRoot: () => root }), null);
 assert.ok(existsSync(join(root, 'skills/example')));
 console.log('PASS: actual disk hashes, steady-state reporting, drift repair, unmanaged protection, malformed/offline no deletion.');
} finally { rmSync(root, { recursive: true, force: true }); }
