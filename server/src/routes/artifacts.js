// ARTIFACTS — what a project keeps beside its work: docs, plans, designs,
// links and files. Mounted at /api/projects/:slug/artifacts; the screen is
// web/src/detail/Artifacts.tsx.
//
// Five rules, each one load-bearing:
//
//  • THE BYTES NEVER RIDE A LIST. `file_data` is named by no SELECT here but
//    the one in GET /:id/file. A list that shipped a 10 MB mockup on every
//    tab open would be the reason the screen is slow.
//  • NOTHING HERE IS IN THE PROJECT PAYLOAD. GET /api/projects/:slug is what
//    the SessionStart hook reads on every session; an artifact never joins it.
//  • A FILE IS SERVED AS DATA, NEVER AS A PAGE. Only raster images keep their
//    type (png, jpeg, gif, webp); everything else, SVG included, goes out as
//    an octet-stream attachment under a sandbox CSP. The client turns the
//    bytes into a blob: URL, and a blob URL carries the APP's origin, so an
//    HTML or SVG file opened from one would run script as Stack.
//  • APPROVED PLAN-MODE PLANS LAND HERE as docs, through routes/plans.js
//    (the hook's door); `origin` and `fingerprint` are written only there.
//  • `links` ARE roadmap_items IDS IN THIS PROJECT. A write keeps only the ids
//    that are, so an artifact cannot point at another project's row; a row
//    deleted later simply drops out of the read.

import { Router } from 'express';
import express from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { numericId } from '../params.js';

export const artifacts = Router({ mergeParams: true });
artifacts.param('id', numericId);

artifacts.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

export const ARTIFACT_TYPES = ['doc', 'plan', 'design', 'link', 'file'];
export const FILE_CAP = 10 * 1024 * 1024;
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const ARTIFACT_COLS = 'id, type, title, body, url, tags, links, origin, file_name, file_mime, file_size, created_at, updated_at';
const COLS = ARTIFACT_COLS;

