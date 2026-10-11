// THE ROADMAP TAB IS THE KEPT-IDEA SURFACE, drawn as a canvas: a free-form
// board of notes you drag about, group, merge and mature until one is worth
// promoting onto the board. Imported from the Claude Design project's "Roadmap
// Canvas" (2026-10-11).
//
// It draws one of the three populations `homeOf` in lib/plan.ts partitions the
// project into — read that header before touching this screen, the board or For
// you's Auto-ideas pane. What lands here is an idea SOMEBODY HAS KEPT and
// nobody has committed to: a child row (`parent_id`) or a `committed` false row
// (#496). The raw machine feed is For you → Auto-ideas; its Keep is one door in,
// and a double-click on the canvas is the other.
//
// WORK LEAVES THIS SCREEN THE MOMENT IT IS WORKED OR PROMOTED. A promoted note
// stays drawn where it sat, faded and read-only ("on the board as #N"), because
// the canvas is a map of where the idea came from. It is board work now: this
// screen never edits it, merges it or groups it, so no row is acted on from two
// screens. Move it, or take it off the canvas, and that is all.
//
// PROMOTING IS ONE WRITE WITH ONE MEANING: `reviewed: true`, `committed: true`
// and `parentId: null` together say "this is committed work now". Leave
// `committed` out and the row bounces straight back here on the next render.
//
// FIVE DECISIONS WORTH THE INK:
//
//  1. THE CANVAS STATE IS ONE JSONB, `canvas` (server util.js cleanCanvas):
//     stage, a position per layout, pin, group and votes. None of it is a run
//     condition. `stage` (raw → exploring → shaped) is how shaped an idea is,
//     and nothing but this screen reads it. Writes go through PUT
//     /roadmap/canvas, which merges a partial and never bumps updated_at.
//  2. AN IDEA WITH NO POSITION IS IN THE INBOX. That is where Auto-ideas' Keep
//     lands one, and dragging it onto the canvas is placing it. Placed in
//     either layout counts: an idea placed only in Lanes gets a fallback slot
//     on the Canvas rather than falling back into the inbox.
//  3. AN IDEA IS BORN `committed` FALSE, through a create then a patch (the
//     create route takes no `committed`). The note is a local draft until it
//     has a title, so an empty double-click writes nothing.
//  4. DISCARD IS DELETE, and on a `hook` row it TOMBSTONES THE FINGERPRINT so
//     the next push cannot re-create it, which is why it asks twice. Merging
//     deletes the absorbed notes the same way, and that is right: their text
//     lives on in the kept note.
//  5. NO SKETCHES. The design has an image well; an image in a row would ride
//     the project payload the SessionStart hook reads on every session. It
//     waits for an attachment store.
//
// WHAT THIS SCREEN STILL CANNOT DO: give a verdict. A verdicted row is board
// work, so it is not this screen's to fix. Board.tsx's header carries the debt.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AreaChip, AddArea } from './Board';
import type { BoardArea, IdeaCanvas, IdeaCanvasPatch, CanvasStage, PlanStep, Priority, RoadmapItem } from '../types';
import { PRIORITY_META, PRIORITY_DEFAULT, timeAgo } from '../lib/ui';
import { isIdea, isBoardWork } from '../lib/plan';
import { hrefTo } from '../lib/route';
import {
  getBoardShape, createRoadmapItem, patchRoadmapItem, deleteRoadmapItem, createArea,
  putIdeaCanvas, getRoadmapView, setRoadmapView,
} from '../store';

// Same key, same reason, as the board's: untagged is a REAL scope and never a
// lane (#267). The leading space keeps it off any area an owner could type.
const UNTAGGED = ' untagged';

type Layout = 'c' | 'l';
type Pos = { x: number; y: number };
type Lane = CanvasStage | 'promoted';

const NW = 184;             // a note's width, in world pixels
const STEP = NW + 24;       // one grid column
const BAND = 560;           // one lane's width in the Lanes layout
const WORLD_H = 1400;       // the canvas's minimum height
const H_GUESS = 130;        // a note's height before it has been measured

const LANES: { key: Lane; label: string; hint: string }[] = [
  { key: 'raw', label: 'Raw', hint: 'Unfiltered. Anything goes.' },
  { key: 'exploring', label: 'Exploring', hint: 'Worth thinking through.' },
  { key: 'shaped', label: 'Shaped', hint: 'Clear enough to build.' },
  { key: 'promoted', label: 'Promoted', hint: 'Drop here to put it on the board.' },
];
const laneIdx = (k: Lane) => LANES.findIndex((l) => l.key === k);
const TINT: Record<Lane, { bg: string; fg: string }> = {
  raw: { bg: 'var(--surface-card)', fg: 'var(--text-tertiary)' },
  exploring: { bg: 'var(--status-info-bg)', fg: 'var(--status-info-fg)' },
  shaped: { bg: 'var(--status-success-bg)', fg: 'var(--status-success-fg)' },
  promoted: { bg: 'var(--surface-raised)', fg: 'var(--text-tertiary)' },
};
const LAYOUTS: { key: Layout; label: string; hint: string }[] = [
  { key: 'c', label: 'Canvas', hint: 'Double-click to add a note. Drag to pan, ⌘/Ctrl+scroll to zoom. Drop a note on another to merge or group.' },
  { key: 'l', label: 'Lanes', hint: 'Double-click in a lane to add a note there. Drag right to mature it; drop in Promoted to put it on the board.' },
];

const stageOf = (it: RoadmapItem): CanvasStage => it.canvas.stage ?? 'raw';
const laneAt = (x: number, max = 3) => Math.max(0, Math.min(max, Math.floor((x + NW / 2) / BAND)));
const snap = (v: number) => Math.round(v);
const PRIO_RANK: Record<Priority, number> = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 };

/** Where an idea came from, in a few words. A `hook` or `fly` row on THIS
 *  screen is one somebody kept from Auto-ideas, so it is signed off. */
const sourceOf = (it: RoadmapItem): string =>
  (it.source === 'hook' ? 'kept from a push' : it.source === 'fly' ? `kept from ${it.flySession || 'a session'}` : it.source === 'plan' ? 'from a plan run' : 'filed by hand');

type Drag =
  | { kind: 'pan'; sx: number; sy: number; sl: number; st: number; moved: boolean }
  | { kind: 'note' | 'group'; id: number; ids: number[]; sx: number; sy: number; orig: Map<number, Pos>; moved: boolean; shift: boolean }
  | { kind: 'rail'; id: number; sx: number; sy: number; moved: boolean };

type Prompt = { a: number; b: number; x: number; y: number; text: string; groupLabel: string };

