// Build web first, then: node scripts/playwright/native-terminal.mjs
// Isolated browser regression and standard UI smoke; no live API or terminal.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, extname } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
const { WebSocketServer } = createRequire(new URL('../../terminal/stack-term.mjs', import.meta.url))('ws');
const dist = resolve('web/dist');
const serve = process.argv.includes('--serve');
const starts = [];
const requests = [];
const sessions = new Map();
let hostConnected = true;
const out = '/tmp/stack-native-terminal-ui';
// Reuse the repository's rootless browser dependencies when provisioned.
const deps = process.env.STACK_UI_SMOKE_DEPS || resolve(homedir(), '.stack/ui-smoke-deps');
if (existsSync(`${deps}/libs/usr/lib/x86_64-linux-gnu`)) {
  process.env.LD_LIBRARY_PATH = `${deps}/libs/usr/lib/x86_64-linux-gnu:${deps}/libs/usr/lib/x86_64-linux-gnu/gbm:${process.env.LD_LIBRARY_PATH || ''}`;
  process.env.FONTCONFIG_FILE ||= `${deps}/fonts.conf`;
}
mkdirSync(out, { recursive: true });
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://fixture').pathname;
  if (path.startsWith('/api/')) {
    requests.push(path);
    const payload = path === '/api/health' ? { version: 'fixture', ok: true }
      : path === '/api/terminal/detached' ? { connected: hostConnected, sessions: hostConnected ? [...sessions.values()] : [] }
      : path === '/api/terminal/agent' ? { connected: true }
      : path === '/api/settings' ? { termIdleHours: 0 }
      : path === '/api/terminal/usage' ? { tokensToday: 0, tokenBudget: 0 }
      : path === '/api/overview' ? { resume: null, attention: {}, activity: [], presence: [], claims: [] }
      : path === '/api/projects' ? [] : [];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
    return;
  }
  try {
    const file = resolve(dist, path === '/' ? 'index.html' : `.${path}`);
    if (!file.startsWith(`${dist}/`)) throw new Error('Invalid path');
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
    res.setHeader('content-type', types[extname(file)] || 'application/octet-stream');
    const content = readFileSync(file);
    res.end(serve && extname(file) === '.html'
      ? content.toString().replace('</head>', `<script>localStorage.setItem('stack.token','fixture');</script></head>`)
      : content);
  } catch { res.writeHead(404); res.end(); }
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (req.url === '/term-status') {
      ws.send(JSON.stringify({ t: 'status', active: false, count: 0, sessions: [], detached: [] }));
    } else if (m.t === 'start') {
      starts.push(m);
      const name = m.tmuxSession || `stack-term-fixture-${starts.length}`;
      const model = { key: m.cmd === 'codex' ? 'codex' : 'anthropic', id: 'native', label: m.cmd };
      sessions.set(name, { name, cmd: m.cmd, cwd: m.cwd, created: Date.now(), model, label: `${m.cmd} fixture` });
      ws.send(JSON.stringify({ t: 'ready', sid: String(starts.length), tmuxSession: name, model, cwd: m.cwd }));
      ws.send(JSON.stringify({ t: 'usage', tokens: 0, codex: { models: [{ id: 'gpt-fixture', label: 'GPT fixture' }], limits: [{ key: 'codex:primary', name: 'Codex · Session · 5h', pct: 32, resetAt: Date.now() + 3600000 }] } }));
      ws.send(JSON.stringify({ t: 'out', data: Buffer.from(`Native ${m.cmd} fixture\r\n`).toString('base64') }));
    }
  });
});
let browser;
try {
  server.listen(serve ? 5180 : 0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  if (serve) {
    console.log(`Local terminal preview: ${url}/#/terminal (sample sessions; no live API or agents)`);
    await new Promise(() => {});
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    if (!localStorage.getItem('stack.token')) {
      localStorage.setItem('stack.token', 'fixture');
      localStorage.setItem('stack.termSession', JSON.stringify({ autoStart: 'claude', onGateway: true, model: 'legacy-route' }));
    }
  });
  await page.goto(`${url}/#/terminal`);
  await page.getByLabel('Session type').waitFor();
  assert.deepEqual(await page.getByLabel('Session type').locator('option').allTextContents(), ['Claude', 'Codex', 'Shell']);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('stack.termTabs') || '[]').some((t) => t.tmux));
  if (await page.getByTitle('Expand the sessions rail').count()) await page.getByTitle('Expand the sessions rail').click();
  await page.getByRole('button', { name: 'Codex models', exact: true }).click();
  await page.getByLabel('Codex model', { exact: true }).selectOption('gpt-fixture');
  await page.getByRole('button', { name: 'Codex models', exact: true }).click();
  await page.getByText('Codex · Session · 5h', { exact: true }).waitFor();
  await page.getByLabel('Session type').selectOption('codex');
  await page.getByRole('button', { name: /^\+ Codex in/ }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('stack.termTabs') || '[]').some((t) => t.cmd === 'codex' && t.tmux));
  assert.equal(starts.find((m) => m.cmd === 'codex').codexModel, 'gpt-fixture');
  const names = [...sessions.keys()];
  hostConnected = false;
  const startsBeforeRestart = starts.length;
  await page.reload();
  await page.getByLabel('Session type').waitFor();
  await page.waitForTimeout(1400);
  assert.equal(starts.length, startsBeforeRestart, 'a disconnected host must not spawn replacement sessions');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('stack.termTabs')).map((t) => t.tmux)), names,
    'reload while the daemon is down preserves all saved session identities');
  hostConnected = true;
  const restoreDeadline = Date.now() + 5000;
  while (starts.filter((m) => m.cmd === 'codex').length < 2 && Date.now() < restoreDeadline) {
    await page.waitForTimeout(50);
  }
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('stack.termTabs') || '[]').filter((t) => t.tmux).length === 2);
  await page.waitForTimeout(400);
  assert.deepEqual([...sessions.keys()], names, 'reload adopts existing sessions without spawning more');
  assert.equal(starts.filter((m) => m.cmd === 'codex').length, 2, 'Codex started once and reattached once');
  for (const start of starts) {
    assert.equal(start.provider, undefined);
    assert.equal(start.model, undefined);
    assert.equal(start.contextTokens, undefined);
    if (start.cmd === 'codex') assert.equal(start.skipPerms, undefined);
  }
  if (await page.getByTitle('Expand the sessions rail').count()) await page.getByTitle('Expand the sessions rail').click();
  await page.getByRole('button', { name: /Settings/ }).click();
  assert.doesNotMatch(await page.locator('body').innerText(), /OmniRoute|gateway/i);
  await page.getByRole('button', { name: /Settings/ }).click();
  await page.screenshot({ path: `${out}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/mobile.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile has no page overflow');
  assert.deepEqual(errors, []);
  assert.ok(!requests.some((p) => /terminal\/(models|gateway)/.test(p)));
  await browser.close();
  browser = null;
  console.log('Native selector, legacy preference migration, Codex reload and mobile layout passed.');
  const smoke = spawn(process.execPath, ['./stack', 'ui-smoke', '--url', url, '--token', 'fixture',
    '--screens', 'terminal', '--out', `${out}/smoke`], { stdio: 'inherit' });
  const [code] = await once(smoke, 'exit');
  assert.equal(code, 0, 'standard terminal UI smoke must pass');
} finally {
  await browser?.close();
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  await new Promise((r) => server.close(r));
}
