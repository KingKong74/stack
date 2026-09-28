// THE INBOX — everything across every project that is waiting on the human, in
// one read. Three queues and one sentence:
//
//   • built: work that is BUILT and has no verdict yet. "Built" is CLAUDE.md's
//     mirrored predicate (done, OR a built_note AND a claim), never `done`
//     alone. Each row carries its latest run, so the verdict is given against
//     evidence: checks, the reviewer's and architect's reads, cost. A NULL read
//     is NO REVIEW, never clean; the client says so.
//   • plans: held pieces a planning run filed (source 'plan'), grouped by
//     parent on the client. Approving is what lets them be queued to build.
//   • ideas: every other held row (hook, fly) that nobody has worked.
//   • loop: autopilot.js's loopStatus: whether the loop is running, and if not,
//     why, or that Stack cannot see the dispatcher.
//
// A read layer: a few aggregate queries, never one per project. The writes are
// the existing routes (PATCH /roadmap/:id, PUT /ready, POST /autopilot/merge
// and /start); this file only reads.

import { Router } from 'express';
import { q } from '../db.js';
import { roadmapItemShape } from '../shape.js';
import { PENDING_SQL } from '../approval.js';
import { loopStatus, runShape } from './autopilot.js';

export const inbox = Router();

const LIMIT = 200;

async function readInbox() {
  const { rows: built } = await q(`
    SELECT r.*, p.slug AS project_slug, p.name AS project_name
      FROM roadmap_items r JOIN projects p ON p.id = r.project_id AND p.deleted_at IS NULL
     WHERE NOT COALESCE(r.archived, false)
       AND COALESCE(r.review_tag, '') = ''
       AND (r.done OR (COALESCE(r.built_note, '') <> '' AND COALESCE(r.claimed_by, '') <> ''))
     ORDER BY r.updated_at DESC
     LIMIT ${LIMIT}`);
  const ids = built.map((r) => r.id);
  const { rows: runs } = ids.length ? await q(`
    SELECT DISTINCT ON (item_id) * FROM autopilot_runs
     WHERE item_id = ANY($1::int[])
     ORDER BY item_id, finished_at DESC`, [ids]) : { rows: [] };
  const runOf = new Map(runs.map((r) => [Number(r.item_id), runShape(r)]));

  const { rows: held } = await q(`
    SELECT r.*, p.slug AS project_slug, p.name AS project_name,
           par.title AS parent_title
      FROM roadmap_items r
      JOIN projects p ON p.id = r.project_id AND p.deleted_at IS NULL
      LEFT JOIN roadmap_items par ON par.id = r.parent_id
     WHERE ${PENDING_SQL('r')}
       AND NOT r.done AND NOT COALESCE(r.archived, false)
       AND COALESCE(r.claimed_by, '') = '' AND COALESCE(r.built_note, '') = ''
     ORDER BY r.parent_id NULLS LAST, r.id
     LIMIT ${LIMIT}`);

  const { rows: projects } = await q(`
    SELECT p.slug, p.name, p.automode,
           count(r.id) FILTER (WHERE r.ready_at IS NOT NULL AND NOT r.done
                                 AND COALESCE(r.claimed_by, '') = '')::int AS ready
      FROM projects p LEFT JOIN roadmap_items r ON r.project_id = p.id
     WHERE p.deleted_at IS NULL
     GROUP BY p.id ORDER BY p.name`);

  const where = (r) => ({ projectSlug: r.project_slug, projectName: r.project_name });
  return {
    built: built.map((r) => ({ ...roadmapItemShape(r), ...where(r), run: runOf.get(Number(r.id)) || null })),
    plans: held.filter((r) => r.source === 'plan')
      .map((r) => ({ ...roadmapItemShape(r), ...where(r), parentTitle: r.parent_title || '' })),
    ideas: held.filter((r) => r.source !== 'plan').map((r) => ({ ...roadmapItemShape(r), ...where(r) })),
    projects: projects.map((p) => ({ slug: p.slug, name: p.name, automode: Boolean(p.automode), ready: p.ready })),
    loop: await loopStatus(),
  };
}

inbox.get('/', async (_req, res) => { res.json(await readInbox()); });

// GET /count — the top bar's number: the same three queues, counted, and
// whether the loop is holding. One statement plus loopStatus.
inbox.get('/count', async (_req, res) => {
  const { rows } = await q(`
    SELECT
      (SELECT count(*) FROM roadmap_items r JOIN projects p ON p.id = r.project_id AND p.deleted_at IS NULL
        WHERE NOT COALESCE(r.archived, false) AND COALESCE(r.review_tag, '') = ''
          AND (r.done OR (COALESCE(r.built_note, '') <> '' AND COALESCE(r.claimed_by, '') <> '')))::int AS built,
      (SELECT count(*) FROM roadmap_items r JOIN projects p ON p.id = r.project_id AND p.deleted_at IS NULL
        WHERE ${PENDING_SQL('r')} AND NOT r.done AND NOT COALESCE(r.archived, false)
          AND COALESCE(r.claimed_by, '') = '' AND COALESCE(r.built_note, '') = '')::int AS held`);
  const loop = await loopStatus();
  res.json({ waiting: rows[0].built + rows[0].held, built: rows[0].built, held: rows[0].held, hold: loop.hold, seen: loop.seen });
});
