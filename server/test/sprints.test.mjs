#!/usr/bin/env node
// SPRINTS (#477) — the commitment surface, and the boundary of what the
// automation is allowed to touch.
//
// Every assertion here pins a rule that is invisible from the screen until it
// has already cost something:
//
//  • ONE ACTIVE SPRINT PER PROJECT. Three packages independently decide what
//    may run tonight (this route, the nightly fan-out, the host runner), and
//    each of them says "the sprint in progress". Two active rows would have the
//    three of them building from different boxes and nothing would say so.
//    Starting one must therefore FINISH the incumbent, in one transaction.
//  • THE ORDER PUT IS THE WHOLE BOX. Ranks are rewritten from 0 on every drop
//    and a row the body leaves out goes back to the backlog. A partial write
//    races the other browser doing the same drag; a full one is idempotent.
//  • DELETING A SPRINT RELEASES ITS WORK. Deleting a decision about work must
//    never delete the work, so the FK is ON DELETE SET NULL and the rank is
//    zeroed with it — a rank left behind is a position in a box that no longer
//    exists, and the next drop would read it as a real one.
//  • A NEW ITEM IS BORN IN THE BACKLOG and the route will not take a sprint on
//    a POST. Otherwise any caller — the extractor, a fly card, a script — could
//    commission tonight's work by writing a title.
//  • AN ITEM FROM ANOTHER PROJECT IS IGNORED, not obeyed and not fatal. The
//    body is a snapshot of one box on one screen; a stale id must not take the
//    whole reorder down with it, and it must certainly not file a stranger's
//    work into this sprint.
//
// Needs a running server on an EMPTY database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   node server/test/sprints.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

const API = process.env.STACK_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.API_TOKEN || 'testtok';

async function call(method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* a non-JSON body is the assertion */ }
  return { status: res.status, body: json, text };
}

const slug = `sprint-test-${Date.now()}`;
const otherSlug = `${slug}-other`;
let sprintsPath = '';
let roadPath = '';

async function makeItem(title, over = {}) {
  const r = await call('POST', roadPath, { title, bucket: 'high', ...over });
  assert.equal(r.status, 201, `create "${title}": ${r.text}`);
  return r.body;
}

test('setup: two projects, so cross-project ids can be tested', async () => {
  for (const s of [slug, otherSlug]) {
    const r = await call('POST', '/projects', { slug: s, name: s });
    assert.ok(r.status === 201 || r.status === 200, `create project ${s}: ${r.text}`);
  }
  sprintsPath = `/projects/${slug}/sprints`;
  roadPath = `/projects/${slug}/roadmap`;
});

test('a new sprint is born PLANNED — creating a box and running it are two decisions', async () => {
  const r = await call('POST', sprintsPath, { name: 'Cycle one' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.name, 'Cycle one');
  assert.equal(r.body.status, 'planned');
  assert.equal(r.body.startedAt, null);
  assert.equal(r.body.endedAt, null);
});

test('a sprint needs a name', async () => {
  const r = await call('POST', sprintsPath, { name: '   ' });
  assert.equal(r.status, 400);
});

test('a new roadmap item is born in the BACKLOG, and a POST cannot put it in a sprint', async () => {
  const { body: boxes } = await call('GET', sprintsPath);
  const one = boxes[0];
  // Sent deliberately — the route must IGNORE it rather than honour it, or a
  // typed title could commission tonight's work.
  const it = await makeItem('born loose', { sprintId: one.id });
  assert.equal(it.sprintId, null);
  assert.equal(it.sprintRank, 0);
});

test('starting a sprint stamps it, and starting a SECOND finishes the first', async () => {
  const { body: boxes } = await call('GET', sprintsPath);
  const one = boxes[0];
  const two = (await call('POST', sprintsPath, { name: 'Cycle two' })).body;

  const started = await call('PATCH', `${sprintsPath}/${one.id}`, { status: 'active' });
  assert.equal(started.status, 200, started.text);
  assert.equal(started.body.status, 'active');
  assert.ok(started.body.startedAt, 'an active sprint carries a start stamp');

  const second = await call('PATCH', `${sprintsPath}/${two.id}`, { status: 'active' });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.status, 'active');

  // THE INVARIANT: exactly one. Not "the newest wins by luck" — the incumbent
  // is finished in the same transaction, so it is `done` and stamped.
  const { body: after } = await call('GET', sprintsPath);
  const active = after.filter((s) => s.status === 'active');
  assert.equal(active.length, 1, 'exactly one sprint per project is ever active');
  assert.equal(active[0].id, two.id);
  const wasFirst = after.find((s) => s.id === one.id);
  assert.equal(wasFirst.status, 'done');
  assert.ok(wasFirst.endedAt, 'the sprint that was running is finished, not merely deactivated');
  assert.ok(wasFirst.startedAt, 'and it keeps the start stamp, so it can say how long it ran');
});

