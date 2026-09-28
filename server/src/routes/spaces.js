import { Router } from 'express';
import { q } from '../db.js';
import { slugify, relativeTime } from '../util.js';
import { numericId } from '../params.js';

// The Projects page's own furniture, beside the projects themselves: the
// AREAS it groups them into, the WORKFLOWS each hub hosts, and the WISHLIST of
// ideas that aren't projects yet. Mounted at /api/spaces. GET / is one read of
// all three (three aggregate queries, never one per project).
//
// An area is a grouping only. Nothing gates, runs or rolls up on it, so a
// deleted or unknown key degrades to 'personal' rather than erroring.
export const spaces = Router();
spaces.param('id', numericId);

export const FALLBACK_AREA = 'personal';
const STAGES = ['spark', 'scoped', 'ready'];

// An incoming area key that exists, else the fallback. Every write of
// projects.category or wishlist_ideas.category goes through this.
export async function resolveArea(val) {
  const key = String(val ?? '').trim();
  if (!key) return FALLBACK_AREA;
  const { rows } = await q('SELECT 1 FROM categories WHERE key = $1', [key]);
  return rows.length ? key : FALLBACK_AREA;
}

const areaShape = (r) => ({ key: r.key, name: r.name, position: r.position });
const ideaShape = (r) => ({ id: r.id, area: r.category, title: r.title, note: r.note, stage: r.stage });
// Health is derived, never stored: see the workflows comment in schema.sql.
export function workflowShape(r) {
  const status = !r.enabled ? 'paused' : r.last_ok === false ? 'failing' : r.last_run_at ? 'ok' : 'never';
  return {
    id: r.id,
    hub: r.slug,
    name: r.name,
    description: r.description,
    trigger: r.trigger,
    enabled: r.enabled,
    status,
    lastRun: r.last_run_at ? relativeTime(r.last_run_at) || 'just now' : '',
    lastNote: r.last_note,
  };
}

const WF_SELECT = `SELECT w.*, p.slug FROM workflows w JOIN projects p ON p.id = w.project_id`;

spaces.get('/', async (_req, res) => {
  const [areas, workflows, ideas] = await Promise.all([
    q('SELECT * FROM categories ORDER BY position, created_at'),
    q(`${WF_SELECT} WHERE p.deleted_at IS NULL ORDER BY w.created_at, w.id`),
    q('SELECT * FROM wishlist_ideas ORDER BY created_at, id'),
  ]);
  res.json({
    areas: areas.rows.map(areaShape),
    workflows: workflows.rows.map(workflowShape),
    ideas: ideas.rows.map(ideaShape),
  });
});

// ---- areas -------------------------------------------------------------

spaces.post('/areas', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'An area needs a name.' });
  const base = slugify(name);
  let key = base;
  for (let i = 2; ; i++) {
    const { rows } = await q('SELECT 1 FROM categories WHERE key = $1', [key]);
    if (!rows.length) break;
    key = `${base}-${i}`;
  }
  const { rows } = await q(
    `INSERT INTO categories (key, name, position)
     VALUES ($1, $2, (SELECT COALESCE(max(position), -1) + 1 FROM categories)) RETURNING *`,
    [key, name]
  );
  res.status(201).json(areaShape(rows[0]));
});

// A rename keeps the key: projects point at the key, so nothing else moves.
spaces.patch('/areas/:key', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'An area needs a name.' });
  const { rows } = await q('UPDATE categories SET name = $1 WHERE key = $2 RETURNING *', [name, req.params.key]);
  if (!rows.length) return res.status(404).json({ error: 'No such area.' });
  res.json(areaShape(rows[0]));
});

// Refused while anything is in it: deleting an area must never silently
// regroup someone's projects. Empty it first (Edit details → Area).
spaces.delete('/areas/:key', async (req, res) => {
  const key = req.params.key;
  if (key === FALLBACK_AREA) return res.status(409).json({ error: 'Personal is the fallback area and stays.' });
  const { rows: [n] } = await q(
    `SELECT (SELECT count(*) FROM projects WHERE category = $1 AND deleted_at IS NULL)::int
          + (SELECT count(*) FROM wishlist_ideas WHERE category = $1)::int AS n`,
    [key]
  );
  if (n.n) return res.status(409).json({ error: `Move its ${n.n} project${n.n === 1 ? '' : 's'} and ideas out first.` });
  const { rowCount } = await q('DELETE FROM categories WHERE key = $1', [key]);
  if (!rowCount) return res.status(404).json({ error: 'No such area.' });
  res.json({ ok: true });
});

