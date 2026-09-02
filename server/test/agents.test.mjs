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
// There were seven. The cull took the Foreman, the Merge agent, Polaris, the
// Scribe, the Drafter and then the AUDITOR — each WITH its surface, which is
// one surface, one switch in both directions. The Auditor is the sharpest case
// of it: its templated bug audit had already retired, so the live session on
// the Quality tab was the whole of what it was, and culling the tab consoles
// left it governing nothing.
check('the agents', AGENTS.map((a) => a.key), ['curator']);
check('one surface each, no surface shared', new Set(AGENTS.map((a) => a.tab)).size, AGENTS.length);
// Every agent has a SURFACE it can act through, and `ops` is now the whole of
// what that can mean: the second half — a `console`, the agent's own live
// session on its tab — is culled, so an agent with no ops is an agent that
// cannot act at all and must not be in the registry.
check('every agent can act somewhere', AGENTS.every((a) => a.ops.length > 0), true);
check('no agent carries a console any more', AGENTS.some((a) => a.console), false);
check('the Auditor is gone from the registry', agentByKey('auditor'), null);
// The op → agent map is built at import time and throws on a duplicate, so a
// second owner for an op cannot even load. This asserts the resolved mapping.
// `audit` resolves to NOBODY now — a retired op must not keep a home, or a call
// site left behind would go on working under an agent that no longer offers it.
check('the retired audit op belongs to nobody', agentForOp('audit'), null);
check('cleanup belongs to the Curator', agentForOp('cleanup').key, 'curator');
// A CULLED AGENT'S OPS BELONG TO NOBODY — the same rule the retired `audit` op
// is held to just above, and the reason it matters more here: these four names
// were live call sites until the cull, so an op that kept a home would let a
// stale caller go on working under an agent that no longer offers the surface.
for (const op of ['judge', 'cluster', 'converge', 'mergeplan', 'readchange',
  'triagequeue', 'ruledraft', 'rulescan', 'refinedraft']) {
  check(`the culled ${op} belongs to nobody`, agentForOp(op), null);
}
// `reviewbrief` is the one that did NOT go. It moved to the Foreman in #375
// because the Review room was its only SURFACE, but the autopilot composes the
// same brief without any room (server/src/reviewbrief.js), so the op outlived
// the agent and is unowned rather than absent — the prompt is still built.
check('an op nobody owns resolves to nothing', agentForOp('nonsense'), null);
// Every survivor is a project tab; the two room-bound agents went with their
// rooms. `surface` stays on the shape even so — it is the agent's identity, and
// a room-bound agent coming back must be able to say so.
check('the surfaces', AGENTS.map((a) => a.tab), ['roadmap']);
check('and all of them are tabs now', AGENTS.every((a) => a.surface === 'tab'), true);
// Every op the ROUTES call has to exist here, or the call throws at runtime.
// This list is the routes' side of the contract, written out so a renamed op
// fails here rather than the first time somebody presses the button.
const WIRED = {
  // 'arrange' reads the timeline and proposes an ORDER; 'allocate' is its other
  // half — WHERE an untagged row belongs, not when it runs. Routes:
  // POST /roadmap/arrange, /allocate. Neither has a CLIENT any more, nor does
  // 'cleanup': their surfaces are culled and the routes are kept unsurfaced, so
  // this list is what still pins their switches. 'titler' and 'assist' in the
  // item modal are the Curator's LIVE surface, and the reason it survived the
  // cull that took the Auditor: an agent governing nothing leaves.
  curator: ['titler', 'assist', 'cleanup', 'arrange', 'allocate'],
};
for (const [key, ops] of Object.entries(WIRED)) {
  check(`${key}'s ops are exactly what its routes call`, agentByKey(key).ops.map((o) => o.op), ops);
}

console.log('\n--- the restriction: an agent cannot run another tab\'s op ---');
const curator = agentClient('curator');
// A CULLED AGENT CANNOT BE BOUND AT ALL. This is the strongest form of the
// restriction and the reason a culled agent leaves the registry rather than
// lingering switched off: a route left behind does not get a client that
// refuses politely, it gets an exception at the bind.
await rejects('nothing can bind to the culled Auditor', () => agentClient('auditor'), 'Unknown agent');
// These reject BEFORE any database read — the binding is checked first, so the
// refusal does not depend on a reachable Postgres.
await rejects('nobody can run the retired audit', () => curator.gate('audit'), 'not an op');
// A CULLED AGENT'S OP IS NOT A SWITCHED-OFF OP — it is a name nothing
// resolves, exactly like the retired `audit`. This is the assertion that stops
// a leftover call site quietly finding a new owner: the refusal has to be
// "not an op", never another agent's name.
for (const op of ['judge', 'mergeplan', 'readchange', 'rulescan', 'canvas', 'sharpen']) {
  await rejects(`nobody can run the culled ${op}`, () => curator.gate(op), 'not an op');
}
await rejects('nobody can run an op that does not exist', () => curator.ask('sudo', 'x'), 'not an op');
// And the message names the surface an op DOES belong to, in the word that
// surface goes by (#375) — asserted through a client bound to the one agent
// there is, since a foreign op now means a culled one.
await rejects('the refusal names the op\'s absence, not a home',
  () => curator.gate('audit'), 'not an op of any tab agent');

