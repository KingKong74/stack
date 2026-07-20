import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { relativeTime } from '../util.js';
import { readSettings, cleanAutopilotTime } from '../settings.js';

// Mounted at /api/projects/:slug/autopilot — the overnight runner's history.
// The runner POSTs one row per item attempt; the dashboard's morning digest
// and this project's panel GET them back. Rows are the runner's account of
// itself — humans never write here.
export const autopilot = Router({ mergeParams: true });

const OUTCOMES = ['landed', 'no-commits', 'failed', 'limit'];

autopilot.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

export function runShape(r) {
  return {
    id: r.id,
    itemId: r.item_id,
    itemTitle: r.item_title || '',
    branch: r.branch || '',
    outcome: r.outcome,
    commits: r.commits,
    tokens: Number(r.tokens) || 0,
    costUsd: Number(r.cost_usd) || 0,
    checksFailing: r.checks_failing,
    summary: r.summary || '',
    // Per-model breakdown (#167): { "<model>": { inputTokens, outputTokens, costUSD } }
    // Present only on dual-model sessions; null for single-model or legacy rows.
    modelUsage: r.model_usage || null,
    when: relativeTime(r.finished_at) || 'just now',
    finishedAt: r.finished_at,
  };
}

// ---------------------------------------------------------------------------
// The GLOBAL autopilot router (mounted at /api/autopilot) — Mission Control's
// scheduling layer. The server can't reach the host (firewall), so a host-side
// dispatcher polls GET /next every minute; the server lazily enqueues whatever
// has come due (the armed nightly per automode project, due calendar rows,
// manual Run-now presses) and hands over at most ONE job at a time. All times
// are the DISPATCHER's local clock, passed in as ?local=YYYY-MM-DDTHH:MM&dow=N
// — the server's own TZ never matters.
// ---------------------------------------------------------------------------
export const autopilotGlobal = Router();

const DAY_LIST = (v) => (Array.isArray(v) ? [...new Set(v.map((d) => Math.trunc(Number(d))).filter((d) => d >= 0 && d <= 6))] : []);
const timeToMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? (Number(m[1]) % 24) * 60 + Number(m[2]) : null;
};
// Due = we're inside [at, at+90min] on the same local day (clamped at
// midnight — a missed slot stays missed, like the old fixed cron line).
const GRACE_MIN = 90;
const within = (startMin, nowMin) => startMin != null && nowMin >= startMin && nowMin < Math.min(startMin + GRACE_MIN, 24 * 60);

function scheduleShape(r) {
  return {
    id: String(r.id),
    slug: r.slug,
    name: r.project_name || r.slug,
    tint: r.tint || null,
    itemId: r.item_id != null ? String(r.item_id) : null,
    itemTitle: r.item_title || '',
    atTime: r.at_time,
    days: DAY_LIST(r.days),
    runDate: r.run_date ? new Date(r.run_date).toISOString().slice(0, 10) : null,
    note: r.note || '',
    enabled: !!r.enabled,
  };
}

function jobShape(r) {
  return {
    id: String(r.id),
    slug: r.slug,
    name: r.project_name || r.slug,
    kind: r.kind,
    itemId: r.item_id != null ? String(r.item_id) : null,
    itemTitle: r.item_title || '',
    status: r.status,
    detail: r.detail || '',
    // #142 — a resume job's earliest hand-out time (the limit reset); null on
    // every other kind, and cleared when a human presses ▶ Resume now.
    notBefore: r.not_before ? new Date(r.not_before).toISOString() : null,
    when: relativeTime(r.finished_at || r.started_at || r.created_at) || 'just now',
  };
}

// control.js renders the same rows onto the Mission Control payload.
export const scheduleShapeRows = (rows) => rows.map(scheduleShape);
export const jobShapeRows = (rows) => rows.map(jobShape);

const SCHEDULE_SELECT = `
  SELECT s.*, p.slug, p.name AS project_name, p.tint, ri.title AS item_title
    FROM autopilot_schedule s
    JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
    LEFT JOIN roadmap_items ri ON ri.id = s.item_id`;

const JOB_SELECT = `
  SELECT j.*, p.slug, p.name AS project_name, ri.title AS item_title
    FROM autopilot_jobs j
    JOIN projects p ON p.id = j.project_id AND p.deleted_at IS NULL
    LEFT JOIN roadmap_items ri ON ri.id = j.item_id`;

