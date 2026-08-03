import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { relativeTime } from '../util.js';
import { runCore } from '../shape.js';
import { readSettings, cleanAutopilotTime } from '../settings.js';
import { occupiedAreas, laneHolders, laneKey } from '../lanes.js';
import { APPROVED_SQL, roadmapIdsIn, scheduleGate, startGate } from '../approval.js';

// Mounted at /api/projects/:slug/autopilot — the overnight runner's history.
// The runner POSTs one row per item attempt; the dashboard's morning digest
// and this project's panel GET them back. Rows are the runner's account of
// itself — humans never write here.
export const autopilot = Router({ mergeParams: true });

const OUTCOMES = ['landed', 'no-commits', 'failed', 'limit', 'planned'];
// #282 — the reviewer's three possible reads. NULL is the fourth state and means
// "no review ran", which is deliberately not the same as "nothing found".
const REVIEW_VERDICTS = ['clean', 'concerns', 'blocked'];
// #284 — the architect's three reads. NULL again means "no pass ran", which is
// not the same as "nothing to say".
const ARCHITECT_VERDICTS = ['aligned', 'drifting', 'concerning'];

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
    // What the run produced, plus both second-model reads (#282/#284) — one
    // shared shape in shape.js, since four routes serve these same columns.
    ...runCore(r),
    // Per-model breakdown (#167): { "<model>": { inputTokens, outputTokens, costUSD } }
    // Present only on dual-model sessions; null for single-model or legacy rows.
    modelUsage: r.model_usage || null,
    // Named tmux session (#171): set when the run was started inside a tmux session
    // so the web terminal can re-attach for live monitoring while the run is active.
    tmuxSession: r.tmux_session || null,
    // #266 — which night (if any) produced this run.
    nightDate: dateKey(r.night_date),
    when: relativeTime(r.finished_at) || 'just now',
    finishedAt: r.finished_at,
  };
}

// ---------------------------------------------------------------------------
// The GLOBAL autopilot router (mounted at /api/autopilot) — Mission Control's
// scheduling layer. The server can't reach the host (firewall), so a host-side
// dispatcher polls GET /next every minute; the server lazily enqueues whatever
// has come due (the armed nightly per automode project, due calendar rows,
// manual Run-now presses) and hands jobs out under two gates (#335): a tunable
// fleet-wide concurrency cap (autopilotWorkers, 0 = unlimited) and a fixed
// per-project serialisation (never tunable — see the comment above the claim
// query in GET /next). All times are the DISPATCHER's local clock, passed in
// as ?local=YYYY-MM-DDTHH:MM&dow=N — the server's own TZ never matters.
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

// Session planner (#228): a session's kind picks the runner mode; the agenda
// is the ORDERED work list (roadmap item ids for build/plan, bug keys for
// debug; [] = the board's own priority order); area scopes the general pick.
// A `refine` session (#274) is a follow-up round on an item that was sent
// back with a delta note — its agenda is item ids, same as build.
const SESSION_KINDS = ['build', 'plan', 'debug', 'audit', 'refine'];
const cleanKind = (v) => (SESSION_KINDS.includes(v) ? v : 'build');
const cleanAgenda = (v) => (Array.isArray(v) ? v : [])
  .map((x) => {
    const s = String(x ?? '').trim();
    if (/^BUG-\d+$/i.test(s)) return s.toUpperCase();          // debug agendas: bug keys
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null; // build/plan: item ids
  })
  .filter((x) => x != null)
  .slice(0, 20);
const cleanArea = (v) => String(v || '').trim().toLowerCase().slice(0, 40);

