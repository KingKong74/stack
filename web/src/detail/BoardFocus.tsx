// THE FOCUS CANVAS — a board card opened in place (Claude Design project
// "Board", 2026-11-01). Double-click a card and the board steps back: the card
// flies to a dotted canvas, and the work it is tied to draws in around it —
// its CHILDREN and its PARENT (`parent_id`, real rows on the server) and
// anything you pulled in as RELATED. Esc or ← Board flies it home.
//
// FIVE DECISIONS WORTH THE INK:
//
//  1. THE FLIGHT IS A FLIP. The card is drawn at its canvas spot (hidden),
//     measured, inverted back onto the board card with a transform, then the
//     transform is released. Going home re-reads where the board card is NOW,
//     because the editor may have moved it to another column.
//  2. EVERY EDIT IS AN ORDINARY WRITE. Column is the board's own drop write
//     (`list_key`), and title, notes, priority, points, kind, due and area
//     are the same PATCHes the card controls and the item modal send. The
//     canvas owns no copy of the row; Board.tsx's `rows` is the truth.
//  3. CHILD IS A FACT, RELATED IS A NOTE. A child is `parent_id`, one level
//     deep: the server refuses a parent that is itself a child, so a focused
//     child offers no "Add part" and no Part button. Related links and
//     node positions are how you like to look at the work, so they live on
//     this device (store.ts getFocusCanvas), never on the row.
//  4. UNLINKING NEVER DELETES. Unfiling a child detaches it and it stays on
//     the board; taking a related node off only forgets the link.
//  5. REDUCED MOTION GETS NO FLIGHT. Every duration goes through `ms`, which
//     collapses to zero, so the canvas simply appears.
//  6. A SLICE OPENS HERE TOO (owner's call, 2026-11-09). `open.sliceId` puts
//     the SLICE in the middle with its tasks drawn in as its parts, on the same
//     flight. A task in a slice is never zoomed on its own: double-clicking
//     one on the board opens its slice with that task in the editor. In slice
//     mode "Part" means filed into the slice (`sliceId`), a part is never
//     unfiled from here (that would ice it), and ✎ on the slice opens the
//     slice's own dialog.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { KitIcon } from './kit/KitIcon';
import type { ItemKind, Priority, RoadmapItem, Slice, Sprint } from '../types';
import { listKeyOf, isBoardWork, isBuilt } from '../lib/plan';
import { isHeld } from '../lib/approval';
import { PRIORITY_META, priorityMeta, dueRead, ITEM_KIND_LABEL } from '../lib/ui';
import { getFocusCanvas, setFocusCanvas, type FocusCanvas } from '../store';

/** What Board.tsx hands over when a card is opened. */
export interface FocusOpen {
  id: number;
  /** The board card's rect at the moment it was opened. */
  from: { l: number; t: number; w: number };
  /** Open with the editor already showing (the card's ✎). */
  edit: boolean;
  /** #601 — the row the editor starts on, when it is one of the focused
   *  cluster's parts rather than the cluster itself. */
  editId?: number;
  /** Where the canvas starts: the console's main column, so the rail stays. */
  canvasLeft: number;
  /** Slice mode (decision 6): the slice in the middle. `id` is then -sliceId,
   *  a key for this device's canvas state and never a row. */
  sliceId?: number;
  /** Where to fly home to when `[data-hl=id]` finds nothing (a slice head). */
  home?: string;
}
export type FocusPhase = 'measure' | 'from' | 'to' | 'back';
type Patch = Partial<{
  title: string; note: string; bucket: Priority; points: number | null; kind: ItemKind;
  dueOn: string | null; area: string; parentId: number | null; sliceId: number | null;
}>;

const DUR = 620;            // the card's flight, in ms (the design's default)
const POINTS: (number | null)[] = [null, 1, 2, 3, 5, 8, 13];
const PORT = 26;            // where a connector meets a card, from its top
const NW = 260;             // a linked node's width
const GAP = 118;            // the lane's row pitch
// The four kit columns carry the board's status tones; any column the owner
// added reads neutral, because a colour nobody chose would claim a meaning.
const COL_TONE: Record<string, string> = {
  planned: 'var(--status-neutral-fg)', progress: 'var(--status-info-fg)',
  review: 'var(--status-warning-fg)', shipped: 'var(--status-success-fg)',
};
const UNTAGGED = ' untagged';

const reduced = () => typeof window !== 'undefined'
  && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const topbarH = () => {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h'));
  return Number.isFinite(v) ? v : 48;
};

