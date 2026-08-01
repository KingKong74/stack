import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { fingerprint, oneOf, BUCKETS, cleanPlan, cleanReviewTags } from '../util.js';

// Risk tiers (#212) — graduated trust. 'low' lets a green overnight run
// auto-queue its own merge; anything else keeps the human on the merge button.
const RISKS = ['low', 'normal', 'high'];
// Desire tiers (#227) — the owner's ranking of what they want NEXT, distinct
// from the MoSCoW bucket's sizing. '' (→ NULL) = unranked, which sorts last.
const TIERS = ['S', 'A', 'B', 'C'];
const cleanTier = (v) => {
  const t = String(v ?? '').trim().toUpperCase();
  return TIERS.includes(t) ? t : null;
};
import { roadmapItemShape, groupRoadmap } from '../shape.js';
import { askGemini, geminiEnabled } from '../gemini.js';
import { buildPrompt } from '../prompts.js';
import { readSettings } from '../settings.js';

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
  const plan = cleanPlan(req.body?.plan);
  const risk = oneOf(req.body?.risk, RISKS, 'normal');
  const tier = cleanTier(req.body?.tier);

  const { rows: pos } = await q(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM roadmap_items WHERE project_id = $1 AND bucket = $2',
    [req.project.id, bucket]
  );
  const { rows } = await q(
    `INSERT INTO roadmap_items (project_id, bucket, title, note, position, source, fingerprint, claimed_by, area, plan, risk, tier)
     VALUES ($1,$2,$3,$4,$5,'manual',$6,$7,$8,$9::jsonb,$10,$11) RETURNING *`,
    [req.project.id, bucket, title, note, pos[0].p, fingerprint(title), claimedBy, area, JSON.stringify(plan), risk, tier]
  );
  res.status(201).json(roadmapItemShape(rows[0]));
});

// PATCH /:id  -> done toggle, bucket move, title/note edit, reorder, reviewed,
//                claim/release (claimed_by), archive-review verdict (review_tag),
//                review shelving (review_shelved, #148)
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
    const verdict = ['solid', 'needs-work', 'rethink'].includes(tag) ? tag : null;
    sets.push(`review_tag = $${i++}`);
    vals.push(verdict);
    // A verdict archives the item — it can't also sit on the review shelf
    // (#148). An explicit value in the same PATCH wins.
    if (verdict && req.body.review_shelved === undefined) sets.push('review_shelved = false');
  }
  if (req.body?.review_shelved !== undefined) {
    // Shelve a review (#148): the completed row leaves the main To-verify list
    // for the collapsed Shelved strip — to be reviewed later; false brings it back.
    sets.push(`review_shelved = $${i++}`); vals.push(Boolean(req.body.review_shelved));
  }
  if (req.body?.review_tags !== undefined) {
    // Review annotations (#146) — the whole list comes back each time, like plan.
    sets.push(`review_tags = $${i++}::jsonb`);
    vals.push(JSON.stringify(cleanReviewTags(req.body.review_tags)));
  }
  if (req.body?.refine_note !== undefined) {
    sets.push(`refine_note = $${i++}`);
    vals.push(String(req.body.refine_note || '').trim().slice(0, 2000) || null);
  }
  if (req.body?.skipped !== undefined) {
    sets.push(`skipped = $${i++}`); vals.push(Boolean(req.body.skipped));
    // Stamp the park so the Parked view can age it honestly (#247). Re-parking
    // an already-parked item keeps the original stamp — COALESCE — so a stray
    // PATCH doesn't reset the clock; unparking clears it.
    sets.push(req.body.skipped ? 'skipped_at = COALESCE(skipped_at, now())' : 'skipped_at = NULL');
  }
  if (req.body?.plan !== undefined) {
    // The whole plan comes back each time (#75) — agents tick a step by
    // re-sending the list with that step's done flipped.
    sets.push(`plan = $${i++}::jsonb`); vals.push(JSON.stringify(cleanPlan(req.body.plan)));
  }
  if (req.body?.done !== undefined) {
    sets.push(`done = $${i++}`); vals.push(Boolean(req.body.done));
    // Completing an item is a human touch — it counts as reviewed, so archived
    // items never linger in the review inbox. A fresh completion also clears
    // the refinement (it was addressed — #146) and last round's review tags
    // (each To-verify pass starts unannotated). Explicit values in the same
    // PATCH win — those columns are already SET above and can't go twice.
    if (req.body.done) {
      sets.push('reviewed_at = COALESCE(reviewed_at, now())');
      if (req.body.refine_note === undefined) sets.push('refine_note = NULL');
      if (req.body.review_tags === undefined) sets.push(`review_tags = '[]'::jsonb`);
    }
    // Un-ticking sends the item back into play, so stale completion state goes
    // with it: the old verdict (a redone item must pass To verify again) and
    // the finished lane's claim (a claimed item is invisible to the autopilot
    // and can read as in-progress). An explicit value in the same PATCH wins —
    // these columns are already SET above and can't be assigned twice.
    else {
      if (req.body.review_tag === undefined) sets.push('review_tag = NULL');
      if (req.body.claimed_by === undefined) sets.push('claimed_by = NULL');
    }
    // Either direction leaves the review shelf (#148): a fresh completion
    // starts its verify round on the main list, and an un-ticked item is back
    // on the board where shelving means nothing. Explicit values in the same
    // PATCH win — the column is already SET above and can't go twice.
    if (req.body.review_shelved === undefined) sets.push('review_shelved = false');
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
  if (req.body?.risk !== undefined) {
    sets.push(`risk = $${i++}`); vals.push(oneOf(req.body.risk, RISKS, 'normal'));
  }
  if (req.body?.tier !== undefined) {
    // #227 — the desire tier. '' (or anything outside S/A/B/C) unranks it.
    sets.push(`tier = $${i++}`); vals.push(cleanTier(req.body.tier));
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
    res.status(err.httpStatus || 502).json({ error: err.message || 'Gemini call failed.' });
  }
});

