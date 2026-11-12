// All diagnostic writes are intercepted in the browser; no live job is queued.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { loadStackEnv } from '../../hook/stack-post.mjs';
loadStackEnv();
const deps = resolve(homedir(), '.stack/ui-smoke-deps');
if (existsSync(`${deps}/libs`)) { process.env.LD_LIBRARY_PATH = `${deps}/libs/usr/lib/x86_64-linux-gnu:${deps}/libs/usr/lib/x86_64-linux-gnu/gbm`; process.env.FONTCONFIG_FILE = `${deps}/fonts.conf`; }
const url = process.argv[2]; if (!url) throw Error('Local web URL required');
const browser = await chromium.launch({ args: ['--no-sandbox'] }); let writes = 0;
try {
 const page = await browser.newPage(); await page.addInitScript(token => localStorage.setItem('stack.token', token), process.env.STACK_TOKEN);
 await page.route('**/api/**', async route => {
  const req = route.request(), path = new URL(req.url()).pathname;
  if (path === '/api/agent-profiles') return route.fulfill({ json: { profiles: [{ key: 'stack-reviewer', name: 'Fixture Reviewer', prompt: 'Review', model: '', tools: ['Read'], enabled: true, skillIds: [] }], knownTools: ['Read'], policy: { advisorModel: '', executorModel: '', spawnsAgents: false }, usage: {}, defaultSpawn: { keys: [] } } });
  if (path === '/api/skills') return route.fulfill({ json: { skills: [], report: { skills: [], when: null, detail: '' } } });
  if (path.includes('/specialists/runs')) {
   if (req.method() === 'POST') { const b = req.postDataJSON(); assert.equal(b.profileKey, 'stack-reviewer'); assert.equal(b.head, 'b'.repeat(40)); writes++; return route.fulfill({ json: { id: '1234', status: 'queued' } }); }
   return route.fulfill({ json: { id: '1234', status: 'done', detail: 'Diagnostic only', result: { summary: 'Fixture read completed', findings: [], read: ['fixture.ts'], blind: ['No tests executed'] } } });
  }
  if (req.method() !== 'GET') return route.abort(); return route.continue();
 });
 await page.goto(url + '/#/p/stack/agents');
 await page.locator('.sa-agrow .who').filter({ hasText: 'Fixture Reviewer' }).click();
 await page.getByRole('button', { name: 'Run diagnostic', exact: true }).click();
 assert.equal(await page.getByRole('button', { name: 'Queue diagnostic' }).isDisabled(), true);
 await page.getByLabel('Diagnostic base commit').fill('a'.repeat(40)); await page.getByLabel('Diagnostic head commit').fill('b'.repeat(40));
 await page.getByRole('button', { name: 'Queue diagnostic' }).click();
 await page.getByText('Fixture read completed', { exact: true }).waitFor(); assert.equal(writes, 1);
 await page.getByText('No tests executed', { exact: true }).waitFor();
 console.log('PASS: diagnostic preflight, exact scope submission, bounded mocked write and honest results/blind spots.');
} finally { await browser.close(); }
