import { Router } from 'express';
import { q } from '../db.js';
import { asList } from '../util.js';

// GET /api/timeline — the cross-project push timeline + a year of daily counts
// for the contribution graph. Two aggregate queries, soft-deleted projects
// excluded.
//
// {
//   days:  [ { date: 'YYYY-MM-DD', label: 'Sat 5 Jul', entries: [
//              { slug, name, tint, hash, branch, summary, tags[], authored, time: '14:32' } ] } ],
//   graph: [ { date: 'YYYY-MM-DD', count } ],   // one entry per day with pushes, last 53 weeks
//   total: 123                                   // pushes in the graph window
// }
export const timeline = Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const dateKey = (d) => d.toISOString().slice(0, 10);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayLabel(key) {
  const d = new Date(`${key}T00:00:00Z`);
  const today = dateKey(new Date());
  const yesterday = dateKey(new Date(Date.now() - DAY_MS));
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

timeline.get('/', async (_req, res) => {
  const [entriesR, graphR] = await Promise.all([
    q(`SELECT s.commit_hash, s.branch, s.summary, s.tags, s.authored, s.created_at,
              p.slug, p.name, p.tint
         FROM sessions s JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
        WHERE s.created_at > now() - interval '30 days'
        ORDER BY s.created_at DESC
        LIMIT 300`),
    q(`SELECT to_char(s.created_at, 'YYYY-MM-DD') AS d, count(*)::int AS n
         FROM sessions s JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
        WHERE s.created_at > now() - interval '371 days'
        GROUP BY 1`),
  ]);

  // Group the recent entries by calendar day, newest day first.
  const byDay = new Map();
  for (const r of entriesR.rows) {
    const created = new Date(r.created_at);
    const key = dateKey(created);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({
      slug: r.slug,
      name: r.name,
      tint: r.tint || null,
      hash: r.commit_hash || '—',
      branch: r.branch || 'main',
      summary: r.summary || '',
      tags: asList(r.tags),
      authored: !!r.authored,
      time: `${String(created.getUTCHours()).padStart(2, '0')}:${String(created.getUTCMinutes()).padStart(2, '0')}`,
    });
  }
  const days = [...byDay.entries()].map(([date, entries]) => ({
    date, label: dayLabel(date), entries,
  }));

  const graph = graphR.rows.map((r) => ({ date: r.d, count: r.n }));
  const total = graph.reduce((sum, g) => sum + g.count, 0);

  res.json({ days, graph, total });
});