// POST /assist  -> Gemini fills the whole item from its note (the modal's ✧
// button): title, tidied note, area, branch claim, priority and tier (#277).
// Suggestion only — it prefills the fields and the human saves (or doesn't),
// and the modal only takes a tier into an EMPTY tier, so a rank you set by
// hand is never re-decided by the model. 503 keyless.
roadmap.post('/assist', async (req, res) => {
  if (!geminiEnabled()) {
    return res.status(503).json({ error: 'Gemini is not configured on this server (set GEMINI_API_KEY).' });
  }
  const note = String(req.body?.note || '').trim().slice(0, 4000);
  if (!note) return res.status(400).json({ error: 'Write the note first — everything comes from it.' });
  const [{ rows: areaRows }, { rows: branchRows }] = await Promise.all([
    q(
      `SELECT DISTINCT area FROM roadmap_items WHERE project_id = $1 AND area IS NOT NULL
       UNION SELECT DISTINCT area FROM futures WHERE project_id = $1 AND area IS NOT NULL`,
      [req.project.id]
    ),
    q(
      `SELECT DISTINCT claimed_by AS branch FROM roadmap_items
        WHERE project_id = $1 AND claimed_by IS NOT NULL AND NOT done`,
      [req.project.id]
    ),
  ]);
  const branches = branchRows.map((r) => r.branch);
  // The assist settings (#131): a standing guidance line folded into the
  // prompt, and which fields the assist may fill (title always may).
  const appSettings = await readSettings();
  const allowed = new Set(appSettings.assist_fields);
  const prompt = buildPrompt('assist', {
    NOTE: note,
    AREAS: areaRows.map((r) => r.area).join(', ') || '(none yet)',
    BRANCHES: branches.join(', ') || '(none)',
    GUIDANCE_LINE: appSettings.assist_guidance
      ? `Standing guidance from the owner (follow it): ${appSettings.assist_guidance}`
      : '',
    NORTH_STAR_LINE: req.project.north_star
      ? `For context, the project's north star: "${String(req.project.north_star).slice(0, 400)}"`
      : '',
  });
  try {
    const answer = await askGemini(prompt, { timeoutMs: 25_000 });
    const title = String(answer?.title || '').trim().slice(0, 300);
    if (!title) return res.status(502).json({ error: 'Gemini returned nothing usable.' });
    const rawTier = String(answer?.tier || '').trim().toUpperCase();
    const fillTier = allowed.has('tier') && TIERS.includes(rawTier) ? rawTier : '';
    // A switched-off field comes back empty — the modal leaves it untouched.
    res.json({
      title,
      note: allowed.has('note') ? String(answer?.note || '').trim().slice(0, 1000) || note : '',
      area: allowed.has('area') ? String(answer?.area || '').trim().toLowerCase().slice(0, 40) : '',
      // A branch claims work for a stream — only ever suggest one that already exists.
      branch: allowed.has('branch') && branches.includes(String(answer?.branch || '').trim()) ? String(answer.branch).trim() : '',
      priority: allowed.has('priority') && BUCKETS.includes(answer?.priority) ? answer.priority : null,
      // #277 — a desire tier, only ever S/A/B/C; anything else means "no view".
      // #298 splits S back out of it: S is the top of the owner's own queue —
      // the rank that decides what the machine works TONIGHT — so the model
      // may argue for it but must never assign it. A/B/C fill an empty field
      // as before; an S comes back as a suggestion the modal offers, and only
      // a human press puts it on the item.
      tier: fillTier && fillTier !== 'S' ? fillTier : '',
      tierSuggested: fillTier === 'S' ? 'S' : '',
      // #298 — how much care the change needs, read from the same note.
      risk: allowed.has('risk') && RISKS.includes(String(answer?.risk || '').trim().toLowerCase())
        ? String(answer.risk).trim().toLowerCase() : '',
    });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || 'Gemini call failed.' });
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
    res.status(err.httpStatus || 502).json({ error: err.message || 'Gemini call failed.' });
  }
});

