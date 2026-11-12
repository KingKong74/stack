import assert from 'node:assert/strict';
import { loopUsage, specialistLoopHold } from '../src/specialist-loops.js';
const policy = { enabled: true, interval_minutes: 60, max_runs_day: 2, max_tokens_day: 150000 };
const ctx = { head: 'a'.repeat(40), connected: true, manualProof: true, usage: { spent: 0, attempts: 0, active: false } };
assert.equal(specialistLoopHold(policy, ctx), '');
for (const [patch, expected] of [[{ connected: false }, /unknown/], [{ manualProof: false }, /manual/], [{ head: null }, /revision/], [{ globalHold: 'quiet hours' }, /quiet/], [{ usage: { spent: null } }, /unknown/], [{ usage: { spent: 0, attempts: 2 } }, /run cap/], [{ usage: { spent: 100000, attempts: 1 } }, /token budget/], [{ failures: 3 }, /failures/]]) assert.match(specialistLoopHold(policy, { ...ctx, ...patch }), expected);
assert.equal(specialistLoopHold({ ...policy, enabled: false }, ctx), 'disabled');
assert.match(specialistLoopHold({ ...policy, last_head: ctx.head }, ctx), /no new commit/);
assert.equal(specialistLoopHold({ ...policy, last_trigger_at: new Date().toISOString() }, ctx), 'cooldown');
assert.equal(loopUsage([{ status: 'failed', advice: null }]).spent, null);
assert.equal(loopUsage([{ status: 'done', advice: JSON.stringify({ skipped: true }) }]).spent, 0);
assert.equal(loopUsage([{ status: 'done', advice: JSON.stringify({ usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } }) }]).spent, 100);
assert.equal(loopUsage([{ status: 'running' }]).active, true);
console.log('PASS: disabled/unknown/manual-proof/quiet/cooldown/dedup/failure/run/token holds and honest usage accounting.');

for (const usage of [{ input_tokens: 10 }, { input_tokens: -1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, { input_tokens: '10', output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]) assert.equal(loopUsage([{status:'done', advice:JSON.stringify({usage})}]).spent, null);
