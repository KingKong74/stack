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
//  • THE SPINE'S DOCS LIVE HERE TOO (#616): `charter` and `architecture`
//    (at most one each per project, a unique index; a second POST is a 409
//    naming the first) and `adr` (with `status`). They have their own tabs,
//    so the plain list leaves them out; `?types=` asks for them by name.
//  • NOTES (2026-11-09): `note` is the owner's loose idea, kept on the
//    Notes tab until it is turned into a milestone, slice or
//    task. A note is a scratchpad, not work, so the plain list leaves it out
//    too. A converted note is kept, tagged `converted` and `became:<kind>:<id>`.
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

export const ARTIFACT_TYPES = ['doc', 'plan', 'design', 'link', 'file', 'charter', 'architecture', 'adr', 'note'];
// The spine's types, and notes: drawn on the Charter screen, not on Artifacts.
export const SPINE_TYPES = ['charter', 'architecture', 'adr', 'note'];
export const ADR_STATUSES = ['proposed', 'accepted', 'superseded'];
export const FILE_CAP = 10 * 1024 * 1024;
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const ARTIFACT_COLS = 'id, type, title, body, url, tags, links, origin, status, slice_id, file_name, file_mime, file_size, created_at, updated_at';
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
  // #616 — an ADR's status ('' on every other type) and the slice a doc was
  // written for (null = none).
  status: r.status || '',
  sliceId: r.slice_id ?? null,
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
  // #616 — an ADR's status. Anything that is not a real one becomes
  // 'proposed' on an ADR (a decision nobody has ruled on) and '' on every
  // other type, so no doc can wear a status that means nothing for it.
  if (!partial || has('status') || has('type')) {
    const type = f.type ?? body?.type;
    const want = String(body?.status ?? '').trim().toLowerCase();
    if (type === 'adr' || (type === undefined && has('status'))) {
      f.status = ADR_STATUSES.includes(want) ? want : 'proposed';
    } else if (type !== undefined) {
      f.status = '';
    }
  }
  // The slice it was written for, checked against THIS project. A bad id is
  // REFUSED (thrown as a 400 below), not cleared: a decision silently
  // detached from its slice reads as one nobody tied to anything.
  if (has('sliceId')) {
    if (body.sliceId === null || body.sliceId === '') f.slice_id = null;
    else {
      const sid = Number(body.sliceId);
      const { rows } = Number.isInteger(sid) && sid > 0
        ? await q('SELECT id FROM slices WHERE id = $1 AND project_id = $2', [sid, projectId]) : { rows: [] };
      if (!rows.length) throw Object.assign(new Error(`sliceId ${body.sliceId} is not a slice in this project.`), { status: 400 });
      f.slice_id = sid;
    }
  }
  return f;
}

// A second charter or architecture doc trips the unique index. Answer it the
// way a caller can act on: 409, naming the one that exists.
async function spineConflict(e, projectId, type, res) {
  if (e?.code !== '23505' || !['charter', 'architecture'].includes(type)) return false;
  const { rows } = await q('SELECT id FROM artifacts WHERE project_id = $1 AND type = $2', [projectId, type]);
  res.status(409).json({ error: `This project already has a ${type} (artifact ${rows[0]?.id}). Edit that one.`, id: rows[0]?.id ?? null });
  return true;
}
const badRequest = (e, res) => {
  if (e?.status !== 400) return false;
  res.status(400).json({ error: e.message });
  return true;
};

// GET / -> every artifact, most recently edited first, without its bytes.
// Links to rows deleted since are dropped here rather than rewritten.
artifacts.get('/', async (req, res) => {
  // #616 — `?types=charter,adr` asks for those types alone; without it the
  // spine's types are left out, because they have tabs of their own.
  const asked = String(req.query.types || '').split(',').map((t) => t.trim()).filter((t) => ARTIFACT_TYPES.includes(t));
  const { rows } = asked.length
    ? await q(`SELECT ${COLS} FROM artifacts WHERE project_id = $1 AND type = ANY($2::text[]) ORDER BY created_at ASC, id ASC`,
      [req.project.id, asked])
    : await q(`SELECT ${COLS} FROM artifacts WHERE project_id = $1 AND NOT (type = ANY($2::text[]))
                ORDER BY updated_at DESC, id DESC`, [req.project.id, SPINE_TYPES]);
  const { rows: live } = await q('SELECT id FROM roadmap_items WHERE project_id = $1', [req.project.id]);
  const ok = new Set(live.map((r) => r.id));
  res.json(rows.map(artifactShape).map((a) => ({ ...a, links: a.links.filter((n) => ok.has(n)) })));
});

artifacts.post('/', async (req, res) => {
  let f;
  try { f = await readFields(req.body, req.project.id, { partial: false }); }
  catch (e) { if (badRequest(e, res)) return; throw e; }
  const keys = Object.keys(f);
  try {
    const { rows } = await q(
      `INSERT INTO artifacts (project_id, ${keys.join(', ')})
       VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING ${COLS}`,
      [req.project.id, ...keys.map((k) => f[k])]);
    res.status(201).json(artifactShape(rows[0]));
  } catch (e) {
    if (await spineConflict(e, req.project.id, f.type, res)) return;
    throw e;
  }
});

artifacts.patch('/:id', async (req, res) => {
  let f;
  try { f = await readFields(req.body, req.project.id, { partial: true }); }
  catch (e) { if (badRequest(e, res)) return; throw e; }
  // A status only means something on an ADR: read the row's type when the
  // PATCH did not send one, so a status sent to a plain doc is dropped.
  if (f.status !== undefined && f.type === undefined) {
    const { rows: cur } = await q('SELECT type FROM artifacts WHERE id = $1 AND project_id = $2', [Number(req.params.id), req.project.id]);
    if (cur[0] && cur[0].type !== 'adr') delete f.status;
  }
  const keys = Object.keys(f);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to change.' });
  try {
    const { rows } = await q(
      `UPDATE artifacts SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now()
       WHERE id = $1 AND project_id = $2 RETURNING ${COLS}`,
      [Number(req.params.id), req.project.id, ...keys.map((k) => f[k])]);
    if (!rows.length) return res.status(404).json({ error: 'No such artifact.' });
    res.json(artifactShape(rows[0]));
  } catch (e) {
    if (await spineConflict(e, req.project.id, f.type, res)) return;
    throw e;
  }
});

artifacts.delete('/:id', async (req, res) => {
  const { rows } = await q('DELETE FROM artifacts WHERE id = $1 AND project_id = $2 RETURNING type, fingerprint, origin',
    [Number(req.params.id), req.project.id]);
  if (!rows.length) return res.status(404).json({ error: 'No such artifact.' });
  // #626 — deleting a decision a SESSION proposed is a dismissal, and it
  // sticks: the tombstone stops the next /checkpoint proposing it again.
  const r = rows[0];
  if (r.type === 'adr' && r.origin?.kind === 'checkpoint' && String(r.fingerprint).startsWith('adr:')) {
    await q(`INSERT INTO dismissed_items (project_id, kind, fingerprint) VALUES ($1, 'adr', $2) ON CONFLICT DO NOTHING`,
      [req.project.id, String(r.fingerprint).slice(4)]);
  }
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
