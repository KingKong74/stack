// The Roadmap tab's TIMELINE view — area lanes, bars in weeks, a tray of
// unscheduled work, and a scope drawer for whatever bar you are looking at.
//
// Four things this file exists to hold:
//
//  1. THE GEOMETRY IS NOT HERE. Bar positions, lane row-stacking and label
//     placement all come from `lib/plan.ts`, pure and tested. A Gantt drawn
//     from arithmetic buried in a render function is a Gantt nobody can check,
//     and a wrong bar is a plan somebody acts on.
//  2. A DRAG IS OPTIMISTIC, AND SAYS SO WHEN IT FAILS. The bar follows the
//     pointer against local state and the PATCH goes out on release; if the
//     write is rejected the bar goes BACK and the error is shown. Leaving it
//     where the pointer dropped it would show a schedule the server does not
//     have — the one failure a planning tool must not have.
//  3. THE GHOST IS THE BASELINE, AND ONLY EXISTS IF THERE IS ONE. No baseline
//     means nothing was ever committed to, which is not "on plan" and is drawn
//     as nothing rather than as a bar sitting under itself.
//  4. POINTER EVENTS, NOT HTML5 DRAG, FOR THE BARS. Dragging a bar needs a
//     live position every few pixels; the HTML5 drag API only reports drops.
//     The TRAY uses HTML5 drag because dropping a chip onto a lane is exactly
//     what that API is for, and the two coexist without fighting.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BoardArea, RoadmapItem, SchedSpan } from '../types';
import {
  SCHED_WEEKS, CYCLE_WEEKS, layoutLane, scaleCols, scopeTotals, slipOf, weekAt,
  nowLeft, whatsNext, calendarMonths, weekDate, fmtDate,
  type Scale,
} from '../lib/plan';
import { labelsOf } from '../lib/labels';

const SCALES: { key: Scale; label: string }[] = [
  { key: 'week', label: 'Weeks' }, { key: 'month', label: 'Months' }, { key: 'quarter', label: 'Quarters' },
];

const BUCKET_LABEL: Record<string, string> = {
  must: 'Must', should: 'Should', could: 'Could', wont: "Won't",
};

// How many lanes the chart shows before it starts scrolling. Ten is about a
// screen; beyond that the tray and the drawer get pushed out of sight, and the
// tray is half of how work gets onto the chart at all.
const LANES_SHOWN = 10;

export interface TimelineProps {
  items: RoadmapItem[];
  areas: BoardArea[];
  /** The Monday weeks are counted from. null = no dates, so no calendar. */
  weekZero: string | null;
  areaFilter: string;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** Resolves when the PATCH lands; REJECTS so the bar can go back. */
  onSchedule: (item: RoadmapItem, sched: SchedSpan | null) => Promise<void>;
  onRebaseline: (item: RoadmapItem) => Promise<void>;
  onOpen: (item: RoadmapItem) => void;
  onToggleSkip: (item: RoadmapItem) => void;
  /** Ghosted positions from an accepted-but-not-applied arrange proposal. */
  proposed?: Map<number, SchedSpan>;
}