export const artifactShape = (r) => ({
  id: r.id,
  type: r.type,
  title: r.title,
  body: r.body,
  url: r.url,
  tags: Array.isArray(r.tags) ? r.tags : [],
  links: Array.isArray(r.links) ? r.links : [],
  // Where it came from: {} by hand, {kind:'plan-mode', …} from routes/plans.js.
  origin: r.origin && typeof r.origin === 'object' ? r.origin : {},
  file: r.file_size > 0 || r.file_name
    ? { name: r.file_name, size: Number(r.file_size), mime: r.file_mime, image: INLINE_IMAGES.has(r.file_mime) }
    : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// Only fields present in the body come back, so PATCH stays partial.
async function readFields(body, projectId, { partial }) {
  const f = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body ?? {}, k);
  const str = (k, cap) => String(body[k] ?? '').slice(0, cap);
  if (!partial || has('type')) f.type = ARTIFACT_TYPES.includes(body?.type) ? body.type : 'doc';
  if (!partial || has('title')) f.title = str('title', 300);
  if (!partial || has('body')) f.body = str('body', 200_000);
  if (!partial || has('url')) f.url = str('url', 2000).trim();
  if (!partial || has('tags')) {
    const tags = (Array.isArray(body?.tags) ? body.tags : [])
      .map((t) => String(t ?? '').trim().slice(0, 80)).filter(Boolean);
    f.tags = JSON.stringify([...new Set(tags)].slice(0, 20));
  }
  if (!partial || has('links')) {
    const want = [...new Set((Array.isArray(body?.links) ? body.links : [])
      .map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50);
    let keep = [];
    if (want.length) {
      const { rows } = await q(
        'SELECT id FROM roadmap_items WHERE project_id = $1 AND id = ANY($2::int[])', [projectId, want]);
      const ok = new Set(rows.map((r) => r.id));
      keep = want.filter((n) => ok.has(n));
    }
    f.links = JSON.stringify(keep);
  }
  return f;
}

// GET / -> every artifact, most recently edited first, without its bytes.
// Links to rows deleted since are dropped here rather than rewritten.
artifacts.get('/', async (req, res) => {
  const { rows } = await q(
    `SELECT ${COLS} FROM artifacts WHERE project_id = $1 ORDER BY updated_at DESC, id DESC`, [req.project.id]);
  const { rows: live } = await q('SELECT id FROM roadmap_items WHERE project_id = $1', [req.project.id]);
  const ok = new Set(live.map((r) => r.id));
  res.json(rows.map(artifactShape).map((a) => ({ ...a, links: a.links.filter((n) => ok.has(n)) })));
});

artifacts.post('/', async (req, res) => {
  const f = await readFields(req.body, req.project.id, { partial: false });
  const keys = Object.keys(f);
  const { rows } = await q(
    `INSERT INTO artifacts (project_id, ${keys.join(', ')})
     VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING ${COLS}`,
    [req.project.id, ...keys.map((k) => f[k])]);
  res.status(201).json(artifactShape(rows[0]));
});

artifacts.patch('/:id', async (req, res) => {
  const f = await readFields(req.body, req.project.id, { partial: true });
  const keys = Object.keys(f);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to change.' });
  const { rows } = await q(
    `UPDATE artifacts SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now()
     WHERE id = $1 AND project_id = $2 RETURNING ${COLS}`,
    [Number(req.params.id), req.project.id, ...keys.map((k) => f[k])]);
  if (!rows.length) return res.status(404).json({ error: 'No such artifact.' });
  res.json(artifactShape(rows[0]));
});

artifacts.delete('/:id', async (req, res) => {
  const { rowCount } = await q('DELETE FROM artifacts WHERE id = $1 AND project_id = $2',
    [Number(req.params.id), req.project.id]);
  if (!rowCount) return res.status(404).json({ error: 'No such artifact.' });
  res.status(204).end();
});

// PUT /:id/file -> the raw bytes, replacing any before. The name rides
// `x-file-name` (URI-encoded), the type rides content-type.
artifacts.put('/:id/file',
  express.raw({ type: () => true, limit: FILE_CAP }),
  async (req, res) => {
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!data.length) return res.status(400).json({ error: 'The file is empty.' });
    let name = '';
    try { name = decodeURIComponent(String(req.get('x-file-name') || '')); } catch { /* keep '' */ }
    name = name.replace(/[\\/\0\r\n]/g, '_').trim().slice(0, 200) || 'file';
    const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase().slice(0, 100);
    const { rows } = await q(
      `UPDATE artifacts SET file_name = $3, file_mime = $4, file_size = $5, file_data = $6, updated_at = now()
       WHERE id = $1 AND project_id = $2 RETURNING ${COLS}`,
      [Number(req.params.id), req.project.id, name, mime, data.length, data]);
    if (!rows.length) return res.status(404).json({ error: 'No such artifact.' });
    res.json(artifactShape(rows[0]));
  });

// GET /:id/file -> the bytes, served as data (see the header).
artifacts.get('/:id/file', async (req, res) => {
  const { rows } = await q(
    'SELECT file_name, file_mime, file_data FROM artifacts WHERE id = $1 AND project_id = $2',
    [Number(req.params.id), req.project.id]);
  const r = rows[0];
  if (!r || !r.file_data) return res.status(404).json({ error: 'No file on that artifact.' });
  const inline = INLINE_IMAGES.has(r.file_mime);
  res.set('content-type', inline ? r.file_mime : 'application/octet-stream');
  res.set('content-disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(r.file_name || 'file')}`);
  res.set('x-content-type-options', 'nosniff');
  res.set('content-security-policy', "default-src 'none'; sandbox");
  res.set('cache-control', 'private, no-store');
  res.send(r.file_data);
});

// A file over the cap arrives as a 413 from express.raw; say it in words.
artifacts.use((err, _req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: `Files are capped at ${FILE_CAP / 1024 / 1024} MB.` });
  }
  next(err);
});
