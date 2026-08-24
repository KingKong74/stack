import { Router } from 'express';
import { pool, q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { NOTE_PALETTE, relativeTime } from '../util.js';
import { workbenchCardShape, workbenchEdgeShape, workbenchBoardShape } from '../shape.js';
import { askGemini, GEMINI_MODELS } from '../gemini.js';
import { agentClient } from '../agents.js';
import { buildPrompt } from '../prompts.js';
import { readSettings, cleanModelAlias } from '../settings.js';
import { extractInsights } from '../debrief.js';
import { numericId } from '../params.js';

// Mounted at /api/projects/:slug/workbench — the planning canvas that replaced
// the notes wall.
//
// THE ONE RULE HERE: a card is a PLACEMENT, not content. A note card carries
// note_id; its words live in `notes` and are read through on the way out and
// written through on the way in. That is what keeps ingest, search, ⌘K and
// promote-to-bug/roadmap all working against a note without ever knowing the
// canvas exists. Only an 'ai' card owns its own title and body, because nothing
// else does. (A 'polaris' card was the second placement kind and went with the
// Polaris cull, along with the funnel it pointed at.)
//
// Positions come from the CLIENT, deliberately. It is the only side that knows
// how tall a card rendered, and stacking an op's output under the last one
// requires that. The server places cards exactly once: the backfill below.
//
// FOLDERS (#414) are cards too — `kind = 'folder'`, owning their own title, with
// `parent_id` saying which folder each card sits in and NULL meaning the root.
// Three rules live at their routes below and nowhere else: only a folder may be
// a parent, the cycle guard is a recursive CTE inside the move's own UPDATE (so
// two tabs cannot race a loop into the tree), and deleting a folder LIFTS its
// contents one level rather than cascading — a cascade would make "delete
// folder" a bulk note delete, which is the fail-safe direction inverted. The
// SMART folders the Explorer shows are computed client-side from the cards this
// route already sends; they are queries, not rows, and must never become rows.
// The one exception is the STACK folder (#416): a real row flagged `system`,
// ensured on every read, refused by DELETE and by a move or a rename. It is a
// row and not a query BECAUSE cards are filed into it — see ensureStackFolder.
//
// Ops are the Gemini surface. Every one of them PROPOSES — output lands as a
// card the owner keeps, edits or cuts. Nothing here writes tracker state; the
// plan card's "promote to Roadmap" is a separate thing the human clicks, and it
// goes through the ordinary roadmap POST.
// Three more consequences of that rule. Removing a note card DOES delete the
// note (it has no other home); cutting an edge drops the 'ai' branch below it,
// and only ever 'ai' cards, which is what makes an op undoable without an undo
// stack; and a READ backfills a card for any note lacking one, which is how
// pre-canvas notes and notes filed through the plain notes route reach the
// canvas at all.
//
// The second pull source is the autopilot DEBRIEF (extraction in ../debrief.js).
// Its structured halves — the session's next_steps/blockers, the advisor's
// stored review_note/architect_note/architect_obs — sort first; the parse of the
// run's free-prose summary is a salvage pass and lands last as kind 'note'. A
// pick travels as a FINGERPRINT, never as text: the server re-runs its own
// extraction and reads the words out of that, so the canvas cannot hold a copy
// that drifted from the record and `debrief` cannot become a source anyone can
// write arbitrary text under. Imports land as a real note keyed on
// fingerprint (re-import is a no-op), dismissed fingerprints are never
// re-offered, and the list comes down including what is already imported, greyed
// — same rule as `onCanvas`. Every skip states its reason. Keyless by design: no
// Gemini in that path, because it reads only what Stack already recorded.
//
// Two op hints are deliberately NARROWER than the design handoff's copy: Gemini
// cannot read the repository, so `Ask` and `Touches` answer from the project
// RECORD (roadmap, bugs, the files recent sessions touched) and say so. Don't
// "fix" that copy back. Same correction on the refine draft: it reads neither
// the run log nor the diff directly, only the session's own account, the second
// model's STORED read and the files that branch touched — so the dialog prints
// the list the server actually assembled (`read[]`), not a fixed caption.
export const workbench = Router({ mergeParams: true });

// Refuse a non-numeric :id before any handler sees it — a NaN reaching
// Postgres used to kill the whole process (see ../params.js).
workbench.param('id', numericId);

workbench.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

// The seven ops, and the width their output card draws at. Keys are the
// prompt-template suffix (`wb` + key) — adding one is a template plus a row.
const OPS = {
  expand: { glyph: '✦', label: 'Expand', w: 268 },
  cluster: { glyph: '⁂', label: 'Cluster', w: 262 },
  plan: { glyph: '⌁', label: 'Draft plan', w: 320 },
  blast: { glyph: '⚠', label: 'Blast radius', w: 258 },
  touches: { glyph: '◎', label: 'Touches', w: 250 },
  critique: { glyph: '✂', label: 'Critique', w: 262 },
  ask: { glyph: '?', label: 'Ask', w: 258 },
};

const BUCKETS = ['must', 'should', 'could', 'wont'];

// How many open board items the Roadmap system folder carries (#415). Capped
// because this rides on every Workbench read, and stated out loud on the folder
// itself — a list that is silently cut reads as the whole board.
const BOARD_IN_FOLDER = 60;

// A note plus its card, or an op's output plus the line feeding it, must land
// together or not at all — a half-written pair is a card with nothing in it, or
// an orphan the canvas never draws.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// A folder id that does not resolve. Distinct from `null`, which is the ROOT and
// a perfectly good answer — collapsing the two would file a card at the top of
// the canvas because someone sent a stale id, which reads as the drop having
// worked and gone somewhere else (#414).
const BAD_PARENT = Symbol('bad-parent');

// `parentId` off the wire -> a folder id, null for the root, or BAD_PARENT.
// Only a FOLDER may hold cards: naming a note as a parent would make a tree the
// Explorer can draw and nothing else in the app can read.
async function resolveParent(projectId, raw, dflt) {
  if (raw === undefined) return dflt;
  if (raw === null || raw === '') return null;
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) return BAD_PARENT;
  const { rows } = await q(
    `SELECT id FROM workbench_cards WHERE project_id = $1 AND id = $2 AND kind = 'folder'`,
    [projectId, id]
  );
  return rows.length ? id : BAD_PARENT;
}

