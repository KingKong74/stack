// THE READY QUEUE — what the automation BUILDS.
//
// Two lanes, one decision each:
//   • the SPRINT in progress is the PLANNING lane: the plan loop designs and
//     breaks down its items, and never builds them;
//   • READY is the BUILD lane: a standing, ordered queue the loop drains
//     whenever there is budget. Top first.
//
// Being Ready is a human decision, so it is a column (`ready_at`, with
// `ready_rank` its place top-to-bottom) and not derived from anything. Like
// `sprint_id`, only this route writes it: POST /roadmap and the batch cannot,
// so no caller that can write a title (the extractor, a planning run, a
// session) can commission a build by writing one.
//
// A HELD item is refused out loud, naming it: an unapproved row in the build
// queue would sit there never running, which reads as a queue that is stuck.
//
// PUT / takes the WHOLE queue, like PUT /sprints/:id/order: listed ids get
// their rank from their index, anything Ready that the body leaves out leaves
// the queue. The copies of "what builds" are here, routes/autopilot.js's
// fan-out, the runner's pick and web/src/lib/plan.ts; change them together.

import { Router } from 'express';
import { pool } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { isApproved, approvalHold } from '../approval.js';

// Mounted at /api/projects/:slug/ready.
export const ready = Router({ mergeParams: true });

ready.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

ready.put('/', async (req, res) => {
  const wanted = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!wanted) return res.status(400).json({ error: 'items must be an array of item ids.' });
  const ids = [...new Set(wanted.map((n) => Math.trunc(Number(n))).filter((n) => Number.isFinite(n) && n > 0))];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Scoped to this project; an id from elsewhere is dropped, as a sprint drop is.
    const { rows: real } = await client.query(
      'SELECT id, title, source, reviewed_at FROM roadmap_items WHERE project_id = $1 AND id = ANY($2::int[])',
      [req.project.id, ids]
    );
    const held = real.filter((r) => !isApproved(r));
    if (held.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Not approved yet, so it can't be queued to build: ${held.map((r) => `#${r.id} "${r.title}" (${approvalHold(r)})`).join('; ')}.`,
        held: held.map((r) => r.id),
      });
    }
    const ok = new Set(real.map((r) => r.id));
    const ordered = ids.filter((n) => ok.has(n));
    if (ordered.length) {
      // ready_at keeps its first value: it is when the item was queued, and a
      // reorder is not a re-queue.
      await client.query(
        `UPDATE roadmap_items r
            SET ready_at = COALESCE(r.ready_at, now()), ready_rank = o.ord - 1, updated_at = now()
           FROM unnest($2::int[]) WITH ORDINALITY AS o(item_id, ord)
          WHERE r.project_id = $1 AND r.id = o.item_id`,
        [req.project.id, ordered]
      );
    }
    await client.query(
      `UPDATE roadmap_items SET ready_at = NULL, ready_rank = 0, updated_at = now()
        WHERE project_id = $1 AND ready_at IS NOT NULL AND NOT (id = ANY($2::int[]))`,
      [req.project.id, ordered]
    );
    await client.query('COMMIT');
    res.json({ items: ordered });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

// POST /add  -> {items: [...]}: APPEND to the bottom of the queue, in the order
// given, leaving everything already queued where it is. For a bulk "approve
// and queue" from a screen that does not hold the whole queue. Already-queued
// ids keep their place. The same held refusal as PUT.
ready.post('/add', async (req, res) => {
  const wanted = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!wanted || !wanted.length) return res.status(400).json({ error: 'items must be a non-empty array of item ids.' });
  const ids = [...new Set(wanted.map((n) => Math.trunc(Number(n))).filter((n) => Number.isFinite(n) && n > 0))];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: real } = await client.query(
      `SELECT id, title, source, reviewed_at, ready_at FROM roadmap_items
        WHERE project_id = $1 AND id = ANY($2::int[]) FOR UPDATE`,
      [req.project.id, ids]
    );
    const held = real.filter((r) => !isApproved(r));
    if (held.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Not approved yet, so it can't be queued to build: ${held.map((r) => `#${r.id} "${r.title}" (${approvalHold(r)})`).join('; ')}.`,
        held: held.map((r) => r.id),
      });
    }
    const fresh = new Set(real.filter((r) => r.ready_at == null).map((r) => r.id));
    const added = ids.filter((n) => fresh.has(n));
    if (added.length) {
      const { rows: top } = await client.query(
        'SELECT COALESCE(MAX(ready_rank), -1) + 1 AS next FROM roadmap_items WHERE project_id = $1 AND ready_at IS NOT NULL',
        [req.project.id]);
      await client.query(
        `UPDATE roadmap_items r
            SET ready_at = now(), ready_rank = $3 + o.ord - 1, updated_at = now()
           FROM unnest($2::int[]) WITH ORDINALITY AS o(item_id, ord)
          WHERE r.project_id = $1 AND r.id = o.item_id`,
        [req.project.id, added, top[0].next]);
    }
    await client.query('COMMIT');
    res.json({ added });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});
