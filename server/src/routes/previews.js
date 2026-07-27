import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { relativeTime } from '../util.js';

// (#208) Branch previews — a mirror site for pushed work, so a branch can be
// LOOKED AT running before it is merged.
//
// The split is the same one every host-touching feature here uses: the server
// owns the state and the host owns the doing. Only the dispatcher can reach
// docker, the repo and cloudflared, so these routes never run anything — they
// queue intent, hold the URL, and take the dispatcher's reports back.
//
// Two routers: `previews` is per-project (mounted under /api/projects/:slug),
// `previewsGlobal` is the cross-project surface the dispatcher sweeps and
// Mission Control lists.
export const previews = Router({ mergeParams: true });
export const previewsGlobal = Router();

const OPEN = ['queued', 'starting', 'live'];
const STATUSES = [...OPEN, 'stopping', 'stopped', 'failed'];

// Default life of a preview. Deliberately short: the quick tunnel's URL is
// public for as long as the preview lives, so expiry is the safety property
// rather than mere tidiness (see schema.sql). Clamped 15m–24h.
const DEFAULT_HOURS = 2;
const clampHours = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(24, Math.max(0.25, n)) : DEFAULT_HOURS;
};

export function previewShape(r) {
  return {
    id: String(r.id),
    slug: r.slug,
    name: r.project_name || r.slug,
    tint: r.tint || null,
    branch: r.branch,
    itemId: r.item_id != null ? String(r.item_id) : null,
    itemTitle: r.item_title || '',
    status: r.status,
    // '' until the tunnel is up. The client must treat an empty url on a
    // 'live' row as still-arriving rather than as a broken preview.
    url: r.url || '',
    detail: r.detail || '',
    port: r.port != null ? Number(r.port) : null,
    createdAt: r.created_at,
    startedAt: r.started_at,
    expiresAt: r.expires_at,
    when: relativeTime(r.stopped_at || r.started_at || r.created_at) || 'just now',
  };
}

const SELECT = `
  SELECT pv.*, p.slug, p.name AS project_name, p.tint, ri.title AS item_title
    FROM previews pv
    JOIN projects p ON p.id = pv.project_id AND p.deleted_at IS NULL
    LEFT JOIN roadmap_items ri ON ri.id = pv.item_id`;

// ---------------------------------------------------------------------------
// Per-project: POST /api/projects/:slug/previews  { branch, itemId?, hours? }
// Queue a preview. Idempotent per branch — asking twice for a branch already
// being previewed hands back the SAME row rather than racing a second docker
// stack onto the host, so a double-click costs nothing.
// ---------------------------------------------------------------------------
previews.post('/', async (req, res) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  const branch = String(req.body?.branch || '').trim();
  if (!branch) return res.status(400).json({ error: 'branch is required.' });
  // Refuse anything that isn't plausibly a git ref. The branch name reaches a
  // shell-free spawn on the host, but it also names a docker compose project
  // and a worktree path, so keep it boring.
  if (!/^[A-Za-z0-9._\/-]{1,120}$/.test(branch) || branch.includes('..')) {
    return res.status(400).json({ error: 'That does not look like a branch name.' });
  }
  const itemId = Number.isFinite(Number(req.body?.itemId)) && req.body.itemId ? Number(req.body.itemId) : null;
  const hours = clampHours(req.body?.hours);

  const open = await q(
    `SELECT id FROM previews WHERE project_id = $1 AND branch = $2 AND status = ANY($3)`,
    [project.id, branch, OPEN]);
  if (open.rows.length) {
    const existing = await q(`${SELECT} WHERE pv.id = $1`, [open.rows[0].id]);
    return res.status(200).json(previewShape(existing.rows[0]));
  }
  const { rows: [{ id }] } = await q(
    `INSERT INTO previews (project_id, branch, item_id, expires_at, detail)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, 'queued — the host picks this up within a minute')
     RETURNING id`,
    [project.id, branch, itemId, hours]);
  const full = await q(`${SELECT} WHERE pv.id = $1`, [id]);
  res.status(201).json(previewShape(full.rows[0]));
});

// GET /api/projects/:slug/previews — this project's previews, newest first.
previews.get('/', async (req, res) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  const { rows } = await q(
    `${SELECT} WHERE pv.project_id = $1 ORDER BY pv.created_at DESC LIMIT 20`, [project.id]);
  res.json(rows.map(previewShape));
});

// ---------------------------------------------------------------------------
// Global: the list Mission Control renders + the dispatcher's work feed.
// ---------------------------------------------------------------------------

// GET /api/previews — open previews first, then recent history.
previewsGlobal.get('/', async (_req, res) => {
  const { rows } = await q(
    `${SELECT}
      WHERE pv.status = ANY($1) OR pv.created_at > now() - interval '2 days'
      ORDER BY (pv.status = ANY($1)) DESC, pv.created_at DESC LIMIT 30`, [OPEN]);
  res.json(rows.map(previewShape));
});