// The SELECT every read goes through. The joins are what let the client treat a
// card's title as a card's title whatever table it actually lives in.
const CARD_SELECT = `
  SELECT c.*, n.text AS note_text, n.colour AS note_colour, n.created_at AS note_created_at
    FROM workbench_cards c
    LEFT JOIN notes n ON n.id = c.note_id`;

const cardsOf = async (projectId) => {
  const { rows } = await q(`${CARD_SELECT} WHERE c.project_id = $1 ORDER BY c.created_at, c.id`, [projectId]);
  return rows.map(workbenchCardShape);
};

const oneCard = async (projectId, id) => {
  const { rows } = await q(`${CARD_SELECT} WHERE c.project_id = $1 AND c.id = $2`, [projectId, id]);
  return rows.length ? workbenchCardShape(rows[0]) : null;
};

// Every note predates the canvas until it doesn't: notes exist from before the
// Workbench shipped, and nothing outside this file creates cards. So a read
// materialises a card for any note that lacks one, laid out in a grid clear of
// whatever is already placed. The unique index on note_id makes this safely
// re-runnable, including from two tabs at once.
async function backfillNoteCards(projectId) {
  const { rows: orphans } = await q(
    `SELECT n.id FROM notes n
      WHERE n.project_id = $1
        AND NOT EXISTS (SELECT 1 FROM workbench_cards c WHERE c.note_id = n.id)
      ORDER BY n.created_at DESC`,
    [projectId]
  );
  if (!orphans.length) return;
  const { rows: extent } = await q(
    'SELECT COALESCE(MAX(y), 0)::int AS max_y FROM workbench_cards WHERE project_id = $1',
    [projectId]
  );
  const y0 = extent[0].max_y ? extent[0].max_y + 190 : 40;
  const values = orphans.map((n, i) => ({
    note_id: n.id, x: 40 + (i % 3) * 268, y: y0 + Math.floor(i / 3) * 150,
  }));
  await q(
    `INSERT INTO workbench_cards (project_id, kind, note_id, x, y, w)
     SELECT $1, 'note', v.note_id, v.x, v.y, 244
       FROM jsonb_to_recordset($2::jsonb) AS v(note_id int, x int, y int)
     ON CONFLICT (note_id) WHERE note_id IS NOT NULL DO NOTHING`,
    [projectId, JSON.stringify(values)]
  );
}

// THE STACK FOLDER (#416) — the one folder a project always has. It is a real
// `folder` card carrying `system = 'stack'`, made here on read rather than at
// project creation, because every project that predates this must get one too
// and a migration that back-filled them would still miss the next project
// created by a path that forgot to call it. Idempotent: the partial unique index
// on (project_id, system) means two tabs reading at once make exactly one.
//
// REAL AND NOT DERIVED, unlike the Roadmap folder (#415), for one reason: it
// HOLDS CARDS. A derived folder has no id, so `parent_id` has nothing to point
// at and nothing can be filed into it. The cost of that choice is the flag has
// to be defended in three places — DELETE, the move, the retitle — and all
// three are below.
const STACK_FOLDER = 'stack';
async function ensureStackFolder(projectId) {
  await q(
    `INSERT INTO workbench_cards (project_id, kind, system, title, parent_id, x, y, w)
     VALUES ($1, 'folder', $2, 'Stack', NULL, 40, 40, 244)
     ON CONFLICT (project_id, system) WHERE system <> '' DO NOTHING`,
    [projectId, STACK_FOLDER]
  );
}

