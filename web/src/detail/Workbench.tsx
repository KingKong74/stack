import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  WorkbenchCard, WorkbenchCascade, WorkbenchData, WorkbenchEdge, WorkbenchOp, WorkbenchPhase,
  WorkbenchDebrief, DebriefInsight, DebriefInsightKind,
} from '../types';
import {
  getWorkbench, addWorkbenchCard, addWorkbenchFolder, patchWorkbenchCard, deleteWorkbenchCard,
  linkWorkbenchCards, cutWorkbenchEdge, runWorkbenchOp, patchSettings,
  getWorkbenchDebrief, importWorkbenchDebrief,
} from '../store';
import {
  ROOT, SMART, SYSTEM, KIND_LABEL, childrenOf, descendantsOf, countIn, pathTo, canFileInto,
  isFolder, isSmart, isSystem, systemOf, sortCards, foldName, phasesOf, upFrom,
  mapLayout, MAP_NODE_W,
  type FolderId, type SortKey,
} from '../lib/workbenchTree';
import { go } from '../lib/route';
import { WorkbenchDesign } from './WorkbenchDesign';

// The Workbench — the planning canvas that replaced the notes wall.
//
// Notes were a pile: a wall of stickies with no way to say that two of them are
// the same thought, or that one of them became a plan. This is the same notes,
// on a ground where they can be placed, wired and worked — with Polaris ideas
// pulled in beside them and the ✧ ops rail turning a rough card into
// directions, a phased plan, a counter-case.
//
// What is REAL here: the notes are notes (⌘K finds them, → Bug still promotes
// them), the ideas are Polaris ideas, and Promote → Roadmap writes real items.
// What is a SUGGESTION: everything an op produces. It lands as a card the owner
// keeps, edits or cuts — nothing an op says changes tracker state on its own.
//
// Geometry lives in this file. Card positions are field coordinates; the field
// is one CSS transform, which is why wheel-zoom can anchor exactly on the
// cursor here (the galaxy re-lays-out per zoom and deliberately cannot).
//
// #414 PUT A FOLDER TREE UNDER ALL OF IT, and the shape of that is in
// lib/workbenchTree.ts — read its header first. What belongs HERE and not there
// is the consequence for this screen: the canvas draws ONE FOLDER AT A TIME.
// `cwd` is which, and a card's x/y are read inside it, so the same coordinates
// in two folders are two different places and filing a card never has to move
// it. A wire whose other end is in another folder is not drawn — a line running
// off to a card you cannot see is a thread the canvas cannot tell you about —
// and the status bar counts what that hides rather than letting it go quiet.

const Z_MIN = 0.4;
const Z_MAX = 2;
const GRID = 26;

// The three ways to look at a folder. Canvas is the original Workbench and
// stays the default; the other two are for a folder holding more than a screen
// of work, where position stops being the thing you are reading by.
type View = 'canvas' | 'tiles' | 'details' | 'map';
const VIEWS: { key: View; label: string }[] = [
  { key: 'canvas', label: 'Canvas' },
  { key: 'tiles', label: 'Tiles' },
  { key: 'details', label: 'Details' },
  { key: 'map', label: 'Map' },
];
// Which views are a ZOOMABLE SPACE rather than a list. The wheel, the zoom chip
// and the minimap all key off this one predicate, so they cannot end up
// disagreeing about whether the thing on screen can be zoomed.
const spatial = (v: View) => v === 'canvas' || v === 'map';

// A deep-link's hl token is a NOTE id (bare, ⌘K's form) or a FUTURE id
// (f<id>, a pulled Polaris idea) — the two tables' ids collide, so the form is
// what tells them apart. Resolved to a card once, so the centring effect and
// the per-card highlight prop can never disagree.
const matchHighlight = (cards: WorkbenchCard[], token: string): WorkbenchCard | undefined => {
  const future = /^f(\d+)$/.exec(token);
  if (future) {
    const futureId = Number(future[1]);
    return cards.find((c) => c.futureId === futureId);
  }
  return cards.find((c) => String(c.noteId) === token);
};

// The hint under each op. Deliberately narrower than the design's copy for two
// of them: Gemini cannot read the repository, so 'Ask' answers from the project
// RECORD (roadmap, bugs, notes, the files recent sessions touched) and 'Touches'
// reasons from those same files. Promising the codebase would be a lie the
// answers then have to live up to.
const OP_HINT: Record<WorkbenchOp, string> = {
  expand: 'rough idea → structured directions',
  cluster: 'group the canvas, flag duplicates',
  plan: 'phases, gates, sequencing',
  blast: 'effort, risk, what it destabilises',
  touches: 'files and open bugs it collides with',
  critique: 'argue against this',
  ask: 'question the project record',
};

type LogEntry = { when: string; t: string };

type PolarisFilter = 'unpicked' | 'recent' | 'all';
const POLARIS_FILTERS: { key: PolarisFilter; label: string }[] = [
  { key: 'unpicked', label: 'Unpicked' },
  { key: 'recent', label: 'Recent' },
  { key: 'all', label: 'All' },
];
// What "Recent" means in the picker. A fortnight, and its own constant rather
// than borrowing util.js's STALE_DAYS — that one is the deck's stale threshold
// and coupling the two would make a change to one silently move the other.
const RECENT_DAYS = 14;

type DebriefFilter = 'new' | 'advisor' | 'all';
const DEBRIEF_FILTERS: { key: DebriefFilter; label: string }[] = [
  { key: 'new', label: 'New' },
  { key: 'advisor', label: 'Advisor' },
  { key: 'all', label: 'All' },
];
// Glyph + label for an insight's KIND — kept beside the filters it sits next
// to, the same way OP_HINT sits beside the ops it labels.
const DEBRIEF_KIND: Record<DebriefInsightKind, string> = {
  blocker: '⚠ blocker', 'next-step': '→ next', advisor: '◈ advisor', note: '· debrief',
};
const DEBRIEF_FROM: Record<DebriefInsight['from'], string> = {
  session: 'session', reviewer: 'reviewer', architect: 'architect', debrief: 'the debrief prose',
};

