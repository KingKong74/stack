// Run against a local web build: node scripts/playwright/skill-evidence.mjs URL.
// Skill responses are fixtures; all other network requests are GET-only.
import assert from 'node:assert/strict';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { loadStackEnv } from '../../hook/stack-post.mjs';
loadStackEnv();
const deps = resolve(homedir(), '.stack/ui-smoke-deps');
if (existsSync(`${deps}/libs`)) { process.env.LD_LIBRARY_PATH = `${deps}/libs/usr/lib/x86_64-linux-gnu:${deps}/libs/usr/lib/x86_64-linux-gnu/gbm`; process.env.FONTCONFIG_FILE = `${deps}/fonts.conf`; }
const url = process.argv[2]; if (!url) throw Error('Local web URL required');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const revision = 'a'.repeat(64);
const skills = ['unknown', 'conflict', 'pending', 'installed'].map((state, i) => ({
 id: 91000 + i, name: `fixture-${state}`, scope: 'global', slug: '', description: 'Fixture installation evidence', body: 'Fixture instructions', enabled: true,
 revision, installationState: state, installedAt: state === 'installed' ? new Date().toISOString() : null,
 installations: [{ runtime: 'claude', path: `/fixture/${state}/skills/example`, revision: state === 'installed' ? revision : 'b'.repeat(64), requestedRevision: revision, state, observedAt: new Date().toISOString() }],
}));
const payload = { skills, report: { when: new Date().toISOString(), skills: skills.map(s => ({ name: s.name, scope: s.scope, slug: '', path: s.installations[0].path, managed: true })), detail: 'fixture' } };
try {
 const page = await browser.newPage();
 await page.addInitScript(token => localStorage.setItem('stack.token', token), process.env.STACK_TOKEN);
 await page.route('**/api/**', async route => {
  if (route.request().method() !== 'GET') return route.abort();
  if (new URL(route.request().url()).pathname === '/api/skills') return route.fulfill({ json: payload });
  return route.continue();
 });
 await page.goto(url + '/#/p/stack/agents');
 await page.getByRole('tab', { name: /Skills/ }).click();
 for (const [state, text] of [['unknown', 'host status unknown'], ['conflict', 'installation conflict'], ['pending', 'sync pending'], ['installed', 'installed']]) {
  const row = page.locator('.sa-skrow').filter({ hasText: `fixture-${state}` });
  await row.waitFor(); assert.ok((await row.locator('.sa-state').innerText()).includes(text));
 }
 await page.locator('.sa-skrow').filter({ hasText: 'fixture-conflict' }).click();
 await page.getByText('Installation evidence', { exact: true }).waitFor();
 assert.ok((await page.locator('.sa-side').innerText()).includes('/fixture/conflict/skills/example'));
 mkdirSync('/tmp/stack-649-ui', { recursive: true });
 await page.screenshot({ path: '/tmp/stack-649-ui/evidence-desktop.png', fullPage: true });
 await page.setViewportSize({ width: 900, height: 900 });
 await page.screenshot({ path: '/tmp/stack-649-ui/evidence-narrow.png', fullPage: true });
 console.log('PASS: unknown/conflict/pending/installed labels and per-target revision/path evidence.');
} finally { await browser.close(); }
