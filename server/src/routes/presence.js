import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';

// Session presence — which projects have a Claude session open right now.
//
//   POST /api/presence       { slug, session_id?, branch?, cwd? }  -> upsert a ping
//   POST /api/presence/end   { slug?, session_id? }                -> clear (idempotent)
//
// Pings only register for projects Stack already tracks (an untracked repo's
// hook gets a 404 and stays silent — first push creates the project, not a
// presence ping). Liveness is decided at read time by util.PRESENCE_TTL_MINUTES.
export const presence = Router();

const sid = (v) => String(v || '').slice(0, 200);

presence.post('/', async (req, res) => {
  const project = await projectBySlug(String(req.body?.slug || ''));
  if (!project) return res.status(404).json({ error: 'No such project.' });

  await q(
    `INSERT INTO presence (project_id, session_id, branch, cwd)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (project_id, session_id)
     DO UPDATE SET branch = COALESCE(EXCLUDED.branch, presence.branch),
                   cwd = COALESCE(EXCLUDED.cwd, presence.cwd),
                   last_seen_at = now()`,
    [project.id, sid(req.body?.session_id), req.body?.branch ? String(req.body.branch).slice(0, 200) : null,
     req.body?.cwd ? String(req.body.cwd).slice(0, 500) : null]
  );
  // Opportunistic sweep so dead rows never accumulate.
  await q(`DELETE FROM presence WHERE last_seen_at < now() - interval '7 days'`);
  res.json({ ok: true });
});

presence.post('/end', async (req, res) => {
  const sessionId = sid(req.body?.session_id);
  const slug = String(req.body?.slug || '');
  if (slug) {
    const project = await projectBySlug(slug);
    if (project) {
      await q('DELETE FROM presence WHERE project_id = $1 AND session_id = $2', [project.id, sessionId]);
    }
  } else if (sessionId) {
    await q('DELETE FROM presence WHERE session_id = $1', [sessionId]);
  }
  res.json({ ok: true }); // idempotent — ending an unknown session is fine
});
