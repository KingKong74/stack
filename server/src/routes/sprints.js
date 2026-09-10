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
import { sprintShape, dayOf } from '../shape.js';
import { numericId } from '../params.js';

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
const cleanDate = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  // Reject a well-formed string that is not a real day (2026-02-31), which the
  // regex above happily passes and Postgres would reject with a 500.
  const d = new Date(`${t}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === t ? t : null;
};

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
