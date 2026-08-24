import { Router } from 'express';
import { pool } from '../db.js';
import {
  slugify, fingerprint, asList, oneOf, TINTS,
  SEVERITIES, BUCKETS, capNote,
} from '../util.js';
import { readSettings } from '../settings.js';
import { geminiEnabled, askGemini } from '../gemini.js';
import { buildPrompt } from '../prompts.js';

export const ingest = Router();

const str = (v, len) => (v ? String(v).slice(0, len) : null);

// Candidate bug list off the wire: [{ title, severity }].
function asBugCandidates(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((b) => ({
      title: str(b?.title, 300),
      severity: oneOf(b?.severity, SEVERITIES, 'medium'),
    }))
    .filter((b) => b.title)
    .slice(0, 25);
}

// Candidate next-step list off the wire: [{ title, priority }].
function asStepCandidates(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((s) => ({
      title: str(s?.title, 300),
      bucket: oneOf(s?.priority, BUCKETS, 'should'), // default bucket: should
    }))
    .filter((s) => s.title)
    .slice(0, 25);
}

// #174 — what this session BUILT: [{ item?, title?, note, bucket?, area? }].
//
// The opposite direction to `next_steps`. Those are work proposed for later and
// arrive as fresh 'hook' rows; these say "this is the board row for what just
// landed", and each either attaches to a row that already exists or files the
// one nobody remembered to make. The consoles shipped with no row at all, which
// is why twenty-two citations pointed at another item's number.
//
// `item` (a roadmap id) is the precise form and always wins; `title` is the
// fallback, matched by fingerprint and only then created. `note` is the
// built_note — the account the Review room verdicts against — and is the one
// genuinely required field: an entry with no note says a row exists and nothing
// about what landed in it, which is the very gap this closes.
//
// Capped at 10. A session lands a handful of things, not fifty; a longer list
// is a session describing every file it touched, and the cap is what stops that
// becoming fifty board rows.
function asBuiltCandidates(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((b) => {
      const id = Number(b?.item);
      return {
        item: Number.isFinite(id) && id > 0 ? Math.trunc(id) : null,
        title: str(b?.title, 300),
        note: str(b?.note, 4000) || '',
        bucket: oneOf(b?.bucket, BUCKETS, 'should'),
        area: str(b?.area, 40)?.toLowerCase() || null,
      };
    })
    // An entry needs somewhere to land (an id or a title) AND something to say.
    .filter((b) => (b.item || b.title) && b.note)
    .slice(0, 10);
}

/**
 * POST /api/ingest
 *
 * Body shape (everything optional except a project identity):
 * {
 *   project: { slug?, name?, repo?, repo_url? },
 *   session: {
 *     session_id?, commit_hash?, branch?, cwd?, model?, reason?, message_count?,
 *     authored?,                       // true = rich /checkpoint, false = metadata backstop
 *     summary?, current_phase?, next_steps?[], blockers?[],
 *     files_touched?[], tools_used?[], tags?[],
 *     in_progress?[], next_up?[], working_well?[]
 *   },
 *   extract: {
 *     bugs?: [{ title, severity }],
 *     next_steps?: [{ title, priority }],
 *     built?: [{ item?, title?, note, bucket?, area? }]   // #174 — see below
 *   }
 * }
 *
 * One transaction: upsert project, record the session (idempotent on
 * commit/session id), refresh the live resume fields with COALESCE, then land
 * the auto-extracted bugs and roadmap items (deduped by fingerprint, honouring
 * tombstones, never touching manual items).
 *
 * `extract.built` (#174) runs in the SAME transaction and in the opposite
 * direction to the rest: everything else here proposes work for later, that one
 * records the board row for work that has just landed — attaching the
 * `built_note` to the row that already exists, or filing the row nobody
 * remembered to make. It never ticks an item; see the block itself for why.
 */
