import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { fingerprint } from '../util.js';
import { futureShape } from '../shape.js';
import { buildPrompt } from '../prompts.js';
import { agentClient } from '../agents.js';

// Mounted at /api/projects/:slug/futures. Futures are loose directional ideas
// curated against the project's north star; promotion to the roadmap is a
// client flow (create the roadmap item, then delete the idea — the delete
// below tombstones a hook idea so the next push won't re-extract it).
export const futures = Router({ mergeParams: true });

futures.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

// #361 — the ✧ surfaces here are POLARIS, the Futures tab's agent, bound once.
// It owns judging, theming and converging the funnel and nothing else: an
// attempt to run the Curator's board cleanup or the Auditor's audit through
// this client throws rather than crossing tabs. `refused` renders its gate as
// a response — `true` means the reply is already sent.
const polaris = agentClient('polaris');
const refused = async (op, res) => {
  try {
    await polaris.gate(op);
    return false;
  } catch (err) {
    res.status(err.httpStatus || 503).json({ error: err.message });
    return true;
  }
};

// GET  /  -> list, newest first
futures.get('/', async (req, res) => {
  const { rows } = await q(
    'SELECT * FROM futures WHERE project_id = $1 ORDER BY created_at DESC',
    [req.project.id]
  );
  res.json(rows.map(futureShape));
});

// POST /  -> create a manual idea
futures.post('/', async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 300);
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const note = String(req.body?.note || '').trim().slice(0, 1000);

  const { rows } = await q(
    `INSERT INTO futures (project_id, title, note, source, fingerprint)
     VALUES ($1,$2,$3,'manual',$4) RETURNING *`,
    [req.project.id, title, note, fingerprint(title)]
  );
  res.status(201).json(futureShape(rows[0]));
});

// The galaxy's shape rules (#312), enforced here because the client derives
// what a thing IS from where it sits: a star holds planets, a planet holds
// moons, and that is the whole depth. Returns an error string, or null when the
// move is legal. `id` is the idea being moved, `pid` the idea it would orbit.
async function checkAdoption(projectId, id, pid) {
  const { rows } = await q(
    'SELECT id, is_star, parent_id FROM futures WHERE project_id = $1 AND id = $2',
    [projectId, pid]
  );
  if (!rows.length) return 'No such idea to orbit.';
  const target = rows[0];
  // The only cycle two levels can make: the target already orbits this idea.
  if (target.parent_id === id) return 'That idea already orbits this one.';
  if (!target.is_star) {
    const { rows: up } = await q(
      'SELECT is_star FROM futures WHERE project_id = $1 AND id = $2',
      [projectId, target.parent_id]
    );
    // A moon cannot be orbited — star → planet → moon is the whole depth.
    if (!up[0]?.is_star) return 'Only a star or a planet can be orbited. Promote it to a star first.';
    const { rows: kids } = await q('SELECT 1 FROM futures WHERE parent_id = $1 LIMIT 1', [id]);
    if (kids.length) return 'This idea already carries moons of its own — only a star can adopt it.';
  }
  return null;
}

