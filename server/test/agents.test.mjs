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
check('the agents', AGENTS.map((a) => a.key),
  ['auditor', 'curator', 'foreman', 'merger', 'scribe', 'polaris', 'drafter']);
check('one surface each, no surface shared', new Set(AGENTS.map((a) => a.tab)).size, AGENTS.length);
// Every agent has a SURFACE it can act through — ops, a console, or both. Not
// "at least one op": the Auditor has none since its templated bug audit went,
// and its whole surface is the live session on the Quality tab. An agent with
// neither would be a card in the room that controls nothing.
check('every agent can act somewhere', AGENTS.every((a) => a.ops.length > 0 || a.console), true);
check('the op-less one is the Auditor, and only it',
  AGENTS.filter((a) => a.ops.length === 0).map((a) => a.key), ['auditor']);
// The op → agent map is built at import time and throws on a duplicate, so a
// second owner for an op cannot even load. This asserts the resolved mapping.
// `audit` resolves to NOBODY now — a retired op must not keep a home, or a call
// site left behind would go on working under an agent that no longer offers it.
check('the retired audit op belongs to nobody', agentForOp('audit'), null);
check('cleanup belongs to the Curator', agentForOp('cleanup').key, 'curator');
check('judge belongs to Polaris', agentForOp('judge').key, 'polaris');
check('mergeplan belongs to the Merge agent', agentForOp('mergeplan').key, 'merger');
check('readchange belongs to the Foreman', agentForOp('readchange').key, 'foreman');
// #375 — these two were the CURATOR's until the Foreman existed. The move is
// the assertion: their only surface is the Review room, so the Review room's
// switch is what must govern them.
check('the reviewer\'s brief moved to the Foreman', agentForOp('reviewbrief').key, 'foreman');
check('...and so did the refine draft', agentForOp('refinedraft').key, 'foreman');
check('an op nobody owns resolves to nothing', agentForOp('nonsense'), null);
// Three project tabs and two Mission Control rooms (#364, #375). A room-bound
// agent is bound exactly like a tab-bound one — the binding is what the item is
// about, and it does not care which kind of surface it names.
check('the surfaces', AGENTS.map((a) => a.tab),
  ['quality', 'roadmap', 'review', 'merge', 'instructions', 'futures', 'workbench']);
