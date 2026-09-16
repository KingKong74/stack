import { Router } from 'express';
import { q } from '../db.js';
import { readSettings, SESSION_DEFAULTS, sessionDefaultLines } from '../settings.js';
import { agentPreamble, readAgents } from '../agents.js';
import { PULSE_DAYS } from '../pulse.js';

// THE CONTEXT ROOM (Mission Control → Context) — app-wide, one GET.
//
// READ THE WARNING BEFORE THE CODE. The kit's Context tab is a MANAGED
// CLAUDE.MD LIBRARY with an Edit/Save button, and that surface was culled FOR
// CAUSE: Stack used to write each repo's CLAUDE.md from its own copy every five
// minutes, authoritatively, and a stale DB copy silently reverted the project's
// own CLAUDE.md for several sessions running — each one filed as a mystery
// blocker. A repo's CLAUDE.md is the repo's. **Nothing in this file reads,
// holds or writes one, and nothing downstream of it may start to.**
//
// WHAT THIS IS INSTEAD. The honest question the kit's screen asks is "what text
// actually reaches a model in this installation, and which of it is mine to
// change?" — and Stack has a real, complete answer to that which is not a file
// library at all. Three kinds of prompt text, and every one of them is already
// stored somewhere with an owner:
//
//   • ROOT — the SESSION DEFAULTS (`settings.session_defaults`). Rendered
//     server-side from the `SESSION_DEFAULTS` catalogue and injected by the
//     SessionStart hook into EVERY session on EVERY project, which makes it the
//     only text here that genuinely is root context. The catalogue is CODE and
//     which lines are on is a Settings switch, so this room shows it and sends
//     you there — it is deliberately not editable from two places.
//   • AGENT — each registered agent's PREAMBLE (`agentPreamble`), which is its
//     identity, its remit and the owner's standing guidance, prefixed in front
//     of every op prompt it ever runs. The preamble's shape is code; the
//     guidance is the owner's, is already a `PATCH /api/agents/:key` field, and
//     is the one thing on this screen that the Edit button writes.
//   • ASSIST — `settings.assist_guidance`, the standing steer folded into ✧
//     Fill-from-note. Also the owner's, also already a PATCH field.
//
// So the kit's Edit/Save button survives, pointed at two fields that were
// always meant to be written by hand, and the file library does not. A doc with
// no `edit` is a STATEMENT OF WHAT THE CODE DOES and has no button at all —
// which is what stops this shape drifting back into a writer.
//
// `reads` IS A REAL COUNT OR IT IS NULL. The kit puts a read count on every
// row; Stack can count sessions in the window (the root block went into each of
// them) and an agent's own `runs` ledger, and it cannot count the ✧ steer at
// all. A null renders as a dash, never as 0 — a thing nobody can measure is not
// a thing nobody read.
export const context = Router();

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

context.get('/', async (_req, res) => {
  const [settings, agents, sessionCount] = await Promise.all([
    readSettings(),
    readAgents(),
    q(
      `SELECT count(*)::int AS n FROM sessions s JOIN projects p ON p.id = s.project_id
        WHERE p.deleted_at IS NULL AND s.created_at > now() - interval '${PULSE_DAYS} days'`
    ),
  ]);

  const on = settings.session_defaults || [];
  const lines = sessionDefaultLines(on);
  // The lines as the hook actually injects them, blank-line separated. Empty
  // when every default is off, which is a real state the client draws as "not
  // written yet" rather than as an empty file.
  const rootBody = lines.join('\n\n');

  const docs = [
    {
      id: 'session-defaults',
      path: 'session-defaults',
      kind: 'root',
      scope: 'Every session, on every project',
      inherits: false,
      summary: 'Standing preferences, granted once instead of re-stated per chat. The SessionStart hook injects these verbatim in front of the resume brief.',
      meta: `${on.length} of ${SESSION_DEFAULTS.length} on`,
      body: rootBody,
      words: words(rootBody),
      reads: sessionCount.rows[0]?.n ?? 0,
      readsLabel: 'sessions',
      // The catalogue is code and the switches live in Settings. Saying so is
      // the point: a second place to toggle them is a second truth.
      edit: null,
      note: 'The catalogue is code (server/src/settings.js). Which lines are on is a switch in Settings → Session defaults, and that is the only place it is set.',
    },
    ...agents.map(({ agent, config }) => {
      const body = agentPreamble(agent, config.guidance).trimEnd();
      return {
        id: `agent:${agent.key}`,
        path: `agents/${agent.key}.md`,
        kind: 'agent',
        scope: agent.remit,
        // Every op prompt gets the preamble AND, through the session, the root
        // block — so "inherits" is a fact here rather than the kit's decoration.
        inherits: true,
        summary: agent.blurb,
        meta: config.model ? `pinned to ${config.model}` : 'CLI default model',
        body,
        words: words(body),
        reads: config.runs,
        readsLabel: 'runs',
        edit: {
          kind: 'agent-guidance',
          agentKey: agent.key,
          value: config.guidance,
          label: 'Standing guidance',
          hint: 'Folded into the preamble in front of every op this agent runs. Blank is fine — it keeps its identity and its remit either way. The rest of the text above is code.',
        },
        note: '',
      };
    }),
    {
      id: 'assist-guidance',
      path: 'assist-guidance.md',
      kind: 'assist',
      scope: '✧ Fill from note, on the item modal',
      inherits: false,
      summary: 'The owner’s standing steer for the assist. It never overrides a value you set by hand.',
      meta: `${(settings.assist_fields || []).length} fields it may fill`,
      body: String(settings.assist_guidance || ''),
      words: words(settings.assist_guidance),
      // Nothing counts how many times the steer has been read. A dash, never a
      // zero — see the header.
      reads: null,
      readsLabel: '',
      edit: {
        kind: 'assist-guidance',
        value: String(settings.assist_guidance || ''),
        label: 'Standing steer',
        hint: 'Prose, in your own words. Which fields the assist may fill is a separate switch in Settings.',
      },
      note: '',
    },
  ];

  res.json({ windowDays: PULSE_DAYS, docs });
});
