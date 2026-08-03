import { Router } from 'express';
import { q } from '../db.js';
import { asList } from '../util.js';

// GET /api/timeline — the cross-project push timeline + a year of daily counts
// for the contribution graph. Soft-deleted projects excluded throughout.
//
// Query params:
//   days  — the feed window in CALENDAR days, today counting as day 1 (so
//           days=3 is today plus the two previous UTC calendar days — what
//           the Today / Yesterday / day-label grouping below reads as "3
//           days"). Clamped to 1..371. Missing/non-finite falls back to 30,
//           unchanged, because the Dashboard's Pushes section also hits this
//           route and its copy says "the last 30 days".
//   graph — pass '0' or 'false' to skip the 371-day graph aggregate (graph:
//           [], total: 0). Extend re-fetches only the feed and should never
//           re-run the year-long aggregate.
//
// {
//   days:  [ { date: 'YYYY-MM-DD', label: 'Sat 5 Jul', entries: [
//              { slug, name, tint, hash, branch, summary, tags[], authored, time: '14:32' } ] } ],
//   graph: [ { date: 'YYYY-MM-DD', count } ],   // one entry per day with pushes, last 53 weeks
//   total: 123,                                  // pushes in the graph window
//   windowDays: 30,                              // the clamped `days` actually served
//   hasMore: true,                                // anything older than the window, to extend into
//   capped: false,                                // the entries list hit its row cap — see #239
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

const CUTOFF_SQL = `(date_trunc('day', now() AT TIME ZONE 'UTC') - ($1::int - 1) * interval '1 day') AT TIME ZONE 'UTC'`;

timeline.get('/', async (req, res) => {
  const parsedDays = Math.floor(Number(req.query.days));
  const windowDays = Number.isFinite(parsedDays) ? Math.min(371, Math.max(1, parsedDays)) : 30;
  const skipGraph = req.query.graph === '0' || req.query.graph === 'false';
  const limit = Math.min(1200, Math.max(300, windowDays * 40));

  const [entriesR, moreR, graphR] = await Promise.all([
    q(`SELECT s.commit_hash, s.branch, s.summary, s.tags, s.authored, s.gemini_note, s.created_at,
              p.slug, p.name, p.tint
         FROM sessions s JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
        WHERE s.created_at >= ${CUTOFF_SQL}
        ORDER BY s.created_at DESC
        LIMIT $2`, [windowDays, limit]),
    q(`SELECT EXISTS (SELECT 1 FROM sessions s JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
                        WHERE s.created_at < ${CUTOFF_SQL}) AS more`, [windowDays]),
    skipGraph ? Promise.resolve(null) : q(`SELECT to_char(s.created_at, 'YYYY-MM-DD') AS d, count(*)::int AS n
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
      geminiNote: r.gemini_note || '',
      authored: !!r.authored,
      time: `${String(created.getUTCHours()).padStart(2, '0')}:${String(created.getUTCMinutes()).padStart(2, '0')}`,
    });
  }
  const dayGroups = [...byDay.entries()].map(([date, entries]) => ({
    date, label: dayLabel(date), entries,
  }));

  const graph = graphR ? graphR.rows.map((r) => ({ date: r.d, count: r.n })) : [];
  const total = graph.reduce((sum, g) => sum + g.count, 0);
  const hasMore = !!moreR.rows[0]?.more;
  const capped = entriesR.rows.length >= limit;

  res.json({ days: dayGroups, graph, total, windowDays, hasMore, capped });
});
