import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { fingerprint, oneOf, BUCKETS } from '../util.js';
import { roadmapItemShape, groupRoadmap } from '../shape.js';
import { askGemini, geminiEnabled } from '../gemini.js';
import { buildPrompt } from '../prompts.js';

// Mounted at /api/projects/:slug/roadmap.
export const roadmap = Router({ mergeParams: true });

roadmap.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

// GET  /  -> grouped MoSCoW roadmap
roadmap.get('/', async (req, res) => {
  const { rows } = await q(
    'SELECT * FROM roadmap_items WHERE project_id = $1 ORDER BY bucket, position, created_at',
    [req.project.id]
  );
  res.json(groupRoadmap(rows));
});

// POST /  -> create a manual roadmap item (optionally pre-claimed to a lane)
roadmap.post('/', async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 300);
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  const bucket = oneOf(req.body?.bucket, BUCKETS, 'should');
  const claimedBy = String(req.body?.claimed_by || '').trim().slice(0, 100) || null;
  const area = String(req.body?.area || '').trim().toLowerCase().slice(0, 40) || null;

  const { rows: pos } = await q(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM roadmap_items WHERE project_id = $1 AND bucket = $2',
    [req.project.id, bucket]
  );
  const { rows } = await q(
    `INSERT INTO roadmap_items (project_id, bucket, title, note, position, source, fingerprint, claimed_by, area)
     VALUES ($1,$2,$3,$4,$5,'manual',$6,$7,$8) RETURNING *`,
    [req.project.id, bucket, title, note, pos[0].p, fingerprint(title), claimedBy, area]
  );
  res.status(201).json(roadmapItemShape(rows[0]));
});

