// #361 — the TAB AGENTS' registry and gate, tested against the real module.
//
//   node server/test/agents.test.mjs      # exits non-zero on any failure
//
// No database and no framework. The restriction this item is about — each
// agent works in ONE tab and cannot run another's ops — is enforced by
// agentClient()'s op binding and by gateDecision(), and both were written pure
// so that this file can exercise them. A rule that can only be checked against
// a live Postgres is a rule that never gets checked; this one is the whole
// feature, so it gets checked.
import {
  AGENTS, agentClient, agentForOp, agentByKey, agentConfigShape, agentPreamble,
  agentShape, gateDecision, cleanAgentModel, cleanGuidance, opSpec,
} from '../src/agents.js';

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${ok ? '' : `  (want ${JSON.stringify(want)})`}`);
};
const rejects = async (label, fn, match) => {
  let msg = '';
  try { await fn(); } catch (e) { msg = e.message; }
  const ok = msg !== '' && (!match || msg.includes(match));
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${msg || '(did not throw)'}`);
};

console.log('--- the registry ---');
check('three agents', AGENTS.map((a) => a.key), ['auditor', 'curator', 'polaris']);
check('one tab each, no tab shared', new Set(AGENTS.map((a) => a.tab)).size, AGENTS.length);
check('every agent owns at least one op', AGENTS.every((a) => a.ops.length > 0), true);
// The op → agent map is built at import time and throws on a duplicate, so a
// second owner for an op cannot even load. This asserts the resolved mapping.
check('audit belongs to the Auditor', agentForOp('audit').key, 'auditor');
check('cleanup belongs to the Curator', agentForOp('cleanup').key, 'curator');
check('judge belongs to Polaris', agentForOp('judge').key, 'polaris');
check('an op nobody owns resolves to nothing', agentForOp('nonsense'), null);
check('the tabs are the project tabs', AGENTS.map((a) => a.tab), ['quality', 'roadmap', 'futures']);
// Every op the ROUTES call has to exist here, or the call throws at runtime.
// This list is the routes' side of the contract, written out so a renamed op
// fails here rather than the first time somebody presses the button.
const WIRED = {
  auditor: ['audit', 'auditprompt'],
  curator: ['titler', 'assist', 'cleanup', 'reviewbrief', 'refinedraft'],
  polaris: ['judge', 'cluster', 'converge'],
};
for (const [key, ops] of Object.entries(WIRED)) {
  check(`${key}'s ops are exactly what its routes call`, agentByKey(key).ops.map((o) => o.op), ops);
}

console.log('\n--- the restriction: an agent cannot run another tab\'s op ---');
const auditor = agentClient('auditor');
const curator = agentClient('curator');
const polaris = agentClient('polaris');
// These reject BEFORE any database read — the binding is checked first, so the
// refusal does not depend on a reachable Postgres.
await rejects('the Auditor cannot run the Curator\'s cleanup', () => auditor.gate('cleanup'), 'Curator');
await rejects('the Auditor cannot run Polaris\'s judge', () => auditor.gate('judge'), 'Polaris');
await rejects('the Curator cannot run the audit', () => curator.gate('audit'), 'Auditor');
await rejects('Polaris cannot run the assist', () => polaris.gate('assist'), 'Curator');
await rejects('nobody can run an op that does not exist', () => curator.ask('sudo', 'x'), 'not an op');
// And the message names the tab, so the exception says where the op belongs.
await rejects('the refusal names the owning tab', () => auditor.gate('titler'), 'Roadmap tab');

console.log('\n--- the gate ---');
const ON = { enabled: true, model: '', guidance: '', opsOff: [] };
const A = agentByKey('auditor');
const spec = (key, op) => agentByKey(key).ops.find((o) => o.op === op);
check('on, with the host up, may act', gateDecision(A, spec('auditor', 'audit'), ON, true), null);
check('off refuses with 409',
  gateDecision(A, spec('auditor', 'audit'), { ...ON, enabled: false }, true)?.httpStatus, 409);
check('off says which agent',
  gateDecision(A, spec('auditor', 'audit'), { ...ON, enabled: false }, true)?.message.includes('Auditor'), true);
check('an op switched off refuses with 409',
  gateDecision(A, spec('auditor', 'audit'), { ...ON, opsOff: ['audit'] }, true)?.httpStatus, 409);
check('...and only that op',
  gateDecision(A, spec('auditor', 'auditprompt'), { ...ON, opsOff: ['audit'] }, true), null);