export function Roadmap({ slug, projectName, items, onRefresh, onEdit, onAreas, highlightId }: {
  slug: string;
  projectName: string;
  /** The project payload's own roadmap, flattened and in payload order. */
  items: RoadmapItem[];
  onRefresh: () => void;
  /** Open the item modal — note, title, area, sub-area and plan. */
  onEdit: (it: RoadmapItem) => void;
  /** Hands the registered area names up, as the board does, so an area made
   *  here is offered by the item modal before any row carries it. */
  onAreas?: (names: string[]) => void;
  highlightId: string | null;
}) {
  // `canvas` defaults to {} so a payload from before the column (a cached one,
  // a fixture) draws its ideas in the inbox rather than throwing.
  const withCanvas = (rs: RoadmapItem[]) => rs.map((r) => (r.canvas ? r : { ...r, canvas: {} }));
  const [rows, setRows] = useState<RoadmapItem[]>(() => withCanvas(items));
  useEffect(() => { setRows(withCanvas(items)); }, [items]);

  const [areas, setAreas] = useState<BoardArea[]>([]);
  const [err, setErr] = useState('');
  const loadShape = useCallback(async () => { setAreas((await getBoardShape(slug)).areas); }, [slug]);
  useEffect(() => { onAreas?.(areas.map((a) => a.name)); }, [areas]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadShape().catch(() => { /* an unregistered area still draws; see areaKey */ }); }, [loadShape]);

  const guard = async (fn: () => Promise<void>) => {
    try { setErr(''); await fn(); }
    catch (e) { setErr((e as Error)?.message || 'Something went wrong.'); onRefresh(); }
  };

  // ---- view state (device-local) --------------------------------------------
  const [view, setView] = useState(() => getRoadmapView(slug));
  useEffect(() => { setView(getRoadmapView(slug)); }, [slug]);
  const writeView = (next: Partial<typeof view>) => {
    const v = { ...view, ...next };
    setView(v);
    setRoadmapView(slug, v);
  };
  const L = view.layout;
  const [zoom, setZoom] = useState(1);
  const [tag, setTag] = useState('');               // '' = every area
  const [sel, setSel] = useState<number[]>([]);
  const [draft, setDraft] = useState<{ pos: Pos; text: string } | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; title: string } | null>(null);
  const [dragPos, setDragPos] = useState<Map<number, Pos> | null>(null);
  const [panning, setPanning] = useState(false);
  const [tidyOpen, setTidyOpen] = useState(false);
  const [tidyLabels, setTidyLabels] = useState<{ x: number; y: number; label: string; color: string; count: number }[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const undoRef = useRef<{ L: Layout; pos: Map<number, Pos | null> } | null>(null);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const heights = useRef(new Map<number, number>());
  const [measured, bump] = useState(0);

  const areaKey = (it: RoadmapItem) => it.area.trim() || UNTAGGED;
  const areaDot = (name: string) => areas.find((a) => a.name === name)?.dot || 'var(--grey-500)';

  // ---- the populations --------------------------------------------------------
  const ideas = useMemo(() => rows.filter((it) => !it.archived && isIdea(it)), [rows]);
  // A promoted note: board work that was once placed here. Read-only (header).
  const promoted = useMemo(
    () => rows.filter((it) => !it.archived && !it.done && isBoardWork(it) && (it.canvas.c || it.canvas.l)),
    [rows]);
  const inbox = useMemo(() => ideas.filter((it) => !it.canvas.c && !it.canvas.l), [ideas]);
  const placed = useMemo(() => ideas.filter((it) => it.canvas.c || it.canvas.l), [ideas]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const hOf = (id: number) => heights.current.get(id) || H_GUESS;

  // ---- where everything is drawn ---------------------------------------------
  // Stored positions where they are valid, a fallback slot where they are not:
  // on the Canvas an idea placed only in Lanes, in Lanes a note whose stored
  // spot sits outside its stage's lane (its stage was set from the inspector).
  const positions = useMemo(() => {
    const out = new Map<number, Pos>();
    const drawn = [...placed, ...promoted];
    if (L === 'c') {
      const lost: RoadmapItem[] = [];
      for (const it of drawn) { if (it.canvas.c) out.set(it.id, it.canvas.c); else lost.push(it); }
      const right = Math.max(40, ...[...out.values()].map((p) => p.x + STEP + 24));
      lost.forEach((it, i) => out.set(it.id, { x: right + (i % 2) * STEP, y: 80 + Math.floor(i / 2) * 180 }));
      return out;
    }
    LANES.forEach((lane, b) => {
      const inLane = drawn.filter((it) => (isBoardWork(it) ? 'promoted' : stageOf(it)) === lane.key);
      const lost: RoadmapItem[] = [];
      for (const it of inLane) {
        const p = it.canvas.l;
        if (p && laneAt(p.x) === b) out.set(it.id, p); else lost.push(it);
      }
      const bottom = Math.max(56, ...inLane.filter((it) => out.has(it.id)).map((it) => out.get(it.id)!.y + hOf(it.id)));
      lost.forEach((it, i) => out.set(it.id, { x: b * BAND + 36 + (i % 2) * STEP, y: bottom + 24 + Math.floor(i / 2) * 180 }));
    });
    return out;
  }, [placed, promoted, L, measured]); // eslint-disable-line react-hooks/exhaustive-deps
  const posOf = (id: number): Pos | undefined => dragPos?.get(id) ?? positions.get(id);

  // Measure each drawn note after paint; a group's box and a tidy need heights.
  useLayoutEffect(() => {
    const root = canvasRef.current; if (!root) return;
    let changed = false;
    root.querySelectorAll<HTMLElement>('[data-note-id]').forEach((el) => {
      const id = Number(el.dataset.noteId), h = el.offsetHeight;
      if (heights.current.get(id) !== h) { heights.current.set(id, h); changed = true; }
    });
    if (changed) bump((n) => n + 1);
  });

  const worldW = L === 'l' ? BAND * 4
    : Math.max(2400, ...[...positions.values()].map((p) => p.x + NW + 400));
  const worldH = Math.max(WORLD_H, ...[...positions.entries()].map(([id, p]) => p.y + hOf(id) + 400));

  // ---- canvas writes ------------------------------------------------------------
  // Optimistic: the rows change at once, the write follows, and a failed write
  // re-reads the payload so the screen never keeps a position the server lost.
  const writeCanvas = (patches: { id: number; canvas: IdeaCanvasPatch }[]) => {
    if (!patches.length) return Promise.resolve();
    const by = new Map(patches.map((p) => [p.id, p.canvas]));
    setRows((rs) => rs.map((r) => {
      const p = by.get(r.id); if (!p) return r;
      const next: Record<string, unknown> = { ...r.canvas };
      for (const [k, v] of Object.entries(p)) { if (v === null) delete next[k]; else next[k] = v; }
      return { ...r, canvas: next as IdeaCanvas };
    }));
    return guard(async () => { await putIdeaCanvas(slug, patches); });
  };
  const wrote = (updated: RoadmapItem) => {
    setRows((r) => r.map((x) => (x.id === updated.id ? updated : x)));
    onRefresh();
  };
  const patchItem = (id: number, patch: Parameters<typeof patchRoadmapItem>[2]) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, id, patch)); });

  // ONE WRITE, ONE MEANING (header). The canvas position stays, so the note is
  // still drawn where it sat, as promoted.
  const promote = (id: number) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, id, { reviewed: true, committed: true, parentId: null })); });
  const discard = (id: number) =>
    guard(async () => {
      await deleteRoadmapItem(slug, id);
      setRows((r) => r.filter((x) => x.id !== id));
      setSel((s) => s.filter((x) => x !== id));
      onRefresh();
    });
  const setStage = (it: RoadmapItem, stage: CanvasStage) =>
    writeCanvas([{ id: it.id, canvas: { stage: stage === 'raw' ? null : stage } }]);
  const vote = (it: RoadmapItem) => writeCanvas([{ id: it.id, canvas: { votes: (it.canvas.votes || 0) + 1 } }]);
  const togglePin = (it: RoadmapItem) => writeCanvas([{ id: it.id, canvas: { pinned: it.canvas.pinned ? null : true } }]);

  /** `#area` in a title files the note there. Spaces in an area name read as '-'. */
  const parseTags = (text: string, area: string) => {
    let picked = area;
    const title = text.replace(/#([\w-]+)/g, (m, k: string) => {
      const hit = areas.find((a) => a.name.toLowerCase().replace(/\s+/g, '-') === k.toLowerCase());
      if (hit) { if (!picked) picked = hit.name; return ''; }
      return m;
    }).replace(/\s+/g, ' ').trim();
    return { title, area: picked };
  };

  // A note is a local draft until it has a title (decision 3).
  const commitDraft = () => {
    const d = draft; setDraft(null);
    if (!d) return;
    const { title, area } = parseTags(d.text, tag && tag !== UNTAGGED ? tag : '');
    if (!title) return;
    const lane = L === 'l' ? LANES[laneAt(d.pos.x, 2)].key as CanvasStage : 'raw';
    guard(async () => {
      const made = await createRoadmapItem(slug, { title, note: '', bucket: PRIORITY_DEFAULT, ...(area ? { area } : {}) });
      const idea = await patchRoadmapItem(slug, made.id, { committed: false });
      const canvas: IdeaCanvas = { [L]: d.pos, ...(lane !== 'raw' ? { stage: lane } : {}) };
      setRows((r) => [...r, { ...idea, canvas }]);
      await putIdeaCanvas(slug, [{ id: idea.id, canvas }]);
      onRefresh();
    });
  };
  const newAt = (x: number, y: number) => {
    setSel([]); setPrompt(null);
    setDraft({ pos: { x: snap(Math.max(0, x)), y: snap(Math.max(0, y)) }, text: '' });
  };

  // ---- merge and group --------------------------------------------------------
  const merge = (ids: number[]) => {
    const all = ids.map((id) => byId.get(id)).filter((it): it is RoadmapItem => !!it && isIdea(it));
    if (all.length < 2) return;
    const [keep, ...rest] = all;
    const extra = rest.map((o) => `From #${o.id} "${o.title}"${o.note.trim() ? `: ${o.note.trim()}` : ''}`).join('\n');
    const plan: PlanStep[] = [...keep.plan, ...rest.flatMap((o) => o.plan)].slice(0, 30);
    const votes = all.reduce((a, o) => a + (o.canvas.votes || 0), 0);
    const area = keep.area || rest.find((o) => o.area)?.area || '';
    setPrompt(null);
    guard(async () => {
      wrote(await patchRoadmapItem(slug, keep.id, {
        note: [keep.note.trim(), extra].filter(Boolean).join('\n\n'), plan, ...(area !== keep.area ? { area } : {}),
      }));
      const c = keep.canvas.c || rest.find((o) => o.canvas.c)?.canvas.c;
      await writeCanvas([{ id: keep.id, canvas: { votes: votes || null, ...(c ? { c } : {}) } }]);
      for (const o of rest) await deleteRoadmapItem(slug, o.id);
      setRows((r) => r.filter((x) => !rest.some((o) => o.id === x.id)));
      setSel([keep.id]);
      onRefresh();
    });
  };
  const groupNames = () => new Set(rows.map((r) => r.canvas.group).filter(Boolean) as string[]);
  /** `dropped`, from the drop prompt, is the note let go on top of ids[0]: it
   *  moves to sit under it, or the box would hold two notes in one spot. */
  const group = (ids: number[], dropped?: number) => {
    const mem = ids.map((id) => byId.get(id)).filter((it): it is RoadmapItem => !!it && isIdea(it));
    if (mem.length < 2) return;
    const anchor = positions.get(ids[0]);
    const under = dropped !== undefined && anchor ? { x: anchor.x, y: snap(anchor.y + hOf(ids[0]) + 24) } : null;
    let name = mem.find((m) => m.canvas.group)?.canvas.group;
    if (!name) {
      const taken = groupNames();
      name = 'New group';
      for (let n = 2; taken.has(name); n++) name = `New group ${n}`;
    }
    setPrompt(null); setSel([]);
    writeCanvas(mem.map((m) => ({ id: m.id, canvas: { group: name!, ...(under && m.id === dropped ? { [L]: under } : {}) } })));
  };
  const ungroup = (name: string) =>
    writeCanvas(rows.filter((r) => r.canvas.group === name).map((r) => ({ id: r.id, canvas: { group: null } })));
  const renameGroup = (from: string, to: string) => {
    const t = to.trim();
    if (!t || t === from) return;
    writeCanvas(rows.filter((r) => r.canvas.group === from).map((r) => ({ id: r.id, canvas: { group: t } })));
  };

  // ---- zoom and pan -------------------------------------------------------------
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const zoomTo = useCallback((z: number, cx?: number, cy?: number) => {
    const c = canvasRef.current; if (!c) return;
    const nz = Math.max(0.25, Math.min(2, z));
    const r = c.getBoundingClientRect();
    const ax = cx === undefined ? r.width / 2 : cx - r.left, ay = cy === undefined ? r.height / 2 : cy - r.top;
    const old = zoomRef.current, wx = (c.scrollLeft + ax) / old, wy = (c.scrollTop + ay) / old;
    setZoom(nz);
    requestAnimationFrame(() => { c.scrollLeft = wx * nz - ax; c.scrollTop = wy * nz - ay; });
  }, []);
  const zoomFit = () => {
    const c = canvasRef.current; if (!c || !positions.size) return;
    const ps = [...positions.entries()];
    const x0 = Math.min(...ps.map(([, p]) => p.x)) - 40, y0 = Math.min(...ps.map(([, p]) => p.y)) - 60;
    const x1 = Math.max(...ps.map(([, p]) => p.x + NW)) + 40, y1 = Math.max(...ps.map(([id, p]) => p.y + hOf(id))) + 40;
    const z = Math.max(0.25, Math.min(1.5, Math.min(c.clientWidth / (x1 - x0), c.clientHeight / (y1 - y0))));
    setZoom(z);
    requestAnimationFrame(() => { c.scrollLeft = x0 * z; c.scrollTop = y0 * z; });
  };
  const toWorld = (cx: number, cy: number): Pos => {
    const c = canvasRef.current!, r = c.getBoundingClientRect(), z = zoomRef.current;
    return { x: (cx - r.left + c.scrollLeft) / z, y: (cy - r.top + c.scrollTop) / z };
  };
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomTo(zoomRef.current * Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
    };
    c.addEventListener('wheel', wheel, { passive: false });
    return () => c.removeEventListener('wheel', wheel);
  }, [zoomTo]);

  // ---- dragging -------------------------------------------------------------------
  const drag = useRef<Drag | null>(null);

  const noteAt = (x: number, y: number, exclude: number[]) => {
    for (const el of document.elementsFromPoint(x, y)) {
      const h = (el as HTMLElement).closest?.('[data-note-id]') as HTMLElement | null;
      if (h && h.dataset.ghost !== '1') {
        const id = Number(h.dataset.noteId);
        if (!exclude.includes(id)) return id;
      }
    }
    return null;
  };
  const mkPrompt = (a: number, b: number, e: PointerEvent): Prompt => {
    const ta = byIdRef.current.get(a), tb = byIdRef.current.get(b);
    const g = tb?.canvas.group;
    return {
      a, b, x: Math.min(e.clientX + 12, window.innerWidth - 264), y: Math.min(e.clientY + 12, window.innerHeight - 220),
      text: `"${ta?.title ?? ''}" onto "${tb?.title ?? ''}"`,
      groupLabel: g ? `Add to "${g}"` : 'Group them',
    };
  };
  const byIdRef = useRef(byId); byIdRef.current = byId;

  const startNote = (e: React.PointerEvent, id: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button,input,textarea')) return;
    e.stopPropagation();
    const p = posOf(id); if (!p) return;
    const it = byId.get(id);
    drag.current = { kind: 'note', id, ids: it?.canvas.pinned ? [] : [id], sx: e.clientX, sy: e.clientY,
      orig: new Map(it?.canvas.pinned ? [] : [[id, p]]), moved: false, shift: e.shiftKey || e.metaKey };
  };
  const startGroup = (e: React.PointerEvent, name: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button,input')) return;
    e.stopPropagation();
    const orig = new Map<number, Pos>();
    for (const it of placed) {
      const p = positions.get(it.id);
      if (it.canvas.group === name && !it.canvas.pinned && p) orig.set(it.id, p);
    }
    drag.current = { kind: 'group', id: -1, ids: [...orig.keys()], sx: e.clientX, sy: e.clientY, orig, moved: false, shift: false };
  };
  const startPan = (e: React.PointerEvent) => {
    if (tidyOpen) setTidyOpen(false);
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-note-id],input,button,textarea')) return;
    const c = canvasRef.current!;
    drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, sl: c.scrollLeft, st: c.scrollTop, moved: false };
  };
  const startRail = (e: React.PointerEvent, id: number) => {
    if (e.button !== 0) return;
    drag.current = { kind: 'rail', id, sx: e.clientX, sy: e.clientY, moved: false };
  };

  // Bound ONCE, calling through `pointer` for the latest render's closures.
  // Re-binding per render loses a pointerup: another window listener's state
  // change re-renders mid-dispatch, and a listener removed during dispatch is
  // never called, so the drag never ends.
  const pointer = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => pointer.current?.move(e);
    const up = (e: PointerEvent) => pointer.current?.up(e);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);
  {
    const move = (e: PointerEvent) => {
      const d = drag.current; if (!d) return;
      const rdx = e.clientX - d.sx, rdy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(rdx, rdy) < 4) return;
      d.moved = true;
      if (d.kind === 'pan') {
        const c = canvasRef.current; if (!c) return;
        c.scrollLeft = d.sl - rdx; c.scrollTop = d.st - rdy;
        setPanning(true);
        return;
      }
      if (d.kind === 'rail') {
        setGhost({ x: e.clientX, y: e.clientY, title: byIdRef.current.get(d.id)?.title || '' });
        return;
      }
      if (!d.orig.size) return;
      const z = zoomRef.current, dx = rdx / z, dy = rdy / z;
      const next = new Map<number, Pos>();
      d.orig.forEach((p, id) => next.set(id, { x: Math.max(0, p.x + dx), y: Math.max(0, p.y + dy) }));
      setDragPos(next);
    };
    const up = (e: PointerEvent) => {
      const d = drag.current; drag.current = null;
      if (!d) return;
      const lay = L, dp = dragPos;
      if (d.kind === 'pan') {
        setPanning(false);
        if (!d.moved) { setSel([]); setPrompt(null); }
        return;
      }
      if (!d.moved) {
        if (d.kind === 'note' || d.kind === 'rail') {
          const id = d.id, shift = d.kind === 'note' && d.shift;
          setSel((s) => (shift ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : [id]));
        }
        return;
      }
      const isIdeaId = (id: number) => { const it = byIdRef.current.get(id); return !!it && isIdea(it); };
      if (d.kind === 'rail') {
        setGhost(null);
        const c = canvasRef.current; if (!c) return;
        const r = c.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
        const w = toWorld(e.clientX, e.clientY);
        const p = { x: snap(Math.max(0, w.x - 20)), y: snap(Math.max(0, w.y - 16)) };
        const target = noteAt(e.clientX, e.clientY, [d.id]);
        const patch: IdeaCanvasPatch = { [lay]: p };
        if (lay === 'l') { const st = LANES[laneAt(p.x, 2)].key; patch.stage = st === 'raw' ? null : st as IdeaCanvas['stage']; }
        writeCanvas([{ id: d.id, canvas: patch }]);
        if (target && isIdeaId(target)) setPrompt(mkPrompt(d.id, target, e));
        return;
      }
      // A note or a group moved: persist where it landed.
      const landed = dp ?? new Map<number, Pos>();
      setDragPos(null);
      setTidyLabels([]);
      if (!landed.size) return;
      const patches: { id: number; canvas: IdeaCanvasPatch }[] = [];
      const promoteIds: number[] = [];
      landed.forEach((p, id) => {
        const it = byIdRef.current.get(id); if (!it) return;
        const pos = { x: snap(p.x), y: snap(p.y) };
        const patch: IdeaCanvasPatch = { [lay]: pos };
        if (lay === 'l' && isIdea(it)) {
          const lane = LANES[laneAt(pos.x)].key;
          if (lane === 'promoted') promoteIds.push(id);
          else if (lane !== stageOf(it)) patch.stage = lane === 'raw' ? null : lane;
        }
        patches.push({ id, canvas: patch });
      });
      writeCanvas(patches).then(() => { promoteIds.forEach((id) => promote(id)); });
      if (d.kind === 'note' && isIdeaId(d.id)) {
        const target = noteAt(e.clientX, e.clientY, d.ids);
        if (target && isIdeaId(target)) setPrompt(mkPrompt(d.id, target, e));
      }
    };
    pointer.current = { move, up };
  }

  // ---- keys -------------------------------------------------------------------------
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.('input,textarea,select,[contenteditable="true"]') || document.querySelector('.modal')) return;
      if (e.key === 'Escape') { setSel([]); setPrompt(null); setTidyOpen(false); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const c = canvasRef.current; if (!c) return;
      const z = zoomRef.current;
      if (e.key === 'n') { e.preventDefault(); newAt((c.scrollLeft + c.clientWidth / 2) / z - NW / 2, (c.scrollTop + c.clientHeight / 2) / z - 60); }
      else if (e.key === '=' || e.key === '+') zoomTo(z * 1.2);
      else if (e.key === '-' || e.key === '_') zoomTo(z / 1.2);
      else if (e.key === '0') zoomTo(1);
      else if (e.key === '1') zoomFit();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  // A deep link selects its note; ProjectDetail scrolls to its `data-hl`.
  useEffect(() => {
    const n = Number(highlightId);
    if (Number.isFinite(n) && n > 0) setSel([n]);
  }, [highlightId]);

  // ---- tidy -------------------------------------------------------------------------
  const tidy = (mode: 'stage' | 'area' | 'votes' | 'priority') => {
    setTidyOpen(false);
    const live2 = placed.filter((it) => !it.canvas.pinned && positions.has(it.id));
    const pins = [...placed, ...promoted].filter((it) => it.canvas.pinned && positions.has(it.id)).map((it) => {
      const p = positions.get(it.id)!;
      return { x: p.x - 12, y: p.y - 12, r: p.x + NW + 12, b: p.y + hOf(it.id) + 12 };
    });
    const hit = (x: number, y: number, w: number, hh: number) => pins.find((p) => x < p.r && x + w > p.x && y < p.b && y + hh > p.y);
    const areaOrder = [...areas.map((a) => a.name), ...new Set(live2.map((it) => it.area).filter((a) => a && !areas.some((x) => x.name === a)))];
    const areaIdx = (it: RoadmapItem) => (it.area ? areaOrder.indexOf(it.area) : 999);
    const kf: (it: RoadmapItem) => number = {
      stage: (it: RoadmapItem) => laneIdx(stageOf(it)),
      area: areaIdx,
      votes: (it: RoadmapItem) => -(it.canvas.votes || 0),
      priority: (it: RoadmapItem) => PRIO_RANK[it.bucket],
    }[mode];
    const pos = new Map<number, Pos>();
    const labels: typeof tidyLabels = [];
    if (L === 'l') {
      LANES.slice(0, 3).forEach((lane, bi) => {
        const arr = live2.filter((it) => stageOf(it) === lane.key)
          .sort((a, b) => kf(a) - kf(b) || (a.canvas.group || '~').localeCompare(b.canvas.group || '~') || (b.canvas.votes || 0) - (a.canvas.votes || 0) || a.id - b.id);
        let y = 80, j = 0, rowH = 0;
        for (const it of arr) {
          for (let guardN = 0; guardN < 200; guardN++) {
            const x = bi * BAND + 36 + j * STEP, p = hit(x, y, NW, hOf(it.id));
            if (!p) { pos.set(it.id, { x, y }); rowH = Math.max(rowH, hOf(it.id)); break; }
            j++; if (j >= 2) { y = rowH ? y + rowH + 24 : p.b + 12; j = 0; rowH = 0; }
          }
          j++; if (j >= 2) { y += rowH + 24; j = 0; rowH = 0; }
        }
      });
    } else {
      type Unit = { grouped: boolean; mem: RoadmapItem[]; key: number; votes: number };
      const units: Unit[] = [], seen = new Set<string>();
      for (const it of live2) {
        const g = it.canvas.group;
        if (g) {
          if (seen.has(g)) continue;
          seen.add(g);
          const mem = live2.filter((m) => m.canvas.group === g).sort((a, b) => (b.canvas.votes || 0) - (a.canvas.votes || 0));
          units.push({ grouped: true, mem, key: Math.min(...mem.map(kf)), votes: mem.reduce((a, m) => a + (m.canvas.votes || 0), 0) });
        } else units.push({ grouped: false, mem: [it], key: kf(it), votes: it.canvas.votes || 0 });
      }
      const columnar = mode === 'stage' || mode === 'area';
      const buckets = columnar
        ? [...new Set(units.map((u) => u.key))].sort((a, b) => a - b)
          .map((k) => ({ k, units: units.filter((u) => u.key === k).sort((a, b) => Number(a.grouped) - Number(b.grouped) || b.votes - a.votes) }))
        : [{ k: -1, units: units.sort((a, b) => a.key - b.key || Number(a.grouped) - Number(b.grouped)) }];
      const cols = columnar ? 2 : Math.max(2, Math.floor(((canvasRef.current?.clientWidth || 1200) / zoom - 80) / STEP));
      let x0 = 40;
      for (const b of buckets) {
        if (columnar) {
          const lab = mode === 'stage'
            ? { label: LANES[b.k].label, color: TINT[LANES[b.k].key].fg }
            : b.k === 999 ? { label: 'No area', color: 'var(--grey-500)' } : { label: areaOrder[b.k], color: areaDot(areaOrder[b.k]) };
          labels.push({ x: x0, y: 36, ...lab, count: b.units.reduce((a, u) => a + u.mem.length, 0) });
        }
        let y = 80, j = 0, rowH = 0;
        const flush = () => { if (j === 0) return; y += rowH + 24; j = 0; rowH = 0; };
        for (const u of b.units) {
          if (!u.grouped) {
            const it = u.mem[0];
            for (let guardN = 0; guardN < 200; guardN++) {
              const x = x0 + j * STEP, p = hit(x, y, NW, hOf(it.id));
              if (!p) { pos.set(it.id, { x, y }); rowH = Math.max(rowH, hOf(it.id)); break; }
              j++; if (j >= cols) { if (rowH) flush(); else { y = p.b + 12; j = 0; } }
            }
            j++; if (j >= cols) flush();
            continue;
          }
          flush();
          const cc = Math.min(cols, u.mem.length), lines: RoadmapItem[][] = [];
          for (let i = 0; i < u.mem.length; i += cc) lines.push(u.mem.slice(i, i + cc));
          const blockH = 38 + lines.reduce((a, r) => a + Math.max(...r.map((m) => hOf(m.id))) + 24, 0) + 14;
          for (let p = hit(x0 - 14, y, cc * STEP + 4, blockH), n = 0; p && n < 200; p = hit(x0 - 14, y, cc * STEP + 4, blockH), n++) y = p.b + 12;
          y += 38;
          for (const r of lines) { r.forEach((m, k) => pos.set(m.id, { x: x0 + k * STEP, y })); y += Math.max(...r.map((m) => hOf(m.id))) + 24; }
          y += 30;
        }
        flush();
        x0 += cols * STEP + 48;
      }
    }
    undoRef.current = { L, pos: new Map(live2.map((it) => [it.id, it.canvas[L] ?? null])) };
    setTidyLabels(L === 'l' ? [] : labels);
    const names = { stage: 'stage', area: 'area', votes: 'votes', priority: 'priority' };
    setToast(`Tidied by ${names[mode]}${L === 'l' ? ' within each lane' : ''}`);
    writeCanvas([...pos.entries()].map(([id, p]) => ({ id, canvas: { [L]: p } })));
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);
  const undoTidy = () => {
    const u = undoRef.current; if (!u) return;
    undoRef.current = null;
    setToast(null); setTidyLabels([]);
    writeCanvas([...u.pos.entries()].map(([id, p]) => ({ id, canvas: { [u.L]: p } })));
  };

  // ---- area chips -------------------------------------------------------------------
  const chips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of ideas) counts.set(areaKey(it), (counts.get(areaKey(it)) || 0) + 1);
    const order = [...areas.map((a) => a.name)];
    for (const k of counts.keys()) if (k !== UNTAGGED && !order.includes(k)) order.push(k);
    const out = order.map((k) => ({ key: k, name: k, dot: areas.find((a) => a.name === k)?.dot || '', n: counts.get(k) || 0 }));
    if (counts.has(UNTAGGED)) out.push({ key: UNTAGGED, name: 'No area', dot: '', n: counts.get(UNTAGGED) || 0 });
    return out;
  }, [ideas, areas]);
  const matches = (it: RoadmapItem) => !tag || areaKey(it) === tag;
  const addArea = (name: string) =>
    guard(async () => {
      const before = new Set(areas.map((a) => a.name));
      const next = await createArea(slug, name);
      setAreas(next);
      const made = next.find((a) => !before.has(a.name))?.name;
      if (made) setTag(made);
    });

  // ---- groups' boxes ------------------------------------------------------------------
  const hulls = (() => {
    const names = [...new Set(placed.map((it) => it.canvas.group).filter(Boolean) as string[])];
    return names.map((name) => {
      const mem = placed.filter((it) => it.canvas.group === name && posOf(it.id));
      if (!mem.length) return null;
      const ps = mem.map((it) => ({ p: posOf(it.id)!, h: hOf(it.id) }));
      const x = Math.min(...ps.map((o) => o.p.x)) - 14, y = Math.min(...ps.map((o) => o.p.y)) - 38;
      return {
        name, count: mem.length, x, y,
        // At least wide enough for its own bar: grip, name, count and Ungroup.
        w: Math.max(Math.max(...ps.map((o) => o.p.x)) + NW + 14 - x, 90 + name.length * 8),
        h: Math.max(...ps.map((o) => o.p.y + o.h)) + 14 - y,
        on: mem.some((it) => sel.includes(it.id)),
      };
    }).filter((h): h is NonNullable<typeof h> => !!h);
  })();

  const selected = sel.length === 1 ? byId.get(sel[0]) ?? null : null;
  const lay = LAYOUTS.find((l) => l.key === L)!;
  const drawn = [...placed, ...promoted];

  return (
    <div className="rc" onClick={() => setTidyOpen(false)}>
      <div className="rc-head">
        <div className="rc-headrow">
          <div className="rc-title">
            <span className="eyebrow">{projectName}</span>
            <h1>Roadmap</h1>
          </div>
          <span className="rc-grow" />
          <div className="rc-tidywrap" onClick={(e) => e.stopPropagation()}>
            <button className={`rc-btn${tidyOpen ? ' on' : ''}`} aria-expanded={tidyOpen}
              onClick={() => setTidyOpen(!tidyOpen)}>
              Tidy up <span className="rc-caret">▾</span>
            </button>
            {tidyOpen && (
              <div className="rc-menu" role="menu">
                <span className="rc-menu-intro">
                  {L === 'l' ? 'Re-stack every lane in neat rows. Pinned notes stay put.' : 'Line up every note on the canvas. Groups stay together, pinned notes stay put.'}
                </span>
                {(L === 'l'
                  ? [['votes', 'By votes', 'Most voted at the top of each lane'], ['priority', 'By priority', 'Highest first in each lane'], ['area', 'By area', 'Same-area notes sit together']] as const
                  : [['stage', 'By stage', 'A column per stage, Raw to Shaped'], ['area', 'By area', 'A column per area'], ['votes', 'By votes', 'One grid, most voted first'], ['priority', 'By priority', 'One grid, highest first']] as const
                ).map(([k, label, hint]) => (
                  <button key={k} role="menuitem" className="rc-menu-opt" onClick={() => tidy(k)}>
                    <span className="l">{label}</span><span className="h">{hint}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="rc-seg" role="tablist" aria-label="Layout">
            {LAYOUTS.map((l) => (
              <button key={l.key} role="tab" aria-selected={L === l.key} className={`rc-layout${L === l.key ? ' on' : ''}`}
                onClick={() => { writeView({ layout: l.key }); setPrompt(null); setTidyLabels([]); setToast(null); }}>
                {l.label}
              </button>
            ))}
          </div>
        </div>
        <div className="rc-chips km-scope">
          <AreaChip label="All" count={ideas.length} active={tag === ''} onClick={() => setTag('')} />
          <AddArea onAdd={addArea} />
          {chips.map((c) => (
            <AreaChip key={c.key} label={c.name} dot={c.dot} count={c.n}
              active={tag === c.key} onClick={() => setTag(tag === c.key ? '' : c.key)} />
          ))}
          <span className="rc-hint">{lay.hint}</span>
          <span className="rc-summary">
            {ideas.length} idea{ideas.length === 1 ? '' : 's'} · {hulls.length} group{hulls.length === 1 ? '' : 's'} · {promoted.length} promoted
          </span>
        </div>
      </div>

      {err && <div className="km-err" role="alert">{err}</div>}

      <div className="rc-body">
        {view.inbox ? (
          <aside className="rc-inbox">
            <div className="rc-inbox-head">
              <span className="l">Inbox</span>
              <span className="n">{inbox.length}</span>
              <span className="rc-grow" />
              <button className="rc-icon" title="Collapse inbox" aria-label="Collapse inbox" onClick={() => writeView({ inbox: false })}>«</button>
            </div>
            <span className="rc-inbox-lede">
              Kept ideas land here. Drag one onto the canvas{L === 'l' ? ' (the lane you drop it in sets its stage)' : ''}, or onto a note to merge or group.
            </span>
            <div className="rc-inbox-list">
              {inbox.map((it) => (
                <div key={it.id} className={`rc-inbox-card${sel.includes(it.id) ? ' on' : ''}`} data-hl={it.id}
                  style={{ opacity: matches(it) ? 1 : 0.35 }} onPointerDown={(e) => startRail(e, it.id)}>
                  <span className="t">{it.title}</span>
                  <div className="meta">
                    <AreaTag area={it.area} dot={areaDot(it.area)} />
                    <span className="rc-grow" />
                    <span className="age">{timeAgo(it.createdAt)}</span>
                  </div>
                </div>
              ))}
              {inbox.length === 0 && <span className="rc-empty">Inbox zero.</span>}
            </div>
          </aside>
        ) : (
          <button className="rc-inboxrail" title="Show inbox" onClick={() => writeView({ inbox: true })}>
            <span className="c">»</span>
            <span className="n">{inbox.length}</span>
            <span className="v">Inbox</span>
          </button>
        )}

        <div className="rc-stage">
          <div ref={canvasRef} className={`rc-canvas${panning ? ' panning' : ''}`}
            onPointerDown={startPan}
            onDoubleClick={(e) => {
              if ((e.target as HTMLElement).closest('[data-note-id],input,button,textarea')) return;
              const w = toWorld(e.clientX, e.clientY);
              newAt(w.x - 24, w.y - 20);
            }}>
            <div className="rc-scaled" style={{ width: Math.round(worldW * zoom), height: Math.round(worldH * zoom) }}>
              <div className={`rc-world${L === 'l' ? ' lanes' : ''}`} style={{ width: worldW, height: worldH, transform: `scale(${zoom})` }}>
                {L === 'l' && LANES.map((lane, i) => (
                  <div key={lane.key} className={`rc-band${i % 2 ? '' : ' alt'}`} style={{ left: i * BAND, width: BAND }}>
                    <div className="rc-band-head">
                      <span className="l" style={{ color: lane.key === 'raw' ? 'var(--text-primary)' : TINT[lane.key].fg }}>{lane.label}</span>
                      <span className="n">{lane.key === 'promoted' ? promoted.length : placed.filter((it) => stageOf(it) === lane.key).length}</span>
                      <span className="h">{lane.hint}</span>
                    </div>
                  </div>
                ))}

                {tidyLabels.map((t) => (
                  <div key={`${t.label}-${t.x}`} className="rc-tidylabel" style={{ left: t.x, top: t.y }}>
                    <span className="d" style={{ background: t.color }} />
                    <span className="l">{t.label}</span>
                    <span className="n">{t.count}</span>
                  </div>
                ))}

                {hulls.map((h) => (
                  <div key={h.name} className={`rc-hull${h.on ? ' on' : ''}`} style={{ left: h.x, top: h.y, width: h.w, height: h.h }}>
                    <div className="rc-hull-bar" onPointerDown={(e) => startGroup(e, h.name)}>
                      <span className="grip">⋮⋮</span>
                      <GroupName name={h.name} onRename={(to) => renameGroup(h.name, to)} />
                      <span className="n">{h.count}</span>
                      <button className="rc-icon sm" title="Ungroup" aria-label={`Ungroup ${h.name}`} onClick={() => ungroup(h.name)}>✕</button>
                    </div>
                  </div>
                ))}

                {drawn.map((it) => {
                  const p = posOf(it.id); if (!p) return null;
                  const prom = isBoardWork(it);
                  const lane: Lane = prom ? 'promoted' : stageOf(it);
                  const on = sel.includes(it.id), dragging = !!dragPos?.has(it.id);
                  const done = it.plan.filter((s) => s.done).length;
                  return (
                    <div key={it.id} className={`rc-note${on ? ' on' : ''}${dragging ? ' dragging' : ''}${it.canvas.pinned ? ' pinned' : ''}${prom ? ' promoted' : ''}`}
                      data-note-id={it.id} data-hl={it.id} data-ghost={prom ? '1' : undefined}
                      style={{ left: p.x, top: p.y, background: TINT[lane].bg, opacity: matches(it) ? (prom ? 0.7 : 1) : 0.25 }}
                      onPointerDown={(e) => startNote(e, it.id)}>
                      <div className="top">
                        {L === 'c' && <span className="stage" style={{ color: TINT[lane].fg }}>{LANES[laneIdx(lane)].label.toUpperCase()}</span>}
                        {!prom && PRIO_RANK[it.bucket] <= 1 && <span className="prio">{it.bucket === 'highest' ? 'HIGHEST' : 'HIGH'}</span>}
                        <span className="rc-grow" />
                        <button className={`pin${it.canvas.pinned ? ' on' : ''}`} title={it.canvas.pinned ? 'Unpin' : 'Pin in place'}
                          aria-label={it.canvas.pinned ? 'Unpin' : 'Pin in place'} onClick={(e) => { e.stopPropagation(); togglePin(it); }}>
                          <PinIcon />
                        </button>
                      </div>
                      <span className="t">{it.title}</span>
                      {it.note.trim() && <span className="note">{it.note}</span>}
                      <div className="tags"><AreaTag area={it.area} dot={areaDot(it.area)} /></div>
                      <div className="foot">
                        <span className="ref">#{it.id}</span>
                        {!prom && it.plan.length > 0 && <span className="ref">☐ {done}/{it.plan.length}</span>}
                        {prom && <span className="onboard">→ on the board</span>}
                        <span className="rc-grow" />
                        {!prom && (
                          <button className="vote" title="Vote" onClick={(e) => { e.stopPropagation(); vote(it); }}>▲ {it.canvas.votes || 0}</button>
                        )}
                      </div>
                    </div>
                  );
                })}

                {draft && (
                  <div className="rc-note on" style={{ left: draft.pos.x, top: draft.pos.y, background: TINT.raw.bg, zIndex: 20 }}>
                    <textarea autoFocus rows={3} value={draft.text} placeholder="What's the idea? #area to file it"
                      onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                      onBlur={commitDraft}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') { e.preventDefault(); setDraft(null); }
                        else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitDraft(); }
                      }} />
                  </div>
                )}
              </div>
            </div>
            {drawn.length === 0 && !draft && (
              <span className="rc-blank">
                {ideas.length
                  ? 'Drag an idea from the inbox onto the canvas, or double-click anywhere to add one.'
                  : 'No ideas kept yet. Double-click anywhere to add one, or keep one in For you → Auto-ideas.'}
              </span>
            )}
          </div>

          <div className="rc-zoom">
            <button title="Zoom out (−)" aria-label="Zoom out" onClick={() => zoomTo(zoom / 1.2)}>−</button>
            <button className="pct" title="Reset to 100% (0)" onClick={() => zoomTo(1)}>{Math.round(zoom * 100)}%</button>
            <button title="Zoom in (+)" aria-label="Zoom in" onClick={() => zoomTo(zoom * 1.2)}>+</button>
            <span className="sep" />
            <button className="fit" title="Fit all notes (1)" onClick={zoomFit}>Fit</button>
          </div>

          {toast && (
            <div className="rc-toast">
              <span>{toast}</span>
              <button className="rc-textbtn link" onClick={undoTidy}>Undo</button>
              <button className="rc-icon" aria-label="Dismiss" onClick={() => setToast(null)}>✕</button>
            </div>
          )}
          {sel.length > 1 && (
            <div className="rc-multi">
              <span className="n">{sel.length} selected</span>
              <span className="sep" />
              <button className="k-btn sm accent" onClick={() => group(sel)}>Group</button>
              <button className="k-btn sm secondary" onClick={() => merge(sel)}>Merge into one</button>
              <button className="k-btn sm ghost" onClick={() => setSel([])}>Clear</button>
            </div>
          )}
        </div>

        {selected && (
          <Inspector key={selected.id} it={selected} areas={chips.filter((c) => c.key !== UNTAGGED)}
            parent={selected.parentId === null ? null : byId.get(selected.parentId) || null}
            promoted={isBoardWork(selected)} boardHref={hrefTo.detail(slug, 'roadmap', String(selected.id))}
            onClose={() => setSel([])}
            onPatch={(patch) => patchItem(selected.id, patch)}
            onStage={(st) => setStage(selected, st)}
            onPin={() => togglePin(selected)}
            onVote={() => vote(selected)}
            onLeaveGroup={() => writeCanvas([{ id: selected.id, canvas: { group: null } }])}
            onPromote={() => promote(selected.id)}
            onDiscard={() => discard(selected.id)}
            onUnplace={() => { setSel([]); writeCanvas([{ id: selected.id, canvas: { c: null, l: null } }]); }}
            onEdit={() => onEdit(selected)} />
        )}
      </div>

      {prompt && (
        <div className="rc-menu rc-prompt" style={{ left: prompt.x, top: prompt.y }} onClick={(e) => e.stopPropagation()}>
          <span className="rc-menu-intro">{prompt.text}</span>
          <button className="rc-menu-opt" onClick={() => merge([prompt.b, prompt.a])}>
            <span className="l">Merge into one note</span><span className="h">Notes, steps and votes combine. The dragged note is deleted.</span>
          </button>
          <button className="rc-menu-opt" onClick={() => group([prompt.b, prompt.a], prompt.a)}>
            <span className="l">{prompt.groupLabel}</span><span className="h">Both stay separate, boxed together.</span>
          </button>
          <button className="rc-menu-opt quiet" onClick={() => setPrompt(null)}>Just leave it here</button>
        </div>
      )}
      {ghost && <div className="rc-dragghost" style={{ left: ghost.x, top: ghost.y }}>{ghost.title}</div>}
    </div>
  );
}

function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

function AreaTag({ area, dot }: { area: string; dot: string }) {
  return (
    <span className="rc-tag">
      <span className="d" style={{ background: area ? dot : 'var(--grey-500)' }} />
      {area || 'No area'}
    </span>
  );
}

/** A group's name, edited in place and written on blur or Enter. */
function GroupName({ name, onRename }: { name: string; onRename: (to: string) => void }) {
  const [v, setV] = useState(name);
  useEffect(() => { setV(name); }, [name]);
  return (
    <input className="rc-hull-name" value={v} aria-label="Group name" size={Math.max(4, v.length + 1)}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onRename(v)}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(name); (e.target as HTMLInputElement).blur(); } }} />
  );
}