// POST /:id/review-brief  -> Gemini writes the reviewer's brief for a completed
// item (#134): what actually shipped, hands-on test steps, likely risks — from
// the item, its built_note, the autopilot run that built it and the project's
// checks. Annotation only, nothing stored. 503 keyless.
roadmap.post('/:id/review-brief', async (req, res) => {
  if (!geminiEnabled()) {
    return res.status(503).json({ error: 'Gemini is not configured on this server (set GEMINI_API_KEY).' });
  }
  const { rows } = await q(
    'SELECT * FROM roadmap_items WHERE project_id = $1 AND id = $2',
    [req.project.id, req.params.id]
  );
  const item = rows[0];
  if (!item) return res.status(404).json({ error: 'No such roadmap item.' });
  if (!item.done) return res.status(400).json({ error: 'Only completed items get a review brief.' });
  const [{ rows: runRows }, { rows: checkRows }] = await Promise.all([
    q(
      `SELECT branch, commits, summary FROM autopilot_runs
        WHERE project_id = $1 AND item_id = $2 AND outcome = 'landed'
        ORDER BY finished_at DESC LIMIT 1`,
      [req.project.id, item.id]
    ),
    q('SELECT name, last_status FROM checks WHERE project_id = $1 ORDER BY id LIMIT 12', [req.project.id]),
  ]);
  const run = runRows[0];
  const prompt = buildPrompt('reviewbrief', {
    ID: String(item.id),
    BUCKET: item.bucket,
    TITLE: item.title,
    NOTE_LINE: item.note ? `The item's note: ${String(item.note).slice(0, 1000)}` : '',
    BUILT_NOTE: String(item.built_note || '(none recorded)').slice(0, 2000),
    RUN_BLOCK: run
      ? `Built by an unattended session on branch ${run.branch} (${run.commits} commit${run.commits === 1 ? '' : 's'}). The session's own account:\n${String(run.summary || '').slice(0, 3000)}`
      : 'No autopilot run recorded for it — likely built by hand or an interactive session.',
    CHECKS_BLOCK: checkRows.length
      ? `The project's HTTP checks (runnable from the Bugs tab): ${checkRows.map((c) => `${c.name} (${c.last_status || 'never run'})`).join(', ')}`
      : '',
    NORTH_STAR_LINE: req.project.north_star
      ? `For context, the project's north star: "${String(req.project.north_star).slice(0, 400)}"`
      : '',
  });
  try {
    const answer = await askGemini(prompt, { timeoutMs: 25_000 });
    const summary = String(answer?.summary || '').trim().slice(0, 1200);
    if (!summary) return res.status(502).json({ error: 'Gemini returned nothing usable.' });
    const list = (v, cap) => (Array.isArray(v) ? v : [])
      .map((s) => String(s).trim().slice(0, 300)).filter(Boolean).slice(0, cap);
    res.json({ summary, test: list(answer?.test, 6), risks: list(answer?.risks, 3) });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || 'Gemini call failed.' });
  }
});

