import { useEffect, useMemo, useState } from 'react';
import {
  getProjectDetail, patchRoadmapItem, deleteRoadmapItem, cleanupRoadmap,
  getPlanLanes, setPlanLanes, startAutopilot, PLAN_LANE_CHOICES,
  type ProjectDetailData, type ControlData, type AutopilotSchedule, type RoadmapCleanupSuggestion,
} from '../store';
import { go } from '../lib/route';
import { FALLBACK_ADVISORS, FALLBACK_EXECUTORS, modelLabel } from '../lib/ui';
import type { RoadmapItem, Priority, Tier } from '../types';
import { tierRank } from '../types';

// The Nights / Plan / Build rooms of Mission Control (Stack Planning design,
// turn 14a). Each room is a different lens on data the shell already holds —
// plus, for Plan and Build, the picked project's own detail payload.

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

// ---- shared: the picked project's detail, cached briefly so switching rooms
// (Plan ↔ Build share the pick) doesn't refetch every mount ----
const detailCache = new Map<string, { data: ProjectDetailData; at: number }>();

function useProjectDetail(slug: string) {
  const [detail, setDetail] = useState<ProjectDetailData | null>(detailCache.get(slug)?.data ?? null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const hit = detailCache.get(slug);
    setDetail(hit?.data ?? null);
    setErr('');
    if (hit && Date.now() - hit.at < 60_000) return;
    let alive = true;
    getProjectDetail(slug)
      .then((d) => {
        detailCache.set(slug, { data: d, at: Date.now() });
        if (alive) setDetail(d);
      })
      .catch((e) => { if (alive) setErr((e as Error)?.message || 'Could not load the project.'); });
    return () => { alive = false; };
  }, [slug]);
  return { detail, err };
}