// GET / -> the whole canvas, plus the board for the Roadmap system folder.
workbench.get('/', async (req, res) => {
  await ensureStackFolder(req.project.id);
  await backfillNoteCards(req.project.id);
  const [cards, edges, board, settings] = await Promise.all([
    cardsOf(req.project.id),
    q('SELECT * FROM workbench_edges WHERE project_id = $1 ORDER BY id', [req.project.id]),
    // #415 — the ROADMAP system folder. The Workbench's whole job is turning
    // loose thinking into planned work, and it could not see the plan; this is
    // the board, read-only, so a note can be written next to the item it is
    // about. Deliberately NOT the whole roadmap payload: the folder lists what
    // is OPEN and in play, because a done item is not something you are still
    // thinking about, and it is capped and SAYS SO (#239's rule) rather than
    // quietly showing the first fifty of a hundred.
    q(
      `SELECT id, title, bucket, area, tier, done, updated_at,
              count(*) OVER ()::int AS total
         FROM roadmap_items
        WHERE project_id = $1 AND NOT done AND NOT archived AND NOT skipped
        ORDER BY CASE tier WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 ELSE 4 END,
                 CASE bucket WHEN 'must' THEN 0 WHEN 'should' THEN 1 WHEN 'could' THEN 2 ELSE 3 END,
                 position, id
        LIMIT $2`,
      [req.project.id, BOARD_IN_FOLDER]
    ),
    readSettings(),
  ]);
  res.json({
    cards,
    edges: edges.rows.map(workbenchEdgeShape),
    // The board, in the run queue's own order — the same order the Roadmap tab
    // shows, so the folder is not a second opinion about what comes next.
    board: board.rows.map(workbenchBoardShape),
    boardTotal: board.rows.length ? board.rows[0].total : 0,
    ops: Object.entries(OPS).map(([key, o]) => ({ key, glyph: o.glyph, label: o.label })),
    // #327 — the model picker's catalogue and current pick. Served
    // unconditionally: the client hides the whole ops rail when there's no
    // key, so there's nothing to gate here.
    models: GEMINI_MODELS,
    model: settings.workbench_model,
  });
});

// POST /cards -> put something on the canvas.
//   { kind:'note', text, x, y }  writes a real note, then wraps it
workbench.post('/cards', async (req, res) => {
  const x = clampInt(req.body?.x, -20000, 20000, 40);
  const y = clampInt(req.body?.y, -20000, 20000, 40);
  // A card is born in the folder the canvas was showing (#414). Omitted = the
  // root, which is what every caller predating folders means.
  const parentId = await resolveParent(req.project.id, req.body?.parentId, null);
  if (parentId === BAD_PARENT) return res.status(400).json({ error: 'No such folder.' });

  const text = String(req.body?.text || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Text is required.' });
  // Same palette cycle the notes wall used, so a note filed here looks like a
  // note filed anywhere else.
  const { rows: cnt } = await q('SELECT count(*)::int AS n FROM notes WHERE project_id = $1', [req.project.id]);
  const colour = NOTE_PALETTE[cnt[0].n % NOTE_PALETTE.length];
  const created = await tx(async (c) => {
    const { rows: n } = await c.query(
      `INSERT INTO notes (project_id, text, colour, source) VALUES ($1,$2,$3,'manual') RETURNING id`,
      [req.project.id, text, colour]
    );
    const { rows: card } = await c.query(
      `INSERT INTO workbench_cards (project_id, kind, note_id, x, y, w, parent_id)
       VALUES ($1,'note',$2,$3,$4,244,$5) RETURNING id`,
      [req.project.id, n[0].id, x, y, parentId]
    );
    return card[0].id;
  });
  res.status(201).json(await oneCard(req.project.id, created));
});

// POST /folders -> a new folder in `parentId` (omitted / null = the root).
//
// A folder is a card like any other — it draws on the canvas, it can be wired,
// it has a position — and the only thing that makes it a folder is that other
// cards may name it as their parent. That is why it lives in workbench_cards
// and not in a table of its own: a second table would need its own positions,
// its own edges and its own selection rules, all of which already exist here.
workbench.post('/folders', async (req, res) => {
  const x = clampInt(req.body?.x, -20000, 20000, 40);
  const y = clampInt(req.body?.y, -20000, 20000, 40);
  const title = String(req.body?.title || '').trim().slice(0, 300) || 'New folder';
  const parentId = await resolveParent(req.project.id, req.body?.parentId, null);
  if (parentId === BAD_PARENT) return res.status(400).json({ error: 'No such folder.' });
  const { rows } = await q(
    `INSERT INTO workbench_cards (project_id, kind, title, parent_id, x, y, w)
     VALUES ($1,'folder',$2,$3,$4,$5,244) RETURNING id`,
    [req.project.id, title, parentId, x, y]
  );
  res.status(201).json(await oneCard(req.project.id, rows[0].id));
});

// PATCH /cards/:id -> move it, refile it, retitle it, or edit its body.
//
// A title edit WRITES THROUGH to whatever the card wraps: renaming a note card
// renames the note. Anything else would fork the text and leave ⌘K searching a
// stale copy.
workbench.patch('/cards/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows: cur } = await q(
    'SELECT * FROM workbench_cards WHERE project_id = $1 AND id = $2', [req.project.id, id]);
  if (!cur.length) return res.status(404).json({ error: 'No such card.' });
  const card = cur[0];
  const body = req.body || {};

  // The Stack folder's POSITION is the owner's; its PLACE and its NAME are not
  // (#416). It stays at the root and it stays called Stack, because a pinned
  // folder that has been renamed and dragged three levels down is a folder that
  // cannot be removed and can no longer be recognised — worse than either. Loud
  // rather than silently ignored: no client path sends these, so anything that
  // does is a bug, and a 400 is how it gets found.
  if (card.system) {
    const moving = body.parentId !== undefined
      && (body.parentId === '' || body.parentId === null
        ? card.parent_id !== null
        : Number(body.parentId) !== card.parent_id);
    if (moving) return res.status(400).json({ error: 'The Stack folder stays at the root.' });
    if (body.title !== undefined && String(body.title).trim() !== card.title) {
      return res.status(400).json({ error: 'The Stack folder cannot be renamed.' });
    }
  }

  const sets = [];
  const vals = [req.project.id, id];
  const push = (frag, v) => { vals.push(v); sets.push(`${frag} = $${vals.length}`); };
  if (body.x !== undefined) push('x', clampInt(body.x, -20000, 20000, card.x));
  if (body.y !== undefined) push('y', clampInt(body.y, -20000, 20000, card.y));
  if (body.w !== undefined) push('w', clampInt(body.w, 160, 640, card.w));
  if (body.body !== undefined && body.body && typeof body.body === 'object') {
    push('body', JSON.stringify(body.body));
  }

  // Refiling (#414). THE CYCLE GUARD IS A RECURSIVE CTE INSIDE THIS UPDATE, not
  // a check before it, for the same reason the roadmap's parent guard is: the
  // right-hand side sees the OLD rows, so two tabs dragging two folders into
  // each other cannot race a loop into existence — a loop the Explorer would
  // then recurse into forever. `line` walks UP from the target; if the card
  // being moved is anywhere in that chain the move is refused and the row keeps
  // the parent it had, which is also what a stale target must do. Never
  // resolving to NULL: a rejected drop that quietly filed the card at the root
  // looks exactly like a drop that worked.
  let prefix = '';
  if (body.parentId !== undefined) {
    const target = await resolveParent(req.project.id, body.parentId, card.parent_id);
    if (target === BAD_PARENT) return res.status(400).json({ error: 'No such folder.' });
    if (target === null) {
      sets.push('parent_id = NULL');
    } else {
      vals.push(target);
      const t = `$${vals.length}`;
      prefix = `WITH RECURSIVE line(id) AS (
                    SELECT ${t}::int
                  UNION
                    SELECT c.parent_id FROM workbench_cards c
                      JOIN line l ON c.id = l.id
                     WHERE c.parent_id IS NOT NULL
                 )`;
      sets.push(`parent_id = CASE WHEN EXISTS (SELECT 1 FROM line WHERE id = $2)
                                  THEN parent_id ELSE ${t}::int END`);
    }
  }

  const title = body.title !== undefined ? String(body.title).trim().slice(0, 4000) : null;
  if (title !== null && title) {
    if (card.kind === 'note') {
      await q('UPDATE notes SET text = $2, updated_at = now() WHERE id = $1', [card.note_id, title]);
    } else {
      push('title', title.slice(0, 300));
    }
  }

  if (sets.length) {
    await q(
      `${prefix} UPDATE workbench_cards SET ${sets.join(', ')}, updated_at = now()
        WHERE project_id = $1 AND id = $2`,
      vals
    );
  }
  res.json(await oneCard(req.project.id, id));
});

