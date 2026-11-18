// Run against a throwaway DATABASE_URL. The test creates a private tmux server.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { migrate, pool } from '../src/db.js';
import { terminal } from '../src/routes/terminal.js';
import { taskModeInstructions } from '../../terminal/task-mode.mjs';

if (!process.env.DATABASE_URL) throw Error('Throwaway DATABASE_URL required.');
await migrate();
const app = express();
let rejectCompletion = false;
app.use(express.json(), (req, res, next) => {
  if (rejectCompletion && req.method === 'POST') return res.sendStatus(503);
  next();
});
app.use('/api/terminal', terminal);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const api = `http://127.0.0.1:${server.address().port}`;
const url = api + '/api/terminal/task-inbox';
const directory = mkdtempSync(join(tmpdir(), 'stack-task-inbox-'));
const socket = join(directory, 'tmux');
const tmux = (...args) => execFileSync('tmux', ['-f', '/dev/null', '-S', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sessions = () => tmux('list-sessions', '-F', '#{session_name}').split('\n');
const helper = fileURLToPath(new URL('../../terminal/task-finish.mjs', import.meta.url));
const sessionName = 'stack-term-task-fixture';
const id = randomUUID();
const post = (body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const read = async () => {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
};
const finish = (name) => tmux(
  'send-keys', '-t', `=${name}:`, `node "${helper}" 'Task fixture' 'Checked the result.'`, 'Enter',
);
async function waitFor(check) {
  for (let i = 0; i < 60; i++) {
    if (check()) return;
    await delay(100);
  }
  assert.fail('Timed out waiting for task terminal.');
}

try {
  assert.match(taskModeInstructions('claude'), /task-finish\.mjs/);
  assert.equal(JSON.parse(taskModeInstructions('codex').slice('developer_instructions='.length)), taskModeInstructions('claude'));
  assert.deepEqual(await read(), []);
  assert.equal((await post({ id, sessionName, runtime: 'claude', title: 'Empty brief' })).status, 400);

  tmux('new-session', '-d', '-s', 'stack-term-regular', '-e', `STACK_API=${api}`, '-e', 'STACK_TOKEN=fixture', 'sh');
  tmux('new-session', '-d', '-s', sessionName, '-e', `STACK_API=${api}`, '-e', 'STACK_TOKEN=fixture', 'sh');
  tmux('set-option', '-t', `=${sessionName}:`, '@stack-task-mode', `${id}:claude`);
  finish('stack-term-regular');
  await waitFor(() => tmux('capture-pane', '-p', '-t', 'stack-term-regular:').includes('Run this command inside'));
  assert.deepEqual(await read(), []);

  rejectCompletion = true;
  finish(sessionName);
  await waitFor(() => tmux('capture-pane', '-p', '-t', sessionName + ':').includes('could not confirm saving'));
  assert.ok(sessions().includes(sessionName));
  assert.deepEqual(await read(), []);

  rejectCompletion = false;
  finish(sessionName);
  await waitFor(() => !sessions().includes(sessionName));
  assert.deepEqual(sessions(), ['stack-term-regular']);
  const [saved] = await read();
  assert.deepEqual({ ...saved, completedAt: undefined }, {
    id, sessionName, runtime: 'claude', title: 'Task fixture', summary: 'Checked the result.', completedAt: undefined,
  });
  assert.ok(Date.parse(saved.completedAt));
  assert.equal((await post({ ...saved, summary: 'Retried with different text.' })).status, 200);
  assert.equal((await post({ ...saved, sessionName: 'stack-term-other' })).status, 409);
  assert.deepEqual(await read(), [saved]);
  console.log('PASS: terminal isolation, failed saves, save-before-close, immutable retries and inbox reads.');
} finally {
  try { tmux('kill-server'); } catch { /* fixture already stopped */ }
  rmSync(directory, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
