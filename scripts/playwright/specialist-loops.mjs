// Intercept every policy mutation; never enable or enqueue a live loop.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { loadStackEnv } from '../../hook/stack-post.mjs';
loadStackEnv();
const url=process.argv[2];if(!url)throw Error('Local web URL required');
const browser=await chromium.launch({args:['--no-sandbox']});
try {
 const page=await browser.newPage();await page.addInitScript(token=>localStorage.setItem('stack.token',token),process.env.STACK_TOKEN);
 const policies=[];let writes=0,dryRuns=0;
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  if(path==='/api/agent-profiles')return route.fulfill({json:{profiles:[{key:'stack-reviewer',name:'Fixture Reviewer',enabled:true}],knownTools:[]}});
  if(path.includes('/specialists/loops')){
   if(req.method()==='GET')return route.fulfill({json:policies});
   const b=req.postDataJSON();
   if(path.endsWith('/dry-run')){dryRuns++;assert.equal(b.head,'b'.repeat(40));return route.fulfill({json:{hold:'a successful manual diagnostic is required',usage:{attempts:0,spent:0},reserveTokens:60000}});}
   writes++;
   if(req.method()==='DELETE'){assert.equal(policies[0].enabled,false);policies.splice(0,1);return route.fulfill({json:{ok:true}});}
   if(req.method()==='POST'){assert.equal(b.profileKey,'stack-reviewer');assert.deepEqual(b.paths,['fixture.js']);policies.push({id:'1',name:b.name,profile_key:b.profileKey,enabled:false,interval_minutes:b.intervalMinutes,max_runs_day:b.maxRunsDay,max_tokens_day:b.maxTokensDay,paths:b.paths,stop_reason:'disabled',last_job_id:'123'});return route.fulfill({status:201,json:policies[0]});}
   assert.equal(req.method(),'PATCH');policies[0].enabled=b.enabled;policies[0].stop_reason=b.enabled?'awaiting host eligibility check':'disabled';return route.fulfill({json:policies[0]});
  }
  if(path.includes('/specialists/runs/123'))return route.fulfill({json:{id:'123',status:'failed',detail:'Diagnostic timed out.',result:null}});
  if(req.method()!=='GET')return route.abort();return route.continue();
 });
 await page.goto(url+'/#/p/stack/loops');
 await page.getByText('No observation policies yet.',{exact:false}).waitFor();
 await page.getByRole('button',{name:'New observation policy'}).click();
 await page.getByLabel('Policy name').fill('Fixture observation');
 await page.getByLabel('Specialist profile',{exact:true}).selectOption('stack-reviewer');
 await page.getByLabel('Literal file paths',{exact:false}).fill('fixture.js');
 await page.getByRole('button',{name:'Create disabled policy'}).click();
 await page.getByRole('button',{name:'Enable observations'}).waitFor();assert.equal(policies[0].enabled,false);
 await page.getByRole('button',{name:'Evaluate eligibility'}).click();
 await page.getByLabel('Base commit').fill('a'.repeat(40));await page.getByLabel('Head commit').fill('b'.repeat(40));
 await page.getByRole('button',{name:'Evaluate without running'}).click();
 await page.getByRole('status').filter({hasText:'manual diagnostic'}).waitFor();assert.equal(writes,1);assert.equal(dryRuns,1);
 await page.getByRole('button',{name:'Enable observations'}).click();await page.getByRole('button',{name:'Disable observations'}).click();await page.getByRole('button',{name:'Enable observations'}).waitFor();
 await page.getByRole('button',{name:'Read latest run #123'}).click();await page.getByText('No completed diagnostic evidence.').waitFor();
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.getByRole('button',{name:'Remove disabled policy'}).click();await page.getByText('No observation policies yet.',{exact:false}).waitFor();
 console.log('PASS: real-policy UI contracts, disabled creation, mutation-free simulation, explicit toggle, absent evidence and narrow layout (all writes intercepted).');
} finally {await browser.close();}
