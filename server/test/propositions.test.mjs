#!/usr/bin/env node
// PROPOSITIONS (routes/propositions.js): agents propose, the owner accepts.
//
//  • A POST persists a structured multi-slice tree; a retry or a repeat with
//    the same sourceKey updates the one row, never a copy.
//  • A proposal is not work: nothing reaches roadmap_items, Ready or a sprint
//    until an accept, and an accept writes neither Ready nor sprint nor makes
//    a milestone current.
//  • Accept validates the whole selection (an item needs its slice, a slice
//    its milestone) and is idempotent; partial acceptance keeps the remainder.
//  • Dismissal sticks: the same sourceKey is refused afterwards.
//  • An owner's edit wins over an agent's re-POST.
//
// Same harness as spine.test.mjs (a running server on a FRESH database):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   node server/test/propositions.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = `props-${Date.now()}`;
const P = `/projects/${SLUG}`;

async function call(method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
const project = async () => (await call('GET', P)).body;
const allRows = async () => Object.values((await project()).roadmap).flat();

let plan; let prop; let current;

const proposal = () => ({
  sourceKey: `artifact:${plan.id}`,
  title: 'Daily admin',
  outcome: 'It handles my daily admin',
  purpose: 'Why: admin eats the morning.',
  proposedBy: 'claude (test)',
  artifactId: plan.id,
  links: [{ kind: 'artifact', id: plan.id, label: 'The plan' }, { kind: 'url', url: 'https://example.com/spec', label: 'Spec' },
    { kind: 'url', url: 'javascript:alert(1)' }, { kind: 'artifact', id: 999999 }],
  tree: {
    milestones: [{
      key: 'ms', name: 'Reliably handles daily admin', goal: 'Admin done by 9am', targetOn: '2026-12-20',
      slices: [
        { key: 'triage', title: 'Email triage', spec: 'Sort the inbox', areas: ['Email'],
          items: [
            { key: 'fetch', title: 'Fetch mail', kind: 'task', spec: { acceptance: ['pulls unread'], outOfScope: ['sending'] } },
            { key: 'label', title: 'Label mail', kind: 'story', dependsOn: ['fetch', 'nope'] },
          ] },
        { key: 'brief', title: 'Daily brief', items: [{ key: 'compose', title: 'Compose the brief', dependsOn: ['label'] }] },
      ],
    }],
  },
});

test('setup', async () => {
  const r = await call('POST', '/ingest', { project: { slug: SLUG, name: SLUG }, session: { summary: 'seed' } });
  assert.ok(r.status < 300, r.text);
  plan = (await call('POST', `${P}/artifacts`, { type: 'plan', title: 'Delivery plan', body: '# plan' })).body;
  current = (await call('POST', `${P}/milestones`, { name: 'Now', status: 'active' })).body;
});

test('a structured multi-slice proposition persists with cleaned links', async () => {
  const r = await call('POST', `${P}/propositions`, proposal());
  assert.equal(r.status, 201, r.text);
  prop = r.body;
  assert.equal(prop.status, 'proposed');
  assert.equal(prop.kind, 'milestone');
  assert.deepEqual(prop.counts, { milestones: 1, slices: 2, items: 3, accepted: 0, total: 6 });
  assert.deepEqual(prop.links.map((l) => l.kind), ['artifact', 'url'], 'a javascript: URL and a foreign artifact are dropped');
  const label = prop.tree.milestones[0].slices[0].items[1];
  assert.equal(label.kind, 'story');
  assert.deepEqual(label.dependsOn, ['fetch'], 'a dependency outside the proposition is dropped');
  assert.deepEqual(prop.tree.milestones[0].slices[0].items[0].spec.acceptance, ['pulls unread']);
});

test('a proposal is not work: nothing on the roadmap, no new milestone', async () => {
  assert.equal((await allRows()).length, 0);
  assert.equal((await call('GET', `${P}/milestones`)).body.length, 1);
});

test('a retry with the same sourceKey updates the one row, never a copy', async () => {
  const same = await call('POST', `${P}/propositions`, proposal());
  assert.equal(same.status, 200);
  assert.equal(same.body.id, prop.id);
  const changed = await call('POST', `${P}/propositions`, { ...proposal(), outcome: 'Revised outcome' });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(changed.body.outcome, 'Revised outcome');
  assert.equal((await call('GET', `${P}/propositions`)).body.length, 1);
});

test('a duplicate key or an empty title is refused', async () => {
  const dup = proposal();
  dup.sourceKey = 'dup';
  dup.tree.milestones[0].slices[1].key = 'triage';
  assert.equal((await call('POST', `${P}/propositions`, dup)).status, 400);
  assert.equal((await call('POST', `${P}/propositions`, { ...proposal(), sourceKey: 'x', title: '' })).status, 400);
});

test('accept refuses an incomplete selection and writes nothing', async () => {
  const r = await call('POST', `${P}/propositions/${prop.id}/accept`, { keys: ['fetch'] });
  assert.equal(r.status, 400, r.text);
  const r2 = await call('POST', `${P}/propositions/${prop.id}/accept`, { keys: ['triage', 'fetch'] });
  assert.equal(r2.status, 400, 'a slice needs its milestone');
  assert.equal((await allRows()).length, 0);
  assert.equal((await call('GET', `${P}/milestones`)).body.length, 1);
});

test('partial accept makes the rows, keeps the hierarchy and touches no gate', async () => {
  const r = await call('POST', `${P}/propositions/${prop.id}/accept`, { keys: ['ms', 'triage', 'fetch', 'label'] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.status, 'proposed', 'a remainder keeps it in the lane');
  assert.equal(r.body.counts.accepted, 4);
  const ms = (await call('GET', `${P}/milestones`)).body;
  const made = ms.find((m) => m.id === r.body.accepted.ms.id);
  assert.equal(made.status, 'planned', 'never made current');
  assert.equal(ms.find((m) => m.id === current.id).status, 'active', 'the incumbent is untouched');
  const sl = (await call('GET', `${P}/slices`)).body.find((s) => s.id === r.body.accepted.triage.id);
  assert.equal(sl.milestoneId, made.id);
  const rows = await allRows();
  assert.equal(rows.length, 2);
  for (const it of rows) {
    assert.equal(it.sliceId, sl.id);
    assert.equal(it.ready, false, 'not Ready');
    assert.equal(it.sprintId ?? null, null, 'in no sprint');
  }
  const label = rows.find((x) => x.title === 'Label mail');
  assert.equal(label.kind, 'story');
  assert.match(label.note, new RegExp(`Depends on: #${r.body.accepted.fetch.id} Fetch mail`));
  const art = (await call('GET', `${P}/artifacts`)).body.find((a) => a.id === plan.id);
  assert.deepEqual([...art.links].sort(), rows.map((x) => x.id).sort(), 'the source artifact links to the work');
});

test('repeated acceptance creates nothing twice', async () => {
  const r = await call('POST', `${P}/propositions/${prop.id}/accept`, { keys: ['ms', 'triage', 'fetch', 'label'] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.made, []);
  assert.equal((await allRows()).length, 2);
  assert.equal((await call('GET', `${P}/milestones`)).body.length, 2);
});

test('the remainder is accepted into the made milestone, and then it leaves the lane', async () => {
  const r = await call('POST', `${P}/propositions/${prop.id}/accept`, { keys: ['brief', 'compose'] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.status, 'accepted');
  assert.equal((await allRows()).length, 3);
  assert.equal((await call('POST', `${P}/propositions/${prop.id}/dismiss`)).status, 409, 'nothing left to dismiss');
});

test('slices can be proposed into an existing milestone', async () => {
  const r = await call('POST', `${P}/propositions`, {
    sourceKey: 'into-now', title: 'More for now',
    tree: { milestones: [{ milestoneId: current.id, slices: [{ key: 's', title: 'Extra', items: [{ key: 'i', title: 'Extra item' }] }] }] },
  });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.kind, 'slices');
  assert.deepEqual(r.body.counts, { milestones: 0, slices: 1, items: 1, accepted: 0, total: 2 });
  const a = await call('POST', `${P}/propositions/${r.body.id}/accept`, { keys: ['s', 'i'] });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.body.status, 'accepted');
  const sl = (await call('GET', `${P}/slices`)).body.find((s) => s.id === a.body.accepted.s.id);
  assert.equal(sl.milestoneId, current.id);
});

test('dismissal sticks: the same sourceKey is refused afterwards', async () => {
  const r = await call('POST', `${P}/propositions`, { ...proposal(), sourceKey: 'gone' });
  assert.equal(r.status, 201, r.text);
  assert.equal((await call('POST', `${P}/propositions/${r.body.id}/dismiss`)).status, 200);
  const again = await call('POST', `${P}/propositions`, { ...proposal(), sourceKey: 'gone' });
  assert.equal(again.status, 409);
  assert.equal(again.body.dismissed, true);
  assert.equal((await call('POST', `${P}/propositions/${r.body.id}/accept`, { keys: ['ms'] })).status, 409);
});

test("an owner's edit wins over an agent's re-POST", async () => {
  const r = await call('POST', `${P}/propositions`, { ...proposal(), sourceKey: 'edited' });
  const e = await call('PATCH', `${P}/propositions/${r.body.id}`, { title: 'Owner title' });
  assert.equal(e.status, 200, e.text);
  assert.ok(e.body.editedAt);
  const again = await call('POST', `${P}/propositions`, { ...proposal(), sourceKey: 'edited' });
  assert.equal(again.status, 409);
  assert.equal(again.body.edited, true);
  assert.equal((await call('GET', `${P}/propositions/${r.body.id}`)).body.title, 'Owner title');
});
