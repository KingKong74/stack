import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { fingerprint, oneOf, BUCKETS, cleanPlan, cleanReviewTags, riskWriteSource, capNote } from '../util.js';
import { cleanLabels } from '../labels.js';

// How many weeks the timeline spans, and which week is "now". A bar is a week
// INDEX from the project's own week zero, never a date — see schema.sql's
// Roadmap-v2 header for why. The client twins are SCHED_WEEKS and NOW_WEEK in
// web/src/lib/plan.ts; change them together.
const SCHED_WEEKS = 24;
const SCHED_NOW_WEEK = 8;

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
import { buildPrompt } from '../prompts.js';
import { agentClient } from '../agents.js';
import { readSettings } from '../settings.js';
import { composeReviewBrief, storeReviewBrief } from '../reviewbrief.js';

// Mounted at /api/projects/:slug/roadmap.
export const roadmap = Router({ mergeParams: true });

roadmap.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

// #361 — every ✧ surface on this file is the CURATOR, the Roadmap tab's agent,
// and it is bound once here. The client refuses any op the Curator does not own
// (the Auditor's audit, Polaris's judge), so the board cannot quietly become
// somebody else's workspace, and it carries the agent's switch, model and
// standing guidance.
const curator = agentClient('curator');

// The Curator's gate, as a response. `true` = it refused and the reply is
// already sent, so the route returns. This replaced the `if (!geminiEnabled())`
// line each ✧ route used to open with: a missing key is now one of several
// reasons an agent may not act, and the agent is the thing that knows them all.
const refused = async (op, res) => {
  try {
    await curator.gate(op);
    return false;
  } catch (err) {
    res.status(err.httpStatus || 503).json({ error: err.message });
    return true;
  }
};

// GET  /  -> grouped MoSCoW roadmap
roadmap.get('/', async (req, res) => {
  const { rows } = await q(
    'SELECT * FROM roadmap_items WHERE project_id = $1 ORDER BY bucket, position, created_at',
    [req.project.id]
  );
  res.json(groupRoadmap(rows));
});