// GET /schedule — every schedule row, soonest-ish first (enabled first).
autopilotGlobal.get('/schedule', async (_req, res) => {
  const { rows } = await q(`${SCHEDULE_SELECT} ORDER BY s.enabled DESC, s.at_time, s.id`);
  res.json(rows.map(scheduleShape));
});

// POST /schedule — { slug, atTime, days?|runDate?, itemId?, note? }
autopilotGlobal.post('/schedule', async (req, res) => {
  const b = req.body || {};
  const project = await projectBySlug(String(b.slug || ''));
  if (!project) return res.status(404).json({ error: 'No such project.' });
  if (timeToMin(b.atTime) == null) return res.status(400).json({ error: 'atTime must be HH:MM.' });
  const days = DAY_LIST(b.days);
  const runDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.runDate || '')) ? b.runDate : null;
  if (!days.length && !runDate) return res.status(400).json({ error: 'Pick repeat days or a one-off date.' });
  const { rows } = await q(
    `INSERT INTO autopilot_schedule (project_id, item_id, at_time, days, run_date, note)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING id`,
    [project.id, Number.isFinite(Number(b.itemId)) ? Number(b.itemId) : null,
     cleanAutopilotTime(b.atTime), JSON.stringify(days), runDate, String(b.note || '').slice(0, 300)]
  );
  const full = await q(`${SCHEDULE_SELECT} WHERE s.id = $1`, [rows[0].id]);
  res.status(201).json(scheduleShape(full.rows[0]));
});

// PATCH /schedule/:id — enabled / atTime / days / runDate / itemId / note
autopilotGlobal.patch('/schedule/:id', async (req, res) => {
  const b = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;
  if ('enabled' in b) { fields.push(`enabled = $${i++}`); values.push(Boolean(b.enabled)); }
  if ('atTime' in b) { fields.push(`at_time = $${i++}`); values.push(cleanAutopilotTime(b.atTime)); }
  if ('days' in b) { fields.push(`days = $${i++}::jsonb`); values.push(JSON.stringify(DAY_LIST(b.days))); }
  if ('runDate' in b) {
    fields.push(`run_date = $${i++}`);
    values.push(/^\d{4}-\d{2}-\d{2}$/.test(String(b.runDate || '')) ? b.runDate : null);
  }
  if ('itemId' in b) {
    fields.push(`item_id = $${i++}`);
    values.push(Number.isFinite(Number(b.itemId)) && b.itemId !== '' && b.itemId !== null ? Number(b.itemId) : null);
  }
  if ('note' in b) { fields.push(`note = $${i++}`); values.push(String(b.note || '').slice(0, 300)); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  values.push(req.params.id);
  const r = await q(`UPDATE autopilot_schedule SET ${fields.join(', ')} WHERE id = $${i} RETURNING id`, values);
  if (!r.rowCount) return res.status(404).json({ error: 'No such schedule.' });
  const full = await q(`${SCHEDULE_SELECT} WHERE s.id = $1`, [req.params.id]);
  res.json(scheduleShape(full.rows[0]));
});

autopilotGlobal.delete('/schedule/:id', async (req, res) => {
  const r = await q('DELETE FROM autopilot_schedule WHERE id = $1', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'No such schedule.' });
  res.json({ ok: true });
});

// POST /start — the Mission Control "Run now" button: queue a manual job.
// { slug, itemId? }. Idempotent-ish: an already queued/claimed/running job for
// the same project comes back instead of stacking a duplicate.
autopilotGlobal.post('/start', async (req, res) => {
  const b = req.body || {};
  const project = await projectBySlug(String(b.slug || ''));
  if (!project) return res.status(404).json({ error: 'No such project.' });
  const open = await q(
    `${JOB_SELECT} WHERE j.project_id = $1 AND j.status IN ('queued','claimed','running')
      ORDER BY j.created_at LIMIT 1`, [project.id]);
  if (open.rows.length) {
    // Run now on a project with a pending limit-resume = resume it NOW: clear
    // the hold so the next dispatcher poll picks it up (#142).
    const row = open.rows[0];
    if (row.kind === 'resume' && row.status === 'queued' && row.not_before) {
      await q('UPDATE autopilot_jobs SET not_before = NULL WHERE id = $1', [row.id]);
      row.not_before = null;
    }
    return res.status(200).json(jobShape(row));
  }
  const itemId = Number.isFinite(Number(b.itemId)) && b.itemId !== '' && b.itemId != null ? Number(b.itemId) : null;
  const { rows } = await q(
    `INSERT INTO autopilot_jobs (project_id, kind, item_id) VALUES ($1,'manual',$2) RETURNING id`,
    [project.id, itemId]);
  const full = await q(`${JOB_SELECT} WHERE j.id = $1`, [rows[0].id]);
  res.status(201).json(jobShape(full.rows[0]));
});