export function RoadmapTimeline({
  items, areas, weekZero, areaFilter, selectedId, onSelect,
  onSchedule, onRebaseline, onOpen, onToggleSkip, proposed,
}: TimelineProps) {
  const [scale, setScale] = useState<Scale>('month');
  const [mode, setMode] = useState<'chart' | 'calendar'>('chart');
  // The chart shows LANES_SHOWN lanes and scrolls for the rest. A project with
  // thirty areas would otherwise push the tray and the drawer off the screen,
  // and the tray is half of how work gets onto the chart in the first place.
  const [expanded, setExpanded] = useState(false);
  const [drawer, setDrawer] = useState(true);
  const [err, setErr] = useState('');
  // The bar being dragged, held locally so the lane re-renders at pointer rate
  // without a round trip. Cleared on release, whether the PATCH lands or not.
  const [live, setLive] = useState<{ id: number; sched: SchedSpan } | null>(null);
  const [trackW, setTrackW] = useState(0);
  const trackRef = useRef<HTMLDivElement | null>(null);

  // The track's pixel width drives inside-vs-outside label placement, so it has
  // to be measured rather than assumed — and re-measured when the drawer opens
  // or the window changes, both of which resize the lanes.
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => setTrackW(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [drawer]);

  useEffect(() => { if (!err) return; const t = setTimeout(() => setErr(''), 6000); return () => clearTimeout(t); }, [err]);

  const cols = scaleCols(scale, SCHED_WEEKS, weekZero);
  const shown = areas.filter((a) => areaFilter === '' || a.name === areaFilter);
  const visible = items.filter((i) => !i.archived);
  // A scheduled item whose area is not a lane would otherwise vanish silently.
  // It gets an "Unassigned" lane rather than being dropped from the view.
  const laneNames = shown.map((a) => a.name);
  const orphans = visible.filter((i) => i.sched && !laneNames.includes(i.area) && areaFilter === '');

  const withLive = (i: RoadmapItem): RoadmapItem =>
    (live && live.id === i.id ? { ...i, sched: live.sched } : i);

  const selected = selectedId === null ? null : items.find((i) => i.id === selectedId) || null;
  const children = selected ? items.filter((i) => i.parentId === selected.id && !i.archived) : [];
  const totals = scopeTotals(children);

  // --- dragging a bar ------------------------------------------------------

  // A bar's press is DOUBLE-DETECTED HERE rather than with onDoubleClick,
  // because startDrag calls preventDefault() on pointerdown — which is what
  // stops a drag selecting text, and also suppresses the synthesised click and
  // dblclick the browser would otherwise fire. An onDoubleClick on the bar
  // silently never runs. Two presses on the same bar inside this window, with
  // no drag between them, open the item.
  const DOUBLE_MS = 400;
  const lastPress = useRef<{ id: number; at: number } | null>(null);

  const startDrag = (it: RoadmapItem, mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    if (!it.sched || trackW <= 0) return;
    e.preventDefault();
    e.stopPropagation();
    const pxPerWeek = trackW / SCHED_WEEKS;
    const from = { ...it.sched };
    const x0 = e.clientX;
    let latest = from;
    let moved = false;

    const move = (ev: PointerEvent) => {
      const d = Math.round((ev.clientX - x0) / pxPerWeek);
      if (d !== 0) moved = true;
      latest = mode === 'move'
        ? { start: Math.max(0, Math.min(SCHED_WEEKS - from.len, from.start + d)), len: from.len }
        : { start: from.start, len: Math.max(1, Math.min(SCHED_WEEKS - from.start, from.len + d)) };
      setLive({ id: it.id, sched: latest });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) {
        setLive(null);
        const now = Date.now();
        const prev = lastPress.current;
        if (prev && prev.id === it.id && now - prev.at < DOUBLE_MS) {
          lastPress.current = null;
          onOpen(it);
        } else {
          lastPress.current = { id: it.id, at: now };
          onSelect(it.id);
        }
        return;
      }
      // Optimistic until the server says otherwise. On a rejection the bar
      // returns to where it was — a bar left at the pointer would be showing a
      // schedule nobody has.
      onSchedule(it, latest)
        .then(() => setLive(null))
        .catch((e2) => {
          setLive(null);
          setErr(e2?.message || `Could not move ${it.title} — it is back where it was.`);
        });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const dropOnLane = (area: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData('text/plain'));
    const it = items.find((x) => x.id === id);
    if (!it) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const len = it.sched?.len ?? Math.max(1, Math.round(it.estimate ?? 2));
    const start = weekAt(e.clientX - rect.left, rect.width, len);
    onSelect(it.id);
    onSchedule(it.area === area ? it : { ...it, area }, { start, len })
      .catch((e2) => setErr(e2?.message || `Could not schedule ${it.title}.`));
  };

  const tray = visible.filter(
    (i) => !i.sched && !i.done && (areaFilter === '' || i.area === areaFilter));

  return (
    <div className={`rt${drawer && selected ? ' with-drawer' : ''}`}>
      <div className="rt-main">
        <div className="rt-toolbar">
          <div className="seg-control sm" role="tablist" aria-label="Timeline shape">
            <button role="tab" aria-selected={mode === 'chart'}
              className={`seg-opt ${mode === 'chart' ? 'on' : ''}`} onClick={() => setMode('chart')}>Chart</button>
            <button role="tab" aria-selected={mode === 'calendar'}
              className={`seg-opt ${mode === 'calendar' ? 'on' : ''}`} onClick={() => setMode('calendar')}
              title={weekZero ? 'The same schedule, by month' : 'Needs a start date on this project'}>
              Calendar
            </button>
          </div>
          {mode === 'chart' && (
            <div className="seg-control sm" role="tablist" aria-label="Timeline scale">
              {SCALES.map((s) => (
                <button key={s.key} role="tab" aria-selected={scale === s.key}
                  className={`seg-opt ${scale === s.key ? 'on' : ''}`} onClick={() => setScale(s.key)}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
          <span className="rt-hint">
            {mode === 'chart'
              ? 'Drag a bar to reschedule · drag its right edge to change duration · select it to unschedule'
              : 'Each week lists what is running in it'}
          </span>
        </div>

        <WhatsNext items={visible} areas={areas} weekZero={weekZero} onSelect={onSelect} />

        {err && <div className="action-error">{err}</div>}

        {mode === 'calendar' ? (
          <Calendar items={visible} areas={areas} weekZero={weekZero}
            selectedId={selectedId} onSelect={onSelect} />
        ) : (
        <div className="rt-chart">
          <div className="rt-head">
            <span className="rt-lane-name lbl">Area</span>
            <div className="rt-track" ref={trackRef}>
              {cols.map((c, k) => (
                <div key={k} className={`rt-col${c.now ? ' now' : ''}`} style={{ flex: c.weeks }}>
                  <span>{c.label}</span>
                </div>
              ))}
              {/* The now-line runs the full height of the chart from here; the
                  lanes draw their own segment so it survives their scrolling. */}
              <span className="rt-nowline head" style={{ left: `${nowLeft()}%` }} aria-hidden="true" />
              <span className="rt-nowtag" style={{ left: `${nowLeft()}%` }}>now</span>
            </div>
          </div>

          <div className={`rt-lanes${expanded ? ' expanded' : ''}`}>
          {shown.length === 0 && (
            <div className="rt-empty">
              No areas yet. Tag an item with an area — or add one above — and it becomes a lane here.
            </div>
          )}

          {shown.map((a) => {
            const mine = visible.filter((i) => i.area === a.name).map(withLive);
            const lane = layoutLane(a.name, mine, trackW);
            return (
              <Lane key={a.name} name={a.name} dot={a.dot} lane={lane} cols={cols}
                selectedId={selectedId} proposed={proposed}
                onDrop={dropOnLane(a.name)} onSelect={onSelect} onOpen={onOpen}
                onDown={startDrag} onUnschedule={(it) => {
                  onSchedule(it, null).catch((e2) => setErr(e2?.message || 'Could not unschedule.'));
                }} />
            );
          })}

          {orphans.length > 0 && (
            <Lane name="Unassigned" dot="" lane={layoutLane('', orphans.map(withLive), trackW)}
              cols={cols} selectedId={selectedId} proposed={proposed}
              onDrop={dropOnLane('')} onSelect={onSelect} onOpen={onOpen} onDown={startDrag}
              onUnschedule={(it) => {
                onSchedule(it, null).catch((e2) => setErr(e2?.message || 'Could not unschedule.'));
              }} />
          )}

          {/* The horizon: committed work with no schedule and no estimate — it
              is on the roadmap but not yet in the plan, and saying so is more
              honest than parking it at week zero. */}
          <div className="rt-lane horizon">
            <div className="rt-lane-name">
              <span className="dot ghost" />
              <span className="nm">Horizon</span>
            </div>
            <div className="rt-lane-body">
              {visible.filter((i) => !i.sched && i.estimate === null && !i.done).slice(0, 6).map((i) => (
                <button key={i.id} className="rt-horizon-chip" onClick={() => onOpen(i)}
                  title="Give it a size and it can be scheduled">{i.title}</button>
              ))}
              {visible.filter((i) => !i.sched && i.estimate === null && !i.done).length === 0 && (
                <span className="rt-lane-empty">Everything unscheduled has been sized.</span>
              )}
            </div>
          </div>
          </div>

          {shown.length + (orphans.length ? 1 : 0) > LANES_SHOWN && (
            <button className="rt-expand" onClick={() => setExpanded(!expanded)}>
              {expanded
                ? `Collapse to ${LANES_SHOWN} lanes`
                : `Show all ${shown.length + (orphans.length ? 1 : 0)} lanes`}
            </button>
          )}
        </div>
        )}

        <div className="rt-tray">
          <div className="rt-tray-head">
            <span className="lbl">Unscheduled</span>
            <span className="rt-hint">
              {tray.length ? 'Drag onto a lane to place it' : 'Everything in this filter is on the timeline.'}
            </span>
          </div>
          <div className="rt-tray-items">
            {tray.map((i) => (
              <div key={i.id} className="rt-chip" draggable
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(i.id)); e.dataTransfer.effectAllowed = 'move'; }}
                onClick={() => onSelect(i.id)}
                title="Drag onto a lane to schedule it">
                <span className="dot" style={{ background: areas.find((a) => a.name === i.area)?.dot || 'var(--line-3)' }} />
                <span className="t">{i.title}</span>
                <span className="est">{i.estimate === null ? 'unsized' : `${i.estimate} wk`}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {selected && (
        drawer ? (
          <aside className="rt-drawer">
            <div className="rt-drawer-head">
              <button className="rt-drawer-toggle" onClick={() => setDrawer(false)} title="Collapse">›</button>
              <span className="nm">{selected.title}</span>
              {selected.sched && (
                <button className="rt-drawer-act" onClick={() => {
                  onSchedule(selected, null).catch((e2) => setErr(e2?.message || 'Could not unschedule.'));
                }}>Unschedule</button>
              )}
            </div>

            <SlipLine item={selected} onRebaseline={() => onRebaseline(selected).catch((e2) => setErr(e2?.message || 'Could not re-baseline.'))} />

            <div className="rt-scope-sum">
              <div className="rt-scope-bar">
                <span className={`fill${totals.fits ? '' : ' over'}`}
                  style={{ width: `${Math.min(100, (totals.committed / CYCLE_WEEKS) * 100)}%` }} />
              </div>
              <div className="rt-scope-line">
                {totals.fits
                  ? `${totals.committed} of ${CYCLE_WEEKS} weeks in the cycle`
                  : `${totals.over} weeks over the ${CYCLE_WEEKS}-week cycle`}
                {totals.deferred > 0 && ` · ${totals.deferred} deferred`}
                {totals.out > 0 && ` · ${totals.out} out of scope`}
              </div>
              {totals.unsized > 0 && (
                // The total is incomplete and must say so — an unsized line is
                // not a free one, and a bar that "fits" because half of it was
                // never sized is the lie this whole drawer exists to avoid.
                <div className="rt-scope-warn">
                  {totals.unsized} line{totals.unsized === 1 ? ' is' : 's are'} unsized, so this total is a floor, not the figure.
                </div>
              )}
            </div>

            <div className="rt-scope">
              {(['must', 'should', 'could', 'wont'] as const).map((b) => {
                const rows = children.filter((c) => c.bucket === b);
                if (!rows.length) return null;
                return (
                  <div className="rt-scope-group" key={b}>
                    <div className={`rt-scope-head ${b}`}>{BUCKET_LABEL[b]}</div>
                    {rows.map((c) => (
                      <div className={`rt-scope-row${c.skipped ? ' cut' : ''}`} key={c.id}>
                        <button className="mk" title={c.skipped ? 'Bring back into the cycle' : 'Defer this line'}
                          onClick={() => onToggleSkip(c)}>{c.skipped ? '↺' : '×'}</button>
                        <button className="t" onClick={() => onOpen(c)}>{c.title}</button>
                        {labelsOf(c.labels).map((l) => (
                          <span key={l.id} className={`rl rl-${l.tone}`}>{l.name}</span>
                        ))}
                        <span className="w">{c.estimate === null ? '—' : `${c.estimate}w`}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
              {children.length === 0 && (
                <div className="rt-lane-empty">
                  No scope lines yet. Items whose parent is this one appear here.
                </div>
              )}
            </div>
          </aside>
        ) : (
          <button className="rt-drawer-rail" onClick={() => setDrawer(true)} title="Show scope">
            <span className="chev">‹</span><span className="w">Scope</span>
          </button>
        )
      )}
    </div>
  );
}

// One area lane. Split out so a lane re-renders on its own during a drag.
function Lane({
  name, dot, lane, cols, selectedId, proposed, onDrop, onSelect, onOpen, onDown, onUnschedule,
}: {
  name: string; dot: string;
  lane: ReturnType<typeof layoutLane>;
  cols: ReturnType<typeof scaleCols>;
  selectedId: number | null;
  proposed?: Map<number, SchedSpan>;
  onDrop: (e: React.DragEvent) => void;
  onSelect: (id: number) => void;
  onOpen: (it: RoadmapItem) => void;
  onDown: (it: RoadmapItem, mode: 'move' | 'resize') => (e: React.PointerEvent) => void;
  onUnschedule: (it: RoadmapItem) => void;
}) {
  return (
    <div className="rt-lane" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="rt-lane-name">
        <span className={`dot${dot ? '' : ' ghost'}`} style={dot ? { background: dot } : undefined} />
        <span className="nm">{name}</span>
      </div>
      <div className="rt-lane-body" style={{ minHeight: 24 + lane.rows * 28 }}>
        <div className="rt-grid" aria-hidden="true">
          {cols.map((c, k) => <div key={k} className={`rt-col${c.now ? ' now' : ''}`} style={{ flex: c.weeks }} />)}
        </div>
        <span className="rt-nowline" style={{ left: `${nowLeft()}%` }} aria-hidden="true" />

        {lane.bars.map((bar) => {
          const it = bar.item;
          const state = it.done ? 'done' : it.claimedBy ? 'now' : 'plan';
          const sel = selectedId === it.id;
          const prop = proposed?.get(it.id);
          return (
            <div key={it.id}>
              {/* the baseline ghost — only when a baseline exists AND differs */}
              {bar.ghost && (
                <div className="rt-ghost" title="Where the plan put it"
                  style={{ top: 10 + bar.row * 28, left: `${bar.ghost.left}%`, width: `${bar.ghost.width}%` }} />
              )}
              {/* an arrange proposal's position, ghosted in the accent */}
              {prop && (
                <div className="rt-proposed" title="Proposed"
                  style={{
                    top: 10 + bar.row * 28,
                    left: `${(prop.start / SCHED_WEEKS) * 100}%`,
                    width: `${(prop.len / SCHED_WEEKS) * 100}%`,
                  }} />
              )}
              <div className={`rt-bar ${state}${sel ? ' sel' : ''}`}
                style={{ top: 10 + bar.row * 28, left: `${bar.left}%`, width: `${bar.width}%` }}
                onPointerDown={onDown(it, 'move')}
                // No onClick/onDoubleClick: preventDefault in onDown suppresses
                // both. Selecting and opening are decided in the pointer flow
                // above, which is the only place that can tell a press from a
                // drag anyway.
                title={`${it.title} — drag to reschedule, click for its scope, double-click to open`}>
                {bar.inside && <span className="t">{it.title}</span>}
              </div>
              <div className="rt-handle" title="Drag to change duration"
                style={{ top: 10 + bar.row * 28, left: `calc(${bar.left + bar.width}% - 5px)` }}
                onPointerDown={onDown(it, 'resize')} />
              {!bar.inside && (
                <button className={`rt-outlabel ${state}`}
                  style={bar.before
                    ? { top: 10 + bar.row * 28, right: `${100 - bar.left}%` }
                    : { top: 10 + bar.row * 28, left: `${bar.left + bar.width}%` }}
                  onClick={() => onSelect(it.id)}
                  onDoubleClick={() => onOpen(it)}>{it.title}</button>
              )}
              {sel && (
                <button className="rt-x" title="Send back to Unscheduled"
                  style={bar.before
                    ? { top: 10 + bar.row * 28, left: `calc(${bar.left + bar.width}% + 4px)` }
                    : { top: 10 + bar.row * 28, right: `calc(${100 - bar.left}% + 4px)` }}
                  onClick={(e) => { e.stopPropagation(); onUnschedule(it); }}>×</button>
              )}
            </div>
          );
        })}

        {lane.bars.length === 0 && <span className="rt-lane-empty">Drop something here to schedule it</span>}
      </div>
    </div>
  );
}

// The one line that says whether this bar is where it was promised to be.
// "Not measured" is its own answer and is deliberately not drawn as "on plan".
function SlipLine({ item, onRebaseline }: { item: RoadmapItem; onRebaseline: () => void }) {
  const s = slipOf(item);
  if (!item.sched) return <div className="rt-slip none">Unscheduled — in the tray.</div>;
  if (!s.measured) {
    return <div className="rt-slip none">No baseline: nothing was committed to, so there is no slip to report.</div>;
  }
  if (s.weeks === 0 && s.longer === 0) return <div className="rt-slip ok">On the plan it started with.</div>;
  const bits: string[] = [];
  if (s.weeks) bits.push(`${s.weeks > 0 ? 'starts' : 'pulled'} ${Math.abs(s.weeks)} wk${Math.abs(s.weeks) === 1 ? '' : 's'} ${s.weeks > 0 ? 'later' : 'earlier'}`);
  if (s.longer) bits.push(`${Math.abs(s.longer)} wk${Math.abs(s.longer) === 1 ? '' : 's'} ${s.longer > 0 ? 'longer' : 'shorter'}`);
  return (
    <div className="rt-slip off">
      Off plan — {bits.join(', ')}.
      <button className="rt-drawer-act" onClick={onRebaseline} title="Accept this as the plan from now on">Re-baseline</button>
    </div>
  );
}

// --- what's next -----------------------------------------------------------

// The bars at and after the now-line, soonest first. The chart shows the whole
// window; this says which end of it to look at, which is the question a Gantt
// is worst at answering by itself.
function WhatsNext({ items, areas, weekZero, onSelect }: {
  items: RoadmapItem[]; areas: BoardArea[]; weekZero: string | null;
  onSelect: (id: number) => void;
}) {
  const next = whatsNext(items);
  if (!next.length) {
    return (
      <div className="rt-next empty">
        <span className="lbl">What&rsquo;s next</span>
        <span className="rt-hint">
          Nothing is scheduled from here on. Drag something out of the tray, or press Arrange.
        </span>
      </div>
    );
  }
  return (
    <div className="rt-next">
      <span className="lbl">What&rsquo;s next</span>
      {next.map(({ item, inWeeks, running }) => {
        const d = weekDate(item.sched!.start, weekZero);
        return (
          <button key={item.id} className={`rt-next-chip${running ? ' running' : ''}`}
            onClick={() => onSelect(item.id)}
            title={`${item.area || 'untagged'} · ${item.sched!.len} wk${item.sched!.len === 1 ? '' : 's'}`}>
            <span className="dot" style={{ background: areas.find((a) => a.name === item.area)?.dot || 'var(--line-3)' }} />
            <span className="t">{item.title}</span>
            <span className="when">
              {running ? 'running' : inWeeks === 1 ? 'next week' : `in ${inWeeks} wks`}
              {d && ` · ${fmtDate(d)}`}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// --- the calendar ----------------------------------------------------------

// The same schedule read as months of weeks. It needs real dates, and without a
// week zero it says so rather than drawing an invented year — a calendar whose
// dates are made up is worse than no calendar.
function Calendar({ items, areas, weekZero, selectedId, onSelect }: {
  items: RoadmapItem[]; areas: BoardArea[]; weekZero: string | null;
  selectedId: number | null; onSelect: (id: number) => void;
}) {
  const months = calendarMonths(items, weekZero);
  if (!months.length) {
    return (
      <div className="rt-chart">
        <div className="rt-empty">
          This project has no start date, so a week has no date to sit on and the calendar cannot be
          drawn. The chart above works without one. Set a start date on the project to turn weeks
          into dates.
        </div>
      </div>
    );
  }
  return (
    <div className="rt-cal">
      {months.map((m) => (
        <div className="rt-cal-month" key={m.label}>
          <div className="rt-cal-head">{m.label}</div>
          {m.weeks.map((w) => (
            <div className={`rt-cal-week${w.now ? ' now' : ''}`} key={w.week}>
              <div className="rt-cal-dates">
                <span className="d">{fmtDate(w.from)} – {fmtDate(w.to)}</span>
                {w.now && <span className="nowtag">now</span>}
              </div>
              <div className="rt-cal-items">
                {w.items.map((i) => (
                  <button key={i.id} className={`rt-cal-chip${selectedId === i.id ? ' sel' : ''}${i.done ? ' done' : ''}`}
                    onClick={() => onSelect(i.id)} title={i.area || 'untagged'}>
                    <span className="dot" style={{ background: areas.find((a) => a.name === i.area)?.dot || 'var(--line-3)' }} />
                    {i.title}
                  </button>
                ))}
                {w.items.length === 0 && <span className="rt-cal-quiet">—</span>}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
