// The Roadmap tab's TIMELINE view — area lanes, bars in continuous time, a tray
// of unscheduled work, and a drawer for whatever bar you are looking at.
//
// Six things this file exists to hold:
//
//  1. THE GEOMETRY IS NOT HERE. Bar positions, lane row-stacking, the ruler and
//     both calendar shapes all come from `lib/plan.ts`, pure and tested. A Gantt
//     drawn from arithmetic buried in a render function is a Gantt nobody can
//     check, and a wrong bar is a plan somebody acts on.
//  2. TIME IS CONTINUOUS AND THE ZOOM IS FREE (#401). The schedule is MINUTES
//     from week zero and the viewport is a window of minutes over it, so the
//     chart runs from a fifteen-minute snap up to a quarter a screen without a
//     mode anywhere. The GRAIN — what the ruler draws and how far one nudge
//     moves — is derived from pixels-per-day off the measured track, never
//     picked: "Hour" has to MEAN hours are legible, or it is a label over a
//     four-pixel column.
//     Two things a viewport must never do quietly: a now-line outside it is not
//     drawn at all (pinning it to an edge would put today somewhere it is not,
//     so an off-screen now becomes a button that takes you back to it), and a
//     bar outside it is COUNTED at the edge it went off, because zooming is the
//     one gesture that can empty a lane that is full of work.
//  3. THE VIEWPORT PANS ANYWHERE; A BAR STAYS IN THE PLAN. Dragging the grid
//     moves the window with no clamp, because a pan that stops dead with no
//     explanation is worse than one that shows empty time. Every EDIT, though —
//     drag, resize, drop, nudge — goes through `clampSpanToDomain`, so a window
//     that has wandered off the horizon still cannot schedule anything outside
//     it. The server clamps to the same domain.
//  4. A DRAG IS OPTIMISTIC, AND SAYS SO WHEN IT FAILS. The bar follows the
//     pointer against local state and the PATCH goes out on release; if the
//     write is rejected the bar goes BACK and the error is shown. Leaving it
//     where the pointer dropped it would show a schedule the server does not
//     have — the one failure a planning tool must not have.
//  5. THE GHOST IS THE BASELINE, AND ONLY EXISTS IF THERE IS ONE. No baseline
//     means nothing was ever committed to, which is not "on plan" and is drawn
//     as nothing rather than as a bar sitting under itself.
//  6. POINTER EVENTS, NOT HTML5 DRAG, FOR THE BARS AND THE GRID. Both need a
//     live position every few pixels; the HTML5 drag API only reports drops. A
//     press on a BAR moves that bar and a press on the LANE moves the window —
//     the bar stops the event, so the two gestures never race. The TRAY uses
//     HTML5 drag because dropping a chip onto a lane is exactly what that API is
//     for, and the two coexist without fighting.
//
// THE WHEEL LISTENER IS ATTACHED BY HAND, not through onWheel. React registers
// wheel at the root as PASSIVE, so `preventDefault` inside an onWheel handler is
// a no-op and the page scrolls away underneath the zoom. It has to be a direct
// `addEventListener(..., { passive: false })` on the element.
//
// AN AREA'S COLOUR IS THE CHART'S ONLY KEY, so two things follow. The bars are
// TINTED WITH IT (mixed against the surface in CSS, so the tint reads in both
// themes) and the state — planned, running, done — is carried by how much tint
// and how solid the border, never by swapping in another hue: a bar that turned
// green when it finished would be indistinguishable from a green area. And the
// lane's dot IS the picker, because the place you notice two areas look alike is
// the place you should be able to fix it, not two screens away in Edit areas.
//
// A LANE WITH NO ITEMS IS NOT DRAWN. An empty lane is a row of grid and a "drop
// something here" that costs a real lane its space, and a project accumulates
// areas it has finished with. The chips above still list them (and the "+N
// empty" reveal names them), which is where an area with nothing in it belongs.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BoardArea, BoardLabel, RoadmapItem, SchedSpan } from '../types';
import {
  CAL_HOUR_FROM, CAL_HOUR_TO, CYCLE_WEEKS, DUR_OPTIONS, MIN_PER_DAY, MIN_PER_HOUR,
  MIN_SCHED_LEN, PX_DAY_MAX, PX_DAY_MIN, UNALLOCATED, ZOOM_STOPS,
  areaMatches, calendarDays, calendarMonths, centreOn, clampSpan, clampSpanToDomain,
  dateAt, defaultLen, dowShort, fitAll as fitAllView, fmtDate, fmtDur, fmtTime,
  fmtWhen, grainFor, horizonOf, layoutLane, leftPct, nowMin, panBy, pxPerDay, scopeTotals,
  slipOf, snapFor, snapTo, spanForPx, spanLabel, spanPct, ticksFor, timeAt, viewAround,
  weekNo, whatsNext, windowLabel, zoomAt,
  type Grain, type Viewport,
} from '../lib/plan';
import { useAutoRefresh } from '../lib/autoRefresh';
import { labelsOf } from '../lib/labels';

const BUCKET_LABEL: Record<string, string> = {
  must: 'Must', should: 'Should', could: 'Could', wont: "Won't",
};

// How many lanes the chart shows before it starts scrolling. Ten is about a
// screen; beyond that the tray and the drawer get pushed out of sight, and the
// tray is half of how work gets onto the chart at all.
const LANES_SHOWN = 10;

/** The lane row's height, and the height of one stacked bar row inside it. */
const LANE_H = 46;
const BAR_ROW_H = 28;
/** One hour of the calendar's time grid, in pixels. */
const CAL_HOUR_H = 42;

/** The width the geometry falls back to before the track has been measured. */
const ASSUMED_TRACK = 900;

export interface TimelineProps {
  items: RoadmapItem[];
  areas: BoardArea[];
  /** #382 — the project's labels; the scope drawer draws its chips from these. */
  labels: BoardLabel[];
  /** The Monday minutes are counted from. null = no dates, so no calendar. */
  weekZero: string | null;
  areaFilter: string;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** The colours an area may wear — the server's closed set, not a free picker. */
  palette: string[];
  /** Set a lane's colour. The parent writes it and hands back fresh areas. */
  onRecolour: (area: string, dot: string) => void;
  /** Resolves when the PATCH lands; REJECTS so the bar can go back. */
  onSchedule: (item: RoadmapItem, sched: SchedSpan | null) => Promise<void>;
  onRebaseline: (item: RoadmapItem) => Promise<void>;
  onOpen: (item: RoadmapItem) => void;
  onToggleSkip: (item: RoadmapItem) => void;
  /** Ghosted positions from an accepted-but-not-applied arrange proposal. */
  proposed?: Map<number, SchedSpan>;
}

