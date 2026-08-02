// THE TAB AGENTS (#361) — Stack's three in-app specialists, each one bound to
// a single project tab.
//
//   Auditor  · Quality tab  — reads the app and reports suspected bugs
//   Curator  · Roadmap tab  — shapes what is on the board and writes it up
//   Polaris  · Futures tab  — judges, themes and converges the idea funnel
//
// Before this file the same three jobs existed as eight loose Gemini routes,
// each one opening `if (!geminiEnabled()) 503` and calling askGemini directly.
// Nothing named them, nothing bounded them and nothing could switch one off
// without switching off every AI surface in the app at once. This module is
// the registry that gives them identities and the ONE choke point they all go
// through.
//
// **The restriction is structural, not a comment.** A route does not call
// `askAgent(op)` with whatever op string it likes: it binds ONCE to its agent
// (`const auditor = agentClient('auditor')`) and every call goes through that
// client, which throws if the op is not in that agent's list. So the Quality
// route physically cannot run the Curator's board cleanup, and a later session
// that wires one up gets an exception rather than a silent cross-tab agent.
// `server/test/agents.test.mjs` pins that: it is the whole point of the item.
//
// Two rules inherited from the rest of the codebase, and both matter here:
//   • **Gemini annotates, the human disposes.** Nothing an agent returns writes
//     tracker state, with the one sanctioned exception the Auditor already had
//     (findings land in the review INBOX as suggestions, source 'hook').
//   • **A missing config row means ON.** Same direction as readSettings(): the
//     agents are how several tabs already work, so a fresh deploy — or a row
//     that has never been written — must degrade to working, not to a silently
//     dead ✧ button. Only an explicit switch-off turns one off.

import { q } from './db.js';
import { askGemini, geminiEnabled } from './gemini.js';

// The Gemini model names an agent may be pinned to. Free-tier quotas are PER
// MODEL, so pointing a heavy agent (the Auditor reads a whole page) at its own
// model is how one agent stops eating another's quota. '' = whatever the
// server's GEMINI_MODEL says, which is the default and the sane answer.
export const AGENT_MODELS = [
  { model: '', label: 'Server default' },
  { model: 'gemini-2.5-flash', label: 'Flash 2.5' },
  { model: 'gemini-2.5-pro', label: 'Pro 2.5' },
  { model: 'gemini-flash-lite-latest', label: 'Flash Lite' },
];

// Same shape of guard as settings.cleanModelAlias: a safe freeform charset
// rather than an enum, so a model newer than the catalogue still works, but
// nothing with whitespace or shell metacharacters ever reaches a URL path.
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
export const cleanAgentModel = (v) => {
  const s = String(v ?? '').trim();
  return s === '' || MODEL_RE.test(s) ? s : '';
};

const GUIDANCE_CAP = 1200;
export const cleanGuidance = (v) => String(v ?? '').replace(/\s+$/g, '').slice(0, GUIDANCE_CAP);

