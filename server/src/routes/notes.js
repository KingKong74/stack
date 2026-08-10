import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { NOTE_PALETTE } from '../util.js';
import { noteShape } from '../shape.js';
import { numericId } from '../params.js';

// Mounted at /api/projects/:slug/notes.
export const notes = Router({ mergeParams: true });

// Refuse a non-numeric :id before any handler sees it — a NaN reaching
// Postgres used to kill the whole process (see ../params.js).
notes.param('id', numericId);

notes.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

// GET  /  -> list
notes.get('/', async (req, res) => {
  const { rows } = await q(
    'SELECT * FROM notes WHERE project_id = $1 ORDER BY created_at DESC',
    [req.project.id]
  );
  res.json(rows.map(noteShape));
});

// POST /  -> create a note (colour cycles the palette unless one is given)
notes.post('/', async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Text is required.' });

  let colour = String(req.body?.colour || '').trim();
  if (!/^#[0-9a-fA-F]{3,8}$/.test(colour)) {
    const { rows: cnt } = await q('SELECT count(*)::int AS n FROM notes WHERE project_id = $1', [req.project.id]);
    colour = NOTE_PALETTE[cnt[0].n % NOTE_PALETTE.length];
  }

  const { rows } = await q(
    `INSERT INTO notes (project_id, text, colour, source) VALUES ($1,$2,$3,'manual') RETURNING *`,
    [req.project.id, text, colour]
  );
  res.status(201).json(noteShape(rows[0]));
});

// PATCH /:id  -> edit a note's text (inline edit on the sticky)
notes.patch('/:id', async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Text is required.' });
  const { rows } = await q(
    'UPDATE notes SET text = $3, updated_at = now() WHERE project_id = $1 AND id = $2 RETURNING *',
    [req.project.id, Number(req.params.id), text]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such note.' });
  res.json(noteShape(rows[0]));
});

// DELETE /:id
notes.delete('/:id', async (req, res) => {
  const { rowCount } = await q(
    'DELETE FROM notes WHERE project_id = $1 AND id = $2',
    [req.project.id, Number(req.params.id)]
  );
  if (!rowCount) return res.status(404).json({ error: 'No such note.' });
  res.json({ ok: true });
});
