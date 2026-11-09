import { Router } from 'express';
import { q } from '../db.js';
import { readSettings, EXECUTOR_CATALOGUE, ADVISOR_CATALOGUE } from '../settings.js';
import { geminiEnabled, GEMINI_MODELS } from '../gemini.js';
import { termAgentConnected } from '../term.js';
import { readUsage, PULSE_DAYS } from '../pulse.js';

// THE MODELS ROOM (Mission Control → Models) — app-wide, no slug, one GET.
//
// It answers two questions that are NOT the same question, and the whole file
// exists to keep them apart:
//
//   1. WHAT THE POLICY IS — `autopilotExecutorModel` / `autopilotAdvisorModel`,
//      the settings row. Inverted by #285: the ADVISOR runs the session (main
//      loop, plans, delegates, verifies, commits) and the EXECUTOR is exposed
//      to it as a subagent holding the write tools. The two catalogues have
//      been in `settings.js` since #175 with nothing serving them — the room
//      that read them was culled — and this is where they come back.
//   2. WHAT WAS ACTUALLY SPENT — and that is TWO POPULATIONS THAT MUST NEVER
//      BE MIXED. `autopilot_runs` answers to the policy above;
//      `sessions.model_usage` is the human's own interactive work, so a model
//      picked by hand there is NOT drift. The arithmetic is `pulse.js`'s
//      `readUsage`, unchanged and fleet-wide rather than per-project, which
//      already holds the rule that matters: SHARES ARE TOKEN-BASED, because an
//      interactive transcript carries no price and a cost-weighted share would
//      silently describe the autopilot alone.
//
// THE KIT'S SCREEN DRAWS A PROVIDER TABLE, and Stack's providers are not a
// table of API keys — that is the mapping decision this file makes:
//
//   • ANTHROPIC is not an API key at all. Claude reaches Stack through the host
//     daemon's uplink to `claude -p` on the owner's own subscription (#364), so
//     its readiness is the DAEMON and its "key" is a subscription. No paid
//     external API, which is the whole reason the arrangement is allowed.
//   • GEMINI is a key, free-tier, and the read-only second opinion. Absent key
//     = ABSENT, never "disabled" — the standing rule for every Gemini surface.
//   • OMNIROUTE cannot be seen from here AT ALL. It is loopback-only on the
//     host and the server is in a container, so the honest answer is "Stack
//     cannot see", which is the FAIL SILENT direction: a reader must not read
//     absence as good news. It gets a card that says so rather than a green one
//     or no card at all.
//
// A provider's own share bar is token share over the whole measured window, and
// it is the ONE bar on this screen a merged population may appear in, for the
// reason readUsage states.
export const models = Router();

/**
 * Which provider a measured model id belongs to. Cosmetic grouping, never
 * stored — the same status `shortModelName` has in pulse.js. A model nobody
 * recognises lands in `other` rather than being silently dropped: an unlabelled
 * spend is still spend, and hiding it is how a bill goes missing.
 */
export function providerOf(model) {
  const s = String(model || '').toLowerCase();
  if (s.includes('claude') || s.includes('anthropic')) return 'anthropic';
  if (s.includes('gemini')) return 'gemini';
  // Codex's ids: gpt-5-codex, gpt-5-mini, openai/…, and the o-series (o3, o4-mini).
  if (s.includes('codex') || s.includes('gpt') || s.includes('openai') || /^o\d/.test(s)) return 'codex';
  return 'other';
}

/**
 * Which policy role, if any, a measured model id is serving. The settings row
 * holds a CLI ALIAS ('sonnet', 'claude-opus-5', '') while a transcript records
 * the full id the CLI resolved it to ('claude-sonnet-4-5-20250929'), so the
 * match is containment rather than equality.
 *
 * '' NEVER MATCHES. An empty alias means "whatever the CLI's own default is",
 * and a blank string is a substring of everything — matching on it would label
 * every model on the screen as the executor's pick, which is exactly the kind
 * of confident wrong answer this screen is for avoiding. Both roles can land on
 * one row (executor and advisor set to the same alias is a real configuration),
 * so this returns a LIST.
 */
export function rolesFor(model, executor, advisor) {
  const id = String(model || '').toLowerCase();
  const out = [];
  const hit = (alias) => {
    const a = String(alias || '').trim().toLowerCase();
    return a !== '' && id.includes(a);
  };
  if (hit(executor)) out.push('executor');
  if (hit(advisor)) out.push('advisor');
  return out;
}