// PATCH /:id  -> title/note edit, reviewed (the review inbox), alignment (the
//                north-star curation verdict; '' clears back to unsorted), and
//                the galaxy's three: parentId, isStar, magnitude (#312)
futures.patch('/:id', async (req, res) => {
  const sets = [];
  const vals = [];
  let i = 1;
  const id = Number(req.params.id);
  // Setting a parent DEMOTES a star (adopting one is exactly that), so the two
  // are resolved together and only one of them ever reaches the statement.
  const adopting = req.body?.parentId !== undefined && req.body.parentId !== null;
  if (req.body?.parentId !== undefined) {
    const pid = req.body.parentId === null ? null : Number(req.body.parentId);
    if (pid !== null) {
      if (!Number.isInteger(pid) || pid === id) {
        return res.status(400).json({ error: 'An idea cannot orbit itself.' });
      }
      const why = await checkAdoption(req.project.id, id, pid);
      if (why) return res.status(400).json({ error: why });
    }
    sets.push(`parent_id = $${i++}`);
    vals.push(pid);
    if (pid !== null) sets.push('is_star = false');
  }
  if (req.body?.isStar !== undefined && !adopting) {
    // A star has no parent by definition — promoting cuts the old orbit, and
    // its moons come with it as planets (their parent is unchanged; it is the
    // parent's new is_star that renames them).
    sets.push(req.body.isStar ? 'is_star = true, parent_id = NULL' : 'is_star = false');
  }
  if (req.body?.magnitude !== undefined) {
    const m = req.body.magnitude === null ? null : Number(req.body.magnitude);
    sets.push(`magnitude = $${i++}`);
    vals.push(m !== null && Number.isInteger(m) && m >= 1 && m <= 5 ? m : null);
  }
  if (req.body?.reviewed !== undefined) {
    sets.push(`reviewed_at = ${req.body.reviewed ? 'now()' : 'NULL'}`);
  }
  if (req.body?.alignment !== undefined) {
    const a = String(req.body.alignment || '').trim();
    sets.push(`alignment = $${i++}`);
    vals.push(['on-course', 'tangent', 'off-course'].includes(a) ? a : null);
  }
  if (req.body?.title !== undefined) {
    const title = String(req.body.title).trim().slice(0, 300);
    if (title) { sets.push(`title = $${i++}`); vals.push(title); }
  }
  if (req.body?.note !== undefined) { sets.push(`note = $${i++}`); vals.push(String(req.body.note).slice(0, 1000)); }
  if (req.body?.area !== undefined) {
    sets.push(`area = $${i++}`);
    vals.push(String(req.body.area || '').trim().toLowerCase().slice(0, 40) || null);
  }
  if (req.body?.canvasX !== undefined) {
    const v = req.body.canvasX === null ? null : Number(req.body.canvasX);
    sets.push(`x_coord = $${i++}`);
    vals.push(v !== null && Number.isFinite(v) && v >= 0 && v <= 20000 ? v : null);
  }
  if (req.body?.canvasY !== undefined) {
    const v = req.body.canvasY === null ? null : Number(req.body.canvasY);
    sets.push(`y_coord = $${i++}`);
    vals.push(v !== null && Number.isFinite(v) && v >= 0 && v <= 20000 ? v : null);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

  // Un-starring back to a loose idea is the one move that would orphan a
  // branch — nothing loose can hold planets — so the same statement returns its
  // planets to the north star's shells. One CTE rather than two round trips:
  // the two writes have to agree or the sky renders a shape with no name.
  // Only the planets are cut: a moon keeps pointing at its planet, so the
  // client draws it loose for now and it becomes a moon again the moment that
  // planet gets a star. Forgetting the relationship would be the lossy choice.
  const detach = req.body?.isStar === false && !adopting;
  vals.push(req.project.id, id);
  const pIdx = i, idIdx = i + 1;
  const update = `UPDATE futures SET ${sets.join(', ')}, updated_at = now()
      WHERE project_id = $${pIdx} AND id = $${idIdx} RETURNING *`;
  const { rows } = await q(
    detach
      ? `WITH upd AS (${update}), loose AS (
           UPDATE futures SET parent_id = NULL, updated_at = now()
            WHERE project_id = $${pIdx} AND parent_id = $${idIdx}
         ) SELECT * FROM upd`
      : update,
    vals
  );
  if (!rows.length) return res.status(404).json({ error: 'No such idea.' });
  res.json(futureShape(rows[0]));
});

// POST /:id/judge  -> ask Gemini for a SUGGESTED alignment verdict against the
// project's north star. Nothing is written — the client shows the suggestion
// and the human clicks the actual verdict (Gemini proposes, you dispose).
// 503 when the server has no GEMINI_API_KEY.
futures.post('/:id/judge', async (req, res) => {
  if (await refused('judge', res)) return;
  const { rows } = await q(
    'SELECT * FROM futures WHERE project_id = $1 AND id = $2',
    [req.project.id, Number(req.params.id)]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such idea.' });
  const idea = rows[0];
  const northStar = String(req.project.north_star || '').trim();
  if (!northStar) {
    return res.status(400).json({ error: 'This project has no north star to judge against yet.' });
  }

  const prompt = buildPrompt('judge', {
    NORTH_STAR: northStar,
    TITLE: idea.title,
    NOTE_LINE: idea.note ? `Note: ${idea.note}` : '',
  });

  try {
    const answer = await polaris.ask('judge', prompt);
    const alignment = ['on-course', 'tangent', 'off-course'].includes(answer?.alignment)
      ? answer.alignment : null;
    if (!alignment) return res.status(502).json({ error: 'Gemini gave an unusable answer — try again.' });
    res.json({ alignment, why: String(answer.why || '').slice(0, 300) });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || 'Gemini call failed.' });
  }
});

