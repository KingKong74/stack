import { Router } from 'express';
import { q } from '../db.js';
import { agentClient, backendReadyFor, readAgent } from '../agents.js';

// THE INSTRUCTIONS TREE — the CLAUDE.md files Stack manages, as a surface.
//
// The problem it exists for: the files that decide how every session and every
// agent behaves are scattered across repos on the host, edited over ssh, and
// invisible to the app that runs the fleet. There is no way to see what the
// merged context actually says, what it costs, or which of two files wins.
//
// The arrangement is the SKILL TREE's (#228), copied deliberately rather than
// re-invented, and for the same reason: the server runs in a container and the
// host firewall drops container→host, so it cannot see a repo. So —
//
//   • the server holds the LIBRARY and the INTENT (`instruction_files`),
//   • the HOST does every read and every write (scripts/stack-instructions.mjs,
//     off the dispatcher's five-minute tick),
//   • `installed_at` is a fact the host REPORTS, never something a save sets,
//   • and a file the host finds but no row claims is REPORTED, never touched.
//
// THE TRUST RULE, which is the whole reason this can be pointed at somebody's
// repo: **Stack only ever writes a CLAUDE.md it planted or was explicitly given.**
// The host marks its own with `<!-- stack-managed -->`; a file without that
// marker is read-only to Stack forever, unless the owner presses Adopt — which
// is what consent looks like when the thing being taken over is a file someone
// wrote by hand. `adopted` records that press so the tree can keep saying so.
//
// What is NOT here, on purpose:
//
//   • **No rules table.** `body` is the file, verbatim. Sections, rules, a
//     rule's scope and its off switch, the precedence order, the merge preview
//     and the token estimate are all DERIVED in web/src/lib/instructions.ts and
//     stored nowhere. A rules table would be a second truth that is wrong the
//     moment somebody edits the file on disk — and people edit the file on
//     disk, because the file is what Claude reads.
//   • **No apply path for the agent.** `POST /draft` returns a proposal and
//     this route never writes it. A model editing its own instructions unread
//     is the one place "the agent annotates, the human disposes" matters most,
//     not least; the owner presses Apply and the ordinary PATCH does it.

export const instructions = Router();

const SCOPES = ['global', 'project'];
const BODY_MAX = 100_000;
const REPORT_MAX = 120;
const REPORT_BODY_MAX = 40_000;

// `dir` becomes a PATH ON THE HOST, so this is a guard and not a tidy-up. No
// absolute paths, no traversal, no dots, no backslashes; forward-slash segments
// of safe characters only, bounded in depth and length. A dir that does not
// survive this comes back '' — the repo root, the one place that is always
// legitimate — rather than being refused, so a stray trailing slash does not
// cost the owner an error message.
export const cleanDir = (v) => String(v ?? '')
  .trim()
  .replace(/\\/g, '/')
  .replace(/^\/+|\/+$/g, '')
  .split('/')
  .filter((seg) => seg && seg !== '.' && seg !== '..' && /^[A-Za-z0-9._@-]{1,64}$/.test(seg))
  .slice(0, 6)
  .join('/')
  .slice(0, 200);

// Where this file lives, as the owner reads it. The global one is the personal
// file Claude Code loads for every project; a project one is relative to the
// repo root, which is how everything else in Stack spells a path.
export const displayPath = (scope, dir) =>
  (scope === 'global' ? '~/.claude/CLAUDE.md' : `${dir ? `${dir}/` : ''}CLAUDE.md`);

// One file, as it lands on disk. The managed marker is APPENDED here and is
// never part of `body`: it is Stack's bookkeeping, not the owner's writing, and
// a marker inside the editor would be a line the owner can delete by accident
// and thereby orphan their own file. The host strips it again when reporting.
export const MANAGED_MARKER = '<!-- stack-managed -->';
export const instructionFile = (body) => {
  const text = String(body || '').replace(/\s+$/, '');
  return `${text}\n\n${MANAGED_MARKER}\n`;
};

