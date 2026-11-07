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
//  • A NEW ITEM IS BORN IN THE BACKLOG unless it names an OPEN sprint, which it
//    joins at the bottom (owner's decision, 2026-10-10). A finished sprint or
//    another project's is refused out loud. Filing is not approval: a held
//    source stays held, and the build lane is the Ready queue, not the sprint.
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

test('a new roadmap item is born in the BACKLOG unless it names an open sprint', async () => {
  const loose = await makeItem('born loose');
  assert.equal(loose.sprintId, null);
  assert.equal(loose.sprintRank, 0);
});

// #621 — SPRINTS COMMIT TO SLICES. An item is in a sprint exactly when its
// slice is; the database derives sprintId/sprintRank. Every item-level sprint
// write is refused out loud.
let sliceA; let sliceB; let sliceC;
const flatRoad = async () => {
  const road = (await call('GET', roadPath)).body;
  return [...road.highest, ...road.high, ...road.medium, ...road.low, ...road.lowest];
};
const slicesPath = () => sprintsPath.replace(/\/sprints$/, '/slices');

test('a POST naming a sprint is REFUSED: work joins a sprint through its slice', async () => {
  const { body: boxes } = await call('GET', sprintsPath);
  const r = await call('POST', roadPath, { title: 'stray', sprintId: boxes[0].id });
  assert.equal(r.status, 400, r.text);
  assert.match(r.body.error, /commit to slices/);
  const b = await call('POST', `${roadPath}/batch`, { items: [{ title: 'ok' }, { title: 'bad', sprintId: boxes[0].id }] });
  assert.equal(b.status, 400, 'a batch with one sprintId files nothing');
  sliceA = (await call('POST', slicesPath(), { title: 'Slice A' })).body;
  sliceB = (await call('POST', slicesPath(), { title: 'Slice B' })).body;
  sliceC = (await call('POST', slicesPath(), { title: 'Slice C' })).body;
  assert.ok(sliceA.id && sliceB.id && sliceC.id);
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

  // A finished sprint is the record of what was committed to: no slice joins it.
  const late = await call('PUT', `${sprintsPath}/${wasFirst.id}/slices`, { slices: [sliceA.id] });
  assert.equal(late.status, 400, late.text);
});

test('PUT /slices orders the sprint; its items follow, slice by slice, and it is idempotent', async () => {
  const active = (await call('GET', sprintsPath)).body.find((s) => s.status === 'active');
  const a1 = await makeItem('a one', { sliceId: sliceA.id });
  const a2 = await makeItem('a two', { sliceId: sliceA.id });
  const b1 = await makeItem('b one', { sliceId: sliceB.id });

  const put = await call('PUT', `${sprintsPath}/${active.id}/slices`, { slices: [sliceB.id, sliceA.id] });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(put.body.sliceIds, [sliceB.id, sliceA.id]);

  const byId = new Map((await flatRoad()).map((r) => [r.id, r]));
  for (const it of [a1, a2, b1]) assert.equal(byId.get(it.id).sprintId, active.id, 'an item is in the sprint its slice is in');
  assert.deepEqual([byId.get(b1.id).sprintRank, byId.get(a1.id).sprintRank, byId.get(a2.id).sprintRank], [0, 1, 2],
    'the run order: the slice\'s place, then the item\'s place in its slice');

  const again = await call('PUT', `${sprintsPath}/${active.id}/slices`, { slices: [sliceB.id, sliceA.id] });
  assert.deepEqual(again.body.sliceIds, [sliceB.id, sliceA.id]);
  assert.equal((await flatRoad()).find((r) => r.id === b1.id).sprintRank, 0);
});

test('a new item in a committed slice joins the sprint, at the bottom of its slice', async () => {
  const active = (await call('GET', sprintsPath)).body.find((s) => s.status === 'active');
  const late = await makeItem('a three', { sliceId: sliceA.id });
  assert.equal(late.sprintId, active.id, 'the create answers with the derived sprint, not a stale one');
  const row = (await flatRoad()).find((r) => r.id === late.id);
  assert.equal(row.sprintId, active.id);
  assert.equal(row.sprintRank, 3, 'below a one and a two, below all of slice B');
});

test('moving an item to another slice moves its sprint with it', async () => {
  const it = await makeItem('wanders', { sliceId: sliceA.id });
  const moved = await call('PATCH', `${roadPath}/${it.id}`, { sliceId: sliceC.id });
  assert.equal(moved.body.sprintId, null, 'the PATCH answers with the derived sprint');
  assert.equal((await flatRoad()).find((r) => r.id === it.id).sprintId, null, 'slice C is in no sprint');
});

test('item-level sprint writes are refused out loud', async () => {
  const active = (await call('GET', sprintsPath)).body.find((s) => s.status === 'active');
  const it = await makeItem('direct', { sliceId: sliceC.id });
  let r = await call('PATCH', `${roadPath}/${it.id}`, { sprintId: active.id });
  assert.equal(r.status, 400, r.text);
  r = await call('PATCH', `${roadPath}/${it.id}`, { sprintRank: 0 });
  assert.equal(r.status, 400, r.text);
  r = await call('PUT', `${sprintsPath}/${active.id}/order`, { items: [it.id] });
  assert.equal(r.status, 410, r.text);
});

