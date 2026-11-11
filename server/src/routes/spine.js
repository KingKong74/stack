// THE SPINE (#608): milestones and slices. Mounted at
// /api/projects/:slug/milestones and /api/projects/:slug/slices.
//
// project → milestone → slice → item, and an item with no slice is in the
// ICEBOX. The rules live in schema.sql's #608 header; the ones this file
// enforces, and why:
//
//  1. AT MOST ONE ACTIVE MILESTONE, guaranteed by a partial unique index.
//     Making one current FINISHES the incumbent in the same transaction, the
//     same move as starting a sprint (routes/sprints.js invariant 1).
//  2. A SLICE ALWAYS HAS A MILESTONE IN ITS OWN PROJECT. POST without one uses
//     the current milestone. A project with NO milestone at all gets a
//     "Current" one made for it: the first slice of a new board should not
//     cost a detour through a screen you have never seen. A project that has
//     milestones but none current is refused out loud, because guessing which
//     one is how work gets filed under the wrong goal.
//  3. DELETING A MILESTONE removes its slices and returns their items to the
//     Icebox, clearing Ready in the same transaction. Work is kept.
//  4. DELETING A SLICE RETURNS ITS ITEMS TO THE ICEBOX, and takes them out of
//     Ready first, in one transaction: Ready ⇒ sliced is a CHECK, and an
//     unsliced row must never be in the build lane.
//
// AGENTS PROPOSE, THE HUMAN DECIDES. Nothing in the automation calls these
// routes; filing an item INTO a slice (POST /roadmap's `sliceId`) is not
// approval, and a held source stays held wherever it lands.

import { Router } from 'express';
import { q, pool } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { milestoneShape, sliceShape, cleanDate } from '../shape.js';
import { numericId } from '../params.js';