// GET /api/previews/work — the dispatcher's sweep, run every poll.
//
// `start` is what to bring up, `stop` is what to tear down — and EXPIRY is
// resolved here, server-side, rather than trusted to the host: a preview whose
// expires_at has passed is reported as stop work even though nobody pressed
// anything. That is what stops an abandoned public URL living forever.
previewsGlobal.get('/work', async (_req, res) => {
  // Recover a start that never reported: the dispatcher died mid-build, or the
  // host rebooted. Back to 'queued' so the next sweep retries it.
  await q(
    `UPDATE previews SET status = 'queued', detail = 'restarting — the previous attempt stopped reporting'
      WHERE status = 'starting' AND created_at < now() - interval '20 minutes'`);
  const { rows: start } = await q(
    `${SELECT} WHERE pv.status = 'queued' ORDER BY pv.created_at LIMIT 3`);
  const { rows: stop } = await q(
    `${SELECT} WHERE pv.status = 'stopping'
        OR (pv.status IN ('live', 'starting') AND pv.expires_at IS NOT NULL AND pv.expires_at < now())
      ORDER BY pv.created_at LIMIT 5`);
  res.json({
    start: start.map(previewShape),
    // The host needs the teardown handles, which the client-facing shape
    // deliberately does not carry (they name paths and pids on the host).
    stop: stop.map((r) => ({
      ...previewShape(r),
      composeProject: r.compose_project || '',
      worktree: r.worktree || '',
      tunnelPid: r.tunnel_pid != null ? Number(r.tunnel_pid) : null,
      expired: Boolean(r.expires_at && new Date(r.expires_at) < new Date()),
    })),
  });
});

// PATCH /api/previews/:id — the dispatcher's progress + outcome report.
// Also the human's Stop button, which only ever sets 'stopping': the actual
// teardown is the host's, so the UI asks and the sweep does.
previewsGlobal.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad preview id.' });
  const b = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;

  if ('status' in b) {
    const s = String(b.status);
    if (!STATUSES.includes(s)) return res.status(400).json({ error: 'Unknown status.' });
    fields.push(`status = $${i++}`);
    values.push(s);
    if (s === 'live') fields.push('started_at = COALESCE(started_at, now())');
    if (s === 'stopped' || s === 'failed') fields.push('stopped_at = now()');
    // A stopped/failed preview has no host resources left, so drop the
    // handles rather than leaving stale paths and pids on the row.
    if (s === 'stopped' || s === 'failed') fields.push(`tunnel_pid = NULL`);
  }
  for (const [key, col] of [['url', 'url'], ['detail', 'detail'],
    ['composeProject', 'compose_project'], ['worktree', 'worktree']]) {
    if (key in b) { fields.push(`${col} = $${i++}`); values.push(String(b[key] || '').slice(0, 500)); }
  }
  for (const [key, col] of [['port', 'port'], ['tunnelPid', 'tunnel_pid']]) {
    if (key in b) {
      const n = Number(b[key]);
      fields.push(`${col} = $${i++}`);
      values.push(Number.isFinite(n) && n > 0 ? Math.trunc(n) : null);
    }
  }
  // Extending a live preview re-arms its expiry — the one write the UI makes
  // that is not a stop.
  if ('hours' in b) {
    fields.push(`expires_at = now() + ($${i++} || ' hours')::interval`);
    values.push(clampHours(b.hours));
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

  values.push(id);
  const { rowCount } = await q(`UPDATE previews SET ${fields.join(', ')} WHERE id = $${i}`, values);
  if (!rowCount) return res.status(404).json({ error: 'No such preview.' });
  const full = await q(`${SELECT} WHERE pv.id = $1`, [id]);
  res.json(previewShape(full.rows[0]));
});

// POST /api/previews/:id/stop — the human's Stop. Marks intent only; the next
// dispatcher sweep does the teardown, so this works even while the host is
// briefly unreachable and never leaves the UI lying about what has happened.
previewsGlobal.post('/:id/stop', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad preview id.' });
  const { rows } = await q(`SELECT status FROM previews WHERE id = $1`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'No such preview.' });
  if (!OPEN.includes(rows[0].status)) {
    // Already stopped or failed — say so rather than queueing a second teardown.
    const full = await q(`${SELECT} WHERE pv.id = $1`, [id]);
    return res.status(200).json(previewShape(full.rows[0]));
  }
  await q(`UPDATE previews SET status = 'stopping', detail = 'stopping — the host tears it down within a minute' WHERE id = $1`, [id]);
  const full = await q(`${SELECT} WHERE pv.id = $1`, [id]);
  res.json(previewShape(full.rows[0]));
});