// Cutting an op's output takes its own output with it — the whole branch that
// grew from it. That recursion only ever follows into 'ai' cards, so a note
// downstream of a cut line stays exactly where it is. It is what makes an op
// undoable without an undo stack.
async function dropAiBranch(projectId, rootId) {
  const { rows } = await q(
    `WITH RECURSIVE doomed(id) AS (
        SELECT $2::int
      UNION
        SELECT e.b_id FROM workbench_edges e
          JOIN doomed d ON e.a_id = d.id
          JOIN workbench_cards c ON c.id = e.b_id AND c.kind = 'ai'
     )
     DELETE FROM workbench_cards WHERE project_id = $1 AND id IN (SELECT id FROM doomed)
     RETURNING id`,
    [projectId, rootId]
  );
  return rows.map((r) => r.id);
}

// DELETE /cards/:id — what "remove" means depends on what the card wraps:
//   note    -> delete the note. It has no other home; this is the sticky's ×.
//   ai      -> delete it and everything it fed.
//   folder  -> delete the FOLDER and LIFT its contents one level (#414).
workbench.delete('/cards/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await q(
    'SELECT * FROM workbench_cards WHERE project_id = $1 AND id = $2', [req.project.id, id]);
  if (!rows.length) return res.status(404).json({ error: 'No such card.' });
  const card = rows[0];

  // The one card that does not delete (#416). The client offers no × on it, so
  // this is the guard behind the guard — and it refuses out loud rather than
  // no-opping, because a delete that reports ok and changes nothing is the
  // worse of the two lies.
  if (card.system) {
    return res.status(400).json({ error: 'The Stack folder cannot be removed. Its contents can.' });
  }

  // Deleting a folder is deleting a NAME, never the work inside it. The
  // children are lifted to the folder's own parent — one level, not to the
  // root, so emptying a folder three deep does not fling its notes to the top
  // of the canvas where nobody was looking. The schema's ON DELETE SET NULL is
  // the backstop for any path that does not come through here; this route is
  // the one that keeps the contents where the owner can still find them.
  if (card.kind === 'folder') {
    const lifted = await tx(async (c) => {
      const { rows: kids } = await c.query(
        'UPDATE workbench_cards SET parent_id = $3, updated_at = now() WHERE project_id = $1 AND parent_id = $2 RETURNING id',
        [req.project.id, id, card.parent_id]
      );
      await c.query('DELETE FROM workbench_cards WHERE project_id = $1 AND id = $2', [req.project.id, id]);
      return kids.map((r) => r.id);
    });
    return res.json({ ok: true, dropped: [id], lifted, liftedTo: card.parent_id ?? null });
  }

  if (card.kind === 'note') {
    await q('DELETE FROM notes WHERE id = $1', [card.note_id]); // cascades the card
    return res.json({ ok: true, dropped: [id], noteId: card.note_id });
  }
  if (card.kind === 'ai') {
    return res.json({ ok: true, dropped: await dropAiBranch(req.project.id, id) });
  }
  await q('DELETE FROM workbench_cards WHERE project_id = $1 AND id = $2', [req.project.id, id]);
  res.json({ ok: true, dropped: [id] });
});

