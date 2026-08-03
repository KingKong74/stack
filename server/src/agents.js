// THE AGENTS (#361, #364) — Stack's in-app specialists, each one bound to a
// single SURFACE and unable to act anywhere else.
//
//   Auditor     · Quality tab   — reads the app and reports suspected bugs
//   Curator     · Roadmap tab   — shapes the board and writes it up
//   Foreman     · Review room   — walks a built change before it lands
//   Polaris     · Futures tab   — judges, themes and converges the idea funnel
//   Merge agent · Merge room    — reads the diffs of the branches about to land
//
// Three of the five are PROJECT tabs; the Foreman and the Merge agent are bound
// to Mission Control ROOMS instead, which is why "surface" and not "tab".
// Nothing else about the binding changes: an agent owns its ops, and the client
// that binds to it throws on anybody else's.
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
//   • **The agent annotates, the human disposes.** Nothing an agent returns writes
//     tracker state, with the one sanctioned exception the Auditor already had
//     (findings land in the review INBOX as suggestions, source 'hook').
//   • **A missing config row means ON.** Same direction as readSettings(): the
//     agents are how several tabs already work, so a fresh deploy — or a row
//     that has never been written — must degrade to working, not to a silently
//     dead ✧ button. Only an explicit switch-off turns one off.

import { q } from './db.js';
import { askClaudeOnHost, termAgentConnected } from './term.js';

// #364 — the agents run on CLAUDE, through the host, and no longer on Gemini.
//
// They were Gemini-backed because that was the only model the SERVER could
// reach: it lives in a container and the host firewall drops container→host,
// so an HTTP call to an external API was the only thing available to it. The
// terminal daemon already dials out and holds a socket open, and it already
// carries one correlated request/reply (the permission-prompt answer), so the
// same socket carries a prompt to `claude -p` on the host. That is the same
// route to the same CLI the autopilot uses — hence "like auto modes".
//
// Two consequences worth stating, because they are the reason this is allowed:
//   • NO PAID EXTERNAL API. It is the owner's own Claude subscription via the
//     CLI, so the standing rule holds — the rule is about spend leaving the
//     house, not about which model thinks.
//   • THE HOST IS NOW THE DEPENDENCY, not a key. With the daemon offline every
//     ✧ surface refuses and says the daemon is offline. That is the price of
//     one backend, and it is stated at the button rather than discovered.
//
// Gemini has NOT been removed from the app — the per-push review note, the
// semantic check assertions, session labelling, triage and the Workbench ops
// are still Gemini and still key-gated. Only the three tab agents moved.

// The Claude aliases an agent may be pinned to. '' = whatever the CLI's own
// default is, which is the right answer unless one agent's work has a shape
// that wants a bigger or cheaper model: the Auditor reads a whole page and
// earns Sonnet, the Curator's titler is a sentence and does not.
export const AGENT_MODELS = [
  { model: '', label: 'CLI default' },
  { model: 'haiku', label: 'Haiku' },
  { model: 'sonnet', label: 'Sonnet' },
  { model: 'opus', label: 'Opus' },
];

// Same shape of guard as settings.cleanModelAlias: a safe freeform charset
// rather than an enum, so a model newer than the catalogue still works, but
// nothing with whitespace or shell metacharacters ever reaches a URL path.
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
export const cleanAgentModel = (v) => {
  const s = String(v ?? '').trim();
  return s === '' || MODEL_RE.test(s) ? s : '';
};

