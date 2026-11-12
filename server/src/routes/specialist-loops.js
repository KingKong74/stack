// Observation policies share the diagnostic queue and existing claim gates.
// No Ready, roadmap, fix or verdict writes. Host polls out; unknown means hold.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool, q } from '../db.js';
import { readSettings } from '../settings.js';
import { loopHold } from './autopilot.js';
import { prepareSpecialistSpec } from '../specialist-spec.js';
import { loopUsage, specialistLoopHold } from '../specialist-loops.js';
export const specialistLoops = Router({ mergeParams: true });
const columns = 'id, profile_key, name, enabled, interval_minutes, max_runs_day, max_tokens_day, paths, last_head, last_job_id, last_trigger_at, stop_reason';
const clean = b => {
  const name = String(b.name || '').trim();
  if (!name || name.length > 120) throw Error('Name must contain 1–120 characters.');
  const values = { intervalMinutes: [15, 10080, 60], maxRunsDay: [1, 12, 2], maxTokensDay: [1000, 2000000, 150000] };
  const out = { name };
  for (const [k, [min, max, fallback]] of Object.entries(values)) { const n = b[k] ?? fallback; if (!Number.isInteger(n) || n < min || n > max) throw Error(`Invalid ${k}.`); out[k] = n; }
  return out;
};
async function prepare(b, slug, client) {
  return prepareSpecialistSpec({ requestId: randomUUID(), base: b.base || '0'.repeat(40), head: b.head || '0'.repeat(40), profileKey: b.profileKey,
    paths: b.paths ?? [], maxSeconds: 90, note: 'Automatic observation only. Report supplied diff evidence; no tools, fixes, proposals or human verdict.' }, slug, client);
}
async function eligibility(client, policy, req, spec) {
  // One shared project budget prevents multiplying spend by creating more policies.
  const jobs = (await client.query(`SELECT status, advice, specialist_spec FROM autopilot_jobs WHERE project_id=$1 AND kind='specialist' AND
    (created_at > now() - interval '24 hours' OR status IN ('queued','claimed','running')) ORDER BY id DESC`, [req.project.id])).rows;
  const proof = jobs.some(j => {
    if (j.status !== 'done' || j.specialist_spec?.loopPolicyId || j.specialist_spec?.model !== spec.model || j.specialist_spec?.profileRevision !== spec.profileRevision || JSON.stringify(j.specialist_spec?.skills) !== JSON.stringify(spec.skills)) return false;
    try { const r = JSON.parse(j.advice); return !r.skipped && Array.isArray(r.findings) && !!r.provenance; } catch { return false; }
  });
  const recent = jobs.filter(j => String(j.specialist_spec?.loopPolicyId) === String(policy.id)).slice(0, 3);
  const failures = recent.length === 3 && recent.every(j => ['failed','paused'].includes(j.status)) ? 3 : 0;
  const settings = await readSettings(client);
  let globalHold = await loopHold(settings, Number.isInteger(req.body?.localMinutes) && req.body.localMinutes >= 0 && req.body.localMinutes < 1440 ? req.body.localMinutes : NaN, client);
  const cap = Number(settings.autopilot_rolling_tokens) || 0;
  if (!globalHold && cap > 0) {
    const hours = settings.autopilot_rolling_hours || 5;
    const diagnosticJobs = (await client.query(`SELECT status,advice FROM autopilot_jobs WHERE kind='specialist' AND
      (created_at > now()-make_interval(hours => $1) OR status IN ('queued','claimed','running'))`,[hours])).rows;
    const diagnosticUsage = loopUsage(diagnosticJobs);
    const runs = (await client.query('SELECT COALESCE(SUM(tokens),0) spent FROM autopilot_runs WHERE finished_at > now()-make_interval(hours => $1)',[hours])).rows[0];
    if (diagnosticUsage.spent === null) globalHold = 'fleet diagnostic usage is unknown';
    else if (Number(runs.spent) + diagnosticUsage.spent + 60000 > cap) globalHold = 'fleet rolling token budget has no room for the next pass reservation';
  }
  const usage = loopUsage(jobs);
  const hold = specialistLoopHold(policy, { head: req.body?.head, connected: req.body?.connected === true, globalHold, usage, manualProof: proof, failures });
  return { hold, usage, manualProof: proof, reserveTokens: 60000 };
}
specialistLoops.get('/', async (req, res) => {
  const { rows } = await q(`SELECT ${columns} FROM specialist_loop_policies WHERE project_id=$1 ORDER BY id`, [req.project.id]);
  res.json(rows);
});
specialistLoops.post('/', async (req, res) => {
  let c; try { c = clean(req.body || {}); } catch(e) { return res.status(400).json({error:e.message}); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialise creation too: two creators at count 31 must not both pass 32.
    await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[req.project.id]);
    let spec; try { spec = await prepare(req.body || {},req.params.slug,client); } catch(e) { await client.query('ROLLBACK'); return res.status(400).json({error:e.message}); }
    const { rows } = await client.query(`INSERT INTO specialist_loop_policies(project_id,profile_key,name,interval_minutes,max_runs_day,max_tokens_day,paths)
      SELECT $1,$2,$3,$4,$5,$6,$7::jsonb WHERE (SELECT count(*) FROM specialist_loop_policies WHERE project_id=$1)<32 RETURNING ${columns}`,
      [req.project.id,spec.profileKey,c.name,c.intervalMinutes,c.maxRunsDay,c.maxTokensDay,JSON.stringify(spec.paths)]);
    await client.query('COMMIT');
    if (!rows.length) return res.status(409).json({error:'Limit of 32 policies per project.'});
    res.status(201).json(rows[0]);
  } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});