export function BoardFocus({
  slug, open, rows, columns, colOf, areas, sprintOf, phase, onPhase, onClosed,
  onPatch, onMove, onCreateChild, slices = [], onEditSlice, onCreateInSlice,
}: {
  slug: string;
  slices?: Slice[];
  onEditSlice?: (s: Slice) => void;
  onCreateInSlice?: (s: Slice, title: string) => Promise<RoadmapItem | undefined>;
  open: FocusOpen;
  rows: RoadmapItem[];
  /** The board's columns, in order (catch-all excluded). */
  columns: { key: string; name: string }[];
  /** The column a row is drawn in, by the board's own rule. */
  colOf: (it: RoadmapItem) => string;
  areas: { name: string; dot: string }[];
  sprintOf: (it: RoadmapItem) => Sprint | null;
  phase: FocusPhase;
  onPhase: (p: FocusPhase) => void;
  /** The flight home has landed: unmount. */
  onClosed: () => void;
  onPatch: (it: RoadmapItem, patch: Patch) => Promise<void> | void;
  onMove: (it: RoadmapItem, key: string) => Promise<void> | void;
  onCreateChild: (parent: RoadmapItem, title: string) => Promise<RoadmapItem | undefined>;
}) {
  const still = useMemo(reduced, []);
  const ms = (n: number) => (still ? 0 : Math.round(n));
  const D = ms(DUR);

  // Decision 6: in slice mode the focus is a stand-in row for the slice, so
  // the flight, the lane and the tray run unchanged around it.
  const slice = open.sliceId != null ? slices.find((x) => x.id === open.sliceId) || null : null;
  const sliceRow = useMemo(() => (slice ? ({
    id: open.id, title: slice.title, note: slice.spec, area: '', parentId: null, archived: false, done: false,
    bucket: 'medium', points: null, kind: '', dueOn: null, claimedBy: '', skipped: false, sliceId: slice.id,
  } as unknown as RoadmapItem) : null), [slice, open.id]);
  const focusItem = slice ? sliceRow : rows.find((x) => x.id === open.id) || null;
  const areaKey = (it: RoadmapItem) => it.area.trim() || UNTAGGED;
  const dotOf = (k: string) => areas.find((a) => a.name === k)?.dot || '';
  const colName = (k: string) => columns.find((c) => c.key === k)?.name || 'No column';

  // ---- geometry, fixed at open ----
  const geo = useMemo(() => {
    const top0 = topbarH();
    const canvasW = window.innerWidth - open.canvasLeft;
    const narrow = canvasW < 880;
    const trayW = narrow ? 280 : 300;
    const avail = canvasW - (narrow ? 0 : trayW + 24) - 24;
    const w = Math.round(Math.min(400, Math.max(260, avail * 0.36)));
    const off = Math.round(Math.max(24, Math.min(Math.max(56, canvasW * 0.14), avail - w - 72 - 260)));
    return { top0, canvasW, narrow, trayW, l: open.canvasLeft + off, w };
  }, [open]);
  const [targetT, setTargetT] = useState(open.from.t);
  const [from, setFrom] = useState(open.from);
  const [fh, setFh] = useState(120);
  const floatRef = useRef<HTMLDivElement | null>(null);

  // ---- canvas state ----
  const [canvas, setCanvas] = useState<FocusCanvas>(() => getFocusCanvas(slug, open.id));
  const writeCanvas = (next: FocusCanvas) => { setCanvas(next); setFocusCanvas(slug, open.id, next); };
  const [editOpen, setEditOpen] = useState(open.edit && !(open.sliceId != null && open.editId == null));
  // #601 — WHICH ROW THE EDITOR IS ON. The focused card by default; a part
  // (clicked on the board's cluster card, or double-clicked here) takes it
  // over, so a part gets every field a card has without a card of its own.
  const [editId, setEditId] = useState(open.editId ?? open.id);
  const editOn = (id: number) => {
    if (slice && id === open.id) { onEditSlice?.(slice); return; }
    if (editOpen && editId === id) { setEditOpen(false); setEditId(open.id); return; }
    setEditId(id); setEditOpen(true);
  };
  const [trayOpen, setTrayOpen] = useState(false);
  const [trayScope, setTrayScope] = useState<'area' | 'all'>('area');
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [dragNode, setDragNode] = useState<number | null>(null);
  const [entering, setEntering] = useState<number[]>([]);
  const fresh = useRef(new Set<number>());
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // MEASURE → FROM → TO. The card renders hidden at its canvas spot, its height
  // fixes where it sits vertically, then it is inverted onto the board card and
  // released two frames later so the browser has painted the inverted state.
  useLayoutEffect(() => {
    if (phase !== 'measure' || !floatRef.current) return;
    const h = floatRef.current.offsetHeight;
    setFh(h);
    setTargetT(Math.round(geo.top0 + (window.innerHeight - geo.top0) / 2 - h / 2));
    onPhase('from');
  }, [phase]);
  useEffect(() => {
    if (phase !== 'from') return;
    let r2 = 0;
    const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => onPhase('to')); });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  }, [phase]);
  // The card's height changes as the editor writes (a tag, a longer title);
  // the lane's stacked layout reads it.
  useLayoutEffect(() => {
    const h = floatRef.current?.offsetHeight;
    if (phase === 'to' && h && h !== fh) setFh(h);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const close = () => {
    if (phase === 'back' || phase === 'measure') return;
    // Home is wherever the board card is NOW — the editor may have moved it.
    // A part has no card of its own, so it flies home into its cluster.
    const el = (open.home ? document.querySelector(open.home) : null)
      || document.querySelector(`.km-cols [data-hl="${open.id}"]`)
      || (focusItem?.parentId != null ? document.querySelector(`.km-cols [data-hl="${focusItem.parentId}"]`) : null);
    if (el) { const r = el.getBoundingClientRect(); setFrom({ l: r.left, t: r.top, w: r.width }); }
    setComposing(false); setDraft('');
    fresh.current.clear();
    onPhase('back');
    clearTimeout(timer.current);
    timer.current = setTimeout(onClosed, D + 80);
  };
  // A card deleted out from under the canvas closes it at once.
  useEffect(() => { if (!focusItem) onClosed(); }, [focusItem]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A dialog over the canvas (the slice's ✎) takes its own Escape.
      if (document.querySelector('.km-scrim')) return;
      if (composing) { setComposing(false); setDraft(''); return; }
      if (editOpen) { setEditOpen(false); setEditId(open.id); return; }
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // A node brought in starts hidden and is released two frames later, so it
  // animates in on its own rather than with the opening stagger.
  const enter = (id: number) => {
    fresh.current.add(id);
    setEntering((e) => [...e, id]);
    requestAnimationFrame(() => requestAnimationFrame(() => setEntering((e) => e.filter((x) => x !== id))));
  };

  if (!focusItem) return null;
  const f = focusItem;
  const ed = rows.find((x) => x.id === editId) || f;
  const live = phase === 'to';
  const kidsOf = (id: number) => rows.filter((x) => x.parentId === id && !x.archived);
  // A slice's parts are its top-level tasks; a cluster inside it keeps its
  // own parts, which draw inside it on the board.
  const kids = slice
    ? rows.filter((x) => x.sliceId === slice.id && !x.archived
      && (x.parentId === null || !rows.some((p) => p.id === x.parentId && p.sliceId === slice.id)))
    : kidsOf(f.id);
  const parent = f.parentId !== null ? rows.find((x) => x.id === f.parentId) || null : null;
  const related = canvas.related
    .map((id) => rows.find((x) => x.id === id))
    .filter((x): x is RoadmapItem => !!x && !x.archived && x.parentId !== f.id && x.id !== f.parentId);
  // ONE LEVEL DEEP (decision 3): only a top-level card can take children.
  const canParent = f.parentId === null;

  const bringIn = async (x: RoadmapItem, rel: 'child' | 'related') => {
    if (rel === 'child') {
      writeCanvas({ ...canvas, related: canvas.related.filter((r) => r !== x.id) });
      enter(x.id);
      await onPatch(x, slice ? { sliceId: slice.id } : { parentId: f.id });
    } else {
      writeCanvas({ ...canvas, related: [...canvas.related.filter((r) => r !== x.id), x.id] });
      enter(x.id);
    }
  };
  const unlink = (x: RoadmapItem, rel: 'child' | 'related' | 'parent') => {
    const pos = { ...canvas.pos }; delete pos[x.id];
    writeCanvas({ related: canvas.related.filter((r) => r !== x.id), pos });
    if (rel === 'child') onPatch(x, { parentId: null });
    if (rel === 'parent') onPatch(f, { parentId: null });
  };
  const addChild = async (title: string) => {
    const t = title.trim();
    if (!t) { setComposing(false); setDraft(''); return; }
    setDraft('');
    const made = slice ? await onCreateInSlice?.(slice, t) : await onCreateChild(f, t);
    if (made) enter(made.id);
  };
  const startNodeDrag = (e: React.PointerEvent, id: number, x: number, y: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input')) return;
    e.stopPropagation(); e.preventDefault();
    const sx = e.clientX; const sy = e.clientY;
    let last = canvas;
    setDragNode(id);
    const move = (ev: PointerEvent) => {
      last = { ...last, pos: { ...last.pos, [id]: { x: Math.round(x + ev.clientX - sx), y: Math.round(y + ev.clientY - sy) } } };
      setCanvas(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setDragNode(null);
      setFocusCanvas(slug, open.id, last);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  // ---- the flight ----
  const inv = `translate(${from.l - geo.l}px, ${from.t - targetT}px) scale(${from.w / geo.w})`;
  const fcTransition = phase === 'to'
    ? `transform ${D}ms var(--ease-out), box-shadow ${D}ms var(--ease-out)`
    : phase === 'back' ? `transform ${ms(DUR * 0.85)}ms var(--ease-standard), box-shadow ${D}ms var(--ease-standard)` : 'none';

  // ---- the graph (the design's layout, verbatim in shape) ----
  const canvasW = geo.canvasW;
  const fx = geo.l - open.canvasLeft; const fy = targetT - geo.top0; const fw = geo.w;
  const lane = [...kids.map((it) => ({ it, rel: 'child' as const })), ...related.map((it) => ({ it, rel: 'related' as const }))];
  const trayLeft = geo.narrow ? canvasW : canvasW - 24 - geo.trayW;
  const PW = geo.narrow ? 280 : 340;
  const limit = (geo.narrow ? canvasW : trayLeft) - 24;
  const want = fx + fw + (editOpen ? 16 + PW : 0) + 48 + NW;
  const shift = editOpen ? Math.max(0, Math.min(fx - 24, want - limit)) : 0;
  const fxE = fx - shift;
  const edgeX = editOpen ? fxE + fw + 16 + PW : fxE + fw;
  const stacked = edgeX + 48 + NW > limit;
  const colX = stacked ? fxE + 32 : Math.max(edgeX + 48, Math.min(edgeX + 130, limit - NW));
  // No room for card + editor + lane side by side: the lane steps back while editing.
  const laneAway = stacked && editOpen;
  const y0 = stacked ? fy + fh + 40 : Math.max(84, fy - (lane.length * GAP) / 2);
  const base = ms(D * 0.85);
  const curveH = (sx: number, sy: number, ex: number, ey: number) => {
    const dx = Math.max(48, (ex - sx) / 2);
    return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`;
  };
  const curve = (sx0: number, sy0: number, ex: number, ey: number) => {
    if (stacked) { const sx = fxE + 16; const sy = fy + fh; return `M ${sx} ${sy} C ${sx} ${ey}, ${ex - 24} ${ey}, ${ex} ${ey}`; }
    return curveH(sx0, sy0, ex, ey);
  };
  type Rel = 'child' | 'related' | 'parent';
  const mk = (it: RoadmapItem, rel: Rel, dx: number, dy: number, k: number) => {
    const p = canvas.pos[it.id] || { x: Math.round(dx), y: Math.round(dy) };
    const isFresh = fresh.current.has(it.id);
    const shown = live && !entering.includes(it.id) && !(laneAway && rel !== 'parent');
    const delay = isFresh ? 0 : base + ms(k * 70);
    return { it, rel, x: p.x, y: p.y, shown, delay, w: stacked && rel !== 'parent' ? Math.max(200, fw - 32) : NW };
  };
  const nodes = lane.map((l, k) => mk(l.it, l.rel, colX, y0 + k * GAP, k));
  if (parent) nodes.push(mk(parent, 'parent', fxE, Math.max(84, fy - 150), 0));
  const childLinks: { d: string; offset: number; transition: string }[] = [];
  const relLinks: { d: string; opacity: number; transition: string }[] = [];
  const ports: { x: number; y: number; hidden?: boolean; focus?: boolean }[] = [];
  for (const n of nodes) {
    const lineT = n.shown ? `stroke-dashoffset ${ms(560)}ms var(--ease-out) ${n.delay + ms(80)}ms` : `stroke-dashoffset ${ms(180)}ms var(--ease-standard)`;
    if (n.rel === 'parent') {
      const sx = n.x; const sy = n.y + PORT; const ex = fxE; const ey = fy + PORT;
      childLinks.push({ d: `M ${sx} ${sy} C ${sx - 72} ${sy}, ${ex - 72} ${ey}, ${ex} ${ey}`, offset: n.shown ? 0 : 1, transition: lineT });
      ports.push({ x: sx, y: sy }, { x: ex, y: ey, focus: true });
    } else if (n.rel === 'child') {
      childLinks.push({ d: curve(edgeX, fy + PORT, n.x, n.y + PORT), offset: n.shown ? 0 : 1, transition: lineT });
      ports.push({ x: n.x, y: n.y + PORT, hidden: !n.shown });
    } else {
      relLinks.push({ d: curve(edgeX, fy + PORT, n.x, n.y + PORT), opacity: n.shown ? 1 : 0,
        transition: n.shown ? `opacity ${ms(360)}ms var(--ease-out) ${n.delay + ms(80)}ms` : `opacity ${ms(160)}ms var(--ease-standard)` });
      ports.push({ x: n.x, y: n.y + PORT, hidden: !n.shown });
    }
  }
  if (lane.length && !laneAway) {
    if (stacked) ports.push({ x: fxE + 16, y: fy + fh, focus: true });
    else ports.push({ x: edgeX, y: fy + PORT, focus: !editOpen });
  }
  const portStyle = (p: { hidden?: boolean }) => ({
    opacity: live && p.hidden !== true ? 1 : 0,
    transition: live ? `opacity ${ms(240)}ms var(--ease-out) ${base}ms` : `opacity ${ms(120)}ms var(--ease-standard)`,
  });
  const ghostOn = live && !laneAway && canParent;
  const gk = lane.length;

  // ---- the tray ----
  const onCanvas = new Map(nodes.map((n) => [n.it.id, n.rel]));
  const fArea = areaKey(f);
  const order = (x: RoadmapItem) => { const i = columns.findIndex((c) => c.key === colOf(x)); return i < 0 ? 99 : i; };
  // Slice mode: the near scope is work in no slice yet, the work you would file.
  const near = (x: RoadmapItem) => (slice ? x.sliceId === null : areaKey(x) === fArea);
  const scoped = rows
    .filter((x) => x.id !== f.id && !x.archived && isBoardWork(x) && (!slice || x.sliceId !== slice.id)
      && (trayScope === 'all' || near(x)))
    .sort((a, b) => order(a) - order(b) || b.id - a.id);
  const trayOn = live && (!geo.narrow || trayOpen);
  const edOn = live && editOpen;
  const cvOn = live;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <>
      <div className="bf" style={{
        left: open.canvasLeft, opacity: cvOn ? 1 : 0,
        transition: cvOn ? `opacity ${ms(D * 0.7)}ms var(--ease-standard) ${ms(D * 0.22)}ms`
          : phase === 'back' ? `opacity ${ms(D * 0.6)}ms var(--ease-standard)` : 'none',
      }} onClick={close}>
        <div className="bf-chrome" onClick={stop} style={{
          opacity: cvOn ? 1 : 0, transform: cvOn ? 'none' : 'translateY(-6px)',
          transition: cvOn
            ? `opacity ${ms(D * 0.5)}ms var(--ease-out) ${ms(D * 0.7)}ms, transform ${ms(D * 0.5)}ms var(--ease-out) ${ms(D * 0.7)}ms`
            : `opacity ${ms(D * 0.25)}ms var(--ease-standard)`,
        }}>
          <button className="k-btn sm secondary bf-back" onClick={close}>
            <KitIcon name="chevron-left" size={14} />Board
          </button>
          <span className="bf-crumb">
            <span>{slug} /</span>
            <span className="id">{slice ? 'Slice' : `#${f.id}`}</span>
          </span>
          {geo.narrow && (
            <button className={`k-btn sm secondary${trayOpen ? ' on' : ''}`} onClick={() => setTrayOpen(!trayOpen)}>
              <KitIcon name="plus" size={14} />{trayOpen ? 'Hide bring in' : 'Bring in'}
            </button>
          )}
          <span className="bf-esc"><kbd>Esc</kbd>back to the board</span>
        </div>

        <svg className="bf-lines" aria-hidden="true">
          {childLinks.map((ln, i) => (
            <path key={`c${i}`} d={ln.d} className="child" pathLength={1} strokeDasharray="1 1"
              strokeDashoffset={ln.offset} style={{ transition: ln.transition }} />
          ))}
          {relLinks.map((ln, i) => (
            <path key={`r${i}`} d={ln.d} className="rel" strokeDasharray="3 5"
              style={{ opacity: ln.opacity, transition: ln.transition }} />
          ))}
        </svg>

        {nodes.map((n) => {
          const it = n.it;
          const dragging = dragNode === it.id;
          const pri = priorityMeta(it.bucket);
          const tint = dotOf(areaKey(it));
          const pts = it.points ?? null;
          const kind = (it.kind ?? '') as ItemKind;
          const ck = colOf(it);
          return (
            <div key={`${n.rel}-${it.id}`} className={`bf-node${dragging ? ' dragging' : ''}${editOpen && editId === it.id ? ' editing' : ''}`}
              onPointerDown={(e) => startNodeDrag(e, it.id, n.x, n.y)} onClick={stop}
              onDoubleClick={(e) => { e.stopPropagation(); if (live && n.rel === 'child') editOn(it.id); }}
              title={n.rel === 'child' ? `Double-click to edit this ${slice ? 'task' : 'part'}` : undefined}
              style={{
                left: n.x, top: n.y, width: n.w, pointerEvents: n.shown ? 'auto' : 'none',
                ...(tint ? { borderTopColor: `color-mix(in oklch, ${tint} 70%, var(--surface-card))`, borderTopWidth: 2 } : {}),
                opacity: n.shown ? 1 : 0,
                transform: n.shown ? (dragging ? 'scale(1.02)' : 'none') : 'translateX(-14px) scale(0.97)',
                transition: dragging ? `transform ${ms(150)}ms var(--ease-out), box-shadow ${ms(150)}ms var(--ease-out)`
                  : n.shown ? `opacity ${ms(360)}ms var(--ease-out) ${n.delay}ms, transform ${ms(460)}ms var(--ease-out) ${n.delay}ms, left ${ms(420)}ms var(--ease-out), top ${ms(420)}ms var(--ease-out), box-shadow var(--dur-normal) var(--ease-out)`
                  : `opacity ${ms(160)}ms var(--ease-standard), transform ${ms(160)}ms var(--ease-standard)`,
              }}>
              <div className="row">
                <span className={`rel${n.rel === 'related' ? '' : ' strong'}`}>
                  {n.rel === 'child' ? (slice ? 'Task' : 'Part') : n.rel === 'parent' ? 'Cluster' : 'Related'}
                </span>
                <span className="col" style={{ color: COL_TONE[ck] || 'var(--status-neutral-fg)' }}>{colName(ck)}</span>
                {!(slice && n.rel === 'child') && <button className="bf-x" onClick={(e) => { e.stopPropagation(); unlink(it, n.rel); }}
                  aria-label={n.rel === 'child' ? `Unfile #${it.id} — it stays on the board` : n.rel === 'parent' ? `Detach from #${it.id}` : `Take #${it.id} off the canvas`}
                  title={n.rel === 'child' ? `Unfile #${it.id} — it stays on the board` : n.rel === 'parent' ? `Detach from #${it.id}` : `Take #${it.id} off the canvas`}>
                  <KitIcon name="x" size={12} />
                </button>}
              </div>
              <span className="t">{it.title}</span>
              <div className="row">
                <span className="id">#{it.id}</span>
                <span className={`bf-pts${pts === null ? ' none' : ''}`}>{pts === null ? '–' : pts}</span>
                {kind && <span className={`k-tag km-kind ${kind}`}>{ITEM_KIND_LABEL[kind]}</span>}
                <span className="right">
                  {n.rel === 'related' && canParent && (slice ? it.parentId === null : kidsOf(it.id).length === 0) && (
                    <button className="bf-mini" title={slice ? 'File this into the slice' : 'File this under the focused item as a child'}
                      onClick={(e) => { e.stopPropagation(); bringIn(it, 'child'); }}>Make part</button>
                  )}
                  <span className="bf-pri" style={{ color: pri.color }}>{pri.glyph}</span>
                </span>
              </div>
            </div>
          );
        })}

        <svg className="bf-lines" aria-hidden="true">
          {ports.filter((p) => !p.focus).map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={4} className="bf-port" style={portStyle(p)} />
          ))}
        </svg>

        {laneAway && lane.length > 0 && (
          <span className="bf-lanenote" style={{ left: fxE, top: fy + fh + 16 }}>
            {lane.length} linked item{lane.length === 1 ? '' : 's'} hidden while editing
          </span>
        )}

        {editOpen && !(slice && ed === f) && (
          <FocusEditor key={ed.id} item={ed} isPart={ed.id !== f.id} leadless={!!slice}
            family={slice ? kids : kids.length ? [f, ...kids] : []} onSwitch={(id) => setEditId(id)}
            x={fxE + fw + 16} y={Math.max(84, fy - 8)} w={PW} on={edOn} ms={ms}
            columns={columns} colKey={colOf(ed)} areas={areas}
            rolled={rows.some((x) => x.parentId === ed.id && !x.archived)}
            onClose={() => { setEditOpen(false); setEditId(open.id); }}
            onPatch={(p) => onPatch(ed, p)} onMove={(k) => onMove(ed, k)} />
        )}

        {canParent && (
          <div className="bf-ghost" onClick={stop} style={{
            left: colX, top: y0 + gk * GAP, width: stacked ? Math.max(200, fw - 32) : NW,
            pointerEvents: ghostOn ? 'auto' : 'none', opacity: ghostOn ? 1 : 0, transform: ghostOn ? 'none' : 'translateX(-14px)',
            transition: live
              ? `opacity ${ms(360)}ms var(--ease-out) ${base + ms(gk * 70)}ms, transform ${ms(460)}ms var(--ease-out) ${base + ms(gk * 70)}ms, top ${ms(420)}ms var(--ease-out)`
              : `opacity ${ms(160)}ms var(--ease-standard)`,
          }}>
            {composing ? (
              <div className="bf-compose">
                <span className="eyebrow">{slice ? 'New task in this slice' : 'New part'}</span>
                <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addChild(draft); } }}
                  placeholder="What needs doing?" aria-label="New part title" />
                <span className="hint">Enter to add · Esc to cancel</span>
              </div>
            ) : (
              <button className="bf-addchild" onClick={() => { setComposing(true); setDraft(''); }}>
                <KitIcon name="plus" size={14} />{slice ? 'Add task' : 'Add part'}
              </button>
            )}
          </div>
        )}

        <div className="bf-tray" onClick={stop} style={{
          width: geo.trayW, pointerEvents: trayOn ? 'auto' : 'none',
          opacity: trayOn ? 1 : 0, transform: trayOn ? 'none' : 'translateX(18px)',
          transition: trayOn
            ? `opacity ${ms(380)}ms var(--ease-out) ${ms(D * 0.75)}ms, transform ${ms(480)}ms var(--ease-out) ${ms(D * 0.75)}ms`
            : `opacity ${ms(160)}ms var(--ease-standard), transform ${ms(160)}ms var(--ease-standard)`,
        }}>
          <div className="bf-trayhead">
            <div className="row">
              <span className="eyebrow">Bring in</span>
              <span className="n">{scoped.length}</span>
            </div>
            <div className="bf-seg" role="tablist">
              <button role="tab" aria-selected={trayScope === 'area'} className={trayScope === 'area' ? 'on' : ''}
                onClick={() => setTrayScope('area')}>
                {dotOf(fArea) && <span className="km-dot" style={{ background: dotOf(fArea) }} />}
                {slice ? 'Not in a slice' : fArea === UNTAGGED ? 'No area' : `Same area · ${fArea}`}
              </button>
              <button role="tab" aria-selected={trayScope === 'all'} className={`all${trayScope === 'all' ? ' on' : ''}`}
                onClick={() => setTrayScope('all')}>Whole board</button>
            </div>
          </div>
          <div className="bf-traylist">
            {scoped.map((x) => {
              const on = onCanvas.get(x.id);
              const ck = colOf(x);
              const kind = (x.kind ?? '') as ItemKind;
              const dot = trayScope === 'all' ? dotOf(areaKey(x)) : '';
              const canChild = slice ? x.parentId === null : canParent && x.id !== f.parentId && kidsOf(x.id).length === 0;
              return (
                <div key={x.id} className={`bf-trayrow${on ? ' on' : ''}`}>
                  <div className="row">
                    {dot && <span className="km-dot" style={{ background: dot }} />}
                    <span className="id">#{x.id}</span>
                    {kind && <span className="kind">{ITEM_KIND_LABEL[kind]}</span>}
                    <span className="col" style={{ color: COL_TONE[ck] || 'var(--status-neutral-fg)' }}>{colName(ck)}</span>
                  </div>
                  <span className="t">{x.title}</span>
                  {on ? (
                    <span className="hint">On the canvas · {on === 'child' ? (slice ? 'Task' : 'Part') : on === 'parent' ? 'Cluster' : 'Related'}</span>
                  ) : (
                    <div className="acts">
                      {canChild && (
                        <button className="bf-mini" title={slice ? 'File it into this slice' : 'File it under the focused item'} onClick={() => bringIn(x, 'child')}>
                          <KitIcon name="plus" size={12} />{slice ? 'Task' : 'Part'}
                        </button>
                      )}
                      <button className="bf-mini" title="Put it on the canvas as related work, without filing it"
                        onClick={() => bringIn(x, 'related')}>
                        <KitIcon name="plus" size={12} />Related
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {scoped.length === 0 && <span className="bf-empty">Nothing else here.</span>}
          </div>
        </div>
      </div>

      <svg className="bf-focusports" aria-hidden="true" style={{ left: open.canvasLeft, top: geo.top0 }}>
        {ports.filter((p) => p.focus).map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={4} className="bf-port" style={portStyle(p)} />
        ))}
      </svg>

      <div ref={floatRef} className={`km-card bf-float${slice ? ' bf-slice' : ''}`} title={slice ? 'Double-click to edit the slice' : 'Double-click to edit'}
        onDoubleClick={(e) => { e.stopPropagation(); if (live) editOn(f.id); }}
        style={{
          left: geo.l, top: targetT, width: geo.w,
          visibility: phase === 'measure' ? 'hidden' : 'visible',
          transform: phase === 'to' ? (shift ? `translateX(${-shift}px)` : 'none') : phase === 'measure' ? 'none' : inv,
          transition: fcTransition,
          boxShadow: phase === 'to' ? 'var(--shadow-md)' : 'var(--shadow-lg)',
          ...(dotOf(fArea) ? { borderTopColor: `color-mix(in oklch, ${dotOf(fArea)} 70%, var(--surface-card))`, borderTopWidth: 2 } : {}),
        }}>
        {slice
          ? <SliceFace slice={slice} kids={kids} onEdit={() => { if (live) editOn(f.id); }} />
          : <CardFace item={f} kids={kids} parent={parent} sprint={sprintOf(f)}
            onEdit={() => { if (live) editOn(f.id); }} />}
      </div>
    </>
  );
}

/** A slice in the middle of the canvas (decision 6): its title, how far its
 *  tasks have got, and the opening of its spec. ✎ opens the slice dialog. */
function SliceFace({ slice, kids, onEdit }: { slice: Slice; kids: RoadmapItem[]; onEdit: () => void }) {
  const built = kids.filter(isBuilt).length;
  const pct = kids.length ? Math.round((built / kids.length) * 100) : 0;
  const lede = slice.spec.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
  return (
    <>
      <span className="t">{slice.title}</span>
      {lede && <span className="bf-slicespec">{lede}</span>}
      <div className="km-cardmeta">
        <span className="kind" style={{ color: 'var(--accent)' }}><KitIcon name="layers" size={13} /></span>
        <span className="id">Slice</span>
        <span className="right">
          <button className="km-colbtn" aria-label="Edit slice" title="Edit slice"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}>
            <KitIcon name="pencil" size={13} />
          </button>
        </span>
      </div>
      <div className="bf-sliceprog" title={`${built} of ${kids.length} built`}>
        <span className="bar"><span style={{ width: `${pct}%` }} /></span>
        <span className="n">{built}/{kids.length} built</span>
      </div>
    </>
  );
}

/** The focused card's face: the board card's own grammar, read-only but for ✎. */
function CardFace({ item, kids, parent, sprint, onEdit }: {
  item: RoadmapItem; kids: RoadmapItem[]; parent: RoadmapItem | null; sprint: Sprint | null; onEdit: () => void;
}) {
  const pri = priorityMeta(item.bucket);
  const pts = item.points ?? null;
  const kind = (item.kind ?? '') as ItemKind;
  const due = dueRead(item.dueOn ?? null, item.done);
  const held = isHeld(item);
  const kidsDone = kids.filter((k) => k.done || listKeyOf(k) === 'shipped').length;
  return (
    <>
      <span className="t">{item.title}</span>
      <div className="km-cardmeta">
        <span className="kind" style={{ color: kids.length ? 'var(--accent)' : 'var(--blue-400)' }}><KitIcon name={kids.length ? 'layers' : 'circle-check'} size={13} /></span>
        <span className="id">#{item.id}</span>
        <span className={`bf-pts${pts === null ? ' none' : ''}`}>{pts === null ? '–' : pts}</span>
        <span className="right">
          <button className="km-colbtn" aria-label="Edit item" title="Edit item"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}>
            <KitIcon name="pencil" size={13} />
          </button>
          <span className="bf-pri lg" style={{ color: pri.color }}>{pri.glyph}</span>
        </span>
      </div>
      {(held || sprint || kind || due || parent || kids.length > 0 || item.claimedBy || item.skipped) && (
        <div className="km-cardtags">
          {held && <span className="k-tag warning">held</span>}
          {sprint && (
            <span className={`k-tag km-sprint${sprint.status === 'active' ? ' on' : ''}`}>
              <KitIcon name="layers" size={11} /><span className="v">{sprint.name}</span>
            </span>
          )}
          {kind && <span className={`k-tag km-kind ${kind}`}>{ITEM_KIND_LABEL[kind]}</span>}
          {due && <span className={`k-tag km-due ${due.tone}`}><KitIcon name="calendar" size={11} /><span className="v">{due.label}</span></span>}
          {parent && <span className="k-tag mono" title={`Part of #${parent.id} — ${parent.title}`}>↳ #{parent.id}</span>}
          {kids.length > 0 && <span className="k-tag mono" title="Parts finished">{kidsDone}/{kids.length} done</span>}
          {item.claimedBy && (
            <span className="k-tag mono" title={item.claimedBy}><KitIcon name="git-branch" size={11} /><span className="v">{item.claimedBy}</span></span>
          )}
          {item.skipped && <span className="k-tag warning">parked</span>}
        </div>
      )}
    </>
  );
}

/**
 * The inline editor. Title and notes save themselves, debounced, and flush
 * when the editor closes; every chip is one write, the same the card sends.
 */
function FocusEditor({ item, isPart, leadless = false, family, onSwitch, x, y, w, on, ms, columns, colKey, areas, rolled, onClose, onPatch, onMove }: {
  item: RoadmapItem; isPart: boolean;
  /** Slice mode: every member of `family` is a task, none of them the lead. */
  leadless?: boolean;
  /** #601 — the cluster and its parts, so the editor can move between them at
   *  any width (a narrow canvas hides the linked nodes while editing). [] for
   *  a plain card. */
  family: RoadmapItem[]; onSwitch: (id: number) => void;
  x: number; y: number; w: number; on: boolean; ms: (n: number) => number;
  columns: { key: string; name: string }[]; colKey: string; areas: { name: string; dot: string }[];
  /** A cluster: its column is rolled up from its parts, so it is shown, not set. */
  rolled: boolean;
  onClose: () => void; onPatch: (p: Patch) => void; onMove: (key: string) => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note);
  const pending = useRef<Patch>({});
  const t = useRef<ReturnType<typeof setTimeout>>();
  const flush = () => {
    clearTimeout(t.current);
    const p = pending.current; pending.current = {};
    if (p.title !== undefined && !p.title.trim()) delete p.title;   // never store an empty title
    if (Object.keys(p).length) onPatch(p);
  };
  const queue = (p: Patch) => {
    pending.current = { ...pending.current, ...p };
    clearTimeout(t.current);
    t.current = setTimeout(flush, 600);
  };
  useEffect(() => () => flush(), []);
  const kind = (item.kind ?? '') as ItemKind;
  const pts = item.points ?? null;
  return (
    <div className="bf-editor" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      style={{
        left: x, top: y, width: w, maxHeight: `calc(100% - ${y}px - 24px)`,
        opacity: on ? 1 : 0, transform: on ? 'none' : 'translateX(-16px) scale(0.98)', pointerEvents: on ? 'auto' : 'none',
        transition: on
          ? `opacity ${ms(280)}ms var(--ease-out) ${ms(60)}ms, transform ${ms(380)}ms var(--ease-out) ${ms(60)}ms`
          : `opacity ${ms(140)}ms var(--ease-standard), transform ${ms(140)}ms var(--ease-standard)`,
      }}>
      <div className="head">
        <span className="eyebrow">{leadless ? 'Edit task' : isPart ? 'Edit part' : 'Edit item'}</span>
        <span className="id">#{item.id}</span>
        <button className="bf-x" onClick={() => { flush(); onClose(); }} aria-label="Close editor" title="Close (Esc)">
          <KitIcon name="x" size={13} />
        </button>
      </div>
      {family.length > 0 && (
        <div className="bf-family" role="tablist" aria-label={leadless ? 'The slice’s tasks' : 'Cluster and its parts'}>
          {family.map((m, i) => {
            const lead = i === 0 && !leadless;
            return (
            <button key={m.id} role="tab" aria-selected={m.id === item.id}
              className={`${m.id === item.id ? 'on' : ''}${lead ? ' lead' : ''}`}
              title={lead ? `Edit the cluster #${m.id}` : `Edit ${leadless ? 'task' : 'part'} #${m.id}`}
              onClick={() => { if (m.id !== item.id) { flush(); onSwitch(m.id); } }}>
              <KitIcon name={lead ? 'layers' : 'circle-check'} size={12} />
              <span className="ft">{m.title}</span>
              {!lead && <span className="fp">{m.points == null ? '–' : m.points}</span>}
            </button>
            );
          })}
        </div>
      )}
      <label className="fld">
        <span>Title</span>
        <textarea rows={2} value={title} onChange={(e) => { setTitle(e.target.value); queue({ title: e.target.value.trim() }); }}
          onBlur={flush} />
      </label>
      <div className="fld">
        <span>Column{rolled ? ' · moves with its parts' : ''}</span>
        <div className="chips">
          {columns.map((c) => (
            <button key={c.key} className={colKey === c.key ? 'on' : ''} disabled={rolled && colKey !== c.key}
              title={rolled ? 'A cluster sits where its parts have got to' : undefined}
              onClick={() => { if (!rolled && colKey !== c.key) onMove(c.key); }}>{c.name}</button>
          ))}
        </div>
      </div>
      <div className="fld">
        <span>Priority</span>
        <div className="chips even">
          {PRIORITY_META.map((p) => (
            <button key={p.key} title={p.label} className={`mono${item.bucket === p.key ? ' on' : ''}`}
              style={item.bucket === p.key ? undefined : { color: p.color }}
              onClick={() => onPatch({ bucket: p.key })}>{p.glyph}</button>
          ))}
        </div>
      </div>
      <div className="fld">
        <span>Story points</span>
        <div className="chips even">
          {POINTS.map((v) => (
            <button key={String(v)} className={`mono${pts === v ? ' on' : ''}`} onClick={() => onPatch({ points: v })}>
              {v === null ? '–' : v}
            </button>
          ))}
        </div>
      </div>
      <div className="pair">
        <div className="fld">
          <span>Kind</span>
          <div className="chips even">
            {([['task', 'Task'], ['story', 'Story'], ['', 'Unset']] as [ItemKind, string][]).map(([k, label]) => (
              <button key={k || 'unset'} className={kind === k ? 'on' : ''} onClick={() => onPatch({ kind: k })}>{label}</button>
            ))}
          </div>
        </div>
        <label className="fld">
          <span>Due</span>
          <input type="date" value={item.dueOn || ''} onChange={(e) => onPatch({ dueOn: e.target.value || null })} />
        </label>
      </div>
      <div className="fld">
        <span>Area</span>
        <div className="chips">
          {[...areas.map((a) => ({ key: a.name, label: a.name, dot: a.dot })), { key: '', label: 'No area', dot: '' }].map((a) => (
            <button key={a.key || 'none'} className={item.area === a.key ? 'on' : ''} onClick={() => onPatch({ area: a.key })}>
              {a.dot && <span className="km-dot" style={{ background: a.dot }} />}{a.label}
            </button>
          ))}
        </div>
      </div>
      <label className="fld">
        <span>Notes</span>
        <textarea rows={4} value={note} placeholder="Context, acceptance, links…"
          onChange={(e) => { setNote(e.target.value); queue({ note: e.target.value }); }} onBlur={flush} />
      </label>
    </div>
  );
}
