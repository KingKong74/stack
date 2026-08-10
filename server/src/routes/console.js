import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { agentByKey, readAgent } from '../agents.js';
import { consolePrime } from '../console-prime.js';

// Mounted at /api/projects/:slug/console. ONE route:
//
//   GET /:key   the briefing a tab agent's live session (#379) is spawned with,
//               plus the model that agent is pinned to.
//
// The browser asks for this the moment it opens a console and hands it to the
// host daemon in the start frame, which spawns `claude --append-system-prompt`
// with it. Why the SERVER composes it, when the tab is already showing most of
// the same material:
//
//  • The agent's identity is registry state (`src/agents.js`) and its standing
//    guidance is a database row. Neither has ever been in the client payload,
//    and a client that re-typed the remit would be a second, drifting copy of
//    the restriction the registry exists to be.
//  • The snapshot is read in one place, so what an agent is told is what Stack
//    knows — not what a tab happened to have loaded and filtered.
//
// The gate is the agent's OWN switches, in the same order gateDecision() uses:
// the agent off is reported before the console off, so the owner is sent to the
// switch they actually flipped. The host daemon is deliberately NOT checked
// here — this route composes text; whether a session can be spawned is the
// daemon's answer and the tab already renders it.
//
// FAIL OPEN, and this is the one direction that matters: a console that cannot
// be primed still opens. The prime is what makes the session the agent, but a
// session in the right checkout is most of the value, and refusing to open a
// terminal because a briefing query failed would trade the whole feature for
// its garnish. The client says so in the strip rather than silently pretending
// (`routes/terminal.js` header, same rule).
export const consoles = Router({ mergeParams: true });

consoles.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

const SEVERITY_RANK = `CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

// Every list below is capped, and every cap SAYS so on the axis it cut
// (#239) — "6 of 23 open items, the 6 the run queue would take first" is a
// different statement from "6 open items", and an agent given the second one
// reasons about a board it has not seen.
const cap = (shown, total, what) =>
  total > shown ? `showing ${shown} of ${total} ${what} — the rest are in Stack` : '';

const ROW_CAP = 8;

// ---------------------------------------------------------------------------
// One builder per agent with a console. Each returns the sections its tab is
// about, in the order the tab draws them. An agent whose builder is missing
// gets no snapshot rather than another agent's — the same restriction the
// registry enforces for ops, applied to what an agent is told.
// ---------------------------------------------------------------------------
const BUILDERS = {
  async auditor(project) {
    const { rows: checks } = await q(
      `SELECT name, last_status, last_error, feature, external FROM checks
        WHERE project_id = $1 ORDER BY (last_status = 'fail') DESC NULLS LAST, name`,
      [project.id]
    );
    const failing = checks.filter((c) => c.last_status === 'fail');
    const unrun = checks.filter((c) => !c.last_status);
    const { rows: bugs } = await q(
      `SELECT bug_key, title, severity, status, COUNT(*) OVER () AS total FROM bugs
        WHERE project_id = $1 AND status <> 'fixed'
        ORDER BY ${SEVERITY_RANK}, created_at DESC LIMIT $2`,
      [project.id, ROW_CAP]
    );
    const bugTotal = Number(bugs[0]?.total ?? 0);
    return [
      {
        title: `CHECKS — ${checks.length} in the suite, ${failing.length} failing`
          + (unrun.length ? `, ${unrun.length} never run` : ''),
        lines: failing.slice(0, ROW_CAP).map((c) =>
          `${c.name}${c.feature ? ` [${c.feature}]` : ''}${c.external ? ' (external — reported, not probed)' : ''}`
          + `: ${String(c.last_error || 'failed with no message').slice(0, 160)}`),
        note: [
          cap(Math.min(failing.length, ROW_CAP), failing.length, 'failing checks'),
          // A check that has never run is not a passing one, and an audit that
          // reads the suite as green because nothing is red has the same bug
          // a NULL review_verdict rendered green would have.
          unrun.length ? `${unrun.length} check(s) have never run — that is not a pass` : '',
        ].filter(Boolean).join('; '),
      },
      {
        title: `OPEN BUGS — ${bugTotal}`,
        lines: bugs.map((b) => `${b.bug_key} [${b.severity}/${b.status}] ${b.title}`),
        note: cap(bugs.length, bugTotal, 'open bugs'),
      },
      {
        title: 'THE LIVE APPLICATION',
        lines: [project.site_url ? `Site under test: ${project.site_url}` : ''].filter(Boolean),
        note: project.site_url ? '' : 'no site URL is set on this project, so there is nothing to read live',
      },
    ];
  },

  async curator(project) {
    const { rows: items } = await q(
      `SELECT id, title, bucket, tier, area, risk, claimed_by, source, reviewed_at, built_note,
              COUNT(*) OVER () AS total
         FROM roadmap_items
        WHERE project_id = $1 AND NOT done AND NOT skipped
        ORDER BY CASE tier WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 ELSE 4 END,
                 CASE bucket WHEN 'must' THEN 0 WHEN 'should' THEN 1 WHEN 'could' THEN 2 ELSE 3 END,
                 position LIMIT $2`,
      [project.id, ROW_CAP]
    );
    const total = Number(items[0]?.total ?? 0);
    const claimed = items.filter((it) => it.claimed_by);
    // #381 — 'fly' is held on the same footing as 'hook' (approval.js), so it
    // belongs in the same briefing line. An agent told the inbox is empty while
    // a card sits waiting reports the board as clear when it is not.
    const inbox = items.filter((it) => (it.source === 'hook' || it.source === 'fly') && !it.reviewed_at);
    return [
      {
        title: `THE BOARD — ${total} open item(s), in the order the run queue would take them`,
        lines: items.map((it) => {
          const meta = [it.bucket, it.tier ? `tier ${it.tier}` : 'unranked', it.area || 'untagged',
            it.risk !== 'normal' ? `risk ${it.risk}` : ''].filter(Boolean).join(' · ');
          return `#${it.id} ${it.title} (${meta})${it.claimed_by ? ` — CLAIMED by ${it.claimed_by}` : ''}`;
        }),
        note: [
          cap(items.length, total, 'open items'),
          claimed.length ? `${claimed.length} of these are claimed — do not re-pick a claimed item` : '',
          inbox.length ? `${inbox.length} are hook-extracted and still awaiting the owner's approval in the Plan inbox` : '',
        ].filter(Boolean).join('; '),
      },
      {
        title: 'WHAT YOU MAY NOT CHANGE HERE',
        lines: [
          '`tier` is the owner\'s ranking of what they want NEXT — agents never set it.',
          '`risk` is written only through PATCH /roadmap/:id, never around it.',
          'The board ORDER is the run queue: reordering it reschedules the night.',
        ],
      },
    ];
  },

  async polaris(project) {
    const { rows: ideas } = await q(
      `SELECT id, title, alignment, magnitude, is_star, parent_id, COUNT(*) OVER () AS total
         FROM futures WHERE project_id = $1
        ORDER BY is_star DESC, (alignment IS NULL) DESC, updated_at DESC LIMIT $2`,
      [project.id, ROW_CAP]
    );
    const total = Number(ideas[0]?.total ?? 0);
    const unjudged = ideas.filter((f) => !f.alignment);
    return [
      {
        title: 'THE NORTH STAR — what every idea here is judged against',
        lines: project.north_star ? [String(project.north_star).trim()] : [],
        note: project.north_star ? '' : 'this project has no north star set, so alignment is unanswerable until it does',
      },
      {
        title: `THE FUNNEL — ${total} idea(s)`,
        lines: ideas.map((f) => {
          const shape = f.is_star ? 'star' : f.parent_id ? 'in orbit' : (f.alignment || 'unjudged');
          const size = f.magnitude ? `magnitude ${f.magnitude}` : 'not sized yet';
          return `#${f.id} ${f.title} (${shape} · ${size})`;
        }),
        note: [
          cap(ideas.length, total, 'ideas'),
          unjudged.length ? `${unjudged.length} shown are unjudged — that is the drift belt, and it is your queue` : '',
        ].filter(Boolean).join('; '),
      },
    ];
  },

  async drafter(project) {
    const { rows: cards } = await q(
      `SELECT c.kind, c.op, COALESCE(NULLIF(c.title, ''), LEFT(n.text, 90), f.title, '') AS label,
              COUNT(*) OVER () AS total
         FROM workbench_cards c
         LEFT JOIN notes n ON n.id = c.note_id
         LEFT JOIN futures f ON f.id = c.future_id
        WHERE c.project_id = $1 ORDER BY c.updated_at DESC LIMIT $2`,
      [project.id, ROW_CAP]
    );
    const total = Number(cards[0]?.total ?? 0);
    return [
      {
        title: `THE CANVAS — ${total} card(s)`,
        lines: cards.map((c) =>
          `[${c.kind}${c.op ? `/${c.op}` : ''}] ${String(c.label || '(untitled)').replace(/\s+/g, ' ').slice(0, 120)}`),
        note: cap(cards.length, total, 'cards'),
      },
      {
        title: 'WHAT A CARD IS',
        lines: [
          'A card is a PLACEMENT, not content: a note or idea card reads its words through from `notes`/`futures`.',
          'Every ✧ op on the canvas only PROPOSES a card — the owner disposes.',
        ],
      },
    ];
  },
};

