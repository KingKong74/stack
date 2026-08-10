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

  const wk = (n) => n * 7 * 24 * 60;
  const hr = (n) => n * 60;

  // ---- scheduling + the baseline -----------------------------------------
  //
  // #401 — sched is MINUTES from week zero. `wk`/`hr` keep the fixtures
  // readable, and the sub-day case below is the one the old integer-week column
  // could not express at all.

  let r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${feature.id}`,
    { sched: { start: wk(4), len: wk(5) } })).json;
  ok('scheduling a bar writes the baseline with it', r.baseline?.start === wk(4) && r.baseline?.len === wk(5), r.baseline);

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${feature.id}`,
    { sched: { start: wk(9), len: wk(6) } })).json;
  ok('a drag moves the bar', r.sched?.start === wk(9) && r.sched?.len === wk(6), r.sched);
  ok('a drag does NOT move the baseline — the slip stays visible', r.baseline?.start === wk(4) && r.baseline?.len === wk(5), r.baseline);

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${feature.id}`, { rebaseline: true })).json;
  ok('re-baselining is the one explicit way to accept the new plan', r.baseline?.start === wk(9) && r.baseline?.len === wk(6), r.baseline);

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${feature.id}`, { sched: null })).json;
  ok('unscheduling returns the bar to the tray', r.sched === null, r.sched);
  ok('…and keeps the baseline, so rescheduling still shows the slip', r.baseline?.start === wk(9), r.baseline);

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${feature.id}`,
    { sched: { start: wk(300), len: wk(400) } })).json;
  ok('an out-of-range bar is clamped into the window, not stored raw',
    r.sched.start < wk(24) && r.sched.start + r.sched.len <= wk(24), r.sched);

  // The point of the unit change: a bar can be an afternoon, and it comes back
  // exactly as sent rather than rounded up to a week.
  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${feature.id}`,
    { sched: { start: wk(3) + hr(9) + 30, len: 90 } })).json;
  ok('a sub-day bar survives the round trip to the minute',
    r.sched.start === wk(3) + hr(9) + 30 && r.sched.len === 90, r.sched);

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${feature.id}`,
    { sched: { start: wk(3), len: 0 } })).json;
  ok('a zero-length bar is floored, never stored — you could not see or grab one',
    r.sched.len === 15, r.sched);

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
  ok('labels come back in board order, not the caller\'s', r.labels.join() === 'customer,risk', r.labels);

  // #382 — labels are the OWNER'S now (project_labels), seeded with the five
  // that used to live in code. Each of these pins a way the move could have
  // lost something: the seed not landing (every existing card's stripes go),
  // an added label being unstorable (the add looks like it worked and no card
  // can wear it), or a delete leaving its id behind on the rows.
  let lb = (await call('GET', `/api/projects/${SLUG}/board`)).json;
  ok('the five default labels seed on first read', lb.labels.length === 5, lb.labels?.map((l) => l.key));
  ok('the tone set is served, so the picker can only offer what will store',
    Array.isArray(lb.tones) && lb.tones.includes('accent'), lb.tones);

  lb = (await call('POST', `/api/projects/${SLUG}/board/labels`, { name: 'Spike', tone: 'sage' })).json;
  ok('a label can be added', lb.labels.some((l) => l.key === 'spike' && l.tone === 'sage'), lb.labels);

  lb = (await call('POST', `/api/projects/${SLUG}/board/labels`, { name: 'Spike', tone: 'nonsense' })).json;
  ok('the same name is one label, not two rows wearing one id',
    lb.labels.filter((l) => l.key === 'spike').length === 1, lb.labels);

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${ticket.id}`,
    { labels: ['spike', 'customer'] })).json;
  ok('an owner-added label is storable on a card', r.labels.includes('spike'), r.labels);

  lb = (await call('DELETE', `/api/projects/${SLUG}/board/labels/spike`)).json;
  ok('deleting a label removes it from the board', !lb.labels.some((l) => l.key === 'spike'), lb.labels);
  r = flat((await call('GET', `/api/projects/${SLUG}/roadmap`)).json).find((i) => i.id === ticket.id);
  ok('…and takes it off every card that carried it', !r.labels.includes('spike'), r.labels);
  ok('…without touching the labels beside it', r.labels.includes('customer'), r.labels);

  // A tone nothing can render is never stored: styles.css has a rule per tone,
  // so an unknown one would be a label that vanishes in one of the two themes.
  lb = (await call('POST', `/api/projects/${SLUG}/board/labels`, { name: 'Odd', tone: 'chartreuse' })).json;
  ok('an unknown tone falls back rather than being stored',
    lb.labels.find((l) => l.key === 'odd')?.tone === 'muted', lb.labels.find((l) => l.key === 'odd'));

  // ---- lists --------------------------------------------------------------

  const board0 = (await call('GET', `/api/projects/${SLUG}/board`)).json;
  ok('the four default lists seed on first read', board0.lists.length === 4, board0.lists.map((l) => l.key));
  ok('an area mentioned by an item is a lane without being registered',
    board0.areas.some((a) => a.name === 'editor' && a.registered === false), board0.areas);

  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${other.id}`, { listKey: 'shipped' })).json;
  ok('a card can be moved to any list', r.listKey === 'shipped', r.listKey);
  ok('moving a card to Shipped does NOT tick it — a column is not a verdict', r.done === false, r.done);

  // The four defaults are the derivation's own targets and the Review room's
  // ends, so they are LOCKED — see server/src/lists.js. The refusal has to come
  // from the API rather than the board, because a client-side lock is a
  // suggestion, and it has to NAME the reason.
  let del = await call('DELETE', `/api/projects/${SLUG}/board/lists/shipped`);
  ok('a default lane refuses to be deleted', del.status === 400, del.status);
  ok('…and says why rather than just saying no', /cannot be renamed or removed/.test(del.json?.error || ''), del.json);
  let ren = await call('PATCH', `/api/projects/${SLUG}/board/lists/progress`, { name: 'Doing' });
  ok('a default lane refuses to be renamed', ren.status === 400, ren.status);
  let items = flat((await call('GET', `/api/projects/${SLUG}/roadmap`)).json);
  ok('a refused delete leaves the cards exactly where they were',
    items.find((i) => i.id === other.id).listKey === 'shipped', items.find((i) => i.id === other.id)?.listKey);

  // A lane the OWNER added is the opposite: nothing derives into it, so it
  // renames and deletes freely — and deleting it returns its cards to the
  // derived column rather than orphaning them in a lane that is gone.
  const spike = (await call('POST', `/api/projects/${SLUG}/board/lists`, { name: 'Spike' })).json.list;
  ok('an added lane is never one of the locked keys', spike.locked === false, spike);
  ren = await call('PATCH', `/api/projects/${SLUG}/board/lists/${spike.key}`, { name: 'Spikes' });
  ok('an added lane renames', ren.json?.list?.name === 'Spikes', ren.json);
  await call('PATCH', `/api/projects/${SLUG}/roadmap/${other.id}`, { listKey: spike.key });
  await call('DELETE', `/api/projects/${SLUG}/board/lists/${spike.key}`);
  items = flat((await call('GET', `/api/projects/${SLUG}/roadmap`)).json);
  ok('deleting a list keeps its cards', items.length === 3, items.length);
  ok('…and returns them to the derived column rather than orphaning them',
    items.find((i) => i.id === other.id).listKey === '', items.find((i) => i.id === other.id)?.listKey);

  // A verdict clears a hand-dragged column, so the card lands in Shipped by
  // derivation rather than sitting wherever it was last dropped — and it is
  // STILL not a tick. This is the Review room's end of the round trip.
  await call('PATCH', `/api/projects/${SLUG}/roadmap/${other.id}`, { listKey: 'planned', claimed_by: 'feat/9-x' });
  r = (await call('PATCH', `/api/projects/${SLUG}/roadmap/${other.id}`, { review_tag: 'solid' })).json;
  ok('a verdict releases the card back to the derivation', r.listKey === '', r.listKey);
  ok('…which reads a verdict as shipped even with the claim still on it',
    r.reviewTag === 'solid' && r.claimedBy === 'feat/9-x', [r.reviewTag, r.claimedBy]);
  ok('…and a verdict still does not tick it', r.done === false, r.done);
  await call('PATCH', `/api/projects/${SLUG}/roadmap/${other.id}`, { review_tag: '', claimed_by: '' });

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