// POST /edges -> wire two cards together by hand.
workbench.post('/edges', async (req, res) => {
  const a = Number(req.body?.a);
  const b = Number(req.body?.b);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) {
    return res.status(400).json({ error: 'Two different cards are required.' });
  }
  const { rows: found } = await q(
    'SELECT id FROM workbench_cards WHERE project_id = $1 AND id = ANY($2::int[])',
    [req.project.id, [a, b]]
  );
  if (found.length < 2) return res.status(404).json({ error: 'No such card.' });
  const { rows } = await q(
    `INSERT INTO workbench_edges (project_id, a_id, b_id, ai) VALUES ($1,$2,$3,false)
     ON CONFLICT (a_id, b_id) DO NOTHING RETURNING *`,
    [req.project.id, a, b]
  );
  if (!rows.length) return res.status(409).json({ error: 'Those cards are already wired.' });
  res.status(201).json(workbenchEdgeShape(rows[0]));
});

// DELETE /edges/:id -> ✂ cut. Drops the op output the line was feeding.
workbench.delete('/edges/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await q(
    'SELECT * FROM workbench_edges WHERE project_id = $1 AND id = $2', [req.project.id, id]);
  if (!rows.length) return res.status(404).json({ error: 'No such line.' });
  const edge = rows[0];
  const { rows: target } = await q(
    'SELECT kind FROM workbench_cards WHERE id = $1', [edge.b_id]);
  await q('DELETE FROM workbench_edges WHERE project_id = $1 AND id = $2', [req.project.id, id]);
  const dropped = target.length && target[0].kind === 'ai'
    ? await dropAiBranch(req.project.id, edge.b_id) : [];
  res.json({ ok: true, dropped });
});

// ---- the debrief import ----

// How many recent autopilot nights the debrief looks at. Fixed, not a query
// param — it is what keeps the picker's list readable, and the +1 in the SQL
// below is what lets the payload say honestly whether it was hit.
const DEBRIEF_CAP = 12;
// How many picks land in one POST. Past this the request still succeeds —
// the caller can just submit again — but nothing past the cap is silently
// dropped, it comes back in `skipped` with a reason.
const DEBRIEF_PICK_CAP = 20;

// The runs-plus-sessions read that turns a project's recent autopilot nights
// into insights. GET /debrief shapes this for browsing; POST /debrief calls
// it again to check picks against — the same extraction both times, so a key
// the picker showed is a key this route can always find, and a key it never
// showed can never be typed in from the client.
async function debriefNights(projectId, days) {
  const { rows: runs } = await q(
    `SELECT id, item_id, item_title, branch, outcome, summary, review_note, architect_note, architect_obs, finished_at
       FROM autopilot_runs
      WHERE project_id = $1 AND finished_at > now() - make_interval(days => $2)
      ORDER BY finished_at DESC LIMIT $3`,
    [projectId, days, DEBRIEF_CAP + 1]
  );
  const shown = runs.slice(0, DEBRIEF_CAP);
  // Sessions are read only for the branches actually in play, and skipped
  // outright when there are none — most windows with no runs have no branches.
  const branches = [...new Set(shown.map((r) => r.branch).filter(Boolean))];
  const { rows: sessions } = branches.length
    ? await q(
        `SELECT branch, summary, current_phase, next_steps, blockers, authored, created_at
           FROM sessions WHERE project_id = $1 AND branch = ANY($2::text[])
          ORDER BY created_at DESC`,
        [projectId, branches]
      )
    : { rows: [] };

  return shown.map((run) => {
    const branchSessions = sessions.filter((s) => s.branch === run.branch);
    const { insights, truncated } = extractInsights(run, branchSessions);
    return {
      // BIGINT comes back from pg as a string; item_id may legitimately be
      // null (a plan night, or a run predating the roadmap link) and that
      // null has to survive, not become 0.
      runId: Number(run.id),
      branch: run.branch,
      day: run.finished_at.toISOString().slice(0, 10),
      when: relativeTime(run.finished_at),
      itemId: run.item_id === null ? null : Number(run.item_id),
      itemTitle: run.item_title,
      outcome: run.outcome,
      insights,
      truncated,
    };
  });
}

// GET /debrief -> what the last few autopilot nights turned up, mined for
// things worth picking up.
//
// Sent down WHOLE, already-imported insights included: the picker's All filter
// has to be able to show one that is already a note, greyed, and `imported` is
// the only thing stopping it being pulled twice. A night that produced nothing
// to act on is still returned
// with an empty `insights` list — dropping it would read as "that night
// never happened", which isn't true.
workbench.get('/debrief', async (req, res) => {
  const days = clampInt(req.query?.days, 1, 90, 21);
  const [nights, totalRes, noteFps, deadFps] = await Promise.all([
    debriefNights(req.project.id, days),
    q(
      `SELECT count(*)::int AS n FROM autopilot_runs
        WHERE project_id = $1 AND finished_at > now() - make_interval(days => $2)`,
      [req.project.id, days]
    ),
    q(`SELECT fingerprint FROM notes WHERE project_id = $1 AND fingerprint <> ''`, [req.project.id]),
    q(`SELECT fingerprint FROM dismissed_items WHERE project_id = $1`, [req.project.id]),
  ]);

  const noteSet = new Set(noteFps.rows.map((r) => r.fingerprint));
  const deadSet = new Set(deadFps.rows.map((r) => r.fingerprint));
  const importedAs = (key) =>
    noteSet.has(key) ? 'note' : deadSet.has(key) ? 'dismissed' : '';

  let total = 0;
  const shaped = nights.map((night) => {
    const insights = night.insights.map((ins) => {
      const as = importedAs(ins.key);
      return { ...ins, imported: as !== '', importedAs: as };
    });
    total += insights.length;
    return { ...night, insights };
  });

  res.json({
    nights: shaped,
    days,
    runsShown: nights.length,
    runsTotal: totalRes.rows[0].n,
    total,
  });
});