console.log('\n--- the gate ---');
const ON = { enabled: true, model: '', guidance: '', opsOff: [] };
const C = agentByKey('curator');
// A SYNTHETIC op-less agent. Nothing in the registry is op-less now — that is
// the rule the Auditor's cull enforced — but the shapes below are pure and
// have to stay correct for one, or the next agent to lose its last op takes
// the room down with it instead of simply reading as empty.
const A = { ...C, key: 'opless', name: 'Opless', ops: [] };
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
// EVERY op needs its backend. The Auditor's deep-audit prompt was the one that
// didn't — it composed a hand-off for a Claude session the human opened
// elsewhere — and the `model: false` flag went out with it rather than staying
// as a branch nothing takes. This asserts no exemption is left over.
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
const S = agentByKey('curator');
// The Scribe carried this pair until the cull; the CURATOR has the same shape
// — `titler` on Claude, `arrange` on Gemini — so the property is still pinned
// by a live agent rather than by the one that happened to prove it first.
check('a gemini op is gated by the same agent switch',
  gateDecision(S, spec('curator', 'arrange'), { ...ON, enabled: false }, true)?.httpStatus, 409);
check('an unavailable gemini names the key, not the daemon',
  gateDecision(S, spec('curator', 'arrange'), ON, false)?.message.includes('GEMINI_API_KEY'), true);
check('...and never blames the host daemon',
  gateDecision(S, spec('curator', 'arrange'), ON, false)?.message.includes('host daemon'), false);
check('the Curator\'s claude op still names the host',
  gateDecision(S, spec('curator', 'titler'), ON, false)?.message.includes('host daemon'), true);
check('backend defaults to claude when unstated',
  agentShape({ agent: S, config: agentConfigShape(S, undefined) })
    .ops.find((o) => o.op === 'titler').backend, 'claude');
check('and is reported for the gemini op',
  agentShape({ agent: S, config: agentConfigShape(S, undefined) })
    .ops.find((o) => o.op === 'arrange').backend, 'gemini');

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
const pre = agentPreamble(C, 'weigh mobile breakage heavily');
check('names the agent', pre.includes('You are Curator'), true);
check('names the tab it may work in', pre.includes('Roadmap tab'), true);
check('tells it work elsewhere is another agent\'s', pre.includes('belongs to another agent'), true);
check('carries the owner\'s steer', pre.includes('weigh mobile breakage heavily'), true);
check('no steer, no steer block', agentPreamble(C, '').includes('STANDING GUIDANCE'), false);
// The preamble is a PREFIX, never a suffix: every op template ends on
// "Respond with ONLY this JSON: {…}", and anything after that is read as part
// of the shape instruction.
const composed = agentPreamble(C, 'x') + 'Respond with ONLY this JSON:\n{ "a": 1 }';
check('the op prompt stays last', composed.endsWith('{ "a": 1 }'), true);

console.log('\n--- the shape the room reads ---');
const shaped = agentShape({ agent: A, config: agentConfigShape(A, undefined) });
// A reader has to survive an empty op list — it draws no op drawer rather than
// an empty one, and never throws on the way there.
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
check('the tab rides along', shaped.tabLabel, 'Roadmap');
// #375 — and what KIND of surface it is, so no card says "Merge tab". Every
// survivor is a tab; the field is kept rather than collapsed because it is the
// agent's identity, and a room-bound agent coming back must be able to say so
// without this having to be re-invented.
check('a tab agent knows it is a tab', shaped.surface, 'tab');
check('every survivor names a real kind of surface',
  AGENTS.every((a) => a.surface === 'tab' || a.surface === 'room'), true);
// The room may not move an agent between tabs, so nothing writable is derived
// from the tab: it is reported, never patched. (routes/agents.js accepts only
// enabled / model / guidance / opsOff.)
check('every registry field the room shows is present',
  ['key', 'name', 'tab', 'tabLabel', 'surface', 'blurb', 'remit'].every((k) => k in shaped), true);

console.log('\n--- the consoles are culled ---');
// A tab agent's console was its own live Claude session in the project's
// checkout, spawned with a server-composed system prompt and drawn on the
// agent's tab. It is gone — the field, its `console_off` switch, the prime and
// the launcher — so `ops` is once again the whole of what an agent can do.
check('the shape offers no console', 'console' in shaped, false);
check('nothing is left in the registry to switch',
  AGENTS.every((a) => a.console === undefined), true);
// And the switch is gone from the config row too: `console_off` is left in the
// database (the column costs nothing and holds what the owner last chose), but
// nothing reads it, so a row carrying one must shape exactly like a row without.
check('a stale console_off in the row changes nothing',
  agentConfigShape(C, { enabled: true, console_off: true }),
  agentConfigShape(C, { enabled: true }));
// A console was never an op, which is what stopped ask() from reaching it.
// Kept as the rule rather than deleted with the feature: whatever a session
// comes back as, it must not arrive as a name in the op map.
check('no agent lists a session among its ops',
  AGENTS.some((a) => a.ops.some((o) => /console|session|terminal/i.test(o.op))), false);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