// A pg DATE parses to LOCAL midnight, so toISOString() shifts the day
// whenever the server TZ is ahead of UTC. Read the local components.
const dateKey = (v) => { if (!v) return null; const d = new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// #266 — the runner's own token-budget floor: below this, a job's share gets
// rounded back UP to it (scripts/stack-autopilot.mjs), so funding a job under
// the floor doesn't shrink spend, it just hides it from the split.
export const MIN_JOB_TOKENS = 50_000;

// #266 — split a night's token budget across n fanned-out jobs so the total
// stays EXACT: no job is silently overfunded (or the night underspent) by
// rounding. total <= 0 means unlimited, so every job gets 0 (unlimited) too.
export function splitNightBudget(total, n) {
  if (n <= 0) return [];
  if (total <= 0) return Array(n).fill(0);
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

// #266 — how many jobs a night stands up for one project. maxItems 0 is
// "unlimited" per Settings, but still capped at 20 (cleanAgenda's own ceiling)
// so a huge board can't enqueue a huge queue; never more than the items that
// are actually eligible tonight. When the night has a real token budget, also
// cap so each job's share is at least MIN_JOB_TOKENS: below that floor the
// runner rounds every share back UP to it, so the night would quietly spend
// more than the budget it was given — fewer, properly funded jobs beats N
// underfunded ones.
export function nightFanOut(maxItems, eligibleCount, totalTokens) {
  if (eligibleCount <= 0) return 0;
  let n = maxItems === 0 ? 20 : Math.max(0, Math.min(maxItems, 20));
  n = Math.min(n, eligibleCount);
  if (totalTokens > 0) {
    const byBudget = Math.max(1, Math.floor(totalTokens / MIN_JOB_TOKENS));
    n = Math.min(n, byBudget);
  }
  return n;
}

// #359 — a due calendar row (or a Run-now press) can pin `item_id` and/or
// carry roadmap ids in its `agenda` (mixed, for a debug row, with `BUG-N`
// strings — those are bug tracker keys, not roadmap items, so they carry no
// approval gate and always pass through). Both gates below need the same
// lookup — one query, by id, for source/reviewed_at/title — so it is pulled
// out here rather than duplicated.
// Returns null when there is nothing to resolve (no roadmap ids in play at
// all): the common case is a manual Run-now with no itemId/agenda, which must
// not pay for this query, let alone be held (a manual item is never held —
// see approval.js).
//
// The DECIDING is not here. scheduleGate/startGate in approval.js are pure
// functions over this map, so both queues can be tested both ways without a
// database — which is the only way the "unapproved filtered out, manual +
// approved still runs" property is ever actually checked.
async function resolveRoadmapApproval(projectId, itemId, agenda) {
  const ids = roadmapIdsIn(itemId, agenda);
  if (ids.length === 0) return null;
  const { rows } = await q(
    `SELECT id, source, reviewed_at, title FROM roadmap_items WHERE project_id = $1 AND id = ANY($2::int[])`,
    [projectId, ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

// The two callers below read the SAME rule off approval.js but must act on it
// oppositely, because one runs unattended and the other has a human at the
// button: GET /next's schedule enqueue has nobody watching a session start,
// so an unapproved item is DROPPED, silently, and the row still stamps/
// retires on schedule; POST /start below is a human pressing Run now, so the
// same hold must REFUSE OUT LOUD — a silent drop there would look like the
// press did nothing.

// The unattended gate for GET /next. null = nothing to gate (enqueue as
// scheduled); otherwise scheduleGate's { held: true } | { agenda }.
async function checkScheduleApproval(projectId, itemId, agenda) {
  const byId = await resolveRoadmapApproval(projectId, itemId, agenda);
  return byId ? scheduleGate(itemId, agenda, byId) : null;
}

// The refuse-out-loud gate for POST /start. null = nothing to check;
// otherwise startGate's { held: [{ id, title, reason }], agenda }.
async function checkStartApproval(projectId, itemId, agenda) {
  const byId = await resolveRoadmapApproval(projectId, itemId, agenda);
  return byId ? startGate(itemId, agenda, byId) : null;
}

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
    runDate: dateKey(r.run_date),
    note: r.note || '',
    enabled: !!r.enabled,
    // #228 — the session plan
    kind: cleanKind(r.session_kind),
    agenda: Array.isArray(r.agenda) ? r.agenda : [],
    area: r.area || '',
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
    // #228 — the session plan the dispatcher passes to the runner as flags.
    sessionKind: cleanKind(r.session_kind),
    agenda: Array.isArray(r.agenda) ? r.agenda : [],
    area: r.area || '',
    // #266 — the fan-out's own bookkeeping: which night this job belongs to,
    // and its slice of that night's token budget.
    nightDate: dateKey(r.night_date),
    // BIGINT comes back from pg as a STRING — Number() it, unlike an INT column.
    tokenBudget: r.token_budget != null ? Number(r.token_budget) : null,
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

// POST /schedule — { slug, atTime, days?|runDate?, itemId?, note?,
//                    kind?, agenda?, area? } (#228 — the session plan)
autopilotGlobal.post('/schedule', async (req, res) => {
  const b = req.body || {};
  const project = await projectBySlug(String(b.slug || ''));
  if (!project) return res.status(404).json({ error: 'No such project.' });
  if (timeToMin(b.atTime) == null) return res.status(400).json({ error: 'atTime must be HH:MM.' });
  const days = DAY_LIST(b.days);
  const runDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.runDate || '')) ? b.runDate : null;
  if (!days.length && !runDate) return res.status(400).json({ error: 'Pick repeat days or a one-off date.' });
  const kind = cleanKind(b.kind);
  // A schedule with no item pinned must store NULL, not 0: Number(null) is 0,
  // and a stored 0 rides the job to the runner as `--item 0`, which finds no
  // roadmap item (ids start at 1) and bails with "nothing run" — an
  // agenda-less plan night silently doing nothing. Ids are positive, so
  // anything not > 0 is "no item".
  const itemId = Number(b.itemId) > 0 ? Number(b.itemId) : null;
  const { rows } = await q(
    `INSERT INTO autopilot_schedule (project_id, item_id, at_time, days, run_date, note, session_kind, agenda, area)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb,$9) RETURNING id`,
    [project.id, itemId,
     cleanAutopilotTime(b.atTime), JSON.stringify(days), runDate, String(b.note || '').slice(0, 300),
     kind, JSON.stringify(cleanAgenda(b.agenda)), cleanArea(b.area)]
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
    // Same "no item" collapse as POST /schedule: 0 is never a real id.
    values.push(Number(b.itemId) > 0 ? Number(b.itemId) : null);
  }
  if ('note' in b) { fields.push(`note = $${i++}`); values.push(String(b.note || '').slice(0, 300)); }
  // #228 — the session plan.
  if ('kind' in b) { fields.push(`session_kind = $${i++}`); values.push(cleanKind(b.kind)); }
  if ('agenda' in b) { fields.push(`agenda = $${i++}::jsonb`); values.push(JSON.stringify(cleanAgenda(b.agenda))); }
  if ('area' in b) { fields.push(`area = $${i++}`); values.push(cleanArea(b.area)); }
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
  // No item pinned must be NULL, not 0 — same "no item" collapse as the
  // schedule (#272). Deliberately kept over #359's looser spelling, which
  // treated 0 as a real id and would have sent `--item 0` back down the very
  // path #272 fixed.
  const itemId = Number(b.itemId) > 0 ? Number(b.itemId) : null;
  const agenda = cleanAgenda(b.agenda);
  // #359 — a human is standing right here, so an unapproved item must be
  // refused OUT LOUD rather than silently dropped (contrast
  // checkScheduleApproval, the unattended twin of this check). Skipped
  // entirely when there's nothing to resolve — a plain manual Run-now with
  // no itemId/agenda must behave exactly as it did before this landed.
  const approval = await checkStartApproval(project.id, itemId, agenda);
  if (approval && approval.held.length) {
    return res.status(409).json({
      error: approval.held.map((h) => h.reason).join(' '),
      held: approval.held.map((h) => h.id),
    });
  }
  // #228 — Run now can carry a full session plan (kind / ordered agenda / area).
  const { rows } = await q(
    `INSERT INTO autopilot_jobs (project_id, kind, item_id, session_kind, agenda, area)
     VALUES ($1,'manual',$2,$3,$4::jsonb,$5) RETURNING id`,
    [project.id, itemId, cleanKind(b.kind), JSON.stringify(approval ? approval.agenda : agenda), cleanArea(b.area)]);
  const full = await q(`${JOB_SELECT} WHERE j.id = $1`, [rows[0].id]);
  res.status(201).json(jobShape(full.rows[0]));
});

// POST /merge — Mission Control's branch-merge button (#154): queue a merge job
// for an open lane branch. The host dispatcher (the only thing with the repo)
// fetches, merges origin/<branch> into main with --no-ff in a throwaway
// worktree, pushes main, and deletes the remote lane branch on success.
// Conflicts are reported as failed — the human must resolve by hand.
// The itemId (if supplied) is carried in the job detail so the UI can offer
// "tick #N" after the job completes — the dispatcher does NOT tick it (the human
// disposes; Gemini/automation never mutates tracker state).
// Serialised the same way as /undo: 409 while any open job exists for the project.
autopilotGlobal.post('/merge', async (req, res) => {
  const b = req.body || {};
  const project = await projectBySlug(String(b.slug || ''));
  if (!project) return res.status(404).json({ error: 'No such project.' });
  const branch = String(b.branch || '').trim();
  if (!branch) return res.status(400).json({ error: 'branch required.' });
  // itemId is advisory — carried as metadata, not a hard FK check. No item
  // pinned must be NULL, not 0 (#272).
  const itemId = Number(b.itemId) > 0 ? Number(b.itemId) : null;
  const open = await q(
    `${JOB_SELECT} WHERE j.project_id = $1 AND j.status IN ('queued','claimed','running')
      ORDER BY j.created_at`, [project.id]);
  const openJobs = open.rows.map(jobShape);
  // Same merge already queued = idempotent.
  const same = openJobs.find((j) => j.kind === 'merge' && j.detail.includes(`origin/${branch} into`));
  if (same) return res.status(200).json(same);
  // Merge TRAINS (#193): other queued merges never block a new one — /next is
  // serialised, so they run one after another and each starts from the fresh
  // origin/main the previous one pushed (rebase-on-the-last for free). Only a
  // NON-merge open job blocks a human press. Auto-merge (#212) arrives FROM a
  // running night — its own job holds the queue, so it bypasses even that.
  const blocker = openJobs.find((j) => j.kind !== 'merge');
  if (blocker && !b.auto) {
    return res.status(409).json({ error: `An automation job for this project is already ${blocker.status} — merge when it finishes.` });
  }
  // AI-assisted conflict resolution (#193): the human opted in on a branch the
  // probe called dirty — the dispatcher lets claude resolve in the worktree,
  // and still aborts safely if the resolution doesn't come out clean.
  const detail = `${b.auto ? 'auto-' : ''}merge origin/${branch} into main${itemId ? ` (item #${itemId})` : ''}${b.auto ? ' — low risk, green checks, clean review' : ''}${b.aiResolve === true ? ' [ai-resolve]' : ''}`;
  const { rows } = await q(
    `INSERT INTO autopilot_jobs (project_id, kind, item_id, detail) VALUES ($1,'merge',$2,$3) RETURNING id`,
    [project.id, itemId, detail]);
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
  // No item pinned must be NULL, not 0 (#272).
  const itemId = Number(b.itemId) > 0 ? Number(b.itemId) : null;
  // #255 — a resume must come back as the SAME kind of session. A plan sweep
  // that hits the usage limit and resumes as a build night would start writing
  // code nobody asked it to write, so the runner passes its kind along and the
  // job carries it; the dispatcher re-derives --plan-only from session_kind.
  const kind = cleanKind(b.kind);
  const openResume = await q(
    `SELECT id FROM autopilot_jobs
      WHERE project_id = $1 AND kind = 'resume' AND status IN ('queued','paused')
      ORDER BY created_at LIMIT 1`, [project.id]);
  let id;
  if (openResume.rows.length) {
    id = openResume.rows[0].id;
    await q(
      `UPDATE autopilot_jobs SET not_before = now() + ($1 || ' minutes')::interval,
              status = 'queued', claimed_at = NULL, item_id = $2, session_kind = $4 WHERE id = $3`,
      [minutes, itemId, id, kind]);
  } else {
    ({ rows: [{ id }] } = await q(
      `INSERT INTO autopilot_jobs (project_id, kind, item_id, not_before, session_kind)
       VALUES ($1, 'resume', $2, now() + ($3 || ' minutes')::interval, $4) RETURNING id`,
      [project.id, itemId, minutes, kind]));
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

// Rotation ordering (#82): nightly jobs for all automode projects are enqueued
// at the same instant, so a plain created_at ORDER BY would always hand the
// same project out first. Instead we pick the project whose last COMPLETED
// nightly run is oldest (NULL = never run → goes first), breaking ties by
// created_at. Non-nightly jobs (manual / scheduled / revert / resume) carry
// their own created_at and slot into the queue normally in front of nightly
// batches when they arrive first.
//
// #335 — two gates replace what used to be a single fleet-wide "one job in
// flight" lock. That lock was the reason a fanned overnight ran SERIAL: every
// automode project's nightly is enqueued at the same instant, so N projects
// finished in N x session-length no matter how idle the host was.
//
// The fleet cap (autopilotWorkers, $1; 0 = unlimited) is the tunable half —
// it bounds how many claude sessions the HOST is asked to run at once, which
// is a property of the machine, not of the work, so the owner dials it to
// whatever the box can actually carry.
//
// Per-project serialisation is NOT tunable and must stay: every job for a
// project runs against the one checkout at $STACK_AUTOPILOT_ROOT/<slug>, and
// two runners fetching, adding worktrees and moving refs in the same repo
// fight over git's ref locks. The project, not the fleet, is the resource
// that can only take one job at a time.
//
// Honesty about the cap: it is a BOUND, not a mutex. Two polls landing in the
// same instant can both read room under the count and both claim, so the
// fleet can briefly overshoot by one. The dispatcher polls on a one-minute
// cron, so this is theoretical — the gate that must not slip is the
// per-project one, and it holds because a second job for the same project
// cannot be claimed while the first row still reads claimed/running.
//
// #267 adds a THIRD gate to the two above, and the three answer three
// different questions — keep them distinct when editing:
//   fleet cap ($1)      · how many sessions may this HOST run at once (tunable)
//   per-project         · one job per checkout, because git ref locks (fixed)
//   area lane ($2, #267)· one worker per (project, area), because two branches
//                         in one area collide at MERGE time (fixed)
// The area lane is the only one of the three that is not answerable in SQL
// alone — the occupied set is computed in JS from lanes.js and passed in as a
// list of "project_id::area" keys, so this statement stays a pure predicate.
//
// A job with no item_id and no area (a nightly, an unstarted plan sweep) is
// not lane-checkable here — it has not chosen an item yet, and the runner does
// the per-item lane check once it does.
//
// Exported so server/test/autopilot-next.test.mjs can exercise this exact
// statement against a real database rather than a copy of it — a copy is
// exactly what would drift.
//
// $1 = autopilotWorkers (0 = unlimited) · $2 = occupied lane keys (text[]).

// The lane predicate, shared by the claim and by the held-jobs query that
// explains what the claim passed over — the two must not drift, or the
// dispatcher logs a reason for a job that was never actually blocked. It is a
// FUNCTION of the placeholder because the two statements bind the occupied
// list at different positions ($2 in the claim, which takes the fleet cap
// first; $1 in the held query, which takes nothing else) — a shared constant
// would have hard-coded one of them and silently mis-bound the other.
// `pinned` is the LEFT JOIN on the job's item; both arms compare the composite
// (project, area) key so a same-named area in another project never matches.
export const laneBlockSql = (p) => `
    (j.area <> '' AND (j.project_id::text || '::' || lower(trim(j.area))) = ANY(${p}::text[]))
    OR (
      pinned.id IS NOT NULL AND COALESCE(pinned.area, '') <> ''
      AND (pinned.project_id::text || '::' || lower(trim(pinned.area))) = ANY(${p}::text[])
      AND EXISTS (
        SELECT 1 FROM roadmap_items other
         WHERE NOT other.done AND COALESCE(other.claimed_by, '') <> ''
           AND other.id <> pinned.id
           AND other.project_id = pinned.project_id
           AND lower(trim(other.area)) = lower(trim(pinned.area))
        UNION ALL
        SELECT 1 FROM autopilot_jobs oj
         LEFT JOIN roadmap_items ojr ON ojr.id = oj.item_id
         WHERE oj.status IN ('claimed', 'running') AND oj.id <> j.id
           AND oj.project_id = j.project_id
           AND (lower(trim(oj.area)) = lower(trim(pinned.area))
                OR lower(trim(COALESCE(ojr.area, ''))) = lower(trim(pinned.area)))
      )
    )`;

export const CLAIM_NEXT_SQL = `
    UPDATE autopilot_jobs SET status = 'claimed', claimed_at = now()
      WHERE id = (
        SELECT j.id FROM autopilot_jobs j
        LEFT JOIN LATERAL (
          SELECT finished_at FROM autopilot_jobs
           WHERE project_id = j.project_id
             AND kind = 'nightly'
             AND status = 'done'
           ORDER BY finished_at DESC LIMIT 1
        ) last_run ON j.kind = 'nightly'
        LEFT JOIN roadmap_items pinned ON pinned.id = j.item_id
         WHERE j.status = 'queued' AND (j.not_before IS NULL OR j.not_before <= now())
           -- Per-PROJECT serialisation (not tunable, see the comment).
           AND NOT EXISTS (
             SELECT 1 FROM autopilot_jobs b
              WHERE b.project_id = j.project_id
                AND b.status IN ('claimed', 'running'))
           -- The fleet cap; $1 = 0 means unlimited.
           AND ($1 = 0 OR (SELECT count(*) FROM autopilot_jobs b2
                            WHERE b2.status IN ('claimed', 'running')) < $1)
           -- The area lane (#267). A blocked job is SKIPPED and the next
           -- eligible one wins inside this same ORDER BY ... LIMIT 1 — that is
           -- the fallback, there is no second queue.
           AND NOT (${laneBlockSql('$2')})
         ORDER BY
           -- Non-nightly jobs first (they have a specific creation time and
           -- priority; nightly batch jobs rank behind them in the same tick).
           (j.kind = 'nightly') ASC,
           -- Rotate nightly projects: least recently run goes first (NULL = never run).
           last_run.finished_at ASC NULLS FIRST,
           -- Stable tie-break across everything else.
           j.created_at ASC
         LIMIT 1 FOR UPDATE OF j SKIP LOCKED
      )
      RETURNING id`;

// GET /next?local=YYYY-MM-DDTHH:MM&dow=N — the host dispatcher's poll.
// Recovers stale jobs, lazily enqueues due work, then claims one job under the
// fleet cap and the per-project gate (#335 — see the comment on CLAIM_NEXT_SQL
// above).
autopilotGlobal.get('/next', async (req, res) => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(req.query.local || ''));
  if (!m) return res.status(400).json({ error: 'local=YYYY-MM-DDTHH:MM required.' });
  const [, localDate, localTime] = m;
  const nowMin = timeToMin(localTime);
  const dow = Math.trunc(Number(req.query.dow));
  const settings = await readSettings();

  // (#270) Heartbeat. This poll is the automation loop's pulse — stamp it
  // before any gate, so a disarmed-but-alive dispatcher is distinguishable
  // from one that has stopped asking. Mission Control reads the freshness;
  // a failure here must never cost the dispatcher its job.
  q(`UPDATE dispatcher_heartbeat SET last_poll_at = now(), host_local = $1 WHERE id`,
    [`${localDate}T${localTime}`]).catch(() => {});

  // Stale recovery: a claim the dispatcher never started (it died) re-queues;
  // a "running" job with no completion report for 12h is closed out.
  await q(`UPDATE autopilot_jobs SET status = 'queued', claimed_at = NULL
            WHERE status = 'claimed' AND claimed_at < now() - interval '15 minutes'`);
  await q(`UPDATE autopilot_jobs SET status = 'failed', detail = 'stale — no completion report', finished_at = now()
            WHERE status = 'running' AND started_at < now() - interval '12 hours'`);

  // The armed nightly (#266 — fanned out): one job PER ELIGIBLE ITEM, up to
  // Settings' max-items, once the clock passes the configured start — not one
  // multi-item job that picked its own items after the fact. Each job is
  // pinned to its item (so the runner's own --item refusal-on-claim/-done
  // logic already applies with no runner change) and carries its own slice of
  // the night's token budget. The candidate pick is ONE aggregate query across
  // every automode project (never one query per project), windowed to the top
  // 20 per project by the run queue's own order — tier first (S/A/B/C, then
  // unranked last), then bucket (must before should), then position/id — and
  // filtered exactly like the runner's own `eligible()`: open, unclaimed, not
  // parked, human-approved (or manual), inside the project's target area. The
  // fan-out and the split are pure helpers (nightFanOut/splitNightBudget)
  // above; the unique partial index (now keyed on the item too) carries the
  // dedup, so re-polls stay free. A project with zero eligible items gets NO
  // nightly job at all tonight — the old single job would have started a
  // session, found nothing eligible and exited; standing one up for nothing
  // is worse than standing up none.
  if (settings.autopilot_enabled && within(timeToMin(settings.autopilot_time), nowMin)) {
    const { rows: candidates } = await q(`
      SELECT project_id, item_id FROM (
        SELECT p.id AS project_id, r.id AS item_id,
               row_number() OVER (
                 PARTITION BY p.id
                 ORDER BY
                   CASE upper(COALESCE(r.tier, ''))
                     WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 ELSE 4 END,
                   CASE r.bucket WHEN 'must' THEN 0 WHEN 'should' THEN 1 ELSE 2 END,
                   r.position, r.id
               ) AS rn
          FROM projects p
          JOIN roadmap_items r ON r.project_id = p.id
         WHERE p.automode AND p.deleted_at IS NULL
           AND NOT r.done AND NOT COALESCE(r.skipped, false)
           AND COALESCE(r.claimed_by, '') = ''
           AND r.bucket IN ('must', 'should')
           -- #359's rule, not a copy of it. #266's fan-out query is newer than
           -- #359's branch, so it arrived spelling this out inline and became
           -- the fourth hand-rolled copy the moment the two merged.
           AND ${APPROVED_SQL('r')}
           AND (COALESCE(p.autopilot_area, '') = '' OR lower(COALESCE(r.area, '')) = lower(p.autopilot_area))
           -- The fan-out is decided ONCE, at the moment the night opens — not
           -- re-decided on every poll. Without this guard, the moment the
           -- runner starts a fanned job it claims that item, the item drops
           -- out of the candidate list above, the top-20 window slides down,
           -- and items N+1, N+2 … look like fresh candidates on the very next
           -- poll (this block runs once a minute for the whole grace window).
           -- Each "fresh" batch would be handed another full splitNightBudget
           -- share, so the night's token budget would be issued several times
           -- over. One decision per project per night is also what makes the
           -- split exact.
           AND NOT EXISTS (
             SELECT 1 FROM autopilot_jobs j
              WHERE j.project_id = p.id AND j.kind = 'nightly' AND j.night_date = $1::date)
      ) ranked
      WHERE rn <= 20
      ORDER BY project_id, rn`, [localDate]);
    const byProject = new Map();
    for (const row of candidates) {
      const list = byProject.get(row.project_id) || [];
      list.push(row.item_id);
      byProject.set(row.project_id, list);
    }
    const values = [];
    const params = [];
    let i = 1;
    for (const [projectId, items] of byProject) {
      const n = nightFanOut(settings.autopilot_max_items, items.length, settings.autopilot_tokens);
      const shares = splitNightBudget(settings.autopilot_tokens, n);
      for (let k = 0; k < n; k++) {
        values.push(`($${i++}, 'nightly', $${i++}::date, $${i++}, $${i++})`);
        params.push(projectId, localDate, items[k], shares[k]);
      }
    }
    if (values.length) {
      await q(
        `INSERT INTO autopilot_jobs (project_id, kind, night_date, item_id, token_budget)
          VALUES ${values.join(', ')}
          ON CONFLICT (project_id, night_date, COALESCE(item_id, 0)) WHERE kind = 'nightly' DO NOTHING`,
        params);
    }
  }

  // The plan sweep (#255). The board's ✧ To planning agent is the pressed
  // version of this; the sweep is the standing one — "the system must plan the
  // implementation of all roadmap items" without anyone asking.
  //
  // It stands up ONE plan job per project that still has eligible unplanned
  // must/should work, and the partial unique index makes that idempotent under
  // a poll that runs every minute. Deliberately gated on the arm switch and
  // automode, exactly like the nightly: the sweep spends tokens, so the same
  // switch that stops the nights stops it too. Its agenda is left empty — the
  // runner re-derives the eligible list when it actually starts, so a job that
  // sits in the queue for hours never plans against a stale board.
  //
  // "No recent 'planned' run" keeps a project that was just swept from being
  // swept again while the human has not yet looked at the designs.
  if (settings.autopilot_enabled && settings.autopilot_plan_sweep) {
    await q(
      `INSERT INTO autopilot_jobs (project_id, kind, session_kind)
         SELECT p.id, 'plan', 'plan'
           FROM projects p
          WHERE p.automode AND p.deleted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM roadmap_items r
               WHERE r.project_id = p.id
                 AND NOT r.done
                 AND NOT COALESCE(r.skipped, false)
                 AND COALESCE(r.claimed_by, '') = ''
                 AND r.bucket IN ('must', 'should')
                 AND jsonb_array_length(COALESCE(r.plan, '[]'::jsonb)) = 0
                 -- Fail safe (unattended spend, no human watching): without this,
                 -- an unapproved hook item alone stands a plan job up, and the
                 -- runner re-derives its eligible list when it actually starts
                 -- and filters that same item back out — a sweep that LOOKS like
                 -- it worked and planned nothing.
                 AND ${APPROVED_SQL('r')})
            AND NOT EXISTS (
              SELECT 1 FROM autopilot_runs ar
               WHERE ar.project_id = p.id
                 AND ar.outcome = 'planned'
                 AND ar.finished_at > now() - interval '20 hours')
       ON CONFLICT DO NOTHING`);
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
      // #359 — fail safe: drop the enqueue rather than run an unapproved item;
      // the row still gets its stamp/retire below either way (see
      // checkScheduleApproval's doc comment for why).
      const approval = await checkScheduleApproval(s.project_id, s.item_id, s.agenda);
      if (!approval || !approval.held) {
        await q(
          `INSERT INTO autopilot_jobs (project_id, kind, item_id, schedule_id, session_kind, agenda, area)
           VALUES ($1,'scheduled',$2,$3,$4,$5::jsonb,$6)`,
          [s.project_id, s.item_id, s.id, cleanKind(s.session_kind),
           JSON.stringify(approval ? approval.agenda : (Array.isArray(s.agenda) ? s.agenda : [])), s.area || '']);
      }
      // One-offs retire themselves; recurring rows just stamp the local date.
      await q(
        onceToday
          ? 'UPDATE autopilot_schedule SET enabled = false, last_enqueued_on = $2 WHERE id = $1'
          : 'UPDATE autopilot_schedule SET last_enqueued_on = $2 WHERE id = $1',
        [s.id, localDate]);
    }
  }

  // #267 — area-disjoint picking. An "area lane" (roadmap_items.area,
  // normalised) admits one worker: two workers in the same area fight over
  // the same files at merge time. A lane is scoped to ONE PROJECT — the same
  // area string in two different projects can never collide over files, so
  // the key is always (project_id, area), never the bare area (lanes.js).
  // A lane is OCCUPIED when either an open roadmap item in that area carries
  // a live branch claim, or an in-flight job (claimed/running) targets that
  // area — its own area filter, or the area of the item it is pinned to. An
  // untagged area ('') is NEVER a lane — it neither occupies one nor can be
  // blocked by one, or every untagged item collapses into one giant lane and
  // the night deadlocks doing nothing. One round trip for the whole board,
  // never one query per project.
  const { rows: holderRows } = await q(`
    SELECT project_id, lower(trim(area)) AS area, claimed_by AS by
      FROM roadmap_items
     WHERE NOT done AND COALESCE(claimed_by, '') <> '' AND COALESCE(area, '') <> ''
    UNION ALL
    SELECT j.project_id, lower(trim(j.area)) AS area, ('job #' || j.id) AS by
      FROM autopilot_jobs j
     WHERE j.status IN ('claimed', 'running') AND COALESCE(j.area, '') <> ''
    UNION ALL
    SELECT j.project_id, lower(trim(ri.area)) AS area, ('job #' || j.id) AS by
      FROM autopilot_jobs j
      JOIN roadmap_items ri ON ri.id = j.item_id
     WHERE j.status IN ('claimed', 'running') AND COALESCE(ri.area, '') <> ''
  `);
  const occupied = [...occupiedAreas(holderRows.map((r) => ({ projectId: r.project_id, area: r.area, by: r.by })))];
  const holderLabel = laneHolders(holderRows.map((r) => ({ projectId: r.project_id, area: r.area, by: r.by })));

  // A holder never blocks itself: a job pinned to an item that is claimed by
  // ITS OWN lane must still be claimable (that's a resume/re-run) — see
  // LANE_BLOCK_SQL, which both this claim and the held-jobs query below share.

  // A queued resume job stays held until its not_before passes (#142); a
  // 'paused' (hung-up) job is never handed out at all — both enforced inside
  // CLAIM_NEXT_SQL, alongside the fleet cap, the per-project gate (#335) and
  // the area lane (#267). Rotation ordering (#82) lives there too.
  const claimed = await q(CLAIM_NEXT_SQL, [settings.autopilot_workers, occupied]);

  // #267 — the queued, otherwise-claimable jobs THIS tick passed over because
  // their area lane was occupied, so the dispatcher can log why. Uses the
  // claim's own lane predicate (same occupied list, bound at $1 here); the
  // winning job (if any) is excluded for free since its status is no longer
  // 'queued'. NOTE this deliberately does NOT re-test the fleet cap or the
  // per-project gate: a job held by those is not held by a LANE, and saying so
  // would blame the area for a queue depth the owner did not cause.
  const { rows: heldRows } = await q(
    `SELECT j.id, j.project_id, p.slug, j.item_id,
            COALESCE(NULLIF(j.area, ''), pinned.area) AS area
       FROM autopilot_jobs j
       JOIN projects p ON p.id = j.project_id AND p.deleted_at IS NULL
       LEFT JOIN roadmap_items pinned ON pinned.id = j.item_id
      WHERE j.status = 'queued' AND (j.not_before IS NULL OR j.not_before <= now())
        AND (${laneBlockSql('$1')})`,
    [occupied]);
  const heldByArea = heldRows.map((r) => {
    // `area` here is the bare, human-readable string for a log line — the
    // lookup into holderLabel still keys on the composite (project, area)
    // lane, same as everywhere else in this file.
    const area = String(r.area || '').trim().toLowerCase();
    return {
      jobId: String(r.id),
      slug: r.slug,
      itemId: r.item_id != null ? String(r.item_id) : null,
      area,
      heldBy: holderLabel.get(laneKey(r.project_id, area)) || '',
    };
  });

  if (!claimed.rows.length) return res.json({ job: null, heldByArea });
  const full = await q(`${JOB_SELECT} WHERE j.id = $1`, [claimed.rows[0].id]);
  res.json({ job: jobShape(full.rows[0]), heldByArea });
});

// PATCH /jobs/:id — the dispatcher reports { status: running|done|failed|queued, detail? }.
// #142 adds the human controls: { status: 'paused' } hangs a job up (held until
// resumed by hand), { status: 'queued', notBefore: null } resumes it now
// (clearing the hold marks it human-pressed — the dispatcher runs a
// held-then-resumed job with --force, like any manual press).
// #150: pausing a RUNNING job is the kill request — the dispatcher polls its
// job's status mid-run and kills the session (tmux path) within ~30s; the job
// stays paused with partial work on its branch. (A pre-#150 dispatcher just
// finishes and overwrites the status — nothing breaks, nothing dies.)
autopilotGlobal.patch('/jobs/:id', async (req, res) => {
  const b = req.body || {};
  const status = ['running', 'done', 'failed', 'queued', 'paused'].includes(b.status) ? b.status : null;
  if (!status) return res.status(400).json({ error: 'status must be running|done|failed|queued|paused.' });
  const clearHold = 'notBefore' in b && b.notBefore == null;
  const stampCol = status === 'running' ? 'started_at = now()'
    : status === 'queued' || status === 'paused' ? 'claimed_at = NULL' : 'finished_at = now()';
  const guard = status === 'paused' ? `AND status IN ('queued','claimed','running')` : '';
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
  // tmux_session (#171): the named tmux session monitoring this run, if any.
  const tmuxSession = b.tmux_session && typeof b.tmux_session === 'string'
    ? String(b.tmux_session).slice(0, 120) : null;
  // The reviewer's verdict (#282). Only the three known words are stored — an
  // unrecognised one becomes NULL rather than inventing a verdict nobody gave.
  const reviewVerdict = REVIEW_VERDICTS.includes(b.review_verdict) ? b.review_verdict : null;
  const reviewNote = b.review_note ? String(b.review_note).slice(0, 1200) : null;
  const reviewFindings = Number.isFinite(Number(b.review_findings))
    ? Math.max(0, Math.trunc(Number(b.review_findings))) : null;
  // #266 — which night (if any) produced this run. Only a plain ISO date is
  // stored — an unrecognised value becomes NULL rather than inventing one.
  const nightDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.night_date || '')) ? b.night_date : null;
  const { rows } = await q(
    `INSERT INTO autopilot_runs
       (project_id, item_id, item_title, branch, outcome, commits, tokens, cost_usd, checks_failing, summary, model_usage, tmux_session, review_verdict, review_note, review_findings, night_date, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16, COALESCE($17, now())) RETURNING *`,
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
      tmuxSession,
      reviewVerdict, reviewNote, reviewFindings,
      nightDate,
      b.started_at ? new Date(b.started_at) : null,
    ]
  );
  res.status(201).json(runShape(rows[0]));
});

// PATCH /runs/:id -> attach the reviewer's read to a run already recorded (#282).
// The run row is posted BEFORE the Gemini diff review so a crash mid-review
// still costs only the review, never the record — which means the verdict has
// to arrive as a second, narrow write. Review fields only: nothing else about a
// finished run is editable after the fact.
autopilot.patch('/runs/:id', async (req, res) => {
  const b = req.body || {};
  const sets = [];
  const vals = [];
  let i = 1;
  if (b.review_verdict !== undefined) {
    sets.push(`review_verdict = $${i++}`);
    vals.push(REVIEW_VERDICTS.includes(b.review_verdict) ? b.review_verdict : null);
  }
  if (b.review_note !== undefined) {
    sets.push(`review_note = $${i++}`);
    vals.push(b.review_note ? String(b.review_note).slice(0, 1200) : null);
  }
  if (b.review_findings !== undefined) {
    sets.push(`review_findings = $${i++}`);
    vals.push(Number.isFinite(Number(b.review_findings)) ? Math.max(0, Math.trunc(Number(b.review_findings))) : null);
  }
  if (b.architect_verdict !== undefined) {
    sets.push(`architect_verdict = $${i++}`);
    vals.push(ARCHITECT_VERDICTS.includes(b.architect_verdict) ? b.architect_verdict : null);
  }
  if (b.architect_note !== undefined) {
    sets.push(`architect_note = $${i++}`);
    vals.push(b.architect_note ? String(b.architect_note).slice(0, 1200) : null);
  }
  if (b.architect_obs !== undefined) {
    const obs = Array.isArray(b.architect_obs)
      ? b.architect_obs.map((o) => String(o).slice(0, 200)).filter(Boolean).slice(0, 4) : null;
    sets.push(`architect_obs = $${i++}::jsonb`);
    vals.push(obs && obs.length ? JSON.stringify(obs) : null);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  vals.push(req.project.id, Number(req.params.id));
  const { rows } = await q(
    `UPDATE autopilot_runs SET ${sets.join(', ')} WHERE project_id = $${i++} AND id = $${i} RETURNING *`,
    vals
  );
  if (!rows.length) return res.status(404).json({ error: 'No such run.' });
  res.json(runShape(rows[0]));
});