// POST /undo — the Reviews view's ⎌ Undo (#128): queue a revert job for a
// completed item. The host dispatcher (the only thing with the repo) reverts
// the commits tagged #<itemId> on main in a throwaway worktree, pushes, and
// un-ticks the item — which sends it back to the board fresh (#116 semantics).
autopilotGlobal.post('/undo', async (req, res) => {
  const b = req.body || {};
  const project = await projectBySlug(String(b.slug || ''));
  if (!project) return res.status(404).json({ error: 'No such project.' });
  const itemId = Number(b.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ error: 'itemId required.' });
  const item = await q('SELECT id, done FROM roadmap_items WHERE project_id = $1 AND id = $2', [project.id, itemId]);
  if (!item.rows.length) return res.status(404).json({ error: 'No such roadmap item.' });
  if (!item.rows[0].done) return res.status(400).json({ error: 'Only a completed item can be undone.' });
  const open = await q(
    `${JOB_SELECT} WHERE j.project_id = $1 AND j.status IN ('queued','claimed','running')
      ORDER BY j.created_at LIMIT 1`, [project.id]);
  if (open.rows.length) {
    const openJob = jobShape(open.rows[0]);
    // The same undo asked twice is idempotent; anything else has to finish first.
    if (openJob.kind === 'revert' && openJob.itemId === String(itemId)) return res.status(200).json(openJob);
    return res.status(409).json({ error: `An automation job for this project is already ${openJob.status} — undo when it finishes.` });
  }
  const { rows } = await q(
    `INSERT INTO autopilot_jobs (project_id, kind, item_id) VALUES ($1,'revert',$2) RETURNING id`,
    [project.id, itemId]);
  const full = await q(`${JOB_SELECT} WHERE j.id = $1`, [rows[0].id]);
  res.status(201).json(jobShape(full.rows[0]));
});

// POST /resume — the runner's graceful pause (#142): a session that died on
// the usage limit queues its own continuation as a DURABLE job instead of a
// detached sleep on the host. { slug, itemId?, minutes } → a kind='resume'
// job held until now()+minutes (the limit reset); minutes is relative so the
// host/server clock skew never matters. Idempotent per project: an open
// resume job is re-pointed at the new reset instead of stacking a duplicate.
// The job is visible in Mission Control and the Terminal, where a human can
// ▶ Resume now (clear the hold), hang it up (status 'paused') or dismiss it.
autopilotGlobal.post('/resume', async (req, res) => {
  const b = req.body || {};
  const project = await projectBySlug(String(b.slug || ''));
  if (!project) return res.status(404).json({ error: 'No such project.' });
  const minutes = Math.min(24 * 60, Math.max(1, Math.round(Number(b.minutes)) || 240));
  const itemId = Number.isFinite(Number(b.itemId)) && b.itemId !== '' && b.itemId != null ? Number(b.itemId) : null;
  const openResume = await q(
    `SELECT id FROM autopilot_jobs
      WHERE project_id = $1 AND kind = 'resume' AND status IN ('queued','paused')
      ORDER BY created_at LIMIT 1`, [project.id]);
  let id;
  if (openResume.rows.length) {
    id = openResume.rows[0].id;
    await q(
      `UPDATE autopilot_jobs SET not_before = now() + ($1 || ' minutes')::interval,
              status = 'queued', claimed_at = NULL, item_id = $2 WHERE id = $3`,
      [minutes, itemId, id]);
  } else {
    ({ rows: [{ id }] } = await q(
      `INSERT INTO autopilot_jobs (project_id, kind, item_id, not_before)
       VALUES ($1, 'resume', $2, now() + ($3 || ' minutes')::interval) RETURNING id`,
      [project.id, itemId, minutes]));
  }
  const full = await q(`${JOB_SELECT} WHERE j.id = $1`, [id]);
  res.status(openResume.rows.length ? 200 : 201).json(jobShape(full.rows[0]));
});

