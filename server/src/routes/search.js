import { Router } from 'express';
import { q } from '../db.js';
import { relativeTime, PRIORITY_SHORT } from '../util.js';

// GET /api/search?q=… — the ⌘K command palette.
//
// Case-insensitive match across project names/subtitles, bug titles, roadmap
// titles/notes, note text and session summaries. Results are grouped by kind;
// each carries its owning project (slug/name/tint), a display title, a meta
// field and a navigation target { slug, tab, highlight }. The tab disambiguates
// what `highlight` means: a commit hash (activity), a bug key (bugs) or a row id
// (roadmap/notes). Each group and the overall total are capped; an empty query
// returns nothing.
//
// Response shape:
// {
//   query: "…",
//   groups: {
//     projects: [ { kind, slug, name, tint, title, meta, target } ],
//     bugs:     [ … ], roadmap: [ … ], futures: [ … ], notes: [ … ], activity: [ … ]
//   },
//   counts: { projects, bugs, roadmap, futures, notes, activity, total },
//   projectCount: 3            // distinct projects across all results
// }
export const search = Router();

const PER_GROUP = 6;   // cap per kind
const TOTAL_CAP = 24;  // cap across all kinds

// Escape LIKE metacharacters so a literal % or _ in the query matches literally.
const likePattern = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const trim = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

search.get('/', async (req, res) => {
  const query = String(req.query.q || '').trim();
  const empty = {
    query,
    groups: { projects: [], bugs: [], roadmap: [], futures: [], notes: [], activity: [] },
    counts: { projects: 0, bugs: 0, roadmap: 0, futures: 0, notes: 0, activity: 0, total: 0 },
    projectCount: 0,
  };
  if (!query) return res.json(empty);

  const pat = likePattern(query);

  const [projR, bugR, roadR, futR, noteR, actR] = await Promise.all([
    q(
      `SELECT slug, name, tint, status, subtitle FROM projects
        WHERE deleted_at IS NULL AND (name ILIKE $1 OR subtitle ILIKE $1)
        ORDER BY pinned DESC, last_session_at DESC NULLS LAST
        LIMIT $2`,
      [pat, PER_GROUP]
    ),
    q(
      `SELECT b.bug_key, b.title, b.status, p.slug, p.name, p.tint
         FROM bugs b JOIN projects p ON p.id = b.project_id AND p.deleted_at IS NULL
        WHERE b.title ILIKE $1
        ORDER BY b.created_at DESC
        LIMIT $2`,
      [pat, PER_GROUP]
    ),
    q(
      `SELECT r.id, r.title, r.note, r.bucket, p.slug, p.name, p.tint
         FROM roadmap_items r JOIN projects p ON p.id = r.project_id AND p.deleted_at IS NULL
        WHERE r.title ILIKE $1 OR r.note ILIKE $1
        ORDER BY r.updated_at DESC NULLS LAST, r.created_at DESC
        LIMIT $2`,
      [pat, PER_GROUP]
    ),
    q(
      `SELECT f.id, f.title, f.note, p.slug, p.name, p.tint
         FROM futures f JOIN projects p ON p.id = f.project_id AND p.deleted_at IS NULL
        WHERE f.title ILIKE $1 OR f.note ILIKE $1
        ORDER BY f.created_at DESC
        LIMIT $2`,
      [pat, PER_GROUP]
    ),
    q(
      `SELECT n.id, n.text, n.created_at, p.slug, p.name, p.tint
         FROM notes n JOIN projects p ON p.id = n.project_id AND p.deleted_at IS NULL
        WHERE n.text ILIKE $1
        ORDER BY n.created_at DESC
        LIMIT $2`,
      [pat, PER_GROUP]
    ),
    q(
      `SELECT s.commit_hash, s.branch, s.summary, s.created_at, p.slug, p.name, p.tint
         FROM sessions s JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
        WHERE s.summary ILIKE $1
        ORDER BY s.created_at DESC
        LIMIT $2`,
      [pat, PER_GROUP]
    ),
  ]);

  const projects = projR.rows.map((r) => ({
    kind: 'project',
    slug: r.slug, name: r.name, tint: r.tint || null,
    title: r.name,
    meta: r.subtitle ? trim(r.subtitle, 60) : r.status,
    target: { slug: r.slug, tab: 'overview', highlight: null },
  }));

  const bugs = bugR.rows.map((r) => ({
    kind: 'bug',
    slug: r.slug, name: r.name, tint: r.tint || null,
    title: r.title,
    meta: r.status,
    target: { slug: r.slug, tab: 'bugs', highlight: r.bug_key },
  }));

  const roadmap = roadR.rows.map((r) => ({
    kind: 'roadmap',
    slug: r.slug, name: r.name, tint: r.tint || null,
    title: r.title,
    meta: PRIORITY_SHORT[r.bucket] || r.bucket,
    target: { slug: r.slug, tab: 'roadmap', highlight: String(r.id) },
  }));

  const futures = futR.rows.map((r) => ({
    kind: 'future',
    slug: r.slug, name: r.name, tint: r.tint || null,
    title: r.title,
    meta: 'idea',
    target: { slug: r.slug, tab: 'futures', highlight: String(r.id) },
  }));

  const notes = noteR.rows.map((r) => ({
    kind: 'note',
    slug: r.slug, name: r.name, tint: r.tint || null,
    title: trim(r.text, 90),
    meta: relativeTime(r.created_at) || 'just now',
    target: { slug: r.slug, tab: 'notes', highlight: String(r.id) },
  }));

  const activity = actR.rows.map((r) => ({
    kind: 'activity',
    slug: r.slug, name: r.name, tint: r.tint || null,
    title: trim(r.summary, 90) || (r.commit_hash || 'push'),
    meta: relativeTime(r.created_at) || 'just now',
    target: { slug: r.slug, tab: 'activity', highlight: r.commit_hash || null },
  }));

  // Apply the overall total cap, trimming from the largest groups so no single
  // kind crowds the rest out.
  const groups = { projects, bugs, roadmap, futures, notes, activity };
  let total = Object.values(groups).reduce((n, g) => n + g.length, 0);
  const order = ['activity', 'notes', 'futures', 'roadmap', 'bugs', 'projects']; // trim these first
  while (total > TOTAL_CAP) {
    const key = order.find((k) => groups[k].length === Math.max(...order.map((o) => groups[o].length)));
    if (!key || !groups[key].length) break;
    groups[key].pop();
    total--;
  }

  const counts = {
    projects: groups.projects.length,
    bugs: groups.bugs.length,
    roadmap: groups.roadmap.length,
    futures: groups.futures.length,
    notes: groups.notes.length,
    activity: groups.activity.length,
    total,
  };

  const slugs = new Set();
  for (const g of Object.values(groups)) for (const r of g) slugs.add(r.slug);

  res.json({ query, groups, counts, projectCount: slugs.size });
});