test('the order PUT writes ranks from 0, adopts loose rows, and is idempotent', async () => {
  const active = (await call('GET', sprintsPath)).body.find((s) => s.status === 'active');
  const a = await makeItem('first');
  const b = await makeItem('second');
  const c = await makeItem('third');

  const put = await call('PUT', `${sprintsPath}/${active.id}/order`, { items: [c.id, a.id, b.id] });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(put.body.items, [c.id, a.id, b.id]);

  const road = (await call('GET', roadPath)).body;
  const flat = [...road.highest, ...road.high, ...road.medium, ...road.low, ...road.lowest];
  const byId = new Map(flat.map((r) => [r.id, r]));
  assert.equal(byId.get(c.id).sprintRank, 0, 'the top of the box is rank 0');
  assert.equal(byId.get(a.id).sprintRank, 1);
  assert.equal(byId.get(b.id).sprintRank, 2);
  for (const id of [a.id, b.id, c.id]) assert.equal(byId.get(id).sprintId, active.id);

  // Sending it again changes nothing — which is the property that makes a drop
  // safe to retry and safe to race.
  const again = await call('PUT', `${sprintsPath}/${active.id}/order`, { items: [c.id, a.id, b.id] });
  assert.deepEqual(again.body.items, [c.id, a.id, b.id]);
});

test('a row the order PUT leaves out is released to the backlog', async () => {
  const active = (await call('GET', sprintsPath)).body.find((s) => s.status === 'active');
  const road = (await call('GET', roadPath)).body;
  const inBox = [...road.highest, ...road.high].filter((r) => r.sprintId === active.id);
  assert.ok(inBox.length >= 3);
  const keep = inBox.slice(0, 2).map((r) => r.id);
  const dropped = inBox[2].id;

  await call('PUT', `${sprintsPath}/${active.id}/order`, { items: keep });
  const after = (await call('GET', roadPath)).body;
  const row = [...after.highest, ...after.high].find((r) => r.id === dropped);
  assert.equal(row.sprintId, null, 'a row off the list is back in the backlog');
  assert.equal(row.sprintRank, 0, 'and its rank goes with it');
});

test('an id from another project is IGNORED, not obeyed and not fatal', async () => {
  const active = (await call('GET', sprintsPath)).body.find((s) => s.status === 'active');
  const stranger = await call('POST', `/projects/${otherSlug}/roadmap`, { title: 'not yours', bucket: 'high' });
  assert.equal(stranger.status, 201, stranger.text);
  const mine = await makeItem('mine');

  const put = await call('PUT', `${sprintsPath}/${active.id}/order`, { items: [stranger.body.id, mine.id] });
  assert.equal(put.status, 200, 'a stale id must not take the whole reorder down');
  assert.deepEqual(put.body.items, [mine.id], 'the response is the REAL membership, so the screen can correct itself');

  const other = (await call('GET', `/projects/${otherSlug}/roadmap`)).body;
  const untouched = [...other.highest, ...other.high].find((r) => r.id === stranger.body.id);
  assert.equal(untouched.sprintId, null, "another project's work is never filed into this sprint");
});

