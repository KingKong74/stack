import { Router } from 'express';
import { q } from '../db.js';
import { readSettings, SESSION_DEFAULTS, sessionDefaultLines } from '../settings.js';
import { mergeProfiles } from '../agent-profiles.js';
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
//   • AGENT — each SPAWN PROFILE's `prompt` (`agent_profiles`), which is the
//     system prompt the overnight runner hands `claude --agents` for that
//     subagent. #520 re-aimed this row: it used to be the tab-agent registry's
//     PREAMBLE, and that registry is culled. The replacement is a better fit
//     than the thing it replaces — a preamble was code with one editable line
//     folded into it, where a profile's prompt is the owner's words end to end,
//     already a `PATCH /api/agent-profiles/:key` field, and is genuinely the
//     largest block of text Stack puts in front of a model.
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
// them) and the open items that would SPAWN a given profile, and it cannot
// count the ✧ steer at all. A null renders as a dash, never as 0 — a thing
// nobody can measure is not a thing nobody read.
//
// AND A PROFILE'S COUNT IS WHAT `resolveSpawn` WOULD ACTUALLY DO, which is why
// the executor's takes `agent_profile = ''` as well as its own key: an item
// that names no profile spawns the executor, so counting only the explicit
// assignments would report Stack's busiest subagent as its least used. The
// same asymmetry is why no other profile may claim the blanks.
export const context = Router();

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

context.get('/', async (_req, res) => {
  const [settings, storedProfiles, profileUse, sessionCount] = await Promise.all([
    readSettings(),
    q('SELECT * FROM agent_profiles ORDER BY key').then((r) => r.rows).catch(() => []),
    // How many OPEN items would spawn each profile. Open and un-archived,
    // because a done item is not work anything is going to build tonight.
    q(
      `SELECT COALESCE(NULLIF(r.agent_profile, ''), 'executor') AS key, count(*)::int AS n
         FROM roadmap_items r JOIN projects p ON p.id = r.project_id
        WHERE p.deleted_at IS NULL AND NOT r.done AND NOT r.archived
        GROUP BY 1`
    ).then((r) => r.rows).catch(() => []),
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

  // The builtins live in code and are merged in at read time, exactly as
  // GET /api/agent-profiles does it — so a fresh install with an empty table
  // still has two rows on this screen rather than none.
  const profiles = mergeProfiles(storedProfiles.map((r) => ({
    key: r.key, name: r.name, description: r.description, prompt: r.prompt,
    model: r.model, tools: r.tools || [], enabled: r.enabled,
  })));
  const useByKey = new Map(profileUse.map((r) => [r.key, r.n]));

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
    ...profiles.map((p) => {
      const body = String(p.prompt || '');
      return {
        id: `agent:${p.key}`,
        path: `agents/${p.key}.md`,
        kind: 'agent',
        scope: p.description || `The ${p.name} subagent, on every run that spawns it`,
        // A subagent's context is ISOLATED — that is the whole point of the
        // #285 arrangement — so it does NOT get the session's root block. The
        // kit's inherit flag is a fact on this screen, and here the fact is no.
        inherits: false,
        summary: p.description || '',
        meta: [
          p.enabled ? null : 'switched off',
          p.model ? `pinned to ${p.model}` : 'inherits the executor model',
          `${(p.tools || []).length} tools`,
        ].filter(Boolean).join(' · '),
        body,
        words: words(body),
        reads: useByKey.get(p.key) ?? 0,
        readsLabel: 'open items',
        edit: {
          kind: 'profile-prompt',
          agentKey: p.key,
          value: body,
          label: 'System prompt',
          hint: 'The whole of what this subagent is told before it starts. Unlike the rest of this screen there is no code wrapped around it — what you write here is what the model reads.',
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