const shape = (r) => ({
  id: r.id,
  scope: r.scope,
  slug: r.slug ?? '',
  dir: r.dir || '',
  path: displayPath(r.scope, r.dir || ''),
  body: r.body || '',
  enabled: r.enabled,
  adopted: r.adopted === true,
  installedAt: r.installed_at ? new Date(r.installed_at).toISOString() : null,
  updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
});

const libraryRows = async () => {
  const { rows } = await q(
    `SELECT f.*, p.slug FROM instruction_files f
       LEFT JOIN projects p ON p.id = f.project_id AND p.deleted_at IS NULL
      ORDER BY f.scope, p.slug NULLS FIRST, f.dir`);
  return rows;
};

const readReport = async () => {
  const { rows } = await q('SELECT * FROM instruction_reports WHERE only_row');
  if (!rows.length) return { files: [], repos: [], detail: '', when: null };
  return {
    files: Array.isArray(rows[0].report) ? rows[0].report : [],
    repos: Array.isArray(rows[0].repos) ? rows[0].repos : [],
    detail: rows[0].detail || '',
    when: rows[0].reported_at ? new Date(rows[0].reported_at).toISOString() : null,
  };
};

const resolveProject = async (slug) => {
  if (!slug) return null;
  const { rows } = await q(
    'SELECT id, slug, name FROM projects WHERE slug = $1 AND deleted_at IS NULL', [String(slug)]);
  return rows[0] || null;
};

// The Scribe's live state, so the dock renders ABSENT with a reason instead of
// offering a ✧ that 409s. Its two ops sit on two backends, so there is no one
// answer to "is it ready" — `opsReady` is per-op for exactly that reason.
const scribeState = async () => {
  const live = await readAgent('scribe');
  if (!live) return { enabled: false, ops: [], opsReady: [] };
  const on = live.agent.ops.filter((s) => !live.config.opsOff.includes(s.op));
  return {
    enabled: live.config.enabled,
    ops: on.map((s) => s.op),
    opsReady: on.filter((s) => backendReadyFor(s)).map((s) => s.op),
  };
};

// GET / — the library, what the host last saw on disk, and the agent's state,
// in one call. One call because the screen cannot render the tree without both
// halves: a managed file missing from disk and a disk file nobody manages are
// each only visible by holding the two lists side by side.
instructions.get('/', async (_req, res) => {
  const [rows, report, agent] = await Promise.all([libraryRows(), readReport(), scribeState()]);
  res.json({ files: rows.map(shape), report, agent });
});

