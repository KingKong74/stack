// SPRINTS (#477) — the commitment surface, and the boundary of what the
// automation is allowed to touch.
//
// A sprint is a named, ordered box of board items. The backlog screen draws
// one div per sprint plus the backlog underneath, dragging a row into a box
// commits it, and the ORDER INSIDE THE BOX IS THE PRIORITY — top is what the
// night takes first. That order replaced the desire tier (#227), which is gone;
// `roadmap_items.sprint_rank` is a dense ascending index scoped to ONE sprint,
// and it is not `position`, which is scoped to the bucket.
//
// FIVE INVARIANTS, and every one of them is a thing a second implementation
// would get wrong:
//
//  1. EXACTLY ONE ACTIVE SPRINT PER PROJECT, and the DATABASE says so — a
//     partial unique index in schema.sql, not a check in this file. "The
//     automation only touches the sprint in progress" is only a sentence while
//     that names one row, and THREE packages decide what may run (this route,
//     `routes/autopilot.js`'s fan-out and the host runner's own pick). A rule
//     living in one of them is a rule the other two can violate. Starting a
//     sprint therefore finishes the incumbent in the SAME transaction; doing it
//     in two statements leaves a window in which the index rejects the write
//     and the caller cannot tell why.
//
//  2. A SPRINT DOES NOT OWN ITS ITEMS. `sprint_id` is ON DELETE SET NULL, so
//     deleting a sprint returns its rows to the backlog. Deleting a decision
//     about work must never delete the work — same rule as an area's delete in
//     `routes/board.js`, and for the same reason.
//
//  3. RANKS ARE DENSIFIED ON EVERY WRITE, never patched in place. `PUT
//     /:id/order` takes the whole ordered list of item ids and rewrites every
//     rank from 0, because the alternative — "insert at rank 4, shuffle the
//     rest" — is a read-modify-write over rows two browsers may both be
//     dragging. A full list is idempotent and a partial one is a race.
//
//  4. THE ORDER PUT IS SCOPED TO THE SPRINT IT NAMES. An id in the body that
//     belongs to another project, or to no sprint, is IGNORED rather than
//     rejected: the body is a snapshot of one box on one screen, and a row
//     somebody else moved out of it between the render and the drop must not
//     take the whole reorder down with it. The response is the sprint's real
//     membership afterwards, so the screen can correct itself.
//
//  5. FINISHING A SPRINT LEAVES ITS UNFINISHED ITEMS IN IT. It does NOT sweep
//     them back to the backlog and it does not carry them into the next sprint.
//     Both are tempting and both silently rewrite history: a done sprint is the
//     record of what was committed to, and a sweep would make every finished
//     sprint read as though it had shipped everything in it. Moving the
//     leftovers on is a drag the owner does, which is one gesture and is
//     visible.
//
// The status vocabulary is `planned | active | done`, with no 'cancelled': a
// sprint nobody ran is deleted, and invariant 2 sends its items home.