// #364 — the answer, parsed. `ask()` returns an OBJECT, exactly as askGemini
// did before it, because the routes' contract is "hand me the JSON the op
// asked for" and changing that would have meant touching every ✧ call site.
//
// The extraction is a shade more forgiving than the Gemini one it replaces,
// for a reason worth knowing: the CLI hands back what the model literally
// wrote, and a model told to answer in JSON writes a ```json fence around it
// far more often through a chat-shaped interface than through a structured
// API. Fences first, then a bare parse, then the first balanced-looking block
// — and if none of those work, the RAW TEXT rides on the error, because
// "the agent said something I could not read" is a debuggable sentence and
// "returned nothing usable" is not.
export function parseAgentJson(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('the agent returned an empty answer');
  const unfenced = text
    .replace(/^```(?:json|jsonc)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  for (const candidate of [unfenced, text]) {
    try { return JSON.parse(candidate); } catch { /* try the next shape */ }
  }
  const m = unfenced.match(/[[{][\s\S]*[\]}]/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* fall through to the throw */ }
  }
  const err = new Error(`the agent's answer was not JSON: ${text.slice(0, 160)}`);
  err.rawAnswer = text;
  throw err;
}

const GUIDANCE_CAP = 1200;
export const cleanGuidance = (v) => String(v ?? '').replace(/\s+$/g, '').slice(0, GUIDANCE_CAP);

// ---------------------------------------------------------------------------
// The registry. `ops` is CLOSED: it is the definition of what this agent may
// do, and every op name here is the name a route passes to its client.
//
// `model: false` marks an op that asks no model at all — the Auditor's
// deep-audit prompt is composed server-side and handed to a Claude session the
// human drives. It is still the Auditor's op and still answers to the Auditor's
// switch: switching an agent off means it stops acting, not "it stops acting
// where it costs something". (It was `gemini: false` before #364; the flag was
// renamed with the backend, because "needs no key" and "needs no model" stopped
// being the same statement once the backend became a local CLI.)
// ---------------------------------------------------------------------------
export const AGENTS = [
  {
    key: 'auditor',
    name: 'Auditor',
    tab: 'quality',
    tabLabel: 'Quality',
    // #375 — tab or room. Three of these are project tabs and two are Mission
    // Control rooms, and until now everything that printed the binding said
    // "tab": the Merge agent's card read "Merge tab", which is a screen that
    // does not exist. The binding is the agent's identity, so the word for it
    // has to be right.
    surface: 'tab',
    blurb: 'Reads the live app, the checks and the tracked bugs, and reports what looks broken.',
    // What the model itself is told it may and may not touch (see preamble()).
    remit: 'the Quality tab: the project\'s checks, its tracked bugs and the live application',
    ops: [
      { op: 'audit', label: 'Bug audit', hint: 'Findings land in the review inbox as suggestions.' },
      { op: 'auditprompt', label: 'Deep-audit prompt', model: false, hint: 'Composes the hand-off prompt for a Claude session you drive yourself.' },
    ],
  },
  {
    key: 'curator',
    name: 'Curator',
    tab: 'roadmap',
    tabLabel: 'Roadmap',
    surface: 'tab',
    blurb: 'Shapes what is on the board: titles, areas, honest buckets, and the write-ups a reviewer reads.',
    remit: 'the Roadmap tab: the project\'s roadmap items, their fields and what was built against them',
    ops: [
      { op: 'titler', label: 'Suggest a title', hint: 'Titles an item from its note.' },
      { op: 'assist', label: 'Fill from note', hint: 'Fills an item\'s fields; never overwrites one you set.' },
      { op: 'cleanup', label: 'Tidy the board', hint: 'Suggests fixes across the open items.' },
    ],
  },
  // #375 — THE FOREMAN, the Review room's own agent.
  //
  // It is not called the Reviewer, and that is deliberate: the room already
  // shows something labelled REVIEWER — the second model's read of the branch
  // diff, taken at push time and stored on the run (`review_verdict`). Two
  // things called the reviewer on one screen would make "what did the reviewer
  // say" unanswerable. The Foreman walks the site: it reads a change with you
  // when you are the one about to give the verdict, where the push reviewer
  // read the diff hours ago without you.
  //
  // `reviewbrief` and `refinedraft` MOVED HERE from the Curator. Their only
  // surface has always been this room, and an agent switch that silences half a
  // room's ✧ buttons while another agent's switch silences the rest is the
  // restriction working against the owner. One room, one switch. (The Curator
  // keeps everything whose surface is the board itself.) An `ops_off` row that
  // still names them under the Curator is ignored on read — agentConfigShape
  // filters to the agent's own ops — so a moved op degrades to ON, the same
  // direction as a missing row.
  {
    key: 'foreman',
    name: 'Foreman',
    tab: 'review',
    tabLabel: 'Review',
    surface: 'room',
    blurb: 'Walks each built change before it lands: what it really is, where to look at it running, and what would send it back.',
    remit: "Mission Control's Review room: the changes waiting on a verdict, what built them, and what the other agents already said about them",
    ops: [
      { op: 'readchange', label: 'Read this change', hint: 'A pre-verdict on one change — what to test, and where it shows in the mirror site.' },
      { op: 'triagequeue', label: 'Triage the queue', hint: 'Says what to read first across every waiting change, and why.' },
      { op: 'reviewbrief', label: 'Reviewer\'s brief', hint: 'Writes up a change for the verdict.' },
      { op: 'refinedraft', label: 'Refine draft', hint: 'Drafts the delta when a change is sent back.' },
    ],
  },
  {
    key: 'merger',
    name: 'Merge agent',
    tab: 'merge',
    tabLabel: 'Merge',
    surface: 'room',
    blurb: 'Reads the diffs of the branches about to be merged and says which pairings should not go in the same wave.',
    remit: "Mission Control's Merge room: the open branches of every project and the diffs they carry",
    ops: [
      { op: 'mergeplan', label: 'Read the plan', hint: 'Reads the real diffs and flags pairings the file paths missed.' },
    ],
  },
  {
    key: 'polaris',
    name: 'Polaris',
    tab: 'futures',
    tabLabel: 'Futures',
    surface: 'tab',
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
export function gateDecision(agent, spec, config, backendReady) {
  if (!spec) return refuse(`"${agent.name}" was asked for an op it does not own.`, 500);
  if (!config.enabled) {
    return refuse(`The ${agent.name} is switched off (Mission Control → Agents).`, 409);
  }
  if ((config.opsOff || []).includes(spec.op)) {
    return refuse(`The ${agent.name}'s "${spec.label}" is switched off (Mission Control → Agents).`, 409);
  }
  // Order matters: the SWITCH is read before the backend, so a switched-off
  // agent says it is switched off rather than blaming an offline daemon the
  // owner would then go and investigate.
  if (spec.model !== false && !backendReady) {
    return refuse(
      'The host daemon is not connected, so no agent can run (the agents run Claude on the host).',
      503);
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
  // #364 — what this agent has actually spent. NUMERIC comes back from pg as a
  // STRING, so it needs Number() (the same coercion shape.js documents for the
  // run ledger). Zero on a fresh row, which reads as "has not spent", not as
  // "does not cost".
  costUsd: Number(row?.cost_usd ?? 0) || 0,
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
async function recordRun(key, op, outcome, costUsd = 0) {
  try {
    await q(
      `INSERT INTO agent_configs (key, runs, last_run_at, last_op, last_outcome, cost_usd)
       VALUES ($1, 1, now(), $2, $3, $4)
       ON CONFLICT (key) DO UPDATE
         SET runs = agent_configs.runs + 1, last_run_at = now(),
             last_op = EXCLUDED.last_op, last_outcome = EXCLUDED.last_outcome,
             cost_usd = agent_configs.cost_usd + EXCLUDED.cost_usd`,
      [key, String(op).slice(0, 40), String(outcome || '').slice(0, 200), Number(costUsd) || 0]
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
          ? `"${op}" is the ${other.name}'s op (the ${other.tabLabel} ${other.surface}) — the ${agent.name} cannot run it.`
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
    const no = gateDecision(agent, spec, config, termAgentConnected());
    if (no) throw no;
    return config;
  };

  return {
    agent,
    ops: agent.ops,
    gate,
    // The call every model-backed op makes. The run is recorded only once
    // something was actually asked of the model — a refusal is not a run, and
    // counting it as one would make a switched-off agent look busy.
    //
    // The host's refusals arrive as a resolved {ok:false}, not a rejection, so
    // they are turned into the same typed throw the gate uses: a route already
    // knows how to render one of those, and "the daemon went away mid-request"
    // deserves the same sentence-beside-the-button treatment as "it was
    // already offline when you pressed".
    async ask(op, prompt, opts = {}) {
      const config = await gate(op);
      const full = agentPreamble(agent, config.guidance) + prompt;
      const r = await askClaudeOnHost(full, {
        model: config.model || opts.model || '',
        timeoutMs: opts.timeoutMs,
        // Host-side material the SERVER cannot gather (the Merge agent's real
        // branch diffs). The host reads it and puts it in front of the prompt.
        diffs: opts.diffs || null,
      });
      if (!r.ok) {
        void recordRun(agent.key, op, r.error || 'failed', 0);
        throw refuse(r.error || 'the host could not run the agent', 503);
      }
      try {
        const parsed = parseAgentJson(r.text);
        void recordRun(agent.key, op, 'ok', r.costUsd);
        return parsed;
      } catch (err) {
        // The run HAPPENED and it cost money — record it as a run that failed
        // to parse rather than not at all, or the ledger reports an agent as
        // idle while it is quietly burning tokens on unreadable answers.
        void recordRun(agent.key, op, err.message, r.costUsd);
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
  const ready = termAgentConnected();
  const out = {};
  for (const { agent, config } of all) {
    out[agent.key] = {
      name: agent.name,
      tab: agent.tab,
      enabled: config.enabled,
      // #364 — can it run AT ALL right now? The switch is the owner's intent;
      // this is whether the backend is there. A tab needs both to offer a ✧,
      // and needs to tell them apart to say WHY one is missing.
      ready,
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
  surface: agent.surface,
  blurb: agent.blurb,
  remit: agent.remit,
  enabled: config.enabled,
  model: config.model,
  guidance: config.guidance,
  ops: agent.ops.map((s) => ({
    op: s.op,
    label: s.label,
    hint: s.hint || '',
    needsModel: s.model !== false,
    enabled: !config.opsOff.includes(s.op),
  })),
  runs: config.runs,
  costUsd: config.costUsd,
  lastRunAt: config.lastRunAt,
  lastOp: config.lastOp,
  lastOutcome: config.lastOutcome,
});