// GET /jobs?slug=&limit= — recent automation sessions, newest first. The read
// side of /start: `stack list-sessions` and anything else that wants the job
// queue without the full Mission Control payload.
autopilotGlobal.get('/jobs', async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const slug = String(req.query.slug || '');
  if (slug) {
    const project = await projectBySlug(slug);
    if (!project) return res.status(404).json({ error: 'No such project.' });
    const { rows } = await q(
      `${JOB_SELECT} WHERE j.project_id = $1 ORDER BY j.created_at DESC LIMIT $2`,
      [project.id, limit]);
    return res.json(rows.map(jobShape));
  }
  const { rows } = await q(`${JOB_SELECT} ORDER BY j.created_at DESC LIMIT $1`, [limit]);
  res.json(rows.map(jobShape));
});

// GET /next?local=YYYY-MM-DDTHH:MM&dow=N — the host dispatcher's poll.
// Recovers stale jobs, lazily enqueues due work, then claims at most one job
// (serialised: nothing is handed out while another job is claimed/running).
autopilotGlobal.get('/next', async (req, res) => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(req.query.local || ''));
  if (!m) return res.status(400).json({ error: 'local=YYYY-MM-DDTHH:MM required.' });
  const [, localDate, localTime] = m;
  const nowMin = timeToMin(localTime);
  const dow = Math.trunc(Number(req.query.dow));
  const settings = await readSettings();

  // Stale recovery: a claim the dispatcher never started (it died) re-queues;
  // a "running" job with no completion report for 12h is closed out.
  await q(`UPDATE autopilot_jobs SET status = 'queued', claimed_at = NULL
            WHERE status = 'claimed' AND claimed_at < now() - interval '15 minutes'`);
  await q(`UPDATE autopilot_jobs SET status = 'failed', detail = 'stale — no completion report', finished_at = now()
            WHERE status = 'running' AND started_at < now() - interval '12 hours'`);

  // The armed nightly: one job per automode project per local date, once the
  // clock passes the configured start. The unique partial index carries the
  // dedup, so re-polls are free.
  if (settings.autopilot_enabled && within(timeToMin(settings.autopilot_time), nowMin)) {
    await q(
      `INSERT INTO autopilot_jobs (project_id, kind, night_date)
        SELECT id, 'nightly', $1::date FROM projects WHERE automode AND deleted_at IS NULL
        ON CONFLICT (project_id, night_date) WHERE kind = 'nightly' DO NOTHING`,
      [localDate]);
  }

  // Due calendar rows (the arm switch pauses the whole calendar; Run-now stays
  // manual-only while disarmed).
  if (settings.autopilot_enabled && Number.isFinite(nowMin)) {
    const { rows: due } = await q(
      `SELECT s.* FROM autopilot_schedule s
         JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
        WHERE s.enabled`);
    for (const s of due) {
      const startMin = timeToMin(s.at_time);
      if (!within(startMin, nowMin)) continue;
      const onceToday = s.run_date && new Date(s.run_date).toISOString().slice(0, 10) === localDate;
      const dayList = DAY_LIST(s.days);
      const recursToday = dayList.length > 0 && dayList.includes(dow)
        && (!s.last_enqueued_on || new Date(s.last_enqueued_on).toISOString().slice(0, 10) < localDate);
      if (!onceToday && !recursToday) continue;
      await q(
        `INSERT INTO autopilot_jobs (project_id, kind, item_id, schedule_id) VALUES ($1,'scheduled',$2,$3)`,
        [s.project_id, s.item_id, s.id]);
      // One-offs retire themselves; recurring rows just stamp the local date.
      await q(
        onceToday
          ? 'UPDATE autopilot_schedule SET enabled = false, last_enqueued_on = $2 WHERE id = $1'
          : 'UPDATE autopilot_schedule SET last_enqueued_on = $2 WHERE id = $1',
        [s.id, localDate]);
    }
  }

  // Serialise: one job in flight at a time (the runner's lockfile agrees).
  const busy = await q(`SELECT 1 FROM autopilot_jobs WHERE status IN ('claimed','running') LIMIT 1`);
  if (busy.rows.length) return res.json({ job: null });
  // A queued resume job stays held until its not_before passes (#142); a
  // 'paused' (hung-up) job is never handed out at all.
  const claimed = await q(
    `UPDATE autopilot_jobs SET status = 'claimed', claimed_at = now()
      WHERE id = (SELECT id FROM autopilot_jobs
                   WHERE status = 'queued' AND (not_before IS NULL OR not_before <= now())
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id`);
  if (!claimed.rows.length) return res.json({ job: null });
  const full = await q(`${JOB_SELECT} WHERE j.id = $1`, [claimed.rows[0].id]);
  res.json({ job: jobShape(full.rows[0]) });
});