// POST /cluster  -> Gemini groups the funnel into themes: a suggested `area`
// for every idea whose theme is missing or clearly wrong (the Polaris sky's
// bearings). Suggestions only — the client shows them grouped and the human
// applies through the normal PATCH. 503 keyless.
futures.post('/cluster', async (req, res) => {
  if (await refused('cluster', res)) return;
  const { rows } = await q(
    'SELECT id, area, title, note FROM futures WHERE project_id = $1 ORDER BY created_at DESC',
    [req.project.id]
  );
  if (!rows.length) return res.json({ items: [] });
  const roadAreas = await q(
    `SELECT DISTINCT area FROM roadmap_items
      WHERE project_id = $1 AND area IS NOT NULL AND area <> ''`,
    [req.project.id]
  );
  const known = [...new Set([
    ...roadAreas.rows.map((r) => r.area),
    ...rows.map((r) => r.area).filter(Boolean),
  ])];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const prompt = buildPrompt('cluster', {
    ITEMS: rows.map((r) =>
      `${r.id} | ${r.area || '-'} | ${r.title} | ${(r.note || '-').slice(0, 200)}`).join('\n'),
    AREAS: known.join(', ') || '(none yet)',
    NORTH_STAR_LINE: req.project.north_star
      ? `For context, the project's north star: "${String(req.project.north_star).slice(0, 400)}"`
      : '',
  });
  try {
    const answer = await polaris.ask('cluster', prompt, { timeoutMs: 30_000 });
    const items = (Array.isArray(answer?.items) ? answer.items : [])
      .filter((s) => byId.has(Number(s?.id)))
      .map((s) => {
        const cur = byId.get(Number(s.id));
        const area = String(s.area || '').trim().toLowerCase().slice(0, 40);
        return { id: cur.id, currentTitle: cur.title, area };
      })
      .filter((s) => s.area && s.area !== (byId.get(s.id).area || ''));
    res.json({ items });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || 'Gemini call failed.' });
  }
});

// (#314) The funnel's orbit shape (#312) — star -> planet -> moon — has to
// reach the prompt, not just the flat id/area/verdict/title/note line: in
// `mode: 'epic'` the whole picked set is merged into ONE ticket, and a star
// with its planets is exactly the structure that merge needs to see. Pure
// (no db/req/Gemini) so it is unit-tested directly against rows, not a route.
export const CONVERGE_ITEMS_CAP = 20;

export function renderConvergeItems(rows, cap = CONVERGE_ITEMS_CAP) {
  if (!rows || !rows.length) return { text: '(none)', shown: 0, total: 0, ids: [] };

  const byId = new Map(rows.map((r) => [r.id, r]));
  const childrenOf = new Map();
  const roots = [];
  for (const r of rows) {
    const parentInSet = r.parent_id != null && byId.has(r.parent_id);
    if (parentInSet) {
      if (!childrenOf.has(r.parent_id)) childrenOf.set(r.parent_id, []);
      childrenOf.get(r.parent_id).push(r);
    } else {
      // No parent in the picked set — a genuine root, or an orphaned child
      // whose parent wasn't picked. Either way it falls back to given order.
      roots.push(r);
    }
  }

  // One family per root, walked depth-first (star -> its planets -> each
  // planet's moons) so a parent is immediately followed by its own orbit —
  // that ordering IS the structure epic mode needs. Families stay contiguous,
  // which is what makes the cap below family-aware for free.
  const families = roots.map((root) => {
    const fam = [];
    const walk = (r) => { fam.push(r); for (const c of childrenOf.get(r.id) || []) walk(c); };
    walk(root);
    return fam;
  });

  // Cap on the right axis (the #239 capped-list rule): never split a parent
  // from its own orbit, so whole FAMILIES are dropped rather than orphaning a
  // child whose parent made the cut but whose sibling didn't. A family bigger
  // than the cap on its own is still kept whole — truncating inside it would
  // be the exact split this exists to avoid.
  const total = rows.length;
  const kept = [];
  for (const fam of families) {
    if (kept.length && kept.length + fam.length > cap) break;
    kept.push(...fam);
  }

  const shown = kept.length;
  const lines = kept.map((r) => {
    const orbit = r.is_star ? 'star' : (r.parent_id != null ? `orbits ${r.parent_id}` : '-');
    return `${r.id} | ${r.area || '-'} | ${r.alignment || 'unjudged'} | ${orbit} | ${r.title} | ${(r.note || '-').slice(0, 300)}`;
  });
  const text = lines.join('\n')
    + (shown < total
      ? `\n(showing ${shown} of ${total} picked ideas — whole star/planet/moon families were kept together, others dropped)`
      : '');

  return { text, shown, total, ids: kept.map((r) => r.id) };
}

