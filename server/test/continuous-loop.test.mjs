#!/usr/bin/env node
// THE CONTINUOUS LOOP — with the mode on 'continuous', GET /next builds the
// Ready queue one job at a time, whenever it may spend.
//
//  • One open job per project: the queue's top item, and nothing more until
//    that job is done.
//  • It holds, and says why on GET /loop, in quiet hours, over the rolling
//    token cap, and while a usage-limit resume is pending.
//  • An item that just ran rests before it is picked again, so a failing
//    build is not retried every minute.
//  • Nightly mode is untouched: no loop jobs.
//
// Same harness as plan-night.test.mjs, on a FRESH database (it arms the
// autopilot and reads every job):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   node server/test/continuous-loop.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { inQuietHours } from '../src/routes/autopilot.js';

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = `loop-${Date.now()}`;

async function call(method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
const jobs = async () => {
  const r = (await call('GET', `/autopilot/jobs?slug=${SLUG}&limit=50`)).body;
  return (Array.isArray(r) ? r : r.jobs).filter((j) => j.kind === 'loop');
};
const poll = (hhmm) => call('GET', `/autopilot/next?local=2026-09-29T${hhmm}&dow=2`);

test('quiet hours, including a window that wraps midnight', () => {
  assert.equal(inQuietHours('22:00-07:00', 23 * 60), true);
  assert.equal(inQuietHours('22:00-07:00', 6 * 60), true);
  assert.equal(inQuietHours('22:00-07:00', 12 * 60), false);
  assert.equal(inQuietHours('09:00-17:00', 12 * 60), true);
  assert.equal(inQuietHours('', 12 * 60), false);
});

let a; let b;
test('setup', async () => {
  await call('POST', '/ingest', { project: { slug: SLUG, name: SLUG }, session: { summary: 'seed' } });
  a = (await call('POST', `/projects/${SLUG}/roadmap`, { title: 'first' })).body;
  b = (await call('POST', `/projects/${SLUG}/roadmap`, { title: 'second' })).body;
  await call('PUT', `/projects/${SLUG}/ready`, { items: [a.id, b.id] });
  await call('PATCH', `/projects/${SLUG}`, { automode: true });
});

test('nightly mode makes no loop jobs', async () => {
  await call('PATCH', '/settings', { autopilotEnabled: true, autopilotMode: 'nightly', autopilotTime: '03:00' });
  await poll('12:00');
  assert.equal((await jobs()).length, 0);
  const loop = (await call('GET', '/autopilot/loop')).body;
  assert.match(loop.hold, /nightly mode/);
});

test('quiet hours hold the loop, and say so', async () => {
  await call('PATCH', '/settings', { autopilotMode: 'continuous', autopilotQuiet: '11:00-13:00' });
  await poll('12:00');
  assert.equal((await jobs()).length, 0);
  assert.match((await call('GET', '/autopilot/loop')).body.hold, /quiet hours/);
});

test('outside quiet hours: one job, the top of the queue, and no second', async () => {
  const r = await poll('14:00');
  assert.equal(r.status, 200, r.text);
  // The poll may hand the job straight to "the dispatcher"; either way it exists.
  let list = await jobs();
  assert.equal(list.length, 1);
  assert.equal(Number(list[0].itemId), a.id);
  await poll('14:01');
  list = await jobs();
  assert.equal(list.length, 1, 'an open job holds the project');
  assert.equal((await call('GET', '/autopilot/loop')).body.hold, '');
});

test('a finished item rests; the next one in the queue goes', async () => {
  const [job] = await jobs();
  await call('PATCH', `/autopilot/jobs/${job.id}`, { status: 'failed', detail: 'test' });
  await poll('14:02');
  const ids = (await jobs()).map((j) => Number(j.itemId));
  assert.ok(ids.includes(b.id), `the next Ready item gets a job (got ${JSON.stringify(ids)})`);
  assert.equal(ids.filter((id) => id === a.id).length, 1, 'the failed item is not retried straight away');
});

test('a pending usage-limit resume holds the loop', async () => {
  for (const j of await jobs()) await call('PATCH', `/autopilot/jobs/${j.id}`, { status: 'done' });
  const r = await call('POST', '/autopilot/resume', { slug: SLUG, minutes: 60 });
  assert.equal(r.status, 201, r.text);
  const before = (await jobs()).length;
  await poll('14:03');
  assert.equal((await jobs()).length, before, 'no new loop job while a resume is pending');
  // GET /loop reads the clock off the last poll, which was outside quiet hours.
  assert.match((await call('GET', '/autopilot/loop')).body.hold, /usage limit/);
  await call('DELETE', `/autopilot/jobs/${r.body.id}`);
});

test('teardown', async () => {
  await call('PATCH', '/settings', { autopilotEnabled: false, autopilotMode: 'nightly', autopilotQuiet: '' });
});
