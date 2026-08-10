import { Router } from 'express';
import { q } from '../db.js';
import { asList } from '../util.js';

// GET /api/timeline — the cross-project feed of what happened, day by day, plus
// a year of daily counts for the contribution graph. Soft-deleted projects
// excluded throughout.
//
// A DAY HAS TWO FEEDS, and they are separate arrays rather than one mixed list
// because they answer different questions (#381):
//
//   entries[] — session rows: work that LANDED, with a commit behind it.
//   flies[]   — roadmap cards a live session opened for work it had just
//               started. Work that BEGAN, with nothing behind it yet.
//
// Not interleaved into one list, because every count, cap and piece of copy
// already built on `entries` means PUSHES, and quietly widening it would turn
// "6 pushes" into a number that is not the pushes. A day of real pushes and a
// day of started-and-abandoned work look identical if only the first is
// recorded, which is the gap this fills: the whole point of the fly marker is
// being able to ask "what did Tuesday's sessions actually start" afterwards.
//
// THE GRAPH STAYS PUSHES ONLY. It is the contribution graph — squares for work
// that landed — and folding in cards-opened would let a session brighten a day
// by announcing intentions. Same reasoning as `planned` runs sitting out the
// land rate: counting intent as output flatters the wrong thing.
//
// `hasMore` and `capped` also track pushes only. Both answer questions about
// the SESSION history (is there older history to extend into; did the entries
// list hit its row cap), and the fly half is a small rider on the same window.
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
//   days:  [ { date: 'YYYY-MM-DD', label: 'Sat 5 Jul',
//              entries: [ { kind: 'push', slug, name, tint, hash, branch, summary,
//                           tags[], authored, time: '14:32' } ],
//              // #381 — cards live sessions opened that day, newest first.
//              flies:   [ { kind: 'fly', slug, name, tint, id, title, note,
//                           session, bucket, area, reviewed, done, time } ] } ],
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

// #381 — the fly feed's own row cap, separate from the push feed's so a chatty
// night cannot crowd out the commits. Flat rather than scaled by the window:
// this feed answers "what did sessions start recently", and a year of it is a
// board query, not a timeline.
const FLY_LIMIT = 300;

const hhmm = (d) =>
  `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;

timeline.get('/', async (req, res) => {
  const parsedDays = Math.floor(Number(req.query.days));
  const windowDays = Number.isFinite(parsedDays) ? Math.min(371, Math.max(1, parsedDays)) : 30;
  const skipGraph = req.query.graph === '0' || req.query.graph === 'false';
  const limit = Math.min(1200, Math.max(300, windowDays * 40));

  const [entriesR, moreR, graphR, fliesR] = await Promise.all([
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
    // #381 — the cards live sessions opened inside the same window. Its own
    // cap: a chatty night must not be able to push the pushes out of the feed,
    // and a day showing 40 cards and none of its commits would be a worse
    // answer than one showing both, capped.
    q(`SELECT r.id, r.title, r.note, r.bucket, r.area, r.fly_session, r.reviewed_at, r.done,
              r.created_at, p.slug, p.name, p.tint
         FROM roadmap_items r JOIN projects p ON p.id = r.project_id AND p.deleted_at IS NULL
        WHERE r.source = 'fly' AND r.created_at >= ${CUTOFF_SQL}
        ORDER BY r.created_at DESC
        LIMIT $2`, [windowDays, FLY_LIMIT]),
  ]);

  // Group both feeds by calendar day, newest day first. A day exists if EITHER
  // feed has something in it — a day on which sessions opened cards and pushed
  // nothing is a real day, and dropping it would hide exactly the pattern the
  // fly marker exists to make visible.
  const byDay = new Map();
  const dayOf = (key) => {
    if (!byDay.has(key)) byDay.set(key, { entries: [], flies: [] });
    return byDay.get(key);
  };
  for (const r of entriesR.rows) {
    const created = new Date(r.created_at);
    dayOf(dateKey(created)).entries.push({
      kind: 'push',
      slug: r.slug,
      name: r.name,
      tint: r.tint || null,
      hash: r.commit_hash || '—',
      branch: r.branch || 'main',
      summary: r.summary || '',
      tags: asList(r.tags),
      geminiNote: r.gemini_note || '',
      authored: !!r.authored,
      time: hhmm(created),
    });
  }
  for (const r of fliesR.rows) {
    const created = new Date(r.created_at);
    dayOf(dateKey(created)).flies.push({
      kind: 'fly',
      slug: r.slug,
      name: r.name,
      tint: r.tint || null,
      id: r.id,
      title: r.title,
      note: r.note || '',
      // '' = a session that did not name itself. The client says "an unnamed
      // session" rather than dropping the row — same rule as a NULL verdict:
      // absent provenance is not absent work.
      session: r.fly_session || '',
      bucket: r.bucket,
      area: r.area || '',
      // Where the card got to. Both are the reason to look at this feed at all:
      // an unsigned card is one you have still to decide about, and a done one
      // is a session's ad-hoc work that actually finished.
      reviewed: !!r.reviewed_at,
      done: !!r.done,
      time: hhmm(created),
    });
  }
  // Newest day first. Sorted explicitly rather than relying on insertion order,
  // which was the push feed's order alone and is no longer the whole story: a
  // day with flies and no pushes enters the map wherever the fly query put it.
  const dayGroups = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([date, feeds]) => ({
      date, label: dayLabel(date), entries: feeds.entries, flies: feeds.flies,
    }));

  const graph = graphR ? graphR.rows.map((r) => ({ date: r.d, count: r.n })) : [];
  const total = graph.reduce((sum, g) => sum + g.count, 0);
  const hasMore = !!moreR.rows[0]?.more;
  const capped = entriesR.rows.length >= limit;

  res.json({ days: dayGroups, graph, total, windowDays, hasMore, capped });
});