// The Plan/Build project picker — automode projects lead (payload order).
function ProjectPicker({ data, pickSlug, onPick }: {
  data: ControlData; pickSlug: string; onPick: (slug: string) => void;
}) {
  return (
    <div className="mc14-picker" role="tablist" aria-label="Project">
      {data.projects.map((p) => (
        <button key={p.slug} role="tab" aria-selected={p.slug === pickSlug}
          className={`mc14-pick-chip ${p.slug === pickSlug ? 'on' : ''}`}
          onClick={() => onPick(p.slug)}>
          <span className="tintdot" style={{ background: p.tint || 'var(--sand)' }} />
          {p.name}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nights — the calendar (12a inside 14a): a week of lanes per project. Past
// cells carry real outcomes (autopilot_runs), future cells their bookings
// (schedules + the armed nightly). Click a cell for the night's detail.
// ---------------------------------------------------------------------------

type NightCell = {
  date: string; dow: number; past: boolean; today: boolean;
  runs: NonNullable<NonNullable<ControlData['usage']>['recentRuns']>;
  books: AutopilotSchedule[];
  nightly: boolean;
};

const scheduleWhen = (s: { days: number[]; runDate: string | null; atTime: string }) => {
  if (s.runDate) return `once · ${s.runDate} ${s.atTime}`;
  if (s.days.length === 7) return `daily · ${s.atTime}`;
  return `${s.days.map((d) => DAY_LABELS[d]).join(' ')} · ${s.atTime}`;
};

export function NightsRoom({ data, onOpenPlanner, onRunNow, onToggleSchedule, onRemoveSchedule }: {
  data: ControlData;
  onOpenPlanner: (row: AutopilotSchedule | null) => void;
  onRunNow: (slug: string) => void;
  onToggleSchedule: (id: string, enabled: boolean) => void;
  onRemoveSchedule: (id: string) => void;
}) {
  const [sel, setSel] = useState<{ slug: string; date: string } | null>(null);

  // A 7-day window, three nights back through three ahead. Runs are bucketed
  // by UTC day server-side; an evening host-local run lands on the same UTC
  // date for any timezone east of the Atlantic, so the lanes read true.
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + i - 3);
    return d;
  }), []);
  const todayStr = fmtDate(new Date());
  const runs = data.usage?.recentRuns ?? [];

  // Rows: any project the week actually touches — automode, a schedule, or a run.
  const rows = data.projects.filter((p) =>
    p.automode
    || data.schedules.some((s) => s.slug === p.slug)
    || runs.some((r) => r.slug === p.slug));

  const cellFor = (slug: string, d: Date): NightCell => {
    const date = fmtDate(d);
    return {
      date,
      dow: d.getDay(),
      past: date < todayStr,
      today: date === todayStr,
      runs: runs.filter((r) => r.slug === slug && r.day === date),
      books: data.schedules.filter((s) => s.enabled && s.slug === slug
        && (s.runDate ? s.runDate === date : s.days.includes(d.getDay()))
        && date >= todayStr),
      nightly: data.autopilot.enabled && date >= todayStr
        && !!data.projects.find((p) => p.slug === slug)?.automode,
    };
  };

  const outcomeOf = (cell: NightCell) => {
    if (cell.runs.some((r) => r.outcome === 'failed')) return 'failed';
    if (cell.runs.some((r) => r.outcome === 'limit')) return 'limit';
    if (cell.runs.some((r) => r.outcome === 'landed')) return 'landed';
    return 'quiet'; // ran but nothing landed
  };

  const selRow = sel && rows.find((p) => p.slug === sel.slug);
  const selCell = sel && selRow ? cellFor(sel.slug, new Date(`${sel.date}T12:00:00`)) : null;
  const selDate = sel ? new Date(`${sel.date}T12:00:00`) : null;

  return (
    <div className="mc14-nights">
      <div className="mc14-room-head">
        <span className="title">Nights</span>
        <span className="meta">{fmtDate(days[0]).slice(5)} → {fmtDate(days[6]).slice(5)}</span>
        <div style={{ flex: 1 }} />
        <span className="mc14-legend"><i className="landed" /> landed</span>
        <span className="mc14-legend"><i className="failed" /> failed</span>
        <span className="mc14-legend"><i className="limit" /> limit</span>
        <span className="mc14-legend"><i className="booked" /> booked</span>
        <button className="btn-repo sm" onClick={() => onOpenPlanner(null)}>+ Plan a session</button>
      </div>

      {rows.length === 0 ? (
        <div className="mc14-empty">No nights yet — flip a project onto automode, or plan a session, and the week fills in.</div>
      ) : (
        <>
          <div className="mc14-cal-days">
            <span className="gutter" />
            {days.map((d) => {
              const date = fmtDate(d);
              return (
                <span key={date} className={`day ${date === todayStr ? 'today' : ''}`}>
                  <b>{date === todayStr ? 'Today' : DAY_LABELS[d.getDay()]}</b>
                  <i>{d.getDate()}</i>
                </span>
              );
            })}
          </div>
          {rows.map((p) => (
            <div className="mc14-cal-row" key={p.slug}>
              <button className="gutter" onClick={() => go.detail(p.slug)} title={`Open ${p.name}`}>
                <span className="tintdot" style={{ background: p.tint || 'var(--sand)' }} />
                <span className="nm">{p.name}</span>
              </button>
              {days.map((d) => {
                const cell = cellFor(p.slug, d);
                const on = sel?.slug === p.slug && sel?.date === cell.date;
                const kind = cell.runs.length ? outcomeOf(cell)
                  : cell.books.length ? 'booked'
                  : cell.nightly ? 'nightly' : 'empty';
                const label = cell.runs.length
                  ? (kind === 'landed' ? `${cell.runs.filter((r) => r.outcome === 'landed').length} landed`
                    : kind === 'failed' ? 'failed' : kind === 'limit' ? 'limit' : 'no commits')
                  : cell.books.length ? `${cell.books[0].atTime}${cell.books.length > 1 ? ` +${cell.books.length - 1}` : ''}`
                  : cell.nightly ? `${data.autopilot.time}` : '';
                const sub = cell.runs.length
                  ? `${fmtTok(cell.runs.reduce((n, r) => n + r.tokens, 0))} tok`
                  : cell.books.length
                    ? (cell.books[0].agenda.length ? `${cell.books[0].kind} ☰${cell.books[0].agenda.length}`
                      : cell.books[0].kind !== 'build' ? cell.books[0].kind
                      : cell.books[0].area || 'board order')
                  : cell.nightly ? 'nightly' : '';
                return (
                  <button key={cell.date} className={`mc14-cell ${kind} ${on ? 'on' : ''} ${cell.today ? 'today' : ''}`}
                    onClick={() => setSel(on ? null : { slug: p.slug, date: cell.date })}
                    title={`${p.name} · ${cell.date}`}>
                    <span className="l">{label || '·'}</span>
                    {sub && <span className="s">{sub}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          <div className="mc14-cal-load">
            <span className="gutter" />
            {days.map((d) => {
              const date = fmtDate(d);
              const n = rows.reduce((acc, p) => {
                const c = cellFor(p.slug, d);
                return acc + (c.runs.length || c.books.length || (c.nightly ? 1 : 0) ? 1 : 0);
              }, 0);
              return (
                <span key={date} className="load">
                  <span className="bar"><span style={{ width: `${rows.length ? Math.round((n / rows.length) * 100) : 0}%` }} /></span>
                  <i>{n ? `${n} lane${n === 1 ? '' : 's'}` : '—'}</i>
                </span>
              );
            })}
          </div>

          {selCell && selRow && selDate && (
            <div className="mc14-night-detail">
              <div className="head">
                <span className="title">{selRow.name} — {DAY_LABELS[selDate.getDay()]} {selDate.getDate()}</span>
                <span className={`badge ${selCell.runs.length ? outcomeOf(selCell) : selCell.books.length || selCell.nightly ? 'booked' : 'empty'}`}>
                  {selCell.runs.length ? outcomeOf(selCell) : selCell.past ? 'quiet' : selCell.books.length ? 'booked' : selCell.nightly ? 'nightly' : 'open'}
                </span>
                <div style={{ flex: 1 }} />
                <span className="meta">
                  {selCell.runs.length > 0 && `${selCell.runs.length} run${selCell.runs.length === 1 ? '' : 's'} · ${fmtTok(selCell.runs.reduce((n, r) => n + r.tokens, 0))} tok`}
                </span>
              </div>
              <div className="items">
                {selCell.runs.map((r, i) => (
                  <button key={`r${i}`} className="item" onClick={() => r.itemId && go.detail(r.slug, 'roadmap', r.itemId)}>
                    <span className={`tag ${r.outcome}`}>{r.outcome.toUpperCase()}</span>
                    <span className="t">{r.itemId ? `#${r.itemId} ` : ''}{r.itemTitle || 'general session'}</span>
                    <span className="m">{fmtTok(r.tokens)} tok · {r.when}</span>
                  </button>
                ))}
                {!selCell.past && selCell.books.map((s) => (
                  <button key={s.id} className="item" onClick={() => onOpenPlanner(s)} title="Open the session plan">
                    <span className="tag booked">{s.kind.toUpperCase()}</span>
                    <span className="t">
                      {s.agenda.length ? `${s.agenda.length} on the agenda, in order`
                        : s.itemId ? `#${s.itemId} ${s.itemTitle || 'pinned item'}`
                        : s.area ? `the board, scoped to ${s.area}` : "the board's own priority order"}
                    </span>
                    <span className="m">{s.atTime} ✎</span>
                  </button>
                ))}
                {!selCell.past && selCell.nightly && (
                  <div className="item quiet">
                    <span className="tag nightly">NIGHTLY</span>
                    <span className="t">the armed nightly — {data.autopilot.maxItems === 0
                      ? 'unlimited items (the clock and token budget govern)'
                      : `up to ${data.autopilot.maxItems} item${data.autopilot.maxItems === 1 ? '' : 's'}`}, must before should</span>
                    <span className="m">{data.autopilot.time}</span>
                  </div>
                )}
                {selCell.runs.length === 0 && selCell.books.length === 0 && !selCell.nightly && (
                  <div className="item quiet"><span className="t">{selCell.past ? 'Nothing ran this night.' : 'Nothing booked — plan a session or Run now.'}</span></div>
                )}
              </div>
              <div className="acts">
                {!selCell.past && (
                  <button className="mc-run" onClick={() => onRunNow(selRow.slug)}
                    title="Queue a session on this project now — the host picks it up within a minute">▶ Run now</button>
                )}
                {selCell.runs.length > 0 && (
                  <button className="btn-repo sm" onClick={() => go.detail(selRow.slug, 'roadmap')}>→ Reviews</button>
                )}
              </div>
            </div>
          )}

          {/* The standing list — the editing surface behind the grid. */}
          {data.schedules.length > 0 && (
            <div className="mc-sched-list mc14-standing">
              {data.schedules.map((s) => (
                <div className={`mc-sched-row ${s.enabled ? '' : 'off'}`} key={s.id}>
                  <button role="switch" aria-checked={s.enabled} aria-label={`Schedule for ${s.name}`}
                    className={`switch sm ${s.enabled ? 'on' : ''}`}
                    onClick={() => onToggleSchedule(s.id, !s.enabled)}>
                    <span className="switch-knob" />
                  </button>
                  <button className="mc-name sm" onClick={() => go.detail(s.slug)}>
                    <span className="tintdot" style={{ background: s.tint || 'var(--sand)' }} />
                    {s.name}
                  </button>
                  <button className="mc-sched-open" onClick={() => onOpenPlanner(s)}
                    title="Open the session plan — kind, agenda, scope">
                    <span className="mc-sched-when">{scheduleWhen(s)}</span>
                    {s.kind !== 'build' && <span className={`mc-kind ${s.kind}`}>{s.kind}</span>}
                    {s.agenda.length > 0 && (
                      <span className="mc-agenda-n" title={`${s.agenda.length} on the agenda, worked in order`}>☰ {s.agenda.length}</span>
                    )}
                    {s.area && !s.agenda.length && <span className="mc-agenda-n">{s.area}</span>}
                    <span className="mc-sched-edit">✎</span>
                  </button>
                  {s.itemId && !s.agenda.length && (
                    <button className="mc-pick" title={s.itemTitle}
                      onClick={() => go.detail(s.slug, 'roadmap', s.itemId!)}>#{s.itemId} {s.itemTitle || 'roadmap item'}</button>
                  )}
                  {s.note && <span className="mc-sched-note" title={s.note}>{s.note}</span>}
                  <button className="mc-sched-del" aria-label="Remove schedule" onClick={() => onRemoveSchedule(s.id)}>×</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan — the ordered schedule with the inbox beside it (16a = 15a + 15b).
// Order IS the plan: the list is the runner's actual queue (board order,
// musts first), each row wearing the night it lands on under the real
// capacity (Settings' items/night). Reorder with the handles — moving across
// the must/should boundary re-buckets the moved item — and Save writes it
// back through the normal position/bucket PATCH. The inbox holds what the
// sessions found (hook-extracted items awaiting review) and what Claude
// proposes (✧ the board's cleanup pass); accepting visibly moves the dates,
// and every accept is one undo away. Dismissing a found item tombstones it.
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;

// Mirrors the runner's pick rule (open, unclaimed, not parked, approved,
// inside the target area) — the schedule holds exactly what it would work.
const schedulable = (it: RoadmapItem, area: string) =>
  !it.done && !it.skipped && !it.claimedBy
  && (it.bucket === 'must' || it.bucket === 'should')
  && (it.source === 'manual' || it.reviewed)
  && (!area || (it.area || '') === area);

const heldWhy = (it: RoadmapItem, area: string): string => {
  if (it.claimedBy) return `⚑ ${it.claimedBy}`;
  if (it.skipped) return 'parked';
  if (it.source === 'hook' && !it.reviewed) return 'in the inbox →';
  if (area && (it.area || '') !== area) return `outside ${area}`;
  return 'below the line';
};

const nightDate = (night: number) => new Date(Date.now() + night * DAY_MS);
const nightLabel = (night: number) => {
  if (night === 0) return 'tonight';
  if (night === 1) return 'tomorrow';
  const d = nightDate(night);
  return night < 7
    ? `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getDate()}`
    : `≈ ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
};

type PlanProposal =
  | { key: string; kind: 'found'; it: RoadmapItem }
  | { key: string; kind: 'cleanup'; s: RoadmapCleanupSuggestion };
type Settled = { note: string; undo?: () => void };

export function PlanRoom({ data, pickSlug, onPick, onSetMaxItems, onSetModel }: {
  data: ControlData; pickSlug: string; onPick: (slug: string) => void;
  onSetMaxItems: (n: number) => void;
  onSetModel: (patch: { autopilotExecutorModel?: string; autopilotAdvisorModel?: string }) => void;
}) {
  const { detail, err } = useProjectDetail(pickSlug);
  const [items, setItems] = useState<RoadmapItem[] | null>(null);
  const [order, setOrder] = useState<number[] | null>(null); // dirty overlay; null = saved order
  // Unsaved cross-boundary moves: the moved item's pending bucket. A separate
  // overlay (not a mutation of items) so revert is exact.
  const [flips, setFlips] = useState<Map<number, Priority>>(new Map());
  // #227 — the same overlay for desire tiers: moving a row across a tier
  // boundary re-tiers the moved item, exactly as crossing must/should re-buckets it.
  const [tierFlips, setTierFlips] = useState<Map<number, Tier>>(new Map());
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<Settled | null>(null);
  const [settled, setSettled] = useState<Map<string, Settled>>(new Map());
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [cleanups, setCleanups] = useState<RoadmapCleanupSuggestion[] | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [roomErr, setRoomErr] = useState('');
  // #260 — parallel-session planning (device-local) and the plan-session push.
  const [lanes, setLanes] = useState<number>(() => getPlanLanes());
  const [heldAll, setHeldAll] = useState(false);   // OUT OF THE SCHEDULE: show every held item
  const [planBusy, setPlanBusy] = useState(false);
  const [planNote, setPlanNote] = useState('');

  // Local working copy of the roadmap — mutations land here AND via PATCH;
  // switching projects resets everything, including the one-step undo.
  useEffect(() => {
    if (detail) {
      setItems([...detail.roadmap.must, ...detail.roadmap.should, ...detail.roadmap.could, ...detail.roadmap.wont]);
      setOrder(null); setFlips(new Map()); setTierFlips(new Map()); setBanner(null); setSettled(new Map()); setDropped(new Set());
      setCleanups(null); setRoomErr('');
    }
  }, [detail]);

  const proj = data.projects.find((p) => p.slug === pickSlug);
  const area = proj?.autopilotArea || '';
  // Items a session works, 0 = unlimited (#260) — the night's clock and token
  // budget are then the only governors, so the whole queue projects onto tonight.
  const cap = data.autopilot.maxItems === 0 ? Infinity : Math.max(1, data.autopilot.maxItems);
  // How many sessions you intend to run in parallel (#260). A planning lens, not
  // a promise: the overnight runner is one lane; the rest are sessions you (or
  // another machine) start — Stack's lane claims already keep them from
  // colliding. Device-local, because it's how YOU intend to work.
  const lanesLabel = lanes === 1 ? 'one lane' : `${lanes} lanes`;
  const perNight = cap === Infinity ? Infinity : cap * lanes;

  if (err) return <div className="mc14-empty">{err}</div>;
  if (!detail || !items) return <div className="mc14-empty">Loading the plan…</div>;

  const byId = new Map(items.map((it) => [it.id, it]));
  const bucketOf = (it: RoadmapItem) => flips.get(it.id) ?? it.bucket;
  const tierOf = (it: RoadmapItem): Tier => tierFlips.get(it.id) ?? it.tier;
  // The saved order: musts in board order, then shoulds — with the DESIRE TIER
  // leading (#227). Tier is the primary sort in the runner's pick too, and
  // unranked items rank last, so an unranked board is exactly must-then-should
  // as before. Stable sort, so board position survives inside a tier.
  const savedOrder = [
    ...items.filter((it) => schedulable(it, area) && it.bucket === 'must'),
    ...items.filter((it) => schedulable(it, area) && it.bucket === 'should'),
  ].sort((a, b) => tierRank(a.tier) - tierRank(b.tier)).map((it) => it.id);
  // The dirty overlay survives item churn: keep known ids, append newcomers.
  const cur = order
    ? [...order.filter((id) => savedOrder.includes(id)), ...savedOrder.filter((id) => !order.includes(id))]
    : savedOrder;
  const dirty = flips.size > 0 || tierFlips.size > 0
    || (order !== null && cur.join(',') !== savedOrder.join(','));

  // Everything open the nights would pass by. No slice (#260): a hidden
  // remainder reads as "that's all of it" when it isn't — long lists collapse
  // behind a count you can open instead.
  const heldAllItems = items
    .filter((it) => !it.done && !schedulable(it, area)
      && !(it.source === 'hook' && !it.reviewed && (it.bucket === 'must' || it.bucket === 'should')));
  const HELD_FOLD = 8;
  const held = heldAll ? heldAllItems : heldAllItems.slice(0, HELD_FOLD);

  // Projection: night k = today+k, `perNight` items a night (the session cap
  // times the lanes you plan to run). Milestone = the night the last must (and
  // the last item) lands. Deltas compare against the saved order while a
  // reorder is unsaved.
  const nightOf = (idx: number) => (perNight === Infinity ? 0 : Math.floor(idx / perNight));
  // Which parallel lane a row falls in, round-robin within its night — so lane
  // 1 always holds the highest-priority work.
  // (idx % Infinity === idx, so the unlimited-capacity case falls out for free:
  // one night, still split across the lanes.)
  const laneOf = (idx: number) => (lanes === 1 ? 0 : (idx % perNight) % lanes);
  const lastNight = (ids: number[], pred: (it: RoadmapItem) => boolean) => {
    let last = -1;
    ids.forEach((id, i) => { const it = byId.get(id); if (it && pred(it)) last = i; });
    return last < 0 ? null : nightOf(last);
  };
  const milestone = (name: string, pred: (it: RoadmapItem) => boolean) => {
    const now = lastNight(cur, pred);
    const was = lastNight(savedOrder, pred);
    return {
      name,
      date: now === null ? '—' : nightLabel(now),
      delta: dirty && was !== null && now !== null && now !== was
        ? `${now < was ? '▲' : '▼'} ${Math.abs(now - was)} night${Math.abs(now - was) === 1 ? '' : 's'} ${now < was ? 'earlier' : 'later'}`
        : '',
      earlier: now !== null && was !== null && now < was,
    };
  };
  const milestones = [
    milestone('musts land', (it) => bucketOf(it) === 'must'),
    milestone('the board clears', () => true),
  ];

  // ▲▼ move one slot; crossing the must/should boundary re-buckets the moved
  // item (it takes its swap partner's bucket) so the shown order stays the
  // truth about what runs first.
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= cur.length) return;
    const next = [...cur];
    [next[idx], next[j]] = [next[j], next[idx]];
    const moved = byId.get(cur[idx]);
    const partner = byId.get(cur[j]);
    if (moved && partner && bucketOf(moved) !== bucketOf(partner)) {
      const target = bucketOf(partner);
      setFlips((m) => {
        const n = new Map(m);
        if (moved.bucket === target) n.delete(moved.id); else n.set(moved.id, target);
        return n;
      });
    }
    // #227 — crossing a tier boundary re-tiers the moved item the same way,
    // because tier is what the queue sorts on first: without this the row would
    // snap back the moment the order was saved.
    if (moved && partner && tierOf(moved) !== tierOf(partner)) {
      const target = tierOf(partner);
      setTierFlips((m) => {
        const n = new Map(m);
        if (moved.tier === target) n.delete(moved.id); else n.set(moved.id, target);
        return n;
      });
    }
    setOrder(next);
  };

  const saveOrder = async () => {
    if (saving) return;
    setSaving(true); setRoomErr('');
    try {
      // Renumber per bucket in the shown order — the same PATCH the board's
      // drag-reorder uses; bucket rides along where a move re-bucketed.
      const updated = await Promise.all(cur.map((id, i) => {
        const flip = flips.get(id);
        const tierFlip = tierFlips.get(id);
        return patchRoadmapItem(pickSlug, id, {
          position: i,
          ...(flip ? { bucket: flip } : {}),
          ...(tierFlip !== undefined ? { tier: tierFlip } : {}),
        });
      }));
      setItems((prev) => prev && prev.map((it) => updated.find((u) => u.id === it.id) ?? it));
      setOrder(null); setFlips(new Map()); setTierFlips(new Map());
      detailCache.delete(pickSlug);
      setBanner({ note: `Order saved — ${milestones[0].date === '—' ? 'the schedule' : `musts land ${milestones[0].date}`}.` });
    } catch (e) {
      setRoomErr((e as Error)?.message || 'Could not save the order.');
    } finally {
      setSaving(false);
    }
  };

  // ---- the inbox ----
  const found = items.filter((it) => it.source === 'hook' && !it.reviewed && !it.done);
  const proposals: PlanProposal[] = [
    ...found.map((it) => ({ key: `f${it.id}`, kind: 'found' as const, it })),
    ...(cleanups ?? [])
      .filter((s) => s.title || s.bucket || s.area)
      .map((s, i) => ({ key: `c${s.id}·${i}`, kind: 'cleanup' as const, s })),
  ].filter((p) => !dropped.has(p.key));
  const pendingCount = proposals.filter((p) => !settled.has(p.key)).length;

  const apply = async (key: string, patch: Parameters<typeof patchRoadmapItem>[2], id: number, note: string, undoPatch?: Parameters<typeof patchRoadmapItem>[2]) => {
    setRoomErr('');
    try {
      const upd = await patchRoadmapItem(pickSlug, id, patch);
      setItems((prev) => prev && prev.map((it) => (it.id === id ? upd : it)));
      detailCache.delete(pickSlug);
      const undo = undoPatch ? () => {
        void patchRoadmapItem(pickSlug, id, undoPatch).then((back) => {
          setItems((prev) => prev && prev.map((it) => (it.id === id ? back : it)));
          setSettled((m) => { const n = new Map(m); n.delete(key); return n; });
          setBanner(null);
          detailCache.delete(pickSlug);
        }).catch((e) => setRoomErr((e as Error)?.message || 'Could not undo.'));
      } : undefined;
      setSettled((m) => new Map(m).set(key, { note, undo }));
      setBanner({ note, undo });
    } catch (e) {
      setRoomErr((e as Error)?.message || 'That didn’t land.');
    }
  };

  const acceptFound = (p: Extract<PlanProposal, { kind: 'found' }>) => {
    // The milestone header re-projects the moment items updates — that IS the
    // "watch the dates move" moment, so the banner just names the change.
    void apply(p.key, { reviewed: true }, p.it.id,
      `Accepted #${p.it.id} into the schedule as a ${p.it.bucket}.`,
      { reviewed: false });
  };
  const dismissFound = async (p: Extract<PlanProposal, { kind: 'found' }>) => {
    setRoomErr('');
    try {
      await deleteRoadmapItem(pickSlug, p.it.id);
      setItems((prev) => prev && prev.filter((it) => it.id !== p.it.id));
      detailCache.delete(pickSlug);
      setSettled((m) => new Map(m).set(p.key, { note: 'dismissed — tombstoned, the next push won’t re-create it' }));
    } catch (e) {
      setRoomErr((e as Error)?.message || 'Could not dismiss it.');
    }
  };
  const acceptCleanup = (p: Extract<PlanProposal, { kind: 'cleanup' }>) => {
    const old = byId.get(p.s.id);
    if (!old) return;
    const patch: Parameters<typeof patchRoadmapItem>[2] = {};
    const back: Parameters<typeof patchRoadmapItem>[2] = {};
    if (p.s.title) { patch.title = p.s.title; back.title = old.title; }
    if (p.s.bucket) { patch.bucket = p.s.bucket; back.bucket = old.bucket; }
    if (p.s.area !== undefined) { patch.area = p.s.area; back.area = old.area; }
    void apply(p.key, patch, p.s.id,
      `Applied to #${p.s.id}${p.s.bucket ? ` — moved to ${p.s.bucket}` : p.s.title ? ' — retitled' : ' — area set'}.`, back);
  };
  const askForProposals = async () => {
    if (cleanupBusy) return;
    setCleanupBusy(true); setRoomErr('');
    try {
      setCleanups(await cleanupRoadmap(pickSlug));
    } catch (e) {
      setRoomErr((e as Error)?.message || 'Gemini call failed — cleanup proposals unavailable.');
    } finally {
      setCleanupBusy(false);
    }
  };
  // #260 — ✧ AI assistance for the plan: hand the queue's undesigned items to
  // the planning agent in the order shown. Same push as the board's ✧ To
  // planning agent (#255) — one plan-kind session, ordered agenda, results
  // saved back as plan steps. Nothing is built and nothing is ticked.
  const unplannedIds = cur.filter((id) => (byId.get(id)?.plan.length ?? 0) === 0);
  // How much of the visible queue carries a desire tier (#227) — the header says
  // "tier leads" only when a tier is actually doing work in the order.
  const rankedHere = cur.filter((id) => byId.get(id)?.tier).length;
  const pushToPlanner = async () => {
    if (planBusy || unplannedIds.length === 0) return;
    setPlanBusy(true); setPlanNote(''); setRoomErr('');
    try {
      const job = await startAutopilot(pickSlug, { kind: 'plan', agenda: unplannedIds });
      setPlanNote(job.sessionKind === 'plan' && (job.agenda?.length ?? 0) === unplannedIds.length
        ? `queued — ${unplannedIds.length} design${unplannedIds.length === 1 ? '' : 's'}, in this order`
        : `an open ${job.kind} session (${job.status}) already holds the queue — nothing new queued`);
    } catch (e) {
      setPlanNote((e as Error)?.message || 'Could not queue the planning session.');
    } finally {
      setPlanBusy(false);
    }
  };

  const acceptAllSafe = () => {
    for (const p of proposals) {
      if (settled.has(p.key)) continue;
      if (p.kind === 'found') acceptFound(p); else acceptCleanup(p);
    }
  };

  // The models the nights run on (#153) — the same app-wide settings the Now
  // room's console writes, surfaced here because this is where the plan is
  // decided: the queue on the left, the hands and the mind that work it above.
  const executors = data.models?.executors ?? FALLBACK_EXECUTORS;
  const advisors = data.models?.advisors ?? FALLBACK_ADVISORS;
  const execLabel = modelLabel(executors, data.autopilot.executorModel);
  const advLabel = modelLabel(advisors, data.autopilot.advisorModel, 'Off');

  const kindChip = (p: PlanProposal) =>
    p.kind === 'found' ? 'FOUND'
    : p.s.bucket ? 'MOVE' : p.s.title ? 'RETITLE' : 'AREA';

  return (
    <div className="mc14-plan">
      <ProjectPicker data={data} pickSlug={pickSlug} onPick={onPick} />

      {/* header: projected milestones · capacity · save/revert (16a) */}
      <div className="mc16-head">
        {milestones.map((m) => (
          <div className="mc16-ms" key={m.name}>
            <span className="nm">{m.name}</span>
            <span className={`date ${m.date === '—' ? 'quiet' : ''}`}>{m.date}</span>
            {m.delta && <span className={`delta ${m.earlier ? 'up' : 'down'}`}>{m.delta}</span>}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <span className="capnote">
          {cap === Infinity ? '∞' : cap}/session × {lanesLabel} · nightly {data.autopilot.time}
        </span>
        <div className="mc16-caps" role="tablist" aria-label="Items per session">
          {[1, 2, 3, 5, 8, 0].map((n) => (
            <button key={n} role="tab" aria-selected={data.autopilot.maxItems === n}
              className={`mc16-cap ${data.autopilot.maxItems === n ? 'on' : ''}`}
              title={n === 0
                ? 'Unlimited — a session works the queue until its wall clock or token budget runs out'
                : `At most ${n} item${n === 1 ? '' : 's'} per session`}
              onClick={() => onSetMaxItems(n)}>{n === 0 ? '∞' : n}</button>
          ))}
        </div>
        <span className="capnote lanes">lanes</span>
        <div className="mc16-caps" role="tablist" aria-label="Parallel sessions you plan to run">
          {PLAN_LANE_CHOICES.map((n) => (
            <button key={n} role="tab" aria-selected={lanes === n}
              className={`mc16-cap ${lanes === n ? 'on' : ''}`}
              title={n === 1
                ? 'One session at a time — the overnight runner alone'
                : `Plan for ${n} sessions in parallel: lane 1 is the overnight runner, the rest are sessions you start`}
              onClick={() => { setLanes(n); setPlanLanes(n); }}>{n}</button>
          ))}
        </div>
        {dirty && <button className="mc16-revert" onClick={() => { setOrder(null); setFlips(new Map()); setTierFlips(new Map()); }}>revert</button>}
        <button className={`mc16-save ${dirty ? 'on' : ''}`} disabled={!dirty || saving} onClick={() => void saveOrder()}>
          {saving ? 'Saving…' : dirty ? 'Save order' : 'Order saved'}
        </button>
      </div>

      {/* the models the schedule runs on — executor hands, advisor mind (#153) */}
      <div className="mc16-models">
        <span className="cap-sm">MODELS</span>
        <div className="grp">
          <span className="l">Executor</span>
          <div className="seg" role="tablist" aria-label="Executor model — runs every session">
            {executors.map((m) => (
              <button key={m.model || '__default'} role="tab"
                aria-selected={data.autopilot.executorModel === m.model}
                className={`mc16-cap ${data.autopilot.executorModel === m.model ? 'on' : ''}`}
                title={m.model === '' ? "The claude CLI's own default model runs the session" : `Sessions run on ${m.label}`}
                onClick={() => onSetModel({ autopilotExecutorModel: m.model })}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grp">
          <span className="l">Advisor</span>
          <div className="seg" role="tablist" aria-label="Advisor model — the stronger model the session consults">
            {advisors.map((m) => (
              <button key={m.model || '__off'} role="tab"
                aria-selected={data.autopilot.advisorModel === m.model}
                className={`mc16-cap ${data.autopilot.advisorModel === m.model ? 'on' : ''}`}
                title={m.model === '' ? 'No advisor — single-model sessions' : `The executor consults ${m.label} for plans, unblocking and the pre-finish check`}
                onClick={() => onSetModel({ autopilotAdvisorModel: m.model })}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <span className="flow">
          {data.autopilot.advisorModel
            ? `${execLabel} builds · consults ${advLabel}`
            : `${execLabel} builds · single-model`}
        </span>
      </div>

      {roomErr && <div className="action-error">{roomErr}</div>}
      {banner && (
        <div className="mc16-banner">
          <span className="cap">JUST CHANGED</span>
          <span className="t">{banner.note}</span>
          {banner.undo && <button onClick={() => banner.undo!()}>undo</button>}
        </div>
      )}

      <div className="mc16-cols">
        <div className="mc16-sched">
          <div className="mc14-room-head">
            <span className="cap-sm">TONIGHT AND AFTER</span>
            <span className="hair" />
            <span className="meta">
              order is the plan — the list is the run queue{rankedHere > 0 ? ' · tier leads' : ''}
            </span>
          </div>
          {lanes > 1 && (
            <div className="mc16-lanenote">
              Split across {lanes} parallel sessions. <b>Lane 1 is the overnight runner</b> — the rest
              are sessions you start yourself (⎇ on the board claims the item's lane and opens one),
              and the lane claims keep them off each other's work. The dates below assume all {lanes} run.
            </div>
          )}
          {cur.map((id, idx) => {
            const it = byId.get(id)!;
            const night = nightOf(idx);
            const lane = laneOf(idx);
            const showBreak = idx === 0 || nightOf(idx - 1) !== night;
            return (
              <div key={id}>
                {showBreak && (
                  <div className="mc16-break">
                    <span className={night === 0 ? 'tonight' : ''}>{nightLabel(night).toUpperCase()}</span>
                    <span className="hair" />
                  </div>
                )}
                <div className={`mc16-row ${night === 0 ? 'tonight' : ''}`}>
                  <span className="grip">⠿</span>
                  <span className="n">{idx + 1}</span>
                  {lanes > 1 && (
                    <span className={`mc16-lane l${lane}`}
                      title={lane === 0
                        ? 'Lane 1 — the overnight runner works this one'
                        : `Lane ${lane + 1} — a session you start in parallel`}>
                      L{lane + 1}
                    </span>
                  )}
                  {tierOf(it) && (
                    <span className={`tier-chip t${tierOf(it)}`}
                      title={`Desire tier ${tierOf(it)} (#227) — the queue works S, then A, B, C, then unranked`}>
                      {tierOf(it)}
                    </span>
                  )}
                  <button className="body" onClick={() => go.detail(pickSlug, 'roadmap', String(id))}>
                    <span className="t">{it.title}</span>
                    <span className="p">{it.area || 'board'} · {bucketOf(it)}{it.plan.length ? ` · ☰ ${it.plan.filter((s) => s.done).length}/${it.plan.length}` : ''}</span>
                  </button>
                  {flips.has(id) && <span className="flag move">→ {flips.get(id)}</span>}
                  {tierFlips.has(id) && (
                    <span className="flag move">→ {tierFlips.get(id) || 'unranked'}</span>
                  )}
                  {it.refineNote && <span className="flag refine">↻ refine</span>}
                  {it.plan.length === 0 && <span className="flag noplan" title="No implementation plan yet — ✧ Plan the queue designs it">no plan</span>}
                  {it.risk === 'low' && <span className="flag low">auto-merge</span>}
                  <span className={`when ${night === 0 ? 'tonight' : ''}`}>{nightLabel(night)}</span>
                  <span className="arrows">
                    <button onClick={() => move(idx, -1)} aria-label="Move up">▲</button>
                    <button onClick={() => move(idx, 1)} aria-label="Move down">▼</button>
                  </span>
                </div>
              </div>
            );
          })}
          {cur.length === 0 && (
            <div className="mc14-empty">Nothing schedulable{area ? ` in ${area}` : ''} — the nights would pass this project by.</div>
          )}
          {/* ✧ AI assistance for the plan itself (#260/#255): hand the queue's
              unplanned items to the planning agent, in the order shown. */}
          {cur.length > 0 && (
            <div className="mc16-planpush">
              <button className="mc16-ask" disabled={planBusy || unplannedIds.length === 0}
                onClick={() => void pushToPlanner()}
                title={unplannedIds.length === 0
                  ? 'Every item in the queue already has an implementation plan'
                  : 'Queue a plan session that designs each unplanned item in the order shown and saves the steps back onto it'}>
                {planBusy ? '✧ Queuing…'
                  : unplannedIds.length === 0 ? '✧ Whole queue is planned'
                  : `✧ Plan the ${unplannedIds.length} unplanned item${unplannedIds.length === 1 ? '' : 's'}`}
              </button>
              {planNote && <span className="note">{planNote}</span>}
            </div>
          )}
          {held.length > 0 && (
            <div className="mc16-held">
              <span className="cap-sm">OUT OF THE SCHEDULE</span>
              {held.map((it) => (
                <button className="mc16-heldrow" key={it.id} onClick={() => go.detail(pickSlug, 'roadmap', String(it.id))}>
                  <span className="tag">#{it.id}</span>
                  <span className="t">{it.title}</span>
                  <span className="why">{heldWhy(it, area)}</span>
                </button>
              ))}
              {heldAllItems.length > HELD_FOLD && (
                <button className="mc16-heldmore" onClick={() => setHeldAll((v) => !v)}>
                  {heldAll
                    ? `show fewer — ${heldAllItems.length} held in total`
                    : `show all ${heldAllItems.length} held (${heldAllItems.length - HELD_FOLD} more)`}
                </button>
              )}
            </div>
          )}
        </div>

        {/* the inbox — what the nights found + what Claude proposes */}
        <div className="mc16-inbox">
          <div className="head">
            <span className="title">Inbox</span>
            {pendingCount > 0 && <span className="count">{pendingCount}</span>}
            <div style={{ flex: 1 }} />
            {pendingCount > 1 && <button className="all" onClick={acceptAllSafe}>accept all safe</button>}
          </div>
          <div className="scroll">
            <span className="intro">
              What the sessions found, and what Claude proposes. Nothing lands until you accept it;
              accepting moves the dates on the left.
            </span>
            {proposals.map((p) => {
              const done = settled.get(p.key);
              return (
                <div key={p.key} className={`mc16-prop ${done ? 'settled' : ''}`}>
                  <div className="toprow">
                    <span className={`kind ${p.kind === 'found' ? 'found' : 'clean'}`}>{kindChip(p)}</span>
                    <div style={{ flex: 1 }} />
                    <span className="impact">
                      {p.kind === 'found' ? (p.it.bucket === 'must' ? 'moves the must line' : `lands as ${p.it.bucket}`) : `#${p.s.id}`}
                    </span>
                  </div>
                  <span className="t">{p.kind === 'found' ? p.it.title : (p.s.title ? `“${p.s.title}”` : p.s.bucket ? `${p.s.currentTitle} → ${p.s.bucket}` : `${p.s.currentTitle} → ${p.s.area}`)}</span>
                  <span className="why">
                    {p.kind === 'found'
                      ? `A session filed this as a next step${p.it.note ? ` — ${p.it.note.slice(0, 120)}` : ''}. Accept to schedule it; dismiss tombstones it.`
                      : p.s.why}
                  </span>
                  <span className="src">{p.kind === 'found' ? 'auto-extracted from a push' : '✧ the board’s cleanup pass'}</span>
                  {!done ? (
                    <div className="acts">
                      <button className="ok" onClick={() => (p.kind === 'found' ? acceptFound(p) : acceptCleanup(p))}>
                        {p.kind === 'found' ? 'Accept into the schedule' : 'Apply'}
                      </button>
                      <button className="no" onClick={() => (p.kind === 'found' ? void dismissFound(p) : setDropped((s) => new Set(s).add(p.key)))}>
                        Dismiss
                      </button>
                    </div>
                  ) : (
                    <div className="done">
                      <span>{done.note}</span>
                      {done.undo && <button onClick={() => done.undo!()}>undo</button>}
                    </div>
                  )}
                </div>
              );
            })}
            {proposals.length === 0 && (
              <div className="mc16-prop quiet"><span className="why">Inbox clear — new pushes file their findings here.</span></div>
            )}
            <button className="mc16-ask" disabled={cleanupBusy} onClick={() => void askForProposals()}>
              {cleanupBusy ? '✧ Asking…' : cleanups ? '✧ Ask again' : '✧ Ask Claude for proposals'}
            </button>
            <div className="rule">
              Accepts are ordinary PATCHes — reviewed, bucket, title, area — so everything here is
              visible on the board too. The one no-undo move is Dismiss on a found item: it tombstones
              the fingerprint so the next push cannot re-file it.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Build — the implementation plan (12c inside 14a): every item carrying plan
// steps, as phase cards with the runner's real gates. Stack's gates are the
// honest ones: the human verdict (autopilot never ticks its own work) and the
// merge (⇥ stays yours). "Last night moved the plan" is the run ledger.
// ---------------------------------------------------------------------------

export function BuildRoom({ data, pickSlug, onPick, onGoNow }: {
  data: ControlData; pickSlug: string; onPick: (slug: string) => void; onGoNow: () => void;
}) {
  const { detail, err } = useProjectDetail(pickSlug);
  const [open, setOpen] = useState<Set<number> | null>(null);

  if (err) return <div className="mc14-empty">{err}</div>;
  if (!detail) return <div className="mc14-empty">Loading the build…</div>;

  const all = [...detail.roadmap.must, ...detail.roadmap.should, ...detail.roadmap.could, ...detail.roadmap.wont];
  const planned = all.filter((it) => it.plan.length > 0);
  const phase = (it: RoadmapItem) =>
    it.claimedBy && !it.done ? 'building'
    : !it.done ? 'queued'
    : !it.reviewTag ? 'verdict'
    : 'landed';
  const orderKey: Record<string, number> = { building: 0, queued: 1, verdict: 2, landed: 3 };
  const phases = [...planned].sort((a, b) => orderKey[phase(a)] - orderKey[phase(b)] || a.id - b.id);
  const openSet = open ?? new Set(phases.filter((it) => phase(it) !== 'landed').slice(0, 2).map((it) => it.id));
  const toggle = (id: number) => {
    const next = new Set(openSet);
    if (next.has(id)) next.delete(id); else next.add(id);
    setOpen(next);
  };

  const totalSteps = planned.reduce((n, it) => n + it.plan.length, 0);
  const doneSteps = planned.reduce((n, it) => n + it.plan.filter((s) => s.done).length, 0);
  const BADGE: Record<string, string> = {
    building: 'building', queued: 'queued', verdict: 'awaiting verdict', landed: 'landed',
  };
  const runsHere = (data.usage?.recentRuns ?? []).filter((r) => r.slug === pickSlug).slice(0, 4);
  const branchFor = (it: RoadmapItem) =>
    data.projects.find((p) => p.slug === pickSlug)?.branches.find((b) => b.itemId === String(it.id));

  return (
    <div className="mc14-build">
      <ProjectPicker data={data} pickSlug={pickSlug} onPick={onPick} />
      {planned.length === 0 ? (
        <div className="mc14-empty">
          No implementation plans yet — plan steps land on roadmap items from the board's ✎ Plan editor,
          or a plan night writes them overnight. Build nights then work them top-down.
        </div>
      ) : (
        <>
          <div className="mc14-room-head">
            <span className="title">{detail.project.name} · implementation plans</span>
            <span className="meta">{doneSteps}/{totalSteps} steps · {planned.length} planned item{planned.length === 1 ? '' : 's'}</span>
            <div className="mc14-buildbar">
              {Array.from({ length: 12 }, (_, i) => (
                <span key={i} className={totalSteps > 0 && i < Math.round((doneSteps / totalSteps) * 12) ? 'on' : ''} />
              ))}
            </div>
          </div>
          {phases.map((it) => {
            const ph = phase(it);
            const isOpen = openSet.has(it.id);
            const br = branchFor(it);
            return (
              <div key={it.id} className={`mc14-phase ${ph}`}>
                <button className="head" onClick={() => toggle(it.id)}>
                  <span className="n">#{it.id}</span>
                  <span className="nm">{it.title}</span>
                  <span className={`badge ${ph}`}>{BADGE[ph]}</span>
                  <div style={{ flex: 1 }} />
                  <span className="meta">{it.plan.filter((s) => s.done).length}/{it.plan.length} steps{it.claimedBy ? ` · ${it.claimedBy}` : ''}</span>
                  <span className="caret">{isOpen ? '▾' : '▸'}</span>
                </button>
                {isOpen && (
                  <div className="body">
                    {(it.refineNote || it.builtNote) && (
                      <div className="why">{it.refineNote ? `↻ Refinement: ${it.refineNote}` : it.builtNote}</div>
                    )}
                    {it.plan.map((s, i) => (
                      <div key={i} className={`step ${s.done ? 'done' : ''}`}>
                        <span className="mark">{s.done ? '✓' : '○'}</span>
                        <span className="t">{s.text}</span>
                      </div>
                    ))}
                    {ph === 'verdict' && (
                      <div className="gate">
                        <span className="g">GATE</span>
                        <span className="t">Human verdict — the autopilot never ticks its own work. Judge what landed in Reviews.</span>
                        <button className="act" onClick={() => go.detail(pickSlug, 'roadmap', String(it.id))}>→ Reviews</button>
                      </div>
                    )}
                    {ph === 'building' && br && (
                      <div className="gate">
                        <span className="g">GATE</span>
                        <span className="t">
                          The merge stays yours — {br.branch}
                          {typeof br.ahead === 'number' ? ` is ↑${br.ahead}${br.behind ? ` ↓${br.behind}` : ''}` : ''}
                          {br.mergeClean === true ? ' and merges clean.' : br.mergeClean === false ? ' and conflicts with main.' : '.'}
                        </span>
                        <button className="act" onClick={onGoNow}>⇥ merge strip</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {runsHere.length > 0 && (
            <div className="mc14-card wide">
              <span className="cap">LAST NIGHTS MOVED THE PLAN</span>
              {runsHere.map((r, i) => (
                <button key={i} className="mc14-diff" onClick={() => r.itemId && go.detail(pickSlug, 'roadmap', r.itemId)}>
                  <span className={`tag ${r.outcome}`}>{r.outcome.toUpperCase()}</span>
                  <span className="t">{r.itemId ? `#${r.itemId} ` : ''}{r.itemTitle || 'general session'} — {r.when}, {fmtTok(r.tokens)} tok</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
