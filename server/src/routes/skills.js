import { Router } from 'express';
import { q } from '../db.js';

// The SKILL TREE (roadmap #228) — a managed library of Claude Code skills that
// Stack owns, so how Claude works across the fleet is tuned from one place
// instead of by hand-editing files on the host.
//
// The server CANNOT see ~/.claude: it runs in a container, the skills live on
// the host behind the firewall. So this is the preview pattern (#208), not a
// pretence otherwise — the server holds the library and the intent, the HOST
// does the writing, and the host reports back what is really on disk. Nothing
// in this file touches a filesystem.
//
// The rule the whole feature rests on: **Stack only ever writes or removes
// skills it planted.** The host marks its own with a `.stack-managed` file
// inside the skill directory, and a skill without that marker is reported and
// never touched. A tool that manages your files has to be trustworthy about
// the ones it did not create.
export const skills = Router();

const SCOPES = ['global', 'project'];
// The report is a snapshot of somebody's disk, so it is capped on both axes.
// Bodies ride along so an UNMANAGED skill can be adopted into the library
// without a second round trip to the host.
const REPORT_MAX = 60;
const BODY_MAX = 16_000;

// kebab-case, and it IS a directory name — so this doubles as the guard that
// keeps a skill name from escaping the skills directory. No dots, no slashes.
const cleanName = (v) => String(v ?? '').trim().toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

const shape = (r) => ({
  id: r.id,
  name: r.name,
  scope: r.scope,
  slug: r.slug ?? '',                  // the project's slug, '' for global
  description: r.description || '',
  body: r.body || '',
  enabled: r.enabled,
  installedAt: r.installed_at ? new Date(r.installed_at).toISOString() : null,
  updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
});

// One SKILL.md, exactly as it lands on disk. Frontmatter is YAML, and a
// description is one line there — newlines would break the block, so they are
// folded rather than trusted.
export const skillFile = (s) => {
  const desc = (s.description || '').replace(/\s+/g, ' ').trim();
  return `---\nname: ${s.name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${(s.body || '').trim()}\n`;
};

const readReport = async () => {
  const { rows } = await q('SELECT * FROM skill_reports WHERE only_row');
  if (!rows.length) return { skills: [], detail: '', when: null };
  return {
    skills: Array.isArray(rows[0].report) ? rows[0].report : [],
    detail: rows[0].detail || '',
    when: rows[0].reported_at ? new Date(rows[0].reported_at).toISOString() : null,
  };
};

const libraryRows = async () => {
  const { rows } = await q(
    `SELECT s.*, p.slug FROM skills s
       LEFT JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
      ORDER BY s.scope, p.slug NULLS FIRST, s.name`);
  return rows;
};

// Resolve the project a 'project'-scoped skill belongs to. A scope of
// 'project' with no resolvable slug is a contradiction, so it is refused
// rather than quietly filed as global.
const resolveProject = async (slug) => {
  if (!slug) return null;
  const { rows } = await q(
    'SELECT id, slug FROM projects WHERE slug = $1 AND deleted_at IS NULL', [String(slug)]);
  return rows[0] || null;
};

// GET / — the library plus what the host last reported on disk. One call, so
// the screen can render the tree AND the drift between them together: a
// managed skill missing from disk, and a disk skill nobody manages, are both
// things you only see by holding the two lists side by side.
skills.get('/', async (_req, res) => {
  const [rows, report] = await Promise.all([libraryRows(), readReport()]);
  res.json({ skills: rows.map(shape), report });
});

