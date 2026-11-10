// STARRED — the owner's shortlist inside a project: the cards, notes and docs
// they want one click away. Mounted at /api/projects/:slug/starred; the screen
// is web/src/detail/Starred.tsx.
//
// Four rules, each one load-bearing:
//
//  • A STAR IS `starred_at` ON THE ROW ITSELF (roadmap_items, artifacts), not
//    a table of its own, so deleting a card or note takes its star with it and
//    nothing is left pointing at a row that is gone. NULL = not starred.
//  • A STAR IS NOT PRIORITY. Nothing that orders or gates work (Ready, the run
//    order, the board's sort, the autopilot) reads it. A second priority field
//    would drift from `bucket`, which is the priority.
//  • ONLY THIS ROUTE WRITES IT, and only a human's press calls it. Neither
//    `PATCH /roadmap/:id` nor `PATCH /artifacts/:id` accepts it, and no hook,
//    checkpoint or agent path sends it (templates/stack-agent-context.md).
//  • A STAR IS NOT AN EDIT. The write leaves `updated_at` alone, so starring a
//    doc does not make it "edited just now" and starring a card does not read
//    as movement in the closure counts that lean on `updated_at`.
//    Re-starring keeps the first time (COALESCE): the list's order is when it
//    was starred, and a double press must not reshuffle it.

import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { numericId } from '../params.js';
import { roadmapItemShape } from '../shape.js';
import { artifactShape } from './artifacts.js';

export const starred = Router({ mergeParams: true });
starred.param('id', numericId);

starred.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

// A doc's text is capped here: the list shows a title and a line, never the
// doc, and a 200 KB architecture doc must not ride a list.
export const STAR_BODY_CAP = 600;
const DOC_COLS = `id, type, title, LEFT(body, ${STAR_BODY_CAP}) AS body, url, tags, links, origin, status, slice_id,
  file_name, file_mime, file_size, starred_at, created_at, updated_at`;

// GET / -> { cards, docs }, each newest star first. Two queries, not one per row.
starred.get('/', async (req, res) => {
  const [cards, docs] = await Promise.all([
    q(`SELECT * FROM roadmap_items WHERE project_id = $1 AND starred_at IS NOT NULL
        ORDER BY starred_at DESC, id DESC`, [req.project.id]),
    q(`SELECT ${DOC_COLS} FROM artifacts WHERE project_id = $1 AND starred_at IS NOT NULL
        ORDER BY starred_at DESC, id DESC`, [req.project.id]),
  ]);
  res.json({ cards: cards.rows.map(roadmapItemShape), docs: docs.rows.map(artifactShape) });
});

// PUT /cards/:id and PUT /docs/:id, body { starred: boolean } -> { id, starredAt }.
// `starred` must be a real boolean: a missing or misspelt body is refused, not
// read as "unstar", because a silent unstar loses the owner's place in the list.
function setStar(table) {
  return async (req, res) => {
    const want = req.body?.starred;
    if (typeof want !== 'boolean') return res.status(400).json({ error: 'Send { "starred": true } or { "starred": false }.' });
    const { rows } = await q(
      `UPDATE ${table} SET starred_at = CASE WHEN $3 THEN COALESCE(starred_at, now()) ELSE NULL END
        WHERE id = $1 AND project_id = $2 RETURNING id, starred_at`,
      [Number(req.params.id), req.project.id, want]);
    if (!rows.length) return res.status(404).json({ error: `No such ${table === 'artifacts' ? 'doc' : 'card'} in this project.` });
    res.json({ id: rows[0].id, starredAt: rows[0].starred_at });
  };
}
starred.put('/cards/:id', setStar('roadmap_items'));
starred.put('/docs/:id', setStar('artifacts'));