consoles.get('/:key', async (req, res) => {
  const agent = agentByKey(req.params.key);
  if (!agent) return res.status(404).json({ error: 'No such agent.' });
  if (!agent.console) {
    return res.status(404).json({ error: `The ${agent.name} has no live session.` });
  }
  const live = await readAgent(agent.key);
  const config = live?.config ?? { enabled: true, consoleOff: false, guidance: '', model: '' };
  if (!config.enabled) {
    return res.status(409).json({ error: `The ${agent.name} is switched off (Mission Control → Agents).` });
  }
  if (config.consoleOff) {
    return res.status(409).json({ error: `The ${agent.name}'s live session is switched off (Mission Control → Agents).` });
  }

  const project = req.project;
  let sections = [];
  let partial = '';
  try {
    sections = await (BUILDERS[agent.key]?.(project) ?? []);
  } catch (e) {
    // The identity is worth having on its own, so a failed snapshot query does
    // not cost the owner the primed session — but the agent is TOLD, because an
    // agent that thinks it has seen the tab and has not is worse than one that
    // knows it is blind. Same rule as the Foreman's blind[].
    partial = `The snapshot could not be read from Stack (${String(e.message || e).slice(0, 120)}).`;
    sections = [{ title: 'WHAT THE TAB SHOWS', lines: [], note: partial }];
  }

  res.json({
    agent: agent.key,
    name: agent.name,
    // The agent's pinned Claude alias, so the console runs on the same model
    // the owner chose for that agent's ✧ work rather than the CLI default.
    // '' = whatever the CLI would do, which is what "CLI default" means.
    model: config.model || '',
    prime: consolePrime({ agent, guidance: config.guidance, project, sections }),
    partial,
  });
});