// POST /debrief -> land picked insights on the canvas as notes.
//
// The body carries only keys and positions. The server re-runs the same
// extraction GET /debrief just ran and reads the landing text OUT OF THAT —
// never out of anything the client sent — so this route can never become a
// way to write arbitrary text under a 'debrief' source. The re-extraction
// uses the widest window a GET could have shown (90 days, the clamp's own
// ceiling) rather than a client-supplied `days`, so a key picked off any GET
// call is still found here regardless of what window that call used.
workbench.post('/debrief', async (req, res) => {
  // `as` is still validated rather than ignored: the client sends it, and a
  // silently-accepted 'idea' would land a note while the caller believed it had
  // filed an idea. The idea half went with the Polaris cull.
  if (req.body?.as !== undefined && req.body.as !== 'note') {
    return res.status(400).json({ error: "as must be 'note'." });
  }
  // Imports land in the folder the picker was opened from (#414).
  const parentId = await resolveParent(req.project.id, req.body?.parentId, null);
  if (parentId === BAD_PARENT) return res.status(400).json({ error: 'No such folder.' });

  const rawPicks = Array.isArray(req.body?.picks) ? req.body.picks : [];
  const picks = rawPicks.slice(0, DEBRIEF_PICK_CAP);
  const skipped = rawPicks.slice(DEBRIEF_PICK_CAP).map((p) => ({
    key: String(p?.key || ''),
    why: `only the first ${DEBRIEF_PICK_CAP} picks in one import are landed — resubmit the rest separately`,
  }));

  const [nights, noteFps, deadFps] = await Promise.all([
    debriefNights(req.project.id, 90),
    q(`SELECT fingerprint FROM notes WHERE project_id = $1 AND fingerprint <> ''`, [req.project.id]),
    q(`SELECT fingerprint FROM dismissed_items WHERE project_id = $1`, [req.project.id]),
  ]);
  const byKey = new Map();
  for (const night of nights) {
    for (const ins of night.insights) byKey.set(ins.key, { insight: ins, night });
  }
  const noteSet = new Set(noteFps.rows.map((r) => r.fingerprint));
  const deadSet = new Set(deadFps.rows.map((r) => r.fingerprint));

  const toLand = [];
  const claimed = new Set(); // two picks in one request sharing a key is the same hazard, caught before the tx
  for (const p of picks) {
    const key = String(p?.key || '');
    const found = byKey.get(key);
    if (!found) { skipped.push({ key, why: 'that insight is no longer in the debrief' }); continue; }
    if (deadSet.has(key)) { skipped.push({ key, why: 'dismissed' }); continue; }
    if (noteSet.has(key) || claimed.has(key)) {
      skipped.push({ key, why: 'already imported' });
      continue;
    }
    claimed.add(key);
    toLand.push({
      key,
      text: found.insight.text,
      night: found.night,
      x: clampInt(p?.x, -20000, 20000, 40),
      y: clampInt(p?.y, -20000, 20000, 40),
    });
  }

  const cardIds = await tx(async (c) => {
    const ids = [];
    for (const pick of toLand) {
      {
        // Same palette cycle POST /cards uses, so a debrief note looks like
        // any other note filed on the wall.
        const { rows: cnt } = await c.query(
          'SELECT count(*)::int AS n FROM notes WHERE project_id = $1', [req.project.id]);
        const colour = NOTE_PALETTE[cnt[0].n % NOTE_PALETTE.length];
        const { rows: n } = await c.query(
          `INSERT INTO notes (project_id, text, colour, source, fingerprint)
           VALUES ($1,$2,$3,'debrief',$4) RETURNING id`,
          [req.project.id, pick.text.slice(0, 4000), colour, pick.key]
        );
        const { rows: card } = await c.query(
          `INSERT INTO workbench_cards (project_id, kind, note_id, x, y, w, parent_id)
           VALUES ($1,'note',$2,$3,$4,244,$5) RETURNING id`,
          [req.project.id, n[0].id, pick.x, pick.y, parentId]
        );
        ids.push(card[0].id);
      }
    }
    return ids;
  });

  res.json({
    cards: await Promise.all(cardIds.map((id) => oneCard(req.project.id, id))),
    skipped,
  });
});

// ---- the ops ----

const CANVAS_CAP = 40;
const ROADMAP_CAP = 25;
const BUG_CAP = 15;
const FILE_CAP = 30;

const describe = (c) => {
  const kind = c.kind === 'ai' ? `${c.op} output` : 'note';
  const text = c.kind === 'ai' ? c.title : (c.note_text || c.title);
  return `[${kind}] ${String(text || '').slice(0, 240)}`;
};