specialistLoops.patch('/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id) || typeof req.body?.enabled !== 'boolean' || Object.keys(req.body).some(k=>k!=='enabled')) return res.status(400).json({error:'Only an explicit enabled boolean may be changed; create a new policy to change its scope.'});
  const { rows } = await q(`WITH changed AS (UPDATE specialist_loop_policies SET enabled=$1, stop_reason=$2 WHERE id=$3 AND project_id=$4 RETURNING *),
    stopped AS (UPDATE autopilot_jobs SET status='paused',detail='Observation policy disabled',finished_at=now()
      WHERE project_id=$4 AND kind='specialist' AND specialist_spec->>'loopPolicyId'=$3::text
      AND status IN ('queued','claimed','running') AND EXISTS(SELECT 1 FROM changed WHERE NOT enabled) RETURNING id)
    SELECT ${columns} FROM changed`,
    [req.body.enabled,req.body.enabled?'awaiting host eligibility check':'disabled',req.params.id,req.project.id]);
  if (!rows.length) return res.status(404).json({error:'No such loop policy.'});
  res.json(rows[0]);
});
for (const action of ['dry-run','dispatch']) specialistLoops.post(`/:id/${action}`, async (req,res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({error:'Invalid policy ID.'});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(659660)');
    const policy = (await client.query('SELECT * FROM specialist_loop_policies WHERE id=$1 AND project_id=$2 FOR UPDATE',[req.params.id,req.project.id])).rows[0];
    if (!policy) { await client.query('ROLLBACK'); return res.status(404).json({error:'No such loop policy.'}); }
    let spec; try { spec = await prepare({...req.body,profileKey:policy.profile_key,paths:policy.paths},req.params.slug,client); } catch(e) {
      const hold = policy.enabled ? `configuration unavailable: ${e.message}` : 'disabled';
      if (action === 'dispatch') await client.query('UPDATE specialist_loop_policies SET stop_reason=$1 WHERE id=$2',[hold,policy.id]);
      await client.query('COMMIT'); return res.json({hold,usage:{attempts:0,spent:null},manualProof:false,reserveTokens:60000,jobId:null,dryRun:action==='dry-run'});
    }
    // Serialise project-wide accounting across policies, without changing queue claims.
    await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[req.project.id]);
    const check = await eligibility(client,policy,req,spec);
    let jobId = null;
    if (action === 'dispatch') {
      if (!check.hold) {
        spec.loopPolicyId = String(policy.id);
        const result = await client.query(`INSERT INTO autopilot_jobs(project_id,kind,status,specialist_spec,specialist_request_id,detail)
          VALUES($1,'specialist','queued',$2::jsonb,$3,'Automatic observation queued; no tools or verdict authority') RETURNING id`,[req.project.id,JSON.stringify(spec),randomUUID()]);
        jobId = String(result.rows[0].id);
        await client.query('UPDATE specialist_loop_policies SET last_head=$1,last_job_id=$2,last_trigger_at=now(),stop_reason=$3 WHERE id=$4',[spec.head,jobId,'queued',policy.id]);
      } else await client.query('UPDATE specialist_loop_policies SET stop_reason=$1 WHERE id=$2',[check.hold,policy.id]);
    }
    await client.query('COMMIT'); res.json({...check,jobId,dryRun:action==='dry-run'});
  } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

export const specialistLoopsGlobal = Router();
specialistLoopsGlobal.get('/', async (_req,res) => {
  const {rows} = await q(`SELECT l.id, p.slug, l.last_head FROM specialist_loop_policies l JOIN projects p ON p.id=l.project_id WHERE l.enabled AND p.deleted_at IS NULL ORDER BY l.id LIMIT 256`);
  res.json(rows);
});

// Recheck authority at start and in the worker's cancellation poll. A queued
// observation never becomes a manual bypass when the arm switch changes.
export async function observationRunHold(projectId, spec, localMinutes) {
  if (!spec?.loopPolicyId) return '';
  const p = (await q('SELECT enabled FROM specialist_loop_policies WHERE id=$1 AND project_id=$2',[spec.loopPolicyId,projectId])).rows[0];
  if (!p?.enabled) return 'observation policy is disabled or missing';
  const n = localMinutes === undefined ? NaN : Number(localMinutes);
  return loopHold(await readSettings(),Number.isInteger(n)&&n>=0&&n<1440?n:NaN);
}

specialistLoops.delete('/:id', async (req,res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({error:'Invalid policy ID.'});
  const r = await q('DELETE FROM specialist_loop_policies WHERE id=$1 AND project_id=$2 AND NOT enabled RETURNING id',[req.params.id,req.project.id]);
  if (!r.rowCount) return res.status(409).json({error:'Disable an existing policy before removing it.'});
  // The diagnostic ledger keeps its captured policy ID, input and results.
  res.json({ok:true});
});
