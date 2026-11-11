// Regression check against a built/local frontend. Terminal sockets are fully
// intercepted: this never launches, types into or kills a real host session.
// node scripts/playwright/terminal-lifecycle.mjs http://127.0.0.1:5199
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { loadStackEnv } from '../../hook/stack-post.mjs';
loadStackEnv();
const url = process.argv[2] || 'http://127.0.0.1:5199';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const survivor = { name: 'stack-term-survivor', cwd: 'stack', cmd: 'codex', attached: false,
  created: Date.now(), label: 'Existing work', model: { key: 'codex', id: 'native', label: 'Codex' } };
async function scenario(saved, host, check, { goneOnRetry = false, delay = 0, route = '#/terminal' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const page = await context.newPage();
    await page.addInitScript(({ token, saved }) => {
      localStorage.setItem('stack.token', token);
      localStorage.setItem('stack.termTabs', JSON.stringify(saved));
      localStorage.setItem('stack.termView', JSON.stringify({ view: 'focus' }));
    }, { token: process.env.STACK_TOKEN, saved });
    await page.route('**/api/terminal/detached', async (r) => {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      await r.fulfill({ json: { connected: true, sessions: host } });
    });
    await page.route('**/api/terminal/label', (r) => r.fulfill({ json: { sessions: [], detached: [] } }));
    const starts = [];
    let socket;
    await page.routeWebSocket('**/term*', (ws) => ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.t !== 'start') return;
      starts.push(frame); socket = ws;
      if (goneOnRetry && starts.length > 1) {
        ws.send(JSON.stringify({ t: 'err', msg: 'This terminal session has ended.' }));
        ws.send(JSON.stringify({ t: 'exit', code: 1 }));
      } else {
        ws.send(JSON.stringify({ t: 'ready', sid: `test-${starts.length}`,
          tmuxSession: frame.tmuxSession, model: survivor.model }));
      }
    }));
    await page.goto(`${url}/${route}`);
    await page.getByRole('tab', { name: 'Focus', exact: true }).waitFor();
    await check({ page, starts, disconnect: () => socket.close({ code: 1012, reason: 'Fixture connection loss' }) });
  } finally { await context.close(); }
}
async function noStarts({ page, starts }) {
  await page.waitForTimeout(1000);
  assert.equal(starts.length, 0, 'restoration must not open a new or unrelated session');
}
try {
  await scenario([], [], noStarts);
  await scenario([{ cwd: 'stack', cmd: 'codex', tmux: 'stack-term-ended' }], [survivor], noStarts);
  await scenario([{ cwd: 'stack', cmd: 'codex' }], [survivor], noStarts);
  await scenario([{ cwd: 'stack', cmd: 'codex', tmux: survivor.name }], [survivor], async ({ page, starts }) => {
    await page.locator('.tv-pane.main .tv-pill.idle').waitFor();
    assert.equal(starts.length, 1);
    assert.equal(starts[0].reattachOnly, true);
    assert.equal(starts[0].tmuxSession, survivor.name);
    await page.getByRole('button', { name: 'Reload this pane', exact: true }).click();
    await page.waitForTimeout(300);
    assert.equal(starts.length, 2);
    assert.equal(starts[1].reattachOnly, true);
  });
  await scenario([], [], async ({ page, starts, disconnect }) => {
    await page.locator('button.tv-go').first().click();
    await page.locator('.tv-pane.main .tv-pill.idle').waitFor();
    assert.equal(starts.length, 1);
    assert.equal(starts[0].reattachOnly, false, 'explicit New may create');
    disconnect();
    await page.waitForTimeout(1500);
    assert.equal(starts.length, 2, 'one reconnect, no replacement after an ended response');
    assert.equal(starts[1].reattachOnly, true);
    assert.equal(starts[1].tmuxSession, starts[0].tmuxSession);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('stack.termTabs'))), [], 'ended identities must not persist');
  }, { goneOnRetry: true });
  await scenario([{ cwd: 'stack', cmd: 'codex', tmux: 'stack-term-ended' }], [], async ({ page, starts }) => {
    await page.locator('button.tv-go').first().click();
    await page.waitForTimeout(1200);
    assert.equal(starts.length, 1, 'a delayed restoration must not add a second session after New');
  }, { delay: 500, route: '#/terminal?cwd=stack' });
  console.log('Terminal lifecycle passed: empty/stale/nameless tabs, exact restore, explicit New, reload, reconnect and delayed restoration');
} finally { await browser.close(); }
