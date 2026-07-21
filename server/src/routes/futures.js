import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { fingerprint } from '../util.js';
import { futureShape } from '../shape.js';
import { askGemini, geminiEnabled } from '../gemini.js';
import { buildPrompt } from '../prompts.js';

// Mounted at /api/projects/:slug/futures. Futures are loose directional ideas
// curated against the project's north star; promotion to the roadmap is a
// client flow (create the roadmap item, then delete the idea — the delete
// below tombstones a hook idea so the next push won't re-extract it).
export const futures = Router({ mergeParams: true });

futures.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

// GET  /  -> list, newest first
futures.get('/', async (req, res) => {
  const { rows } = await q(
    'SELECT * FROM futures WHERE project_id = $1 ORDER BY created_at DESC',
    [req.project.id]
  );
  res.json(rows.map(futureShape));
});

// POST /  -> create a manual idea
futures.post('/', async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 300);
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const note = String(req.body?.note || '').trim().slice(0, 1000);

  const { rows } = await q(
    `INSERT INTO futures (project_id, title, note, source, fingerprint)
     VALUES ($1,$2,$3,'manual',$4) RETURNING *`,
    [req.project.id, title, note, fingerprint(title)]
  );
  res.status(201).json(futureShape(rows[0]));
});

// PATCH /:id  -> title/note edit, reviewed (the review inbox), alignment (the
//                north-star curation verdict; '' clears back to unsorted)
futures.patch('/:id', async (req, res) => {
  const sets = [];
  const vals = [];
  let i = 1;
  if (req.body?.reviewed !== undefined) {
    sets.push(`reviewed_at = ${req.body.reviewed ? 'now()' : 'NULL'}`);
  }
  if (req.body?.alignment !== undefined) {
    const a = String(req.body.alignment || '').trim();
    sets.push(`alignment = $${i++}`);
    vals.push(['on-course', 'tangent', 'off-course'].includes(a) ? a : null);
  }
  if (req.body?.title !== undefined) {
    const title = String(req.body.title).trim().slice(0, 300);
    if (title) { sets.push(`title = $${i++}`); vals.push(title); }
  }
  if (req.body?.note !== undefined) { sets.push(`note = $${i++}`); vals.push(String(req.body.note).slice(0, 1000)); }
  if (req.body?.area !== undefined) {
    sets.push(`area = $${i++}`);
    vals.push(String(req.body.area || '').trim().toLowerCase().slice(0, 40) || null);
  }
  if (req.body?.canvasX !== undefined) {
    const v = req.body.canvasX === null ? null : Number(req.body.canvasX);
    sets.push(`x_coord = $${i++}`);
    vals.push(v !== null && Number.isFinite(v) && v >= 0 && v <= 20000 ? v : null);
  }
  if (req.body?.canvasY !== undefined) {
    const v = req.body.canvasY === null ? null : Number(req.body.canvasY);
    sets.push(`y_coord = $${i++}`);
    vals.push(v !== null && Number.isFinite(v) && v >= 0 && v <= 20000 ? v : null);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

  vals.push(req.project.id, Number(req.params.id));
  const { rows } = await q(
    `UPDATE futures SET ${sets.join(', ')}, updated_at = now()
      WHERE project_id = $${i++} AND id = $${i} RETURNING *`,
    vals
  );
  if (!rows.length) return res.status(404).json({ error: 'No such idea.' });
  res.json(futureShape(rows[0]));
});

// POST /:id/judge  -> ask Gemini for a SUGGESTED alignment verdict against the
// project's north star. Nothing is written — the client shows the suggestion
// and the human clicks the actual verdict (Gemini proposes, you dispose).
// 503 when the server has no GEMINI_API_KEY.
futures.post('/:id/judge', async (req, res) => {
  if (!geminiEnabled()) {
    return res.status(503).json({ error: 'Gemini is not configured on this server (set GEMINI_API_KEY).' });
  }
  const { rows } = await q(
    'SELECT * FROM futures WHERE project_id = $1 AND id = $2',
    [req.project.id, Number(req.params.id)]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such idea.' });
  const idea = rows[0];
  const northStar = String(req.project.north_star || '').trim();
  if (!northStar) {
    return res.status(400).json({ error: 'This project has no north star to judge against yet.' });
  }

  const prompt = buildPrompt('judge', {
    NORTH_STAR: northStar,
    TITLE: idea.title,
    NOTE_LINE: idea.note ? `Note: ${idea.note}` : '',
  });

  try {
    const answer = await askGemini(prompt);
    const alignment = ['on-course', 'tangent', 'off-course'].includes(answer?.alignment)
      ? answer.alignment : null;
    if (!alignment) return res.status(502).json({ error: 'Gemini gave an unusable answer — try again.' });
    res.json({ alignment, why: String(answer.why || '').slice(0, 300) });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || 'Gemini call failed.' });
  }
});

// DELETE /:id  -> remove; auto (hook) ideas leave a tombstone
futures.delete('/:id', async (req, res) => {
  const { rows } = await q(
    'DELETE FROM futures WHERE project_id = $1 AND id = $2 RETURNING source, fingerprint',
    [req.project.id, Number(req.params.id)]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such idea.' });
  if (rows[0].source === 'hook') {
    await q(
      `INSERT INTO dismissed_items (project_id, kind, fingerprint)
       VALUES ($1,'future',$2) ON CONFLICT DO NOTHING`,
      [req.project.id, rows[0].fingerprint]
    );
  }
  res.json({ ok: true });
});
