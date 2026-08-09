// The Roadmap tab's own furniture: the project's AREAS (the timeline's lanes
// and every view's filter chips) and the Plan view's LISTS.
//
// Both are per-project and owner-editable, which is exactly why they are here
// and not in code. Contrast `labels.js`, a fixed registry: a label is a
// classification the whole product understands, an area is a part of one
// particular project and only its owner can name it.
//
// The rule that shapes this whole file: **`roadmap_items.area` stays a free
// STRING.** `project_areas` names and colours areas; it does not own them, and
// there is no foreign key. That is deliberate — `futures.area` mirrors the same
// string, the ingest hook writes areas it has never heard of, and an area that
// only exists because some row mentions it is a real area. So:
//
//  • RENAME rewrites every row carrying the old string, in the same transaction
//    as the row itself. Half a rename is a board that has quietly split one
//    area into two.
//  • DELETE clears the string off its rows rather than deleting them. Deleting
//    an area must never delete work.
//  • READ unions the table with the areas rows actually mention, so an area
//    that arrived via a push shows up as a lane without anyone registering it.

import { Router } from 'express';
import { pool, q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { ensureLists } from '../lists.js';

// Mounted at /api/projects/:slug/board (mergeParams to see :slug).
export const board = Router({ mergeParams: true });

// Resolve the project once for every route under here.
board.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

// The lane palette — sixteen, and the ONLY colours an area may wear.
//
// A closed set rather than a free colour input, for the same reason the label
// registry is code: these dots are read side by side down a Gantt's left edge,
// and a free picker produces two areas a fortnight apart that nobody can tell
// apart at 8px. Every entry is muted to the same degree so no lane shouts, and
// they are ordered so that ADJACENT areas get contrasting hues — the assignment
// below walks this list in order, so neighbours never come out as neighbours.
//
// PALETTE[0] is the fallback for an area with no stored colour, which is a real
// state: an area that arrived from a push has never been given one.
const PALETTE = [
  '#8a847a', '#6f9a72', '#c4623d', '#4f7f8a',
  '#b08a2e', '#7a6f9a', '#b23b3b', '#5f8f6a',
  '#9a6f8a', '#7f8a4f', '#a8734a', '#5b7f9a',
  '#8a6f5a', '#6a8a8a', '#a05f7a', '#6f7a9a',
];
export const AREA_PALETTE = PALETTE;

const clean = (v) => String(v || '').trim().toLowerCase().slice(0, 40);

async function readAreas(projectId) {
  const [stored, mentioned] = await Promise.all([
    q('SELECT id, name, dot, position FROM project_areas WHERE project_id = $1 ORDER BY position, id', [projectId]),
    // The union half: an area is real if any row says so, registered or not.
    q(`SELECT DISTINCT area AS name FROM roadmap_items
        WHERE project_id = $1 AND COALESCE(area, '') <> ''`, [projectId]),
  ]);
  const seen = new Set(stored.rows.map((r) => r.name));
  const out = stored.rows.map((r, idx) => ({
    id: r.id, name: r.name, dot: r.dot || PALETTE[idx % PALETTE.length], registered: true,
  }));
  mentioned.rows
    .filter((r) => !seen.has(r.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((r, k) => {
      out.push({ id: null, name: r.name, dot: PALETTE[(out.length + k) % PALETTE.length], registered: false });
    });
  return out;
}

// GET / -> { areas, lists }
board.get('/', async (req, res) => {
  const [areas, lists] = await Promise.all([
    readAreas(req.project.id),
    ensureLists(q, req.project.id),
  ]);
  res.json({ areas, lists, palette: PALETTE });
});

// POST /areas  { name }
board.post('/areas', async (req, res) => {
  const name = clean(req.body?.name);
  if (!name) return res.status(400).json({ error: 'An area needs a name.' });
  const { rows: pos } = await q(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM project_areas WHERE project_id = $1',
    [req.project.id]
  );
  // Only a colour from the palette. Anything else is dropped rather than
  // stored: a dot the picker cannot show is one the owner cannot change back.
  const dot = PALETTE.includes(String(req.body?.dot || '').trim()) ? String(req.body.dot).trim() : '';
  await q(
    `INSERT INTO project_areas (project_id, name, dot, position) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, name) DO NOTHING`,
    [req.project.id, name, dot, pos[0].p]
  );
  res.status(201).json({ areas: await readAreas(req.project.id) });
});

// PATCH /areas/:name  { name?, dot? }  — rename rewrites every row that carries
// the old string, in the SAME transaction as the registry row.
board.patch('/areas/:name', async (req, res) => {
  const from = clean(req.params.name);
  const to = req.body?.name === undefined ? from : clean(req.body.name);
  if (!to) return res.status(400).json({ error: 'An area needs a name.' });
  // An unknown colour is IGNORED, not stored as ''. Storing '' would silently
  // reset the area to its positional default — the same trap as resolving a bad
  // parentId to NULL: a rejected write must leave the row as it was.
  const raw = req.body?.dot === undefined ? null : String(req.body.dot || '').trim();
  const dot = raw !== null && PALETTE.includes(raw) ? raw : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (to !== from) {
      // The registry row may not exist (an area that arrived from a push), so
      // this is an upsert rather than an update — and the item rewrite runs
      // either way, because the string is the real state.
      await client.query(
        `INSERT INTO project_areas (project_id, name, dot, position)
         SELECT $1, $2, COALESCE($3, ''), COALESCE((SELECT position FROM project_areas WHERE project_id = $1 AND name = $4), 0)
           ON CONFLICT (project_id, name) DO NOTHING`,
        [req.project.id, to, dot, from]
      );
      await client.query('DELETE FROM project_areas WHERE project_id = $1 AND name = $2', [req.project.id, from]);
      await client.query('UPDATE roadmap_items SET area = $1, updated_at = now() WHERE project_id = $2 AND area = $3', [to, req.project.id, from]);
      await client.query('UPDATE futures SET area = $1 WHERE project_id = $2 AND area = $3', [to, req.project.id, from]);
    } else if (dot !== null) {
      await client.query(
        `INSERT INTO project_areas (project_id, name, dot, position) VALUES ($1, $2, $3, 0)
           ON CONFLICT (project_id, name) DO UPDATE SET dot = EXCLUDED.dot`,
        [req.project.id, to, dot]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json({ areas: await readAreas(req.project.id) });
});

// DELETE /areas/:name — clears the tag off its rows. Never deletes work.
board.delete('/areas/:name', async (req, res) => {
  const name = clean(req.params.name);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM project_areas WHERE project_id = $1 AND name = $2', [req.project.id, name]);
    await client.query('UPDATE roadmap_items SET area = NULL, updated_at = now() WHERE project_id = $1 AND area = $2', [req.project.id, name]);
    await client.query('UPDATE futures SET area = NULL WHERE project_id = $1 AND area = $2', [req.project.id, name]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json({ areas: await readAreas(req.project.id) });
});

// POST /lists  { name }
board.post('/lists', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'A list needs a name.' });
  await ensureLists(q, req.project.id);
  const key = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'list').slice(0, 40);
  const { rows: pos } = await q(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM project_lists WHERE project_id = $1',
    [req.project.id]
  );
  const { rows } = await q(
    `INSERT INTO project_lists (project_id, key, name, position) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, key) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, key, name, position`,
    [req.project.id, `${key}-${pos[0].p}`, name, pos[0].p]
  );
  res.status(201).json({ list: rows[0] });
});

// PATCH /lists/:key  { name }
board.patch('/lists/:key', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'A list needs a name.' });
  const { rows } = await q(
    'UPDATE project_lists SET name = $1 WHERE project_id = $2 AND key = $3 RETURNING id, key, name, position',
    [name, req.project.id, String(req.params.key)]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such list.' });
  res.json({ list: rows[0] });
});

// DELETE /lists/:key — the cards do not go with it. Their `list_key` is cleared,
// which returns them to the DERIVED column rather than orphaning them in a
// column that no longer exists.
board.delete('/lists/:key', async (req, res) => {
  const key = String(req.params.key);
  const { rows: left } = await q('SELECT count(*)::int AS n FROM project_lists WHERE project_id = $1', [req.project.id]);
  if (left[0].n <= 1) return res.status(400).json({ error: 'A board needs at least one list.' });
  await q('UPDATE roadmap_items SET list_key = NULL, updated_at = now() WHERE project_id = $1 AND list_key = $2', [req.project.id, key]);
  await q('DELETE FROM project_lists WHERE project_id = $1 AND key = $2', [req.project.id, key]);
  res.json({ ok: true });
});