// What Stack actually knows, assembled once per op. Every list is capped and
// SAYS it is capped with its true total — an unmarked slice reads as "that is
// all there is" and the model then reasons from an absence that isn't real.
// Ordering is by importance, never by recency, so a cap never drops the
// long-standing criticals (the same trap `prompts.js`'s header documents).
async function projectRecord(project) {
  const [road, bugs, files] = await Promise.all([
    q(
      `SELECT id, title, bucket, tier, done, area FROM roadmap_items WHERE project_id = $1
        ORDER BY done ASC,
                 CASE tier WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 ELSE 4 END,
                 CASE bucket WHEN 'must' THEN 0 WHEN 'should' THEN 1 WHEN 'could' THEN 2 ELSE 3 END,
                 position`,
      [project.id]
    ),
    q(
      `SELECT id, title, severity, status FROM bugs WHERE project_id = $1 AND status <> 'fixed'
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                 created_at DESC`,
      [project.id]
    ),
    q(
      `SELECT DISTINCT jsonb_array_elements_text(files_touched) AS f
         FROM (SELECT files_touched FROM sessions
                WHERE project_id = $1 AND jsonb_typeof(files_touched) = 'array'
                ORDER BY created_at DESC LIMIT 25) s`,
      [project.id]
    ),
  ]);

  const capped = (rows, cap, label, fmt) => {
    const shown = rows.slice(0, cap);
    const head = rows.length > cap
      ? `${label} (showing the ${shown.length} that matter most of ${rows.length} — the list is TRUNCATED):`
      : `${label} (all ${rows.length}):`;
    return `${head}\n${shown.map(fmt).join('\n') || '(none)'}`;
  };

  return [
    capped(road.rows, ROADMAP_CAP, 'Roadmap items',
      (r) => `#${r.id} | ${r.bucket}${r.tier ? `/tier ${r.tier}` : ''} | ${r.done ? 'done' : 'open'} | ${r.area || '-'} | ${r.title}`),
    capped(bugs.rows, BUG_CAP, 'Open bugs',
      (b) => `${b.id} | ${b.severity} | ${b.status} | ${b.title}`),
    capped(files.rows.map((r) => r.f).filter(Boolean), FILE_CAP,
      'Files recent sessions touched', (f) => `- ${f}`),
  ].join('\n\n');
}

// POST /ops -> run one op against one card.
//
// The gate is the DRAFTER's, not a bare key check. Every one of the seven
// buttons is that agent's single `canvas` op, so the Workbench answers to a
// switch in Mission Control → Agents like every other surface — and the refusal
// still names the missing backend, because the op is Gemini-backed and the gate
// knows it. The call itself stays here rather than going through
// `drafter.ask()`: this route wants the model's answer field by field (it drops
// anything the op is not allowed to produce) and it honours the canvas's own
// model picker, neither of which the shared ask() path has any business
// knowing.
const drafter = agentClient('drafter');

