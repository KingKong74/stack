import { Router } from 'express';
import { q } from '../db.js';
import { tipShape } from '../shape.js';

// The recipe library — app-wide Claude recipes (the Stack Planning design's
// Tips). Mounted at /api/tips: one library, read from the client's bottom-left
// dock wherever you are. Running a recipe is a client flow (the terminal's
// one-shot brief handoff); POST /:id/run just records that it happened.
export const tips = Router();

const STAGES = new Set(['diverge', 'converge', 'judge', 'ship']);

// Clean an incoming field set (POST body, or PATCH subset). Only fields
// present in the body come back, so PATCH stays partial.
function readFields(body, { partial }) {
  const f = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body ?? {}, k);
  const str = (k, cap) => String(body[k] ?? '').trim().slice(0, cap);
  if (!partial || has('name')) f.name = str('name', 200);
  if (!partial || has('stage')) {
    const s = str('stage', 20);
    f.stage = STAGES.has(s) ? s : 'ship';
  }
  if (!partial || has('surface')) f.surface = str('surface', 40);
  if (!partial || has('blurb')) f.blurb = str('blurb', 300);
  if (!partial || has('when')) f.when_note = str('when', 1000);
  if (!partial || has('prompt')) f.prompt = str('prompt', 8000);
  if (!partial || has('best')) {
    f.best = JSON.stringify((Array.isArray(body.best) ? body.best : [])
      .map((l) => String(l ?? '').trim().slice(0, 300)).filter(Boolean).slice(0, 8));
  }
  if (!partial || has('who')) f.who_note = str('who', 1000);
  if (has('pinned')) f.pinned = !!body.pinned;
  return f;
}

// GET / -> the library, pinned first, then most-run.
tips.get('/', async (_req, res) => {
  const { rows } = await q('SELECT * FROM tips ORDER BY pinned DESC, uses DESC, id');
  res.json(rows.map(tipShape));
});

// POST / -> keep a new recipe.
tips.post('/', async (req, res) => {
  const f = readFields(req.body, { partial: false });
  if (!f.name) return res.status(400).json({ error: 'A name is required.' });
  if (!f.prompt) return res.status(400).json({ error: 'The prompt is the recipe — it is required.' });
  const keys = Object.keys(f);
  const { rows } = await q(
    `INSERT INTO tips (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => f[k])
  );
  res.status(201).json(tipShape(rows[0]));
});

// PATCH /:id -> edit any subset (incl. pin/unpin).
tips.patch('/:id', async (req, res) => {
  const f = readFields(req.body, { partial: true });
  if (Object.prototype.hasOwnProperty.call(f, 'name') && !f.name) {
    return res.status(400).json({ error: 'A name is required.' });
  }
  if (Object.prototype.hasOwnProperty.call(f, 'prompt') && !f.prompt) {
    return res.status(400).json({ error: 'The prompt is the recipe — it is required.' });
  }
  const keys = Object.keys(f);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to change.' });
  const { rows } = await q(
    `UPDATE tips SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [Number(req.params.id), ...keys.map((k) => f[k])]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such recipe.' });
  res.json(tipShape(rows[0]));
});

// POST /:id/run -> the run ledger: bump uses + stamp last_run_at. The actual
// run is the terminal session the client opens with the prompt.
tips.post('/:id/run', async (req, res) => {
  const { rows } = await q(
    'UPDATE tips SET uses = uses + 1, last_run_at = now() WHERE id = $1 RETURNING *',
    [Number(req.params.id)]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such recipe.' });
  res.json(tipShape(rows[0]));
});

// DELETE /:id
tips.delete('/:id', async (req, res) => {
  const { rowCount } = await q('DELETE FROM tips WHERE id = $1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'No such recipe.' });
  res.json({ ok: true });
});
