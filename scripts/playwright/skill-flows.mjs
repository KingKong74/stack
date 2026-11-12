// Build web first, then node scripts/playwright/skill-flows.mjs.
// All mutations stay in this fixture. Other API requests are GET-only reads.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { homedir } from 'node:os';
import { chromium } from 'playwright';
import { loadStackEnv } from '../../hook/stack-post.mjs';
loadStackEnv();
const upstream = 'http://127.0.0.1:8787';
const headers = { authorization: `Bearer ${process.env.STACK_TOKEN}` };
const json = async (path) => { const r = await fetch(upstream + path, { headers }); assert.equal(r.ok, true); return r.json(); };
const profiles = await json('/api/agent-profiles');
const skills = [{ id: 90001, name: 'fixture-skill', scope: 'project', slug: 'stack', description: 'Fixture', body: 'Instructions', enabled: false, installedAt: null }];
const foreign = { name: 'foreign', scope: 'global', slug: '', path: '/fixture/unmanaged/foreign', managed: false, description: 'Foreign instructions', body: 'Preserve me' };
const writes = [];
const deps = resolve(homedir(), '.stack/ui-smoke-deps');
if (existsSync(`${deps}/libs`)) { process.env.LD_LIBRARY_PATH = `${deps}/libs/usr/lib/x86_64-linux-gnu:${deps}/libs/usr/lib/x86_64-linux-gnu/gbm`; process.env.FONTCONFIG_FILE = `${deps}/fonts.conf`; }
const dist = resolve('web/dist');
const server = createServer(async (req, res) => {
 try {
  const path = new URL(req.url, 'http://fixture').pathname;
  if (path.startsWith('/api/')) {
   let payload;
   if (req.method !== 'GET') {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw || '{}'); writes.push({ path, body });
    if (path === '/api/agent-profiles' && req.method === 'POST') {
     assert.ok(body.prompt.trim()); assert.equal(body.enabled, false);
     payload = { ...body, builtin: false }; profiles.profiles.push(payload);
    } else if (path.startsWith('/api/agent-profiles/') && req.method === 'PATCH') {
     assert.deepEqual(body.skillIds, [90001]);
     payload = profiles.profiles.find(p => p.key === path.split('/').at(-1)); Object.assign(payload, body);
    } else if (path === '/api/skills/90001' && req.method === 'PATCH') {
     if (body.resources) assert.deepEqual(body.resources, [{ path: 'references/check.md', content: 'Check evidence' }]);
     else { assert.equal(body.scope, 'project'); assert.equal(body.slug, 'fixture-other'); }
     Object.assign(skills[0], body); payload = skills[0];
    } else if (path === '/api/skills' && req.method === 'POST') {
     assert.equal(body.name, 'foreign-copy'); assert.equal(body.enabled, false); assert.equal(body.body, foreign.body);
     payload = { ...body, id: 90002, installedAt: null }; skills.push(payload);
    } else { throw Error(`Unexpected mutation ${req.method} ${path}`); }
   } else if (path === '/api/agent-profiles') payload = profiles;
   else if (path === '/api/skills') payload = { skills, report: { skills: [foreign], when: new Date().toISOString(), detail: '' } };
   else if (path === '/api/projects') payload = [{ slug: 'stack', name: 'Stack' }, { slug: 'fixture-other', name: 'Other' }];
   else payload = await json(path);
   res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)); return;
  }
  const file = resolve(dist, path === '/' ? 'index.html' : `.${path}`);
  assert.ok(file.startsWith(dist + '/'));
  res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] || 'application/octet-stream');
  res.end(readFileSync(file));
 } catch (e) { res.statusCode = 500; res.end(String(e)); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
 const page = await browser.newPage();
 await page.addInitScript(() => localStorage.setItem('stack.token', 'fixture'));
 await page.goto(url + '/#/p/stack/agents');
 await page.getByRole('button', { name: '+ New', exact: true }).click();
 await page.locator('.sa-edit .sa-body').waitFor();
 assert.equal(writes[0].body.enabled, false);
 await Promise.all([page.waitForResponse(r => r.url().includes('/agent-profiles/') && r.request().method() === 'PATCH'), page.getByLabel('Link fixture-skill to New agent').click()]);
 await page.waitForFunction(() => document.querySelector('input[aria-label="Link fixture-skill to New agent"]')?.checked);
 await page.getByRole('tab', { name: /Skills/ }).click();
 await page.locator('.sa-skrow').filter({ hasText: 'fixture-skill' }).click();
 await Promise.all([page.waitForResponse(r => r.url().endsWith('/skills/90001') && r.request().method() === 'PATCH'), page.getByLabel('Project', { exact: true }).selectOption('fixture-other')]);
 await page.getByLabel('Skill resources JSON').fill(JSON.stringify([{ path: 'references/check.md', content: 'Check evidence' }]));
 await Promise.all([page.waitForResponse(r => r.url().endsWith('/skills/90001') && r.request().method() === 'PATCH'), page.getByLabel('Skill resources JSON').press('Tab')]);
 await page.getByRole('button', { name: '← All skills' }).click();
 await page.getByRole('button', { name: 'Copy to library', exact: true }).click();
 await page.getByRole('button', { name: 'Cancel', exact: true }).click();
 assert.equal(writes.filter(w => w.path === '/api/skills').length, 0);
 await page.getByRole('button', { name: 'Copy to library', exact: true }).click();
 await Promise.all([page.waitForResponse(r => r.url().endsWith('/skills') && r.request().method() === 'POST'), page.getByRole('button', { name: 'Create disabled copy', exact: true }).click()]);
 assert.equal(writes.length, 5); assert.equal(foreign.managed, false);
 console.log('PASS: disabled agent creation, project selection, copy cancellation and confirmed disabled copy; all writes isolated.');
} finally { await browser.close(); server.close(); }