// Every op the ROUTES call has to exist here, or the call throws at runtime.
// This list is the routes' side of the contract, written out so a renamed op
// fails here rather than the first time somebody presses the button.
const WIRED = {
  // NO OPS. Both of the Auditor's went to the same place: the deep-audit prompt
  // (#379) and then the bug audit itself, each a template standing in for an
  // investigation the tab's live session does directly. Nothing routes to this
  // agent any more — its model, guidance and switch govern that session.
  auditor: [],
  // 'arrange' reads the timeline and proposes an ORDER — the one thing the
  // Arrange panel's arithmetic structurally cannot do. Routes: POST /roadmap/arrange.
  // 'allocate' is its other half: WHERE an untagged row belongs, not when it
  // runs. Routes: POST /roadmap/allocate.
  curator: ['titler', 'assist', 'cleanup', 'arrange', 'allocate'],
  foreman: ['readchange', 'triagequeue', 'reviewbrief', 'refinedraft'],
  merger: ['mergeplan'],
  polaris: ['judge', 'cluster', 'converge'],
  // #379 — ONE op for the canvas's seven ✧ buttons. Routes: POST
  // /projects/:slug/workbench/ops, which gates on it and then makes its own
  // Gemini call (it wants the answer field by field and honours the canvas's
  // model picker). Two of the button names would collide with other agents'
  // ops if they were registered separately — which is the registry saying
  // correctly that they are one surface, not seven capabilities.
  // #418 — 'sharpen' is the SECOND, and it is not an eighth canvas button: it
  // runs before a card exists (the corner ＋'s Thought composer, whose save
  // files the note this canvas then draws), reads loose text and writes
  // nothing. Routes: POST /projects/:slug/workbench/sharpen.
  drafter: ['canvas', 'sharpen'],
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
// An agent with NO ops refuses everything, including the op it used to own.
// That is the shape of a retired capability: not a switched-off op somebody can
// turn back on, but a name no client resolves at all.
await rejects('the Auditor cannot run its own retired audit', () => auditor.gate('audit'), 'not an op');
await rejects('...and neither can anybody else', () => curator.gate('audit'), 'not an op');
await rejects('Polaris cannot run the assist', () => polaris.gate('assist'), 'Curator');
// The Merge agent reads diffs across every project; it must not be able to
// reach a project tab's op just because its remit is the widest.
await rejects('the Merge agent cannot run the titler', () => agentClient('merger').gate('titler'), 'Curator');
await rejects('...nor the Curator\'s cleanup', () => agentClient('merger').gate('cleanup'), 'Curator');
await rejects('and nobody else can run its mergeplan', () => auditor.gate('mergeplan'), 'Merge agent');
// #375 — the Foreman reads changes across every project, so the same rule that
// bounds the Merge agent has to bound it: the widest remit is still a remit.
const foreman = agentClient('foreman');
await rejects('the Foreman cannot judge a future', () => foreman.gate('judge'), 'Polaris');
await rejects('...nor tidy the board', () => foreman.gate('cleanup'), 'Curator');
await rejects('...nor read a merge plan', () => foreman.gate('mergeplan'), 'Merge agent');
// And the Curator can no longer reach what it used to own — the move is real,
// not a relabelling. A stale call site fails here rather than at the button.
await rejects('the Curator can no longer write the brief', () => curator.gate('reviewbrief'), 'Foreman');
await rejects('...nor draft the refinement', () => curator.gate('refinedraft'), 'Foreman');
await rejects('the refusal names the Review room', () => curator.gate('readchange'), 'the Review room');
await rejects('nobody can run an op that does not exist', () => curator.ask('sudo', 'x'), 'not an op');
// And the message names the surface, so the exception says where the op
// belongs — in the word that surface actually goes by (#375).
await rejects('the refusal names the owning tab', () => auditor.gate('titler'), 'the Roadmap tab');

console.log('\n--- the gate ---');
const ON = { enabled: true, model: '', guidance: '', opsOff: [] };
const A = agentByKey('auditor');
// The gate is read on the CURATOR: it is the agent with several ops, and the
// Auditor has none to gate at all now.
const C = agentByKey('curator');
const spec = (key, op) => agentByKey(key).ops.find((o) => o.op === op);
check('on, with the host up, may act', gateDecision(C, spec('curator', 'cleanup'), ON, true), null);
check('off refuses with 409',
  gateDecision(C, spec('curator', 'cleanup'), { ...ON, enabled: false }, true)?.httpStatus, 409);
check('off says which agent',
  gateDecision(C, spec('curator', 'cleanup'), { ...ON, enabled: false }, true)?.message.includes('Curator'), true);
check('an op switched off refuses with 409',
  gateDecision(C, spec('curator', 'cleanup'), { ...ON, opsOff: ['cleanup'] }, true)?.httpStatus, 409);
check('...and only that op',
  gateDecision(C, spec('curator', 'assist'), { ...ON, opsOff: ['cleanup'] }, true), null);
// #364 — the backend is the HOST now, not a Gemini key: the agents run
// `claude -p` through the terminal daemon's uplink. With the daemon down there
// is no second backend to fall through to, so the op refuses and says which
// thing is missing rather than answering emptily.
check('no host refuses a model-backed op with 503',
  gateDecision(C, spec('curator', 'cleanup'), ON, false)?.httpStatus, 503);
check('...and the refusal names the host, not a key',
  gateDecision(C, spec('curator', 'cleanup'), ON, false)?.message.includes('host daemon'), true);
// EVERY op needs its backend now (#379). The Auditor's deep-audit prompt was
// the one that didn't — it composed a hand-off for a Claude session the human
// opened elsewhere, which is what the tab's own live session does properly —
// and the `model: false` flag went out with it rather than staying as a branch
// nothing takes. This asserts the registry carries no exemption left over.
check('no op is exempt from its backend', AGENTS.every((a) => a.ops.every((o) => o.model !== false)), true);
// Order matters: switched off AND host-down must read as switched off. The
// owner who turned it off should not be sent to investigate the daemon.
check('off beats host-down in the message',
  gateDecision(C, spec('curator', 'cleanup'), { ...ON, enabled: false }, false)?.httpStatus, 409);

// A GEMINI-BACKED OP ON A CLAUDE-BACKED AGENT (the Scribe's quick passes).
// The point of the flag is that one surface keeps one switch even when its two
// halves run on different backends — so the switch still governs both, and only
// the REFUSAL differs. It has to name the right backend: sending the owner to
// restart a daemon that was never involved is the whole failure this prevents.
const S = agentByKey('scribe');
check('a gemini op is gated by the same agent switch',
  gateDecision(S, spec('scribe', 'rulescan'), { ...ON, enabled: false }, true)?.httpStatus, 409);
check('an unavailable gemini names the key, not the daemon',
  gateDecision(S, spec('scribe', 'rulescan'), ON, false)?.message.includes('GEMINI_API_KEY'), true);
check('...and never blames the host daemon',
  gateDecision(S, spec('scribe', 'rulescan'), ON, false)?.message.includes('host daemon'), false);
check('the Scribe\'s claude op still names the host',
  gateDecision(S, spec('scribe', 'ruledraft'), ON, false)?.message.includes('host daemon'), true);
check('backend defaults to claude when unstated',
  agentShape({ agent: S, config: agentConfigShape(S, undefined) })
    .ops.find((o) => o.op === 'ruledraft').backend, 'claude');
check('and is reported for the gemini op',
  agentShape({ agent: S, config: agentConfigShape(S, undefined) })
    .ops.find((o) => o.op === 'rulescan').backend, 'gemini');

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
  agentConfigShape(C, { enabled: true, ops_off: ['cleanup', 'audit', 'gone'] }).opsOff, ['cleanup']);