export function Workbench({
  slug, projectName, geminiReady, highlightId, notesNonce, onPromoteNote, onPromotePlan,
}: {
  slug: string;
  projectName: string;             // names the root crumb — the tree has no root row (#414)
  geminiReady: boolean;
  highlightId?: string | null;      // a NOTE id (⌘K) or f<futureId> (a Polaris-idea deep-link)
  notesNonce: number;               // bumped when a note is deleted elsewhere
  onPromoteNote: (noteId: number, text: string, kind: 'bug' | 'roadmap') => void;
  onPromotePlan: (phases: WorkbenchPhase[]) => Promise<boolean>;
}) {
  const [data, setData] = useState<WorkbenchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [sel, setSel] = useState<number | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rail, setRail] = useState(true);

  // ---- the explorer (#414) ----
  // `hist` + `hi` are a browser history, not a stack: Back then a new folder
  // truncates the forward end, which is the behaviour every file browser has
  // and the one thing a plain stack gets wrong.
  const [cwd, setCwd] = useState<FolderId>(ROOT);
  const [hist, setHist] = useState<FolderId[]>([ROOT]);
  const [hi, setHi] = useState(0);
  // The last folder that can actually HOLD a card. A smart or system folder
  // cannot, so anything made while one is open has to land somewhere real —
  // and the somewhere it should land is where you were last working, not the
  // root by default. Kept beside `cwd` rather than derived from history,
  // because history contains the unholdable ones too.
  const [lastRealFolder, setLastRealFolder] = useState<FolderId>(ROOT);
  const [view, setView] = useState<View>('canvas');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [tree, setTree] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // The card being dragged, and the folder it is currently over. Both are
  // pointer-lifetime state and deliberately not refs: the drop target has to
  // RE-RENDER to show it will accept, and a ref cannot do that.
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<FolderId | null>(null);
  // A second selection, for folding several cards into one. Separate from
  // `sel`, which is the ops rail's subject and is exactly one card — merging
  // them would make every ops button ambiguous the moment two things are ticked.
  const [marked, setMarked] = useState<Set<number>>(new Set());
  // Which map nodes are shut. A way of LOOKING at the tree, like a scroll
  // position — not stored, so two panes on the same map may differ.
  const [mapShut, setMapShut] = useState<Set<number>>(new Set());
  const [full, setFull] = useState(false);
  const [minimap, setMinimap] = useState(true);
  // THE SIDE PANE (#415). Its own folder and its own view, because the whole
  // point is looking at two places at once — sharing either would make it a
  // mirror rather than a second pane. Deliberately LIST-ONLY: the canvas's pan,
  // zoom, wheel listener and measured card heights are attached to one ground
  // element, and a second live canvas needs all four duplicated. Dragging works
  // ACROSS the split regardless, because the lists are HTML5 drag targets and
  // that is what the split is actually for.
  const [split, setSplit] = useState(false);
  const [cwd2, setCwd2] = useState<FolderId>(ROOT);
  const [view2, setView2] = useState<Exclude<View, 'canvas'>>('tiles');
  const [hotEdge, setHotEdge] = useState<number | null>(null);
  const [linking, setLinking] = useState<number | null>(null);
  const [busyOp, setBusyOp] = useState<WorkbenchOp | null>(null);
  // ✧ ops model choice — app-wide (workbenchModel in Settings), not per-project.
  // Seeded from the payload each load; changed optimistically and persisted
  // by a settings PATCH, reverted if that PATCH fails.
  const [model, setModel] = useState('');
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [lastGen, setLastGen] = useState<number | null>(null);

  // Focus mode: dim everything not attached to the selection. On a canvas that
  // has been worked for a while this is the only way to read one thread.
  const [focus, setFocus] = useState(false);
  // The pull-from-Polaris picker.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pQuery, setPQuery] = useState('');
  const [pFilter, setPFilter] = useState<PolarisFilter>('unpicked');
  const [picked, setPicked] = useState<Set<number>>(new Set());

  // The pull-from-debrief picker. Loaded lazily on first open, not with the
  // tab — most sessions on this project never touch it, and a night's account
  // is a heavier read than the Polaris list already sitting in `data`.
  const [debriefOpen, setDebriefOpen] = useState(false);
  const [debrief, setDebrief] = useState<WorkbenchDebrief | null>(null);
  const [debriefLoading, setDebriefLoading] = useState(false);
  const [dQuery, setDQuery] = useState('');
  const [dFilter, setDFilter] = useState<DebriefFilter>('new');
  const [dPicked, setDPicked] = useState<Set<string>>(new Set());

  const groundRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef(pan); panRef.current = pan;
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  // The pointer-drag closure outlives the render that made it, so it reads the
  // card list through a ref — a captured array would be one drag out of date
  // and would test the drop against a tree that has since changed.
  const allCardsRef = useRef<WorkbenchCard[]>([]);
  allCardsRef.current = data?.cards ?? [];
  // The wheel listener is attached once, so it reads "is this a zoomable view"
  // through a ref rather than closing over a value it would then hold stale.
  const spatialRef = useRef(true);
  // Measured card heights, keyed by card id. Edges attach to a card's middle and
  // op output stacks under the last one, and both need the height the browser
  // actually gave a card — not one we guessed from its content.
  const nodeRef = useRef<Record<number, HTMLDivElement | null>>({});
  const [heights, setHeights] = useState<Record<number, number>>({});

  // Closing drops the ticks too: a selection you left behind and forgot would
  // pull an idea you didn't mean to the next time you opened the panel.
  const closePicker = useCallback(() => {
    setPickerOpen(false);
    setPicked(new Set());
    setPQuery('');
  }, []);

  // Same rule for the debrief picker — and the two are mutually exclusive, so
  // opening either one first closes the other rather than stacking two panels
  // over the same dock corner.
  const closeDebrief = useCallback(() => {
    setDebriefOpen(false);
    setDPicked(new Set());
    setDQuery('');
  }, []);
  const openPicker = useCallback(() => { closeDebrief(); setPickerOpen(true); }, [closeDebrief]);

  // A wall-clock stamp rather than "now / 1m / 5m": this log is not re-rendered
  // on a timer, so a relative age would freeze at whatever it said when it was
  // written and quietly become wrong.
  const say = useCallback((t: string) => {
    const when = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setLog((prev) => [{ when, t }, ...prev].slice(0, 40));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    return getWorkbench(slug)
      .then((d) => { setData(d); setModel(d.model); setError(''); })
      .catch((e) => setError((e as Error)?.message || 'Failed to load the workbench.'))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => { void load(); }, [load, notesNonce]);

  // ---- measurement ----
  // Keyed on what can actually CHANGE a card's height — which cards exist, how
  // wide they are, and their content. Deliberately not on x/y: measuring every
  // render would force a reflow on every frame of a drag, for a number that
  // cannot have moved.
  const shape = (data?.cards ?? [])
    .map((c) => `${c.id}:${c.w}:${c.title.length}:${JSON.stringify(c.body).length}`).join('|');
  useLayoutEffect(() => {
    const ids = Object.keys(nodeRef.current);
    if (!ids.length) return;
    setHeights((prev) => {
      const next: Record<number, number> = {};
      let changed = false;
      for (const key of ids) {
        const id = Number(key);
        const el = nodeRef.current[id];
        if (!el) continue;
        next[id] = el.offsetHeight;
        if (prev[id] !== next[id]) changed = true;
      }
      return changed || Object.keys(prev).length !== Object.keys(next).length ? next : prev;
    });
  }, [shape]);

  const hOf = useCallback((c: WorkbenchCard) => heights[c.id] || 120, [heights]);

  // Esc backs out of whatever mode you are in, in the order you'd want it to.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (full) { setFull(false); return; }
      if (debriefOpen) closeDebrief();
      else if (pickerOpen) closePicker();
      else if (linking !== null) setLinking(null);
      else if (asking) { setAsking(false); setQuestion(''); }
      else if (focus) setFocus(false);
      else setSel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [linking, asking, pickerOpen, debriefOpen, focus, full, closePicker, closeDebrief]);

  // ---- pan + zoom ----
  // Native wheel listener with passive:false, so the page never scrolls out
  // from under the canvas mid-zoom.
  //
  // KEYED ON THE GROUND EXISTING, not on mount. This effect used to run once
  // with `[]` — and the first render is the LOADING state, which has no canvas
  // in it, so `groundRef.current` was null, the effect bailed, and it never ran
  // again. Wheel zoom was silently dead from the moment the loading state was
  // added: the buttons still worked, so it read as a preference rather than a
  // bug. Anything reaching for a DOM node that appears after a fetch has this
  // hazard; the fix is to depend on the node being there.
  const groundReady = !loading || !!data;
  useEffect(() => {
    const el = groundRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Only a spatial view zooms; a list scrolls, and hijacking its wheel
      // would make Details unreadable below the fold.
      if (!spatialRef.current) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const z0 = zoomRef.current;
      const nz = Math.min(Z_MAX, Math.max(Z_MIN, z0 * Math.exp(-e.deltaY * 0.0016)));
      if (Math.abs(nz - z0) < 0.0005) return;
      const k = nz / z0;
      const p = panRef.current;
      setZoom(nz);
      setPan({ x: mx - (mx - p.x) * k, y: my - (my - p.y) * k });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [groundReady]);

  const zoomBy = (f: number) => {
    const el = groundRef.current;
    const w = el ? el.clientWidth / 2 : 500;
    const h = el ? el.clientHeight / 2 : 380;
    const z0 = zoomRef.current;
    const nz = Math.min(Z_MAX, Math.max(Z_MIN, z0 * f));
    const k = nz / z0;
    const p = panRef.current;
    setZoom(nz);
    setPan({ x: w - (w - p.x) * k, y: h - (h - p.y) * k });
  };

  // Screen point -> field coordinate, so a card lands where it was dropped.
  const toField = (clientX: number, clientY: number) => {
    const r = groundRef.current?.getBoundingClientRect();
    const p = panRef.current;
    const z = zoomRef.current;
    return {
      x: Math.round(((clientX - (r?.left ?? 0)) - p.x) / z),
      y: Math.round(((clientY - (r?.top ?? 0)) - p.y) / z),
    };
  };

  // Where a new card should go when nothing said: the middle of the view.
  const centreOfView = () => {
    const el = groundRef.current;
    const r = el?.getBoundingClientRect();
    return toField((r?.left ?? 0) + (el?.clientWidth ?? 800) / 2 - 120,
      (r?.top ?? 0) + (el?.clientHeight ?? 600) / 2 - 60);
  };

  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (linking !== null) { setLinking(null); return; }
    setSel(null);
    const x0 = e.clientX, y0 = e.clientY;
    const p0 = panRef.current;
    const move = (ev: PointerEvent) => setPan({ x: p0.x + ev.clientX - x0, y: p0.y + ev.clientY - y0 });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Dragging a card moves it locally at pointer speed and persists ONCE on
  // release — a PATCH per frame would be a write storm for a position nobody
  // has finished choosing yet.
  //
  // THE CANVAS DOES NOT USE HTML5 DRAG (#414), and that is not an oversight.
  // Setting `draggable` on a card would hand mousedown to the native drag,
  // which suppresses pointermove — the card would stop being movable at all.
  // So filing from the canvas is decided HERE, on release: whatever folder card
  // is under the pointer takes the drop. The Explorer, the tiles and the rows
  // are plain lists with no positions to defend, so those DO use HTML5 drag.
  const startDrag = (e: React.PointerEvent, card: WorkbenchCard) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (linking !== null && linking !== card.id) { void wire(linking, card.id); return; }
    // ⌘/Ctrl-click marks rather than selects: marking is how a Fold is built,
    // and it has to be reachable on the canvas too, not only in the lists.
    if (e.metaKey || e.ctrlKey) {
      setMarked((prev) => {
        const next = new Set(prev);
        if (next.has(card.id)) next.delete(card.id); else next.add(card.id);
        return next;
      });
      return;
    }
    setSel(card.id);
    const x0 = e.clientX, y0 = e.clientY;
    const c0 = { x: card.x, y: card.y };
    // The final position is tracked here rather than read back out of state on
    // release: a state updater that also fires a request runs twice under
    // StrictMode, and that would be two PATCHes for one drag.
    const at = { ...c0 };
    let moved = false;
    // Which folder card the pointer is currently over, if any. Read off the
    // DOM rather than from the card coordinates: the cards under the cursor are
    // exactly what the browser already knows, and recomputing hit boxes through
    // a pan and a zoom is arithmetic that only has to be wrong once.
    const folderUnder = (ev: { clientX: number; clientY: number }): number | null => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const host = el?.closest?.('[data-folder-id]') as HTMLElement | null | undefined;
      const id = host ? Number(host.dataset.folderId) : NaN;
      return Number.isFinite(id) && id !== card.id ? id : null;
    };
    const move = (ev: PointerEvent) => {
      const z = zoomRef.current;
      const nx = Math.round(c0.x + (ev.clientX - x0) / z);
      const ny = Math.round(c0.y + (ev.clientY - y0) / z);
      if (!moved && Math.abs(nx - c0.x) < 2 && Math.abs(ny - c0.y) < 2) return;
      moved = true;
      at.x = nx; at.y = ny;
      setData((d) => (d ? { ...d, cards: d.cards.map((c) => (c.id === card.id ? { ...c, x: nx, y: ny } : c)) } : d));
      // Light the folder up only if it would actually take the card.
      const hit = folderUnder(ev);
      const ok = hit !== null && canFileInto(allCardsRef.current, card.id, hit);
      setOver(ok ? hit : null);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) return;
      const hit = folderUnder(ev);
      if (hit !== null && canFileInto(allCardsRef.current, card.id, hit)) {
        // Dropped ONTO a folder: file it, and leave the position alone. The
        // card is about to stop being drawn here, so persisting where it was
        // let go would write a coordinate inside a folder it never sat in.
        setOver(null);
        void fileInto(card.id, hit);
        return;
      }
      setOver(null);
      void patchWorkbenchCard(slug, card.id, { x: at.x, y: at.y }).catch(() => {});
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---- mutations ----
  const guard = async (fn: () => Promise<void>) => {
    try { setError(''); await fn(); }
    catch (e) { setError((e as Error)?.message || 'Something went wrong.'); }
  };

  // ---- navigation (#414) ----
  // Every arrival clears the selection, the search box and the marks. They are
  // all statements about the folder you were in, and carrying a tick from one
  // folder into another is how a Fold ends up eating a card nobody can see.
  const arrive = useCallback((next: FolderId) => {
    setCwd(next);
    if (!isSmart(next) && !isSystem(next)) setLastRealFolder(next);
    setSel(null);
    setMarked(new Set());
    setQuery('');
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }, []);

  const navigate = useCallback((next: FolderId) => {
    setHist((prev) => {
      const cut = prev.slice(0, hi + 1);
      // Re-entering the folder you are already in is not a history entry.
      if (cut[cut.length - 1] === next) return prev;
      setHi(cut.length);
      return [...cut, next];
    });
    arrive(next);
  }, [hi, arrive]);

  const back = useCallback(() => {
    if (hi <= 0) return;
    setHi(hi - 1);
    arrive(hist[hi - 1]);
  }, [hi, hist, arrive]);

  const forward = useCallback(() => {
    if (hi >= hist.length - 1) return;
    setHi(hi + 1);
    arrive(hist[hi + 1]);
  }, [hi, hist, arrive]);

  // Sets the choice immediately (an in-flight op sees it disabled, never a
  // stale value slipping through) and persists it as the app-wide default;
  // a failed save reports through the same banner as every other mutation and
  // rolls the picker back to what actually stuck.
  const changeModel = (next: string) => {
    const prev = model;
    setModel(next);
    void guard(async () => {
      try { await patchSettings({ workbenchModel: next }); }
      catch (e) { setModel(prev); throw e; }
    });
  };

  // Neither a smart folder nor a system one can hold a card, so anything made
  // while one is open lands in the last folder that CAN — which is where you
  // were working, not the root. Making it at the root instead would be correct
  // and still feel like the card went missing (#414, #415).
  const folderForNew = (): number | null => (typeof cwd === 'number' ? cwd
    : typeof lastRealFolder === 'number' ? lastRealFolder : null);

  const addNote = () => guard(async () => {
    const at = centreOfView();
    const text = 'New note';
    const card = await addWorkbenchCard(slug, {
      kind: 'note', text, x: at.x, y: at.y, parentId: folderForNew(),
    });
    setData((d) => (d ? { ...d, cards: [...d.cards, card] } : d));
    setSel(card.id);
    say('Added a note. Click its text to write it.');
  });

  // ---- folders (#414) ----
  const newFolder = () => guard(async () => {
    const at = centreOfView();
    const card = await addWorkbenchFolder(slug, {
      title: 'New folder', parentId: folderForNew(), x: at.x, y: at.y,
    });
    setData((d) => (d ? { ...d, cards: [...d.cards, card] } : d));
    setSel(card.id);
    say(`Folder made in ${crumbs[crumbs.length - 1]?.name ?? 'the workbench'}. Click its name to rename it.`);
  });

  // Refile one card, or the whole marked set if the dragged card is part of it.
  // Each move is its own PATCH and the server may refuse any of them, so the
  // state is rebuilt from what came BACK rather than from what was sent — a
  // refused move that still redrew as moved is the one failure this must not
  // have.
  const fileInto = (cardId: number, target: FolderId) => guard(async () => {
    // Neither a query nor a read-only view is a place. Refused here as well as
    // in canFileInto so no caller can reach the PATCH with one of them.
    if (isSmart(target) || isSystem(target)) return;
    const ids = marked.has(cardId) ? [...marked] : [cardId];
    const movable = ids.filter((id) => canFileInto(allCards, id, target));
    setOver(null);
    setDragging(null);
    if (!movable.length) return;
    const moved = await Promise.all(movable.map((id) =>
      patchWorkbenchCard(slug, id, { parentId: target })));
    setData((d) => (d ? {
      ...d,
      cards: d.cards.map((c) => moved.find((m) => m.id === c.id) ?? c),
    } : d));
    setMarked(new Set());
    const landed = moved.filter((m) => m.parentId === (typeof target === 'number' ? target : null));
    const name = target === ROOT ? 'the workbench'
      : `“${allCards.find((c) => c.id === target)?.title || 'folder'}”`;
    if (!landed.length) say('Nothing moved — that folder cannot hold those cards.');
    else say(`Filed ${landed.length} ${landed.length === 1 ? 'card' : 'cards'} into ${name}.`);
  });

  // Fold the marked cards into a new folder that takes the anchor's place on
  // the canvas — the pile stays where you were looking, which is the whole
  // point of folding rather than filing.
  const foldMarked = () => guard(async () => {
    const ids = [...marked];
    if (ids.length < 2) return;
    const members = ids.map((id) => allCards.find((c) => c.id === id)).filter(Boolean) as WorkbenchCard[];
    if (members.length < 2) return;
    const anchor = members[0];
    const folder = await addWorkbenchFolder(slug, {
      title: foldName(anchor.title, members.length),
      parentId: folderForNew(),
      x: anchor.x,
      y: anchor.y,
    });
    const moved = await Promise.all(members.map((m) =>
      patchWorkbenchCard(slug, m.id, { parentId: folder.id })));
    setData((d) => (d ? {
      ...d,
      cards: [...d.cards.map((c) => moved.find((m) => m.id === c.id) ?? c), folder],
    } : d));
    setMarked(new Set());
    setSel(folder.id);
    say(`Folded ${moved.length} cards into “${folder.title}”.`);
  });

  // Promote a folder's contents to the Roadmap as phases. It goes through the
  // same dialog a plan card's Ship does — one promote path, one place the
  // owner edits what is about to be written.
  const promoteFolder = (folder: WorkbenchCard) => guard(async () => {
    const phases = phasesOf(allCards, folder.id, folder.title || 'Folder');
    const ok = await onPromotePlan(phases);
    if (!ok) return;
    say(`“${folder.title}” promoted — ${phases.length} ${phases.length === 1 ? 'phase' : 'phases'} on the Roadmap.`);
  });

  // A design pasted back from a Claude session. It stacks where an ✧ op's
  // output stacks — it IS output on the same thread — and it comes back as a
  // real note, because that is the only kind of card the canvas lets the client
  // make and the only one whose words are the human's own.
  const pasteDesign = (into: WorkbenchCard, text: string) => guard(async () => {
    const prev = lastGen != null ? data?.cards.find((c) => c.id === lastGen) : null;
    let at = prev
      ? { x: prev.x, y: prev.y + hOf(prev) + 22 }
      : { x: into.x + into.w + 60, y: into.y };
    if (prev && at.y > prev.y + 620) at = { x: prev.x + 348, y: into.y };
    const card = await addWorkbenchCard(slug, { kind: 'note', text, x: at.x, y: at.y });
    const edge = await linkWorkbenchCards(slug, into.id, card.id);
    setData((d) => (d ? { ...d, cards: [...d.cards, card], edges: [...d.edges, edge] } : d));
    setSel(card.id);
    setLastGen(card.id);
    say(`Design pasted back as a note, wired to “${into.title.slice(0, 34)}${into.title.length > 34 ? '…' : ''}”.`);
  });

  // Pull the whole selection in one go, laid out in a column of four that steps
  // sideways — a batch dumped on one spot is a stack you then have to unpile.
  // Each idea is its own POST (the route is per-card and already pinned); they
  // go concurrently because their positions are decided here, not server-side.
  const pullPicked = () => guard(async () => {
    const ids = [...picked];
    if (!ids.length) return;
    const at = centreOfView();
    const settled = await Promise.allSettled(ids.map((futureId, i) => addWorkbenchCard(slug, {
      kind: 'polaris', futureId,
      x: at.x + Math.floor(i / 4) * 268,
      y: at.y + (i % 4) * 128,
    })));
    const made = settled
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof addWorkbenchCard>>> => r.status === 'fulfilled')
      .map((r) => r.value);
    const failed = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (!made.length) throw (failed[0]?.reason ?? new Error('Something went wrong.'));
    const pulled = new Set(ids);
    // A star's pull cascades its planets in alongside it (#326). Dedupe by id
    // when merging — two picked stars can't share a planet (an idea has one
    // parent) but a planet could in principle arrive both picked directly and
    // cascaded in by its star in the same batch.
    const cascadedCards = made.flatMap((c) => c.cascaded?.cards ?? []);
    const cascadedEdges = made.flatMap((c) => c.cascaded?.edges ?? []);
    const cascadedFutureIds = new Set(cascadedCards.map((c) => c.futureId));
    const capped = made
      .filter((c) => c.cascaded && c.cascaded.total > c.cascaded.placed)
      .map((c) => c.cascaded as WorkbenchCascade);
    setData((d) => {
      if (!d) return d;
      const cardIds = new Set(d.cards.map((c) => c.id));
      const edgeIds = new Set(d.edges.map((e) => e.id));
      const newCards: WorkbenchCard[] = [];
      for (const c of [...made, ...cascadedCards]) {
        if (cardIds.has(c.id)) continue;
        cardIds.add(c.id);
        newCards.push(c);
      }
      const newEdges: WorkbenchEdge[] = [];
      for (const e of cascadedEdges) {
        if (edgeIds.has(e.id)) continue;
        edgeIds.add(e.id);
        newEdges.push(e);
      }
      return {
        ...d,
        cards: [...d.cards, ...newCards],
        edges: [...d.edges, ...newEdges],
        polaris: d.polaris.map((p) => (
          pulled.has(p.id) || cascadedFutureIds.has(p.id) ? { ...p, onCanvas: true } : p)),
      };
    });
    setPicked(new Set());
    setPickerOpen(false);
    setSel(made[0].id);
    say(`Pulled ${made.map((c) => c.meta).join(', ')} in from Polaris.`);
    if (capped.length) {
      const placed = capped.reduce((n, c) => n + c.placed, 0);
      const total = capped.reduce((n, c) => n + c.total, 0);
      say(`Placed ${placed} of ${total} planets — the rest are still in the tray.`);
    }
    if (failed.length) {
      const reasons = failed
        .map((r) => (r.reason as Error)?.message || 'Something went wrong.')
        .join('; ');
      say(`${failed.length} of ${ids.length} did not land: ${reasons}`);
    }
  });

  // Opens the debrief picker and loads it on first open only — the tab does
  // not warm it, and a re-open reuses what is already in state rather than
  // re-reading a night's account every time the dock button is pressed.
  const openDebrief = () => {
    closePicker();
    setDebriefOpen(true);
    if (debrief || debriefLoading) return;
    setDebriefLoading(true);
    void guard(async () => {
      const d = await getWorkbenchDebrief(slug);
      setDebrief(d);
    }).finally(() => setDebriefLoading(false));
  };

  // Land the ticked insights in one POST, laid out exactly like `pullPicked` —
  // same origin, same column-of-four step, so the two pickers feel like the
  // same object dropping cards on the same ground.
  const importPicked = (as: 'note' | 'idea') => guard(async () => {
    const keys = [...dPicked];
    if (!keys.length || !debrief) return;
    const at = centreOfView();
    const picks = keys.map((key, i) => ({
      key,
      x: at.x + Math.floor(i / 4) * 268,
      y: at.y + (i % 4) * 128,
    }));
    const { cards: made, skipped } = await importWorkbenchDebrief(slug, { as, picks });
    if (made.length) {
      setData((d) => (d ? { ...d, cards: [...d.cards, ...made] } : d));
      setSel(made[0].id);
    }
    // The picks that DID land — a key can come back in `skipped` instead, and
    // that key must not be flipped as if it landed.
    const skippedKeys = new Set(skipped.map((s) => s.key));
    const landed = keys.filter((k) => !skippedKeys.has(k));
    const landedSet = new Set(landed);
    setDebrief((d) => (d ? {
      ...d,
      nights: d.nights.map((n) => ({
        ...n,
        insights: n.insights.map((ins) => (landedSet.has(ins.key)
          ? { ...ins, imported: true, importedAs: as } : ins)),
      })),
    } : d));
    setDPicked(new Set());
    setDebriefOpen(false);
    setDQuery('');
    if (landed.length) {
      const nights = debrief.nights.filter((n) => n.insights.some((ins) => landedSet.has(ins.key)));
      const from = nights.length === 1 ? `the ${nights[0].day} night`
        : nights.length > 1 ? `${nights.length} nights` : 'the debrief';
      say(`Imported ${landed.length} insight${landed.length > 1 ? 's' : ''} from ${from} as ${as === 'note' ? 'notes' : 'ideas'}.`);
    }
    // A refusal that is swallowed leaves a button that silently does nothing —
    // every skip is reported, verbatim, in the reason the server gave.
    for (const s of skipped) say(s.why);
  });

  const saveTitle = (card: WorkbenchCard, title: string) => {
    const next = title.trim();
    if (!next || next === card.title) return;
    void guard(async () => {
      const updated = await patchWorkbenchCard(slug, card.id, { title: next });
      setData((d) => (d ? { ...d, cards: d.cards.map((c) => (c.id === card.id ? updated : c)) } : d));
    });
  };

  const saveBody = (card: WorkbenchCard, body: WorkbenchCard['body']) => {
    // Optimistic: the plan card is edited a field at a time and waiting on a
    // round-trip per keystroke-blur would make it feel broken.
    setData((d) => (d ? { ...d, cards: d.cards.map((c) => (c.id === card.id ? { ...c, body } : c)) } : d));
    void patchWorkbenchCard(slug, card.id, { body }).catch(() => {});
  };

  const dropCard = (card: WorkbenchCard) => guard(async () => {
    const res = await deleteWorkbenchCard(slug, card.id);
    const gone = new Set(res.dropped);
    // A deleted FOLDER lifts its contents rather than taking them with it, so
    // the ones it held have to be re-parented HERE too. Dropping the folder and
    // leaving its children pointing at it would strand them: nothing draws a
    // card whose parent is not there, so the work would simply vanish from the
    // canvas until the next reload (#414).
    const lifted = new Set(res.lifted ?? []);
    const liftedTo = res.liftedTo ?? null;
    setData((d) => (d ? {
      ...d,
      cards: d.cards
        .filter((c) => !gone.has(c.id))
        .map((c) => (lifted.has(c.id) ? { ...c, parentId: liftedTo } : c)),
      edges: d.edges.filter((e) => !gone.has(e.a) && !gone.has(e.b)),
      // The idea itself never left — it just becomes pickable again.
      polaris: res.returnedToTray
        ? d.polaris.map((p) => (p.id === res.returnedToTray ? { ...p, onCanvas: false } : p))
        : d.polaris,
    } : d));
    if (sel != null && gone.has(sel)) setSel(null);
    // Standing inside a folder that has just been deleted is a dead end — the
    // breadcrumb would name something that no longer exists.
    if (cwd === card.id) navigate(liftedTo);
    say(card.kind === 'polaris'
      ? `Took ${card.meta} off the canvas. The idea is untouched.`
      : lifted.size
        ? `Removed the folder. Its ${lifted.size} card${lifted.size > 1 ? 's' : ''} moved up a level — nothing inside was deleted.`
        : `Removed ${gone.size} card${gone.size > 1 ? 's' : ''}.`);
  });

  const wire = (a: number, b: number) => guard(async () => {
    setLinking(null);
    const edge = await linkWorkbenchCards(slug, a, b);
    setData((d) => (d ? { ...d, edges: [...d.edges, edge] } : d));
    say('Wired two cards together.');
  });

  const cut = (edgeId: number) => guard(async () => {
    const res = await cutWorkbenchEdge(slug, edgeId);
    const gone = new Set(res.dropped);
    setData((d) => (d ? {
      ...d,
      cards: d.cards.filter((c) => !gone.has(c.id)),
      edges: d.edges.filter((e) => e.id !== edgeId && !gone.has(e.a) && !gone.has(e.b)),
    } : d));
    setHotEdge(null);
    if (sel != null && gone.has(sel)) setSel(null);
    say(gone.size
      ? `Cut the line — dropped ${gone.size} card${gone.size > 1 ? 's' : ''} it fed.`
      : 'Cut the line. Both cards kept.');
  });

  const runOp = (op: WorkbenchOp) => {
    const card = data?.cards.find((c) => c.id === sel);
    if (!card) return;
    if (op === 'ask' && !asking) { setAsking(true); return; }
    const q = op === 'ask' ? question.trim() : '';
    if (op === 'ask' && !q) return;
    setBusyOp(op);
    void guard(async () => {
      // Stack under the last thing generated, wrapping to a new column when the
      // stack runs long; otherwise sit to the right of the card it came from.
      const prev = lastGen != null ? data?.cards.find((c) => c.id === lastGen) : null;
      let at = prev
        ? { x: prev.x, y: prev.y + hOf(prev) + 22 }
        : { x: card.x + card.w + 60, y: card.y };
      if (prev && at.y > prev.y + 620) at = { x: prev.x + 348, y: card.y };
      try {
        const { card: made, edge } = await runWorkbenchOp(slug, {
          op, cardId: card.id, ...at, question: q || undefined, model: model || undefined,
        });
        setData((d) => (d ? { ...d, cards: [...d.cards, made], edges: [...d.edges, edge] } : d));
        setSel(made.id);
        setLastGen(made.id);
        setAsking(false);
        setQuestion('');
        say(`${OP_LABEL[op]} on “${card.title.slice(0, 34)}${card.title.length > 34 ? '…' : ''}”`);
      } finally {
        setBusyOp(null);
      }
    });
  };

  const shipPlan = (card: WorkbenchCard) => guard(async () => {
    const phases = card.body.phases || [];
    if (!phases.length || card.body.shipped) return;
    const ok = await onPromotePlan(phases);
    if (!ok) return;
    saveBody(card, { ...card.body, shipped: true });
    say(`${phases.length} phases promoted to the Roadmap as ${phases.map((p) => p.bucket).join(' / ')}.`);
  });

  // ---- a deep-link (⌘K's note id, or a sidebar's f<futureId>) finds its card ----
  const highlightedCard = useMemo(
    () => (data && highlightId ? matchHighlight(data.cards, highlightId) : undefined),
    [data, highlightId],
  );
  const centred = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightId || !highlightedCard || centred.current === highlightId) return;
    const card = highlightedCard;
    centred.current = highlightId;
    setSel(card.id);
    const el = groundRef.current;
    setZoom(1);
    setPan({
      x: (el?.clientWidth ?? 900) / 2 - card.x - card.w / 2,
      y: (el?.clientHeight ?? 600) / 2 - card.y - 60,
    });
  }, [highlightedCard, highlightId]);

  // ---- what is attached to the selection ----
  // One breadth-first walk out from the selected card, in BOTH directions along
  // every edge, giving each reachable card its hop count. The rail's "attached"
  // list and focus mode's dimming are two readings of this one map, which is
  // why it is computed once here rather than twice where it is used.
  const attached = useMemo(() => {
    const reach = new Map<number, number>();
    if (!data || sel == null) return reach;
    const byId = new Set(data.cards.map((c) => c.id));
    if (!byId.has(sel)) return reach;
    reach.set(sel, 0);
    const queue = [sel];
    while (queue.length) {
      const id = queue.shift() as number;
      const depth = reach.get(id) as number;
      for (const e of data.edges) {
        const nb = e.a === id ? e.b : e.b === id ? e.a : null;
        if (nb == null || reach.has(nb) || !byId.has(nb)) continue;
        reach.set(nb, depth + 1);
        queue.push(nb);
      }
    }
    return reach;
  }, [data, sel]);

  // Centre the canvas on a card and select it — how the attached list navigates.
  const goTo = (card: WorkbenchCard) => {
    const el = groundRef.current;
    const z = zoomRef.current;
    setSel(card.id);
    setPan({
      x: (el?.clientWidth ?? 900) / 2 - (card.x + card.w / 2) * z,
      y: (el?.clientHeight ?? 600) / 2 - (card.y + 60) * z,
    });
  };

  // Dimming needs something to dim AGAINST. With nothing selected — click the
  // ground and the selection is gone — an unguarded `focus` would grey the whole
  // canvas out at once with nothing on screen explaining why.
  const dimming = focus && sel != null && attached.size > 0;

  const lineage = useMemo(() => {
    if (!data) return [];
    return data.cards
      .filter((c) => c.id !== sel && attached.has(c.id))
      .sort((a, b) => (attached.get(a.id) as number) - (attached.get(b.id) as number)
        || a.id - b.id)
      .map((c) => ({
        card: c,
        depth: (attached.get(c.id) as number),
        kind: c.kind === 'polaris' ? c.meta : c.kind === 'note' ? 'note' : (c.op || 'ai'),
      }));
  }, [data, sel, attached]);

  // ---- edge geometry ----
  const paths = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.cards.map((c) => [c.id, c]));
    return data.edges.map((e) => {
      const a = byId.get(e.a); const b = byId.get(e.b);
      if (!a || !b) return null;
      const ah = hOf(a); const bh = hOf(b);
      // Attach at the card's middle, but never lower than 140px down it — a tall
      // plan card should be met near its head, not at its waist.
      const ay = a.y + Math.min(ah, 140) / 2;
      const by = b.y + Math.min(bh, 140) / 2;
      let d: string;
      if (b.x > a.x + a.w) {
        const x1 = a.x + a.w; const x2 = b.x;
        const dx = Math.min(60, Math.max(10, (x2 - x1) / 2));
        d = `M${x1},${ay} C${x1 + dx},${ay} ${x2 - dx},${by} ${x2},${by}`;
      } else if (b.x + b.w < a.x) {
        const x1 = a.x; const x2 = b.x + b.w;
        const dx = Math.min(60, Math.max(10, (x1 - x2) / 2));
        d = `M${x1},${ay} C${x1 - dx},${ay} ${x2 + dx},${by} ${x2},${by}`;
      } else {
        const down = b.y >= a.y;
        const cx1 = a.x + a.w / 2; const cx2 = b.x + b.w / 2;
        const y1 = down ? a.y + ah : a.y;
        const y2 = down ? b.y : b.y + bh;
        const dy = Math.min(48, Math.max(8, Math.abs(y2 - y1) / 2)) * (down ? 1 : -1);
        d = `M${cx1},${y1} C${cx1},${y1 + dy} ${cx2},${y2 - dy} ${cx2},${y2}`;
      }
      return {
        id: e.id, a: e.a, b: e.b, d, ai: e.ai,
        // A line dims unless BOTH its ends are in the thread — a wire that
        // trails off into dimmed space reads as a thread that continues.
        dim: dimming && !(attached.has(e.a) && attached.has(e.b)),
        mx: Math.round((a.x + a.w / 2 + b.x + b.w / 2) / 2),
        my: Math.round((ay + by) / 2),
      };
    }).filter(Boolean) as {
      id: number; a: number; b: number; d: string; ai: boolean; dim: boolean; mx: number; my: number;
    }[];
  }, [data, hOf, dimming, attached]);

  if (loading && !data) {
    return <div className="empty-state"><div className="big">Loading the workbench…</div></div>;
  }

  // ---- the folder in view (#414) ----
  // `allCards` is the whole canvas; `shown` is what this folder holds. Every
  // tree question is asked of the first and every render of the second — mixing
  // them is how a count says twelve over a folder drawing three.
  const allCards = data?.cards ?? [];
  // Which system folder, if any, is open. Everything else on the screen keys
  // off this rather than re-testing `cwd`, so the canvas, the lists and the
  // status bar cannot disagree about whether one is showing.
  const sysOpen = systemOf(cwd);
  const board = data?.board ?? [];
  const boardCapped = (data?.boardTotal ?? 0) > board.length;

  const crumbs = pathTo(allCards, cwd, projectName);
  const searching = query.trim().length > 0;
  // A search reaches DOWN from here, not across the whole canvas: you are
  // searching the folder you are standing in, and its subfolders are part of
  // it. Searching everything would make the breadcrumb a lie.
  //
  // EXCEPT ON THE CANVAS, which cannot honestly draw a result set from several
  // folders at once: x/y are read INSIDE a folder, so two matches from two
  // folders carry two unrelated coordinate systems and land on top of each
  // other. The canvas is a place, so it searches only what is placed in it, and
  // the status bar says which of the two searches you got rather than leaving
  // the difference to be discovered.
  const deepSearch = searching && view !== 'canvas';
  const shown = (() => {
    const needle = query.trim().toLowerCase();
    const pool = deepSearch ? descendantsOf(allCards, cwd) : childrenOf(allCards, cwd);
    const base = searching ? pool.filter((c) => c.title.toLowerCase().includes(needle)) : pool;
    return view === 'canvas' && !searching ? base : sortCards(base, sortKey, sortDir, allCards);
  })();
  const shownIds = new Set(shown.map((c) => c.id));
  const cards = shown;
  const selCard = allCards.find((c) => c.id === sel) || null;
  // A folder is where the canvas can go next; the toolbar's Promote and the
  // ops rail both need to know whether the selection is one.
  const selFolder = isFolder(selCard) ? selCard : null;
  const upTo = upFrom(allCards, cwd);
  const ops = data?.ops ?? [];
  const models = data?.models ?? [];
  const selectedModel = models.find((m) => m.model === model);

  // ---- the Polaris picker's derived view ----
  const ideas = data?.polaris ?? [];
  const unpickedCount = ideas.filter((p) => !p.onCanvas).length;
  const shownIdeas = (() => {
    const needle = pQuery.trim().toLowerCase();
    return ideas
      .filter((p) => (pFilter === 'all' ? true
        : pFilter === 'recent' ? p.days <= RECENT_DAYS
          : !p.onCanvas))
      .filter((p) => !needle
        || `${p.title} ${p.meta} ${p.area}`.toLowerCase().includes(needle));
  })();
  // Four ways to have an empty list, and they want four different sentences —
  // "no matches" over an empty funnel is the unhelpful version of the truth.
  const emptyPickerCopy = ideas.length === 0
    ? 'No Polaris ideas yet — capture them on the Polaris tab.'
    : pQuery.trim() ? 'Nothing matches that.'
      : pFilter === 'unpicked' ? 'Every idea is already on the canvas.'
        : `Nothing captured in the last ${RECENT_DAYS} days.`;

  const togglePick = (id: number) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // ---- the debrief picker's derived view ----
  const nights = debrief?.nights ?? [];
  const debriefNewCount = nights.reduce((n, night) => n + night.insights.filter((i) => !i.imported).length, 0);
  // Grouped by night, newest first — the server already orders nights that
  // way, so this only has to filter within each and drop a night left empty.
  const shownNights = (() => {
    const needle = dQuery.trim().toLowerCase();
    return nights
      .map((night) => ({
        night,
        insights: night.insights
          .filter((ins) => (dFilter === 'all' ? true
            : dFilter === 'advisor' ? ins.from === 'reviewer' || ins.from === 'architect'
              : !ins.imported))
          .filter((ins) => !needle || ins.text.toLowerCase().includes(needle)),
      }))
      .filter((g) => g.insights.length > 0);
  })();
  // Four ways to have an empty list, the same way emptyPickerCopy earns its
  // four — "nothing matches" said over a debrief that never ran, or one
  // that already gave everything up, is the unhelpful version of the truth.
  const emptyDebriefCopy = nights.length === 0
    ? 'No autopilot night has finished here yet — there is nothing to import.'
    : nights.every((n) => n.insights.length === 0)
      ? `The last ${debrief?.runsShown ?? nights.length} nights left nothing to pick up.`
      : dQuery.trim() ? 'Nothing matches that.'
        : dFilter === 'advisor' ? 'No reviewer or architect read is attached to these nights.'
          : 'Everything these nights turned up is already on the canvas.';

  const toggleDPick = (key: string) => setDPicked((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // ---- the explorer's derived view (#414) ----
  // ⌘/Ctrl-click builds the marked set; a plain click clears it and selects.
  // Marking is deliberately its own gesture: `sel` is the ops rail's single
  // subject, and letting a plain click accumulate would make every op button
  // ambiguous the moment two things were ticked.
  const toggleMark = (id: number, additive: boolean) => setMarked((prev) => {
    const next = additive ? new Set(prev) : new Set<number>();
    if (prev.has(id) && additive) next.delete(id); else next.add(id);
    return next;
  });

  // Open what was double-clicked: a folder navigates, anything else selects and
  // centres. A smart folder can be opened too — it just never becomes a place
  // you can put something.
  const openCard = (c: WorkbenchCard) => {
    if (isFolder(c)) { navigate(c.id); return; }
    setSel(c.id);
    if (view === 'canvas') goTo(c);
  };

  // One row per folder in the Explorer, flattened depth-first so the tree can
  // be a list of divs rather than nested containers — nesting is what makes a
  // drag target's hit box overlap its parent's.
  const treeRows = (() => {
    const rows: { card: WorkbenchCard; depth: number; open: boolean; kids: number }[] = [];
    const walk = (parent: FolderId, depth: number, seen: Set<number>) => {
      for (const c of childrenOf(allCards, parent)) {
        if (!isFolder(c) || seen.has(c.id)) continue;
        seen.add(c.id);
        const open = expanded.has(c.id);
        rows.push({ card: c, depth, open, kids: countIn(allCards, c.id) });
        if (open) walk(c.id, depth + 1, seen);
      }
    };
    walk(ROOT, 0, new Set());
    return rows;
  })();

  const toggleExpand = (id: number) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Drop handlers, shared by every surface that accepts one (the tree rows, the
  // breadcrumb, a folder card on the canvas, a tile). `accepts` is asked before
  // anything is painted, so a target that will refuse never lights up.
  const dropProps = (target: FolderId) => ({
    onDragOver: (e: React.DragEvent) => {
      if (dragging === null || !canFileInto(allCards, dragging, target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (over !== target) setOver(target);
    },
    onDragLeave: () => setOver((o) => (o === target ? null : o)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (dragging === null) return;
      void fileInto(dragging, target);
    },
  });

  const dragProps = (c: WorkbenchCard) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      setDragging(c.id);
      e.dataTransfer.effectAllowed = 'move';
      // Firefox will not start a drag without payload. The id is not read back
      // — `dragging` is the truth — but it has to be set.
      e.dataTransfer.setData('text/plain', String(c.id));
    },
    onDragEnd: () => { setDragging(null); setOver(null); },
  });

  // What the status bar says, and it is three separate facts rather than one
  // sentence because two of them are frequently empty.
  const hiddenWires = data
    ? data.edges.filter((e) => shownIds.has(e.a) !== shownIds.has(e.b)).length
    : 0;
  const sysCount = sysOpen
    ? (sysOpen.key === 'sys:polaris' ? ideas.length : data?.boardTotal ?? 0) : 0;
  const statusCount = sysOpen
    ? `${sysCount} ${sysCount === 1 ? 'item' : 'items'} · read-only`
    : `${shown.length} ${shown.length === 1 ? 'item' : 'items'}`
    + (searching
      ? ` matching “${query.trim()}”${deepSearch ? ' in here and below' : ' placed in this folder'}`
      : '');
  const statusMarked = marked.size ? `${marked.size} marked` : selCard ? `“${selCard.title.slice(0, 60)}”` : '';
  // A wire crossing a folder boundary is not drawn, and saying nothing about it
  // would make the canvas read as a thread that simply ends (see the header).
  const statusWires = hiddenWires
    ? `${hiddenWires} ${hiddenWires === 1 ? 'wire runs' : 'wires run'} outside this folder`
    : '';

  // Only wires with BOTH ends in this folder are drawn — see the file header.
  const wires = paths.filter((p) => shownIds.has(p.a) && shownIds.has(p.b));

  // Pull ONE idea from the Polaris folder onto the canvas, into whatever real
  // folder you were last in — never into the system folder itself, which holds
  // no cards. Same POST the picker uses; this is just a one-click door onto it.
  const pullIdea = (futureId: number) => guard(async () => {
    const into = typeof lastRealFolder === 'number' ? lastRealFolder : null;
    const at = centreOfView();
    const card = await addWorkbenchCard(slug, {
      kind: 'polaris', futureId, x: at.x, y: at.y, parentId: into,
    });
    setData((d) => (d ? {
      ...d,
      cards: [...d.cards, card, ...(card.cascaded?.cards ?? [])],
      edges: [...d.edges, ...(card.cascaded?.edges ?? [])],
      polaris: d.polaris.map((p) => (p.id === futureId ? { ...p, onCanvas: true } : p)),
    } : d));
    const where = into === null ? 'the workbench'
      : `“${allCards.find((c) => c.id === into)?.title || 'folder'}”`;
    say(`Pulled ${card.meta} into ${where}.`);
  });

  spatialRef.current = spatial(view) && !sysOpen;

  // The map, laid out from the whole tree — not from `shown`. It is a picture
  // of how the workbench is ARRANGED, so standing inside a folder must not
  // shrink it to that folder; the current folder is highlighted instead.
  const map = view === 'map' && !sysOpen
    ? mapLayout(allCards, projectName, mapShut) : null;

  // THE MINIMAP. Bounds come from what is actually drawn, so it frames the work
  // rather than a fixed field — an empty canvas has no minimap at all rather
  // than a rectangle wandering an imaginary 2400px plane.
  const mini = (() => {
    if (!minimap || !spatialRef.current) return null;
    const boxes = map
      ? map.nodes.map((n) => ({ x: n.x, y: n.y, w: MAP_NODE_W, h: 44 }))
      : shown.map((c) => ({ x: c.x, y: c.y, w: c.w, h: hOf(c) }));
    if (!boxes.length) return null;
    // RAW bounds decide whether anything overflows; PADDED bounds are what the
    // minimap draws. Using the padded ones for both lets the display margin
    // manufacture an overflow that is not there — 160px of padding on an 846px
    // viewport put a minimap over a canvas that fitted perfectly well.
    const rawX0 = Math.min(...boxes.map((b) => b.x));
    const rawY0 = Math.min(...boxes.map((b) => b.y));
    const rawW = Math.max(1, Math.max(...boxes.map((b) => b.x + b.w)) - rawX0);
    const rawH = Math.max(1, Math.max(...boxes.map((b) => b.y + b.h)) - rawY0);
    const el = groundRef.current;
    const vw = el?.clientWidth ?? 800;
    const vh = el?.clientHeight ?? 520;
    // A MINIMAP IS FOR CONTENT THAT DOES NOT FIT, so that — not a count of
    // items — is what decides whether it appears. Counting was the first cut,
    // and it hid the minimap on a one-node map that fitted anyway while
    // promising one for two cards sitting side by side.
    if (rawW <= vw / zoom && rawH <= vh / zoom) return null;
    const pad = 80;
    const x0 = rawX0 - pad;
    const y0 = rawY0 - pad;
    const w = rawW + pad * 2;
    const h = rawH + pad * 2;
    // The viewport rect, in the same world coordinates as the boxes.
    const vx = -pan.x / zoom;
    const vy = -pan.y / zoom;
    return {
      x0, y0, w, h, boxes,
      view: { x: vx, y: vy, w: vw / zoom, h: vh / zoom },
      // Screen point inside the minimap -> a pan that centres that world point.
      panTo: (fx: number, fy: number) => {
        const wx = x0 + fx * w;
        const wy = y0 + fy * h;
        setPan({ x: vw / 2 - wx * zoom, y: vh / 2 - wy * zoom });
      },
    };
  })();

  const sortHead = (key: SortKey, label: string) => (
    <button className={`wb-sort${sortKey === key ? ' on' : ''}`}
      onClick={() => {
        if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
        else { setSortKey(key); setSortDir(1); }
      }}>
      {label}{sortKey === key ? (sortDir === 1 ? ' ▲' : ' ▼') : ''}
    </button>
  );

  return (
    // Fullscreen is a CLASS, not a portal or the Fullscreen API: the canvas has
    // to keep its measured card heights and its wheel listener across the
    // switch, and both are attached to nodes that a portal would remount.
    <div className={`wb${full ? ' full' : ''}`}>
      <div className="section-bar" style={{ marginBottom: 6 }}>
        <div className="titles">
          <div className="h">Workbench</div>
          <div className="subtitle">Notes, Polaris ideas and the ✧ ops that turn them into a plan</div>
        </div>
        <div className="wb-hint">drag ↔ move · wheel ↔ zoom · hover a line ↔ ✂ cut · drag onto a folder ↔ file</div>
      </div>

      {error && <div className="action-error">{error}</div>}

      {/* The explorer bar (#414): where you are, what you are looking at it
          with, and the three things you can do to a folder. */}
      <div className="wb-bar">
        <div className="wb-nav">
          <button onClick={back} disabled={hi <= 0} title="Back">‹</button>
          <button onClick={forward} disabled={hi >= hist.length - 1} title="Forward">›</button>
          <button onClick={() => upTo && navigate(upTo.to)} disabled={!upTo}
            title="Up one level">↑</button>
        </div>

        <div className="wb-crumbs" {...dropProps(ROOT)}>
          {crumbs.map((c, i) => (
            <span key={`${String(c.id)}-${i}`} className="wb-crumb-wrap">
              {i > 0 && <span className="sep">/</span>}
              <button
                className={`wb-crumb${i === crumbs.length - 1 ? ' here' : ''}${over === c.id && i < crumbs.length - 1 ? ' over' : ''}`}
                onClick={() => navigate(c.id)}
                {...(i < crumbs.length - 1 ? dropProps(c.id) : {})}>
                {c.name}
              </button>
            </span>
          ))}
        </div>

        {!sysOpen && (
          <input className="wb-search" value={query} placeholder="Search this folder…"
            onChange={(e) => setQuery(e.target.value)} />
        )}

        {/* A system folder has one way of being looked at, so the view switch
            and the folder verbs are not offered rather than offered-and-inert:
            a disabled control still says "this is a thing you do here". */}
        {!sysOpen && (
          <>
            <div className="wb-views">
              {VIEWS.map((v) => (
                <button key={v.key} className={view === v.key ? 'on' : ''}
                  onClick={() => setView(v.key)}>{v.label}</button>
              ))}
            </div>

            <button className={`ghost sm${split ? ' on' : ''}`}
              title="Show a second folder beside this one"
              onClick={() => setSplit((v) => !v)}>Split</button>
            <button className="ghost sm" onClick={() => void newFolder()}>+ Folder</button>
            {marked.size > 1 && (
              <button className="ghost sm" onClick={() => void foldMarked()}>Fold {marked.size}</button>
            )}
            {selFolder && (
              <button className="ghost sm" onClick={() => void promoteFolder(selFolder)}>
                Promote “{selFolder.title.slice(0, 22)}{selFolder.title.length > 22 ? '…' : ''}”
              </button>
            )}
          </>
        )}
      </div>

      <div className="wb-body">
        {tree && (
          <div className="wb-tree">
            <div className="wb-tree-head">
              <span>Explorer</span>
              <button onClick={() => setTree(false)} title="Hide the explorer">‹</button>
            </div>

            <div className="wb-tree-label">Smart folders</div>
            {SMART.map((s) => (
              <button key={s.key} className={`wb-tree-row${cwd === s.key ? ' on' : ''}`}
                onClick={() => navigate(s.key)}>
                <span className="dot" style={{ background: s.tone }} />
                <span className="name">{s.name}</span>
                <span className="count">{countIn(allCards, s.key)}</span>
              </button>
            ))}

            <div className="wb-tree-label">Folders</div>
            <button className={`wb-tree-row${cwd === ROOT ? ' on' : ''}${over === ROOT ? ' over' : ''}`}
              onClick={() => navigate(ROOT)} {...dropProps(ROOT)}>
              <span className="ic root" />
              <span className="name">{projectName}</span>
              <span className="count">{countIn(allCards, ROOT)}</span>
            </button>
            {/* The two system folders sit UNDER the project, indented like any
                other child, because that is what they are — the Workbench's
                connection to the funnel it draws from and the board it feeds.
                They carry no drop handler and no delete: they are derived, so
                there is nothing to file into and nothing to remove (#415). */}
            {SYSTEM.map((sysf) => (
              <button key={sysf.key}
                className={`wb-tree-row system${cwd === sysf.key ? ' on' : ''}`}
                style={{ paddingLeft: 23 }}
                onClick={() => navigate(sysf.key)}>
                <span className="ic" style={{ background: sysf.tone }} />
                <span className="name">{sysf.name}</span>
                <span className="count">
                  {sysf.key === 'sys:polaris' ? ideas.length : data?.boardTotal ?? 0}
                </span>
              </button>
            ))}
            {treeRows.map((r) => (
              <button key={r.card.id}
                className={`wb-tree-row${cwd === r.card.id ? ' on' : ''}${over === r.card.id ? ' over' : ''}`}
                style={{ paddingLeft: 10 + (r.depth + 1) * 13 }}
                onClick={() => navigate(r.card.id)}
                onDoubleClick={() => toggleExpand(r.card.id)}
                {...dragProps(r.card)} {...dropProps(r.card.id)}>
                <span className={`twist${r.kids ? '' : ' none'}${r.open ? ' open' : ''}`}
                  onClick={(e) => { e.stopPropagation(); toggleExpand(r.card.id); }}>▸</span>
                <span className="ic" />
                <span className="name">{r.card.title || 'Untitled folder'}</span>
                <span className="count">{r.kids}</span>
              </button>
            ))}
            {!treeRows.length && (
              <div className="wb-tree-empty">
                No folders yet. <button className="linkish" onClick={() => void newFolder()}>Make one</button> and
                drag cards onto it.
              </div>
            )}
          </div>
        )}
        {!tree && (
          <button className="wb-tree-peg" onClick={() => setTree(true)} title="Show the explorer">›</button>
        )}

        {/* A SYSTEM FOLDER RENDERS ITSELF, whatever view is selected: its rows
            are futures and roadmap items, not cards, so Canvas/Tiles/Details
            have nothing to say about them. Read-only both ways — the one write
            offered is the pull that already existed (#415). */}
        {sysOpen && (
          <div className="wb-list wb-system">
            <div className="wb-system-head">
              <span className="dot" style={{ background: sysOpen.tone }} />
              <span className="t">{sysOpen.name}</span>
              <span className="b">{sysOpen.blurb}</span>
            </div>

            {sysOpen.key === 'sys:polaris' && (
              <div className="wb-rows">
                {ideas.map((idea) => (
                  <div className="wb-row sys" key={idea.id}>
                    <span className="name">
                      <span className="ic k-polaris" />
                      <span className="t">{idea.title}</span>
                    </span>
                    <span className="kind">{idea.area || '—'}</span>
                    <span className="items">{idea.meta}</span>
                    <span className="when">
                      {idea.onCanvas
                        ? <span className="on-canvas">on the canvas</span>
                        : (
                          <button className="chip-sm" onClick={() => void pullIdea(idea.id)}>
                            → canvas
                          </button>
                        )}
                    </span>
                  </div>
                ))}
                {!ideas.length && (
                  <div className="wb-list-empty">
                    No Polaris ideas yet — the funnel is on the Polaris tab.
                  </div>
                )}
              </div>
            )}

            {sysOpen.key === 'sys:roadmap' && (
              <div className="wb-rows">
                {board.map((it) => (
                  <div className="wb-row sys" key={it.id}
                    onDoubleClick={() => go.detail(slug, 'roadmap', String(it.id))}>
                    <span className="name">
                      <span className={`ic bk-${it.bucket}`} />
                      <span className="t">#{it.id} {it.title}</span>
                    </span>
                    <span className="kind">{it.bucket}{it.tier ? ` · ${it.tier}` : ''}</span>
                    <span className="items">{it.area || '—'}</span>
                    <span className="when">
                      <button className="chip-sm" onClick={() => go.detail(slug, 'roadmap', String(it.id))}>
                        open ↗
                      </button>
                    </span>
                  </div>
                ))}
                {!board.length && (
                  <div className="wb-list-empty">Nothing open on the board right now.</div>
                )}
                {/* #239's rule: a capped list says it is capped, and on the
                    right axis — how many there are, not how many are shown. */}
                {boardCapped && (
                  <div className="wb-list-note">
                    Showing the first {board.length} of {data?.boardTotal ?? 0} open items, in the
                    run queue’s order. The Roadmap tab has the rest.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* The LIST views, named rather than defined as "not canvas" — that
            spelling silently swallowed Map the moment it was added, and drew a
            list of rows beside the graph. */}
        {!sysOpen && (view === 'tiles' || view === 'details') && (
          <div className={`wb-list${view === 'details' ? ' details' : ''}`}>
            {view === 'details' && (
              <div className="wb-list-head">
                {sortHead('name', 'Name')}
                {sortHead('kind', 'Kind')}
                {sortHead('items', 'Items')}
                {sortHead('updated', 'Updated')}
              </div>
            )}
            <div className={view === 'tiles' ? 'wb-tiles' : 'wb-rows'}>
              {shown.map((c) => (
                <div key={c.id}
                  className={`${view === 'tiles' ? 'wb-tile' : 'wb-row'}`
                    + `${marked.has(c.id) ? ' marked' : ''}${sel === c.id ? ' sel' : ''}`
                    + `${over === c.id ? ' over' : ''}${c.days >= 30 ? ' stale' : ''}`}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey) toggleMark(c.id, true);
                    else { setSel(c.id); setMarked(new Set()); }
                  }}
                  onDoubleClick={() => openCard(c)}
                  {...dragProps(c)} {...(isFolder(c) ? dropProps(c.id) : {})}>
                  {/* THE TWO VIEWS DO NOT SHARE MARKUP. A Details row is a
                      four-column grid, so the icon has to live INSIDE the name
                      cell or it takes a column of its own and shifts every
                      other cell one to the right — which is exactly what the
                      first cut did. A tile is a stack, and wants its meta on
                      one line underneath. Same fields, two structures. */}
                  <span className="name">
                    {/* `k-` prefixed, NOT the bare kind. This stylesheet is one
                        global scope and `.note` is already the notes-wall
                        sticky — an unprefixed kind class inherited its padding
                        and border and drew an 11px swatch as a 34px box. */}
                    <span className={`ic k-${c.kind}`} />
                    <span className="t">{c.title || 'Untitled'}</span>
                  </span>
                  {view === 'details' ? (
                    <>
                      <span className="kind">{KIND_LABEL[c.kind]}</span>
                      <span className="items">{isFolder(c) ? countIn(allCards, c.id) : '—'}</span>
                      <span className="when">{c.when}</span>
                    </>
                  ) : (
                    <span className="meta">
                      <span className="kind">{KIND_LABEL[c.kind]}</span>
                      {isFolder(c) && <span className="items">{countIn(allCards, c.id)} in</span>}
                      <span className="when">{c.when}</span>
                    </span>
                  )}
                </div>
              ))}
              {!shown.length && (
                <div className="wb-list-empty">
                  {searching ? 'Nothing in this folder or below it matches that.'
                    : isSmart(cwd) ? 'Nothing on the canvas answers that search right now.'
                      : 'This folder is empty. Drag cards onto it, or make a note here.'}
                </div>
              )}
            </div>
          </div>
        )}

        <div
          ref={groundRef}
          // Hidden with a class, never unmounted: the wheel listener and the
          // measured card heights are attached to this node, and remounting it
          // per view switch would drop both (#414, #415).
          // Shown for EVERY spatial view, not just the canvas. The map is
          // drawn inside this same field — it needs the pan, the zoom and the
          // wheel listener — so a canvas-only test hid the map in a
          // display:none container: the nodes were in the DOM and nothing was
          // on screen, which no assertion about element counts can catch.
          className={`wb-ground${linking !== null ? ' linking' : ''}`
            + `${spatial(view) && !sysOpen ? '' : ' hidden'}`}
          onPointerDown={startPan}
          style={{
            backgroundSize: `${GRID * zoom}px ${GRID * zoom}px`,
            backgroundPosition: `${pan.x % (GRID * zoom)}px ${pan.y % (GRID * zoom)}px`,
          }}
        >
          <div className="wb-field" style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})` }}>
            <svg className="wb-wires" width="2400" height="1800"
              style={{ display: view === 'canvas' ? undefined : 'none' }}>
              {wires.map((p) => (
                <path key={`w${p.id}`} d={p.d} fill="none"
                  className={`wb-wire${p.ai ? ' ai' : ''}${hotEdge === p.id ? ' hot' : ''}${p.dim ? ' dim' : ''}`} />
              ))}
              {wires.map((p) => (
                <g key={`h${p.id}`} className="wb-wire-hit">
                  <path d={p.d} fill="none" stroke="transparent" strokeWidth={16}
                    onClick={(e) => { e.stopPropagation(); void cut(p.id); }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onMouseEnter={() => setHotEdge(p.id)}
                    onMouseLeave={() => setHotEdge((h) => (h === p.id ? null : h))} />
                  {hotEdge === p.id && (
                    <g className="wb-scissor">
                      <circle cx={p.mx} cy={p.my} r={11} />
                      <text x={p.mx} y={p.my} textAnchor="middle" dominantBaseline="central">✂</text>
                    </g>
                  )}
                </g>
              ))}
            </svg>

            {view === 'map' && map && (
              <div className="wb-map" style={{ width: map.w, height: map.h }}>
                <svg width={map.w} height={map.h} className="wb-map-wires">
                  {map.edges.map((e, i) => (
                    <path key={i} fill="none"
                      d={`M ${e.x1} ${e.y1} C ${e.x1 + 60} ${e.y1}, ${e.x2 - 60} ${e.y2}, ${e.x2} ${e.y2}`} />
                  ))}
                </svg>
                {map.nodes.map((n) => (
                  <div key={String(n.id)}
                    className={`wb-map-node${n.id === cwd ? ' here' : ''}${n.card ? '' : ' root'}`}
                    style={{ transform: `translate(${n.x}px,${n.y}px)`, width: MAP_NODE_W }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => navigate(n.id)}>
                    <span className="nm">{n.name}</span>
                    <span className="ct">{n.holds}</span>
                    {n.kids > 0 && (
                      <button className="tw" title={n.collapsed ? 'Expand' : 'Collapse'}
                        onClick={(e) => {
                          e.stopPropagation();
                          setMapShut((prev) => {
                            const next = new Set(prev);
                            if (typeof n.id !== 'number') return next;
                            if (next.has(n.id)) next.delete(n.id); else next.add(n.id);
                            return next;
                          });
                        }}>{n.collapsed ? `+${n.kids}` : '−'}</button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {view === 'canvas' && cards.map((c) => (
              <CardView
                key={c.id} card={c}
                selected={c.id === sel}
                marked={marked.has(c.id)}
                linkingFrom={linking === c.id}
                highlighted={c.id === highlightedCard?.id}
                dimmed={dimming && !attached.has(c.id)}
                over={over === c.id}
                inside={isFolder(c) ? countIn(allCards, c.id) : 0}
                nodeRef={(el) => { if (el) nodeRef.current[c.id] = el; else delete nodeRef.current[c.id]; }}
                onDown={(e) => startDrag(e, c)}
                onTitle={(t) => saveTitle(c, t)}
                onBody={(b) => saveBody(c, b)}
                onShip={() => void shipPlan(c)}
                onOpen={() => openCard(c)}
              />
            ))}
          </div>

          {/* Both overlays sit inside the ground, so their presses have to be
              stopped or every click on them would start a pan. */}
          <div className="wb-zoom" onPointerDown={(e) => e.stopPropagation()}>
            <button onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
            <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>{Math.round(zoom * 100)}%</button>
            <button onClick={() => zoomBy(1.2)} aria-label="Zoom in">+</button>
            <button className={minimap ? 'on' : ''} title="Minimap"
              onClick={() => setMinimap((m) => !m)}>▣</button>
            <button className={full ? 'on' : ''} title={full ? 'Leave fullscreen (Esc)' : 'Fullscreen'}
              onClick={() => setFull((f) => !f)}>{full ? '⤡' : '⤢'}</button>
          </div>

          {/* THE MINIMAP frames what is DRAWN, not a fixed field: an empty
              canvas gets no minimap rather than a rectangle wandering an
              imaginary plane. Press or drag anywhere in it to pan there. */}
          {mini && (
            <div className="wb-mini"
              onPointerDown={(e) => {
                e.stopPropagation();
                const el = e.currentTarget;
                const move = (ev: PointerEvent | React.PointerEvent) => {
                  const r = el.getBoundingClientRect();
                  mini.panTo(
                    Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)),
                    Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)),
                  );
                };
                move(e);
                const up = () => {
                  window.removeEventListener('pointermove', move as (e: PointerEvent) => void);
                  window.removeEventListener('pointerup', up);
                };
                window.addEventListener('pointermove', move as (e: PointerEvent) => void);
                window.addEventListener('pointerup', up);
              }}>
              {mini.boxes.map((b, i) => (
                <span key={i} className="dot" style={{
                  left: `${((b.x - mini.x0) / mini.w) * 100}%`,
                  top: `${((b.y - mini.y0) / mini.h) * 100}%`,
                  width: `${Math.max(1.5, (b.w / mini.w) * 100)}%`,
                  height: `${Math.max(1.5, (b.h / mini.h) * 100)}%`,
                }} />
              ))}
              <span className="port" style={{
                left: `${((mini.view.x - mini.x0) / mini.w) * 100}%`,
                top: `${((mini.view.y - mini.y0) / mini.h) * 100}%`,
                width: `${(mini.view.w / mini.w) * 100}%`,
                height: `${(mini.view.h / mini.h) * 100}%`,
              }} />
            </div>
          )}

          {pickerOpen && (
            <div className="wb-picker" onPointerDown={(e) => e.stopPropagation()}>
              <div className="head">
                <span className="dot" />
                <span className="t">Polaris</span>
                <span className="n">{ideas.length} idea{ideas.length === 1 ? '' : 's'}</span>
                <button className="x" onClick={closePicker} aria-label="Close">×</button>
              </div>
              <div className="find">
                <div className="searchbox">
                  <span className="glass" />
                  <input value={pQuery} autoFocus placeholder="Filter ideas…"
                    onChange={(e) => setPQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closePicker(); } }} />
                </div>
                <div className="filters">
                  {POLARIS_FILTERS.map((f) => (
                    <button key={f.key} className={`chip-sm${pFilter === f.key ? ' on' : ''}`}
                      onClick={() => setPFilter(f.key)}>{f.label}</button>
                  ))}
                </div>
              </div>
              <div className="list">
                {shownIdeas.map((p) => (
                  <button key={p.id} type="button"
                    className={`wb-idea${picked.has(p.id) ? ' picked' : ''}${p.onCanvas ? ' on-canvas' : ''}`}
                    disabled={p.onCanvas}
                    onClick={() => togglePick(p.id)}>
                    <span className="box">{picked.has(p.id) ? '✓' : ''}</span>
                    <span className="b">
                      <span className="top">
                        <span className="meta">{p.meta}</span>
                        <span className="age">{p.age}</span>
                      </span>
                      <span className="t">{p.title}</span>
                      <span className="sub">
                        {p.onCanvas
                          ? 'already on the canvas'
                          : p.isStar && p.links > 0
                            ? <>{p.area || 'untagged'} ·{' '}
                              <span className="star">★ {p.links} planet{p.links === 1 ? '' : 's'}</span></>
                            : [p.area || 'untagged', `${p.links} linked`].join(' · ')}
                      </span>
                    </span>
                  </button>
                ))}
                {shownIdeas.length === 0 && (
                  <div className="none">{emptyPickerCopy}</div>
                )}
              </div>
              <div className="foot">
                <span className="n">{picked.size ? `${picked.size} selected` : 'Select one or more'}</span>
                <button className="btn-accent" disabled={picked.size === 0} onClick={pullPicked}>
                  Pull → canvas
                </button>
              </div>
            </div>
          )}

          {debriefOpen && (
            <div className="wb-picker" onPointerDown={(e) => e.stopPropagation()}>
              <div className="head">
                <span className="dot" />
                <span className="t">Debrief</span>
                <span className="n">{debrief ? `${debrief.total} insight${debrief.total === 1 ? '' : 's'}` : '…'}</span>
                <button className="x" onClick={closeDebrief} aria-label="Close">×</button>
              </div>
              {/* A capped list has to say it is capped — the same rule the
                  server's own prompts follow. */}
              {debrief && debrief.runsTotal > debrief.runsShown && (
                <div className="cap">showing the last {debrief.runsShown} of {debrief.runsTotal} nights</div>
              )}
              <div className="find">
                <div className="searchbox">
                  <span className="glass" />
                  <input value={dQuery} autoFocus placeholder="Filter insights…"
                    onChange={(e) => setDQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeDebrief(); } }} />
                </div>
                <div className="filters">
                  {DEBRIEF_FILTERS.map((f) => (
                    <button key={f.key} className={`chip-sm${dFilter === f.key ? ' on' : ''}`}
                      onClick={() => setDFilter(f.key)}>{f.label}</button>
                  ))}
                </div>
              </div>
              <div className="list">
                {debriefLoading && <div className="none">Reading the last few nights…</div>}
                {!debriefLoading && shownNights.map(({ night, insights }) => (
                  <div className="wb-debrief-night" key={night.runId}>
                    <div className="wb-debrief-head">
                      <span className="w">{night.day} · {night.when}</span>
                      <span className="i">{night.itemId != null
                        ? `#${night.itemId} ${night.itemTitle}` : (night.itemTitle || night.branch)}</span>
                      <span className="o">{night.outcome}</span>
                      {night.truncated > 0 && (
                        <span className="more">+{night.truncated} more this night were not listed</span>
                      )}
                    </div>
                    {insights.map((ins) => (
                      <button key={ins.key} type="button"
                        className={`wb-insight${dPicked.has(ins.key) ? ' picked' : ''}${ins.imported ? ' imported' : ''}`}
                        disabled={ins.imported}
                        onClick={() => toggleDPick(ins.key)}>
                        <span className="box">{dPicked.has(ins.key) ? '✓' : ''}</span>
                        <span className="b">
                          <span className="top">
                            <span className="kind">{DEBRIEF_KIND[ins.kind]}</span>
                            <span className="from">{DEBRIEF_FROM[ins.from]}</span>
                          </span>
                          <span className="t">{ins.text}</span>
                          {ins.imported && (
                            <span className="sub">
                              {ins.importedAs === 'note' ? 'already a note on the canvas'
                                : ins.importedAs === 'idea' ? 'already an idea'
                                  : 'dismissed earlier, not offered again'}
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
                {!debriefLoading && shownNights.length === 0 && (
                  <div className="none">{emptyDebriefCopy}</div>
                )}
              </div>
              <div className="foot">
                <span className="n">{dPicked.size ? `${dPicked.size} selected` : 'Select one or more'}</span>
                <button className="btn-accent" disabled={dPicked.size === 0} onClick={() => void importPicked('note')}>
                  Import → canvas
                </button>
                <button className="chip-sm" disabled={dPicked.size === 0} onClick={() => void importPicked('idea')}>
                  → Ideas
                </button>
              </div>
            </div>
          )}

          <div className="wb-dock" onPointerDown={(e) => e.stopPropagation()}>
            <button className={`wb-pull${pickerOpen ? ' on' : ''}`}
              onClick={() => (pickerOpen ? closePicker() : openPicker())}>
              <span className="dot" />
              <span className="l">Pull from Polaris</span>
              <span className="n">{unpickedCount} unpicked</span>
            </button>
            <button className={`wb-debrief${debriefOpen ? ' on' : ''}`}
              onClick={() => (debriefOpen ? closeDebrief() : openDebrief())}>
              <span className="dot" />
              <span className="l">⤓ Pull from a night</span>
              {debrief && <span className="n">{debriefNewCount} new</span>}
            </button>
            <button className="chip-sm add" onClick={addNote}>+ note</button>
          </div>

          {!loading && cards.length === 0 && (
            <div className="wb-empty">
              <div className="big">
                {searching ? 'Nothing placed here matches'
                  : cwd === ROOT ? 'An empty bench' : 'An empty folder'}
              </div>
              <div>
                {/* The canvas searches only what is PLACED in this folder, so
                    an empty result here is not the same answer the lists give.
                    Say which search ran, and where the other one lives. */}
                {searching
                  ? 'The canvas can only search what is placed in this folder. Tiles or Details will search the subfolders too.'
                  : cwd === ROOT
                    ? 'Jot a note or pull an idea across from Polaris, then select it and run an ✧ op.'
                    : 'Drag cards onto this folder from anywhere, or add a note — it will be filed here.'}
              </div>
            </div>
          )}
        </div>

        {split && !sysOpen && (
          <SidePane
            cards={allCards} projectName={projectName}
            cwd={cwd2} onNavigate={setCwd2}
            view={view2} onView={setView2}
            over={over} dragProps={dragProps} dropProps={dropProps}
            onClose={() => setSplit(false)}
            onOpenCard={(c) => { if (isFolder(c)) setCwd2(c.id); else setSel(c.id); }}
            sel={sel}
          />
        )}

        {rail ? (
          <div className="wb-rail">
            <div className="wb-rail-head">
              <div className="row">
                <span className="k">selected</span>
                <button className="collapse" onClick={() => setRail(false)} aria-label="Collapse the rail">›</button>
              </div>
              <div className="t">{selCard ? selCard.title : 'Nothing selected'}</div>
              <div className="m">{selCard ? kindLine(selCard) : 'Click a card to work on it.'}</div>
              {selCard && (
                <div className="acts">
                  <button className="chip-sm" onClick={() => setLinking(selCard.id)}>⁃ link</button>
                  {selCard.kind === 'note' && selCard.noteId != null && (
                    <>
                      <button className="chip-sm" onClick={() => onPromoteNote(selCard.noteId as number, selCard.title, 'bug')}>→ Bug</button>
                      <button className="chip-sm" onClick={() => onPromoteNote(selCard.noteId as number, selCard.title, 'roadmap')}>→ Roadmap</button>
                    </>
                  )}
                  <button className="chip-sm danger" onClick={() => void dropCard(selCard)}>
                    {selCard.kind === 'polaris' ? '↩ off canvas' : '× remove'}
                  </button>
                </div>
              )}
              {linking !== null && <div className="linking-hint">Click another card to wire them. Esc or the ground cancels.</div>}
            </div>

            {/* What this card is attached to, at any depth — the thread it sits
                in, which the canvas itself can only show you by eye once there
                is more than a screenful on it. */}
            {selCard && (
              <div className="wb-lineage">
                <div className="row">
                  <span className="k">attached · {lineage.length}</span>
                  <button className={`focus${focus ? ' on' : ''}`} onClick={() => setFocus((f) => !f)}
                    title={focus ? 'Show the whole canvas again' : 'Dim everything not in this thread'}>
                    {focus ? '✦ focused' : 'focus'}
                  </button>
                </div>
                {lineage.length === 0 ? (
                  <div className="none">Nothing attached yet. Run an ✧ op, or use ⁃ link to wire this to another card.</div>
                ) : lineage.map((n) => (
                  <button key={n.card.id} className="line" onClick={() => goTo(n.card)} title={n.card.title}>
                    <span className="d">{'·'.repeat(n.depth)}</span>
                    <span className="kind">{n.kind}</span>
                    <span className="t">{n.card.title}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Keyless, the ops are ABSENT rather than disabled — the same rule
                every other ✧ surface follows. */}
            {geminiReady && (
              <div className="wb-ops">
                {models.length > 0 && (
                  <div className="wb-model">
                    <label className="k" htmlFor="wb-model-select">model</label>
                    <select id="wb-model-select" value={model} disabled={busyOp !== null}
                      onChange={(e) => changeModel(e.target.value)}>
                      {models.map((m) => (
                        <option key={m.model} value={m.model}>{m.label}</option>
                      ))}
                    </select>
                    <span className="hint">
                      {selectedModel?.note ? `${selectedModel.note} — ` : ''}
                      applies to every ✧ op, on every project — this is a Stack-wide setting, not just this Workbench.
                    </span>
                  </div>
                )}
                <div className="row">
                  <span className="k">ops</span>
                  <span className="note">nothing runs unprompted</span>
                </div>
                {ops.map((o) => (
                  <button key={o.key} className={`wb-op${busyOp === o.key ? ' busy' : ''}`}
                    disabled={!selCard || busyOp !== null}
                    onClick={() => runOp(o.key)}>
                    <span className="g">{o.glyph}</span>
                    <span className="b">
                      <span className="l">{o.label}</span>
                      <span className="h">{OP_HINT[o.key]}</span>
                    </span>
                    {busyOp === o.key && <span className="s">running…</span>}
                  </button>
                ))}
                {asking && (
                  <div className="wb-ask">
                    <input autoFocus value={question} placeholder="Ask about this project's record…"
                      onChange={(e) => setQuestion(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); runOp('ask'); }
                        else if (e.key === 'Escape') { e.preventDefault(); setAsking(false); setQuestion(''); }
                      }} />
                    <span className="hint">⏎ to ask · answers come from the roadmap, bugs, notes and recent
                      pushes — not the source code</span>
                  </div>
                )}
              </div>
            )}

            <WorkbenchDesign card={selCard} slug={slug} lineage={lineage} onSay={say}
              onPasteBack={(text) => pasteDesign(selCard as WorkbenchCard, text)} />

            <div className="wb-log">
              <div className="k">log</div>
              {log.length === 0
                ? <div className="none">This session's moves show up here.</div>
                : log.map((l, i) => (
                  <div className="line" key={i}><span className="w">{l.when}</span><span className="t">{l.t}</span></div>
                ))}
            </div>
          </div>
        ) : (
          <div className="wb-rail closed">
            <button className="collapse" onClick={() => setRail(true)} aria-label="Open the rail">‹</button>
            <div className="spine">ops · {cards.length} cards</div>
          </div>
        )}
      </div>

      {/* Three separate facts, not one sentence: two of them are usually
          empty, and the wire count is the only place the canvas admits it is
          hiding a thread that leaves this folder (#414). */}
      <div className="wb-status">
        <span>{statusCount}</span>
        <span className="mid">{statusMarked}</span>
        <span className="right">{statusWires}</span>
      </div>
    </div>
  );
}

// THE SIDE PANE (#415) — the right half of a split.
//
// It is a second EXPLORER, not a second canvas, and the distinction is
// deliberate rather than a shortfall of effort. The canvas's pan, zoom, native
// wheel listener and measured card heights all hang off one ground element;
// a live second canvas means four duplicated subsystems and two sets of
// coordinates for a drag to reason about. What a split is actually FOR — see
// two folders at once and move work between them — is delivered by the list
// views, which are HTML5 drag targets already, so a drag crosses the split for
// free. The pane says what it is rather than looking like a broken canvas.
function SidePane({
  cards, projectName, cwd, onNavigate, view, onView, over, dragProps, dropProps,
  onClose, onOpenCard, sel,
}: {
  cards: WorkbenchCard[];
  projectName: string;
  cwd: FolderId;
  onNavigate: (id: FolderId) => void;
  view: Exclude<View, 'canvas'>;
  onView: (v: Exclude<View, 'canvas'>) => void;
  over: FolderId | null;
  dragProps: (c: WorkbenchCard) => Record<string, unknown>;
  dropProps: (t: FolderId) => Record<string, unknown>;
  onClose: () => void;
  onOpenCard: (c: WorkbenchCard) => void;
  sel: number | null;
}) {
  const [shut, setShut] = useState<Set<number>>(new Set());
  const crumbs = pathTo(cards, cwd, projectName);
  const up = upFrom(cards, cwd);
  const rows = sortCards(childrenOf(cards, cwd), 'name', 1, cards);
  const map = view === 'map' ? mapLayout(cards, projectName, shut) : null;

  return (
    <div className="wb-side">
      <div className="wb-side-bar">
        <button className="nav" disabled={!up} title="Up one level"
          onClick={() => up && onNavigate(up.to)}>↑</button>
        <div className="wb-crumbs">
          {crumbs.map((c, i) => (
            <span key={`${String(c.id)}-${i}`} className="wb-crumb-wrap">
              {i > 0 && <span className="sep">/</span>}
              <button className={`wb-crumb${i === crumbs.length - 1 ? ' here' : ''}`}
                onClick={() => onNavigate(c.id)}>{c.name}</button>
            </span>
          ))}
        </div>
        <div className="wb-views">
          {VIEWS.filter((v) => v.key !== 'canvas').map((v) => (
            <button key={v.key} className={view === v.key ? 'on' : ''}
              onClick={() => onView(v.key as Exclude<View, 'canvas'>)}>{v.label}</button>
          ))}
        </div>
        <button className="nav" title="Close the split" onClick={onClose}>✕</button>
      </div>

      <div className="wb-side-body">
        {view === 'map' && map && (
          <div className="wb-map" style={{ width: map.w, height: map.h }}>
            <svg width={map.w} height={map.h} className="wb-map-wires">
              {map.edges.map((e, i) => (
                <path key={i} fill="none"
                  d={`M ${e.x1} ${e.y1} C ${e.x1 + 60} ${e.y1}, ${e.x2 - 60} ${e.y2}, ${e.x2} ${e.y2}`} />
              ))}
            </svg>
            {map.nodes.map((n) => (
              <div key={String(n.id)}
                className={`wb-map-node${n.id === cwd ? ' here' : ''}${n.card ? '' : ' root'}`}
                style={{ transform: `translate(${n.x}px,${n.y}px)`, width: MAP_NODE_W }}
                onClick={() => onNavigate(n.id)}>
                <span className="nm">{n.name}</span>
                <span className="ct">{n.holds}</span>
                {n.kids > 0 && (
                  <button className="tw" onClick={(e) => {
                    e.stopPropagation();
                    setShut((prev) => {
                      const next = new Set(prev);
                      if (typeof n.id !== 'number') return next;
                      if (next.has(n.id)) next.delete(n.id); else next.add(n.id);
                      return next;
                    });
                  }}>{n.collapsed ? `+${n.kids}` : '−'}</button>
                )}
              </div>
            ))}
          </div>
        )}

        {view !== 'map' && (
          <div className={view === 'tiles' ? 'wb-tiles' : 'wb-rows'}>
            {rows.map((c) => (
              <div key={c.id}
                className={`${view === 'tiles' ? 'wb-tile' : 'wb-row'}`
                  + `${sel === c.id ? ' sel' : ''}${over === c.id ? ' over' : ''}`}
                onClick={() => onOpenCard(c)}
                onDoubleClick={() => onOpenCard(c)}
                {...dragProps(c)} {...(isFolder(c) ? dropProps(c.id) : {})}>
                <span className="name">
                  <span className={`ic k-${c.kind}`} />
                  <span className="t">{c.title || 'Untitled'}</span>
                </span>
                <span className="meta">
                  <span className="kind">{KIND_LABEL[c.kind]}</span>
                  {isFolder(c) && <span className="items">{countIn(cards, c.id)} in</span>}
                  <span className="when">{c.when}</span>
                </span>
              </div>
            ))}
            {!rows.length && (
              <div className="wb-list-empty">
                Empty. Drag something across from the other side.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// An editable line that React does NOT reconcile the text of.
//
// The obvious `<div contentEditable>{value}</div>` is a trap: React still owns
// those children, so ANY re-render while you are typing — a card being measured,
// another card being dragged, a line going hot — rewrites the node back to the
// last committed value and drops the caret to the start. Rendering no children
// and setting textContent imperatively takes React out of it, and the focus
// guard means an incoming value never yanks the words out from under the cursor.
function Editable({ value, className, editable = true, onCommit, onPointerDown }: {
  value: string;
  className: string;
  editable?: boolean;
  onCommit: (next: string) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || el === document.activeElement) return;
    if (el.textContent !== value) el.textContent = value;
  }, [value]);
  return (
    <div ref={ref} className={className} contentEditable={editable} suppressContentEditableWarning
      onPointerDown={onPointerDown}
      onBlur={(e) => onCommit((e.currentTarget.textContent || '').trim())} />
  );
}

const OP_LABEL: Record<WorkbenchOp, string> = {
  expand: 'Expand', cluster: 'Cluster', plan: 'Draft plan', blast: 'Blast radius',
  touches: 'Touches', critique: 'Critique', ask: 'Ask',
};

// The rail's one-line description of the selection. The `ai` case is the
// FALLBACK, so every new kind has to be named above it — a folder fell through
// to it once and the rail called a folder "a suggestion, not a decision".
const kindLine = (c: WorkbenchCard) =>
  c.kind === 'polaris' ? `Polaris idea · ${c.meta}`
    : c.kind === 'note' ? `Scratch note · ${c.meta}`
      : c.kind === 'folder' ? 'Folder · double-click it, or use the explorer, to go in'
        : `✧ ${OP_LABEL[c.op as WorkbenchOp] || 'AI'} output · a suggestion, not a decision`;

// One card. Note and Polaris cards read their title through from the row they
// wrap, so editing here writes to the note or the idea, never to a copy.
function CardView({
  card, selected, marked, linkingFrom, highlighted, dimmed, over, inside,
  nodeRef, onDown, onTitle, onBody, onShip, onOpen,
}: {
  card: WorkbenchCard;
  selected: boolean;
  marked: boolean;
  linkingFrom: boolean;
  highlighted: boolean;
  dimmed: boolean;
  over: boolean;                    // a drag is hovering this folder and it will accept
  inside: number;                   // how many cards a folder holds (0 for anything else)
  nodeRef: (el: HTMLDivElement | null) => void;
  onDown: (e: React.PointerEvent) => void;
  onTitle: (t: string) => void;
  onBody: (b: WorkbenchCard['body']) => void;
  onShip: () => void;
  onOpen: () => void;
}) {
  const body = card.body;
  const lines = body.lines || [];
  const phases = body.phases || [];
  const chips = body.chips || [];
  const stop = (e: React.PointerEvent) => e.stopPropagation();

  const setPhase = (i: number, patch: Partial<WorkbenchPhase>) =>
    onBody({ ...body, phases: phases.map((p, j) => (j === i ? { ...p, ...patch } : p)) });

  // A FOLDER CARD IS ITS OWN SHAPE (#414) — it has no body to draw, and what it
  // does have is a count and a way in. Double-click opens it, the same gesture
  // as the Explorer and the tiles, so the canvas is not the one surface with a
  // different way of entering a folder.
  if (card.kind === 'folder') {
    return (
      <div
        ref={nodeRef}
        className={`wb-card folder${selected ? ' on' : ''}${marked ? ' marked' : ''}`
          + `${highlighted ? ' hl' : ''}${dimmed ? ' dim' : ''}${over ? ' over' : ''}`}
        onPointerDown={onDown}
        onDoubleClick={onOpen}
        style={{ transform: `translate(${card.x}px,${card.y}px)`, width: card.w }}
        /* How a pointer-drag finds a drop target: the release reads this off
           the DOM under the cursor rather than recomputing hit boxes. */
        data-folder-id={card.id}
      >
        <div className="wb-card-head">
          <span className="k">folder</span>
          <span className="m">{inside} {inside === 1 ? 'item' : 'items'}</span>
        </div>
        <Editable className="wb-title" value={card.title} onCommit={onTitle} onPointerDown={stop} />
        <button className="wb-open" onPointerDown={stop} onClick={onOpen}>Open →</button>
      </div>
    );
  }

  return (
    <div
      ref={nodeRef}
      className={`wb-card ${card.kind}${selected ? ' on' : ''}${marked ? ' marked' : ''}${linkingFrom ? ' linking' : ''}${highlighted ? ' hl' : ''}${dimmed ? ' dim' : ''}`}
      onPointerDown={onDown}
      onDoubleClick={onOpen}
      style={{
        transform: `translate(${card.x}px,${card.y}px)`,
        width: card.w,
        ...(card.colour ? { ['--note-c' as string]: card.colour } : {}),
      }}
    >
      <div className="wb-card-head">
        <span className="k">{card.kind === 'polaris' ? 'from polaris' : card.kind === 'ai' ? card.op : 'note'}</span>
        <span className="m">{card.kind === 'ai' ? 'ai' : card.meta}</span>
      </div>

      {/* An op's title is its own; a note's or an idea's is the row's, and
          editing it writes back to that row. */}
      {card.kind === 'ai'
        ? <div className="wb-title">{card.title}</div>
        : <Editable className="wb-title" value={card.title} onCommit={onTitle} onPointerDown={stop} />}

      {lines.length > 0 && (
        <div className="wb-lines">
          {lines.map((l, i) => {
            // Expand's first `choices` lines are a fork in the road: picking one
            // is a real decision the next op is told about, so they get a
            // button's affordances and the rest stay plain text.
            const pickable = (body.choices || 0) > i;
            const chosen = body.chosen === i;
            const dimmed = pickable && body.chosen !== undefined && !chosen;
            return (
              <button key={i} type="button"
                className={`wb-line${pickable ? ' pick' : ''}${chosen ? ' chosen' : ''}${dimmed ? ' dim' : ''}`}
                onPointerDown={stop}
                onClick={pickable ? () => onBody({ ...body, chosen: i }) : undefined}>
                <span className="mk">{l.mk}</span>
                <span className="t">{l.t}</span>
                {chosen && <span className="tick">✓ chosen</span>}
              </button>
            );
          })}
        </div>
      )}

      {phases.length > 0 && (
        <div className="wb-phases">
          {phases.map((p, i) => (
            <div className="wb-phase" key={i}>
              <span className="n">{p.n}</span>
              <div className="b">
                <Editable className="t" value={p.t} onPointerDown={stop} onCommit={(t) => setPhase(i, { t })} />
                <Editable className="d" value={p.d} onPointerDown={stop} onCommit={(d) => setPhase(i, { d })} />
                <div className="g">
                  <span className="gk">gate</span>
                  <Editable className="gv" value={p.gate} onPointerDown={stop} onCommit={(gate) => setPhase(i, { gate })} />
                  <span className="gb">{p.bucket}</span>
                </div>
              </div>
              <button className="x" onPointerDown={stop} aria-label="Remove this phase"
                onClick={() => onBody({
                  ...body,
                  phases: phases.filter((_, j) => j !== i).map((q, j) => ({ ...q, n: `P${j}` })),
                })}>×</button>
            </div>
          ))}
          <button className="wb-addphase" onPointerDown={stop}
            onClick={() => onBody({
              ...body,
              phases: [...phases, {
                n: `P${phases.length}`, t: 'New phase', d: 'What ships in this slice.',
                gate: 'what must be true to move on', bucket: 'could',
              }],
            })}>+ phase</button>
          <div className="wb-phasehint">click any line to edit · × removes a phase</div>
          <button className="wb-ship" onPointerDown={stop} onClick={onShip} disabled={!!body.shipped}>
            {body.shipped
              ? `✓ ${phases.length} items on the Roadmap`
              : `Promote ${phases.length} phases → Roadmap`}
          </button>
        </div>
      )}

      {chips.length > 0 && (
        <div className="wb-chips">
          {chips.map((ch, i) => <span className="techchip" key={i}>{ch}</span>)}
        </div>
      )}
    </div>
  );
}
