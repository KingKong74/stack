// node --test server/test/native-terminal.test.mjs
// Exercise the real daemon over its uplink with fake tmux/PTY executables.
// No real sessions, user accounts, production API or database are touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { nativeLaunch, agentForTag } from '../../terminal/native-launch.mjs';

test('terminal API exposes host status and retires gateway/catalogue endpoints', { timeout: 5000 }, async () => {
  const { default: express } = await import('express');
  const { terminal } = await import('../src/routes/terminal.js');
  const app = express();
  app.use('/api/terminal', terminal);
  const server = createServer(app);
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/terminal`;
    assert.deepEqual(await (await fetch(`${base}/agent`)).json(), { connected: false });
    for (const path of ['gateway', 'models']) assert.equal((await fetch(`${base}/${path}`)).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('only native Claude and Codex launch; Codex always launches in YOLO mode', () => {
  assert.equal(nativeLaunch('claude').command, 'exec claude');
  assert.equal(nativeLaunch('claude', { skipPerms: true }).command, 'exec claude --dangerously-skip-permissions');
  assert.equal(nativeLaunch('claude', { skipPerms: true, claudeModel: 'sonnet' }).command,
    'exec claude --dangerously-skip-permissions --model sonnet');
  assert.throws(() => nativeLaunch('claude', { claudeModel: 'opus; rm -rf ~' }), /Invalid Claude model/);
  assert.deepEqual(nativeLaunch('codex', { skipPerms: true, provider: 'omniroute', model: 'untrusted' }),
    { command: 'exec codex --dangerously-bypass-approvals-and-sandbox', tag: 'codex:native' });
  for (const cmd of ['gemini', 'qwen', 'omniroute', 'codex; echo bad', '']) {
    assert.throws(() => nativeLaunch(cmd), /Unknown agent/);
  }
  assert.equal(agentForTag('codex:native'), 'codex');
  assert.equal(agentForTag('anthropic:subscription'), 'claude');
  assert.equal(agentForTag('omniroute:legacy'), 'claude');
  assert.equal(agentForTag(''), undefined);
});

test('SSH terminal launcher uses native Codex and records its tmux tag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stack-native-cli-'));
  const previous = { HOME: process.env.HOME, PATH: process.env.PATH };
  writeFileSync(join(dir, 'tmux'), `#!${process.execPath}
    require('node:fs').appendFileSync('${dir}/calls', JSON.stringify(process.argv.slice(2)) + '\\n');
  `, { mode: 0o755 });
  try {
    process.env.HOME = dir;
    process.env.PATH = `${dir}:${previous.PATH}`;
    const { main } = await import('../../scripts/stack-term-cli.mjs');
    assert.equal(await main(['--cli', 'codex']), 0);
    const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
    const launch = calls.find((args) => args[0] === 'new-session').join(' ');
    assert.match(launch, /exec codex --dangerously-bypass-approvals-and-sandbox/);
    assert.match(launch, /@stack-model 'codex:native'/);
    assert.doesNotMatch(launch, /omniroute/);
    assert.equal(await main(['--cli', 'gemini']), 1);
  } finally {
    Object.assign(process.env, previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daemon launches, resizes and reattaches Codex without a gateway', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stack-native-terminal-'));
  const script = (name, body) => writeFileSync(join(dir, name), `#!${process.execPath}\n${body}`, { mode: 0o755 });
  script('tmux', `
    const a = process.argv.slice(2);
    if (a[0] === 'has-session') process.exit(a.includes('=stack-term-existing') ? 0 : 1);
    if (a[0] === 'list-sessions') console.log('stack-term-existing\\t0\\t1\\t${dir}\\t1\\t0\\t0\\tcodex:native');
  `);
  script('python3', `
    const fs = require('node:fs');
    console.log('SPAWN ' + JSON.stringify(process.argv.slice(2)));
    process.stdin.on('data', d => process.stdout.write(d));
    fs.createReadStream(null, {fd: 3}).on('data', () => console.log('RESIZED'));
  `);
  const http = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ termIdleHours: 0 }));
  });
  const wss = new WebSocketServer({ server: http });
  let child;
  let ws;
  let logs = '';
  try {
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const connection = once(wss, 'connection');
    child = spawn(process.execPath, [resolve('terminal/stack-term.mjs')], {
      env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, STACK_TERM_ROOT: dir,
        STACK_API: `http://127.0.0.1:${http.address().port}`, STACK_TOKEN: 'fixture-only' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => { logs += d; });
    child.stdout.on('data', (d) => { logs += d; });
    [ws] = await connection;
    const frames = [];
    ws.on('message', (raw) => frames.push(JSON.parse(raw)));
    const waitFor = async (predicate) => {
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        const match = frames.find(predicate);
        if (match) return match;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.fail(`No matching frame. Daemon log: ${logs}`);
    };
    const start = (sid, cmd, extra = {}) => ws.send(JSON.stringify({ t: 'start', sid, cmd,
      cwd: '', cols: 100, rows: 30, ...extra }));
    start('codex', 'codex', { skipPerms: true, provider: 'omniroute', model: 'old-gateway-model' });
    const ready = await waitFor((f) => f.t === 'ready' && f.sid === 'codex');
    assert.equal(ready.cmd, 'codex');
    assert.equal(ready.model.key, 'codex');
    const output = await waitFor((f) => f.t === 'out' && f.sid === 'codex'
      && Buffer.from(f.data, 'base64').toString().includes('SPAWN'));
    const text = Buffer.from(output.data, 'base64').toString();
    assert.match(text, /exec codex --dangerously-bypass-approvals-and-sandbox/);
    assert.doesNotMatch(text, /omniroute|old-gateway-model/);
    ws.send(JSON.stringify({ t: 'resize', sid: 'codex', cols: 0, rows: 9000 }));
    await waitFor((f) => f.t === 'out' && f.sid === 'codex'
      && Buffer.from(f.data, 'base64').toString().includes('RESIZED'));
    start('attach', 'claude', { tmuxSession: 'stack-term-existing' });
    const attached = await waitFor((f) => f.t === 'ready' && f.sid === 'attach');
    assert.equal(attached.cmd, 'codex');
    assert.equal(attached.model.key, 'codex');
    // An unavailable catalogue must not block a model the user selected earlier.
    start('selected', 'codex', { codexModel: 'gpt-5.3-codex' });
    const selected = await waitFor((f) => f.t === 'ready' && f.sid === 'selected');
    assert.equal(selected.model.id, 'gpt-5.3-codex');
    const selectedOutput = await waitFor((f) => f.t === 'out' && f.sid === 'selected'
      && Buffer.from(f.data, 'base64').toString().includes('SPAWN'));
    assert.match(Buffer.from(selectedOutput.data, 'base64').toString(), /--model gpt-5.3-codex/);
    start('invalid-model', 'codex', { codexModel: 'bad;command' });
    assert.match((await waitFor((f) => f.t === 'err' && f.sid === 'invalid-model')).msg, /Invalid agent launch options/);
    start('bad', 'gemini');
    assert.match((await waitFor((f) => f.t === 'err' && f.sid === 'bad')).msg, /Unknown session type/);
    for (const sid of ['codex', 'attach', 'selected']) ws.send(JSON.stringify({ t: 'kill', sid }));
    await waitFor((f) => f.t === 'exit' && f.sid === 'codex');
    await waitFor((f) => f.t === 'exit' && f.sid === 'attach');
  } finally {
    child?.kill('SIGTERM');
    if (child && child.exitCode === null) await once(child, 'exit');
    ws?.terminate();
    wss.close();
    await new Promise((r) => http.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('"Work goes to: New branch" starts a new session in its own worktree, and refuses out loud when it cannot', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stack-branch-session-'));
  const script = (name, body) => writeFileSync(join(dir, name), `#!${process.execPath}\n${body}`, { mode: 0o755 });
  script('tmux', `
    const a = process.argv.slice(2);
    if (a[0] === 'has-session') process.exit(1);
  `);
  script('python3', `
    console.log('SPAWN ' + JSON.stringify(process.argv.slice(2)));
    process.stdin.on('data', () => {});
  `);
  const { spawnSync } = await import('node:child_process');
  const { mkdirSync } = await import('node:fs');
  const repo = join(dir, 'proj');
  mkdirSync(join(repo, 'sub'), { recursive: true });
  mkdirSync(join(dir, 'plain'));
  const g = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'sub', 'f'), 'x');
  g('add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const http = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"termIdleHours":0}'); });
  const wss = new WebSocketServer({ server: http });
  let child; let ws; let logs = '';
  try {
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const connection = once(wss, 'connection');
    child = spawn(process.execPath, [resolve('terminal/stack-term.mjs')], {
      env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, STACK_TERM_ROOT: dir,
        STACK_API: `http://127.0.0.1:${http.address().port}`, STACK_TOKEN: 'fixture-only' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => { logs += d; }); child.stdout.on('data', (d) => { logs += d; });
    [ws] = await connection;
    const frames = [];
    ws.on('message', (raw) => frames.push(JSON.parse(raw)));
    const waitFor = async (predicate) => {
      const end = Date.now() + 8000;
      while (Date.now() < end) { const m = frames.find(predicate); if (m) return m; await new Promise((r) => setTimeout(r, 20)); }
      assert.fail(`No matching frame. Daemon log: ${logs}`);
    };
    ws.send(JSON.stringify({ t: 'start', sid: 'br', cmd: 'claude', cwd: 'proj/sub', cols: 80, rows: 24,
      tmuxSession: 'stack-term-abc123', dest: 'branch', claudeModel: 'sonnet' }));
    const ready = await waitFor((f) => f.t === 'ready' && f.sid === 'br');
    assert.equal(ready.branch, 'term/abc123');
    assert.equal(ready.project, 'proj');
    assert.equal(ready.cwd, '~/.stack/worktrees/term-abc123/sub', 'the same sub-path, inside the new tree');
    const spawned = await waitFor((f) => f.t === 'out' && f.sid === 'br' && Buffer.from(f.data, 'base64').toString().includes('SPAWN'));
    assert.match(Buffer.from(spawned.data, 'base64').toString(), /--model sonnet/);
    assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'main', 'the checkout itself is untouched');
    assert.match(g('branch', '--list', 'term/abc123').stdout, /term\/abc123/);

    ws.send(JSON.stringify({ t: 'start', sid: 'nogit', cmd: 'claude', cwd: 'plain', cols: 80, rows: 24,
      tmuxSession: 'stack-term-def456', dest: 'branch' }));
    assert.match((await waitFor((f) => f.t === 'err' && f.sid === 'nogit')).msg, /own branch: .*not inside a git repository/);
    assert.ok(!frames.some((f) => f.t === 'ready' && f.sid === 'nogit'), 'never falls back to the checkout');
    ws.send(JSON.stringify({ t: 'kill', sid: 'br' }));
  } finally {
    ws?.close(); child?.kill(); await new Promise((r) => http.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