// The three backends Stack actually has, in the order they matter. `models` is
// filled from the measured usage below; a provider with none still gets a card,
// because "configured and unused" and "not configured" are different answers.
// `group` splits the room the way the owner reads it: a HARNESS can run a
// session (and so could hold a policy role), an OTHER backend never runs one.
// Only Claude Code holds a role today: the autopilot spawns `claude -p` and
// nothing else, so Codex is a terminal-only harness and Copilot is planned.
function backends({ hostReady, geminiReady }) {
  return [
    {
      key: 'anthropic',
      group: 'harness',
      name: 'Claude Code',
      kind: 'Coding harness',
      reach: 'owner’s subscription · host daemon',
      detail: 'Reached by the host daemon’s uplink to `claude -p`, not by an API key. The autopilot and the terminal both run through it. Reads CLAUDE.md; spawn profiles reach it through --agents.',
      state: hostReady ? 'Host connected' : 'Host offline',
      tone: hostReady ? 'success' : 'warning',
    },
    {
      key: 'codex',
      group: 'harness',
      name: 'Codex',
      kind: 'Coding harness · terminal only',
      reach: 'codex CLI · host daemon',
      // Measured only where a transcript reached Stack, and the transcript hook
      // is Claude Code's, so an empty Codex row is not a claim that it is idle.
      detail: 'Runs in Stack’s terminal through the host daemon. Reads AGENTS.md, and CLAUDE.md wherever AGENTS.md points to it. The autopilot does not run Codex yet, so it cannot hold the advisor or executor role.',
      state: hostReady ? 'Terminal only' : 'Host offline',
      tone: hostReady ? 'neutral' : 'warning',
      absent: 'Nothing measured. Stack’s transcript hook is Claude Code’s, so a Codex session usually leaves no usage here. This is not a claim that it is idle.',
    },
    {
      key: 'copilot',
      group: 'harness',
      name: 'GitHub Copilot',
      kind: 'Coding harness · planned',
      reach: '—',
      detail: 'Not set up. Once connected it could become an advisor or executor option, and its usage would be measured here alongside the others.',
      state: 'Not connected',
      tone: 'neutral',
      planned: true,
    },
    {
      key: 'gemini',
      group: 'other',
      name: 'Gemini',
      kind: 'Read-only second opinion',
      reach: geminiReady ? 'GEMINI_API_KEY is set' : 'GEMINI_API_KEY is unset',
      detail: 'Free tier. It annotates and the human disposes: the per-push review note, check assertions, labelling and triage, and the Curator’s two board reads.',
      state: geminiReady ? 'Key configured' : 'Absent',
      tone: geminiReady ? 'success' : 'neutral',
    },
    {
      key: 'omniroute',
      group: 'other',
      name: 'OmniRoute (local)',
      kind: 'Local gateway',
      reach: 'localhost:20128, host-side only',
      // FAIL SILENT, stated out loud. The server is in a container and the
      // gateway is bound loopback-only on the host, so no answer here is
      // measurable — and "Stack cannot see" is the answer, never a green card
      // and never an empty one that reads as "nothing is running".
      detail: 'Loopback-only on the host, and the server is in a container, so Stack cannot see it from here. Free by default; only OMNIROUTE_MODEL naming a paid model spends anything.',
      state: 'Not visible from here',
      tone: 'neutral',
      absent: 'Nothing measured. Stack can’t see this backend either way, so this isn’t a claim that it’s idle.',
    },
    {
      key: 'other',
      group: 'other',
      name: 'Other',
      kind: 'Unrecognised',
      reach: '—',
      detail: 'Models measured in the window that match none of the backends above. Listed rather than dropped: unlabelled spend is still spend.',
      state: 'Measured only',
      tone: 'neutral',
    },
  ];
}

models.get('/', async (_req, res) => {
  const since = `now() - interval '${PULSE_DAYS} days'`;
  const [settings, sessions, runs] = await Promise.all([
    readSettings(),
    q(
      `SELECT s.created_at, s.tokens_used, s.model_usage, s.agent_usage,
              s.agent_calls, s.agents_recorded, s.summary
         FROM sessions s JOIN projects p ON p.id = s.project_id
        WHERE p.deleted_at IS NULL AND s.created_at > ${since}`
    ),
    q(
      `SELECT r.finished_at, r.tokens, r.cost_usd, r.model_usage, r.item_title, r.outcome
         FROM autopilot_runs r JOIN projects p ON p.id = r.project_id
        WHERE p.deleted_at IS NULL AND r.finished_at > ${since}`
    ),
  ]);

  const usage = readUsage({ sessions: sessions.rows, runs: runs.rows });
  const executor = settings.autopilot_executor_model || '';
  const advisor = settings.autopilot_advisor_model || '';

  const byProvider = new Map();
  for (const m of usage.models) {
    const key = providerOf(m.model);
    if (!byProvider.has(key)) byProvider.set(key, []);
    byProvider.get(key).push({ ...m, roles: rolesFor(m.model, executor, advisor) });
  }

  const providers = backends({ hostReady: termAgentConnected(), geminiReady: geminiEnabled() })
    .map((b) => {
      const rows = byProvider.get(b.key) || [];
      const tokens = rows.reduce((n, r) => n + r.tokens, 0);
      return {
        ...b,
        tokens,
        autoTokens: rows.reduce((n, r) => n + (r.autoTokens || 0), 0),
        runs: rows.reduce((n, r) => n + r.runs, 0),
        sessions: rows.reduce((n, r) => n + r.sessions, 0),
        share: usage.tokens > 0 ? (tokens / usage.tokens) * 100 : 0,
        models: rows,
      };
    })
    // 'other' is a bucket, not a backend: it appears only when something landed
    // in it. The real ones always appear, measured or not.
    .filter((b) => b.key !== 'other' || b.models.length > 0);

  res.json({
    windowDays: PULSE_DAYS,
    hostReady: termAgentConnected(),
    geminiReady: geminiEnabled(),
    policy: {
      executor,
      advisor,
      executorCatalogue: EXECUTOR_CATALOGUE,
      advisorCatalogue: ADVISOR_CATALOGUE,
      geminiCatalogue: GEMINI_MODELS,
    },
    totals: {
      // `measured: false` = NOTHING IN THE WINDOW CARRIED THIS, and the client
      // draws the band absent rather than a row of zeroes. Same rule as pulse.
      measured: usage.measured,
      tokens: usage.tokens,
      interactiveTokens: usage.interactiveTokens,
      autoTokens: usage.autoTokens,
      sessions: usage.sessions,
      runs: usage.runs,
      // Priced runs only — `pricedRuns` of `runs` is what stops this reading as
      // the whole bill. An interactive session is never priced.
      costUsd: usage.costUsd,
      pricedRuns: usage.pricedRuns,
      delegations: usage.delegations,
    },
    providers,
  });
});
