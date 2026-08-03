import { Router } from 'express';
import { q } from '../db.js';
import { worktreeShape } from '../shape.js';

// (#229) The worktree REGISTER — one row per git worktree the host has
// checked out for a parallel interactive session (a terminal tab / `stack
// term`), so a worktree whose session has died can be FOUND rather than
// silently accumulating on disk forever.
//
// Same split as previews and skills: the server runs in a container and
// cannot see the host filesystem, so this surface is a register, not a
// manager. No route here executes git or touches the filesystem — the host
// alone creates and removes worktrees and reports what it did. A later
// session adding a "clean up" endpoint here would break that invariant.
export const worktrees = Router();

const KINDS = ['term', 'autopilot'];

// GET / — live worktrees (released_at IS NULL) newest first.
// ?all=1 includes released ones too. ?kind=term|autopilot filters.
worktrees.get('/', async (req, res) => {
  const conditions = [];
  const values = [];
  if (!('all' in req.query)) conditions.push('released_at IS NULL');
  if (KINDS.includes(req.query.kind)) {
    values.push(req.query.kind);
    conditions.push(`kind = $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await q(`SELECT * FROM worktrees ${where} ORDER BY created_at DESC`, values);
  res.json(rows.map(worktreeShape));
});

// POST / — the host registers (or re-registers) a worktree. Idempotent on
// `path`: re-registering the same path refreshes it and clears released_at,
// because a path coming back into use is live again whatever it was before.
worktrees.post('/', async (req, res) => {
  const path = String(req.body?.path || '').trim();
  if (!path) return res.status(400).json({ error: 'path is required.' });
  if (!path.startsWith('/')) return res.status(400).json({ error: 'path must be an absolute host path.' });
  const repo = String(req.body?.repo || '').trim();
  const branch = String(req.body?.branch || '').trim();
  const sessionName = String(req.body?.sessionName || '').trim();
  const kind = KINDS.includes(req.body?.kind) ? req.body.kind : 'term';

  const { rows } = await q(
    `INSERT INTO worktrees (path, repo, branch, session_name, kind)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (path) DO UPDATE
       SET repo = EXCLUDED.repo, branch = EXCLUDED.branch, session_name = EXCLUDED.session_name,
           kind = EXCLUDED.kind, last_seen_at = now(), released_at = NULL
     RETURNING *`,
    [path, repo, branch, sessionName, kind]);
  res.status(200).json(worktreeShape(rows[0]));
});

// POST /release — the host's report that it removed a worktree. Stamps
// released_at rather than deleting: the row is the record that the worktree
// existed, same as a soft-deleted project or a stopped preview.
worktrees.post('/release', async (req, res) => {
  const path = String(req.body?.path || '').trim();
  if (!path) return res.status(400).json({ error: 'path is required.' });
  const { rows } = await q(
    `UPDATE worktrees SET released_at = COALESCE(released_at, now())
      WHERE path = $1 RETURNING *`,
    [path]);
  if (!rows.length) return res.status(404).json({ error: 'No such worktree.' });
  res.json(worktreeShape(rows[0]));
});

// DELETE /:id — hard delete, for tidying a row whose host path is long gone.
worktrees.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad worktree id.' });
  const { rowCount } = await q('DELETE FROM worktrees WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'No such worktree.' });
  res.json({ ok: true });
});