// PATCH /:id  -> done toggle, bucket move, title/note edit, reorder, reviewed,
//                claim/release (claimed_by), archive-review verdict (review_tag)
roadmap.patch('/:id', async (req, res) => {
  const sets = [];
  const vals = [];
  let i = 1;
  if (req.body?.reviewed !== undefined) {
    sets.push(`reviewed_at = ${req.body.reviewed ? 'now()' : 'NULL'}`);
  }
  if (req.body?.claimed_by !== undefined) {
    sets.push(`claimed_by = $${i++}`);
    vals.push(String(req.body.claimed_by || '').trim().slice(0, 100) || null);
  }
  if (req.body?.review_tag !== undefined) {
    const tag = String(req.body.review_tag || '').trim();
    sets.push(`review_tag = $${i++}`);
    vals.push(['solid', 'needs-work', 'rethink'].includes(tag) ? tag : null);
  }
  if (req.body?.skipped !== undefined) {
    sets.push(`skipped = $${i++}`); vals.push(Boolean(req.body.skipped));
  }
  if (req.body?.done !== undefined) {
    sets.push(`done = $${i++}`); vals.push(Boolean(req.body.done));
    // Completing an item is a human touch — it counts as reviewed, so archived
    // items never linger in the review inbox.
    if (req.body.done) sets.push('reviewed_at = COALESCE(reviewed_at, now())');
  }
  if (req.body?.bucket !== undefined) { sets.push(`bucket = $${i++}`); vals.push(oneOf(req.body.bucket, BUCKETS, 'should')); }
  if (req.body?.title !== undefined) {
    const title = String(req.body.title).trim().slice(0, 300);
    if (title) { sets.push(`title = $${i++}`); vals.push(title); }
  }
  if (req.body?.note !== undefined) { sets.push(`note = $${i++}`); vals.push(String(req.body.note).slice(0, 1000)); }
  if (req.body?.area !== undefined) {
    sets.push(`area = $${i++}`);
    vals.push(String(req.body.area || '').trim().toLowerCase().slice(0, 40) || null);
  }
  if (req.body?.built_note !== undefined) {
    sets.push(`built_note = $${i++}`);
    vals.push(String(req.body.built_note || '').trim().slice(0, 2000) || null);
  }
  if (req.body?.position !== undefined && Number.isFinite(req.body.position)) {
    sets.push(`position = $${i++}`); vals.push(Math.trunc(req.body.position));
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

  vals.push(req.project.id, Number(req.params.id));
  const { rows } = await q(
    `UPDATE roadmap_items SET ${sets.join(', ')}, updated_at = now()
      WHERE project_id = $${i++} AND id = $${i} RETURNING *`,
    vals
  );
  if (!rows.length) return res.status(404).json({ error: 'No such roadmap item.' });
  res.json(roadmapItemShape(rows[0]));
});

// POST /suggest-title  -> Gemini titles an item from its note (the ✧ button in
// the modal). Suggestion only — the human applies or ignores it. 503 keyless.
roadmap.post('/suggest-title', async (req, res) => {
  if (!geminiEnabled()) {
    return res.status(503).json({ error: 'Gemini is not configured on this server (set GEMINI_API_KEY).' });
  }
  const note = String(req.body?.note || '').trim().slice(0, 2000);
  if (!note) return res.status(400).json({ error: 'Write the note first — the title comes from it.' });
  const prompt = buildPrompt('titler', {
    NOTE: note,
    NORTH_STAR_LINE: req.project.north_star
      ? `For context, the project's north star: "${String(req.project.north_star).slice(0, 400)}"`
      : '',
  });
  try {
    const answer = await askGemini(prompt, { timeoutMs: 20_000 });
    const title = String(answer?.title || '').trim().slice(0, 300);
    if (!title) return res.status(502).json({ error: 'Gemini returned nothing usable.' });
    res.json({ title });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Gemini call failed.' });
  }
});

// POST /assist  -> Gemini fills the whole item from its note (the modal's ✧
// button): title, tidied note, area, lane, priority. Suggestion only — it
// prefills the fields and the human saves (or doesn't). 503 keyless.
roadmap.post('/assist', async (req, res) => {
  if (!geminiEnabled()) {
    return res.status(503).json({ error: 'Gemini is not configured on this server (set GEMINI_API_KEY).' });
  }
  const note = String(req.body?.note || '').trim().slice(0, 4000);
  if (!note) return res.status(400).json({ error: 'Write the note first — everything comes from it.' });
  const [{ rows: areaRows }, { rows: laneRows }] = await Promise.all([
    q(
      `SELECT DISTINCT area FROM roadmap_items WHERE project_id = $1 AND area IS NOT NULL
       UNION SELECT DISTINCT area FROM futures WHERE project_id = $1 AND area IS NOT NULL`,
      [req.project.id]
    ),
    q(
      `SELECT DISTINCT claimed_by AS lane FROM roadmap_items
        WHERE project_id = $1 AND claimed_by IS NOT NULL AND NOT done`,
      [req.project.id]
    ),
  ]);
  const lanes = laneRows.map((r) => r.lane);
  const prompt = buildPrompt('assist', {
    NOTE: note,
    AREAS: areaRows.map((r) => r.area).join(', ') || '(none yet)',
    LANES: lanes.join(', ') || '(none)',
    NORTH_STAR_LINE: req.project.north_star
      ? `For context, the project's north star: "${String(req.project.north_star).slice(0, 400)}"`
      : '',
  });
  try {
    const answer = await askGemini(prompt, { timeoutMs: 25_000 });
    const title = String(answer?.title || '').trim().slice(0, 300);
    if (!title) return res.status(502).json({ error: 'Gemini returned nothing usable.' });
    res.json({
      title,
      note: String(answer?.note || '').trim().slice(0, 1000) || note,
      area: String(answer?.area || '').trim().toLowerCase().slice(0, 40),
      // A lane claims work for a stream — only ever suggest one that already exists.
      lane: lanes.includes(String(answer?.lane || '').trim()) ? String(answer.lane).trim() : '',
      priority: BUCKETS.includes(answer?.priority) ? answer.priority : null,
    });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Gemini call failed.' });
  }
});

// POST /cleanup  -> Gemini reviews the OPEN board and suggests fixes: areas
// for untagged items, cleaned titles, honest buckets. Suggestions only — the
// client shows them for the human to apply through the normal PATCH. 503 keyless.
roadmap.post('/cleanup', async (req, res) => {
  if (!geminiEnabled()) {
    return res.status(503).json({ error: 'Gemini is not configured on this server (set GEMINI_API_KEY).' });
  }
  const { rows } = await q(
    `SELECT id, bucket, area, title, note FROM roadmap_items
      WHERE project_id = $1 AND NOT done ORDER BY bucket, position`,
    [req.project.id]
  );
  if (!rows.length) return res.json({ items: [] });
  const openById = new Map(rows.map((r) => [r.id, r]));
  const prompt = buildPrompt('cleanup', {
    ITEMS: rows.map((r) =>
      `${r.id} | ${r.bucket} | ${r.area || '-'} | ${r.title} | ${(r.note || '-').slice(0, 300)}`).join('\n'),
    AREAS: [...new Set(rows.map((r) => r.area).filter(Boolean))].join(', ') || '(none yet)',
    NORTH_STAR_LINE: req.project.north_star
      ? `For context, the project's north star: "${String(req.project.north_star).slice(0, 400)}"`
      : '',
  });
  try {
    const answer = await askGemini(prompt, { timeoutMs: 30_000 });
    const items = (Array.isArray(answer?.items) ? answer.items : [])
      .filter((s) => openById.has(Number(s?.id)))
      .map((s) => {
        const cur = openById.get(Number(s.id));
        const area = String(s.area || '').trim().toLowerCase().slice(0, 40);
        const title = String(s.title || '').trim().slice(0, 300);
        const bucket = BUCKETS.includes(s.bucket) ? s.bucket : '';
        return {
          id: cur.id,
          currentTitle: cur.title,
          // Only echo fields that actually change something.
          ...(area && area !== (cur.area || '') ? { area } : {}),
          ...(title && title !== cur.title ? { title } : {}),
          ...(bucket && bucket !== cur.bucket ? { bucket } : {}),
          why: String(s.why || '').trim().slice(0, 200),
        };
      })
      .filter((s) => s.area || s.title || s.bucket);
    res.json({ items });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Gemini call failed.' });
  }
});

// DELETE /:id  -> remove; auto (hook) items leave a tombstone
roadmap.delete('/:id', async (req, res) => {
  const { rows } = await q(
    'DELETE FROM roadmap_items WHERE project_id = $1 AND id = $2 RETURNING source, fingerprint',
    [req.project.id, Number(req.params.id)]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such roadmap item.' });
  if (rows[0].source === 'hook') {
    await q(
      `INSERT INTO dismissed_items (project_id, kind, fingerprint)
       VALUES ($1,'roadmap',$2) ON CONFLICT DO NOTHING`,
      [req.project.id, rows[0].fingerprint]
    );
  }
  res.json({ ok: true });
});