workbench.post('/ops', async (req, res) => {
  const op = String(req.body?.op || '');
  if (!OPS[op]) return res.status(400).json({ error: 'Unknown op.' });
  try {
    await drafter.gate('canvas');
  } catch (err) {
    return res.status(err.httpStatus || 503).json({ error: err.message });
  }
  const cardId = Number(req.body?.cardId);
  const question = String(req.body?.question || '').trim().slice(0, 400);
  if (op === 'ask' && !question) return res.status(400).json({ error: 'Ask needs a question.' });

  const { rows: all } = await q(
    `${CARD_SELECT} WHERE c.project_id = $1 ORDER BY c.created_at, c.id`, [req.project.id]);
  const sel = all.find((c) => c.id === cardId);
  if (!sel) return res.status(404).json({ error: 'No such card.' });

  const { rows: edges } = await q(
    'SELECT a_id, b_id FROM workbench_edges WHERE project_id = $1', [req.project.id]);
  const wired = new Set();
  edges.forEach((e) => {
    if (e.a_id === sel.id) wired.add(e.b_id);
    if (e.b_id === sel.id) wired.add(e.a_id);
  });
  const others = all.filter((c) => c.id !== sel.id && !wired.has(c.id));

  const context = buildPrompt('wbcontext', {
    PROJECT: req.project.name,
    NORTH_STAR_LINE: req.project.north_star
      ? `NORTH STAR: "${String(req.project.north_star).slice(0, 600)}"` : '',
    SELECTED_KIND: sel.kind === 'ai' ? `an earlier ${sel.op} output` : 'a scratch note',
    SELECTED: describe(sel),
    NEIGHBOURS: all.filter((c) => wired.has(c.id)).map(describe).join('\n') || '(nothing wired to it yet)',
    CANVAS_SHOWN: Math.min(others.length, CANVAS_CAP),
    CANVAS_TOTAL: all.length,
    CANVAS: others.slice(0, CANVAS_CAP).map(describe).join('\n') || '(nothing else on the canvas)',
    RECORD: await projectRecord(req.project),
  });
  const prompt = buildPrompt(`wb${op}`, { CONTEXT: context, QUESTION: question });

  // #327 — the request's model choice wins over the stored setting (what runs
  // is what the picker shows); the stored setting is the fallback.
  const model = cleanModelAlias(req.body?.model) || (await readSettings()).workbench_model;
  let answer;
  try {
    answer = await askGemini(prompt, { timeoutMs: 30_000, model });
  } catch (err) {
    return res.status(err.httpStatus || 502).json({ error: err.message || 'Gemini call failed.' });
  }

  // Take only the fields this op is allowed to produce. A model that returns
  // phases for a critique gets them dropped rather than rendered.
  const lines = (Array.isArray(answer?.lines) ? answer.lines : [])
    .map((l) => ({ mk: String(l?.mk || '·').slice(0, 2), t: String(l?.t || '').trim().slice(0, 300) }))
    .filter((l) => l.t).slice(0, 8);
  const phases = op !== 'plan' ? [] : (Array.isArray(answer?.phases) ? answer.phases : [])
    .map((p, i) => ({
      n: `P${i}`,
      t: String(p?.t || '').trim().slice(0, 160),
      d: String(p?.d || '').trim().slice(0, 400),
      gate: String(p?.gate || '').trim().slice(0, 200),
      bucket: BUCKETS.includes(p?.bucket) ? p.bucket : (i === 0 ? 'must' : i < 3 ? 'should' : 'could'),
    }))
    .filter((p) => p.t).slice(0, 8);
  const chips = op !== 'touches' ? [] : (Array.isArray(answer?.chips) ? answer.chips : [])
    .map((c) => String(c || '').trim().slice(0, 60)).filter(Boolean).slice(0, 8);

  if (!lines.length && !phases.length && !chips.length) {
    return res.status(502).json({ error: 'Gemini gave an unusable answer — try again.' });
  }

  const cardBody = { lines, ...(phases.length ? { phases } : {}), ...(chips.length ? { chips } : {}) };
  // Expand's first three lines are a fork in the road, not a list: marking them
  // pickable is what lets a later op read one branch instead of all three.
  if (op === 'expand') cardBody.choices = Math.min(3, lines.length);
  if (op === 'ask') cardBody.question = question;

  const created = await tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO workbench_cards (project_id, kind, op, title, body, x, y, w, parent_id)
       VALUES ($1,'ai',$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        req.project.id, op,
        String(answer?.title || OPS[op].label).trim().slice(0, 200),
        JSON.stringify(cardBody),
        clampInt(req.body?.x, -20000, 20000, sel.x + sel.w + 60),
        clampInt(req.body?.y, -20000, 20000, sel.y),
        OPS[op].w,
        // Output lands in the SOURCE card's folder, never the caller's idea of
        // one: an op is a thing done to that card, and its answer appearing in
        // a folder the input is not in would break the wire between them across
        // a boundary the canvas cannot draw (#414).
        sel.parent_id ?? null,
      ]
    );
    await c.query(
      'INSERT INTO workbench_edges (project_id, a_id, b_id, ai) VALUES ($1,$2,$3,true)',
      [req.project.id, sel.id, rows[0].id]
    );
    return rows[0].id;
  });

  const { rows: edge } = await q(
    'SELECT * FROM workbench_edges WHERE project_id = $1 AND a_id = $2 AND b_id = $3',
    [req.project.id, sel.id, created]
  );
  res.status(201).json({
    card: await oneCard(req.project.id, created),
    edge: workbenchEdgeShape(edge[0]),
  });
});

// POST /sharpen -> tidy a thought that has not been filed yet (#418).
//
// The corner ＋'s Thought composer is this canvas's front door: what it saves
// is a note, and a note IS a card the next time the canvas is read. So the pass
// over it belongs to the Drafter — one surface, one switch — and it is that
// agent's own `sharpen` op rather than an eighth `canvas` button, because it is
// the only one that runs BEFORE a card exists. /ops reads a card id and writes
// a card and an edge; this reads loose text and writes NOTHING.
//
// It PROPOSES, hardest of all the ✧ surfaces: the answer is shown beside the
// owner's own words and only a press replaces them. Nothing here touches the
// composer's text, and the route cannot — it has no id to write to.
//
// AN EMPTY ANSWER IS THE EXPECTED ONE when the scrap already reads well. The
// prompt says so and this hands `text: ''` straight through, because "already
// clear" is a real answer; turning it into an error would teach the model to
// manufacture a rewrite, which is the failure the Refine draft's `draft: ""`
// exists to prevent.
workbench.post('/sharpen', async (req, res) => {
  try {
    await drafter.gate('sharpen');
  } catch (err) {
    return res.status(err.httpStatus || 503).json({ error: err.message });
  }
  const text = String(req.body?.text || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Write the thought first — there is nothing to sharpen.' });

  const prompt = buildPrompt('sharpen', {
    TEXT: text,
    PROJECT_LINE: `The project is "${req.project.name}".`,
    NORTH_STAR_LINE: req.project.north_star
      ? `Its north star, for tone and vocabulary only: "${String(req.project.north_star).slice(0, 400)}"`
      : '',
  });

  // The canvas's own model picker governs here too — it is the same backend
  // doing the same job on the same tab, and two model settings for one surface
  // is the drifting second truth this codebase keeps refusing to build.
  const model = cleanModelAlias(req.body?.model) || (await readSettings()).workbench_model;
  try {
    const answer = await askGemini(prompt, { timeoutMs: 20_000, model });
    const sharpened = String(answer?.text || '').trim().slice(0, 4000);
    res.json({
      // Identical text is the same answer as none: saying "nothing to sharpen"
      // is honest, while showing the owner their own words as a proposal to
      // accept would be a button that does nothing dressed as one that did.
      text: sharpened && sharpened !== text ? sharpened : '',
      why: String(answer?.why || '').trim().slice(0, 120),
    });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || 'Gemini call failed.' });
  }
});