test('a slice left out leaves the sprint; a stranger\'s slice is ignored', async () => {
  const active = (await call('GET', sprintsPath)).body.find((s) => s.status === 'active');
  const theirs = (await call('POST', `/projects/${otherSlug}/slices`, { title: 'not yours' })).body;
  const put = await call('PUT', `${sprintsPath}/${active.id}/slices`, { slices: [theirs.id, sliceA.id] });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(put.body.sliceIds, [sliceA.id], 'the answer is the REAL commitment');
  const rows = await flatRoad();
  assert.ok(rows.filter((r) => r.sliceId === sliceB.id).every((r) => r.sprintId === null), 'slice B left, and its items with it');
  assert.ok(rows.filter((r) => r.sliceId === sliceA.id).every((r) => r.sprintId === active.id));
});

test('a slice is in at most ONE open sprint: committing it elsewhere moves it', async () => {
  const active = (await call('GET', sprintsPath)).body.find((s) => s.status === 'active');
  const next = (await call('POST', sprintsPath, { name: 'next up' })).body;
  const r = await call('PUT', `${sprintsPath}/${next.id}/slices`, { slices: [sliceA.id] });
  assert.deepEqual(r.body.sliceIds, [sliceA.id]);
  const boxes = (await call('GET', sprintsPath)).body;
  assert.deepEqual(boxes.find((b) => b.id === active.id).sliceIds, [], 'it left the sprint in progress');
  assert.ok((await flatRoad()).filter((x) => x.sliceId === sliceA.id).every((x) => x.sprintId === next.id));
  await call('DELETE', `${sprintsPath}/${next.id}`);
});

test('deleting a sprint releases its slices rather than taking them', async () => {
  const box = (await call('POST', sprintsPath, { name: 'doomed' })).body;
  await call('PUT', `${sprintsPath}/${box.id}/slices`, { slices: [sliceB.id] });
  const del = await call('DELETE', `${sprintsPath}/${box.id}`);
  assert.equal(del.status, 200, del.text);
  const rows = (await flatRoad()).filter((r) => r.sliceId === sliceB.id);
  assert.ok(rows.length >= 1, 'deleting a decision about work never deletes the work');
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

// --- the planned window ------------------------------------------------------
//
// TWO PAIRS OF DATES, and they answer different questions: `startsOn`/`endsOn`
// is when the owner MEANT the sprint to run, `startedAt`/`endedAt` is when it
// actually did. Collapsing them would lose the only comparison worth having.
// Nothing gates on the window — a date must never stop a night at midnight.

test('a sprint can be born with its window, or given one later, or have half of one', async () => {
  const born = await call('POST', sprintsPath, { name: 'Dated', startsOn: '2026-09-14', endsOn: '2026-09-28' });
  assert.equal(born.status, 201, born.text);
  assert.equal(born.body.startsOn, '2026-09-14', 'a bare day, never an instant');
  assert.equal(born.body.endsOn, '2026-09-28');
  assert.equal(born.body.startedAt, null, 'the planned window is not a run stamp');

  // HALF A WINDOW IS A REAL STATE — "starts Monday, no end decided". Demanding
  // both would make the first date impossible to enter.
  const half = (await call('POST', sprintsPath, { name: 'Half', startsOn: '2026-10-01' })).body;
  assert.equal(half.startsOn, '2026-10-01');
  assert.equal(half.endsOn, null);

  const later = await call('PATCH', `${sprintsPath}/${half.id}`, { endsOn: '2026-10-15' });
  assert.equal(later.body.startsOn, '2026-10-01', 'the end alone does not disturb the start');
  assert.equal(later.body.endsOn, '2026-10-15');

  const cleared = await call('PATCH', `${sprintsPath}/${half.id}`, { startsOn: null, endsOn: null });
  assert.equal(cleared.body.startsOn, null);
  assert.equal(cleared.body.endsOn, null);
});

// The one date mistake worth refusing rather than storing: every reader would
// render a backwards window as a negative length.
test('a window cannot end before it starts — including when only one end is sent', async () => {
  const bad = await call('POST', sprintsPath, { name: 'Backwards', startsOn: '2026-09-28', endsOn: '2026-09-14' });
  assert.equal(bad.status, 400, bad.text);

  const ok = (await call('POST', sprintsPath, { name: 'Forwards', startsOn: '2026-09-14', endsOn: '2026-09-28' })).body;
  // Checked against the row's OWN other end, not just against what this PATCH
  // carries — otherwise "move the start later" silently inverts a window
  // somebody set last week.
  const invert = await call('PATCH', `${sprintsPath}/${ok.id}`, { startsOn: '2026-10-30' });
  assert.equal(invert.status, 400, 'moving one end past the other is the same mistake');
  const still = (await call('GET', sprintsPath)).body.find((x) => x.id === ok.id);
  assert.equal(still.startsOn, '2026-09-14', 'and nothing was written');
});

test('a date that is not a real day clears the field rather than 500-ing', async () => {
  const b = (await call('POST', sprintsPath, { name: 'Junk dates', startsOn: '2026-02-31' })).body;
  // 2026-02-31 passes a YYYY-MM-DD shape test and is not a day. Postgres would
  // reject it; the route resolves it to null, which is recoverable by typing
  // again — a 400 the client can only answer with the value already refused is
  // not.
  assert.equal(b.startsOn, null);
  const c = await call('PATCH', `${sprintsPath}/${b.id}`, { endsOn: 'not-a-date' });
  assert.equal(c.status, 200);
  assert.equal(c.body.endsOn, null);
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
