import { useEffect, useMemo, useState } from 'react';
import {
  getProjectDetail, type ProjectDetailData, type ControlData, type AutopilotSchedule,
} from '../store';
import { go } from '../lib/route';
import type { RoadmapItem } from '../types';

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
                    <span className="t">the armed nightly — up to {data.autopilot.maxItems} item{data.autopilot.maxItems === 1 ? '' : 's'}, must before should</span>
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
// Plan — the hierarchy (12b inside 14a): north star → areas → items, beside
// tonight's actual pick order and the honest reasons the rest won't be picked.
// Mirrors the runner's eligibility rule; computed client-side, no API.
// ---------------------------------------------------------------------------

const pickable = (it: RoadmapItem, area: string) =>
  !it.done && !it.skipped && !it.claimedBy
  && (it.source === 'manual' || it.reviewed)
  && (!area || (it.area || '') === area);

const whyNot = (it: RoadmapItem, area: string): string => {
  if (it.claimedBy) return `claimed by ${it.claimedBy}`;
  if (it.skipped) return 'parked — skipped stays off the autopilot’s plate';
  if (it.source === 'hook' && !it.reviewed) return 'auto-extracted and not yet approved in the review inbox';
  if (area && (it.area || '') !== area) return `outside the target area (${area})`;
  return 'behind the items above in board order';
};

export function PlanRoom({ data, pickSlug, onPick }: {
  data: ControlData; pickSlug: string; onPick: (slug: string) => void;
}) {
  const { detail, err } = useProjectDetail(pickSlug);
  const [pathOnly, setPathOnly] = useState(false);
  const proj = data.projects.find((p) => p.slug === pickSlug);
  const area = proj?.autopilotArea || '';

  if (err) return <div className="mc14-empty">{err}</div>;
  if (!detail) return <div className="mc14-empty">Loading the plan…</div>;

  const { roadmap, northStar } = detail;
  const open = [...roadmap.must, ...roadmap.should, ...roadmap.could].filter((it) => !it.done);
  const done = [...roadmap.must, ...roadmap.should, ...roadmap.could].filter((it) => it.done);
  const queue = [...roadmap.must.filter((it) => pickable(it, area)), ...roadmap.should.filter((it) => pickable(it, area))]
    .slice(0, Math.max(data.autopilot.maxItems, 3));
  const queueIds = new Set(queue.map((it) => it.id));
  const excluded = [...roadmap.must, ...roadmap.should]
    .filter((it) => !it.done && !queueIds.has(it.id) && !pickable(it, area))
    .slice(0, 6);

  const shown = pathOnly ? open.filter((it) => queueIds.has(it.id)) : [...open, ...done];
  const areas = [...new Set(shown.map((it) => it.area || ''))]
    .sort((a, b) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0) || a.localeCompare(b));

  const chip = (it: RoadmapItem) => {
    if (it.done) return { cls: 'done', t: '✓ done' };
    if (it.claimedBy) return { cls: 'lane', t: `⚑ ${it.claimedBy}` };
    if (it.refineNote) return { cls: 'refine', t: '↻ refine' };
    if (it.skipped) return { cls: 'parked', t: '⏭ parked' };
    if (it.plan.length) return { cls: 'plan', t: `☰ ${it.plan.filter((s) => s.done).length}/${it.plan.length}` };
    return null;
  };

  return (
    <div className="mc14-plan">
      <ProjectPicker data={data} pickSlug={pickSlug} onPick={onPick} />
      <div className="mc14-plan-cols">
        <div className="mc14-tree">
          <div className="mc14-room-head">
            <span className="title">{detail.project.name} · plan tree</span>
            <span className="meta">
              {roadmap.must.filter((i) => !i.done).length} must · {roadmap.should.filter((i) => !i.done).length} should · {done.length} done
            </span>
            <div style={{ flex: 1 }} />
            <button className={`mc14-only ${pathOnly ? 'on' : ''}`} onClick={() => setPathOnly((v) => !v)}>
              {pathOnly ? "tonight's path" : 'everything'}
            </button>
          </div>
          <div className="mc14-star">
            <span className="cap">NORTH STAR</span>
            {northStar
              ? <div className="txt">{northStar}</div>
              : <button className="txt quiet" onClick={() => go.detail(pickSlug, 'futures')}>No north star yet — set one on the Polaris tab and every verdict gets a bearing.</button>}
          </div>
          {areas.map((a) => {
            const items = shown.filter((it) => (it.area || '') === a);
            if (!items.length) return null;
            return (
              <div key={a || '__none'} className="mc14-branch">
                <div className="mc14-node epic">
                  <span className="nm">{a || 'no area'}</span>
                  <span className="meta">{items.filter((i) => !i.done).length} open</span>
                </div>
                {items.map((it) => {
                  const c = chip(it);
                  return (
                    <button key={it.id} className={`mc14-node item ${it.done ? 'done' : ''} ${queueIds.has(it.id) ? 'picked' : ''}`}
                      onClick={() => go.detail(pickSlug, 'roadmap', String(it.id))}>
                      <span className="nm">#{it.id} {it.title}</span>
                      {c && <span className={`chip ${c.cls}`}>{c.t}</span>}
                      <span className="meta">{it.bucket}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {shown.length === 0 && <div className="mc14-empty">Nothing on the board{pathOnly ? "'s path tonight" : ''}.</div>}
        </div>

        <div className="mc14-plan-rail">
          <div className="mc14-card">
            <span className="cap">TONIGHT'S PICK ORDER</span>
            <span className="rule">
              Open must items in board order, then shoulds — skipping claimed, parked and unapproved hook items{area ? `, inside ${area}` : ''}. The board IS the priority list.
            </span>
            {queue.map((it, i) => (
              <button key={it.id} className={`mc14-q ${i === 0 ? 'first' : ''}`}
                onClick={() => go.detail(pickSlug, 'roadmap', String(it.id))}>
                <span className="n">{i + 1}</span>
                <span className="body">
                  <span className="t">#{it.id} {it.title}</span>
                  <span className="p">{it.area || 'board'} · {it.bucket}{it.plan.length ? ` · ☰ ${it.plan.length} steps` : ''}</span>
                </span>
              </button>
            ))}
            {queue.length === 0 && <span className="rule quiet">Nothing eligible{area ? ` in ${area}` : ''} — the night would pass this project by.</span>}
          </div>
          {excluded.length > 0 && (
            <div className="mc14-card">
              <span className="cap">WHY NOT THE REST</span>
              {excluded.map((it) => (
                <div key={it.id} className="mc14-whynot">
                  <span className="x">✕</span>
                  <span className="t"><b>#{it.id}</b> {whyNot(it, area)}</span>
                </div>
              ))}
            </div>
          )}
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
