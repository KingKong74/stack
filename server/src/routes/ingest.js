import { Router } from 'express';
import { pool } from '../db.js';
import {
  slugify, fingerprint, asList, oneOf, TINTS,
  SEVERITIES, BUCKETS,
} from '../util.js';
import { readSettings } from '../settings.js';

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

// Candidate futures list off the wire: [{ title, note? }] — loose directional
// ideas for the Futures tab, distinct from concrete next-steps.
function asFutureCandidates(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((f) => ({ title: str(f?.title, 300), note: str(f?.note, 1000) || '' }))
    .filter((f) => f.title)
    .slice(0, 25);
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
 *     futures?: [{ title, note? }]
 *   }
 * }
 *
 * One transaction: upsert project, record the session (idempotent on
 * commit/session id), refresh the live resume fields with COALESCE, then land
 * the auto-extracted bugs and roadmap items (deduped by fingerprint, honouring
 * tombstones, never touching manual items).
 */
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
    cwd: str(s.cwd, 500),
    model: str(s.model, 100),
    reason: str(s.reason, 100),
    message_count: Number.isFinite(s.message_count) ? Math.trunc(s.message_count) : null,
  };

  const bugCandidates = asBugCandidates(extract.bugs);
  const stepCandidates = asStepCandidates(extract.next_steps);
  const futureCandidates = asFutureCandidates(extract.futures);

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

    // --- 2. Record the session, idempotent on commit hash / session id ---
    let existingSession = null;
    if (commit) {
      const r = await client.query(
        'SELECT id FROM sessions WHERE project_id = $1 AND commit_hash = $2 LIMIT 1',
        [projectId, commit]
      );
      existingSession = r.rows[0] || null;
    }
    if (!existingSession && session.session_id) {
      const r = await client.query(
        'SELECT id FROM sessions WHERE project_id = $1 AND session_id = $2 LIMIT 1',
        [projectId, session.session_id]
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
           authored = (authored OR $15)
         WHERE id=$1`,
        // $1=id, $2..$14 as listed, $15=authored (boolean), $16=message_count
        [existingSession.id, session.session_id, session.commit_hash, session.summary,
         session.current_phase, JSON.stringify(session.next_steps), JSON.stringify(session.blockers),
         JSON.stringify(session.files_touched), JSON.stringify(session.tools_used),
         JSON.stringify(session.tags), session.branch, session.cwd, session.model,
         session.reason, authored, session.message_count]
      );
    } else {
      await client.query(
        `INSERT INTO sessions
           (project_id, session_id, commit_hash, summary, current_phase, next_steps,
            blockers, files_touched, tools_used, tags, branch, cwd, model, reason,
            message_count, authored, source)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,
                 $11,$12,$13,$14,$15,$16,'hook')`,
        [projectId, ...sessionCols]
      );
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

    // --- 6. Land auto-extracted futures (directional ideas) ---
    let createdFutures = 0;
    {
      const seen = new Set();
      for (const cand of futureCandidates) {
        const fp = fingerprint(cand.title);
        if (!fp || seen.has(fp)) continue;
        seen.add(fp);
        if (await dismissed('future', fp)) continue;

        const existing = await client.query(
          `SELECT id FROM futures WHERE project_id=$1 AND fingerprint=$2 AND source='hook'`,
          [projectId, fp]
        );
        if (existing.rows.length) {
          await client.query('UPDATE futures SET updated_at = now() WHERE id = $1', [
            existing.rows[0].id,
          ]);
        } else {
          await client.query(
            `INSERT INTO futures (project_id, title, note, source, fingerprint)
             VALUES ($1,$2,$3,'hook',$4)`,
            [projectId, cand.title, cand.note, fp]
          );
          createdFutures++;
        }
      }
    }

    await client.query('COMMIT');
    res.json({
      ok: true,
      project: slug,
      session: existingSession ? 'updated' : 'created',
      bugs: { created: createdBugs, relinked: relinkedBugs },
      roadmap: { created: createdSteps },
      futures: { created: createdFutures },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ingest failed:', err);
    res.status(500).json({ error: 'Ingest failed.' });
  } finally {
    client.release();
  }
});