// ---------------------------------------------------------------------------
// The registry. `ops` is CLOSED: it is the definition of what this agent may
// do, and every op name here is the name a route passes to its client.
//
// `gemini: false` marks an op that costs no key — the Auditor's deep-audit
// prompt is composed server-side and handed to a Claude session. It is still
// the Auditor's op and still answers to the Auditor's switch: switching an
// agent off means it stops acting, not "it stops acting where it costs money".
// ---------------------------------------------------------------------------
export const AGENTS = [
  {
    key: 'auditor',
    name: 'Auditor',
    tab: 'quality',
    tabLabel: 'Quality',
    blurb: 'Reads the live app, the checks and the tracked bugs, and reports what looks broken.',
    // What the model itself is told it may and may not touch (see preamble()).
    remit: 'the Quality tab: the project\'s checks, its tracked bugs and the live application',
    ops: [
      { op: 'audit', label: 'Bug audit', hint: 'Findings land in the review inbox as suggestions.' },
      { op: 'auditprompt', label: 'Deep-audit prompt', gemini: false, hint: 'Composes the hand-off prompt for a Claude session.' },
    ],
  },
  {
    key: 'curator',
    name: 'Curator',
    tab: 'roadmap',
    tabLabel: 'Roadmap',
    blurb: 'Shapes what is on the board: titles, areas, honest buckets, and the write-ups a reviewer reads.',
    remit: 'the Roadmap tab: the project\'s roadmap items, their fields and what was built against them',
    ops: [
      { op: 'titler', label: 'Suggest a title', hint: 'Titles an item from its note.' },
      { op: 'assist', label: 'Fill from note', hint: 'Fills an item\'s fields; never overwrites one you set.' },
      { op: 'cleanup', label: 'Tidy the board', hint: 'Suggests fixes across the open items.' },
      { op: 'reviewbrief', label: 'Reviewer\'s brief', hint: 'Writes up a completed item for the verdict.' },
      { op: 'refinedraft', label: 'Refine draft', hint: 'Drafts the delta when an item is sent back.' },
    ],
  },
  {
    key: 'polaris',
    name: 'Polaris',
    tab: 'futures',
    tabLabel: 'Futures',
    blurb: 'Keeps the idea funnel pointed at the north star: verdicts, themes, and tickets when an idea is ready.',
    remit: 'the Futures tab: the project\'s idea funnel and its north star',
    ops: [
      { op: 'judge', label: 'Judge alignment', hint: 'Suggests a verdict against the north star.' },
      { op: 'cluster', label: 'Cluster themes', hint: 'Suggests a theme for unthemed ideas.' },
      { op: 'converge', label: 'Converge to tickets', hint: 'Drafts roadmap tickets from picked ideas.' },
    ],
  },
];

export const AGENT_KEYS = AGENTS.map((a) => a.key);
const BY_KEY = new Map(AGENTS.map((a) => [a.key, a]));

// op -> the agent that owns it. Built once, and it is also the assertion that
// no op is claimed twice: two agents owning one op would make "which tab does
// this belong to" unanswerable, which is exactly what the item forbids.
const BY_OP = new Map();
for (const agent of AGENTS) {
  for (const spec of agent.ops) {
    if (BY_OP.has(spec.op)) {
      throw new Error(`Agent op "${spec.op}" is claimed by both ${BY_OP.get(spec.op).agent.name} and ${agent.name}.`);
    }
    BY_OP.set(spec.op, { agent, spec });
  }
}

export const agentByKey = (key) => BY_KEY.get(String(key || '')) || null;
export const agentForOp = (op) => BY_OP.get(String(op || ''))?.agent || null;
export const opSpec = (op) => BY_OP.get(String(op || ''))?.spec || null;

// The typed refusal every gate throws. `httpStatus` is what the route sends —
// routes already do `err.httpStatus || 502`, so this needs no new handling.
function refuse(message, status) {
  const err = new Error(message);
  err.httpStatus = status;
  err.agentRefusal = true;
  return err;
}

// The whole gate decision, as a pure function of (agent, op spec, config, is
// there a key). Pure on purpose: this is the rule the item is actually about,
// and a rule that can only be exercised against a live Postgres is a rule that
// never gets tested. `server/test/agents.test.mjs` runs it directly; gate()
// below is the thin async wrapper that reads the row and applies it.
// Returns null when the agent may act, or the refusal to throw.
export function gateDecision(agent, spec, config, geminiReady) {
  if (!spec) return refuse(`"${agent.name}" was asked for an op it does not own.`, 500);
  if (!config.enabled) {
    return refuse(`The ${agent.name} is switched off (Mission Control → Agents).`, 409);
  }
  if ((config.opsOff || []).includes(spec.op)) {
    return refuse(`The ${agent.name}'s "${spec.label}" is switched off (Mission Control → Agents).`, 409);
  }
  // Order matters: the SWITCH is read before the key, so a switched-off agent
  // says it is switched off rather than blaming a missing key the owner would
  // then go and check.
  if (spec.gemini !== false && !geminiReady) {
    return refuse('Gemini is not configured on this server (set GEMINI_API_KEY).', 503);
  }
  return null;
}

