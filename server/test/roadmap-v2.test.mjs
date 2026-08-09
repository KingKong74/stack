#!/usr/bin/env node
// The Roadmap tab v2's persistence: scheduling, the baseline, hierarchy,
// labels, lists and areas.
//
// Most of these pin a rule that is invisible from the screen until it has
// already lost you something:
//
//  • The BASELINE is written once and never follows a drag. A baseline that
//    tracked the bar would make every slip disappear at the moment you moved
//    the bar to acknowledge it — the ghost would sit exactly under the bar,
//    for ever, and the timeline would report a project that had never slipped.
//  • An INVALID parent leaves the row alone. Resolving it to NULL instead
//    means a bad id silently detaches a scope line, which on the board reads
//    as the line simply vanishing.
//  • Deleting an AREA or a LIST never deletes work.
//  • Moving a card to "Shipped" does NOT tick it: `done` is a verdict the
//    Review room owns and a column is not a verdict.
//
// Needs a running server on an EMPTY database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   node server/test/roadmap-v2.test.mjs
//
// Override with STACK_TEST_API / STACK_TEST_TOKEN.

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = `roadmap-v2-test-${Date.now().toString(36)}`;

let failed = 0;
const ok = (name, cond, got) => {
  if (cond) { console.log(`ok    ${name}`); return; }
  failed += 1;
  console.log(`FAIL  ${name}${got === undefined ? '' : `  (got ${JSON.stringify(got)})`}`);
};

const call = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, json };
};

const flat = (roadmap) => ['must', 'should', 'could', 'wont'].flatMap((b) => roadmap[b] || []);

async function main() {
  await call('POST', '/api/projects', { name: SLUG });
  const mk = async (title, extra = {}) =>
    (await call('POST', `/api/projects/${SLUG}/roadmap`, { title, ...extra })).json;

  const feature = await mk('Inline comments', { bucket: 'must', area: 'editor' });
  const ticket = await mk('Resolve / reopen', { bucket: 'should', area: 'editor' });
  const other = await mk('Usage metering', { bucket: 'should', area: 'billing' });

  // ---- scheduling + the baseline -----------------------------------------

  let r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${feature.id}`,
    { sched: { start: 4, len: 5 } })).json;
  ok('scheduling a bar writes the baseline with it', r.baseline?.start === 4 && r.baseline?.len === 5, r.baseline);

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${feature.id}`,
    { sched: { start: 9, len: 6 } })).json;
  ok('a drag moves the bar', r.sched?.start === 9 && r.sched?.len === 6, r.sched);
  ok('a drag does NOT move the baseline — the slip stays visible', r.baseline?.start === 4 && r.baseline?.len === 5, r.baseline);

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${feature.id}`, { rebaseline: true })).json;
  ok('re-baselining is the one explicit way to accept the new plan', r.baseline?.start === 9 && r.baseline?.len === 6, r.baseline);

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${feature.id}`, { sched: null })).json;
  ok('unscheduling returns the bar to the tray', r.sched === null, r.sched);
  ok('…and keeps the baseline, so rescheduling still shows the slip', r.baseline?.start === 9, r.baseline);

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${feature.id}`,
    { sched: { start: 300, len: 400 } })).json;
  ok('an out-of-range bar is clamped into the window, not stored raw',
    r.sched.start < 24 && r.sched.start + r.sched.len <= 24, r.sched);

  // ---- hierarchy ----------------------------------------------------------

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${ticket.id}`, { parentId: feature.id })).json;
  ok('a ticket hangs off a feature', r.parentId === feature.id, r.parentId);

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${feature.id}`, { parentId: ticket.id })).json;
  ok('a feature may not hang off a ticket — one level only', r.parentId === null, r.parentId);

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${ticket.id}`, { parentId: ticket.id })).json;
  ok('nothing may parent itself, and the try does not detach it', r.parentId === feature.id, r.parentId);

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${ticket.id}`, { parentId: 99999 })).json;
  ok('an unknown parent leaves the row where it was', r.parentId === feature.id, r.parentId);

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${ticket.id}`, { parentId: null })).json;
  ok('detaching is explicit and works', r.parentId === null, r.parentId);

  // ---- labels -------------------------------------------------------------

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${ticket.id}`,
    { labels: ['risk', 'not-a-label', 'customer'] })).json;
  ok('unknown labels are dropped, not stored invisibly', !r.labels.includes('not-a-label'), r.labels);
  ok('labels come back in registry order, not the caller\'s', r.labels.join() === 'customer,risk', r.labels);

  // ---- lists --------------------------------------------------------------

  const board0 = (await call('GET', `/api/projects/${SLUG}/board`)).json;
  ok('the four default lists seed on first read', board0.lists.length === 4, board0.lists.map((l) => l.key));
  ok('an area mentioned by an item is a lane without being registered',
    board0.areas.some((a) => a.name === 'editor' && a.registered === false), board0.areas);

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${other.id}`, { listKey: 'shipped' })).json;
  ok('a card can be moved to any list', r.listKey === 'shipped', r.listKey);
  ok('moving a card to Shipped does NOT tick it — a column is not a verdict', r.done === false, r.done);

  await call('DELETE', `/api/projects/${SLUG}/board/lists/shipped`);
  let items = flat((await call('GET', `/api/projects/${SLUG}/roadmap`)).json);
  ok('deleting a list keeps its cards', items.length === 3, items.length);
  ok('…and returns them to the derived column rather than orphaning them',
    items.find((i) => i.id === other.id).listKey === '', items.find((i) => i.id === other.id)?.listKey);

  // ---- areas --------------------------------------------------------------

  await call('POST', `/api/projects/${SLUG}/board/areas`, { name: 'Editor' });
  const renamed = (await call('PATCH', `/api/projects/${SLUG}/board/areas/editor`, { name: 'Editor core' })).json;
  ok('renaming an area registers the new name', renamed.areas.some((a) => a.name === 'editor core'), renamed.areas);
  items = flat((await call('GET', `/api/projects/${SLUG}/roadmap`)).json);
  ok('…and rewrites every item that carried the old one',
    items.filter((i) => i.area === 'editor core').length === 2, items.map((i) => i.area));

  await call('DELETE', `/api/projects/${SLUG}/board/areas/editor core`);
  items = flat((await call('GET', `/api/projects/${SLUG}/roadmap`)).json);
  ok('deleting an area never deletes work', items.length === 3, items.length);
  ok('…it only clears the tag', items.filter((i) => i.area === '').length === 2, items.map((i) => i.area));

  // ---- estimate -----------------------------------------------------------

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${ticket.id}`, { estimate: 2.5 })).json;
  ok('an estimate round-trips as a number, not a pg string', r.estimate === 2.5, r.estimate);
  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${ticket.id}`, { estimate: null })).json;
  ok('unsized is null, not zero — an unsized ticket is not a free one', r.estimate === null, r.estimate);

  await call('DELETE', `/api/projects/${SLUG}`);
  await call('DELETE', `/api/projects/${SLUG}/purge`);

  console.log(failed ? `\n${failed} check(s) failed.` : '\nall checks passed.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