// The SessionEnd hook's per-model transcript usage, shaped like the autopilot
// runner's `model_usage` so one reader serves both populations. Untrusted
// input: model ids are capped and bounded in number, and every count is
// coerced to a finite non-negative integer. Cost is deliberately absent — a
// transcript carries none, and inventing one would put a made-up dollar figure
// beside the runner's real ones.
const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
function asModelUsage(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [model, u] of Object.entries(v).slice(0, 12)) {
    const id = String(model || '').trim().slice(0, 120);
    if (!id || !u || typeof u !== 'object') continue;
    const row = {};
    let any = 0;
    for (const k of USAGE_KEYS) {
      const n = Number(u[k]);
      row[k] = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
      any += row[k];
    }
    if (any > 0) out[id] = row;
  }
  return out;
}

// { 'Explore': 3, … } — how many subagents of each type a session spawned.
// A COUNT, never a cost: the parent transcript never records what a subagent
// spent, and the client says so rather than letting the number read as spend.
function asAgentTypes(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [type, n] of Object.entries(v).slice(0, 20)) {
    const t = String(type || '').trim().slice(0, 40);
    const c = Number(n);
    if (t && Number.isFinite(c) && c > 0) out[t] = Math.trunc(c);
  }
  return out;
}

ingest.post('/', async (req, res) => {
  const body = req.body || {};
  const p = body.project || {};
  const s = body.session || {};
  const extract = body.extract || {};

  const slug = slugify(p.slug || p.name || s.cwd?.split('/').pop());
  const name = (p.name || p.slug || slug).toString().slice(0, 200);
  const repo = str(p.repo, 300);
  const repoUrl = str(p.repo_url, 500);
  const commit = str(s.commit_hash, 80);

  // authored = a rich Claude-authored /checkpoint. Metadata-only backstops from
  // the SessionEnd hook leave this false, which keeps them from overwriting an
  // existing authored summary / the project's resume fields for the same commit.
  const authored = Boolean(s.authored);

  const session = {
    session_id: str(s.session_id, 200),
    commit_hash: commit,
    summary: str(s.summary, 8000),
    current_phase: str(s.current_phase, 400),
    next_steps: asList(s.next_steps),
    blockers: asList(s.blockers),
    files_touched: asList(s.files_touched),
    tools_used: asList(s.tools_used),
    tags: asList(s.tags, 8, 40),
    in_progress: asList(s.in_progress),
    next_up: asList(s.next_up),
    working_well: asList(s.working_well),
    branch: str(s.branch, 200),
    // #381/#174 — the tmux session name, if this post named one. Not a column
    // on `sessions`: it is here only so the built rows below can be claimed and
    // stamped as this session's, the same way a fly card opened at work-start
    // is. Validated to the same shape the roadmap route accepts, so the two
    // spellings of a claim cannot diverge.
    fly_session: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(s.session || '').trim())
      ? String(s.session).trim() : null,
    cwd: str(s.cwd, 500),
    model: str(s.model, 100),
    reason: str(s.reason, 100),
    message_count: Number.isFinite(s.message_count) ? Math.trunc(s.message_count) : null,
    // Real transcript token usage from the SessionEnd hook (#178) — 0 = unknown.
    tokens_used: Number.isFinite(s.tokens_used) && s.tokens_used > 0 ? Math.trunc(s.tokens_used) : 0,
    // Per-model usage + delegations, only ever sent by the SessionEnd hook: it
    // is the only thing that reads the transcript. `{}` means the post carried
    // none (a /checkpoint, or a hook that could not read one), which is why the
    // writes below treat empty as "leave what is there" rather than as zero.
    model_usage: asModelUsage(s.model_usage),
    agent_calls: Number.isFinite(s.agent_calls) && s.agent_calls > 0 ? Math.trunc(s.agent_calls) : 0,
    agent_types: asAgentTypes(s.agent_types),
    agent_usage: asModelUsage(s.agent_usage),
    agents_recorded: Number.isFinite(s.agents_recorded) && s.agents_recorded > 0 ? Math.trunc(s.agents_recorded) : 0,
  };

  const bugCandidates = asBugCandidates(extract.bugs);
  const stepCandidates = asStepCandidates(extract.next_steps);
  const builtCandidates = asBuiltCandidates(extract.built);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Settings gate (read inside the txn). keep_resume_card off means we still
    // record the activity row but never touch the project's resume fields.
    const settings = await readSettings(client);

    // --- 1. Upsert project identity (first push creates it + assigns a tint) ---
    let projectId;
    const found = await client.query('SELECT id FROM projects WHERE slug = $1', [slug]);
    if (found.rows.length) {
      projectId = found.rows[0].id;
      await client.query(
        `UPDATE projects
            SET name = $2,
                repo = COALESCE($3, repo),
                repo_url = COALESCE(repo_url, $4),   -- fill once; never overwrite a hand-set URL
                last_session_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [projectId, name, repo, repoUrl]
      );
    } else {
      const { rows: cnt } = await client.query('SELECT count(*)::int AS n FROM projects');
      const tint = TINTS[cnt[0].n % TINTS.length];
      const ins = await client.query(
        `INSERT INTO projects (slug, name, repo, repo_url, tint, last_session_at)
         VALUES ($1, $2, $3, $4, $5, now())
         RETURNING id`,
        [slug, name, repo, repoUrl, tint]
      );
      projectId = ins.rows[0].id;
    }

    // --- 2. Record the session, idempotent on session id / commit hash ---
    // A session's identity is its session_id, and the commit is only a fallback
    // for posts that carry none. Matching the commit FIRST silently collapsed
    // parallel sessions: several sessions sharing one checkout all end at the
    // same `git rev-parse HEAD`, so three sessions ending together posted the
    // same commit_hash, all three matched the one row, and the feed kept only
    // the last — two real pushes vanished, and the survivor's row was re-stamped
    // with the end time so hours-old work read as minutes old.
    let existingSession = null;
    if (session.session_id) {
      const r = await client.query(
        'SELECT id FROM sessions WHERE project_id = $1 AND session_id = $2 LIMIT 1',
        [projectId, session.session_id]
      );
      existingSession = r.rows[0] || null;
    }
    if (!existingSession && commit) {
      // An authored /checkpoint posts no session_id, so the SessionEnd backstop
      // that follows it must still be able to claim that row by commit — but
      // only an UNCLAIMED one, or the next session in the same checkout would
      // claim it right back and we'd be where we started. A post with no
      // session_id of its own (a re-run /checkpoint) matches either way.
      const unclaimedOnly = session.session_id
        ? "AND (session_id IS NULL OR session_id = '')"
        : '';
      const r = await client.query(
        `SELECT id FROM sessions
           WHERE project_id = $1 AND commit_hash = $2 ${unclaimedOnly}
           ORDER BY id DESC LIMIT 1`,
        [projectId, commit]
      );
      existingSession = r.rows[0] || null;
    }

    const sessionCols = [
      session.session_id, session.commit_hash, session.summary, session.current_phase,
      JSON.stringify(session.next_steps), JSON.stringify(session.blockers),
      JSON.stringify(session.files_touched), JSON.stringify(session.tools_used),
      JSON.stringify(session.tags), session.branch, session.cwd, session.model,
      session.reason, session.message_count, authored,
    ];

    let sessionRowId = existingSession ? existingSession.id : null;
    if (existingSession) {
      // Re-running for the same push refreshes the row, never duplicates it.
      // COALESCE-safe: a metadata post ($15 = false) never clobbers an existing
      // authored summary, and the jsonb lists only overwrite when non-empty.
      await client.query(
        `UPDATE sessions SET
           session_id=COALESCE($2, session_id),
           commit_hash=COALESCE($3, commit_hash),
           summary = CASE
             WHEN $15 THEN COALESCE($4, summary)        -- incoming authored: it wins
             WHEN authored THEN summary                 -- existing authored, incoming metadata: keep
             ELSE COALESCE(NULLIF(summary, ''), $4)     -- both metadata: keep if non-empty
           END,
           current_phase = CASE
             WHEN $15 THEN COALESCE($5, current_phase)
             WHEN authored THEN current_phase
             ELSE COALESCE(NULLIF(current_phase, ''), $5)
           END,
           next_steps    = CASE WHEN $6::jsonb  = '[]'::jsonb THEN next_steps    ELSE $6::jsonb  END,
           blockers      = CASE WHEN $7::jsonb  = '[]'::jsonb THEN blockers      ELSE $7::jsonb  END,
           files_touched = CASE WHEN $8::jsonb  = '[]'::jsonb THEN files_touched ELSE $8::jsonb  END,
           tools_used    = CASE WHEN $9::jsonb  = '[]'::jsonb THEN tools_used    ELSE $9::jsonb  END,
           tags          = CASE WHEN $10::jsonb = '[]'::jsonb THEN tags          ELSE $10::jsonb END,
           branch=COALESCE($11, branch), cwd=COALESCE($12, cwd), model=COALESCE($13, model),
           reason=$14, message_count=COALESCE($16, message_count),
           tokens_used = GREATEST(tokens_used, $17),  -- keep the fullest count (#178)
           -- Same rule as the jsonb lists: empty means the post carried none,
           -- so it leaves what is there. Only the hook ever sends these, and a
           -- /checkpoint landing on the same row must not blank them.
           model_usage = CASE WHEN $18::jsonb = '{}'::jsonb THEN model_usage ELSE $18::jsonb END,
           agent_types = CASE WHEN $20::jsonb = '{}'::jsonb THEN agent_types ELSE $20::jsonb END,
           agent_usage = CASE WHEN $21::jsonb = '{}'::jsonb THEN agent_usage ELSE $21::jsonb END,
           agent_calls = GREATEST(agent_calls, $19),
           agents_recorded = GREATEST(agents_recorded, $22),
           authored = (authored OR $15)
         WHERE id=$1`,
        // $1=id, $2..$14 as listed, $15=authored (boolean), $16=message_count,
        // $17=tokens_used, $18=model_usage, $19=agent_calls, $20=agent_types,
        // $21=agent_usage, $22=agents_recorded
        [existingSession.id, session.session_id, session.commit_hash, session.summary,
         session.current_phase, JSON.stringify(session.next_steps), JSON.stringify(session.blockers),
         JSON.stringify(session.files_touched), JSON.stringify(session.tools_used),
         JSON.stringify(session.tags), session.branch, session.cwd, session.model,
         session.reason, authored, session.message_count, session.tokens_used,
         JSON.stringify(session.model_usage), session.agent_calls, JSON.stringify(session.agent_types),
         JSON.stringify(session.agent_usage), session.agents_recorded]
      );
    } else {
      const ins = await client.query(
        `INSERT INTO sessions
           (project_id, session_id, commit_hash, summary, current_phase, next_steps,
            blockers, files_touched, tools_used, tags, branch, cwd, model, reason,
            message_count, authored, tokens_used, model_usage, agent_calls, agent_types,
            agent_usage, agents_recorded, source)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,
                 $11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20::jsonb,$21::jsonb,$22,'hook')
         RETURNING id`,
        [projectId, ...sessionCols, session.tokens_used,
         JSON.stringify(session.model_usage), session.agent_calls, JSON.stringify(session.agent_types),
         JSON.stringify(session.agent_usage), session.agents_recorded]
      );
      sessionRowId = ins.rows[0].id;
    }

    // --- 3. Refresh the project's live resume state (COALESCE / keep-if-empty) ---
    // Only an authored /checkpoint refreshes the resume card; the metadata-only
    // hook backstop never touches it (so it can't clobber rich Claude-authored
    // content). Also skipped entirely when keep_resume_card is off — in which
    // case the activity row above still lands (the feed never has gaps).
    if (settings.keep_resume_card && authored) {
      await client.query(
        `UPDATE projects SET
           summary       = COALESCE($2, summary),
           current_phase = COALESCE($3, current_phase),
           next_steps    = CASE WHEN $4::jsonb = '[]'::jsonb THEN next_steps   ELSE $4::jsonb END,
           blockers      = $5::jsonb,
           in_progress   = CASE WHEN $6::jsonb = '[]'::jsonb THEN in_progress  ELSE $6::jsonb END,
           next_up       = CASE WHEN $7::jsonb = '[]'::jsonb THEN next_up      ELSE $7::jsonb END,
           working_well  = CASE WHEN $8::jsonb = '[]'::jsonb THEN working_well ELSE $8::jsonb END,
           updated_at    = now()
         WHERE id = $1`,
        [
          projectId, session.summary, session.current_phase,
          JSON.stringify(session.next_steps), JSON.stringify(session.blockers),
          JSON.stringify(session.in_progress), JSON.stringify(session.next_up),
          JSON.stringify(session.working_well),
        ]
      );
    }

    // --- 4. Land auto-extracted bugs ---
    const dismissed = async (kind, fp) => {
      const r = await client.query(
        'SELECT 1 FROM dismissed_items WHERE project_id=$1 AND kind=$2 AND fingerprint=$3',
        [projectId, kind, fp]
      );
      return r.rows.length > 0;
    };

    let createdBugs = 0;
    let relinkedBugs = 0;
    {
      const { rows } = await client.query(
        `SELECT COALESCE(MAX((substring(bug_key from '^BUG-([0-9]+)$'))::int), 0) AS n
           FROM bugs WHERE project_id = $1`,
        [projectId]
      );
      let n = rows[0].n;
      const seen = new Set();
      for (const cand of bugCandidates) {
        const fp = fingerprint(cand.title);
        if (!fp || seen.has(fp)) continue;
        seen.add(fp);
        if (await dismissed('bug', fp)) continue;

        const existing = await client.query(
          `SELECT id FROM bugs WHERE project_id=$1 AND fingerprint=$2 AND source='hook'`,
          [projectId, fp]
        );
        if (existing.rows.length) {
          // Already tracked — point it at this commit instead of duplicating.
          await client.query(
            'UPDATE bugs SET link_ref = COALESCE($2, link_ref), updated_at = now() WHERE id = $1',
            [existing.rows[0].id, commit]
          );
          relinkedBugs++;
        } else {
          n++;
          await client.query(
            `INSERT INTO bugs (project_id, bug_key, title, severity, status, link_ref, source, fingerprint)
             VALUES ($1,$2,$3,$4,'open',$5,'hook',$6)`,
            [projectId, `BUG-${n}`, cand.title, cand.severity, commit, fp]
          );
          createdBugs++;
        }
      }
    }

    // --- 5. Land auto-extracted roadmap items ---
    let createdSteps = 0;
    {
      const seen = new Set();
      for (const cand of stepCandidates) {
        const fp = fingerprint(cand.title);
        if (!fp || seen.has(fp)) continue;
        seen.add(fp);
        if (await dismissed('roadmap', fp)) continue;

        const existing = await client.query(
          `SELECT id FROM roadmap_items WHERE project_id=$1 AND fingerprint=$2 AND source='hook'`,
          [projectId, fp]
        );
        if (existing.rows.length) {
          await client.query('UPDATE roadmap_items SET updated_at = now() WHERE id = $1', [
            existing.rows[0].id,
          ]);
        } else {
          const pos = await client.query(
            'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM roadmap_items WHERE project_id=$1 AND bucket=$2',
            [projectId, cand.bucket]
          );
          await client.query(
            `INSERT INTO roadmap_items (project_id, bucket, title, note, done, position, source, fingerprint)
             VALUES ($1,$2,$3,'',false,$4,'hook',$5)`,
            [projectId, cand.bucket, cand.title, pos.rows[0].p, fp]
          );
          createdSteps++;
        }
      }
    }

    // --- 6. File the board row for what this session BUILT (#174) ---
    //
    // THIS NEVER TICKS AN ITEM. A row lands here as BUILT — a `built_note` plus
    // a claim — and never as `done`. That is #374's queue predicate exactly
    // (`done` OR (built_note AND claimed_by)), so the change reaches the Review
    // room for a verdict without a machine having awarded itself one. Ticking
    // belongs to the merge job, with a human verdict stored beside it, and a
    // session declaring its own work finished is precisely the judgement the
    // Review room exists to make.
    //
    // The claim is what makes it queue at all, so it is never left empty when
    // there is anything honest to put in it: the tmux session if the checkpoint
    // named one, else the branch the work is on.
    let builtLinked = 0;
    let builtCreated = 0;
    let builtMissed = 0;
    {
      const claim = session.fly_session
        ? `term:${session.fly_session}`.slice(0, 100)
        : (session.branch || '').slice(0, 100) || null;

      // Written only where it is EMPTY. A row already claimed by a lane keeps
      // that claim: the branch doing the work is a fact about the fleet, and
      // overwriting it with the checkpointing session would quietly reassign
      // somebody else's in-flight work.
      // Capped OUT LOUD, the same way PATCH /roadmap/:id caps it (BUG-12).
      // This route is the second writer of the column — a claim that the PATCH
      // was the only one is what left this path uncapped — and a note arriving
      // here is exactly as long as one arriving there: it is the same session's
      // account of the same work, just travelling in the checkpoint package
      // instead of a PATCH. Capping in only one of the two writers means the
      // marker's absence stops meaning "nothing was cut".
      const attach = async (id, note) => {
        await client.query(
          `UPDATE roadmap_items
              SET built_note = $2,
                  claimed_by = COALESCE(NULLIF(claimed_by, ''), $3),
                  updated_at = now()
            WHERE id = $1 AND project_id = $4`,
          [id, capNote(note) || null, claim, projectId]
        );
      };

      const seen = new Set();
      for (const cand of builtCandidates) {
        // --- the precise form: an id the session already claimed ---
        //
        // A NUMBER IS NOT A NAME, AND THIS REPO'S NUMBERS COLLIDE. Roadmap
        // items and bugs are separate id sequences, both cited as "#174" all
        // over the repo and the SessionStart block — so a session that means a
        // different table's #174 and sends `item: 174` lands on a completely
        // unrelated roadmap row. That is not hypothetical: it happened while
        // this very feature was being filed, and it overwrote the built_note of
        // an archived, human-verdicted item, which is unrecoverable.
        //
        // Two guards, and both refuse rather than write:
        if (cand.item) {
          const row = await client.query(
            'SELECT id, title, archived FROM roadmap_items WHERE id = $1 AND project_id = $2',
            [cand.item, projectId]
          );
          // 1. An id belonging to another project (or long deleted) is COUNTED
          //    and dropped, never coerced into a new row: silently creating a
          //    card because a number was wrong is how a board fills with
          //    near-duplicates of work that is already on it.
          if (!row.rows.length) { builtMissed++; continue; }

          // 2. AN ARCHIVED ROW IS HISTORY AND A CHECKPOINT MAY NOT REWRITE IT.
          //    Archived means the owner has finished with it — it has been
          //    built, verdicted and filed away. A session recording what it
          //    just built is never talking about one of those, so an id landing
          //    here is a wrong number by definition.
          if (row.rows[0].archived) { builtMissed++; continue; }

          // 3. If the entry ALSO names a title, it has to be the row's title.
          //    This is the guard with real teeth: it makes the caller say what
          //    it thinks it is writing to, so a wrong number is caught by the
          //    disagreement instead of being obeyed. Optional, because an entry
          //    that sends only an id is still the precise form — but the
          //    /checkpoint command asks for both, so in practice it always runs.
          if (cand.title && fingerprint(cand.title) !== fingerprint(row.rows[0].title)) {
            builtMissed++;
            continue;
          }

          if (seen.has(`id:${cand.item}`)) continue;
          seen.add(`id:${cand.item}`);
          await attach(cand.item, cand.note);
          builtLinked++;
          continue;
        }

        // --- the fallback: match a row by title, and only then make one ---
        const fp = fingerprint(cand.title);
        if (!fp || seen.has(`fp:${fp}`)) continue;
        seen.add(`fp:${fp}`);

        // ANY source, open rows first, oldest first. Any source because the
        // point is to land on the row that already represents this work,
        // whoever made it — including the fly card (#381) this same session
        // very likely opened when it started, which is what makes one row serve
        // the whole life of a piece of work rather than two describing its ends.
        const existing = await client.query(
          `SELECT id FROM roadmap_items
            WHERE project_id = $1 AND fingerprint = $2 AND NOT archived
            ORDER BY done ASC, id ASC LIMIT 1`,
          [projectId, fp]
        );
        if (existing.rows.length) {
          await attach(existing.rows[0].id, cand.note);
          builtLinked++;
          continue;
        }

        // Nothing to attach to — file the row nobody remembered to make. The
        // tombstone is honoured on CREATION only: a fingerprint the owner
        // dismissed must not come back as a by-product of a checkpoint.
        if (await dismissed('roadmap', fp)) continue;
        const pos = await client.query(
          'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM roadmap_items WHERE project_id=$1 AND bucket=$2',
          [projectId, cand.bucket]
        );
        await client.query(
          // source 'fly' (#381), not 'hook': a session made this row, and the
          // marker already means exactly that. It also keeps the row out of the
          // extractor's dedup index and inside the same dismiss contract.
          `INSERT INTO roadmap_items
             (project_id, bucket, title, note, done, position, source, fingerprint,
              built_note, claimed_by, area, fly_session)
           VALUES ($1,$2,$3,'',false,$4,'fly',$5,$6,$7,$8,$9)`,
          [projectId, cand.bucket, cand.title, pos.rows[0].p, fp,
            capNote(cand.note) || null, claim, cand.area, session.fly_session]
        );
        builtCreated++;
      }
    }

    // --- 7. Presence upkeep ---
    // An authored /checkpoint proves the session is alive → bump last_seen_at.
    // The metadata backstop (authored:false) only arrives when a session ends →
    // clear its presence row. (The SessionEnd hook also calls /presence/end
    // explicitly; this is the belt for machines running older hooks.)
    if (session.session_id) {
      if (authored) {
        await client.query(
          `UPDATE presence SET last_seen_at = now(), branch = COALESCE($3, branch)
            WHERE project_id = $1 AND session_id = $2`,
          [projectId, session.session_id, session.branch]
        );
      } else {
        await client.query(
          'DELETE FROM presence WHERE project_id = $1 AND session_id = $2',
          [projectId, session.session_id]
        );
      }
    }

    await client.query('COMMIT');

    // Post-commit, fire-and-forget: stamp the second model's one-line take on
    // this push (sessions.gemini_note). Never awaited — ingest's latency and
    // success are exactly what they were without Gemini.
    if (geminiEnabled() && sessionRowId) void stampGeminiNote(sessionRowId, authored);

    res.json({
      ok: true,
      project: slug,
      session: existingSession ? 'updated' : 'created',
      bugs: { created: createdBugs, relinked: relinkedBugs },
      roadmap: { created: createdSteps },
      // #174 — `missed` is REPORTED, not swallowed: an id that matched nothing
      // means a session cited a number that is not on this board, and the
      // /checkpoint command tells the session to relay that rather than let a
      // built_note vanish into a wrong id.
      built: { linked: builtLinked, created: builtCreated, missed: builtMissed },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ingest failed:', err);
    res.status(500).json({ error: 'Ingest failed.' });
  } finally {
    client.release();
  }
});

// The per-push Gemini annotation. Reads the row back fresh (the txn has
// committed), asks for one outside take, stamps it. An existing note is only
// refreshed when the incoming post was authored (the content got richer) —
// so a metadata backstop can't waste a call re-judging the same summary.
// Every failure is swallowed: an annotation must never surface as an error.
async function stampGeminiNote(sessionRowId, incomingAuthored) {
  try {
    const { rows } = await pool.query(
      `SELECT s.summary, s.current_phase, s.next_steps, s.gemini_note,
              p.name, p.north_star
         FROM sessions s JOIN projects p ON p.id = s.project_id
        WHERE s.id = $1`,
      [sessionRowId]
    );
    const row = rows[0];
    if (!row || !row.summary) return;
    if (row.gemini_note && !incomingAuthored) return;

    const out = await askGemini(buildPrompt('pushnote', {
      NAME: row.name,
      NORTH_STAR_LINE: row.north_star ? `North star: ${row.north_star}` : '',
      PHASE: row.current_phase || '—',
      SUMMARY: row.summary,
      NEXT_STEPS: asList(row.next_steps).join('; ') || '—',
    }));
    const note = String(out?.note || '').trim().slice(0, 500);
    if (note) await pool.query('UPDATE sessions SET gemini_note = $2 WHERE id = $1', [sessionRowId, note]);
  } catch { /* silent — see above */ }
}