function Inspector({ it, areas, parent, promoted, boardHref, onClose, onPatch, onStage, onPin, onVote, onLeaveGroup, onPromote, onDiscard, onUnplace, onEdit }: {
  it: RoadmapItem;
  areas: { key: string; name: string; dot: string }[];
  parent: RoadmapItem | null;
  promoted: boolean;
  boardHref: string;
  onClose: () => void;
  onPatch: (patch: Parameters<typeof patchRoadmapItem>[2]) => void;
  onStage: (s: CanvasStage) => void;
  onPin: () => void;
  onVote: () => void;
  onLeaveGroup: () => void;
  onPromote: () => void;
  onDiscard: () => void;
  onUnplace: () => void;
  onEdit: () => void;
}) {
  const [title, setTitle] = useState(it.title);
  const [note, setNote] = useState(it.note);
  const [step, setStep] = useState('');
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { setTitle(it.title); }, [it.title]);
  useEffect(() => { setNote(it.note); }, [it.note]);
  const stage = stageOf(it);
  const shaped = stage === 'shaped';
  const done = it.plan.filter((s) => s.done).length;
  const setPlan = (plan: PlanStep[]) => onPatch({ plan });

  if (promoted) {
    return (
      <aside className="rc-insp" aria-label={`#${it.id}`}>
        <div className="rc-insp-head">
          <span className="ref">#{it.id}</span>
          <span className="age">· {timeAgo(it.createdAt)}</span>
          <span className="rc-grow" />
          <button className="rc-icon" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="rc-insp-body">
          <span className="rc-insp-title ro">{it.title}</span>
          {it.note.trim() && <span className="rc-insp-ro">{it.note}</span>}
        </div>
        <div className="rc-insp-foot">
          <div className="rc-onboard">
            <span>On the board as</span>
            <a href={boardHref}>#{it.id}</a>
          </div>
          <span className="rc-insp-hint">Board work now. It is edited there; here it only marks where the idea grew.</span>
          <button className="k-btn sm ghost" onClick={onUnplace}>Take off the canvas</button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="rc-insp" aria-label={`Idea #${it.id}`}>
      <div className="rc-insp-head">
        <span className="ref">#{it.id}</span>
        <span className="age">· {timeAgo(it.createdAt)}</span>
        <span className="rc-grow" />
        <button className={`rc-textbtn${it.canvas.pinned ? ' accent' : ''}`} onClick={onPin}>{it.canvas.pinned ? 'Pinned' : 'Pin'}</button>
        {/* On a `hook` row this TOMBSTONES the fingerprint (header, decision 4). */}
        <button className="rc-textbtn danger" onClick={() => (confirming ? onDiscard() : setConfirming(true))}>
          {confirming ? (it.source === 'hook' ? 'Really? The next push will not re-add it' : 'Really discard?') : 'Discard'}
        </button>
        <button className="rc-icon" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="rc-insp-body">
        <textarea className="rc-insp-title" rows={2} value={title} aria-label="Title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => { const t = title.trim(); if (t && t !== it.title) onPatch({ title: t }); else setTitle(it.title); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }} />

        <div className="rc-insp-meta">
          <span>{sourceOf(it)}</span>
          {parent && <span>· under <b>#{parent.id}</b> {parent.title}</span>}
          {it.canvas.group && (
            <span>· in group <b>{it.canvas.group}</b> <button className="rc-textbtn link inline" onClick={onLeaveGroup}>Leave group</button></span>
          )}
        </div>

        <div className="rc-field">
          <span className="rc-eyebrow">STAGE</span>
          <div className="rc-seg full">
            {LANES.slice(0, 3).map((l) => (
              <button key={l.key} className={`rc-layout${stage === l.key ? ' on' : ''}`} aria-pressed={stage === l.key}
                onClick={() => onStage(l.key as CanvasStage)}>{l.label}</button>
            ))}
          </div>
        </div>

        <div className="rc-field rc-prio">
          <div className="rc-field">
            <span className="rc-eyebrow">PRIORITY</span>
            <div className="rc-seg full">
              {PRIORITY_META.map((p) => (
                <button key={p.key} className={`rc-layout${it.bucket === p.key ? ' on' : ''}`} aria-pressed={it.bucket === p.key}
                  title={p.label} onClick={() => onPatch({ bucket: p.key })}>{p.short === 'Medium' ? 'Med' : p.short}</button>
              ))}
            </div>
          </div>
          <button className="rc-votebtn" onClick={onVote} title="Vote">▲ {it.canvas.votes || 0}</button>
        </div>

        <div className="rc-field">
          <span className="rc-eyebrow">AREA</span>
          <div className="rc-areas">
            {areas.map((a) => (
              <button key={a.key} className={`im-chip${it.area === a.name ? ' on' : ''}`} aria-pressed={it.area === a.name}
                onClick={() => onPatch({ area: it.area === a.name ? '' : a.name })}>
                <span className="km-dot" style={{ background: a.dot || 'var(--grey-500)' }} />{a.name}
              </button>
            ))}
            {areas.length === 0 && <span className="rc-insp-hint">No areas yet. Add one from the chip row.</span>}
          </div>
        </div>

        <div className="rc-field">
          <span className="rc-eyebrow">NOTES</span>
          <textarea className="rc-notes" rows={6} value={note} placeholder="Brain dump. Why, rough approach, open questions…"
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => { if (note !== it.note) onPatch({ note }); }} />
        </div>

        <div className="rc-field">
          <span className="rc-eyebrow">CHECKLIST {it.plan.length > 0 && <span className="n">{done}/{it.plan.length}</span>}</span>
          {it.plan.map((s, k) => (
            <div key={k} className="rc-check">
              <button className={`box${s.done ? ' on' : ''}`} aria-label={s.done ? 'Untick' : 'Tick'} aria-pressed={s.done}
                onClick={() => setPlan(it.plan.map((x, j) => (j === k ? { ...x, done: !x.done } : x)))} />
              <span className={`t${s.done ? ' done' : ''}`}>{s.text}</span>
              <button className="rc-icon sm" aria-label="Remove step" onClick={() => setPlan(it.plan.filter((_, j) => j !== k))}>✕</button>
            </div>
          ))}
          <input className="rc-stepin" value={step} placeholder="+ Add a step, press Enter"
            onChange={(e) => setStep(e.target.value)}
            onKeyDown={(e) => {
              const t = step.trim();
              if (e.key === 'Enter' && t) { setStep(''); setPlan([...it.plan, { text: t, done: false }]); }
            }} />
        </div>

        <button className="rc-textbtn link" onClick={onEdit}>More fields…</button>
      </div>
      <div className="rc-insp-foot">
        <button className={`k-btn ${shaped ? 'accent' : 'secondary'} rc-promote`} onClick={onPromote}>Promote to board</button>
        <span className="rc-insp-hint">
          {shaped ? 'Puts it on the board as committed work. It stays on the canvas, marked promoted.' : 'Not shaped yet. You can still promote it.'}
        </span>
      </div>
    </aside>
  );
}
