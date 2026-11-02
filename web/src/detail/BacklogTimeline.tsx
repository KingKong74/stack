// THE BACKLOG'S TIMELINE — the design's Gantt (Board.dc.html, "TIMELINE"), drawn
// over the same sprints and rows the List view ranks. One lane per sprint, in
// board order, with the backlog last.
//
// WHAT A BAR MEANS. Nothing here is a stored schedule. A sprint's items are laid
// END TO END from its start, in `sprintRank` order, each as long as its
// `estimate` (weeks → days, ×7). An item with no estimate is drawn as two days,
// with a dashed edge, so a guessed length never reads like a typed one. The
// backlog is laid out the same way, starting the Monday after the last dated
// sprint ends. It is drawn dashed and labelled PROJECTED, because nothing has
// committed to it. A bar that runs past its sprint's end is hatched, and the
// lane head counts the days over.
//
// THE ONE WRITE IS THE SPRINT'S WINDOW. Dragging a sprint's bar moves it, and
// dragging an edge moves that end. Dragging across an undated lane gives it a
// window (a click alone makes it twelve days). The drag is drawn locally and
// sent as ONE PATCH of both ends on release: two PATCHes would race the
// server's end-before-start check. Dates never gate the runner (the runner
// reads `status`), so this is a note to the human, the same as the List
// view's date editor.
//
// THE AXIS FREEZES WHILE A WINDOW IS BEING DRAGGED, or the range would grow
// under the cursor and the bar would slide away from the pointer.
//
// It never writes a rank or moves a row. Ordering stays the List view's drag.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { KitIcon } from './kit/KitIcon';
import type { BoardList, RoadmapItem, Sprint } from '../types';
import { priorityMeta } from '../lib/ui';

const DAY = 86400000;
const d2n = (s: string) => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY);
const n2d = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
const fmtD = (n: number) => new Date(n * DAY).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
/** 0 = Monday. Day 0 of the epoch was a Thursday. */
const wkday = (n: number) => ((n + 3) % 7 + 7) % 7;
/** Today as a day number, read on the reader's own calendar, not UTC's. */
const todayN = () => { const t = new Date(); return Math.round(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / DAY); };
/** An estimate in weeks as days on the axis; no estimate draws as two. */
const lenOf = (it: RoadmapItem) => (it.estimate ? Math.max(1, Math.round(it.estimate * 7)) : 2);

/** The bar tone for a board column. A lane the owner added takes the planned tone. */
const TONE: Record<string, string> = { progress: 'progress', review: 'review', shipped: 'shipped' };

type Win = { a: number; z: number };

