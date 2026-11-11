#!/usr/bin/env node
// Read-only Charter regression: ad-block cosmetic rules must not hide document text.
// Run: node scripts/playwright/charter-visibility.test.mjs <candidate frontend URL>
// Use setup-browser-deps.sh --print-env if Chromium needs private libraries.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { loadStackEnv } from '../../hook/stack-post.mjs';

loadStackEnv();
const base = process.argv[2];
if (!base || !process.env.STACK_TOKEN) throw new Error('Supply a frontend URL and configure STACK_TOKEN');
const body = `# Charter

A charter with bold list entries.

## Who it is for

- _Primary reader_ **The owner**: All the owner’s context stays visible.

## Principles

- **Resume is the point.** The full principle stays visible.

## Success

1. **Every everyday flow reaches the right outcome.** The full goal stays visible.

## Boundaries

- **Paid spend**: No paid model APIs.
`;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const width of [1920, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.addInitScript((token) => localStorage.setItem('stack.token', token), process.env.STACK_TOKEN);
    // Fixture only in the browser response: no writes to real charter data.
    await page.route('**/api/projects/stack/artifacts?*', async (route) => {
      const response = await route.fetch();
      assert(response.ok(), 'Could not read spine documents');
      const docs = await response.json();
      assert(docs.some((d) => d.type === 'charter'), 'Expected the Stack charter');
      await route.fulfill({ response, json: docs.map((d) => d.type === 'charter' ? { ...d, body } : d) });
    });
    await page.goto(`${base}/#/p/stack/charter`);
    await page.getByRole('heading', { name: /Who it is for/ }).waitFor();
    // Reproduce the cosmetic selectors that remove the screenshot’s cards,
    // principle rows, goal wording and context labels, while leaving headings.
    await page.addStyleTag({ content: '.ad, .ad-card, .ad-rows, .ad-label, .ad-body, .ad-goal { display: none !important; }' });
    for (const text of ['The owner', 'All the owner’s context stays visible.', 'Resume is the point.',
      'The full principle stays visible.', 'Every everyday flow reaches the right outcome.',
      'The full goal stays visible.', 'Paid spend', 'No paid model APIs.']) {
      assert(await page.getByText(text, { exact: true }).isVisible(), `Hidden at ${width}px: ${text}`);
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${width}px`);
    await page.close();
  }
  console.log('PASS: Charter cards, principle rows and goals stay visible with ad-block filters at desktop and mobile widths');
} finally {
  await browser.close();
}