import { Router } from 'express';
import { pool, q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { sprintShape, dayOf, cleanDate } from '../shape.js';
import { numericId } from '../params.js';
import { askGemini, geminiEnabled } from '../gemini.js';
import { buildPrompt } from '../prompts.js';
import { APPROVED_SQL } from '../approval.js';
import { normArea } from '../lanes.js';
import { BUCKETS } from '../util.js';

// Roughly a sprint, in points. A CONSTANT and not a setting, deliberately: it
// is a steer inside one prompt, not a rule anything enforces, and a knob would
// imply the number gates something. `points` is unitless (#507) and most rows
// carry none, so this is a hint about when to stop adding — nothing rejects a
// fuller sprint, and a human dragging one more row in is unaffected.
const SPRINT_CAPACITY = 13;

// Priority order, as SQL. `bucket` is a text column with no natural sort — the
// vocabulary's ORDER is the priority (util.js's BUCKETS) and alphabetical puts
// 'high' above 'highest' and 'low' above both. Built from BUCKETS so the two
// cannot drift; the list is code, so interpolating it is not an injection
// surface, and the regex is what keeps that true if somebody edits it.
const BUCKET_ORDER_SQL = `CASE r.bucket ${BUCKETS.map((b, i) => {
  if (!/^[a-z]+$/.test(b)) throw new Error(`bucket ${JSON.stringify(b)} is not a bare word`);
  return `WHEN '${b}' THEN ${i}`;
}).join(' ')} ELSE ${BUCKETS.length} END`;

// Mounted at /api/projects/:slug/sprints.
export const sprints = Router({ mergeParams: true });

// Same guard as every other collection: a non-numeric :id used to reach
// Postgres and take the process with it (see ../params.js).
sprints.param('id', numericId);

sprints.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

export const SPRINT_STATUSES = ['planned', 'active', 'done'];

const cleanName = (v) => String(v ?? '').trim().slice(0, 80);

/**
 * A bare YYYY-MM-DD, or null. `undefined` means "not in this PATCH"; an explicit
 * null, '' or anything unparseable means CLEAR IT.
 *
 * Anything unrecognised clearing the field rather than 400-ing is deliberate and
 * is the safe direction here: the alternative is a sprint stuck with a window
 * nobody can remove because the only value the client can send back is the one
 * the server already refuses. A date is an annotation, not a gate — nothing
 * downstream reads it — so the cost of losing one is a re-type.
 */

/**
 * THE ACTIVE SPRINT OF ONE PROJECT, or null. The single reader every gate in
 * this package goes through, so "the sprint in progress" is looked up one way.
 *
 * NULL IS A REAL AND COMMON ANSWER — a project between sprints — and it means
 * THE AUTOMATION HAS NOTHING TO DO, never "so run anything". That direction is
 * the whole point of the feature and it is the one thing a caller can invert by
 * accident, which is why this returns the row rather than a boolean.
 */
export async function activeSprint(projectId) {
  const { rows } = await q(
    `SELECT * FROM sprints WHERE project_id = $1 AND status = 'active' LIMIT 1`,
    [projectId]
  );
  return rows[0] || null;
}

// GET / — every sprint on the project, in board order.
//
// Planned and active boxes first in their own `position` order, then the done
// ones NEWEST FIRST. A finished sprint is history and history reads backwards;
// interleaving them by position would push this quarter's box below last
// quarter's the moment somebody reordered.
sprints.get('/', async (req, res) => {
  const { rows } = await q(
    `SELECT * FROM sprints WHERE project_id = $1
      ORDER BY (status = 'done') ASC, position ASC, id ASC`,
    [req.project.id]
  );
  const live = rows.filter((r) => r.status !== 'done');
  const done = rows.filter((r) => r.status === 'done')
    .sort((a, b) => new Date(b.ended_at || b.updated_at) - new Date(a.ended_at || a.updated_at));
  res.json([...live, ...done].map(sprintShape));
});

// POST / — open a new sprint. Born `planned`: creating a box and committing to
// running it are two decisions, and a POST that also started the sprint would
// silently finish whichever one is in progress (invariant 1).
sprints.post('/', async (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const { rows: pos } = await q(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM sprints WHERE project_id = $1',
    [req.project.id]
  );
  // The window MAY be set at creation — naming a cycle and saying when it runs
  // is one thought, and making it two round trips would leave every new sprint
  // undated by default. Still optional: both null is the common case.
  const startsOn = cleanDate(req.body?.startsOn);
  const endsOn = cleanDate(req.body?.endsOn);
  if (startsOn && endsOn && endsOn < startsOn) {
    return res.status(400).json({ error: `A sprint cannot end (${endsOn}) before it starts (${startsOn}).` });
  }
  const { rows } = await q(
    `INSERT INTO sprints (project_id, name, position, starts_on, ends_on)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.project.id, name, pos[0].p, startsOn, endsOn]
  );
  res.status(201).json(sprintShape(rows[0]));
});

// PATCH /:id — rename, reposition, or change the status.
//
// THE STATUS CHANGE IS THE WHOLE ROUTE and it runs in a transaction, because
// invariant 1's unique index means "start this one" is inseparable from "finish
// the incumbent". Doing it in two round trips would either race the index or
// leave the project with no sprint in progress if the second write failed —
// and a project with no active sprint is a project the night does nothing on,
// which is a silent outcome and the worst of the three.
sprints.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const wantStatus = req.body?.status === undefined
    ? null
    : String(req.body.status).trim().toLowerCase();
  if (wantStatus !== null && !SPRINT_STATUSES.includes(wantStatus)) {
    return res.status(400).json({ error: `status must be one of ${SPRINT_STATUSES.join(', ')}.` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: mine } = await client.query(
      'SELECT * FROM sprints WHERE project_id = $1 AND id = $2 FOR UPDATE',
      [req.project.id, id]
    );
    if (!mine.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such sprint.' }); }

    if (wantStatus === 'active' && mine[0].status !== 'active') {
      // Finish the incumbent first, inside this transaction. `ended_at` is
      // stamped exactly as an explicit finish would stamp it, because that is
      // what this is — the owner started another sprint, and the one that was
      // running is over.
      await client.query(
        `UPDATE sprints SET status = 'done', ended_at = now(), updated_at = now()
          WHERE project_id = $1 AND status = 'active'`,
        [req.project.id]
      );
    }

    const sets = ['updated_at = now()'];
    const vals = [];
    let i = 1;
    if (req.body?.name !== undefined) {
      const name = cleanName(req.body.name);
      if (!name) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Name cannot be empty.' }); }
      sets.push(`name = $${i++}`); vals.push(name);
    }
    if (req.body?.position !== undefined && Number.isFinite(Number(req.body.position))) {
      sets.push(`position = $${i++}`); vals.push(Math.max(0, Math.trunc(Number(req.body.position))));
    }
    // The planned window. Each end is settable on its own — half a window is a
    // real thing to know ("starts Monday, no end decided") and demanding both
    // would make the first date impossible to enter.
    const startsOn = req.body?.startsOn === undefined ? undefined : cleanDate(req.body.startsOn);
    const endsOn = req.body?.endsOn === undefined ? undefined : cleanDate(req.body.endsOn);
    if (startsOn !== undefined) { sets.push(`starts_on = $${i++}`); vals.push(startsOn); }
    if (endsOn !== undefined) { sets.push(`ends_on = $${i++}`); vals.push(endsOn); }
    // A window that ends before it starts is not a window, and it is the one
    // date mistake worth refusing OUT LOUD rather than storing: every reader
    // would render it as a negative length. Checked against the row's OWN other
    // end when the PATCH only sends one, or "move the start later" would be
    // accepted and silently invert a window somebody set last week.
    // `dayOf`, never a UTC round trip — the row's own dates come back from pg
    // at LOCAL midnight and converting them would compare yesterday's date
    // against today's input. See its header in shape.js.
    const finalStart = startsOn !== undefined ? startsOn : dayOf(mine[0].starts_on);
    const finalEnd = endsOn !== undefined ? endsOn : dayOf(mine[0].ends_on);
    if (finalStart && finalEnd && finalEnd < finalStart) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `A sprint cannot end (${finalEnd}) before it starts (${finalStart}).` });
    }
    if (wantStatus !== null) {
      sets.push(`status = $${i++}`); vals.push(wantStatus);
      // `started_at` is stamped ONCE and never cleared — a sprint restarted
      // after a mistaken finish is still the sprint that started when it did,
      // and COALESCE is what keeps that true without a second column saying so.
      if (wantStatus === 'active') sets.push('started_at = COALESCE(started_at, now()), ended_at = NULL');
      if (wantStatus === 'done') sets.push('ended_at = now()');
      // Back to planned: it is not running and it did not finish, so the finish
      // stamp is a lie that would outlive the mistake.
      if (wantStatus === 'planned') sets.push('ended_at = NULL');
    }
    vals.push(req.project.id, id);
    const { rows } = await client.query(
      `UPDATE sprints SET ${sets.join(', ')} WHERE project_id = $${i++} AND id = $${i} RETURNING *`,
      vals
    );
    await client.query('COMMIT');
    res.json(sprintShape(rows[0]));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

// PUT /:id/order — the drop handler. The body is `{ items: [id, id, …] }`, the
// WHOLE box top to bottom, and every rank is rewritten from 0 (invariant 3).
//
// It also ADOPTS: an id in the list that was in another sprint or in the
// backlog is moved into this one. That is what makes a drag from the backlog
// into a sprint, and a drag between two sprints, the same single request as a
// reorder within one — three gestures the screen cannot always tell apart at
// the moment of the drop, and three round trips where one will do.
sprints.put('/:id/order', async (req, res) => {
  const id = Number(req.params.id);
  const { rows: mine } = await q('SELECT id FROM sprints WHERE project_id = $1 AND id = $2', [req.project.id, id]);
  if (!mine.length) return res.status(404).json({ error: 'No such sprint.' });

  const wanted = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!wanted) return res.status(400).json({ error: 'items must be an array of item ids.' });
  const ids = wanted.map((n) => Math.trunc(Number(n))).filter((n) => Number.isFinite(n) && n > 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Invariant 4 — scope the ids to this project before writing any of them.
    // An id from another project is dropped silently, which is the same
    // handling a row somebody else moved gets, and the response below tells
    // the screen what actually happened.
    const { rows: real } = await client.query(
      'SELECT id FROM roadmap_items WHERE project_id = $1 AND id = ANY($2::int[])',
      [req.project.id, ids]
    );
    const ok = new Set(real.map((r) => r.id));
    const ordered = ids.filter((n) => ok.has(n));

    if (ordered.length) {
      // One statement, ranks from the array's own index. `unnest … WITH
      // ORDINALITY` is what keeps this a single write rather than a loop of
      // N updates inside a transaction the drag is waiting on.
      await client.query(
        `UPDATE roadmap_items r
            SET sprint_id = $2, sprint_rank = o.ord - 1, updated_at = now()
           FROM unnest($3::int[]) WITH ORDINALITY AS o(item_id, ord)
          WHERE r.project_id = $1 AND r.id = o.item_id`,
        [req.project.id, id, ordered]
      );
    }
    // Anything still pointing at this sprint that the body did not list has
    // been dragged OUT of it — back to the backlog. This is the other half of
    // "the body is the whole box": without it, a row removed from the box on
    // screen stays in it in the database and reappears on the next refresh.
    await client.query(
      `UPDATE roadmap_items SET sprint_id = NULL, sprint_rank = 0, updated_at = now()
        WHERE project_id = $1 AND sprint_id = $2 AND NOT (id = ANY($3::int[]))`,
      [req.project.id, id, ordered]
    );
    await client.query('COMMIT');
    res.json({ sprintId: id, items: ordered });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

// DELETE /:id — the box goes, the work stays (invariant 2).
//
// The FK is ON DELETE SET NULL, so the items return to the backlog by
// themselves; `sprint_rank` is zeroed here because a rank left behind is a
// position in a box that no longer exists, and the next drag into any sprint
// would read it as a real one.
sprints.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await q('SELECT id FROM sprints WHERE project_id = $1 AND id = $2', [req.project.id, id]);
  if (!rows.length) return res.status(404).json({ error: 'No such sprint.' });
  await q('UPDATE roadmap_items SET sprint_rank = 0 WHERE project_id = $1 AND sprint_id = $2', [req.project.id, id]);
  await q('DELETE FROM sprints WHERE project_id = $1 AND id = $2', [req.project.id, id]);
  res.json({ ok: true, released: true });
});

// ---------------------------------------------------------------------------
// POST /:id/plan — ✧ THE PLANNER (#522)
// ---------------------------------------------------------------------------
//
// Proposes an order for one sprint, and pulls the backlog rows it wants into
// that order. It WRITES NOTHING. That is not caution, it is the standing rule —
// **agents never write `sprint_id` or `sprint_rank`** — and the reason is the
// same one the sprint gate exists for: sprint membership IS what the machine
// works tonight, so a model that could edit the box would be commissioning its
// own work. The human presses Apply, and Apply is `PUT /:id/order`, which is
// the same call a drag makes.
//
// WHAT MAKES THIS WORTH ASKING A MODEL, and it is not "rank by priority" —
// bucket already does that, and a sort needs no model. It is the AREA LANE, and
// the consequence of it that nothing on any screen says out loud:
//
//   The robot builds one item per area at a time, and a built item HOLDS its
//   area until a human merges and ticks it (lanes.js: an open row with a
//   non-empty `claimed_by` occupies the lane). So a sprint whose runnable rows
//   are all one area STOPS after the first one: it is built, its lane locks,
//   and everything behind it is unreachable until the owner comes back to
//   review. Spreading areas down the order is what keeps a night's second and
//   third pick runnable while the first waits on a verdict.
//
// That is a real, measurable property of this installation's runner, it is
// invisible on the board, and it is the one thing a planner can know that a
// sort cannot. Everything else the prompt weighs — due dates, priority, points,
// visible dependencies — is tie-breaking underneath it.
//
// WHAT IT IS SHOWN IS WHAT IT MAY MOVE. The prompt gets the sprint's current
// rows in full and a CAPPED slice of the backlog, and the cap says its own size
// and axis (#239) — a model handed "the backlog" reasons from absence and will
// confidently explain why it left out rows it was never shown.
//
// HELD ROWS ARE NEVER OFFERED. A `hook`/`fly` row nobody has signed off cannot
// run (#359), so proposing one is proposing work the runner will skip — the
// plan would look fuller than the night it describes. `APPROVED_SQL` is the
// same predicate the runner picks with.
//
// AND THE ANSWER IS FILTERED, NOT TRUSTED. Every id comes back through the same
// row map it went out in; anything that is not a real, open, approved row of
// this project is dropped. A model that invents an id must not be able to make
// the Apply button write one.
sprints.post('/:id/plan', async (req, res) => {
  if (!geminiEnabled()) {
    return res.status(503).json({
      error: 'Gemini is not configured on this server, so the planner cannot run (GEMINI_API_KEY is unset).',
    });
  }
  const id = Number(req.params.id);
  const { rows: box } = await q(
    'SELECT id, name, status FROM sprints WHERE project_id = $1 AND id = $2', [req.project.id, id]);
  if (!box.length) return res.status(404).json({ error: 'No such sprint.' });

  // EVERY open row, and the filtering happens below in two different ways —
  // because "may this be planned" and "does this hold a lane" are different
  // questions over the same table and one query answers both.
  const { rows: all } = await q(
    `SELECT id, title, area, points, bucket, due_on, sprint_id, sprint_rank, claimed_by,
            skipped, parent_id, ${APPROVED_SQL('r')} AS approved
       FROM roadmap_items r
      WHERE project_id = $1 AND NOT done AND NOT archived
      ORDER BY ${BUCKET_ORDER_SQL}, due_on NULLS LAST, created_at`,
    [req.project.id]);

  // A CANDIDATE must be approved, parentless board work. A row a session found
  // and nobody signed off (#359) cannot run, so proposing it would make the
  // plan look fuller than the night it describes; a child is a Roadmap idea and
  // belongs to its parent.
  const rows = all.filter((r) => r.approved && r.parent_id === null);

  const inSprint = rows.filter((r) => Number(r.sprint_id) === id)
    .sort((a, b) => (a.sprint_rank - b.sprint_rank));
  // PARKED ROWS ARE NOT CANDIDATES. `skipped` means planned-but-not-yet, and
  // the agents already leave them alone; offering one here would be the planner
  // arguing with a decision the owner has already made. A parked row ALREADY in
  // the sprint stays in the list it is shown, because taking it out would be a
  // drop nobody asked for.
  const backlog = rows.filter((r) => r.sprint_id === null && !r.skipped);

  // The lanes that are locked right now — a FACT, handed to the model as one.
  //
  // OVER `all`, NEVER OVER THE CANDIDATES, and this is the trap: lanes.js says
  // an OPEN row with a non-empty `claimed_by` occupies its area, and says
  // nothing about approval or parentage. A held row somebody is already
  // building holds its lane exactly as hard as an approved one — it is a branch
  // in that area either way, and that is the whole reason the lane exists. Read
  // off the candidates instead and the planner reports a locked area as free,
  // then fills the sprint with work that cannot run.
  const held = new Map();
  for (const r of all) {
    const area = normArea(r.area);
    if (area && String(r.claimed_by || '').trim() && !held.has(area)) {
      held.set(area, String(r.claimed_by).trim());
    }
  }

  const line = (r) => [
    `#${r.id}`, normArea(r.area) || '(untagged)',
    r.points === null || r.points === undefined ? '-' : String(r.points),
    r.bucket, r.due_on ? dayOf(r.due_on) : '-',
    String(r.title || '').slice(0, 120),
  ].join(' | ');

  const SHOW = 30;
  const shown = backlog.slice(0, SHOW);
  const inPoints = inSprint.reduce((n, r) => n + (Number(r.points) || 0), 0);

  const prompt = buildPrompt('sprintplan', {
    NORTH_STAR_LINE: req.project.north_star
      ? `The project's north star: "${String(req.project.north_star).slice(0, 400)}"` : '',
    HELD_LANES: held.size
      ? [...held].map(([a, by]) => `  ${a} — held by ${by}`).join('\n')
      : '  (none — every area is free)',
    IN_COUNT: String(inSprint.length),
    IN_POINTS: String(inPoints),
    CAPACITY: String(SPRINT_CAPACITY),
    IN_ROWS: inSprint.length ? inSprint.map(line).join('\n') : '  (the sprint is empty)',
    OUT_TOTAL: String(backlog.length),
    OUT_SHOWN: String(shown.length),
    OUT_ROWS: shown.length ? shown.map(line).join('\n') : '  (the backlog is empty)',
  });

  let answer;
  try {
    answer = await askGemini(prompt, { timeoutMs: 45_000 });
  } catch (err) {
    return res.status(err.httpStatus || 502).json({ error: err.message || 'The planner call failed.' });
  }

  // Filter, never trust. Only ids this project actually has, de-duplicated,
  // and only rows that were candidates in the first place.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const allowed = new Set([...inSprint, ...backlog].map((r) => r.id));
  const seen = new Set();
  const order = [];
  for (const entry of Array.isArray(answer?.order) ? answer.order : []) {
    const rid = Math.trunc(Number(entry?.id));
    if (!Number.isFinite(rid) || !allowed.has(rid) || seen.has(rid)) continue;
    seen.add(rid);
    const r = byId.get(rid);
    order.push({
      id: rid,
      title: r.title || '',
      area: normArea(r.area),
      points: r.points === null || r.points === undefined ? null : Number(r.points),
      bucket: r.bucket,
      dueOn: r.due_on ? dayOf(r.due_on) : null,
      // Whether this row is coming FROM the backlog, so the screen can mark the
      // three moves apart: an add, a stay, and (below) a drop.
      adding: r.sprint_id === null,
      laneHeld: !!(normArea(r.area) && held.has(normArea(r.area))),
      why: String(entry?.why || '').trim().slice(0, 160),
    });
  }
  // WHAT APPLYING WOULD REMOVE. `PUT /:id/order` treats the body as the WHOLE
  // box, so a row the plan leaves out goes back to the backlog — that is the
  // drag's own semantics and it must never be a surprise. Computed here rather
  // than left to the client to diff, because the client would have to re-derive
  // which rows were candidates.
  const drops = inSprint.filter((r) => !seen.has(r.id))
    .map((r) => ({ id: r.id, title: r.title || '', area: normArea(r.area) }));

  res.json({
    sprintId: id,
    sprintName: box[0].name,
    // An EMPTY order is a real answer and the prompt invites one: a sprint
    // already in a sensible shape needs no change. The client draws it as
    // "nothing to change", never as a failure.
    order,
    drops,
    heldLanes: [...held].map(([area, by]) => ({ area, by })),
    capacity: {
      target: SPRINT_CAPACITY,
      points: order.reduce((n, r) => n + (r.points || 0), 0),
      unsized: order.filter((r) => r.points === null).length,
    },
    backlogShown: shown.length,
    backlogTotal: backlog.length,
    summary: String(answer?.summary || '').trim().slice(0, 400),
  });
});
