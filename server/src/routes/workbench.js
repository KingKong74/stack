import { Router } from 'express';
import { pool, q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { NOTE_PALETTE } from '../util.js';
import { workbenchCardShape, workbenchEdgeShape, workbenchIdeaShape } from '../shape.js';
import { askGemini, geminiEnabled } from '../gemini.js';
import { buildPrompt } from '../prompts.js';

// Mounted at /api/projects/:slug/workbench — the planning canvas that replaced
// the notes wall.
//
// THE ONE RULE HERE: a card is a PLACEMENT, not content. A note card carries
// note_id and a polaris card carries future_id; their words live in `notes` and
// `futures` and are read through on the way out and written through on the way
// in. That is what keeps ingest, search, ⌘K and promote-to-bug/roadmap all
// working against a note without ever knowing the canvas exists — and it is why
// deleting a polaris card must NOT delete the idea. Only an 'ai' card owns its
// own title and body, because nothing else does.
//
// Positions come from the CLIENT, deliberately. It is the only side that knows
// how tall a card rendered, and stacking an op's output under the last one
// requires that. The server places cards exactly once: the backfill below.
//
// Ops are the Gemini surface. Every one of them PROPOSES — output lands as a
// card the owner keeps, edits or cuts. Nothing here writes tracker state; the
// plan card's "promote to Roadmap" is a separate thing the human clicks, and it
// goes through the ordinary roadmap POST.
export const workbench = Router({ mergeParams: true });

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

// The SELECT every read goes through. The joins are what let the client treat a
// card's title as a card's title whatever table it actually lives in.
const CARD_SELECT = `
  SELECT c.*, n.text AS note_text, n.colour AS note_colour, n.created_at AS note_created_at,
         f.title AS future_title, f.created_at AS future_created_at
    FROM workbench_cards c
    LEFT JOIN notes n ON n.id = c.note_id
    LEFT JOIN futures f ON f.id = c.future_id`;

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

// GET / -> the whole canvas, plus EVERY Polaris idea for the pull picker.
//
// The picker sends the whole funnel rather than only what is unpicked, because
// its "All" filter has to be able to show an idea that is already on the canvas
// — greyed, with `onCanvas` saying why it can't be picked twice. Uncapped on
// purpose: `GET /futures` and the detail payload already return the funnel in
// full, and a silent slice here would read as "that's all the ideas you have".
workbench.get('/', async (req, res) => {
  await backfillNoteCards(req.project.id);
  const [cards, edges, ideas] = await Promise.all([
    cardsOf(req.project.id),
    q('SELECT * FROM workbench_edges WHERE project_id = $1 ORDER BY id', [req.project.id]),
    q(
      `SELECT f.id, f.title, f.area, f.created_at, f.is_star,
              (SELECT count(*) FROM futures ch WHERE ch.parent_id = f.id)::int AS links,
              EXISTS (SELECT 1 FROM workbench_cards c WHERE c.future_id = f.id) AS on_canvas
         FROM futures f
        WHERE f.project_id = $1
        ORDER BY f.created_at DESC`,
      [req.project.id]
    ),
  ]);
  res.json({
    cards,
    edges: edges.rows.map(workbenchEdgeShape),
    polaris: ideas.rows.map(workbenchIdeaShape),
    ops: Object.entries(OPS).map(([key, o]) => ({ key, glyph: o.glyph, label: o.label })),
  });
});

// A canvas full of one star's orbit is not a canvas — cap the fan-out.
const CASCADE_PLANETS = 24;

// Pulling a STAR onto the canvas also pulls its direct children (planets) —
// not moons, because star -> planet -> moon is the whole depth this galaxy
// goes to and a moon cascading in behind its planet would bury the canvas two
// levels deep in one click. Three rules that aren't obvious from the SQL:
//   - a planet already on the canvas is NOT duplicated: the INSERT's
//     ON CONFLICT on the future_id partial index just no-ops for it, and we
//     still wire an edge to whatever card it already has.
//   - the UNIQUE (a_id, b_id) index on workbench_edges is what makes a
//     re-pull of the same star idempotent rather than laying a second line
//     over the first.
//   - only DIRECT children cascade (parent_id = the star's id) — a grandchild
//     (a moon) is left in the tray for its own planet to bring in, if ever.
// Returns null when the star has no planets (nothing to report), otherwise
// { cards, edges, placed, total } — `cards` holds only the NEWLY created
// planet cards, `edges` only the edges actually created this call.
async function cascadePlanets(client, projectId, starId, starCardId, starX, starY) {
  const { rows: children } = await client.query(
    `SELECT id, count(*) OVER ()::int AS total
       FROM futures
      WHERE project_id = $1 AND parent_id = $2
      ORDER BY created_at ASC
      LIMIT $3`,
    [projectId, starId, CASCADE_PLANETS]
  );
  if (!children.length) return null;
  const total = children[0].total;
  const planetIds = children.map((c) => c.id);

  const placements = children.map((c, i) => ({
    future_id: c.id,
    x: clampInt(starX + 268, -20000, 20000, starX + 268),
    y: clampInt(starY + i * 128, -20000, 20000, starY + i * 128),
  }));

  // Single multi-row insert — no per-planet query. Planets already on the
  // canvas are silently skipped by the partial unique index.
  const { rows: insertedIds } = await client.query(
    `INSERT INTO workbench_cards (project_id, kind, future_id, x, y, w)
     SELECT $1, 'polaris', v.future_id, v.x, v.y, 244
       FROM jsonb_to_recordset($2::jsonb) AS v(future_id int, x int, y int)
     ON CONFLICT (future_id) WHERE future_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [projectId, JSON.stringify(placements)]
  );
  const newCardShapes = insertedIds.length
    ? (await client.query(
        `${CARD_SELECT} WHERE c.project_id = $1 AND c.id = ANY($2::int[]) ORDER BY c.id`,
        [projectId, insertedIds.map((r) => r.id)]
      )).rows.map(workbenchCardShape)
    : [];

  // Wire the star to every planet's card, new or pre-existing, in one
  // statement. ON CONFLICT (a_id, b_id) is what makes a re-pull non-
  // duplicating; c.id <> starCardId guards defensively even though a planet
  // can never be its own star.
  const { rows: edgeRows } = await client.query(
    `INSERT INTO workbench_edges (project_id, a_id, b_id, ai)
     SELECT $1, $2, c.id, false
       FROM workbench_cards c
      WHERE c.project_id = $1 AND c.future_id = ANY($3::int[]) AND c.id <> $2
     ON CONFLICT (a_id, b_id) DO NOTHING
     RETURNING *`,
    [projectId, starCardId, planetIds]
  );

  return {
    cards: newCardShapes,
    edges: edgeRows.map(workbenchEdgeShape),
    placed: planetIds.length,
    total,
  };
}

// POST /cards -> put something on the canvas.
//   { kind:'note', text, x, y }        writes a real note, then wraps it
//   { kind:'polaris', futureId, x, y } pulls an idea out of the tray — and,
//                                      if it is a star, cascades its planets
workbench.post('/cards', async (req, res) => {
  const x = clampInt(req.body?.x, -20000, 20000, 40);
  const y = clampInt(req.body?.y, -20000, 20000, 40);
  const kind = req.body?.kind === 'polaris' ? 'polaris' : 'note';

  if (kind === 'polaris') {
    const futureId = Number(req.body?.futureId);
    if (!Number.isFinite(futureId)) return res.status(400).json({ error: 'futureId is required.' });
    const { rows: f } = await q(
      'SELECT id, is_star FROM futures WHERE project_id = $1 AND id = $2', [req.project.id, futureId]);
    if (!f.length) return res.status(404).json({ error: 'No such idea.' });

    const result = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO workbench_cards (project_id, kind, future_id, x, y, w)
         VALUES ($1,'polaris',$2,$3,$4,244)
         ON CONFLICT (future_id) WHERE future_id IS NOT NULL DO NOTHING RETURNING id`,
        [req.project.id, futureId, x, y]
      );
      if (!rows.length) return { conflict: true };
      const starCardId = rows[0].id;
      const cascaded = f[0].is_star
        ? await cascadePlanets(c, req.project.id, futureId, starCardId, x, y)
        : null;
      return { starCardId, cascaded };
    });

    if (result.conflict) return res.status(409).json({ error: 'That idea is already on the canvas.' });
    const card = await oneCard(req.project.id, result.starCardId);
    if (result.cascaded) card.cascaded = result.cascaded;
    return res.status(201).json(card);
  }

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
      `INSERT INTO workbench_cards (project_id, kind, note_id, x, y, w)
       VALUES ($1,'note',$2,$3,$4,244) RETURNING id`,
      [req.project.id, n[0].id, x, y]
    );
    return card[0].id;
  });
  res.status(201).json(await oneCard(req.project.id, created));
});