export function BacklogTimeline({
  boxes, byBox, loose, lists, activeId, zoom, colOf, runnable, onOpen, onWindow,
}: {
  /** Every sprint, finished ones included, in board order. */
  boxes: Sprint[];
  /** Each box's rows in `sprintRank` order, already scoped and searched. */
  byBox: Map<number, RoadmapItem[]>;
  /** The backlog's rows, in the List view's own order. */
  loose: RoadmapItem[];
  lists: BoardList[];
  activeId: number | null;
  zoom: 'week' | 'day';
  colOf: (it: RoadmapItem) => { key: string; name: string };
  runnable: (it: RoadmapItem) => boolean;
  onOpen: (it: RoadmapItem, el: HTMLElement) => void;
  /** Write a sprint's whole window. It resolves once the write has landed or failed. */
  onWindow: (b: Sprint, startsOn: string, endsOn: string) => Promise<void>;
}) {
  const dayW = zoom === 'day' ? 34 : 15;
  const today = todayN();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  // Finished sprints start folded: they are history, and the eye should land on
  // what is live.
  const [shut, setShut] = useState<Set<string>>(
    () => new Set(boxes.filter((b) => b.status === 'done').map((b) => String(b.id))));
  // The window being dragged, drawn locally until the write lands.
  const [drafts, setDrafts] = useState<Record<number, Win>>({});
  const [dragging, setDragging] = useState<number | null>(null);
  const range = useRef<{ start: number; end: number } | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const fit = () => setNarrow(el.clientWidth < 800);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const LW = narrow ? 260 : 340;

  const winOf = (b: Sprint): Win | null => {
    const d = drafts[b.id];
    if (d) return d;
    return b.startsOn && b.endsOn ? { a: d2n(b.startsOn), z: d2n(b.endsOn) } : null;
  };

  // ---- the layout, in day numbers first ----------------------------------
  const dated = boxes.map((b) => ({ b, w: winOf(b) })).filter((x): x is { b: Sprint; w: Win } => !!x.w);
  const lastEnd = dated.length ? Math.max(...dated.map((x) => x.w.z)) : today;
  let maxEnd = Math.max(lastEnd, today);
  const plans = boxes.map((b) => {
    const items = byBox.get(b.id) || [];
    const w = winOf(b);
    let cur = w ? w.a : null;
    const spans = items.map((it) => {
      const a = cur;
      if (cur !== null) { cur += lenOf(it); maxEnd = Math.max(maxEnd, cur); }
      return a;
    });
    return { b, items, w, spans, cur };
  });
  let pc = lastEnd + 1; pc += (7 - wkday(pc)) % 7;
  const pStart = pc;
  const looseSpans = loose.map((it) => { const a = pc; pc += lenOf(it); return a; });
  maxEnd = Math.max(maxEnd, pc);

  if (dragging === null || !range.current) {
    const live = dated.filter((x) => x.b.status !== 'done');
    let start = Math.min(today, ...(live.length ? live : dated).map((x) => x.w.a)) - 7;
    start -= wkday(start);
    let end = maxEnd + 10; end += 6 - wkday(end);
    range.current = { start, end };
  }
  const { start, end } = range.current;
  const X = (n: number) => Math.max(-dayW * 2, (n - start) * dayW);
  const days = end - start + 1;
  const tlW = days * dayW;
  const todayX = LW + X(today) + dayW / 2;

  // Scroll today into view on open and on a change of scale, never otherwise:
  // a refresh must not yank the reader back from wherever they had scrolled.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, todayX - LW - (el.clientWidth - LW) * 0.3);
  }, [zoom, LW]);

  // Once the server's answer is in the payload, the local draft has done its job.
  useEffect(() => {
    if (dragging !== null) return;
    setDrafts((d) => {
      const next = { ...d };
      let changed = false;
      for (const b of boxes) {
        const w = next[b.id];
        if (w && b.startsOn && b.endsOn && d2n(b.startsOn) === w.a && d2n(b.endsOn) === w.z) {
          delete next[b.id]; changed = true;
        }
      }
      return changed ? next : d;
    });
  }, [boxes, dragging]);

  // ---- the drags -----------------------------------------------------------
  const commit = (b: Sprint, w: Win) => {
    const was = b.startsOn && b.endsOn ? { a: d2n(b.startsOn), z: d2n(b.endsOn) } : null;
    if (was && was.a === w.a && was.z === w.z) {
      setDrafts((d) => { const n = { ...d }; delete n[b.id]; return n; });
      return;
    }
    onWindow(b, n2d(w.a), n2d(w.z)).finally(() => {
      // A failed write leaves the payload as it was. Dropping the draft puts
      // the bar back where the server says it is.
      setDrafts((d) => {
        const cur = d[b.id];
        if (!cur || cur.a !== w.a || cur.z !== w.z) return d;
        const n = { ...d }; delete n[b.id]; return n;
      });
    });
  };

  const track = (b: Sprint, at: (ev: PointerEvent) => Win) => {
    let last: Win | null = null;
    setDragging(b.id);
    const move = (ev: PointerEvent) => {
      last = at(ev);
      const w = last;
      setDrafts((d) => ({ ...d, [b.id]: w }));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const w = last || at(ev);
      setDrafts((d) => ({ ...d, [b.id]: w }));
      setDragging(null);
      commit(b, w);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startMove = (e: React.PointerEvent, b: Sprint, mode: 'move' | 'l' | 'r') => {
    if (e.button !== 0) return;
    const w0 = winOf(b);
    if (!w0) return;
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX;
    track(b, (ev) => {
      const dd = Math.round((ev.clientX - sx) / dayW);
      if (mode === 'move') return { a: w0.a + dd, z: w0.z + dd };
      if (mode === 'l') return { a: Math.min(w0.z, w0.a + dd), z: w0.z };
      return { a: w0.a, z: Math.max(w0.a, w0.z + dd) };
    });
  };

  const startCreate = (e: React.PointerEvent<HTMLDivElement>, b: Sprint) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const left = e.currentTarget.getBoundingClientRect().left;
    const dayAt = (x: number) => start + Math.floor((x - left) / dayW);
    const n0 = dayAt(e.clientX);
    setDrafts((d) => ({ ...d, [b.id]: { a: n0, z: n0 } }));
    track(b, (ev) => {
      const n = dayAt(ev.clientX);
      if (ev.type === 'pointerup' && n === n0) return { a: n0, z: n0 + 11 };
      return { a: Math.min(n0, n), z: Math.max(n0, n) };
    });
  };

  const toggle = (key: string) => setShut((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  // ---- the axis ------------------------------------------------------------
  const weeks = useMemo(() => {
    const out: { n: number; x: number; w: number; label: string }[] = [];
    for (let n = start; n <= end; n += 7) out.push({ n, x: (n - start) * dayW, w: 7 * dayW, label: fmtD(n) });
    return out;
  }, [start, end, dayW]);
  const dayTicks = zoom === 'day'
    ? Array.from({ length: days }, (_, i) => {
      const n = start + i;
      return { n, x: i * dayW, label: String(new Date(n * DAY).getUTCDate()), tone: n === today ? 'today' : wkday(n) >= 5 ? 'we' : '' };
    })
    : [];
  const grid: React.CSSProperties = {
    width: tlW,
    backgroundImage: zoom === 'day'
      ? `repeating-linear-gradient(90deg, transparent 0 ${5 * dayW}px, var(--km-tl-weekend) ${5 * dayW}px ${7 * dayW}px), repeating-linear-gradient(90deg, var(--border-subtle) 0 1px, transparent 1px ${7 * dayW}px)`
      : `repeating-linear-gradient(90deg, var(--border-subtle) 0 1px, transparent 1px ${7 * dayW}px)`,
  };

  const census = (items: RoadmapItem[]) => lists.map((l) => {
    const n = items.filter((it) => colOf(it).key === l.key).length;
    return { key: l.key, name: l.name, n };
  });

  const lastDated = [...dated].sort((x, y) => y.w.z - x.w.z)[0];
  const nameOf = (key: string, fallback: string) => lists.find((l) => l.key === key)?.name || fallback;

  // ---- one item row --------------------------------------------------------
  const row = (it: RoadmapItem, i: number, a: number | null, b: Sprint | null, w: Win | null, projected: boolean) => {
    const pri = priorityMeta(it.bucket);
    const col = colOf(it);
    const tone = TONE[col.key] || 'planned';
    const len = lenOf(it);
    const e = a === null ? 0 : a + len;
    const sEnd = w ? w.z + 1 : null;
    const over = a !== null && sEnd !== null && e > sEnd && !it.done;
    const bx = a === null ? 0 : X(a) + 1;
    const bw = a === null ? 0 : X(e) - X(a) - 3;
    const runs = !!b && b.id === activeId && runnable(it);
    const label = bw > 170 ? `#${it.id}  ${it.title}` : bw > 44 ? `#${it.id}` : '';
    const tip = a === null
      ? `#${it.id} ${it.title}`
      : `#${it.id} ${it.title}\n${fmtD(a)} → ${fmtD(e - 1)}${projected ? ' (projected)' : ''} · ${it.estimate ? `${it.estimate}w estimate` : 'no estimate, drawn as 2 days'}${over ? '\nRuns past the end of the sprint' : ''}`;
    const open = (ev: React.MouseEvent<HTMLElement>) => { ev.stopPropagation(); onOpen(it, ev.currentTarget); };
    return (
      <div key={it.id} className="km-tl-row" data-hl={it.id}>
        <div className={`km-tl-lab${runs ? ' runs' : ''}`} style={{ width: LW }} onDoubleClick={open}>
          <span className="rank" title={b ? `${i + 1} in this sprint — the runner works top down` : ''}>{i + 1}</span>
          <span className="id">#{it.id}</span>
          <span className="t" title={it.title}>{it.title}</span>
          <span className="est" title="Estimate, in weeks">{it.estimate !== null ? `${it.estimate}w` : '–'}</span>
          <span className="pri" style={{ color: pri.color }} title={`Priority — ${pri.label}`}>{pri.glyph}</span>
        </div>
        <div className="km-tl-track" style={grid}>
          {a === null ? (
            <span className="km-tl-nobar">Not on the timeline until the sprint has dates</span>
          ) : <>
            <div className={`km-tl-bar t-${tone}${it.estimate ? '' : ' guess'}${projected ? ' proj' : ''}`}
              style={{ left: bx, width: Math.max(4, bw) }} title={tip} onDoubleClick={open}>
              {label}
            </div>
            {over && sEnd !== null && (
              <div className="km-tl-overrun" aria-hidden="true" style={{ left: X(sEnd), width: Math.max(2, X(e) - X(sEnd) - 2) }} />
            )}
          </>}
        </div>
      </div>
    );
  };

  const laneHead = (key: string, name: string, items: RoadmapItem[], opts: { active?: boolean; done?: boolean }, track: React.ReactNode) => {
    const isOpen = !shut.has(key);
    return (
      <div className={`km-tl-head${opts.active ? ' on' : ''}${opts.done ? ' done' : ''}`}>
        <div className="km-tl-lab" style={{ width: LW }}>
          <button className="fold" onClick={() => toggle(key)} aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Fold' : 'Unfold'} ${name}`}>
            <KitIcon name={isOpen ? 'chevron-down' : 'chevron-right'} size={14} />
          </button>
          {opts.active && <span className="km-live" title="In progress — the planner works on this sprint" />}
          <span className="nm">{name}</span>
          <span className="n">{items.length} item{items.length === 1 ? '' : 's'}</span>
          {lists.length > 0 && (
            <span className="km-squares">
              {census(items).map((c) => (
                <span key={c.key} className={`sq${c.n ? '' : ' zero'}`} title={`${c.n} in ${c.name}`}>{c.n}</span>
              ))}
            </span>
          )}
        </div>
        <div className="km-tl-track" style={grid}>{track}</div>
      </div>
    );
  };

  return (
    <>
      <div className="km-tl" ref={scrollRef}>
        <div className="km-tl-inner" style={{ width: LW + tlW }}>
          <div className={`km-tl-axis${zoom === 'day' ? ' days' : ''}`}>
            <div className="km-tl-lab corner" style={{ width: LW }}>Sprint · item</div>
            <div className="km-tl-track" style={{ width: tlW }}>
              {weeks.map((w) => <span key={w.n} className="wk" style={{ left: w.x, width: w.w }}>{w.label}</span>)}
              {dayTicks.map((d) => <span key={d.n} className={`dy ${d.tone}`} style={{ left: d.x, width: dayW }}>{d.label}</span>)}
            </div>
          </div>

          {plans.map(({ b, items, w, spans, cur }) => {
            const key = String(b.id);
            const active = b.id === activeId;
            const done = b.status === 'done';
            const overDays = w && cur !== null ? Math.max(0, cur - (w.z + 1)) : 0;
            const hw = w ? X(w.z + 1) - X(w.a) - 2 : 0;
            const when = w ? `${fmtD(w.a)} – ${fmtD(w.z)}` : '';
            const track = w ? <>
              <div className={`km-tl-win${active ? ' on' : ''}${done ? ' done' : ''}${dragging === b.id ? ' drag' : ''}`}
                // A window that starts before the axis is clamped under the
                // sticky label column, so its text starts at the visible edge.
                style={{ left: X(w.a) + 1, width: Math.max(10, hw), paddingLeft: 12 + Math.max(0, -X(w.a)) }}
                onPointerDown={(e) => startMove(e, b, 'move')}
                title={`${b.name} · ${when}\nDrag to move this sprint · drag an edge to change its dates`}>
                {hw > 150 ? `${b.name} · ${when}` : hw > 70 ? b.name : ''}
                <span className="edge l" onPointerDown={(e) => startMove(e, b, 'l')} />
                <span className="edge r" onPointerDown={(e) => startMove(e, b, 'r')} />
              </div>
              {overDays > 0 && (
                <span className="km-tl-over" style={{ left: X(w.a) + 1 + Math.max(10, hw) + 8 }}
                  title={`Its items, laid end to end by estimate, run ${overDays} day${overDays === 1 ? '' : 's'} past the sprint's end`}>
                  {overDays} day{overDays === 1 ? '' : 's'} over
                </span>
              )}
            </> : (
              <div className="km-tl-create" onPointerDown={(e) => startCreate(e, b)}
                title="Drag across the timeline to give this sprint a window — a click makes it twelve days">
                <span className="hint" style={{ left: X(Math.max(today, lastEnd + 3)) }}>
                  <KitIcon name="calendar" size={12} />Undated — drag across the timeline to set its window
                </span>
              </div>
            );
            return (
              <div key={key} className="km-tl-lane">
                {laneHead(key, b.name, items, { active, done }, track)}
                {!shut.has(key) && (items.length === 0 ? (
                  <div className="km-tl-row">
                    <div className="km-tl-lab empty" style={{ width: LW }}>Empty — drag work in from the List view</div>
                    <div className="km-tl-track" style={grid} />
                  </div>
                ) : items.map((it, i) => row(it, i, spans[i], b, w, false)))}
              </div>
            );
          })}

          <div className="km-tl-lane">
            {laneHead('loose', 'Backlog', loose, {}, (
              <span className="km-tl-proj" style={{ left: X(pStart) }}>
                {lastDated ? `Projected after ${lastDated.b.name} — not committed` : 'Projected — not committed'}
              </span>
            ))}
            {!shut.has('loose') && (loose.length === 0 ? (
              <div className="km-tl-row">
                <div className="km-tl-lab empty" style={{ width: LW }}>Everything is in a sprint or done.</div>
                <div className="km-tl-track" style={grid} />
              </div>
            ) : loose.map((it, i) => row(it, i, looseSpans[i], null, null, true)))}
          </div>

          <div className="km-tl-today" aria-hidden="true" style={{ left: todayX }}>
            <span>Today · {fmtD(today)}</span>
          </div>
        </div>
      </div>

      <div className="km-tl-legend">
        <span><i className="t-progress" />{nameOf('progress', 'In Progress')}</span>
        <span><i className="t-review" />{nameOf('review', 'In Review')}</span>
        <span><i className="t-shipped" />{nameOf('shipped', 'Done')}</span>
        <span><i className="guess" />No estimate (2 days) or projected</span>
        <span><i className="hatch" />Past the sprint's end</span>
        <span className="right">Bars run end to end by rank and estimate · double-click one to open it</span>
      </div>
    </>
  );
}