test('a single-item PATCH files at the BOTTOM, and null sends it back', async () => {
  const active = (await call('GET', sprintsPath)).body.find((s) => s.status === 'active');
  const road = (await call('GET', roadPath)).body;
  const inBox = [...road.highest, ...road.high].filter((r) => r.sprintId === active.id);
  const loner = await makeItem('dragged in on its own');

  const moved = await call('PATCH', `${roadPath}/${loner.id}`, { sprintId: active.id });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.body.sprintId, active.id);
  // The BOTTOM, never the top: a single-item move has no opinion about order,
  // and the top slot is a claim about what the night takes first.
  assert.equal(moved.body.sprintRank, inBox.length);

  const back = await call('PATCH', `${roadPath}/${loner.id}`, { sprintId: null });
  assert.equal(back.body.sprintId, null);
  assert.equal(back.body.sprintRank, 0);
});

test("a sprint id from another project resolves to the BACKLOG, never to that sprint", async () => {
  const theirs = await call('POST', `/projects/${otherSlug}/sprints`, { name: 'theirs' });
  assert.equal(theirs.status, 201, theirs.text);
  const it = await makeItem('cross-project attempt');
  const r = await call('PATCH', `${roadPath}/${it.id}`, { sprintId: theirs.body.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.sprintId, null, 'the safe end of the two — never a stranger’s sprint');
});

test('deleting a sprint releases its work rather than taking it', async () => {
  const box = (await call('POST', sprintsPath, { name: 'doomed' })).body;
  const a = await makeItem('survives the box');
  const b = await makeItem('survives too');
  await call('PUT', `${sprintsPath}/${box.id}/order`, { items: [a.id, b.id] });

  const del = await call('DELETE', `${sprintsPath}/${box.id}`);
  assert.equal(del.status, 200, del.text);

  const road = (await call('GET', roadPath)).body;
  const rows = [...road.highest, ...road.high].filter((r) => r.id === a.id || r.id === b.id);
  assert.equal(rows.length, 2, 'deleting a decision about work never deletes the work');
  for (const r of rows) {
    assert.equal(r.sprintId, null);
    assert.equal(r.sprintRank, 0, 'a rank in a box that no longer exists is not a rank');
  }
});

test('the project payload carries the sprints, in the same order the collection serves', async () => {
  const detail = await call('GET', `/projects/${slug}`);
  assert.equal(detail.status, 200, detail.text);
  assert.ok(Array.isArray(detail.body.sprints), 'the board draws its boxes from this payload');
  const listed = (await call('GET', sprintsPath)).body;
  assert.deepEqual(
    detail.body.sprints.map((s) => s.id), listed.map((s) => s.id),
    'two spellings of one order — no package can import the other, so they are pinned instead');
  assert.equal(detail.body.sprints.filter((s) => s.status === 'active').length, 1);
});

test('renaming and reopening, and an unknown status is refused', async () => {
  const box = (await call('GET', sprintsPath)).body.find((s) => s.status === 'done');
  assert.ok(box, 'the earlier finish left one');
  const named = await call('PATCH', `${sprintsPath}/${box.id}`, { name: 'Renamed' });
  assert.equal(named.body.name, 'Renamed');

  const reopened = await call('PATCH', `${sprintsPath}/${box.id}`, { status: 'planned' });
  assert.equal(reopened.body.status, 'planned');
  assert.equal(reopened.body.endedAt, null, 'a sprint back in play did not finish');
  assert.ok(reopened.body.startedAt, 'but it did once start, and that is not undone');

  const bad = await call('PATCH', `${sprintsPath}/${box.id}`, { status: 'cancelled' });
  assert.equal(bad.status, 400, 'the vocabulary is closed');

  const gone = await call('PATCH', `${sprintsPath}/999999`, { name: 'nope' });
  assert.equal(gone.status, 404);
});

test('a non-numeric :id is refused before it reaches Postgres', async () => {
  const r = await call('DELETE', `${sprintsPath}/undefined`);
  assert.ok(r.status === 400 || r.status === 404, `expected a clean refusal, got ${r.status}`);
});

test('cleanup', async () => {
  for (const s of [slug, otherSlug]) {
    await call('DELETE', `/projects/${s}`);
    await call('DELETE', `/projects/${s}/purge`);
  }
});