// PATCH /cards/:id -> move it, retitle it, or edit its body.
//
// A title edit WRITES THROUGH to whatever the card wraps: renaming a note card
// renames the note, renaming a polaris card renames the idea. Anything else
// would fork the text and leave ⌘K searching a stale copy.
workbench.patch('/cards/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows: cur } = await q(
    'SELECT * FROM workbench_cards WHERE project_id = $1 AND id = $2', [req.project.id, id]);
  if (!cur.length) return res.status(404).json({ error: 'No such card.' });
  const card = cur[0];
  const body = req.body || {};

  const sets = [];
  const vals = [req.project.id, id];
  const push = (frag, v) => { vals.push(v); sets.push(`${frag} = $${vals.length}`); };
  if (body.x !== undefined) push('x', clampInt(body.x, -20000, 20000, card.x));
  if (body.y !== undefined) push('y', clampInt(body.y, -20000, 20000, card.y));
  if (body.w !== undefined) push('w', clampInt(body.w, 160, 640, card.w));
  if (body.body !== undefined && body.body && typeof body.body === 'object') {
    push('body', JSON.stringify(body.body));
  }

  const title = body.title !== undefined ? String(body.title).trim().slice(0, 4000) : null;
  if (title !== null && title) {
    if (card.kind === 'note') {
      await q('UPDATE notes SET text = $2, updated_at = now() WHERE id = $1', [card.note_id, title]);
    } else if (card.kind === 'polaris') {
      await q('UPDATE futures SET title = $2, updated_at = now() WHERE id = $1',
        [card.future_id, title.slice(0, 300)]);
    } else {
      push('title', title.slice(0, 300));
    }
  }

  if (sets.length) {
    await q(
      `UPDATE workbench_cards SET ${sets.join(', ')}, updated_at = now()
        WHERE project_id = $1 AND id = $2`,
      vals
    );
  }
  res.json(await oneCard(req.project.id, id));
});