export const MILESTONE_STATUSES = ['planned', 'active', 'done'];
const cleanText = (v, cap) => String(v ?? '').trim().slice(0, cap);
// Area names, normalised the way roadmap_items.area is (lowercase, 40 chars),
// deduped, capped. Free strings: a slice may name an area nothing has used yet.
const cleanAreas = (v) => [...new Set((Array.isArray(v) ? v : [])
  .map((a) => String(a ?? '').trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 20);

const withProject = async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
};

// ---------------------------------------------------------------------------
// MILESTONES
// ---------------------------------------------------------------------------
export const milestones = Router({ mergeParams: true });
milestones.param('id', numericId);
milestones.use(withProject);

// The one order every reader uses: live ones by position, finished ones after.
export const MILESTONE_ORDER = `ORDER BY (status = 'done') ASC, position ASC, id ASC`;

milestones.get('/', async (req, res) => {
  const { rows } = await q(`SELECT * FROM milestones WHERE project_id = $1 ${MILESTONE_ORDER}`, [req.project.id]);
  res.json(rows.map(milestoneShape));
});

milestones.post('/', async (req, res) => {
  const name = cleanText(req.body?.name, 120);
  if (!name) return res.status(400).json({ error: 'A milestone needs a name.' });
  const status = req.body?.status === 'active' ? 'active' : 'planned';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (status === 'active') {
      await client.query(
        `UPDATE milestones SET status = 'done', ended_at = now(), updated_at = now()
          WHERE project_id = $1 AND status = 'active'`, [req.project.id]);
    }
    const { rows } = await client.query(
      `INSERT INTO milestones (project_id, name, goal, status, target_on, position, started_at)
       VALUES ($1, $2, $3, $4, $5,
               (SELECT COALESCE(MAX(position), -1) + 1 FROM milestones WHERE project_id = $1),
               CASE WHEN $4 = 'active' THEN now() END)
       RETURNING *`,
      [req.project.id, name, cleanText(req.body?.goal, 20000), status, cleanDate(req.body?.targetOn)]);
    await client.query('COMMIT');
    res.status(201).json(milestoneShape(rows[0]));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

milestones.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body ?? {};
  const want = b.status === undefined ? null : String(b.status).trim().toLowerCase();
  if (want !== null && !MILESTONE_STATUSES.includes(want)) {
    return res.status(400).json({ error: `status must be one of ${MILESTONE_STATUSES.join(', ')}.` });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: mine } = await client.query(
      'SELECT * FROM milestones WHERE project_id = $1 AND id = $2 FOR UPDATE', [req.project.id, id]);
    if (!mine.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such milestone.' }); }
    if (want === 'active' && mine[0].status !== 'active') {
      await client.query(
        `UPDATE milestones SET status = 'done', ended_at = now(), updated_at = now()
          WHERE project_id = $1 AND status = 'active'`, [req.project.id]);
    }
    const sets = ['updated_at = now()'];
    const vals = [req.project.id, id];
    const put = (sql, v) => { vals.push(v); sets.push(sql.replace('?', `$${vals.length}`)); };
    if (b.name !== undefined) {
      const name = cleanText(b.name, 120);
      if (!name) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'A milestone needs a name.' }); }
      put('name = ?', name);
    }
    if (b.goal !== undefined) put('goal = ?', cleanText(b.goal, 20000));
    if (b.targetOn !== undefined) put('target_on = ?', cleanDate(b.targetOn));
    if (b.position !== undefined && Number.isFinite(Number(b.position))) put('position = ?', Math.trunc(Number(b.position)));
    if (want !== null) {
      put('status = ?', want);
      // started_at survives the finish, as a sprint's does; ended_at is cleared
      // if a finished milestone is reopened, because it is no longer over.
      if (want === 'active') sets.push('started_at = COALESCE(started_at, now())', 'ended_at = NULL');
      if (want === 'done') sets.push('ended_at = COALESCE(ended_at, now())');
      if (want === 'planned') sets.push('ended_at = NULL');
    }
    const { rows } = await client.query(
      `UPDATE milestones SET ${sets.join(', ')} WHERE project_id = $1 AND id = $2 RETURNING *`, vals);
    await client.query('COMMIT');
    res.json(milestoneShape(rows[0]));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

milestones.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id FROM milestones WHERE project_id = $1 AND id = $2 FOR UPDATE', [req.project.id, id]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such milestone.' }); }
    // Lock slices before freeing their items, serialising with item filing.
    await client.query('SELECT id FROM slices WHERE milestone_id = $1 FOR UPDATE', [id]);
    await client.query(
      `UPDATE roadmap_items SET ready_at = NULL, ready_rank = 0, slice_id = NULL, slice_rank = 0, updated_at = now()
        WHERE project_id = $1 AND slice_id IN (SELECT id FROM slices WHERE milestone_id = $2)`, [req.project.id, id]);
    await client.query('DELETE FROM slices WHERE project_id = $1 AND milestone_id = $2', [req.project.id, id]);
    await client.query('DELETE FROM milestones WHERE project_id = $1 AND id = $2', [req.project.id, id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// SLICES
// ---------------------------------------------------------------------------
export const slices = Router({ mergeParams: true });
slices.param('id', numericId);
slices.use(withProject);

export const SLICE_ORDER = 'ORDER BY s.archived ASC, m_pos ASC, s.milestone_id ASC, s.position ASC, s.id ASC';
// Slices in milestone order, then their own. Shared with the project payload.
export const SLICE_SELECT = `SELECT s.*, m.position AS m_pos FROM slices s JOIN milestones m ON m.id = s.milestone_id`;

slices.get('/', async (req, res) => {
  const { rows } = await q(`${SLICE_SELECT} WHERE s.project_id = $1 ${SLICE_ORDER}`, [req.project.id]);
  res.json(rows.map(sliceShape));
});

// The milestone a slice write names, checked against THIS project. `null`
// result = refused, and `error` says why.
async function milestoneFor(db, projectId, raw) {
  if (raw !== undefined && raw !== null && raw !== '') {
    const mid = Number(raw);
    const { rows } = Number.isInteger(mid) && mid > 0
      ? await db('SELECT id FROM milestones WHERE id = $1 AND project_id = $2', [mid, projectId]) : { rows: [] };
    return rows.length ? { id: rows[0].id } : { error: `milestoneId ${raw} is not a milestone in this project.` };
  }
  const { rows: active } = await db(`SELECT id FROM milestones WHERE project_id = $1 AND status = 'active'`, [projectId]);
  if (active.length) return { id: active[0].id };
  const { rows: any } = await db('SELECT 1 FROM milestones WHERE project_id = $1 LIMIT 1', [projectId]);
  if (any.length) return { error: 'No milestone is current, so name one (milestoneId) for this slice.' };
  const { rows: made } = await db(
    `INSERT INTO milestones (project_id, name, status, started_at) VALUES ($1, 'Current', 'active', now()) RETURNING id`,
    [projectId]);
  return { id: made[0].id };
}

slices.post('/', async (req, res) => {
  const title = cleanText(req.body?.title, 200);
  if (!title) return res.status(400).json({ error: 'A slice needs a title.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const db = (t, p) => client.query(t, p);
    const m = await milestoneFor(db, req.project.id, req.body?.milestoneId);
    if (m.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: m.error }); }
    const { rows } = await db(
      `INSERT INTO slices (project_id, milestone_id, title, spec, areas, position)
       VALUES ($1, $2, $3, $4, $5::jsonb,
               (SELECT COALESCE(MAX(position), -1) + 1 FROM slices WHERE milestone_id = $2))
       RETURNING *`,
      [req.project.id, m.id, title, cleanText(req.body?.spec, 50000), JSON.stringify(cleanAreas(req.body?.areas))]);
    await client.query('COMMIT');
    res.status(201).json(sliceShape(rows[0]));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

slices.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body ?? {};
  const sets = ['updated_at = now()'];
  const vals = [req.project.id, id];
  const put = (sql, v) => { vals.push(v); sets.push(sql.replace('?', `$${vals.length}`)); };
  if (b.title !== undefined) {
    const title = cleanText(b.title, 200);
    if (!title) return res.status(400).json({ error: 'A slice needs a title.' });
    put('title = ?', title);
  }
  if (b.spec !== undefined) put('spec = ?', cleanText(b.spec, 50000));
  if (b.areas !== undefined) put('areas = ?::jsonb', JSON.stringify(cleanAreas(b.areas)));
  if (b.position !== undefined && Number.isFinite(Number(b.position))) put('position = ?', Math.trunc(Number(b.position)));
  if (b.archived !== undefined) put('archived = ?', !!b.archived);
  if (b.milestoneId !== undefined) {
    // Explicit only: `null` is not "the current one" here, because moving a
    // slice is a decision and an empty value must not make it for you.
    const mid = Number(b.milestoneId);
    const { rows: ok } = Number.isInteger(mid) && mid > 0
      ? await q('SELECT id FROM milestones WHERE id = $1 AND project_id = $2', [mid, req.project.id]) : { rows: [] };
    if (!ok.length) return res.status(400).json({ error: `milestoneId ${b.milestoneId} is not a milestone in this project.` });
    put('milestone_id = ?', mid);
  }
  if (sets.length === 1) return res.status(400).json({ error: 'Nothing to update.' });
  const { rows } = await q(
    `UPDATE slices SET ${sets.join(', ')} WHERE project_id = $1 AND id = $2 RETURNING *`, vals);
  if (!rows.length) return res.status(404).json({ error: 'No such slice.' });
  res.json(sliceShape(rows[0]));
});

slices.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id FROM slices WHERE project_id = $1 AND id = $2 FOR UPDATE', [req.project.id, id]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such slice.' }); }
    // Rule 4: out of Ready, then out of the slice, then the slice goes.
    const { rows: freed } = await client.query(
      `UPDATE roadmap_items SET ready_at = NULL, ready_rank = 0, slice_id = NULL, slice_rank = 0, updated_at = now()
        WHERE project_id = $1 AND slice_id = $2 RETURNING id`, [req.project.id, id]);
    await client.query('DELETE FROM slices WHERE project_id = $1 AND id = $2', [req.project.id, id]);
    await client.query('COMMIT');
    res.json({ ok: true, iced: freed.map((r) => r.id) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});