// ---- wishlist ideas ----------------------------------------------------

spaces.post('/ideas', async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'An idea needs a title.' });
  const note = String(req.body?.note || '').trim().slice(0, 500);
  const stage = STAGES.includes(req.body?.stage) ? req.body.stage : 'spark';
  const area = await resolveArea(req.body?.area);
  const { rows } = await q(
    'INSERT INTO wishlist_ideas (category, title, note, stage) VALUES ($1, $2, $3, $4) RETURNING *',
    [area, title, note, stage]
  );
  res.status(201).json(ideaShape(rows[0]));
});

spaces.patch('/ideas/:id', async (req, res) => {
  const b = req.body || {};
  const f = {};
  if ('title' in b) {
    f.title = String(b.title || '').trim().slice(0, 200);
    if (!f.title) return res.status(400).json({ error: 'An idea needs a title.' });
  }
  if ('note' in b) f.note = String(b.note || '').trim().slice(0, 500);
  if ('stage' in b) f.stage = STAGES.includes(b.stage) ? b.stage : 'spark';
  if ('area' in b) f.category = await resolveArea(b.area);
  const keys = Object.keys(f);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to change.' });
  const { rows } = await q(
    `UPDATE wishlist_ideas SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [Number(req.params.id), ...keys.map((k) => f[k])]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such idea.' });
  res.json(ideaShape(rows[0]));
});

spaces.delete('/ideas/:id', async (req, res) => {
  const { rowCount } = await q('DELETE FROM wishlist_ideas WHERE id = $1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'No such idea.' });
  res.json({ ok: true });
});

// ---- workflows ---------------------------------------------------------

const hubId = async (slug) => {
  const { rows } = await q(
    `SELECT id FROM projects WHERE slug = $1 AND kind = 'hub' AND deleted_at IS NULL`, [String(slug || '')]
  );
  return rows[0]?.id ?? null;
};
const one = async (id) => (await q(`${WF_SELECT} WHERE w.id = $1`, [id])).rows[0];

spaces.post('/workflows', async (req, res) => {
  const b = req.body || {};
  const name = slugify(b.name || '');
  if (!String(b.name || '').trim()) return res.status(400).json({ error: 'A workflow needs a name.' });
  const pid = await hubId(b.hub);
  if (!pid) return res.status(400).json({ error: 'A workflow runs inside a hub, and that is not one.' });
  const { rows } = await q(
    `INSERT INTO workflows (project_id, name, description, trigger, enabled)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [pid, name, String(b.description || '').trim().slice(0, 300),
      String(b.trigger || '').trim().slice(0, 60) || 'manual', b.enabled !== false]
  );
  res.status(201).json(workflowShape(await one(rows[0].id)));
});

spaces.patch('/workflows/:id', async (req, res) => {
  const b = req.body || {};
  const f = {};
  if ('name' in b) {
    if (!String(b.name || '').trim()) return res.status(400).json({ error: 'A workflow needs a name.' });
    f.name = slugify(b.name);
  }
  if ('description' in b) f.description = String(b.description || '').trim().slice(0, 300);
  if ('trigger' in b) f.trigger = String(b.trigger || '').trim().slice(0, 60) || 'manual';
  if ('enabled' in b) f.enabled = !!b.enabled;
  const keys = Object.keys(f);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to change.' });
  const { rowCount } = await q(
    `UPDATE workflows SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [Number(req.params.id), ...keys.map((k) => f[k])]
  );
  if (!rowCount) return res.status(404).json({ error: 'No such workflow.' });
  res.json(workflowShape(await one(Number(req.params.id))));
});

spaces.delete('/workflows/:id', async (req, res) => {
  const { rowCount } = await q('DELETE FROM workflows WHERE id = $1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'No such workflow.' });
  res.json({ ok: true });
});

// POST /workflows/:id/runs {ok, note?} -> whatever ran it reports the outcome.
// `ok` must be a real boolean: a missing one would otherwise read as a pass.
spaces.post('/workflows/:id/runs', async (req, res) => {
  const ok = req.body?.ok;
  if (typeof ok !== 'boolean') return res.status(400).json({ error: '`ok` must be true or false.' });
  const note = String(req.body?.note || '').trim().slice(0, 300);
  const { rowCount } = await q(
    'UPDATE workflows SET last_run_at = now(), last_ok = $2, last_note = $3 WHERE id = $1',
    [Number(req.params.id), ok, note]
  );
  if (!rowCount) return res.status(404).json({ error: 'No such workflow.' });
  res.json(workflowShape(await one(Number(req.params.id))));
});