instructions.post('/', async (req, res) => {
  const scope = SCOPES.includes(req.body?.scope) ? req.body.scope : 'project';
  const dir = scope === 'global' ? '' : cleanDir(req.body?.dir);
  const project = scope === 'project' ? await resolveProject(req.body?.slug) : null;
  if (scope === 'project' && !project) {
    return res.status(400).json({ error: 'A project file needs a project that exists.' });
  }
  try {
    const { rows } = await q(
      `INSERT INTO instruction_files (scope, project_id, dir, body, enabled, adopted)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [scope, project?.id ?? null, dir,
        String(req.body?.body || '').slice(0, BODY_MAX),
        req.body?.enabled !== false,
        req.body?.adopted === true]);
    res.status(201).json(shape({ ...rows[0], slug: project?.slug ?? '' }));
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: `Stack already manages ${displayPath(scope, dir)} there.` });
    }
    throw e;
  }
});

instructions.patch('/:id', async (req, res) => {
  const { rows: cur } = await q('SELECT * FROM instruction_files WHERE id = $1', [req.params.id]);
  if (!cur.length) return res.status(404).json({ error: 'No such instructions file.' });
  const sets = [];
  const vals = [];
  let i = 1;
  if (req.body?.body !== undefined) {
    sets.push(`body = $${i++}`); vals.push(String(req.body.body).slice(0, BODY_MAX));
  }
  if (req.body?.enabled !== undefined) {
    sets.push(`enabled = $${i++}`); vals.push(req.body.enabled === true);
  }
  if (req.body?.dir !== undefined && cur[0].scope === 'project') {
    sets.push(`dir = $${i++}`); vals.push(cleanDir(req.body.dir));
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  // Any change to WHAT gets written invalidates the install: the row no longer
  // describes what is on disk, and the tree has to say so until the host has
  // caught up. Toggling `enabled` off is the exception — that is a removal, and
  // the host clears installed_at itself once the file is gone.
  const touchesContent = ['body', 'dir'].some((k) => req.body?.[k] !== undefined);
  if (touchesContent) sets.push('installed_at = NULL');
  vals.push(req.params.id);
  try {
    const { rows } = await q(
      `UPDATE instruction_files SET ${sets.join(', ')}, updated_at = now() WHERE id = $${i} RETURNING *`, vals);
    const { rows: p } = rows[0].project_id
      ? await q('SELECT slug FROM projects WHERE id = $1', [rows[0].project_id])
      : { rows: [] };
    res.json(shape({ ...rows[0], slug: p[0]?.slug ?? '' }));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Stack already manages a file at that path.' });
    throw e;
  }
});

// DELETE — out of the library. That is NOT a delete on disk: the host's `keep`
// list drives removal, and it only ever removes a file carrying the marker.
// A file Stack adopted goes back to being the owner's, marker and all, which is
// the right direction for a mistake to fall.
instructions.delete('/:id', async (req, res) => {
  await q('DELETE FROM instruction_files WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// POST /adopt — take over a file the host reported but nobody manages. This is
// the consent step the trust rule turns on, so it reads the body from the LAST
// REPORT rather than from anything the client sent: the owner is adopting the
// file that is on disk, and a body posted from a browser is a different thing
// wearing its name.
instructions.post('/adopt', async (req, res) => {
  const scope = SCOPES.includes(req.body?.scope) ? req.body.scope : 'project';
  const dir = scope === 'global' ? '' : cleanDir(req.body?.dir);
  const slug = String(req.body?.slug || '');
  const report = await readReport();
  const found = report.files.find((f) => f.scope === scope && (f.slug || '') === (scope === 'global' ? '' : slug) && (f.dir || '') === dir);
  if (!found) {
    return res.status(404).json({
      error: 'The host has not reported a file there — nothing to adopt. (The sync runs every five minutes.)',
    });
  }
  if (found.managed) {
    return res.status(409).json({ error: 'Stack already manages that file.' });
  }
  const project = scope === 'project' ? await resolveProject(slug) : null;
  if (scope === 'project' && !project) {
    return res.status(400).json({ error: 'A project file needs a project that exists.' });
  }
  try {
    const { rows } = await q(
      `INSERT INTO instruction_files (scope, project_id, dir, body, enabled, adopted)
       VALUES ($1,$2,$3,$4,true,true) RETURNING *`,
      [scope, project?.id ?? null, dir, String(found.body || '').slice(0, BODY_MAX)]);
    res.status(201).json(shape({ ...rows[0], slug: project?.slug ?? '' }));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Stack already manages a file at that path.' });
    throw e;
  }
});

// ---- the host's two endpoints ---------------------------------------------

// GET /work — everything the host needs to make disk match the library, with no
// decision left on its side beyond writing and deleting.
//
// `keep` rather than a remove list, for the reason skills.js gives: the server
// does not know what is on disk, and a diff computed against a stale report
// would delete a file that had only just been written. `scan` is the extra this
// one needs — the host cannot report files in repos it was never told to look
// at, and enumerating every directory under $HOME is not a thing to do on a
// five-minute tick.
instructions.get('/work', async (_req, res) => {
  const rows = await libraryRows();
  const { rows: projects } = await q(
    'SELECT slug FROM projects WHERE deleted_at IS NULL ORDER BY slug');
  const place = (r) => ({ scope: r.scope, slug: r.scope === 'project' ? (r.slug || '') : '', dir: r.dir || '' });
  const enabled = rows.filter((r) => r.enabled && !(r.scope === 'project' && !r.slug));
  res.json({
    scan: projects.map((p) => p.slug),
    write: enabled.map((r) => ({
      id: r.id, ...place(r), content: instructionFile(r.body),
      installed: !!r.installed_at,
      // The one-time licence to write over a file carrying no marker. See the
      // note on `claimed_at` in schema.sql: without this the host refuses the
      // very file the owner just pressed Adopt on, and adoption does nothing.
      adopt: r.adopted === true && !r.claimed_at,
    })),
    keep: enabled.map((r) => place(r)),
  });
});

// POST /report — the host's snapshot of disk, plus the ids it just installed.
// Replaces the report whole, like the branch report (#207) and the skill one.
instructions.post('/report', async (req, res) => {
  const list = (Array.isArray(req.body?.files) ? req.body.files : [])
    .map((f) => (f && typeof f === 'object' ? {
      scope: SCOPES.includes(f.scope) ? f.scope : 'project',
      slug: String(f.slug || '').slice(0, 80),
      dir: cleanDir(f.dir),
      path: String(f.path || '').slice(0, 300),
      managed: f.managed === true,
      body: String(f.body || '').slice(0, REPORT_BODY_MAX),
      // How many tracked files this file's directory reaches — the honest
      // version of the map's "reaches N files", counted by git on the host
      // rather than guessed here. -1 means the host could not count (not a
      // repo, git absent): rendered as unknown, never as zero, the same rule
      // as a NULL review verdict.
      reach: Number.isFinite(Number(f.reach)) ? Math.trunc(Number(f.reach)) : -1,
      bytes: Number(f.bytes) || 0,
    } : null))
    .filter((f) => f)
    .slice(0, REPORT_MAX);

  // Where a nested file could go, per repo. Capped on both axes like the file
  // list — this is a snapshot of somebody's disk, and a repo with a generator
  // loose in it must not be able to put ten thousand directories in a payload.
  const repos = (Array.isArray(req.body?.repos) ? req.body.repos : [])
    .map((r) => (r && typeof r === 'object' && r.slug ? {
      slug: String(r.slug).slice(0, 80),
      // Absent on an older host, which reads as "could not ask" — the truthful
      // answer for a host that does not know about this field at all.
      known: r.known === true,
      root: Number.isFinite(Number(r.root)) ? Math.trunc(Number(r.root)) : -1,
      dirs: (Array.isArray(r.dirs) ? r.dirs : []).slice(0, 60)
        .map((d) => ({ dir: cleanDir(d?.dir), files: Number(d?.files) || 0 }))
        .filter((d) => d.dir),
    } : null))
    .filter(Boolean)
    .slice(0, 60);

  const installed = (Array.isArray(req.body?.installed) ? req.body.installed : [])
    .map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0).slice(0, 400);
  if (installed.length) {
    // COALESCE on claimed_at, never a plain assignment: it is stamped by the
    // FIRST write and then frozen, because it is the record that a takeover
    // already happened. Re-stamping it would keep re-granting the licence.
    await q(
      `UPDATE instruction_files
          SET installed_at = now(), claimed_at = COALESCE(claimed_at, now())
        WHERE id = ANY($1)`, [installed]);
  }
  // A file the host reports as absent is not installed, whatever we thought.
  // This is what keeps the tree honest after somebody deletes a file by hand:
  // the row goes back to "not on disk" rather than claiming an install that no
  // longer exists.
  const present = list.filter((f) => f.managed).map((f) => `${f.scope}:${f.slug}:${f.dir}`);
  await q(
    `UPDATE instruction_files SET installed_at = NULL
      WHERE installed_at IS NOT NULL
        AND (scope || ':'
             || CASE WHEN scope = 'project'
                     THEN COALESCE((SELECT slug FROM projects WHERE id = instruction_files.project_id), '')
                     ELSE '' END
             || ':' || dir) <> ALL($1::text[])`,
    [present]);

  await q(
    `INSERT INTO instruction_reports (only_row, report, repos, detail, reported_at)
     VALUES (TRUE, $1::jsonb, $2::jsonb, $3, now())
     ON CONFLICT (only_row) DO UPDATE
       SET report = EXCLUDED.report, repos = EXCLUDED.repos,
           detail = EXCLUDED.detail, reported_at = now()`,
    [JSON.stringify(list), JSON.stringify(repos), String(req.body?.detail || '').slice(0, 400)]);
  res.json({ ok: true, count: list.length, repos: repos.length });
});

// ---- the Scribe ------------------------------------------------------------

const scribe = agentClient('scribe');

// The files in scope for one project, weakest first: the personal file, the
// repo root, then nested. Library bodies win over reported ones — the library
// is what will be on disk after the next tick — but an unmanaged file still
// rides along, because leaving it out would hand the agent a tree that is
// missing exactly the rules nobody has looked at yet.
async function filesInScope(slug) {
  const [rows, report] = await Promise.all([libraryRows(), readReport()]);
  const key = (scope, s, dir) => `${scope}:${scope === 'project' ? s : ''}:${dir}`;
  const out = new Map();
  for (const f of report.files) {
    if (f.scope === 'project' && (f.slug || '') !== slug) continue;
    out.set(key(f.scope, f.slug, f.dir), {
      path: displayPath(f.scope, f.dir || ''),
      scope: f.scope, dir: f.dir || '', body: String(f.body || ''), managed: f.managed === true,
    });
  }
  for (const r of rows) {
    if (!r.enabled) continue;
    if (r.scope === 'project' && (r.slug || '') !== slug) continue;
    out.set(key(r.scope, r.slug, r.dir || ''), {
      path: displayPath(r.scope, r.dir || ''),
      scope: r.scope, dir: r.dir || '', body: String(r.body || ''), managed: true,
    });
  }
  return [...out.values()].sort((a, b) => {
    const rank = (f) => (f.scope === 'global' ? 0 : f.dir ? 2 + f.dir.split('/').length : 1);
    return rank(a) - rank(b) || a.path.localeCompare(b.path);
  });
}

const renderTree = (files) => files
  .map((f) => `--- ${f.path}${f.managed ? '' : ' (not managed by Stack — read only)'} ---\n${f.body.trim() || '(empty)'}`)
  .join('\n\n');

// POST /draft — the Scribe answers a request about the tree with a PROPOSAL.
//
// The answer is rules in and rules out, never a rewritten file: the parser
// splices by line range precisely so nothing unmodelled is lost, and handing
// back a whole regenerated body would throw that away at the last step. `null`
// is a real answer and the prompt says so out loud — a model told to produce a
// change will produce one, and what comes back when there was nothing to change
// is a plausible rule nobody needed.
instructions.post('/draft', async (req, res) => {
  const slug = String(req.body?.slug || '');
  const ask = String(req.body?.ask || '').trim().slice(0, 2000);
  if (!ask) return res.status(400).json({ error: 'Say what you want changed.' });
  const files = await filesInScope(slug);
  if (!files.length) {
    return res.status(400).json({ error: 'There are no instructions files in scope yet — add one first.' });
  }
  const history = (Array.isArray(req.body?.history) ? req.body.history : [])
    .slice(-6)
    .map((m) => `${m?.role === 'user' ? 'OWNER' : 'YOU'}: ${String(m?.text || '').slice(0, 1200)}`)
    .join('\n');

  const prompt = `The owner is editing the CLAUDE.md tree for the project "${slug || '(none)'}".
Here is every instructions file in scope, weakest precedence first. The closest file to an edit wins.

${renderTree(files)}

${history ? `The conversation so far:\n${history}\n\n` : ''}The owner now says:
${ask}

Answer in two parts.

"reply" is what you say to them: what the file currently does, what is actually wrong with it, and
what you propose. Two or three sentences. Plain prose, no markdown headings, no preamble.

"diff" is the change, or null. It names ONE file by its path exactly as written above, ONE section
heading, the rule texts to REMOVE (each matching an existing rule's wording closely enough to find
it) and the rule texts to ADD. Keep added rules to one instruction each: a rule that hides two
instructions in one sentence is the defect you are most often being asked to fix.

**"diff": null is a real and often correct answer.** Return it whenever the tree already says what
they are asking for, when the request is a question rather than a change, or when you would have to
invent a convention nobody has followed. Do not manufacture a change to have something to show.

Never propose a change to a file marked "not managed by Stack" — say in "reply" that it would have
to be adopted first.

Respond with ONLY this JSON:
{"reply": "...", "diff": {"path": "...", "section": "...", "remove": ["..."], "add": ["..."]}}`;

  try {
    const out = await scribe.ask('ruledraft', prompt, { timeoutMs: 240_000 });
    const d = out?.diff;
    const paths = new Set(files.map((f) => f.path));
    // A path the model invented is dropped rather than rendered: an Apply
    // button pointed at a file that does not exist is worse than no button.
    const diff = d && typeof d === 'object' && paths.has(String(d.path || ''))
      ? {
        path: String(d.path),
        section: String(d.section || '').slice(0, 120),
        remove: (Array.isArray(d.remove) ? d.remove : []).slice(0, 10).map((s) => String(s).slice(0, 600)),
        add: (Array.isArray(d.add) ? d.add : []).slice(0, 10).map((s) => String(s).slice(0, 600)),
      }
      : null;
    res.json({
      reply: String(out?.reply || '').slice(0, 4000),
      diff: diff && (diff.remove.length || diff.add.length) ? diff : null,
    });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message });
  }
});

const PASSES = {
  contradictions: {
    title: 'Contradictions',
    ask: `Find rules that FIGHT each other across the tree — one file forbidding what another requires,
or two rules in one file that cannot both be followed. Say which two, and where. A pair that looks
like a conflict but has an obvious reason (a package that genuinely needs the opposite rule) is worth
reporting only if neither file says why.`,
    action: 'the shortest honest fix',
  },
  missing: {
    title: 'Missing conventions',
    ask: `Find conventions these files DO NOT state but plainly assume — a rule that only makes sense
if some unwritten one is also true, a section that covers three of four obvious cases, a command
referred to but never defined. Report the gap, not a wish list of best practices.`,
    action: 'the rule to add',
  },
  tighten: {
    title: 'Tighten wording',
    ask: `Find rules a model would have to GUESS at: preferences phrased as instructions, adjectives
doing the work of a rule, two instructions hidden in one sentence, a paragraph that spends its words
on framing before the first actionable fact.`,
    action: 'how to say it',
  },
  budget: {
    title: 'Token budget',
    ask: `Find what the merged context is SPENDING for nothing: switched-off rules still carried in the
file, restatements of something a file above already said, framing that costs tokens and changes no
behaviour. Say roughly what each costs.`,
    action: 'what to cut',
  },
};

// POST /scan — the four read-only passes. Gemini, key-gated, and it never
// writes: every finding is a sentence and a place, and the owner does the
// editing. Same standing rule as every other Gemini surface in the app.
instructions.post('/scan', async (req, res) => {
  const pass = PASSES[String(req.body?.pass || '')] ? String(req.body.pass) : 'contradictions';
  const slug = String(req.body?.slug || '');
  const files = await filesInScope(slug);
  if (!files.length) {
    return res.status(400).json({ error: 'There are no instructions files in scope yet — add one first.' });
  }
  const spec = PASSES[pass];
  const prompt = `You are reading the CLAUDE.md instruction tree for the project "${slug || '(none)'}".
These files are what an AI coding agent is told before it touches this repo. They are listed weakest
precedence first; the file closest to an edit wins.

${renderTree(files)}

${spec.ask}

For each finding give: "text" (one or two sentences saying what is wrong — quote the wording you
mean), "where" (the file path and section, exactly as written above) and "action" (two or three words
naming ${spec.action}).

**Returning an empty list is a real answer and often the right one.** These files may simply be fine
for this pass. Do not pad the list to look useful; a finding nobody acts on costs more than silence.
Report at most six, worst first.

Respond with ONLY this JSON:
{"items": [{"text": "...", "where": "...", "action": "..."}]}`;

  try {
    const out = await scribe.ask('rulescan', prompt, { timeoutMs: 45_000 });
    const items = (Array.isArray(out?.items) ? out.items : []).slice(0, 6).map((it) => ({
      text: String(it?.text || '').slice(0, 600),
      where: String(it?.where || '').slice(0, 200),
      action: String(it?.action || '').slice(0, 40),
    })).filter((it) => it.text);
    res.json({
      pass,
      title: spec.title,
      // The meta line says what was READ, not what was found — a pass over four
      // files that found nothing has to read as a pass that ran.
      meta: `${files.length} file${files.length === 1 ? '' : 's'} read · ${items.length} found`,
      items,
    });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message });
  }
});