skills.post('/', async (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'A skill needs a name.' });
  const scope = SCOPES.includes(req.body?.scope) ? req.body.scope : 'global';
  const project = scope === 'project' ? await resolveProject(req.body?.slug) : null;
  if (scope === 'project' && !project) {
    return res.status(400).json({ error: 'A project skill needs a project that exists.' });
  }
  try {
    const { rows } = await q(
      `INSERT INTO skills (name, scope, project_id, description, body, enabled)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, scope, project?.id ?? null,
        String(req.body?.description || '').slice(0, 1000),
        String(req.body?.body || '').slice(0, 100_000),
        req.body?.enabled !== false]);
    res.status(201).json(shape({ ...rows[0], slug: project?.slug ?? '' }));
  } catch (e) {
    // The partial unique indexes: one skill of a name per place.
    if (e.code === '23505') {
      return res.status(409).json({ error: `A ${scope} skill called "${name}" already exists.` });
    }
    throw e;
  }
});

skills.patch('/:id', async (req, res) => {
  const { rows: cur } = await q('SELECT * FROM skills WHERE id = $1', [req.params.id]);
  if (!cur.length) return res.status(404).json({ error: 'No such skill.' });
  const sets = [];
  const vals = [];
  let i = 1;
  if (req.body?.name !== undefined) {
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'A skill needs a name.' });
    sets.push(`name = $${i++}`); vals.push(name);
  }
  if (req.body?.description !== undefined) {
    sets.push(`description = $${i++}`); vals.push(String(req.body.description).slice(0, 1000));
  }
  if (req.body?.body !== undefined) {
    sets.push(`body = $${i++}`); vals.push(String(req.body.body).slice(0, 100_000));
  }
  if (req.body?.enabled !== undefined) {
    sets.push(`enabled = $${i++}`); vals.push(req.body.enabled === true);
  }
  if (req.body?.scope !== undefined && SCOPES.includes(req.body.scope)) {
    const project = req.body.scope === 'project' ? await resolveProject(req.body?.slug) : null;
    if (req.body.scope === 'project' && !project) {
      return res.status(400).json({ error: 'A project skill needs a project that exists.' });
    }
    sets.push(`scope = $${i++}`); vals.push(req.body.scope);
    sets.push(`project_id = $${i++}`); vals.push(project?.id ?? null);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  // Any edit to WHAT gets written invalidates the install: the row no longer
  // describes what is on disk, and the tree must say so until the host has
  // caught up. Only `enabled` toggling off is different — that is a removal,
  // and the host clears installed_at itself when it removes the directory.
  const touchesContent = ['name', 'description', 'body', 'scope'].some((k) => req.body?.[k] !== undefined);
  if (touchesContent) sets.push('installed_at = NULL');
  vals.push(req.params.id);
  try {
    const { rows } = await q(
      `UPDATE skills SET ${sets.join(', ')}, updated_at = now() WHERE id = $${i} RETURNING *`, vals);
    const { rows: p } = rows[0].project_id
      ? await q('SELECT slug FROM projects WHERE id = $1', [rows[0].project_id])
      : { rows: [] };
    res.json(shape({ ...rows[0], slug: p[0]?.slug ?? '' }));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A skill of that name already exists there.' });
    throw e;
  }
});

// DELETE — out of the library, which is also the instruction to remove it from
// disk. The host takes the difference on its next sync; it is gone here
// immediately, and gone there within a tick.
skills.delete('/:id', async (req, res) => {
  await q('DELETE FROM skills WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---- the host's two endpoints ---------------------------------------------

// GET /work — everything the host needs to make disk match the library, with
// no logic left on the host's side beyond writing and deleting. `write` is the
// enabled set with its file content already rendered; `keep` is every managed
// name the host should still find, so anything managed and NOT in it can be
// removed. Sending `keep` rather than a `remove` list is deliberate: the server
// does not know what is on disk, and a diff computed from a stale report would
// delete a skill that had only just been written.
skills.get('/work', async (_req, res) => {
  const rows = await libraryRows();
  const place = (r) => (r.scope === 'project' ? { scope: 'project', slug: r.slug || '' } : { scope: 'global', slug: '' });
  const enabled = rows.filter((r) => r.enabled && !(r.scope === 'project' && !r.slug));
  res.json({
    write: enabled.map((r) => ({
      id: r.id, name: r.name, ...place(r), content: skillFile(r),
      // The host writes only when content differs, and reports back on the
      // ones it actually wrote — so a steady state costs nothing.
      installed: !!r.installed_at,
    })),
    keep: enabled.map((r) => ({ name: r.name, ...place(r) })),
  });
});

// POST /report — the host's snapshot of disk, plus which library ids it just
// installed. Replaces the report whole, like the branch report (#207).
skills.post('/report', async (req, res) => {
  const list = (Array.isArray(req.body?.skills) ? req.body.skills : [])
    .map((s) => (s && typeof s === 'object' ? {
      name: cleanName(s.name),
      scope: SCOPES.includes(s.scope) ? s.scope : 'global',
      slug: String(s.slug || '').slice(0, 80),
      path: String(s.path || '').slice(0, 300),
      managed: s.managed === true,
      description: String(s.description || '').replace(/\s+/g, ' ').slice(0, 1000),
      body: String(s.body || '').slice(0, BODY_MAX),
    } : null))
    .filter((s) => s && s.name)
    .slice(0, REPORT_MAX);

  const installed = (Array.isArray(req.body?.installed) ? req.body.installed : [])
    .map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
  if (installed.length) {
    await q('UPDATE skills SET installed_at = now() WHERE id = ANY($1)', [installed]);
  }
  // A skill the host reports as absent is not installed, whatever we thought.
  // This is what makes the tree honest after somebody deletes a directory by
  // hand: the row goes back to "not on disk" rather than claiming an install
  // that no longer exists.
  const present = list.filter((s) => s.managed).map((s) => `${s.scope}:${s.slug}:${s.name}`);
  await q(
    `UPDATE skills SET installed_at = NULL
      WHERE installed_at IS NOT NULL
        AND (scope || ':' || COALESCE((SELECT slug FROM projects WHERE id = skills.project_id), '') || ':' || name)
            <> ALL($1::text[])`,
    [present]);

  await q(
    `INSERT INTO skill_reports (only_row, report, detail, reported_at)
     VALUES (TRUE, $1::jsonb, $2, now())
     ON CONFLICT (only_row) DO UPDATE
       SET report = EXCLUDED.report, detail = EXCLUDED.detail, reported_at = now()`,
    [JSON.stringify(list), String(req.body?.detail || '').slice(0, 400)]);
  res.json({ ok: true, count: list.length });
});