// ---------------------------------------------------------------------------
// The config row. Missing row = the registry defaults, which are all ON.
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = { enabled: true, model: '', guidance: '', opsOff: [] };

export const agentConfigShape = (agent, row) => ({
  enabled: row ? Boolean(row.enabled) : DEFAULT_CONFIG.enabled,
  model: cleanAgentModel(row?.model),
  guidance: cleanGuidance(row?.guidance),
  // Only ops this agent actually owns — a stale name left in the row after an
  // op is renamed must not silently disable something else.
  opsOff: (Array.isArray(row?.ops_off) ? row.ops_off : [])
    .map(String).filter((op) => agent.ops.some((s) => s.op === op)),
  runs: Number(row?.runs ?? 0),
  lastRunAt: row?.last_run_at ? new Date(row.last_run_at).toISOString() : null,
  lastOp: row?.last_op || '',
  lastOutcome: row?.last_outcome || '',
});

// One row per agent, keyed by the registry (not by what is in the table), so an
// agent added to the registry appears immediately and a row for an agent that
// no longer exists is ignored rather than rendered.
export async function readAgents() {
  let byKey = new Map();
  try {
    const { rows } = await q('SELECT * FROM agent_configs');
    byKey = new Map(rows.map((r) => [r.key, r]));
  } catch {
    // The table is created by the boot migration; a read that fails must not
    // take the tabs down with it. Defaults are ON, same direction as settings.
  }
  return AGENTS.map((agent) => ({ agent, config: agentConfigShape(agent, byKey.get(agent.key)) }));
}

export async function readAgent(key) {
  const agent = agentByKey(key);
  if (!agent) return null;
  const all = await readAgents();
  return all.find((a) => a.agent.key === agent.key) || null;
}