// POST /converge  -> Gemini drafts roadmap tickets from a picked set of ideas
// (the sky's converge tray): body {ids, mode: 'tickets'|'epic'}. Drafts only —
// the client shows them editable and creates through the normal roadmap POST;
// keyless the client falls back to direct-mapped drafts, so this route is the
// ✧ enrichment, not the flow. 503 keyless.
// A bound on the REQUEST, not on the prompt — well above CONVERGE_ITEMS_CAP so
// it never pre-empts the family-aware cap (that one decides what actually
// gets dropped; this one just stops a client posting ten thousand ids at SQL).
const CONVERGE_IDS_MAX = 200;

futures.post('/converge', async (req, res) => {
  if (await refused('converge', res)) return;
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(Number).filter(Number.isFinite).slice(0, CONVERGE_IDS_MAX);
  if (!ids.length) return res.status(400).json({ error: 'Pick at least one idea.' });
  const mode = req.body?.mode === 'epic' ? 'epic' : 'tickets';
  const { rows } = await q(
    'SELECT id, area, alignment, title, note, parent_id, is_star FROM futures WHERE project_id = $1 AND id = ANY($2::int[])',
    [req.project.id, ids]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such ideas.' });
  // No ORDER BY on the query above, so Postgres hands rows back in whatever
  // order it likes — but the client sends the tray in the sky's own
  // depth-first order (a parent immediately followed by its orbit), and
  // renderConvergeItems takes root order as given. Put the rows back in the
  // order they were picked before it decides what "given order" means.
  const pickOrder = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => (pickOrder.get(a.id) ?? 0) - (pickOrder.get(b.id) ?? 0));
  const { text: itemsText, ids: shownIds } = renderConvergeItems(rows);
  const okIds = new Set(shownIds);
  const prompt = buildPrompt('converge', {
    ITEMS: itemsText,
    MODE_LINE: mode === 'epic'
      ? 'MODE: merge ALL the ideas into ONE epic — a single ticket whose plan steps cover the set.'
      : 'MODE: one ticket per idea, each standing alone.',
    NORTH_STAR_LINE: req.project.north_star
      ? `The project's north star: "${String(req.project.north_star).slice(0, 400)}"`
      : '',
  });
  try {
    const answer = await polaris.ask('converge', prompt, { timeoutMs: 30_000 });
    const items = (Array.isArray(answer?.items) ? answer.items : [])
      .map((s) => ({
        title: String(s?.title || '').trim().slice(0, 300),
        note: String(s?.note || '').trim().slice(0, 1000),
        bucket: ['must', 'should', 'could'].includes(s?.bucket) ? s.bucket : 'should',
        area: String(s?.area || '').trim().toLowerCase().slice(0, 40),
        plan: (Array.isArray(s?.plan) ? s.plan : [])
          .map((p) => String(p || '').trim().slice(0, 200)).filter(Boolean).slice(0, 8),
        sources: (Array.isArray(s?.sources) ? s.sources : [])
          .map(Number).filter((n) => okIds.has(n)),
      }))
      .filter((s) => s.title)
      .slice(0, mode === 'epic' ? 1 : 20);
    if (!items.length) return res.status(502).json({ error: 'Gemini gave an unusable answer — try again.' });
    res.json({ items });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || 'Gemini call failed.' });
  }
});

// DELETE /:id  -> remove; auto (hook) ideas leave a tombstone
futures.delete('/:id', async (req, res) => {
  const { rows } = await q(
    'DELETE FROM futures WHERE project_id = $1 AND id = $2 RETURNING source, fingerprint',
    [req.project.id, Number(req.params.id)]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such idea.' });
  if (rows[0].source === 'hook') {
    await q(
      `INSERT INTO dismissed_items (project_id, kind, fingerprint)
       VALUES ($1,'future',$2) ON CONFLICT DO NOTHING`,
      [req.project.id, rows[0].fingerprint]
    );
  }
  res.json({ ok: true });
});
