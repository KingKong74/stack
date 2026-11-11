#!/usr/bin/env node
// Read-only regression for project tab navigation, refresh and browser history.
// Run: node scripts/playwright/project-tabs.test.mjs <candidate frontend URL> [slug]
// Use setup-browser-deps.sh --print-env if Chromium needs private libraries.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { loadStackEnv } from '../../hook/stack-post.mjs';

loadStackEnv();
const base = process.argv[2];
if (!base || !process.env.STACK_TOKEN) throw new Error('Supply a frontend URL and configure STACK_TOKEN');
const path = `#/p/${encodeURIComponent(process.argv[3] || 'stack')}`;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const context = await browser.newContext();
  await context.addInitScript((token) => localStorage.setItem('stack.token', token), process.env.STACK_TOKEN);
  const page = await context.newPage();
  await page.goto(`${base}/${path}`);
  const rail = page.locator('.con-navitems');
  const selected = (label) => page.getByRole('tab', { name: label, exact: true, selected: true });
  const checkRoute = async (tab) => {
    await page.waitForURL((url) => url.hash === `${path}/${tab}`);
    assert.equal(new URL(page.url()).hash, `${path}/${tab}`);
  };
  for (const [label, tab] of [['Notes', 'notes'], ['Charter', 'charter'], ['Plans', 'plans']]) {
    await rail.getByRole('button', { name: label, exact: true }).click();
    await checkRoute(tab);
    await page.reload();
    await checkRoute(tab);
    await rail.getByRole('button', { name: label, exact: true }).and(page.locator('[aria-current="page"]')).waitFor();
  }
  await rail.getByRole('button', { name: 'Charter', exact: true }).click();
  await checkRoute('charter');
  await page.getByRole('tab', { name: 'Design', exact: true }).click();
  await checkRoute('design');
  await selected('Design').waitFor();
  await page.reload();
  await selected('Design').waitFor();
  await page.getByRole('tab', { name: 'Architecture', exact: true }).click();
  await checkRoute('architecture');
  await page.goBack();
  await selected('Design').waitFor();
  await page.goForward();
  await selected('Architecture').waitFor();
  console.log('PASS: rail tabs, Charter sub-tabs, reload, Back and Forward');
} finally {
  await browser.close();
}