export async function writeAgent(key, patch) {
  const agent = agentByKey(key);
  if (!agent) return null;
  const fields = [];
  const values = [agent.key];
  let i = 2;
  if ('enabled' in patch) { fields.push(`enabled = $${i++}`); values.push(Boolean(patch.enabled)); }
  if ('model' in patch) { fields.push(`model = $${i++}`); values.push(cleanAgentModel(patch.model)); }
  if ('guidance' in patch) { fields.push(`guidance = $${i++}`); values.push(cleanGuidance(patch.guidance)); }
  if ('opsOff' in patch) {
    const off = (Array.isArray(patch.opsOff) ? patch.opsOff : [])
      .map(String).filter((op) => agent.ops.some((s) => s.op === op));
    fields.push(`ops_off = $${i++}`);
    values.push(JSON.stringify([...new Set(off)]));
  }
  if (!fields.length) return readAgent(key);
  // The row may not exist yet (missing = defaults), so this is an upsert whose
  // INSERT half has to carry the same values the UPDATE half sets.
  await q(
    `INSERT INTO agent_configs (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
    [agent.key]
  );
  await q(
    `UPDATE agent_configs SET ${fields.join(', ')}, updated_at = now() WHERE key = $1`,
    values
  );
  return readAgent(key);
}

// Fire-and-forget run ledger: how many times this agent has been asked, when,
// for what, and how it went. Never throws into the request path — a counter
// that fails must not fail the answer the owner is waiting for.
async function recordRun(key, op, outcome) {
  try {
    await q(
      `INSERT INTO agent_configs (key, runs, last_run_at, last_op, last_outcome)
       VALUES ($1, 1, now(), $2, $3)
       ON CONFLICT (key) DO UPDATE
         SET runs = agent_configs.runs + 1, last_run_at = now(),
             last_op = EXCLUDED.last_op, last_outcome = EXCLUDED.last_outcome`,
      [key, String(op).slice(0, 40), String(outcome || '').slice(0, 200)]
    );
  } catch { /* the ledger is a nicety; the answer is not */ }
}

// ---------------------------------------------------------------------------
// The preamble — the agent's identity, its tab restriction and the owner's
// standing steer, prefixed to whatever op prompt is being run.
//
// It goes in FRONT, never behind: every op template ends on "Respond with ONLY
// this JSON: {…}", and anything appended after that is read as part of the
// shape instruction. The restriction is stated to the model as well as being
// enforced in code, because the two catch different things — the code stops a
// route calling the wrong agent, the sentence stops the model answering about
// a tab it was not asked about.
// ---------------------------------------------------------------------------
export function agentPreamble(agent, guidance) {
  const steer = String(guidance || '').trim();
  return `You are ${agent.name}, one of Stack's tab agents. You work on ${agent.remit}, and ONLY there.
Work outside that tab belongs to another agent: if the material below points somewhere else, say so
plainly in your answer rather than answering for it.${steer ? `

STANDING GUIDANCE FROM THE OWNER (follow it):
${steer}` : ''}

`;
}

// ---------------------------------------------------------------------------
// agentClient(key) — what a route binds to. Every tab has exactly one.
// ---------------------------------------------------------------------------
export function agentClient(key) {
  const agent = agentByKey(key);
  if (!agent) throw new Error(`Unknown agent "${key}".`);

  // The structural half of the restriction. An op belonging to another agent
  // is a programming error, not a runtime condition: it throws here rather
  // than running the other tab's work under this agent's name and switch.
  const own = (op) => {
    const spec = agent.ops.find((s) => s.op === op);
    if (!spec) {
      const other = agentForOp(op);
      throw new Error(
        other
          ? `"${op}" is the ${other.name}'s op (${other.tabLabel} tab) — the ${agent.name} cannot run it.`
          : `"${op}" is not an op of any tab agent.`
      );
    }
    return spec;
  };

  // Is this agent allowed to act at all right now? Returns the live config so
  // a caller that needs it (the keyless ops) doesn't read the row twice.
  const gate = async (op) => {
    const spec = own(op);
    const live = await readAgent(agent.key);
    const config = live?.config ?? { ...DEFAULT_CONFIG };
    const no = gateDecision(agent, spec, config, geminiEnabled());
    if (no) throw no;
    return config;
  };

  return {
    agent,
    ops: agent.ops,
    gate,
    // The call every Gemini-backed op makes. The run is recorded only once
    // something was actually asked of the model — a refusal is not a run, and
    // counting it as one would make a switched-off agent look busy.
    async ask(op, prompt, opts = {}) {
      const config = await gate(op);
      const full = agentPreamble(agent, config.guidance) + prompt;
      try {
        const answer = await askGemini(full, { ...opts, model: config.model || opts.model });
        void recordRun(agent.key, op, 'ok');
        return answer;
      } catch (err) {
        void recordRun(agent.key, op, err?.message || 'failed');
        throw err;
      }
    },
  };
}

// The compact per-agent state the project detail payload carries, so a tab can
// render its ✧ surfaces ABSENT with a reason instead of offering a button that
// 409s. Same treatment `geminiReady` already gets (#278).
export async function agentsForClient() {
  const all = await readAgents();
  const out = {};
  for (const { agent, config } of all) {
    out[agent.key] = {
      name: agent.name,
      tab: agent.tab,
      enabled: config.enabled,
      // Only the ops that may actually run — the client asks "is my op here".
      ops: agent.ops.filter((s) => !config.opsOff.includes(s.op)).map((s) => s.op),
    };
  }
  return out;
}

// The full shape the Agents room reads (registry + config + ledger).
export const agentShape = ({ agent, config }) => ({
  key: agent.key,
  name: agent.name,
  tab: agent.tab,
  tabLabel: agent.tabLabel,
  blurb: agent.blurb,
  remit: agent.remit,
  enabled: config.enabled,
  model: config.model,
  guidance: config.guidance,
  ops: agent.ops.map((s) => ({
    op: s.op,
    label: s.label,
    hint: s.hint || '',
    gemini: s.gemini !== false,
    enabled: !config.opsOff.includes(s.op),
  })),
  runs: config.runs,
  lastRunAt: config.lastRunAt,
  lastOp: config.lastOp,
  lastOutcome: config.lastOutcome,
});