// Cutting an op's output takes its own output with it — the whole branch that
// grew from it. That recursion only ever follows into 'ai' cards, so a note or
// an idea downstream of a cut line stays exactly where it is. It is what makes
// an op undoable without an undo stack.
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
//   polaris -> take it off the canvas ONLY. The idea belongs to Polaris.
//   ai      -> delete it and everything it fed.
workbench.delete('/cards/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await q(
    'SELECT * FROM workbench_cards WHERE project_id = $1 AND id = $2', [req.project.id, id]);
  if (!rows.length) return res.status(404).json({ error: 'No such card.' });
  const card = rows[0];

  if (card.kind === 'note') {
    await q('DELETE FROM notes WHERE id = $1', [card.note_id]); // cascades the card
    return res.json({ ok: true, dropped: [id], noteId: card.note_id });
  }
  if (card.kind === 'ai') {
    return res.json({ ok: true, dropped: await dropAiBranch(req.project.id, id) });
  }
  await q('DELETE FROM workbench_cards WHERE project_id = $1 AND id = $2', [req.project.id, id]);
  res.json({ ok: true, dropped: [id], returnedToTray: card.future_id });
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

// ---- the ops ----

const CANVAS_CAP = 40;
const ROADMAP_CAP = 25;
const BUG_CAP = 15;
const FILE_CAP = 30;

const describe = (c) => {
  const kind = c.kind === 'polaris' ? `idea P-${c.future_id}` : c.kind === 'ai' ? `${c.op} output` : 'note';
  const text = c.kind === 'ai' ? c.title : (c.note_text || c.future_title || c.title);
  return `[${kind}] ${String(text || '').slice(0, 240)}`;
};

// What Stack actually knows, assembled once per op. Every list is capped and
// SAYS it is capped with its true total — an unmarked slice reads as "that is
// all there is" and the model then reasons from an absence that isn't real.
// Ordering is by importance, never by recency, so a cap never drops the
// long-standing criticals (the same trap routes/audit.js documents).
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

// POST /ops -> run one op against one card. 503 keyless, like every ✧ surface.
workbench.post('/ops', async (req, res) => {
  const op = String(req.body?.op || '');
  if (!OPS[op]) return res.status(400).json({ error: 'Unknown op.' });
  if (!geminiEnabled()) {
    return res.status(503).json({ error: 'Gemini is not configured on this server (set GEMINI_API_KEY).' });
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
    SELECTED_KIND: sel.kind === 'polaris' ? 'a Polaris idea' : sel.kind === 'ai' ? `an earlier ${sel.op} output` : 'a scratch note',
    SELECTED: describe(sel),
    NEIGHBOURS: all.filter((c) => wired.has(c.id)).map(describe).join('\n') || '(nothing wired to it yet)',
    CANVAS_SHOWN: Math.min(others.length, CANVAS_CAP),
    CANVAS_TOTAL: all.length,
    CANVAS: others.slice(0, CANVAS_CAP).map(describe).join('\n') || '(nothing else on the canvas)',
    RECORD: await projectRecord(req.project),
  });
  const prompt = buildPrompt(`wb${op}`, { CONTEXT: context, QUESTION: question });

  let answer;
  try {
    answer = await askGemini(prompt, { timeoutMs: 30_000 });
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
      `INSERT INTO workbench_cards (project_id, kind, op, title, body, x, y, w)
       VALUES ($1,'ai',$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        req.project.id, op,
        String(answer?.title || OPS[op].label).trim().slice(0, 200),
        JSON.stringify(cardBody),
        clampInt(req.body?.x, -20000, 20000, sel.x + sel.w + 60),
        clampInt(req.body?.y, -20000, 20000, sel.y),
        OPS[op].w,
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
