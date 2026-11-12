// Sprint retirement and milestone planning scope, against a throwaway API/DB.
// DATABASE_URL=postgres://... STACK_TEST_API=http://127.0.0.1:4599 node server/test/sprints.test.mjs
// Never point this check at production: it seeds legacy history and polls jobs.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { q, pool, migrate } from '../src/db.js';

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const slug = `milestone-planning-${Date.now()}`;
const base = `/projects/${slug}`;
const call = async (method, path, body) => {
  const response = await fetch(`${API}/api${path}`, {
    method, headers: { authorization: `Bearer ${process.env.STACK_TEST_TOKEN || 'testtok'}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const ok = async (method, path, body) => {
  const r = await call(method, path, body); assert.ok(r.status < 300, JSON.stringify(r)); return r.body;
};
let projectId; let milestone; let slice; let item; let legacyId;
after(async () => { await pool.end(); });

test('seed a current milestone, sliced item and legacy sprint history', async () => {
  await ok('POST', '/ingest', { project: { slug, name: slug }, session: { summary: 'seed' } });
  projectId = (await q('SELECT id FROM projects WHERE slug = $1', [slug])).rows[0].id;
  milestone = await ok('POST', `${base}/milestones`, { name: 'Current delivery', status: 'active' });
  slice = await ok('POST', `${base}/slices`, { title: 'Working slice', milestoneId: milestone.id });
  item = await ok('POST', `${base}/roadmap`, { title: 'Design this', sliceId: slice.id });
  legacyId = (await q("INSERT INTO sprints (project_id, name, status) VALUES ($1, 'History', 'active') RETURNING id", [projectId])).rows[0].id;
  await q('INSERT INTO sprint_slices (sprint_id, slice_id, project_id, rank) VALUES ($1,$2,$3,0)', [legacyId, slice.id, projectId]);
  await q('UPDATE roadmap_items SET sprint_id = $1, sprint_rank = 9 WHERE id = $2', [legacyId, item.id]);
});

test('all sprint endpoints refuse legacy clients and leave work untouched', async () => {
  for (const [method, suffix, body] of [
    ['GET', ''], ['POST', '', { name: 'New' }], ['PATCH', `/${legacyId}`, { status: 'done' }],
    ['PUT', `/${legacyId}/slices`, { slices: [] }], ['PUT', `/${legacyId}/order`, { items: [] }],
    ['POST', `/${legacyId}/plan`, {}], ['DELETE', `/${legacyId}`],
  ]) {
    const r = await call(method, `${base}/sprints${suffix}`, body);
    assert.equal(r.status, 410, `${method} ${suffix}`); assert.match(r.body.error, /retired/i);
  }
  const detail = await ok('GET', base);
  assert.deepEqual(detail.sprints, []);
  assert.ok(Object.values(detail.roadmap).flat().some((it) => it.id === item.id && it.sliceId === slice.id));
  assert.equal((await q('SELECT count(*)::int AS n FROM sprints WHERE id = $1', [legacyId])).rows[0].n, 1);
});

test('sprint metadata cannot be written on item create, patch or batch', async () => {
  for (const patch of [{ sprintId: legacyId }, { sprintId: null }, { sprintRank: 0 }]) {
    assert.equal((await call('POST', `${base}/roadmap`, { title: 'Legacy', ...patch })).status, 400);
    assert.equal((await call('PATCH', `${base}/roadmap/${item.id}`, patch)).status, 400);
    assert.equal((await call('POST', `${base}/roadmap/batch`, { items: [{ title: 'Legacy batch', ...patch }] })).status, 400);
  }
});

test('migration is repeatable and keeps history without deriving new sprint membership', async () => {
  await migrate(); await migrate();
  const old = (await q('SELECT sprint_id, sprint_rank, slice_id FROM roadmap_items WHERE id = $1', [item.id])).rows[0];
  assert.deepEqual(old, { sprint_id: legacyId, sprint_rank: 9, slice_id: slice.id });
  const added = await ok('POST', `${base}/roadmap`, { title: 'New sliced work', sliceId: slice.id });
  assert.equal(added.sprintId, null);
  const triggers = await q("SELECT tgname FROM pg_trigger WHERE tgname IN ('roadmap_spine_ins','roadmap_spine_upd','sprint_slices_sync','sprints_status_sync')");
  assert.equal(triggers.rows.length, 0);
});

test('debrief and overview order Ready then current slices, ignoring historical sprint rank', async () => {
  const second = await ok('POST', `${base}/slices`, { title: 'Second slice', milestoneId: milestone.id });
  const later = await ok('POST', `${base}/roadmap`, { title: 'Second slice item', sliceId: second.id });
  const futureMilestone = await ok('POST', `${base}/milestones`, { name: 'Upcoming delivery' });
  const futureSlice = await ok('POST', `${base}/slices`, { title: 'Future slice', milestoneId: futureMilestone.id });
  const ready = await ok('POST', `${base}/roadmap`, { title: 'Ready future item', sliceId: futureSlice.id });
  await ok('PUT', `${base}/ready`, { items: [ready.id] });
  const debrief = await ok('GET', `${base}/debrief`);
  assert.equal(debrief.roadmap[0].id, ready.id);
  assert.equal(debrief.roadmap[0].milestoneName, futureMilestone.name);
  assert.equal(debrief.roadmap[0].inCurrentMilestone, false);
  assert.equal(debrief.roadmap.find((r) => r.id === item.id).sliceTitle, slice.title);
  assert.ok(debrief.roadmap.findIndex((r) => r.id === item.id) < debrief.roadmap.findIndex((r) => r.id === later.id));
  assert.ok(debrief.roadmap.every((r) => !('inSprint' in r)), 'debrief exposes spine context');
  const overview = await ok('GET', '/overview');
  const found = overview.roadmap.buckets.find((b) => b.bucket === 'medium').items.filter((r) => r.slug === slug);
  assert.equal(Number(found[0].id), ready.id);
  assert.ok(found.findIndex((r) => Number(r.id) === item.id) < found.findIndex((r) => Number(r.id) === later.id));
  await ok('PUT', `${base}/ready`, { items: [] });
  await ok('DELETE', `${base}/roadmap/${later.id}`);
});

test('plan sweep follows only live slices in the current milestone; Ready remains separate', async () => {
  await ok('PATCH', base, { automode: true });
  await ok('PATCH', '/settings', { autopilotEnabled: true, autopilotPlanSweep: true, autopilotQuiet: '', autopilotRollingTokens: 0 });
  await q('UPDATE sprints SET status = \'done\' WHERE project_id = $1', [projectId]);
  const poll = () => ok('GET', '/autopilot/next?local=2026-11-12T12:00&dow=4');
  const jobs = async () => (await q("SELECT kind FROM autopilot_jobs WHERE project_id = $1", [projectId])).rows;
  await poll();
  assert.ok((await jobs()).some((j) => j.kind === 'plan'), 'planning needs no active sprint');
  assert.ok(!(await jobs()).some((j) => j.kind === 'loop'), 'planning scope does not make an item Ready');
  await q('DELETE FROM autopilot_jobs WHERE project_id = $1', [projectId]);
  await ok('PATCH', `${base}/slices/${slice.id}`, { archived: true });
  await poll(); assert.deepEqual(await jobs(), [], 'archived slices do not trigger planning');
  await ok('PATCH', `${base}/slices/${slice.id}`, { archived: false });
  await ok('PATCH', `${base}/milestones/${milestone.id}`, { status: 'planned' });
  await poll(); assert.deepEqual(await jobs(), [], 'no current milestone means no planning');
  await ok('PATCH', `${base}/milestones/${milestone.id}`, { status: 'active' });
  const future = await ok('POST', `${base}/milestones`, { name: 'Later' });
  await ok('PATCH', `${base}/slices/${slice.id}`, { milestoneId: future.id });
  await poll(); assert.deepEqual(await jobs(), [], 'upcoming milestones are outside planning scope');
  await ok('PATCH', `${base}/slices/${slice.id}`, { milestoneId: milestone.id });
  await q('UPDATE roadmap_items SET archived = true WHERE project_id = $1', [projectId]);
  await poll(); assert.deepEqual(await jobs(), [], 'archived items do not trigger planning');
  await q("UPDATE roadmap_items SET archived = false, source = 'hook', reviewed_at = NULL WHERE project_id = $1", [projectId]);
  await poll(); assert.deepEqual(await jobs(), [], 'held items do not trigger planning');
  await q('UPDATE roadmap_items SET reviewed_at = now(), skipped = true WHERE project_id = $1', [projectId]);
  await poll(); assert.deepEqual(await jobs(), [], 'parked items do not trigger planning');
  await q('UPDATE roadmap_items SET skipped = false, slice_id = NULL WHERE project_id = $1', [projectId]);
  await poll(); assert.deepEqual(await jobs(), [], 'Icebox items do not trigger planning');
  await ok('PATCH', base, { automode: false });
  await ok('PATCH', '/settings', { autopilotPlanSweep: false });
});
