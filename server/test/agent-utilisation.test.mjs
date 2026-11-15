// Run with DATABASE_URL pointing to a fresh throwaway Postgres; never production.
import assert from 'node:assert/strict';
import express from 'express';
import { pool, migrate, q } from '../src/db.js';
import { agentProfiles } from '../src/routes/agent-profiles.js';
if (!process.env.DATABASE_URL) throw Error('Throwaway DATABASE_URL required');
await migrate();
const app = express(); app.use('/agent-profiles', agentProfiles);
const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
try {
  const p = (await q("INSERT INTO projects(slug,name) VALUES('usage-fixture','Usage') RETURNING id")).rows[0].id;
  const gone = (await q("INSERT INTO projects(slug,name,deleted_at) VALUES('usage-deleted','Gone',now()) RETURNING id")).rows[0].id;
  await q(`INSERT INTO sessions(project_id,agent_types,created_at) VALUES
    ($1,'{"executor":3,"reviewer":2,"malformed":"oops"}',now()),
    ($1,'{"executor":99}',now()-interval '31 days'),
    ($2,'{"executor":99}',now())`, [p, gone]);
  for (const [status, started, key] of [['done',true,'reviewer'],['failed',true,'reviewer'],['running',true,'reviewer'],['queued',false,'reviewer']]) {
    await q(`INSERT INTO autopilot_jobs(project_id,kind,status,specialist_spec,started_at)
      VALUES($1,'specialist',$2,$3::jsonb,CASE WHEN $4 THEN now() ELSE NULL END)`,[p,status,JSON.stringify({profileKey:key}),started]);
  }
  const r = await fetch(`http://127.0.0.1:${server.address().port}/agent-profiles`);
  assert.equal(r.status,200); const body = await r.json();
  assert.equal(body.utilisation.windowDays,30);
  const u = body.utilisation.profiles;
  assert.equal(u.executor.calls,3); assert.equal(u.executor.diagnostics,0);
  assert.equal(u.reviewer.calls,2); assert.equal(u.reviewer.diagnostics,3);
  assert.equal(u.reviewer.completed,1); assert.equal(u.reviewer.failed,1);
  assert.deepEqual(u.reviewer.projects,['usage-fixture']); assert.ok(Date.parse(u.reviewer.lastAt));
  assert.equal(u.malformed,undefined); assert.equal(u['unused-profile'],undefined);
  assert.ok(body.profiles.length); assert.ok(body.usage);
  await q('ALTER TABLE sessions RENAME COLUMN agent_types TO unavailable_types');
  const unavailable = await (await fetch(`http://127.0.0.1:${server.address().port}/agent-profiles`)).json();
  assert.equal(unavailable.utilisation.profiles,null,'failed observation is unknown, never zero');
  console.log('PASS: route usage, outcomes, exact keys, date window, deleted projects, unstarted jobs, malformed counts and unavailable telemetry.');
} finally { await new Promise(r=>server.close(r)); await pool.end(); }