export function RoadmapTimeline({
  items, areas, labels, weekZero, areaFilter, selectedId, onSelect,
  palette, onRecolour, onSchedule, onRebaseline, onOpen, onToggleSkip, proposed,
}: TimelineProps) {
  const [mode, setMode] = useState<'chart' | 'calendar'>('chart');
  // The slice of the schedule on screen, in minutes. ONE piece of state for
  // where and how far in: a zoom that did not also say where you were looking
  // would jump you back to now every time you changed it.
  const [view, setView] = useState<Viewport>(() => viewAround(nowMin(weekZero)));
  const [trackW, setTrackW] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [drawer, setDrawer] = useState(true);
  const [err, setErr] = useState('');
  // The bar being dragged, held locally so the lane re-renders at pointer rate
  // without a round trip. Cleared on release, whether the PATCH lands or not.
  const [live, setLive] = useState<{ id: number; sched: SchedSpan } | null>(null);
  // Which lane's colour popover is open (one at a time), by area name.
  const [colourFor, setColourFor] = useState<string | null>(null);
  // THE TWO SIDE PANELS START FOLDED. What's next and the unscheduled tray each
  // answer a question you ask sometimes; the CHART answers the one you opened
  // the tab for, and both open pushed it below the fold. Each keeps its heading
  // and its COUNT while folded, so nothing goes missing — a fold that hid the
  // fact there are nine unscheduled items would be the tray's whole point,
  // hidden.
  const [openNext, setOpenNext] = useState(false);
  const [openTray, setOpenTray] = useState(false);
  const [openOrphans, setOpenOrphans] = useState(false);
  // Bumped so the now-line follows the clock. The cadence is the device's own
  // Auto refresh setting (#312) rather than a bare interval of this component's
  // own choosing, so a hidden tab does not tick and the owner can turn it off.
  // With it off the line still moves on any interaction, which is every gesture
  // that could make its position matter.
  const [, setTick] = useState(0);
  useAutoRefresh(() => setTick((n) => n + 1));

  const trackRef = useRef<HTMLDivElement | null>(null);
  const calRef = useRef<HTMLDivElement | null>(null);

  // The track's pixel width drives the GRAIN, the label placement and every
  // gesture's minutes-per-pixel, so it has to be measured rather than assumed —
  // and re-measured when the drawer opens or the window changes, both of which
  // resize the lanes.
  useLayoutEffect(() => {
    const el = mode === 'chart' ? trackRef.current : calRef.current;
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
  }, [drawer, mode]);

  useEffect(() => { if (!err) return; const t = setTimeout(() => setErr(''), 6000); return () => clearTimeout(t); }, [err]);

  const px = trackW || ASSUMED_TRACK;
  const grain = grainFor(view, px);
  const now = nowMin(weekZero);
  const snap = snapFor(grain);

  // --- moving through time -------------------------------------------------

  const zoomBy = useCallback((factor: number, anchor = 0.5) => {
    setView((v) => zoomAt(v, px, factor, anchor));
  }, [px]);

  const goTo = useCallback((at: number) => setView((v) => centreOn(v, at)), []);

  const setStop = useCallback((stopPx: number) => {
    setView((v) => {
      const at = v.start + v.span / 2;
      const span = clampSpan(spanForPx(stopPx, px), px);
      return { start: at - span / 2, span };
    });
  }, [px]);

  const fitEverything = () => {
    const spans = items.filter((i) => !i.archived && i.sched).map((i) => i.sched!);
    setView(fitAllView(spans, px, now));
  };

  // How many minutes one pixel is worth for a PAN. The chart's answer is the
  // viewport's own scale; the calendar's is its column width, because there a
  // drag of one column has to move exactly one day whatever the zoom says.
  const calCols = mode === 'calendar' && (grain === 'hour' || grain === 'day')
    ? (grain === 'hour' ? 1 : 7) : 7;
  const panScale = mode === 'chart'
    ? view.span / px
    : MIN_PER_DAY / Math.max(1, (px - (grain === 'hour' || grain === 'day' ? 58 : 0)) / calCols);

  const startPan = (e: React.PointerEvent) => {
    // Not a pan on a control that lives inside the grid — the bars, the
    // off-window markers and the now handle all stop the event themselves, and
    // this catches anything else that is a button.
    if ((e.target as HTMLElement).closest('button')) return;
    const x0 = e.clientX;
    const from = view.start;
    setDragging(true);
    const move = (ev: PointerEvent) => setView((v) => ({ ...v, start: from - (ev.clientX - x0) * panScale }));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragging(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // THE WHEEL IS NOT AN onWheel. React's wheel listener is passive, so the
  // preventDefault below would be ignored and the page would scroll out from
  // under the zoom. A horizontal wheel (a trackpad swipe) pans instead, because
  // that gesture already means "move sideways" everywhere else.
  useEffect(() => {
    const el = mode === 'chart' ? trackRef.current : calRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setView((v) => panBy(v, e.deltaX * panScale));
        return;
      }
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchor = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
      // ⌘/⌃ zooms harder — the same "this gesture means scale" convention every
      // map has, and the only way to cross hours-to-quarters in one movement.
      zoomBy(Math.exp(-e.deltaY * (e.ctrlKey || e.metaKey ? 0.006 : 0.0022)), anchor);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [mode, panScale, zoomBy]);

  // --- what is on the chart ------------------------------------------------

  const visible = items.filter((i) => !i.archived);
  // An area with nothing in it is NOT a lane. The one exception is the area you
  // are filtered by: hiding that would leave the chart empty with no lane naming
  // what it is filtered to, which reads as "this area has no work" when what it
  // means is "you filtered to an area that has none".
  const populated = new Set(visible.map((i) => i.area));
  const shown = areas.filter((a) => (areaFilter === '' ? populated.has(a.name) : a.name === areaFilter));
  // A scheduled item whose area is not a lane would otherwise vanish silently.
  // It gets an "Unallocated" lane rather than being dropped from the view — and
  // that lane is what the Unallocated chip filters the chart down to.
  const laneNames = shown.map((a) => a.name);
  const orphans = visible.filter(
    (i) => i.sched && !laneNames.includes(i.area) && areaMatches(i.area, areaFilter));

  const withLive = (i: RoadmapItem): RoadmapItem =>
    (live && live.id === i.id ? { ...i, sched: live.sched } : i);
  const liveItems = useMemo(
    () => visible.map(withLive),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, live]);

  const selected = selectedId === null ? null : items.find((i) => i.id === selectedId) || null;
  const selectedLive = selected ? withLive(selected) : null;
  const children = selected ? items.filter((i) => i.parentId === selected.id && !i.archived) : [];
  const totals = scopeTotals(children);

  const { ticks, bands } = ticksFor(view, grain, weekZero, px);
  const nowPct = leftPct(now, view);
  const nowOn = nowPct >= 0 && nowPct <= 100;

  const scheduled = visible.filter((i) => i.sched).length;

  // --- editing a bar -------------------------------------------------------

  const patch = (it: RoadmapItem, sched: SchedSpan) => {
    onSchedule(it, sched)
      .catch((e) => setErr((e as Error)?.message || `Could not move ${it.title} — it is back where it was.`));
  };

  // A bar's press is DOUBLE-DETECTED HERE rather than with onDoubleClick,
  // because startBar calls preventDefault() on pointerdown — which is what stops
  // a drag selecting text, and also suppresses the synthesised click and
  // dblclick the browser would otherwise fire. An onDoubleClick on the bar
  // silently never runs. Two presses on the same bar inside this window, with no
  // drag between them, open the item.
  const DOUBLE_MS = 400;
  const lastPress = useRef<{ id: number; at: number } | null>(null);

  const startBar = (it: RoadmapItem, kind: 'move' | 'resize') => (e: React.PointerEvent) => {
    if (!it.sched) return;
    e.preventDefault();
    e.stopPropagation();
    const perPx = view.span / px;
    const from = { ...it.sched };
    const x0 = e.clientX;
    let latest = from;
    let moved = false;

    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - x0) * perPx;
      if (Math.abs(ev.clientX - x0) > 2) moved = true;
      latest = clampSpanToDomain(kind === 'move'
        ? { start: snapTo(from.start + d, snap), len: from.len }
        : { start: from.start, len: Math.max(MIN_SCHED_LEN, snapTo(from.len + d, snap)) });
      setLive({ id: it.id, sched: latest });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) {
        setLive(null);
        const at = Date.now();
        const prev = lastPress.current;
        if (prev && prev.id === it.id && at - prev.at < DOUBLE_MS) {
          lastPress.current = null;
          onOpen(it);
        } else {
          lastPress.current = { id: it.id, at };
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
          setErr((e2 as Error)?.message || `Could not move ${it.title} — it is back where it was.`);
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
    const len = it.sched?.len ?? defaultLen(it, grain);
    const start = timeAt(e.clientX - rect.left, rect.width, len, view, snap);
    onSelect(it.id);
    onSchedule(it.area === area ? it : { ...it, area }, { start, len })
      .catch((e2) => setErr((e2 as Error)?.message || `Could not schedule ${it.title}.`));
  };

  /**
   * Place a tray item without a drag: after the last bar in its own lane, or at
   * now if the lane is empty, and never on top of something already there. The
   * same rule the Scope view's Schedule button uses.
   */
  const place = (it: RoadmapItem) => {
    const area = it.area;
    const len = defaultLen(it, grain);
    let start = Math.max(now, snapTo(view.start + view.span * 0.25, snap));
    liveItems
      .filter((x) => x.area === area && x.sched)
      .sort((a, b) => a.sched!.start - b.sched!.start)
      .forEach((x) => {
        if (start < x.sched!.start + x.sched!.len && start + len > x.sched!.start) {
          start = x.sched!.start + x.sched!.len;
        }
      });
    onSelect(it.id);
    onSchedule(it, clampSpanToDomain({ start, len }))
      .catch((e2) => setErr((e2 as Error)?.message || `Could not schedule ${it.title}.`));
  };

  const tray = visible.filter((i) => !i.sched && !i.done && areaMatches(i.area, areaFilter));
  // Unscheduled AND unsized — a subset of the tray, drawn as its own row
  // because a bar cannot be laid out for something with no length. Same chip.
  const horizon = horizonOf(items, areaFilter);

  const lanesOver = shown.length + (orphans.length ? 1 : 0) > LANES_SHOWN;

  return (
    <div className={`rt${drawer && selected ? ' with-drawer' : ''}`}>
      <div className="rt-main">
        <WhatsNext items={liveItems} areas={areas} weekZero={weekZero} now={now}
          onSelect={onSelect} open={openNext} onToggle={() => setOpenNext(!openNext)} />

        {err && <div className="action-error">{err}</div>}

        <div className="rt-chart">
          <div className="rt-toolbar">
            <div className="seg-control sm" role="tablist" aria-label="Timeline shape">
              <button role="tab" aria-selected={mode === 'chart'}
                className={`seg-opt ${mode === 'chart' ? 'on' : ''}`} onClick={() => setMode('chart')}>Chart</button>
              <button role="tab" aria-selected={mode === 'calendar'}
                className={`seg-opt ${mode === 'calendar' ? 'on' : ''}`} onClick={() => setMode('calendar')}
                title={weekZero ? 'The same window, drawn as a calendar' : 'Needs a start date on this project'}>
                Calendar
              </button>
            </div>

            <div className="rt-window">
              <span className="range">{windowLabel(view, grain, weekZero)}</span>
              <span className="sub">{spanLabel(view, grain, weekZero)}</span>
            </div>

            <ZoomControl view={view} trackPx={px} grain={grain}
              onStop={setStop} onIn={() => zoomBy(1.4)} onOut={() => zoomBy(1 / 1.4)} />

            <button className="rt-jump now" onClick={() => goTo(now)}
              title="Bring today back into the window">Now</button>
            <button className="rt-jump" onClick={fitEverything}
              title="Zoom out until every scheduled bar is on screen">Fit all</button>
          </div>

          <div className="rt-body">
            <div className="rt-viewwrap">
              {mode === 'chart' ? (
                <div className="rt-grid-wrap">
                  <div className="rt-names">
                    <div className="rt-names-head">Area</div>
                    <div className={`rt-names-list${expanded ? ' expanded' : ''}`}>
                      {shown.map((a) => {
                        const n = liveItems.filter((i) => i.area === a.name && i.sched).length;
                        return (
                          <LaneName key={a.name} name={a.name} dot={a.dot} count={n}
                            palette={palette} picking={colourFor === a.name}
                            onPick={() => setColourFor(colourFor === a.name ? null : a.name)}
                            onRecolour={(c) => { setColourFor(null); onRecolour(a.name, c); }} />
                        );
                      })}
                      {orphans.length > 0 && (
                        <LaneName name="Unallocated" dot="" count={orphans.length}
                          folded={!openOrphans} onFold={() => setOpenOrphans(!openOrphans)} />
                      )}
                      <LaneName name="Horizon" dot="" count={horizon.length} ghost />
                    </div>
                  </div>

                  <div className={`rt-track${dragging ? ' dragging' : ''}`} ref={trackRef}
                    onPointerDown={startPan}>
                    <div className="rt-ruler">
                      {bands.map((b) => (
                        <span key={`h${b.key}`} className="rt-band"
                          style={{ left: `${b.left}%`, width: `${b.width}%` }} aria-hidden="true" />
                      ))}
                      {ticks.map((t) => (
                        <span key={t.at} className={`rt-tick${t.major ? ' major' : ''}`}
                          style={{ left: `${t.left}%` }}>
                          {t.sub && <span className="sub">{t.sub}</span>}
                          <span className="lbl">{t.label}</span>
                        </span>
                      ))}
                    </div>

                    <div className={`rt-lanes${expanded ? ' expanded' : ''}`}>
                      {shown.length === 0 && orphans.length === 0 && (
                        <div className="rt-empty">
                          {areaFilter === ''
                            ? 'No areas with work in them yet. Tag an item with an area — or add one above — and it becomes a lane here.'
                            : 'Nothing in this area. Clear the filter above, or drag something out of the tray onto a lane.'}
                        </div>
                      )}

                      {shown.map((a) => (
                        <Lane key={a.name} dot={a.dot} ticks={ticks} bands={bands}
                          lane={layoutLane(a.name, liveItems.filter((i) => i.area === a.name), trackW, view)}
                          view={view} selectedId={selectedId} proposed={proposed}
                          onDrop={dropOnLane(a.name)} onGoTo={goTo}
                          onSelect={onSelect} onOpen={onOpen} onDown={startBar}
                          onUnschedule={(it) => {
                            onSchedule(it, null).catch((e2) => setErr((e2 as Error)?.message || 'Could not unschedule.'));
                          }} />
                      ))}

                      {orphans.length > 0 && openOrphans && (
                        // No dot and no picker: there is no area here to give a colour to.
                        <Lane dot="" ticks={ticks} bands={bands}
                          lane={layoutLane('', orphans.map(withLive), trackW, view)}
                          view={view} selectedId={selectedId} proposed={proposed}
                          onDrop={dropOnLane('')} onGoTo={goTo}
                          onSelect={onSelect} onOpen={onOpen} onDown={startBar}
                          onUnschedule={(it) => {
                            onSchedule(it, null).catch((e2) => setErr((e2 as Error)?.message || 'Could not unschedule.'));
                          }} />
                      )}
                      {orphans.length > 0 && !openOrphans && <div className="rt-lane folded" />}

                      {/* The horizon: committed work with no schedule and no
                          estimate — it is on the roadmap but not yet in the plan,
                          and saying so is more honest than parking it at minute
                          zero. The population is `horizonOf`, filter and all: it
                          is the same chip the lanes, the tray and the orphan fold
                          obey, and this row used to be the one thing on the chart
                          that did not. */}
                      <div className="rt-lane horizon">
                        <div className="rt-horizon-chips">
                          {horizon.slice(0, 6).map((i) => (
                            <button key={i.id} className="rt-horizon-chip" onClick={() => onOpen(i)}
                              title="Give it a size and it can be scheduled">{i.title}</button>
                          ))}
                          {/* NOT `rt-lane-empty`: that one is `height: 100%`,
                              which inside this wrapping flex row takes a whole
                              lane's height to itself and pushes the chips out of
                              a body that clips. */}
                          {horizon.length > 6 && (
                            <span className="rt-horizon-more">…and {horizon.length - 6} more</span>
                          )}
                          {horizon.length === 0 && (
                            // Scoped, because the claim is: "everything
                            // unscheduled HERE". Unqualified under a filter it
                            // would speak for a board it is not looking at.
                            <span className="rt-horizon-more">
                              Everything unscheduled{areaFilter ? ` in ${areaFilter === UNALLOCATED ? 'unallocated' : areaFilter}` : ''} has been sized.
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* The now marker floats over every lane. Dragging it PANS —
                        it is the one handle on the chart whose whole job is
                        "take me through time", and moving today is not a thing
                        anybody may do. */}
                    <div className="rt-nowlayer" aria-hidden={!nowOn}>
                      {nowOn && <span className="rt-nowline" style={{ left: `${nowPct}%` }} />}
                      {nowOn && (
                        <button className="rt-nowhandle" style={{ left: `${nowPct}%` }}
                          onPointerDown={(e) => { e.stopPropagation(); startPan(e); }}
                          onDoubleClick={() => goTo(now)}
                          title="Drag left or right to move the window through time">
                          <span className="a">◂</span>
                          <span className="t">{grain === 'hour' && weekZero
                            ? `NOW ${fmtTime(dateAt(now, weekZero)!)}` : 'NOW'}</span>
                          <span className="a">▸</span>
                        </button>
                      )}
                      {!nowOn && (
                        <button className={`rt-nowoff ${nowPct < 0 ? 'left' : 'right'}`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => goTo(now)}
                          title="Now is outside this window">
                          {nowPct < 0 ? '◂ NOW' : 'NOW ▸'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <Calendar items={liveItems} areas={areas} view={view} grain={grain}
                  weekZero={weekZero} now={now} selectedId={selectedId}
                  dragging={dragging} onPointerDown={startPan} calRef={calRef}
                  onSelect={onSelect} onDown={startBar} />
              )}

              {mode === 'chart' && lanesOver && (
                <button className="rt-expand" onClick={() => setExpanded(!expanded)}>
                  {expanded
                    ? `Collapse to ${LANES_SHOWN} lanes`
                    : `Show all ${shown.length + (orphans.length ? 1 : 0)} lanes`}
                </button>
              )}
            </div>

            {selectedLive && drawer && (
              <Drawer item={selectedLive} areas={areas} labels={labels} children={children}
                totals={totals} weekZero={weekZero} snap={snap}
                onClose={() => setDrawer(false)} onClear={() => onSelect(null)}
                onPatch={(s) => patch(selectedLive, s)}
                onUnschedule={() => {
                  onSchedule(selectedLive, null).catch((e2) => setErr((e2 as Error)?.message || 'Could not unschedule.'));
                }}
                onGoTo={() => goTo(selectedLive.sched ? selectedLive.sched.start : now)}
                onOpen={() => onOpen(selectedLive)} onToggleSkip={onToggleSkip}
                onRebaseline={() => onRebaseline(selectedLive).catch((e2) => setErr((e2 as Error)?.message || 'Could not re-baseline.'))} />
            )}
            {selectedLive && !drawer && (
              <button className="rt-drawer-rail" onClick={() => setDrawer(true)} title="Show this bar">
                <span className="chev">‹</span><span className="w">Scope</span>
              </button>
            )}
          </div>

          <div className="rt-foot">
            <span className="n">{scheduled} scheduled · {grain} grain</span>
            <span className="rt-hint">
              {mode === 'chart'
                ? 'Scroll to zoom · drag the grid or the NOW marker to move · click a bar to open it, drag its right edge to resize'
                : 'Scroll to zoom · drag sideways to change days · click an event to open it, drag its bottom edge to resize'}
            </span>
          </div>
        </div>

        <Tray items={tray} areas={areas} areaFilter={areaFilter}
          open={openTray} onToggle={() => setOpenTray(!openTray)}
          onSelect={onSelect} onPlace={place} />
      </div>
    </div>
  );
}

// --- the zoom --------------------------------------------------------------

/**
 * The zoom: five named stops, a dot that shows where between them you actually
 * are, and a step either side.
 *
 * The dot is on a LOG scale, because the zoom is: each stop is roughly a third
 * of the one below it, so a linear dot would spend four fifths of its travel
 * between Month and Quarter. The stops are shortcuts to a pixel density and the
 * dot is the truth — you can sit anywhere between two of them, and the label in
 * the accent is whichever grain you have landed in.
 */
function ZoomControl({ view, trackPx, grain, onStop, onIn, onOut }: {
  view: Viewport; trackPx: number; grain: Grain;
  onStop: (px: number) => void; onIn: () => void; onOut: () => void;
}) {
  const at = pxPerDay(view, trackPx);
  const t = Math.max(0, Math.min(1,
    (Math.log(Math.max(PX_DAY_MIN, at)) - Math.log(PX_DAY_MIN))
    / (Math.log(PX_DAY_MAX) - Math.log(PX_DAY_MIN))));
  return (
    <div className="rt-zoom">
      <button onClick={onIn} title="Finer grain — toward hours" aria-label="Zoom in">◂</button>
      <div className="rt-zoom-scale">
        <div className="stops">
          {ZOOM_STOPS.map((s) => (
            <button key={s.key} className={s.key === grain ? 'on' : ''}
              onClick={() => onStop(s.px)} title={`About ${s.px}px to a day`}>{s.label}</button>
          ))}
        </div>
        <div className="rail"><span className="dot" style={{ left: `${(1 - t) * 100}%` }} /></div>
      </div>
      <button onClick={onOut} title="Coarser grain — toward quarters" aria-label="Zoom out">▸</button>
    </div>
  );
}

// --- the lanes -------------------------------------------------------------

function LaneName({ name, dot, count, palette, picking, onPick, onRecolour, ghost, folded, onFold }: {
  name: string; dot: string; count: number;
  palette?: string[]; picking?: boolean;
  onPick?: () => void; onRecolour?: (dot: string) => void;
  ghost?: boolean;
  folded?: boolean; onFold?: () => void;
}) {
  return (
    <div className={`rt-lane-name${ghost ? ' quiet' : ''}`}>
      {/* The dot is the picker, because the moment you want a different colour
          is the moment you are looking at two lanes wearing the same one. */}
      {onPick && palette ? (
        <button className="dot pick" style={dot ? { background: dot } : undefined}
          aria-label={`Colour for ${name}`} title={`${name} — click to change its colour`}
          onClick={onPick} />
      ) : (
        <span className={`dot${dot ? '' : ' ghost'}`} style={dot ? { background: dot } : undefined} />
      )}
      {picking && palette && onRecolour && (
        <span className="rtab-palette" role="menu">
          {palette.map((c) => (
            <button key={c} role="menuitem" style={{ background: c }}
              className={c === dot ? 'on' : ''} title={c}
              onClick={() => onRecolour(c)} />
          ))}
        </span>
      )}
      {onFold ? (
        <button className="nm fold" onClick={onFold} aria-expanded={!folded}
          title={folded ? `Show ${name}` : `Fold ${name} away`}>
          <span className="chev">{folded ? '▸' : '▾'}</span>{name}
        </button>
      ) : (
        <span className="nm">{name}</span>
      )}
      <span className="n">{count || ''}</span>
    </div>
  );
}

const pctStyle = (p: { left: number; width: number }) =>
  ({ left: `${p.left}%`, width: `${p.width}%` });

// One area lane. Split out so a lane re-renders on its own during a drag.
function Lane({
  dot, lane, ticks, bands, view, selectedId, proposed,
  onDrop, onGoTo, onSelect, onOpen, onDown, onUnschedule,
}: {
  dot: string;
  lane: ReturnType<typeof layoutLane>;
  ticks: ReturnType<typeof ticksFor>['ticks'];
  bands: ReturnType<typeof ticksFor>['bands'];
  /** The slice on screen — the proposal ghosts are positioned against it. */
  view: Viewport;
  selectedId: number | null;
  proposed?: Map<number, SchedSpan>;
  onDrop: (e: React.DragEvent) => void;
  onGoTo: (at: number) => void;
  onSelect: (id: number) => void;
  onOpen: (it: RoadmapItem) => void;
  onDown: (it: RoadmapItem, kind: 'move' | 'resize') => (e: React.PointerEvent) => void;
  onUnschedule: (it: RoadmapItem) => void;
}) {
  return (
    <div className="rt-lane" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}
      style={{ minHeight: Math.max(LANE_H, 18 + lane.rows * BAR_ROW_H) }}>
      <div className="rt-lane-grid" aria-hidden="true">
        {bands.map((b) => (
          <span key={b.key} className="rt-band" style={{ left: `${b.left}%`, width: `${b.width}%` }} />
        ))}
        {ticks.map((t) => (
          <span key={t.at} className={`rt-rule${t.major ? ' major' : ''}`} style={{ left: `${t.left}%` }} />
        ))}
      </div>

      {/* What the zoom put off screen, at the edge it went off. Counted, not
          dropped — a lane holding three bars a fortnight to the left must not
          draw as an empty one — and the marker takes you to them. */}
      {lane.offLeft > 0 && lane.nearestLeft !== null && (
        <button className="rt-off left" onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onGoTo(lane.nearestLeft!)}
          title={`${lane.offLeft} bar${lane.offLeft === 1 ? '' : 's'} earlier than this window`}>
          ◂ {lane.offLeft}
        </button>
      )}
      {lane.offRight > 0 && lane.nearestRight !== null && (
        <button className="rt-off right" onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onGoTo(lane.nearestRight!)}
          title={`${lane.offRight} bar${lane.offRight === 1 ? '' : 's'} later than this window`}>
          {lane.offRight} ▸
        </button>
      )}

      {lane.bars.map((bar) => {
        const it = bar.item;
        const state = it.done ? 'done' : it.claimedBy ? 'now' : 'plan';
        const sel = selectedId === it.id;
        const prop = proposed?.get(it.id);
        const top = 9 + bar.row * BAR_ROW_H;
        return (
          <div key={it.id}>
            {/* the baseline ghost — only when a baseline exists AND differs */}
            {bar.ghost && (
              <div className="rt-ghost" title="Where the plan put it"
                style={{ top, ...pctStyle(bar.ghost) }} />
            )}
            {/* an arrange proposal's position, ghosted in the accent */}
            {prop && (
              <div className="rt-proposed" title="Proposed"
                style={{ top, ...pctStyle(spanPct(prop, view)) }} />
            )}
            {/* The bar wears its AREA's colour, and its state is how much of it
                there is (styles.css). `--tint` is unset on the Unallocated lane,
                where the plain state colours still apply — an item with no area
                has no colour to be given. */}
            <div className={`rt-bar ${state}${dot ? ' tinted' : ''}${sel ? ' sel' : ''}`}
              style={{
                top, left: `${bar.left}%`, width: `${bar.width}%`,
                // A bar that starts before the window keeps its title VISIBLE:
                // the hidden part is padded away, so the label sits at the left
                // edge of the track instead of off it. Percentages here and in
                // `left` both resolve against the lane's width, so the two
                // cancel exactly. Without it, panning turns every bar it clips
                // into an anonymous block of colour.
                ...(bar.left < 0 ? { paddingLeft: `calc(9px + ${-bar.left}%)` } : {}),
                ...(dot ? { '--tint': dot } : {}),
              } as React.CSSProperties}
              onPointerDown={onDown(it, 'move')}
              // No onClick/onDoubleClick: preventDefault in onDown suppresses
              // both. Selecting and opening are decided in the pointer flow
              // above, which is the only place that can tell a press from a drag.
              title={`${it.title} — drag to reschedule, click for its detail, double-click to open`}>
              <span className="cap" aria-hidden="true" />
              {bar.inside && <span className="t">{it.title}</span>}
              <span className="grip" title="Drag to change how long this takes"
                onPointerDown={onDown(it, 'resize')} />
            </div>
            {!bar.inside && (
              <button className={`rt-outlabel ${state}`}
                onPointerDown={(e) => e.stopPropagation()}
                style={bar.before
                  ? { top, right: `${100 - bar.left}%` }
                  : { top, left: `${bar.left + bar.width}%` }}
                onClick={() => onSelect(it.id)}
                onDoubleClick={() => onOpen(it)}>{it.title}</button>
            )}
            {sel && (
              <button className="rt-x" title="Send back to Unscheduled"
                onPointerDown={(e) => e.stopPropagation()}
                style={bar.before
                  ? { top, left: `calc(${bar.left + bar.width}% + 4px)` }
                  : { top, right: `calc(${100 - bar.left}% + 4px)` }}
                onClick={(e) => { e.stopPropagation(); onUnschedule(it); }}>×</button>
            )}
          </div>
        );
      })}

      {/* "Nothing here" and "nothing in THIS WINDOW" are different answers, and
          only one of them invites a drop. */}
      {lane.bars.length === 0 && (
        <span className="rt-lane-empty">
          {lane.offLeft + lane.offRight > 0
            ? `${lane.offLeft + lane.offRight} bar${lane.offLeft + lane.offRight === 1 ? '' : 's'}, all outside this window`
            : 'Drop something here to schedule it'}
        </span>
      )}
    </div>
  );
}

// --- the drawer ------------------------------------------------------------

/**
 * Everything about the selected bar, in one 340px column: how long it takes,
 * when it happens, whether it is where it was promised to be, and what it is
 * made of.
 *
 * THE TWO CONTROLS ARE THE SAME TWO EDITS THE CHART OFFERS, spelled out. A drag
 * is fast and imprecise; a nudge is exact and slow, and the step it moves by is
 * the GRAIN you are looking at — so the same button means fifteen minutes on an
 * hour grid and a day on a quarter one. The presets are neither: they are the
 * sizes a person actually says out loud.
 */
function Drawer({
  item, areas, labels, children, totals, weekZero, snap,
  onClose, onClear, onPatch, onUnschedule, onGoTo, onOpen, onToggleSkip, onRebaseline,
}: {
  item: RoadmapItem;
  areas: BoardArea[];
  labels: BoardLabel[];
  children: RoadmapItem[];
  totals: ReturnType<typeof scopeTotals>;
  weekZero: string | null;
  snap: number;
  onClose: () => void;
  onClear: () => void;
  onPatch: (s: SchedSpan) => void;
  onUnschedule: () => void;
  onGoTo: () => void;
  onOpen: () => void;
  onToggleSkip: (it: RoadmapItem) => void;
  onRebaseline: () => void;
}) {
  const s = item.sched;
  const dot = areas.find((a) => a.name === item.area)?.dot || '';
  const from = s ? dateAt(s.start, weekZero) : null;
  const to = s ? dateAt(s.start + s.len, weekZero) : null;
  const nudge = (field: 'start' | 'len', by: number) => () => {
    if (!s) return;
    onPatch(clampSpanToDomain(field === 'start'
      ? { start: s.start + by, len: s.len }
      : { start: s.start, len: Math.max(MIN_SCHED_LEN, s.len + by) }));
  };

  return (
    <aside className="rt-drawer">
      <div className="rt-drawer-head">
        <button className="rt-drawer-toggle" onClick={onClose} title="Collapse">›</button>
        <span className={`dot${dot ? '' : ' ghost'}`} style={dot ? { background: dot } : undefined} />
        <span className="area">{item.area || 'no area'}</span>
        <button className="rt-drawer-x" onClick={onClear} title="Deselect">×</button>
      </div>

      <button className="rt-drawer-title" onClick={onOpen} title="Open this item">{item.title}</button>

      {s ? (
        <>
          <div className="rt-field">
            <div className="lbl">How long will this take</div>
            <div className="rt-dur">
              <span className="v">{fmtDur(s.len)}</span>
              <span className="rt-step">
                <button onClick={nudge('len', -snap)} title="Shorter">−</button>
                <span className="by">±{fmtDur(snap)}</span>
                <button onClick={nudge('len', snap)} title="Longer">+</button>
              </span>
            </div>
            {/* Against a fortnight, which is what the presets top out at — a
                progress bar with no stated ceiling is a bar that means nothing. */}
            <div className="rt-durbar" title="Against a fortnight">
              <span style={{
                width: `${Math.max(4, Math.min(100, (s.len / (14 * MIN_PER_DAY)) * 100))}%`,
                background: dot || 'var(--accent)',
              }} />
            </div>
            <div className="rt-durs">
              {DUR_OPTIONS.map((d) => (
                <button key={d.label} className={Math.abs(s.len - d.min) < 1 ? 'on' : ''}
                  onClick={() => onPatch(clampSpanToDomain({ start: s.start, len: d.min }))}>
                  {d.label}
                </button>
              ))}
            </div>
            <div className="rt-note">Or drag the bar’s right edge on the timeline.</div>
          </div>

          <div className="rt-field">
            <div className="lbl">When</div>
            <div className="rt-when">
              <span className="v">
                {from
                  ? <>{fmtDate(from)} · {fmtTime(from)}<br />
                    <span className="ends">ends {fmtDate(to!)} · {fmtTime(to!)}</span></>
                  // No week zero, so no dates — the week index is what this
                  // project actually knows, and inventing a date would be the
                  // calendar's lie in a smaller box.
                  : <>wk {weekNo(s.start)}<br /><span className="ends">ends wk {weekNo(s.start + s.len)}</span></>}
              </span>
              <span className="rt-step">
                <button onClick={nudge('start', -snap)} title="Start earlier">◂</button>
                <button onClick={nudge('start', snap)} title="Start later">▸</button>
              </span>
            </div>
            <div className="rt-note">
              {s.len >= MIN_PER_DAY
                ? `${Math.ceil(s.len / MIN_PER_DAY)} days on the board`
                : 'inside one day'}
              {' · '}
              {item.estimate === null ? 'unsized on the board' : `sized at ${item.estimate} wk`}
            </div>
          </div>

          <SlipLine item={item} onRebaseline={onRebaseline} />
        </>
      ) : (
        <div className="rt-slip none">Unscheduled — in the tray below.</div>
      )}

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
          // The total is incomplete and must say so — an unsized line is not a
          // free one, and a bar that "fits" because half of it was never sized
          // is the lie this whole drawer exists to avoid.
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
                  <button className="t" onClick={() => onOpen()}>{c.title}</button>
                  {labelsOf(c.labels, labels).map((l) => (
                    <span key={l.key} className={`rl rl-${l.tone}`}>{l.name}</span>
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

      <div className="rt-drawer-acts">
        <button className="rt-act accent" onClick={onOpen}>Open item</button>
        {s && <button className="rt-act" onClick={onGoTo} title="Bring this bar back into the window">Show me</button>}
        {s && <button className="rt-act" onClick={onUnschedule}>Unschedule</button>}
      </div>
    </aside>
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
  if (s.min === 0 && s.longer === 0) return <div className="rt-slip ok">On the plan it started with.</div>;
  const bits: string[] = [];
  if (s.min) bits.push(`${s.min > 0 ? 'starts' : 'pulled'} ${fmtDur(Math.abs(s.min))} ${s.min > 0 ? 'later' : 'earlier'}`);
  if (s.longer) bits.push(`${fmtDur(Math.abs(s.longer))} ${s.longer > 0 ? 'longer' : 'shorter'}`);
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
function WhatsNext({ items, areas, weekZero, now, onSelect, open, onToggle }: {
  items: RoadmapItem[]; areas: BoardArea[]; weekZero: string | null; now: number;
  onSelect: (id: number) => void;
  open: boolean; onToggle: () => void;
}) {
  const next = whatsNext(items, now);
  if (!next.length) {
    // Nothing ahead is worth saying WITHOUT being opened for: it is the one
    // state of this strip that is a finding rather than a list.
    return (
      <div className="rt-next empty">
        <span className="lbl">What&rsquo;s next</span>
        <span className="rt-hint">
          Nothing is scheduled from here on. Drag something out of the tray, or press Arrange.
        </span>
      </div>
    );
  }
  const running = next.filter((n) => n.running).length;
  return (
    <div className={`rt-next${open ? ' on' : ''}`}>
      <button className={`rt-fold${open ? ' on' : ''}`} onClick={onToggle} aria-expanded={open}>
        <span className="chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="lbl">What’s next</span>
        <span className="n">{next.length}</span>
        <span className="rt-hint">
          {running
            ? `${running} running now${next.length > running ? ` · ${next.length - running} queued` : ''}`
            : `next up in ${fmtWhen(next[0].inMin, false)}`}
        </span>
      </button>
      {open && (
        <div className="rt-next-grid">
          {next.map(({ item, inMin, running: live }) => {
            const d = item.sched ? dateAt(item.sched.start, weekZero) : null;
            return (
              <button key={item.id} className={`rt-next-card${live ? ' running' : ''}`}
                onClick={() => onSelect(item.id)}
                title={`${item.area || 'untagged'} · ${fmtDur(item.sched!.len)}`}>
                <span className="top">
                  <span className="dot" style={{ background: areas.find((a) => a.name === item.area)?.dot || 'var(--line-3)' }} />
                  <span className="area">{item.area || 'untagged'}</span>
                  <span className="when">{fmtWhen(inMin, live)}</span>
                </span>
                <span className="t">{item.title}</span>
                <span className="at">{d ? `${fmtDate(d)} · ${fmtTime(d)}` : `wk ${weekNo(item.sched!.start)}`}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- the tray --------------------------------------------------------------

/**
 * Unscheduled work, GROUPED BY AREA rather than as one flat run of chips.
 *
 * The grouping is the point: the lane a thing belongs in is the lane you are
 * about to drop it on, so the tray is already sorted the way the chart is. A
 * click places it after the last bar in its own lane; a drag puts it exactly
 * where you let go, and onto any lane you like.
 */
function Tray({ items, areas, areaFilter, open, onToggle, onSelect, onPlace }: {
  items: RoadmapItem[]; areas: BoardArea[]; areaFilter: string;
  open: boolean; onToggle: () => void;
  onSelect: (id: number) => void;
  onPlace: (it: RoadmapItem) => void;
}) {
  const order = [...areas.map((a) => a.name), ''];
  const groups = order
    .map((name) => ({ name, dot: areas.find((a) => a.name === name)?.dot || '', rows: items.filter((i) => i.area === name) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="rt-tray">
      {/* Folded, the tray is one line that still says how many are waiting.
          Dragging a chip onto a lane needs it open, which is the trade: the
          gesture is available the moment you are looking for it. */}
      <button className={`rt-fold${open ? ' on' : ''}`} onClick={onToggle} aria-expanded={open}>
        <span className="chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="lbl">Unscheduled</span>
        <span className="n">{items.length}</span>
        <span className="rt-hint">
          {items.length
            ? `${areaFilter === '' ? 'across every area' : `in ${areaFilter === UNALLOCATED ? 'items with no area' : areaFilter}`} · click to drop it on its lane, or drag it where you want it`
            : 'Everything in this filter is on the timeline.'}
        </span>
      </button>
      {open && groups.map((g) => (
        <div className="rt-tray-group" key={g.name || '(none)'}>
          <div className="rt-tray-area">
            <span className={`dot${g.dot ? '' : ' ghost'}`} style={g.dot ? { background: g.dot } : undefined} />
            <span className={`nm${g.name ? '' : ' quiet'}`}>{g.name || 'no area'}</span>
            <span className="n">{g.rows.length}</span>
          </div>
          <div className="rt-tray-items">
            {g.rows.map((i) => (
              <div key={i.id} className="rt-chip" draggable
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(i.id)); e.dataTransfer.effectAllowed = 'move'; }}
                onClick={() => { onSelect(i.id); onPlace(i); }}
                title={`Click to drop this onto the ${g.name || 'unallocated'} lane, or drag it anywhere`}>
                <span className={`dot${g.dot ? '' : ' ghost'}`} style={g.dot ? { background: g.dot } : undefined} />
                <span className="t">{i.title}</span>
                <span className="est">{i.estimate === null ? 'unsized' : `${i.estimate} wk`}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- the calendar ----------------------------------------------------------

/**
 * THE SAME WINDOW, DRAWN AS A CALENDAR — and which calendar depends on the ZOOM,
 * not on a second control. Hours and days become a time grid with real hour
 * rows; weeks and coarser become month grids, because an hour row is nonsense
 * once a screen holds a quarter.
 *
 * It needs real dates, and without a week zero it says so rather than drawing an
 * invented year — a calendar whose dates are made up is worse than no calendar.
 */
function Calendar({
  items, areas, view, grain, weekZero, now, selectedId, dragging, onPointerDown, calRef,
  onSelect, onDown,
}: {
  items: RoadmapItem[]; areas: BoardArea[]; view: Viewport; grain: Grain;
  weekZero: string | null; now: number; selectedId: number | null;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  calRef: React.MutableRefObject<HTMLDivElement | null>;
  onSelect: (id: number) => void;
  onDown: (it: RoadmapItem, kind: 'move' | 'resize') => (e: React.PointerEvent) => void;
}) {
  if (!weekZero) {
    return (
      <div className="rt-cal-none" ref={calRef}>
        This project has no start date, so a minute offset has no day to sit on and the calendar
        cannot be drawn. The chart works without one. Set a start date on the project to turn the
        plan into dates.
      </div>
    );
  }
  const dotOf = (a: string) => areas.find((x) => x.name === a)?.dot || '';
  const cls = `rt-cal${dragging ? ' dragging' : ''}`;

  if (grain === 'hour' || grain === 'day') {
    const days = calendarDays(items, view, grain, weekZero, now);
    // THE HOUR WINDOW STRETCHES TO WHAT IS ACTUALLY THERE. Six-to-ten is the
    // default frame, but a 04:00 event outside it would be positioned above the
    // grid and paint over the header — so anything earlier or later widens the
    // frame instead of being drawn somewhere it is not.
    let from = CAL_HOUR_FROM; let to = CAL_HOUR_TO;
    for (const d of days) {
      for (const ev of d.events) {
        const dayFrom = d.day * MIN_PER_DAY;
        from = Math.min(from, Math.floor((ev.startMin - dayFrom) / MIN_PER_HOUR));
        to = Math.max(to, Math.ceil((ev.endMin - dayFrom) / MIN_PER_HOUR));
      }
    }
    from = Math.max(0, from); to = Math.min(24, Math.max(from + 1, to));
    const hours = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const bodyH = (to - from) * CAL_HOUR_H;
    const nowTop = ((now - Math.floor(now / MIN_PER_DAY) * MIN_PER_DAY) / MIN_PER_HOUR - from) * CAL_HOUR_H;

    return (
      <div className={cls} ref={calRef} onPointerDown={onPointerDown}>
        <div className="rt-cal-head">
          <span className="gutter" />
          {days.map((d) => (
            <span className="col" key={d.day}>
              <span className="dow">{dowShort(d.date)}</span>
              <span className={`num${d.today ? ' today' : ''}`}>{d.date.getUTCDate()}</span>
            </span>
          ))}
        </div>

        <div className="rt-cal-allday">
          <span className="gutter">All-day</span>
          {days.map((d) => (
            <span className="col" key={d.day}>
              {d.allDay.map(({ item, first }) => (
                <button key={item.id} className={`rt-cal-chip${selectedId === item.id ? ' sel' : ''}`}
                  style={dotOf(item.area) ? { '--tint': dotOf(item.area) } as React.CSSProperties : undefined}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onSelect(item.id)}
                  title={`${item.title} — ${fmtDur(item.sched!.len)}`}>
                  {first ? item.title : `↳ ${item.title}`}
                </button>
              ))}
            </span>
          ))}
        </div>

        <div className="rt-cal-scroll">
          <div className="rt-cal-body" style={{ height: bodyH }}>
            <span className="gutter">
              {hours.map((h) => (
                <span key={h} className="hr" style={{ top: (h - from) * CAL_HOUR_H }}>
                  {h === from ? '' : `${String(h).padStart(2, '0')}:00`}
                </span>
              ))}
            </span>
            {days.map((d) => {
              const dayFrom = d.day * MIN_PER_DAY;
              return (
                <span className="col" key={d.day}>
                  {hours.map((h) => (
                    <span key={h} className="rule" style={{ top: (h - from) * CAL_HOUR_H }} aria-hidden="true" />
                  ))}
                  {d.events.map((ev) => {
                    const top = ((ev.startMin - dayFrom) / MIN_PER_HOUR - from) * CAL_HOUR_H;
                    const h = Math.max(22, ((ev.endMin - ev.startMin) / MIN_PER_HOUR) * CAL_HOUR_H);
                    const sel = selectedId === ev.item.id;
                    return (
                      <span key={ev.item.id} className={`rt-cal-ev${sel ? ' sel' : ''}`}
                        style={{
                          top, height: h,
                          ...(dotOf(ev.item.area) ? { '--tint': dotOf(ev.item.area) } : {}),
                        } as React.CSSProperties}
                        onPointerDown={onDown(ev.item, 'move')}
                        onClick={() => onSelect(ev.item.id)}>
                        <span className="tm">
                          {fmtTime(dateAt(ev.startMin, weekZero)!)} – {fmtTime(dateAt(ev.endMin, weekZero)!)}
                        </span>
                        <span className="t">{ev.item.title}</span>
                        {/* The grip resizes along the SAME axis the chart's does
                            — time — even though it is drawn vertically here. */}
                        <span className="grip" title="Drag to change how long this takes"
                          onPointerDown={onDown(ev.item, 'resize')} />
                      </span>
                    );
                  })}
                  {d.today && nowTop >= 0 && nowTop <= bodyH && (
                    <span className="rt-cal-now" style={{ top: nowTop }} aria-hidden="true" />
                  )}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  const months = calendarMonths(items, view, grain, weekZero, now);
  const compact = months.length > 1;
  return (
    <div className={`${cls} months${compact ? ' compact' : ''}`} ref={calRef} onPointerDown={onPointerDown}>
      {months.map((m) => (
        <div className="rt-cal-month" key={m.key}>
          <div className="rt-cal-mhead">{m.title}</div>
          <div className="rt-cal-grid">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, k) => (
              <span className="dow" key={k}>{d}</span>
            ))}
            {m.cells.map((c) => (
              <div key={c.day} className={`rt-cal-cell${c.inMonth ? '' : ' out'}`}>
                <span className={`num${c.today ? ' today' : ''}`}>{c.date.getUTCDate()}</span>
                {!compact && c.items.slice(0, 2).map((i) => (
                  <button key={i.id} className={`rt-cal-chip${selectedId === i.id ? ' sel' : ''}`}
                    style={dotOf(i.area) ? { '--tint': dotOf(i.area) } as React.CSSProperties : undefined}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onSelect(i.id)} title={i.title}>{i.title}</button>
                ))}
                {!compact && c.items.length > 2 && (
                  <span className="more">+{c.items.length - 2} more</span>
                )}
                {/* At the quarter grain a cell is too small for a title, so the
                    day's load is drawn as DENSITY. It is the same population the
                    chips would list — never a different one. */}
                {compact && c.items.length > 0 && (
                  <span className="load" title={`${c.items.length} active`}
                    style={{ opacity: Math.min(1, 0.25 + c.items.length * 0.2) }} />
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