// A tmux session name, as the terminal daemon spells them ('stack-term-a1b2').
// Constrained rather than free text because it is rendered as a chip, parsed
// back into a `term:` claim and matched against the running-sessions strip; a
// name with a space in it would break all three quietly.
const FLY_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// POST /  -> create a roadmap item (optionally pre-claimed to a lane)
//
// #381 — TWO ORIGINS MAY POST HERE, and 'hook' is not one of them. `source`
// defaults to 'manual' (a human at the board) and the only other value this
// route accepts is 'fly': a live Claude session opening a card for work it has
// just been asked to do, so that ad-hoc work is on the board like any other
// rather than existing only in a transcript nobody re-reads.
//
// 'hook' is REFUSED, not silently downgraded. That source carries the
// extractor's fingerprint dedup and the `dismissed_items` tombstone contract,
// and a caller who could claim it could resurrect an item the owner dismissed
// or collide with the unique index. Only ingest.js writes 'hook'.
//
// A fly item is HELD from the auto runner exactly like a hook item (see
// approval.js) — the sign-off is the distance between a session taking a note
// and a session commissioning a night's work.
roadmap.post('/', async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 300);
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const wantSource = String(req.body?.source || 'manual').trim().toLowerCase();
  if (wantSource !== 'manual' && wantSource !== 'fly') {
    return res.status(400).json({
      error: `source must be 'manual' or 'fly' — '${wantSource}' cannot be set from here.`,
    });
  }
  const source = wantSource;
  // Who opened it. Only meaningful on a fly item, and a fly item without one is
  // still a fly item: the session is provenance, not identity, and refusing the
  // card because a session could not name itself would lose the work.
  const rawSession = String(req.body?.session || '').trim();
  const flySession = source === 'fly' && FLY_SESSION_RE.test(rawSession) ? rawSession : null;
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  const bucket = oneOf(req.body?.bucket, BUCKETS, 'should');
  const claimedBy = String(req.body?.claimed_by || '').trim().slice(0, 100) || null;
  const area = String(req.body?.area || '').trim().toLowerCase().slice(0, 40) || null;
  const plan = cleanPlan(req.body?.plan);
  const risk = oneOf(req.body?.risk, RISKS, 'normal');
  // #262 — an untouched default isn't a human decision; only a caller who
  // actually sent a risk gets credited as its source.
  const riskSource = req.body?.risk !== undefined ? 'human' : null;
  const tier = cleanTier(req.body?.tier);
  // The Polaris hook: which agent_profiles key should build this item ('' =
  // the default executor). A plain string, same handling as any other.
  const agentProfile = String(req.body?.agentProfile || '').trim().slice(0, 60);

  const fp = fingerprint(title);

  // #381 — the SAME-SESSION GUARD, and only for fly items.
  //
  // A session is told to open a card when it starts work, and a session is not
  // a reliable narrator of whether it has already done so: a compaction, a
  // re-read of its own instructions or a second turn on the same task all end
  // with it posting again. Nothing else on this route dedups (two people may
  // legitimately write the same card by hand), so this is deliberately the
  // narrowest possible test — same project, same fingerprint, same session,
  // still open — and it returns 200 with the EXISTING card rather than 201.
  //
  // Not a unique index: two different sessions working the same thing is a real
  // and interesting state (it is how you notice a collision), so the database
  // must not forbid it. Only a session duplicating ITSELF is the mistake.
  if (source === 'fly' && flySession) {
    const { rows: dupe } = await q(
      `SELECT * FROM roadmap_items
        WHERE project_id = $1 AND fingerprint = $2 AND source = 'fly'
          AND fly_session = $3 AND NOT done AND NOT archived
        ORDER BY id LIMIT 1`,
      [req.project.id, fp, flySession]
    );
    if (dupe.length) return res.status(200).json(roadmapItemShape(dupe[0]));
  }

  const { rows: pos } = await q(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM roadmap_items WHERE project_id = $1 AND bucket = $2',
    [req.project.id, bucket]
  );
  const { rows } = await q(
    // #262 brought risk_source, #334 brought agent_profile, on separate
    // branches that each rewrote this one statement. Both columns are real;
    // the merge left two whole INSERTs stacked, which JS read as a tagged
    // template call rather than a syntax error.
    `INSERT INTO roadmap_items (project_id, bucket, title, note, position, source, fingerprint, claimed_by, area, plan, risk, risk_source, tier, agent_profile, fly_session)
     VALUES ($1,$2,$3,$4,$5,$14,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$15) RETURNING *`,
    [req.project.id, bucket, title, note, pos[0].p, fp, claimedBy, area, JSON.stringify(plan), risk, riskSource, tier, agentProfile, source, flySession]
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
    if (verdict) {
      // #263 — a verdict is human unless the caller says otherwise. Only the
      // autoverdict gate (scripts/lib/autoverdict.mjs) ever sends 'auto'; any
      // ordinary client PATCH stays human without having to say so.
      sets.push(`verdict_source = $${i++}`);
      vals.push(req.body.verdict_source === 'auto' ? 'auto' : 'human');
      sets.push('verdict_at = now()');
      sets.push(`verdict_evidence = $${i++}`);
      vals.push(String(req.body.verdict_evidence || '').trim().slice(0, 500) || null);
    } else {
      // Clearing the tag IS the ⎌ undo — the ordinary and only path back from
      // an auto verdict. The reset has to be atomic with the clear or the row
      // keeps claiming a machine verdict it no longer has.
      sets.push(`verdict_source = 'human'`);
      sets.push('verdict_at = NULL');
      sets.push('verdict_evidence = NULL');
    }
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
      if (req.body.review_tag === undefined) {
        sets.push('review_tag = NULL');
        // #263 — un-ticking clears a verdict the same way the ⎌ undo does:
        // atomically, so an un-ticked item never keeps claiming a machine
        // verdict it no longer has.
        sets.push(`verdict_source = 'human'`);
        sets.push('verdict_at = NULL');
        sets.push('verdict_evidence = NULL');
      }
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
    // #262 — where the tier comes from decides who may write it. A human
    // decision overrides the machine outright, justification and all — its old
    // reason no longer applies. An auto tier is only a SUGGESTION, so the guard
    // against it clobbering a human's tier has to live IN the UPDATE: every RHS
    // sees the OLD row, so the CASE is atomic and two nights writing the same
    // item can't race it — a read-then-check first would leave exactly that gap.
    // ABSENT means the modal: a bare {risk} PATCH is a person, and a person
    // wins. Anything PRESENT but unrecognised takes the guarded path, not the
    // winning one — a machine typo must not be able to claim a row as human-decided.
    const source = riskWriteSource(req.body.risk_source);
    const risk = oneOf(req.body.risk, RISKS, 'normal');
    const reason = String(req.body.risk_reason || '').trim().slice(0, 300) || null;
    if (source === 'human') {
      sets.push(`risk = $${i++}`); vals.push(risk);
      sets.push(`risk_source = 'human'`);
      sets.push(`risk_reason = $${i++}`); vals.push(reason);
    } else {
      sets.push(`risk        = CASE WHEN risk_source = 'human' THEN risk        ELSE $${i++} END`);
      sets.push(`risk_reason = CASE WHEN risk_source = 'human' THEN risk_reason ELSE $${i++} END`);
      sets.push(`risk_source = CASE WHEN risk_source = 'human' THEN risk_source ELSE 'auto'  END`);
      vals.push(risk, reason);
    }
  }
  if (req.body?.tier !== undefined) {
    // #227 — the desire tier. '' (or anything outside S/A/B/C) unranks it.
    sets.push(`tier = $${i++}`); vals.push(cleanTier(req.body.tier));
  }
  if (req.body?.built_note !== undefined) {
    // Capped out loud — see capNote. This is the ONLY writer of the column, so
    // everything downstream can read it whole rather than re-capping (which
    // would cut the marker off the end and hide the cap again).
    sets.push(`built_note = $${i++}`);
    vals.push(capNote(req.body.built_note) || null);
  }
  if (req.body?.position !== undefined && Number.isFinite(req.body.position)) {
    sets.push(`position = $${i++}`); vals.push(Math.trunc(req.body.position));
  }
  if (req.body?.agentProfile !== undefined) {
    // The Polaris hook: which agent_profiles key should build this item. A
    // plain string set, '' to clear — not folded into the done/un-done
    // clearing lists above, because which agent should build an item is a
    // planning decision that survives a verify round-trip.
    sets.push(`agent_profile = $${i++}`);
    vals.push(String(req.body.agentProfile || '').trim().slice(0, 60));
  }
  // ---- the Roadmap tab v2 ----------------------------------------------
  if (req.body?.sched !== undefined) {
    // null = back to the tray. The BASELINE is written only when there isn't
    // one (COALESCE), which is the whole slip mechanism: a drag moves the bar
    // and leaves the ghost where the plan put it. A baseline that followed the
    // bar could never show a slip, so this is the one place it may be set and
    // it may only ever set it ONCE. Re-baselining is an explicit, separate act.
    const s = req.body.sched;
    if (s === null) {
      sets.push('sched_start = NULL', 'sched_len = NULL');
    } else if (Number.isFinite(s?.start) && Number.isFinite(s?.len)) {
      const start = Math.max(0, Math.min(SCHED_WEEKS - 1, Math.trunc(s.start)));
      const len = Math.max(1, Math.min(SCHED_WEEKS - start, Math.trunc(s.len)));
      sets.push(`sched_start = $${i++}`); vals.push(start);
      sets.push(`sched_len = $${i++}`); vals.push(len);
      sets.push(`plan_start = COALESCE(plan_start, $${i++})`); vals.push(start);
      sets.push(`plan_len = COALESCE(plan_len, $${i++})`); vals.push(len);
    }
  }
  if (req.body?.rebaseline === true) {
    // "This is the plan now." The only path that overwrites the ghost, and it
    // is deliberately its own flag rather than a side effect of a drag.
    sets.push('plan_start = sched_start', 'plan_len = sched_len');
  }
  if (req.body?.parentId !== undefined) {
    // ONE LEVEL DEEP. A ticket hangs off a feature; a feature may not hang off
    // a ticket, and nothing may hang off itself. The check is a subquery inside
    // this UPDATE's own right-hand side so it sees the OLD rows and two writers
    // cannot race a cycle into existence — the same reasoning as the risk guard.
    const pid = Number(req.body.parentId);
    if (!Number.isFinite(pid) || pid <= 0) {
      sets.push('parent_id = NULL');
    } else {
      // COALESCE back to the CURRENT parent, not to NULL: a rejected target
      // (another project's row, a ticket, itself) must leave the row where it
      // was. Resolving to NULL would let a bad id silently orphan a ticket,
      // which reads on the board as the scope line simply vanishing.
      // Detaching is the explicit `parentId: null` branch above.
      sets.push(`parent_id = COALESCE((
        SELECT p.id FROM roadmap_items p
         WHERE p.id = $${i} AND p.project_id = $${i + 1}
           AND p.id <> $${i + 2} AND p.parent_id IS NULL), parent_id)`);
      vals.push(pid, req.project.id, Number(req.params.id));
      i += 3;
    }
  }
  if (req.body?.labels !== undefined) {
    sets.push(`labels = $${i++}::jsonb`);
    vals.push(JSON.stringify(cleanLabels(req.body.labels)));
  }
  if (req.body?.listKey !== undefined) {
    // '' clears back to DERIVED. Moving a card never ticks it: `done` is a
    // verdict the Review room owns and a board column is not a verdict, so
    // dropping something in "Shipped" moves the card and nothing else.
    sets.push(`list_key = $${i++}`);
    vals.push(String(req.body.listKey || '').trim().slice(0, 40) || null);
  }
  if (req.body?.archived !== undefined) {
    sets.push(`archived = $${i++}`); vals.push(!!req.body.archived);
  }
  if (req.body?.estimate !== undefined) {
    // null = unsized, which the scope drawer states rather than counting as 0.
    const e = req.body.estimate;
    if (e === null || e === '') { sets.push('estimate = NULL'); }
    else if (Number.isFinite(Number(e))) {
      sets.push(`estimate = $${i++}`);
      vals.push(Math.max(0, Math.min(99, Math.round(Number(e) * 10) / 10)));
    }
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

// POST /suggest-title  -> the Curator titles an item from its note (the ✧
// button in the modal). Suggestion only — the human applies or ignores it.
// 503 if the host is unreachable.
roadmap.post('/suggest-title', async (req, res) => {
  if (await refused('titler', res)) return;
  const note = String(req.body?.note || '').trim().slice(0, 2000);
  if (!note) return res.status(400).json({ error: 'Write the note first — the title comes from it.' });
  const prompt = buildPrompt('titler', {
    NOTE: note,
    NORTH_STAR_LINE: req.project.north_star
      ? `For context, the project's north star: "${String(req.project.north_star).slice(0, 400)}"`
      : '',
  });
  try {
    const answer = await curator.ask('titler', prompt, { timeoutMs: 20_000 });
    const title = String(answer?.title || '').trim().slice(0, 300);
    if (!title) return res.status(502).json({ error: 'The Curator returned nothing usable.' });
    res.json({ title });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || "The Curator's call failed." });
  }
});