// #364 — the backend is the HOST now, not a Gemini key: the agents run
// `claude -p` through the terminal daemon's uplink. With the daemon down there
// is no second backend to fall through to, so the op refuses and says which
// thing is missing rather than answering emptily.
check('no host refuses a model-backed op with 503',
  gateDecision(A, spec('auditor', 'audit'), ON, false)?.httpStatus, 503);
check('...and the refusal names the host, not a key',
  gateDecision(A, spec('auditor', 'audit'), ON, false)?.message.includes('host daemon'), true);
// The Auditor's deep-audit prompt asks no model at all — it composes the prompt
// for a Claude session the human drives — so an offline host must not refuse
// it. It is the reason the whole card is still worth rendering with the daemon
// down, and it was the reason it was worth rendering without a key before.
check('no host still allows the model-less op',
  gateDecision(A, spec('auditor', 'auditprompt'), ON, false), null);
// Order matters: switched off AND host-down must read as switched off. The
// owner who turned it off should not be sent to investigate the daemon.
check('off beats host-down in the message',
  gateDecision(A, spec('auditor', 'audit'), { ...ON, enabled: false }, false)?.httpStatus, 409);
check('the model-less op still obeys the agent switch',
  gateDecision(A, spec('auditor', 'auditprompt'), { ...ON, enabled: false }, false)?.httpStatus, 409);

console.log('\n--- the config row ---');
// A MISSING ROW MEANS ON. Same direction as readSettings(): these agents are
// how three tabs already work, so an unwritten row must degrade to working.
check('missing row = enabled', agentConfigShape(A, undefined).enabled, true);
check('missing row = no model override', agentConfigShape(A, undefined).model, '');
check('missing row = nothing switched off', agentConfigShape(A, undefined).opsOff, []);
check('an explicit false is honoured', agentConfigShape(A, { enabled: false }).enabled, false);
// A stale op name (one renamed since the row was written) must not silently
// disable something else — ops_off is filtered to the agent's own ops.
check('a foreign op name in ops_off is ignored',
  agentConfigShape(A, { enabled: true, ops_off: ['cleanup', 'audit', 'gone'] }).opsOff, ['audit']);
// The model alias is spliced into an argv on the HOST now (#364), which raises
// the stakes on this guard from "a bad URL path" to "a bad exec argument".
check('a model with a space is rejected', cleanAgentModel('sonnet 4'), '');
check('a model with a shell metacharacter is rejected', cleanAgentModel('sonnet;rm -rf /'), '');
check('a flag-looking model is rejected', cleanAgentModel('--dangerously-skip-permissions'), '');
check('a path traversal is rejected', cleanAgentModel('../../secret'), '');
check('a real alias passes', cleanAgentModel('sonnet'), 'sonnet');
check('a dated model id passes', cleanAgentModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001');
check('guidance is capped', cleanGuidance('x'.repeat(5000)).length, 1200);

console.log('\n--- the preamble ---');
const pre = agentPreamble(A, 'weigh mobile breakage heavily');
check('names the agent', pre.includes('You are Auditor'), true);
check('names the tab it may work in', pre.includes('Quality tab'), true);
check('tells it work elsewhere is another agent\'s', pre.includes('belongs to another agent'), true);
check('carries the owner\'s steer', pre.includes('weigh mobile breakage heavily'), true);
check('no steer, no steer block', agentPreamble(A, '').includes('STANDING GUIDANCE'), false);
// The preamble is a PREFIX, never a suffix: every op template ends on
// "Respond with ONLY this JSON: {…}", and anything after that is read as part
// of the shape instruction.
const composed = agentPreamble(A, 'x') + 'Respond with ONLY this JSON:\n{ "a": 1 }';
check('the op prompt stays last', composed.endsWith('{ "a": 1 }'), true);

console.log('\n--- the shape the room reads ---');
const shaped = agentShape({ agent: A, config: agentConfigShape(A, { enabled: true, ops_off: ['audit'] }) });
check('ops carry their own switch', shaped.ops.map((o) => [o.op, o.enabled]), [['audit', false], ['auditprompt', true]]);
check('the model-less op is marked', opSpec('auditprompt').model, false);
check('...and the shape reports it to the room', 
  agentShape({ agent: A, config: agentConfigShape(A, undefined) }).ops.find((o) => o.op === 'auditprompt').needsModel, false);
check('the tab rides along', shaped.tabLabel, 'Quality');
// The room may not move an agent between tabs, so nothing writable is derived
// from the tab: it is reported, never patched. (routes/agents.js accepts only
// enabled / model / guidance / opsOff.)
check('every registry field the room shows is present',
  ['key', 'name', 'tab', 'tabLabel', 'blurb', 'remit'].every((k) => k in shaped), true);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