// POST /:id/refine-draft  -> Gemini drafts the ✎ Refine delta (Turn 3): the one
// instruction that sends a completed item back to the board saying only what to
// change on top of what landed.
//
// The affordance is the roadmap tab's, deliberately: OFFERED, never forced, and
// the result is a draft in an editable box that the human still has to send.
// Gemini annotates, the human disposes — this one never writes the note itself,
// never sends the item back and never queues the session.
//
// What it reads is the RECORD, not the repository. The server has no checkout,
// so there is no diff to hand it; what it gets instead is the session's own
// account, the second model's read of the diff (which IS a read of one, stored
// by the night), the architect's structural read, and the files the sessions on
// that branch touched. The UI's subtext says exactly that rather than the
// design's "run log + diff" — same correction the Workbench ops carry, and for
// the same reason. 503 keyless.
roadmap.post('/:id/refine-draft', async (req, res) => {
  if (!geminiEnabled()) {
    return res.status(503).json({ error: 'Gemini is not configured on this server (set GEMINI_API_KEY).' });
  }
  const { rows } = await q(
    'SELECT * FROM roadmap_items WHERE project_id = $1 AND id = $2',
    [req.project.id, req.params.id]
  );
  const item = rows[0];
  if (!item) return res.status(404).json({ error: 'No such roadmap item.' });
  if (!item.done) return res.status(400).json({ error: 'Only completed items get a refine draft.' });

  const [{ rows: runRows }, { rows: checkRows }] = await Promise.all([
    q(
      `SELECT branch, commits, outcome, checks_failing, summary,
              review_verdict, review_note, review_findings,
              architect_verdict, architect_note, architect_obs
         FROM autopilot_runs
        WHERE project_id = $1 AND item_id = $2
        ORDER BY finished_at DESC LIMIT 1`,
      [req.project.id, item.id]
    ),
    q(`SELECT name, last_status FROM checks
        WHERE project_id = $1 AND last_status = 'fail' ORDER BY id LIMIT 8`, [req.project.id]),
  ]);
  const run = runRows[0];

  // The files the work touched, from the sessions recorded against its branch.
  // Not a diff — a list of what was opened — and the prompt is told which it is.
  let files = [];
  if (run?.branch) {
    const { rows: fileRows } = await q(
      `SELECT files_touched FROM sessions
        WHERE project_id = $1 AND branch = $2 AND jsonb_array_length(files_touched) > 0
        ORDER BY created_at DESC LIMIT 8`,
      [req.project.id, run.branch]
    );
    const seen = new Set();
    for (const r of fileRows) {
      for (const f of (Array.isArray(r.files_touched) ? r.files_touched : [])) {
        if (typeof f === 'string' && f) seen.add(f.replace(/^.*?\/(?=(server|web|hook|scripts|terminal|templates)\/)/, ''));
      }
    }
    files = [...seen];
  }
  // A capped list inside a prompt must SAY it is capped (#239) — the model reads
  // absence as evidence, so a silent slice would have it reason from a file set
  // that never existed.
  const FILE_CAP = 30;
  const shownFiles = files.slice(0, FILE_CAP);

  const prompt = buildPrompt('refinedraft', {
    ID: String(item.id),
    BUCKET: item.bucket,
    TITLE: item.title,
    NOTE_LINE: item.note ? `The item's note: ${String(item.note).slice(0, 1000)}` : '',
    BUILT_NOTE: String(item.built_note || '(none recorded — the builder left no account)').slice(0, 2000),
    RUN_BLOCK: run
      ? `The run: branch ${run.branch}, ${run.commits} commit${run.commits === 1 ? '' : 's'}, outcome ${run.outcome}`
        + `${run.checks_failing == null ? ', checks never run' : `, ${run.checks_failing} check${run.checks_failing === 1 ? '' : 's'} failing`}.`
        + `\nThe session's own account:\n${String(run.summary || '(none)').slice(0, 3000)}`
      : 'No autopilot run recorded — built by hand or by an interactive session, so there is no run log.',
    // An empty verdict means NO PASS RAN, and the prompt has to be told that in
    // those words: "no reviewer read" is not "the reviewer found nothing".
    REVIEW_BLOCK: run?.review_verdict
      ? `The second model reviewed the branch DIFF and returned "${run.review_verdict}"`
        + `${run.review_findings != null ? ` with ${run.review_findings} finding${run.review_findings === 1 ? '' : 's'}` : ''}:`
        + `\n${String(run.review_note || '(no note)').slice(0, 2000)}`
      : 'No second-model review ran on this branch — that is an absence of evidence, not a clean bill.',
    ARCHITECT_BLOCK: run?.architect_verdict
      ? `The architect's structural read returned "${run.architect_verdict}": ${String(run.architect_note || '').slice(0, 1500)}`
      : '',
    FILES_BLOCK: shownFiles.length
      ? `The sessions on that branch touched ${files.length} file${files.length === 1 ? '' : 's'}`
        + `${files.length > FILE_CAP ? ` (the ${FILE_CAP} below are a sample of them)` : ''}: ${shownFiles.join(', ')}`
      : 'No record of which files the work touched.',
    OWNER_BLOCK: checkRows.length
      ? `Checks currently FAILING on this project: ${checkRows.map((c) => c.name).join(', ')}.`
      : '',
    NORTH_STAR_LINE: req.project.north_star
      ? `For context, the project's north star: "${String(req.project.north_star).slice(0, 400)}"`
      : '',
  });

  try {
    const answer = await askGemini(prompt, { timeoutMs: 25_000 });
    // An EMPTY draft is a valid answer here, and not an error — the prompt asks
    // for one whenever the record does not evidence something to change. That
    // is the whole difference between an assistant and a complaint generator:
    // told to produce a delta from a run nobody reviewed and a built note with
    // no gap in it, the honest output is nothing, and the dialog says so.
    const draft = String(answer?.draft || '').trim().slice(0, 2000);
    res.json({
      draft,
      basis: String(answer?.basis || '').trim().slice(0, 60),
      // What it actually had, so the dialog's chrome can say so rather than
      // repeating the design's "run log + diff" on a run that had neither.
      read: [
        run ? 'run log' : '',
        run?.review_verdict ? "the reviewer's read of the diff" : '',
        run?.architect_verdict ? 'the architect' : '',
        shownFiles.length ? `${files.length} file${files.length === 1 ? '' : 's'} touched` : '',
      ].filter(Boolean),
    });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || 'Gemini call failed.' });
  }
});

// (#218: #196) The old GET /tree endpoint (a DB-derived branch-tree model for
// #72) was removed — nothing called it: the shipped branch navigator is
// scripts/stack-tree.mjs, which reads git directly.

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
