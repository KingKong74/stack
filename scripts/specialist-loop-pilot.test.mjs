// Complete observation pilot on a FRESH throwaway DB + real temporary Git
// checkout. Native output is injected; no subscription call or live activation.
import assert from 'node:assert/strict';
import express from '../server/node_modules/express/index.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { migrate, pool, q } from '../server/src/db.js';
import { specialists } from '../server/src/routes/specialists.js';
import { specialistLoopsGlobal } from '../server/src/routes/specialist-loops.js';
import { CLAIM_NEXT_SQL } from '../server/src/routes/autopilot.js';
import { sweepSpecialistLoops } from './lib/specialist-loop-sweep.mjs';
import { runSpecialistJob } from './lib/specialist-run.mjs';
if (!process.env.DATABASE_URL) throw Error('Fresh throwaway DATABASE_URL required');
await migrate();
const slug=`pilot-${randomUUID().slice(0,8)}`,key=`review-${randomUUID().slice(0,8)}`;
const root=mkdtempSync(join(tmpdir(),'stack-loop-pilot-')),repo=join(root,slug);mkdirSync(repo);
const git=(...args)=>{const r=spawnSync('git',['-C',repo,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
git('init');
const commit=n=>{writeFileSync(join(repo,'fixture.js'),`export const version = ${n};\n`);git('add','.');git('-c','user.name=Fixture','-c','user.email=f@f','commit','-m',`Fixture ${n}`);return git('rev-parse','HEAD');};
const base=commit(1);let head=commit(2);
const project=(await q('INSERT INTO projects(slug,name) VALUES($1,$1) RETURNING id',[slug])).rows[0];
await q("INSERT INTO agent_profiles(key,name,prompt,tools) VALUES($1,'Pilot Reviewer','Review supplied evidence','[\"Read\"]')",[key]);
await q("UPDATE settings SET autopilot_enabled=true,autopilot_quiet='',autopilot_rolling_tokens=0");
const app=express();app.use(express.json());app.use('/api/projects/:slug/specialists',specialists);app.use('/api/specialist-loops',specialistLoopsGlobal);
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const api=async(method,path,body,status=200)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10000),...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.status,status,await r.clone().text());return r.json();};
const path=`/api/projects/${slug}/specialists`;
const usage={input_tokens:100,output_tokens:100,cache_read_input_tokens:0,cache_creation_input_tokens:0};
let invocations=0;
const complete=async id=>{
 const claim=await q(CLAIM_NEXT_SQL,[1,[]]);assert.equal(String(claim.rows[0].id),String(id));
 const {spec}=await api('GET',`${path}/runs/${id}`);
 await api('POST',`${path}/runs/${id}/start`,{localMinutes:720});
 const result=await runSpecialistJob({repo,spec,invoke:async()=>{invocations++;return {text:JSON.stringify({summary:'Fixture read only',findings:[],read:[],blind:['No verification commands executed']}),usage};}});
 await api('POST',`${path}/runs/${id}/result`,{status:'done',result});return result;
};
const sweep=()=>sweepSpecialistLoops({api,root,localMinutes:720});
try {
 const manual=await api('POST',`${path}/runs`,{requestId:randomUUID(),profileKey:key,base,head},201);await complete(manual.id);
 const policy=await api('POST',`${path}/loops`,{name:'Reviewer pilot',profileKey:key,paths:['fixture.js'],intervalMinutes:15,maxRunsDay:6,maxTokensDay:500000},201);
 assert.equal(policy.enabled,false);assert.deepEqual(await sweep(),[]);
 await api('PATCH',`${path}/loops/${policy.id}`,{enabled:true});
 let report=(await sweep())[0];assert.ok(report.jobId);await complete(report.jobId);
 assert.equal((await sweep())[0].hold,'no new commit since the last pass');
 // New sweep invocation reads persisted state; a dispatcher restart cannot replay it.
 assert.equal((await sweepSpecialistLoops({api,root,localMinutes:720}))[0].jobId,null);
 head=commit(3);assert.equal((await sweep())[0].hold,'cooldown');
 await q("UPDATE specialist_loop_policies SET last_trigger_at=now()-interval '1 hour' WHERE id=$1",[policy.id]);
 await q('UPDATE settings SET autopilot_enabled=false');assert.match((await sweep())[0].hold,/switched off/);
 await q('UPDATE settings SET autopilot_enabled=true');
 // A genuine empty diff in the selected scope spends no model call.
 const empty=await api('POST',`${path}/loops`,{name:'Empty scope pilot',profileKey:key,paths:['not-changed.js'],maxRunsDay:6,maxTokensDay:500000},201);
 await api('PATCH',`${path}/loops/${policy.id}`,{enabled:false});await api('PATCH',`${path}/loops/${empty.id}`,{enabled:true});
 report=(await sweep())[0];const before=invocations;const skipped=await complete(report.jobId);assert.equal(skipped.skipped,true);assert.equal(invocations,before);
 await api('PATCH',`${path}/loops/${empty.id}`,{enabled:false});
 await api('PATCH',`${path}/loops/${policy.id}`,{enabled:true});report=(await sweep())[0];assert.ok(report.jobId);
 await api('PATCH',`${path}/loops/${policy.id}`,{enabled:false});
 assert.equal((await api('GET',`${path}/runs/${report.jobId}`)).status,'paused');
 await api('POST',`${path}/runs/${report.jobId}/result`,{status:'failed',detail:'Late worker'},409);
 await api('PATCH',`${path}/loops/${policy.id}`,{enabled:true});assert.equal((await sweep())[0].hold,'no new commit since the last pass');
 commit(4);await q("UPDATE specialist_loop_policies SET last_trigger_at=now()-interval '1 hour' WHERE id=$1",[policy.id]);
 assert.match((await sweep())[0].hold,/usage is unknown/);
 const roadmap=(await q('SELECT count(*)::int n FROM roadmap_items WHERE project_id=$1',[project.id])).rows[0].n;assert.equal(roadmap,0);
 assert.equal((await q("SELECT count(*)::int n FROM autopilot_jobs WHERE project_id=$1 AND kind<>'specialist'",[project.id])).rows[0].n,0);
 console.log('PASS: manual proof → persisted policy → real Git host sweep → existing claim → bounded evidence → no replay/cooldown → empty-input no-call → pause/late-result refusal → restart/unknown-usage hold; no work/verdict writes.');
} finally {await new Promise(r=>server.close(r));await pool.end();rmSync(root,{recursive:true,force:true});}
