#!/usr/bin/env node
// The Workbench canvas — the properties that keep it honest.
//
// The canvas is a PLACEMENT layer over rows that live somewhere else, and every
// bug worth pinning here comes from forgetting that:
//
//   • BACKFILL — notes that predate the canvas (and any note filed from
//     elsewhere, like the ✧ re-entry plan) must get a card on read, and a
//     second read must not give them a second one.
//   • WRITE-THROUGH — retitling a card retitles the NOTE. A second copy of the
//     text would leave ⌘K searching a stale one.
//   • DELETE — a note card's × deletes the note, because it has no other home.
//     (Polaris cards were the asymmetric case — their × only unplaced the idea
//     — and went with the Polaris cull.)
//   • CUT DROPS THE BRANCH — cutting an op's line drops the output it fed and
//     everything downstream of THAT, but never a note that happens to sit
//     below the cut.
//   • FOLDERS DO NOT CASCADE (#414) — deleting a folder lifts its contents one
//     level. A cascade would make "delete this folder" a bulk note delete. The
//     cycle guard is here too: a refused move leaves the card where it was,
//     because resolving it to the root reads as a move that worked.
//   • THE STACK FOLDER IS A ROW WITH THREE REFUSALS (#416) — it exists on every
//     read, cannot be deleted, moved or renamed, and still takes cards. Being a
//     real row is what lets it hold them; the refusals are what a derived
//     folder got for free, and each one is a route that could forget.
//
// Needs a running server on an EMPTY database (it writes real rows):
//   docker run -d --rm --name pg -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t \
//     -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t API_TOKEN=testtok PORT=4599 \
//     node server/src/index.js &
//   DATABASE_URL=postgres://t:t@127.0.0.1:55432/t node server/test/workbench.test.mjs
//
// It needs DATABASE_URL as well as the API: one case stands an op's output up
// directly, because ops are the only way to make an 'ai' card through the API
// and they need a live Gemini key.
//
// Override the API with STACK_TEST_API / STACK_TEST_TOKEN.
//
// The ops are NOT exercised here: they are the one path that calls Gemini, and
// a test that needs a live key and a daily quota is a test that gets skipped.
// What the ops produce is a card like any other, and the card is what this
// covers.

const API = process.env.STACK_TEST_API || 'http://127.0.0.1:4599';
const TOKEN = process.env.STACK_TEST_TOKEN || 'testtok';
const SLUG = 'workbench-test';

