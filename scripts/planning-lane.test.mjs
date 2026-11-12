// Exercise the real runner's pick with a read-only fixture API and --dry.
// No model or production API calls; a temporary repo has no remote.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const row = (id, sliceId, extra = {}) => ({ id, sliceId, title: `item ${id}`, bucket: 'medium', sliceRank: 0,
  source: 'manual', done: false, archived: false, skipped: false, claimedBy: '', area: '', plan: [], ...extra });
const detail = {
  automode: true,
  milestones: [{ id: 4, status: 'active' }, { id: 5, status: 'planned' }],
  slices: [{ id: 10, milestoneId: 4, position: 0, archived: false }, { id: 11, milestoneId: 4, position: 1, archived: false },
    { id: 12, milestoneId: 5, position: 0, archived: false }, { id: 13, milestoneId: 4, position: 0, archived: true }],
  sprints: [{ id: 99, status: 'active' }],
  roadmap: { medium: [row(1, 12, { sprintId: 99 }), row(2, 11), row(3, 10, { sliceRank: 1 }), row(4, 10),
    row(5, 13), row(6, null), row(7, 10, { source: 'hook' }), row(8, 10, { skipped: true }), row(9, 10, { archived: true })] },
};

test('runner plans live current-milestone slices in slice/rank order and builds Ready only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stack-planning-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const writes = [];
  const server = createServer((req, res) => {
    if (req.method !== 'GET') writes.push(req.method + ' ' + req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/settings' ? { autopilotEnabled: true } :
      req.url === '/api/projects/fixture' ? detail : {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const run = (plan = true) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/stack-autopilot.mjs', '--project', 'fixture', '--repo', dir, '--dry', ...(plan ? ['--plan-only'] : [])], {
      env: { ...process.env, STACK_API: `http://127.0.0.1:${server.address().port}`, STACK_TOKEN: 'fixture', GEMINI_API_KEY: '', OMNIROUTE_MODEL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', (b) => { output += b; }); child.stderr.on('data', (b) => { output += b; });
    child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve(output) : reject(Error(output)));
  });
  try {
    assert.match(await run(), /would author a design for #4 /);
    detail.roadmap.medium.find((r) => r.id === 4).plan = [{ text: 'Already designed', done: false }];
    assert.match(await run(), /would author a design for #3 /);
    detail.slices.find((s) => s.id === 10).archived = true;
    assert.match(await run(), /would author a design for #2 /);
    detail.milestones[0].status = 'planned';
    assert.match(await run(), /no milestone is current/);
    assert.match(await run(false), /Ready queue.*empty/);
    detail.roadmap.medium[0].ready = true; detail.roadmap.medium[0].readyRank = 0;
    assert.match(await run(false), /would claim.*item 1/);
    assert.deepEqual(writes, [], 'dry pick never writes or invokes a model');
  } finally {
    await new Promise((resolve) => server.close(resolve)); rmSync(dir, { recursive: true, force: true });
  }
});