// POST /assist  -> the Curator fills the whole item from its note (the
// modal's ✧ button): title, tidied note, area, branch claim, priority and
// tier (#277). Suggestion only — it prefills the fields and the human saves
// (or doesn't), and the modal only takes a tier into an EMPTY tier, so a rank
// you set by hand is never re-decided by the model. 503 if the host is
// unreachable.
roadmap.post('/assist', async (req, res) => {
  if (await refused('assist', res)) return;
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
    const answer = await curator.ask('assist', prompt, { timeoutMs: 25_000 });
    const title = String(answer?.title || '').trim().slice(0, 300);
    if (!title) return res.status(502).json({ error: 'The Curator returned nothing usable.' });
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
    res.status(err.httpStatus || 502).json({ error: err.message || "The Curator's call failed." });
  }
});

// POST /cleanup  -> the Curator reviews the OPEN board and suggests fixes:
// areas for untagged items, cleaned titles, honest buckets. Suggestions only —
// the client shows them for the human to apply through the normal PATCH.
// 503 if the host is unreachable.
// POST /arrange -> the Curator reads the timeline and proposes an ORDER.
//
// The Arrange panel's other actions are arithmetic (lib/plan.ts): they pack,
// compact and trim without reading a word. This one exists for the thing the
// arithmetic structurally cannot do — notice that "usage dashboard" cannot
// precede "metering ingest" — and it is the only part of Arrange that costs a
// model call.
//
// PROPOSES ONLY. It returns {moves:[{id,start,why}]} and writes nothing: the
// timeline ghosts each move in the accent and the owner applies or discards.
// That is what keeps "Gemini annotates, the human disposes" true of a button
// whose whole job is rearranging a plan.
roadmap.post('/arrange', async (req, res) => {
  if (await refused('arrange', res)) return;
  const { rows } = await q(
    `SELECT id, bucket, area, title, note, sched_start, sched_len, estimate
       FROM roadmap_items
      WHERE project_id = $1 AND NOT done AND NOT archived
      ORDER BY sched_start NULLS LAST, bucket, position`,
    [req.project.id]
  );
  // Two bars cannot be ordered against each other, and one cannot be ordered at
  // all. Say so rather than spending a call to be told the same.
  if (rows.length < 2) return res.json({ moves: [], note: 'Not enough on the board to order.' });

  const byId = new Map(rows.map((r) => [r.id, r]));
  const prompt = buildPrompt('arrange', {
    NOW_WEEK: SCHED_NOW_WEEK,
    ITEMS: rows.map((r) => [
      r.id, r.area || '-', r.bucket,
      r.sched_len ?? (r.estimate === null ? '-' : Math.max(1, Math.round(Number(r.estimate)))),
      r.sched_start === null ? '-' : r.sched_start,
      r.title, (r.note || '-').slice(0, 200),
    ].join(' | ')).join('\n'),
    NORTH_STAR_LINE: req.project.north_star
      ? `For context, the project's north star: "${String(req.project.north_star).slice(0, 400)}"`
      : '',
  });

  try {
    const answer = await curator.ask('arrange', prompt, { timeoutMs: 45_000 });
    const moves = (Array.isArray(answer?.moves) ? answer.moves : [])
      .map((m) => {
        const cur = byId.get(Number(m?.id));
        if (!cur) return null;
        const len = Math.max(1, Number(cur.sched_len)
          || (cur.estimate === null ? 2 : Math.round(Number(cur.estimate))) || 2);
        // Clamped the same way a drag is, and never earlier than now: a model
        // is allowed to be wrong about the week, not to schedule the past.
        const start = Math.max(SCHED_NOW_WEEK,
          Math.min(SCHED_WEEKS - len, Math.trunc(Number(m.start))));
        if (!Number.isFinite(start)) return null;
        if (cur.sched_start === start && cur.sched_len === len) return null; // a no-op is not a move
        return { id: cur.id, title: cur.title, sched: { start, len }, why: String(m.why || '').trim().slice(0, 200) };
      })
      .filter(Boolean)
      .slice(0, 8);
    res.json({ moves });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || "The Curator's call failed." });
  }
});

roadmap.post('/cleanup', async (req, res) => {
  if (await refused('cleanup', res)) return;
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
    const answer = await curator.ask('cleanup', prompt, { timeoutMs: 30_000 });
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
    res.status(err.httpStatus || 502).json({ error: err.message || "The Curator's call failed." });
  }
});

// #375 — POST /:id/review-brief and POST /:id/refine-draft LIVED HERE. They
// moved to routes/review.js with the ops themselves, which are the Foreman's
// now rather than the Curator's: the Review room was always their only surface,
// and both of them refused a change that was still on a branch (`if (!item.done)
// 400`) — which after #374 is most of what that room shows. The routes are
// POST /api/review/:slug/:id/brief and /refine-draft.

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