// An op-less agent filters EVERYTHING out, including a row left behind by the
// op it used to have — a stale ops_off must never resurrect a retired name.
check('an op-less agent switches nothing off',
  agentConfigShape(A, { enabled: true, ops_off: ['audit'] }).opsOff, []);
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
const shaped = agentShape({ agent: A, config: agentConfigShape(A, undefined) });
// The room has to survive an empty op list — an agent whose surface is its
// console draws no op drawer rather than an empty one.
check('an op-less agent shapes to an empty list, not to nothing', shaped.ops, []);
check('ops carry their own switch',
  agentShape({ agent: C, config: agentConfigShape(C, { enabled: true, ops_off: ['cleanup'] }) })
    .ops.map((o) => [o.op, o.enabled]),
  [['titler', true], ['assist', true], ['cleanup', false], ['arrange', true], ['allocate', true]]);
// An op switched off on ONE agent leaves another agent's alone — the shape is
// read per agent, and ops_off is that agent's column.
check('...and only that agent\'s',
  agentShape({ agent: C, config: agentConfigShape(C, { enabled: true, ops_off: ['cleanup'] }) })
    .ops.map((o) => o.enabled), [true, true, false, true, true]);
check('an op nobody registered has no spec', opSpec('auditprompt'), null);
check('the tab rides along', shaped.tabLabel, 'Quality');
// #375 — and what KIND of surface it is, so no card says "Merge tab".
check('a tab agent knows it is a tab', shaped.surface, 'tab');
check('a room agent knows it is a room', agentByKey('foreman').surface, 'room');
// The room may not move an agent between tabs, so nothing writable is derived
// from the tab: it is reported, never patched. (routes/agents.js accepts only
// enabled / model / guidance / opsOff.)
check('every registry field the room shows is present',
  ['key', 'name', 'tab', 'tabLabel', 'surface', 'blurb', 'remit'].every((k) => k in shaped), true);

console.log('\n--- the console (#379): an agent\'s live session ---');
// A console is NOT an op. Nothing routes to it, nothing asks it for JSON, and
// putting it in `ops` would have made `ask()` able to reach it.
check('no agent lists a console among its ops',
  AGENTS.some((a) => a.ops.some((o) => /console|session|terminal/i.test(o.op))), false);
// Only the four PROJECT tabs whose agents work on something you can point at.
// A room-bound agent spans every project and has no one checkout to open in.
check('which agents have one', AGENTS.filter((a) => a.console).map((a) => a.key),
  ['auditor', 'curator', 'polaris', 'drafter']);
check('none of the room-bound agents does',
  AGENTS.filter((a) => a.surface === 'room').every((a) => !a.console), true);
// Same direction as everything else here: a missing row — and a row written
// before the column existed — reads as ON.
check('missing row = the console is on', agentConfigShape(A, undefined).consoleOff, false);
check('a row from before the column = on', agentConfigShape(A, { enabled: true }).consoleOff, false);
check('an explicit switch-off is honoured', agentConfigShape(A, { console_off: true }).consoleOff, true);
// The room reads the POSITIVE, and null for an agent that has none — a switch
// drawn for a session that does not exist is worse than no row at all.
check('the shape reports it on',
  agentShape({ agent: A, config: agentConfigShape(A, undefined) }).console.enabled, true);
check('...and off when the owner said so',
  agentShape({ agent: A, config: agentConfigShape(A, { enabled: true, console_off: true }) }).console.enabled, false);
check('a console-less agent reports null',
  agentShape({ agent: agentByKey('merger'), config: agentConfigShape(agentByKey('merger'), undefined) }).console, null);
// Switching the console off must not touch the ✧ ops, and switching the AGENT
// off is a separate statement — that is why the console has a switch at all.
check('the console switch leaves the ops alone',
  agentShape({ agent: C, config: agentConfigShape(C, { enabled: true, console_off: true }) })
    .ops.every((o) => o.enabled), true);
// …and an agent with no ops still has its session: the console is the half that
// survived, so a console read that depended on an op would report it as gone.
check('an op-less agent still reports its console',
  agentShape({ agent: A, config: agentConfigShape(A, undefined) }).console.enabled, true);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
