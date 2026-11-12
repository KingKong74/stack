// THE FILE EXCHANGE — how files cross between the owner and a project's
// sessions. Mounted at /api/files. The owner's half is the Artifacts screen
// (web/src/detail/Artifacts.tsx); the host's half is the terminal daemon's
// sync loop (terminal/file-sync.mjs), which DIALS OUT here like everything
// else host-side: the server never reaches the host.
//
//   owner drops a file ──► artifact, exchange='in' ──► daemon mirrors it to
//                                                      ~/.stack/files/<slug>/inbox/<hostName>
//   a session writes  ~/.stack/files/<slug>/outbox/<name> ──► daemon PUTs it
//                                                      here ──► artifact, exchange='out'
//
// Rules worth the ink:
//
//  • 'out' IS WRITTEN HERE ALONE. It means "a session made this"; the plain
//    artifacts route can share ('in') or keep (''), never claim 'out'.
//  • ONE ARTIFACT PER OUTBOX NAME. The fingerprint is `out:<name>` under the
//    existing unique index, so a session rewriting `report.md` updates the
//    one row rather than piling up copies, and a retried upload is a no-op.
//    A row the owner deleted comes back only if the session writes the file
//    again (the daemon remembers what it already sent).
//  • THE SYNC LIST CARRIES NO BYTES. The daemon fetches each file through the
//    artifacts route's own GET /:id/file, once per version.
//  • "SYNCED" IS ONLY WHAT THE DAEMON SAID. `lastSyncAt` lives in memory and
//    is stamped by the daemon's own poll; null (a restart, or no daemon)
//    reads on the screen as "Stack cannot see the host", never as "in sync".

import { Router } from 'express';
import express from 'express';
import { createHash } from 'node:crypto';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { ARTIFACT_COLS, FILE_CAP, artifactShape, safeFileName } from './artifacts.js';

export const files = Router();

// A daemon polls every 20s; after this long without one the screen says the
// host has gone quiet.
export const SYNC_STALE_SEC = 90;
let lastSyncAt = null;

// GET /sync -> the daemon's poll: every live project's slug (so it can make
// each one's folders) and every shared file, without its bytes.
files.get('/sync', async (_req, res) => {
  const [{ rows: projects }, { rows }] = await Promise.all([
    q('SELECT slug FROM projects WHERE deleted_at IS NULL ORDER BY slug'),
    q(`SELECT a.id, a.file_name, a.file_size AS size, a.updated_at, p.slug
         FROM artifacts a JOIN projects p ON p.id = a.project_id
        WHERE a.exchange = 'in' AND a.file_size > 0 AND p.deleted_at IS NULL
        ORDER BY a.id`),
  ]);
  lastSyncAt = new Date().toISOString();
  res.json({
    projects: projects.map((r) => r.slug),
    inbox: rows.map((r) => ({
      slug: r.slug, id: r.id, name: r.file_name, size: Number(r.size),
      hostName: `${r.id}-${safeFileName(r.file_name)}`, updatedAt: r.updated_at,
    })),
  });
});

// GET /status -> what the screen needs to say whether the host can see drops.
files.get('/status', (_req, res) => {
  const age = lastSyncAt ? Math.round((Date.now() - Date.parse(lastSyncAt)) / 1000) : null;
  res.json({ lastSyncAt, live: age !== null && age <= SYNC_STALE_SEC, staleAfterSec: SYNC_STALE_SEC });
});

const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// PUT /:slug/out/:name -> one file a session left in its outbox. Raw bytes;
// the type rides content-type. Upserts the one row for that name.
files.put('/:slug/out/:name',
  express.raw({ type: () => true, limit: FILE_CAP }),
  async (req, res) => {
    const project = await projectBySlug(req.params.slug);
    if (!project) return res.status(404).json({ error: 'No such project.' });
    const name = safeFileName(req.params.name);
    if (name !== req.params.name) return res.status(400).json({ error: 'That is not a plain outbox file name.' });
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!data.length) return res.status(400).json({ error: 'The file is empty.' });
    const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase().slice(0, 100);
    const sha = createHash('sha256').update(data).digest('hex');
    const type = INLINE_IMAGES.has(mime) ? 'design' : 'file';
    const origin = JSON.stringify({ kind: 'session-outbox', sha256: sha });
    const { rows } = await q(
      `INSERT INTO artifacts (project_id, type, title, exchange, fingerprint, origin, file_name, file_mime, file_size, file_data)
       VALUES ($1, $2, $3, 'out', $4, $5::jsonb, $3, $6, $7, $8)
       ON CONFLICT (project_id, fingerprint) WHERE fingerprint <> ''
       DO UPDATE SET file_mime = EXCLUDED.file_mime, file_size = EXCLUDED.file_size, file_data = EXCLUDED.file_data,
                     origin = EXCLUDED.origin, updated_at = now()
         WHERE artifacts.origin->>'sha256' IS DISTINCT FROM EXCLUDED.origin->>'sha256'
       RETURNING ${ARTIFACT_COLS}`,
      [project.id, type, name, `out:${name}`, origin, mime, data.length, data]);
    if (rows.length) return res.status(201).json(artifactShape(rows[0]));
    // Same bytes as last time: nothing to do, and say which row it is.
    const { rows: cur } = await q(`SELECT ${ARTIFACT_COLS} FROM artifacts WHERE project_id = $1 AND fingerprint = $2`,
      [project.id, `out:${name}`]);
    res.json(artifactShape(cur[0]));
  });

files.use((err, _req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: `Files are capped at ${FILE_CAP / 1024 / 1024} MB.` });
  }
  next(err);
});