// PATCH /jobs/:id — the dispatcher reports { status: running|done|failed|queued, detail? }.
// #142 adds the human controls on a pending job: { status: 'paused' } hangs it
// up (held until resumed by hand — only valid while queued/claimed, a running
// session has no kill channel), { status: 'queued', notBefore: null } resumes
// it now (clearing the hold marks it human-pressed — the dispatcher runs a
// held-then-resumed job with --force, like any manual press).
autopilotGlobal.patch('/jobs/:id', async (req, res) => {
  const b = req.body || {};
  const status = ['running', 'done', 'failed', 'queued', 'paused'].includes(b.status) ? b.status : null;
  if (!status) return res.status(400).json({ error: 'status must be running|done|failed|queued|paused.' });
  const clearHold = 'notBefore' in b && b.notBefore == null;
  const stampCol = status === 'running' ? 'started_at = now()'
    : status === 'queued' || status === 'paused' ? 'claimed_at = NULL' : 'finished_at = now()';
  const guard = status === 'paused' ? `AND status IN ('queued','claimed')` : '';
  const r = await q(
    `UPDATE autopilot_jobs SET status = $1, detail = COALESCE($2, detail),
            not_before = CASE WHEN $4 THEN NULL ELSE not_before END, ${stampCol}
      WHERE id = $3 ${guard} RETURNING id`,
    [status, 'detail' in b ? String(b.detail || '').slice(0, 500) : null, req.params.id, clearHold]);
  if (!r.rowCount) {
    if (status === 'paused') {
      const exists = await q('SELECT status FROM autopilot_jobs WHERE id = $1', [req.params.id]);
      if (exists.rows.length) return res.status(409).json({ error: `A ${exists.rows[0].status} job can't be hung up.` });
    }
    return res.status(404).json({ error: 'No such job.' });
  }
  const full = await q(`${JOB_SELECT} WHERE j.id = $1`, [req.params.id]);
  res.json(jobShape(full.rows[0]));
});

// DELETE /jobs/:id — dismiss a pending job (#142: a hung-up or held resume the
// human decides against). Only queued/paused rows go; anything claimed,
// running or finished stays as history.
autopilotGlobal.delete('/jobs/:id', async (req, res) => {
  const r = await q(
    `DELETE FROM autopilot_jobs WHERE id = $1 AND status IN ('queued','paused') RETURNING id`,
    [req.params.id]);
  if (!r.rowCount) {
    const exists = await q('SELECT status FROM autopilot_jobs WHERE id = $1', [req.params.id]);
    if (exists.rows.length) return res.status(409).json({ error: `A ${exists.rows[0].status} job can't be dismissed.` });
    return res.status(404).json({ error: 'No such job.' });
  }
  res.json({ ok: true });
});

// GET /runs -> recent run history, newest first
autopilot.get('/runs', async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const { rows } = await q(
    'SELECT * FROM autopilot_runs WHERE project_id = $1 ORDER BY finished_at DESC LIMIT $2',
    [req.project.id, limit]
  );
  res.json(rows.map(runShape));
});

// POST /runs -> the runner records an item attempt
autopilot.post('/runs', async (req, res) => {
  const b = req.body || {};
  const outcome = OUTCOMES.includes(b.outcome) ? b.outcome : 'landed';
  // model_usage (#167): { "<model>": { inputTokens, outputTokens, costUSD } } or null.
  // Accept an object, silently reject anything else.
  const modelUsage = (b.model_usage && typeof b.model_usage === 'object' && !Array.isArray(b.model_usage))
    ? b.model_usage : null;
  const { rows } = await q(
    `INSERT INTO autopilot_runs
       (project_id, item_id, item_title, branch, outcome, commits, tokens, cost_usd, checks_failing, summary, model_usage, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb, COALESCE($12, now())) RETURNING *`,
    [
      req.project.id,
      Number.isFinite(Number(b.item_id)) ? Number(b.item_id) : null,
      String(b.item_title || '').slice(0, 300),
      String(b.branch || '').slice(0, 120),
      outcome,
      Math.max(0, parseInt(b.commits, 10) || 0),
      Math.max(0, parseInt(b.tokens, 10) || 0),
      Math.max(0, Number(b.cost_usd) || 0),
      Number.isFinite(Number(b.checks_failing)) ? Number(b.checks_failing) : null,
      String(b.summary || '').slice(0, 2000),
      modelUsage ? JSON.stringify(modelUsage) : null,
      b.started_at ? new Date(b.started_at) : null,
    ]
  );
  res.status(201).json(runShape(rows[0]));
});