let failed = 0;
function check(name, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

const call = async (path, opts = {}) => {
  const r = await fetch(`${API}/api${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
};

const board = () => call(`/projects/${SLUG}/workbench`);

// Every project has a Stack folder it did not make (#416), so a count of
// "cards" is a count of the ones this test PUT there. Counting the payload
// whole would make every assertion below one out — and the first thing anyone
// would do about that is bump the numbers, which pins the wrong thing.
const owned = (b) => b.cards.filter((c) => !c.system);

(async () => {
  // A project, one note filed the OLD way (straight at the notes route, as the
  // ✧ re-entry plan and every pre-Workbench note was).
  await call('/ingest', {
    method: 'POST',
    body: {
      project: { slug: SLUG, name: 'Workbench test' },
      session: { session_id: 'wb-1', commit_hash: 'wb00001', branch: 'main', summary: 'seed', message_count: 1 },
    },
  });
  await call(`/projects/${SLUG}/notes`, { method: 'POST', body: { text: 'a note from before the canvas' } });

  // 1. BACKFILL — the legacy note gets a card on read, and only ever one.
  const first = await board();
  check('a pre-canvas note is materialised as a card', owned(first).length, 1);
  check('its title reads through from the note', owned(first)[0].title, 'a note from before the canvas');
  const second = await board();
  check('reading twice does not double the card', owned(second).length, 1);

  // #327 — the model picker's catalogue and current pick ride along on the
  // same payload.
  check('the model catalogue is non-empty', first.models.length > 0, true);
  check('every catalogue entry names a model, a label and a note',
    first.models.every((m) => typeof m.model === 'string' && typeof m.label === 'string' && typeof m.note === 'string'), true);
  check('exactly one entry is the server default', first.models.filter((m) => m.model === '').length, 1);
  check('the current pick is a string', typeof first.model, 'string');

  // 2. WRITE-THROUGH — retitling the card retitles the note itself.
  const noteCard = owned(second)[0];
  await call(`/projects/${SLUG}/workbench/cards/${noteCard.id}`, {
    method: 'PATCH', body: { title: 'retitled on the canvas', x: 120, y: 240 },
  });
  const notes = await call(`/projects/${SLUG}/notes`);
  check('the note row itself carries the new text', notes[0].text, 'retitled on the canvas');
  const moved = owned(await board())[0];
  check('and the move persisted', `${moved.x},${moved.y}`, '120,240');

  // 3. CUT DROPS THE BRANCH. Ops need a live Gemini key, so the shapes an op
  //    would make are built by hand: note → ai → ai, plus a plain note wired
  //    below the cut that must survive it.
  const bystander = await call(`/projects/${SLUG}/workbench/cards`, {
    method: 'POST', body: { kind: 'note', text: 'a bystander note', x: 40, y: 600 },
  });
  const { rootId, leafId } = await seedAiChain(noteCard.id, bystander.id);
  const wired = await board();
  check('the chain is on the canvas', owned(wired).length, 4);

  const aiEdge = wired.edges.find((e) => e.ai && e.b === rootId);
  const res = await call(`/projects/${SLUG}/workbench/edges/${aiEdge.id}`, { method: 'DELETE' });
  check('cutting the op line drops it and everything it fed', res.dropped.length, 2);
  check('both dropped cards were the ai ones', res.dropped.slice().sort().join(), [rootId, leafId].sort().join());
  const after = await board();
  check('the note and the bystander are untouched', owned(after).length, 2);
  check('the bystander note still exists', (await call(`/projects/${SLUG}/notes`)).length, 2);

  // 4. A note card's × really does delete the note.
  await call(`/projects/${SLUG}/workbench/cards/${bystander.id}`, { method: 'DELETE' });
  check('removing a note card deletes the note', (await call(`/projects/${SLUG}/notes`)).length, 1);
  check('and its card goes with it', owned(await board()).length, 1);

  // 5. FOLDERS (#414). A folder is a card that other cards may name as their
  // parent, and the three properties worth pinning are the three that are
  // expensive to get wrong: the cycle guard, what a delete does to the contents,
  // and where a newly made card is born.
  const wb = `/projects/${SLUG}/workbench`;
  const outer = await call(`${wb}/folders`, { method: 'POST', body: { title: 'Outer', x: 10, y: 10 } });
  const inner = await call(`${wb}/folders`, {
    method: 'POST', body: { title: 'Inner', parentId: outer.id, x: 20, y: 20 },
  });
  check('a folder is a card of kind folder', outer.kind, 'folder');
  check('a folder owns its own title', outer.title, 'Outer');
  check('a root folder has no parent', outer.parentId, null);
  check('a nested folder names its parent', inner.parentId, outer.id);

  const filed = await call(`${wb}/cards`, {
    method: 'POST', body: { kind: 'note', text: 'filed on arrival', x: 1, y: 1, parentId: inner.id },
  });
  check('a card is born in the folder it was made in', filed.parentId, inner.id);
  check('and carries an age the smart folders can compare', typeof filed.days, 'number');

  // THE CYCLE GUARD. A refused move must leave the row where it was — resolving
  // to the root instead would look exactly like a move that worked.
  const cycled = await call(`${wb}/cards/${outer.id}`, {
    method: 'PATCH', body: { parentId: inner.id },
  });
  check('a folder cannot be filed into its own descendant', cycled.parentId, null);
  const selfed = await call(`${wb}/cards/${inner.id}`, {
    method: 'PATCH', body: { parentId: inner.id },
  });
  check('and cannot be filed into itself', selfed.parentId, outer.id);

  const lifted = await call(`${wb}/cards/${filed.id}`, { method: 'PATCH', body: { parentId: null } });
  check('a legal move out to the root sticks', lifted.parentId, null);
  await call(`${wb}/cards/${filed.id}`, { method: 'PATCH', body: { parentId: inner.id } });

  let refusedNonFolder = 0;
  try { await call(`${wb}/cards/${inner.id}`, { method: 'PATCH', body: { parentId: filed.id } }); }
  catch { refusedNonFolder = 1; }
  check('only a folder may be a parent', refusedNonFolder, 1);

  // DELETING A FOLDER IS DELETING A NAME. If this ever cascades, it becomes a
  // bulk note delete — the one direction the fail-safe rule forbids.
  const dropped = await call(`${wb}/cards/${inner.id}`, { method: 'DELETE' });
  check('deleting a folder lifts its contents rather than cascading', dropped.lifted.length, 1);
  check('and lifts them one level, not to the root', dropped.liftedTo, outer.id);
  const afterDelete = await board();
  const survivor = afterDelete.cards.find((c) => c.id === filed.id);
  check('the note inside the deleted folder still exists', Boolean(survivor), true);
  check('and now sits in the folder that held its folder', survivor.parentId, outer.id);
  check('the deleted folder is gone', afterDelete.cards.some((c) => c.id === inner.id), false);

  // 6. THE STACK FOLDER (#416). A real row — unlike the derived Roadmap
  // folder, because cards are filed INTO this one — and therefore a
  // flag that has to be defended at every route a folder can be reached
  // through. Three refusals and one permission are what make it what it is.
  const stack = afterDelete.cards.find((c) => c.system === 'stack');
  check('every project has a Stack folder without asking', Boolean(stack), true);
  check('and it is a folder', stack.kind, 'folder');
  check('called Stack', stack.title, 'Stack');
  check('sitting at the root', stack.parentId, null);
  check('reading twice does not make a second one',
    (await board()).cards.filter((c) => c.system === 'stack').length, 1);

  let refusedDelete = 0;
  try { await call(`${wb}/cards/${stack.id}`, { method: 'DELETE' }); } catch { refusedDelete = 1; }
  check('the Stack folder refuses to be deleted', refusedDelete, 1);
  check('and is still there afterwards',
    (await board()).cards.some((c) => c.id === stack.id), true);

  let refusedMove = 0;
  try { await call(`${wb}/cards/${stack.id}`, { method: 'PATCH', body: { parentId: outer.id } }); }
  catch { refusedMove = 1; }
  check('it refuses to be filed into another folder', refusedMove, 1);

  let refusedRename = 0;
  try { await call(`${wb}/cards/${stack.id}`, { method: 'PATCH', body: { title: 'Mine now' } }); }
  catch { refusedRename = 1; }
  check('and refuses to be renamed', refusedRename, 1);

  // Its POSITION is the owner's, though: it drags on the canvas like any card.
  const nudged = await call(`${wb}/cards/${stack.id}`, { method: 'PATCH', body: { x: 300, y: 320 } });
  check('but it moves on the canvas like anything else', `${nudged.x},${nudged.y}`, '300,320');

  // The permission that is the whole reason it is a row and not a query.
  const intoStack = await call(`${wb}/cards/${filed.id}`, {
    method: 'PATCH', body: { parentId: stack.id },
  });
  check('cards can be filed INTO it', intoStack.parentId, stack.id);

  console.log(failed ? `\n${failed} check(s) failed.` : '\nall checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// Create a future and set it to orbit `parentId` — a planet under a star, or a
// moon under a planet, exactly as the galaxy's own PATCH /:id would do it by
// hand from the Sky view.
async function seedAiChain(fromCardId, bystanderCardId) {
  if (!process.env.DATABASE_URL) {
    throw new Error('This test writes the ai chain directly — run it with the same DATABASE_URL as the server.');
  }
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { rows: p } = await db.query('SELECT id FROM projects WHERE slug = $1', [SLUG]);
    const pid = p[0].id;
    const mk = async (title) => (await db.query(
      `INSERT INTO workbench_cards (project_id, kind, op, title, x, y, w)
       VALUES ($1,'ai','critique',$2,0,0,258) RETURNING id`, [pid, title])).rows[0].id;
    const rootId = await mk('op output');
    const leafId = await mk('op output of the op output');
    const link = (a, b, ai) => db.query(
      'INSERT INTO workbench_edges (project_id, a_id, b_id, ai) VALUES ($1,$2,$3,$4)', [pid, a, b, ai]);
    await link(fromCardId, rootId, true);
    await link(rootId, leafId, true);
    // A hand-drawn line from the doomed branch to a plain note: the recursion
    // must stop at it rather than follow the edge into a card it does not own.
    await link(rootId, bystanderCardId, false);
    return { rootId, leafId };
  } finally {
    await db.end();
  }
}
