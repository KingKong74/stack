// THE WORK MAP — the Board tab's front page (Board Map design, 2026-11-18).
// The whole spine as one pannable tree: project → milestone → job (slice) →
// task (board row) → ticket (part). The model is lib/workMap.ts, whose header
// carries the rules about what is drawn and how each status is derived. This
// file is the screen, and it decides nothing about the work.
//
// DECISIONS THE CODE DEPENDS ON:
//  1. EVERY WRITE IS THE BOARD'S. The map is handed Board.tsx's own actions
//     (approve, send back, sign off, Ready, park, archive, run in terminal), so
//     a verdict given here is the very write the kanban gives, with its receipt
//     and its Undo. The map has no writer of its own.
//  2. "NEEDS YOUR ATTENTION" LISTS ONLY WHAT IS REAL: built work awaiting a
//     verdict, held rows awaiting a sign-off, and sessions stopped on a prompt.
//     With no host daemon on the line the session half is unknowable, and the
//     rail says "Stack cannot see the host", never "nothing needs you"
//     (root CLAUDE.md, fail silent).
//  3. A DOUBLE-CLICK OPENS THE NODE'S SESSION when its `term:` claim names a
//     live one, and otherwise flies the row (or the job) onto the focus canvas,
//     which is where a row is edited. A milestone has no session of its own.
//  4. THE SESSIONS BAR is this project's live tmux sessions (the host's
//     detached feed, polled through lib/autoRefresh.ts). A press opens it in
//     the project's terminal; it never kills or types (root CLAUDE.md).
//  5. PAN, ZOOM AND SELECTION ARE SCREEN STATE. The arrangement, the finished
//     fold and the tucked panels are device-local preferences (store.ts).
//  6. DELETE ASKS TWICE. A `hook` row's delete tombstones its fingerprint, so
//     it has no undo; the first press only arms it. Archive is recoverable.
//  7. LANES IS THE SAME SCREEN WITH A DIFFERENT MIDDLE: one milestone at a
//     time, a lane per job split into the four stages (laneBoard in
//     lib/workMap.ts). Selection, the rail, the details and every action are
//     the map's, so the two views can't disagree. A lane's fold is the map's
//     fold of that job. Lanes draws no attention rail and no details panel
//     (owner's call, 2026-11-20): its menu carries Approve instead.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Milestone, RoadmapItem, Slice } from '../types';
import {
  ROOT, TYPE_LABEL, KIDS_LABEL, CARD_H,
  STAGES,
  buildWorkMap, layoutMap, edgePath, ancestors, descendants, activeSet, isDone, itemKey,
  laneBoard, laneMilestones, defaultLaneMilestone,
  type MapNode, type NodeStatus,
} from '../lib/workMap';
import { isBuilt } from '../lib/plan';
import {
  getBoardMapPrefs, setBoardMapPrefs, getDetachedFeed, getTermNames,
  type BoardMapPrefs, type DetachedSession,
} from '../store';
import { useAutoRefresh } from '../lib/autoRefresh';
import { go } from '../lib/route';

export interface MapActions {
  approve: (it: RoadmapItem) => void;
  sendBack: (it: RoadmapItem, text: string) => void;
  signOff: (it: RoadmapItem) => void;
  runInTerminal: (it: RoadmapItem) => void;
  setReady: (it: RoadmapItem, on: boolean) => void;
  park: (it: RoadmapItem) => void;
  archive: (it: RoadmapItem) => void;
  /** A `hook` row's delete tombstones it: no undo, so the menu asks twice. */
  remove: (it: RoadmapItem) => void;
  edit: (it: RoadmapItem) => void;
  openItem: (it: RoadmapItem, el: HTMLElement | null) => void;
  openSlice: (slice: Slice, el: HTMLElement | null) => void;
  /** Off the map: the Icebox and ideas live on the Propositions tab. */
  showOffMap: () => void;
}

type Tone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';
const STATUS: Record<NodeStatus, [string, Tone]> = {
  planned: ['Planned', 'neutral'], ready: ['Ready', 'neutral'], held: ['Held', 'neutral'],
  parked: ['Parked', 'neutral'], active: ['Building', 'info'], review: ['For review', 'warning'],
  done: ['Done', 'success'], current: ['Current', 'info'], achieved: ['Achieved', 'success'],
  empty: ['Empty', 'neutral'],
};
const MIN_Z = 0.3;
const MAX_Z = 1.6;
const PAN_MARGIN = 280;

const firstSeg = (cwd?: string) => (cwd || '').replace(/^[/\\~]+/, '').split('/')[0] || '';
const firstLine = (s: string) => s.split('\n').map((x) => x.trim()).find(Boolean) || '';

function Chip({ status, small }: { status: NodeStatus; small?: boolean }) {
  const [label, tone] = STATUS[status];
  return <span className={`bm-chip t-${tone}${small ? ' sm' : ''}`}>{label}</span>;
}

export type BoardMapMode = 'map' | 'lanes';

export function BoardMap({ slug, projectName, rows, milestones, slices, highlightId, actions, onLayout, mode }: {
  slug: string;
  mode: BoardMapMode;
  projectName: string;
  rows: RoadmapItem[];
  milestones: Milestone[];
  slices: Slice[];
  highlightId: string | null;
  actions: MapActions;
  /** Switch the Board tab's layout. */
  onLayout: (layout: 'map' | 'lanes' | 'list') => void;
}) {
  const map = useMemo(() => buildWorkMap({ slug, name: projectName }, rows, milestones, slices),
    [slug, projectName, rows, milestones, slices]);
  const node = (k: string) => map.nodes.get(k);

  // ---- preferences (device-local) and screen state ----------------------------
  const [prefs, setPrefsState] = useState<BoardMapPrefs>(() => getBoardMapPrefs(slug));
  useEffect(() => { setPrefsState(getBoardMapPrefs(slug)); }, [slug]);
  const setPrefs = (patch: Partial<BoardMapPrefs>) => {
    setPrefsState((p) => { const next = { ...p, ...patch }; setBoardMapPrefs(slug, next); return next; });
  };
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [focusMode, setFocusMode] = useState(false);
  const [full, setFull] = useState(false);
  const [query, setQuery] = useState('');
  const [ctx, setCtx] = useState<{ key: string; x: number; y: number } | null>(null);
  const [sendBack, setSendBack] = useState<string | null>(null);
  const [arming, setArming] = useState(false);
  useEffect(() => { setArming(false); }, [ctx]);

  // The first selection: a deep link's row, else the first thing being built.
  const [sel, setSel] = useState<string>(() => {
    const hl = Number(highlightId);
    if (Number.isFinite(hl) && hl > 0) return itemKey(hl);
    const hot = [...map.nodes.values()].find((n) => n.status === 'review' || n.status === 'active');
    return hot?.key || ROOT;
  });
  useEffect(() => {
    const hl = Number(highlightId);
    if (Number.isFinite(hl) && hl > 0) setSel(itemKey(hl));
  }, [highlightId]);
  const selNode = node(sel) || node(ROOT)!;
  const lanesMode = mode === 'lanes';
  useEffect(() => { setSendBack(null); }, [sel]);

  const isFolded = useCallback((k: string) => {
    if (k in collapsed) return collapsed[k];
    const n = map.nodes.get(k);
    return !!n && prefs.collapseDone && isDone(n.status) && n.kids.length > 0;
  }, [collapsed, map, prefs.collapseDone]);
  const laid = useMemo(() => layoutMap(map, prefs.layout, isFolded), [map, prefs.layout, isFolded]);
  const hot = useMemo(() => activeSet(map), [map]);

  // ---- the lanes view: one milestone at a time (decision 7) --------------------
  const msList = useMemo(() => laneMilestones(map), [map]);
  const [laneMs, setLaneMs] = useState<string | null>(null);
  const shownMs = laneMs && msList.includes(laneMs) ? laneMs : defaultLaneMilestone(map, sel);
  const board = useMemo(() => laneBoard(map, shownMs), [map, shownMs]);
  const lanesRef = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLowerCase();
  const matches = (n: MapNode) => !needle || n.title.toLowerCase().includes(needle)
    || n.ref.toLowerCase() === needle || n.ref.toLowerCase() === `#${needle.replace(/^#/, '')}`;

  // ---- live sessions (the host's detached feed) --------------------------------
  const [sessions, setSessions] = useState<DetachedSession[]>([]);
  const [connected, setConnected] = useState<boolean | undefined>(undefined);
  const readSessions = useCallback(() => {
    getDetachedFeed()
      .then((r) => { setSessions(r.sessions); setConnected(r.connected); })
      .catch(() => { setConnected(false); });
  }, []);
  useEffect(() => { readSessions(); }, [readSessions]);
  useAutoRefresh(readSessions);
  const mine = sessions.filter((d) => (d.project || firstSeg(d.cwd)) === slug);
  const liveNames = new Set(sessions.map((d) => d.name));
  const names = getTermNames();
  const sessionLabel = (d: DetachedSession) => names[d.name] || d.label || d.name;
  const openSession = (name: string) => {
    const d = sessions.find((x) => x.name === name);
    go.projectTerminal(slug, d?.cwd || slug, name);
  };
  const claimFor = (name: string) => [...map.nodes.values()].find((n) => n.session === name);

  // ---- the canvas: size, pan, zoom ---------------------------------------------
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [wrapTop, setWrapTop] = useState(0);
  useLayoutEffect(() => {
    const measure = () => setWrapTop(Math.max(0, Math.round(wrapRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [full]);
  const [view, setView] = useState({ x: 0, y: 0, z: 0.9 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const laidRef = useRef(laid);
  laidRef.current = laid;

  const clamp = (x: number, y: number, z: number) => {
    const el = canvasRef.current;
    if (!el) return { x, y, z };
    const { W, H } = laidRef.current;
    const lim = (v: number, viewSize: number, size: number) => {
      const a = viewSize - size * z - PAN_MARGIN; const b = PAN_MARGIN;
      return Math.min(Math.max(a, b), Math.max(Math.min(a, b), v));
    };
    return { x: Math.round(lim(x, el.clientWidth, W)), y: Math.round(lim(y, el.clientHeight, H)), z };
  };
  const zoomAt = (z: number, mx: number, my: number) => {
    const v = viewRef.current;
    const nz = Math.min(MAX_Z, Math.max(MIN_Z, z));
    const k = nz / v.z;
    setView(clamp(mx - (mx - v.x) * k, my - (my - v.y) * k, nz));
  };
  const zoomCenter = (z: number) => {
    const el = canvasRef.current;
    if (el) zoomAt(z, el.clientWidth / 2, el.clientHeight / 2);
  };
  const centreOn = (k: string) => {
    const el = canvasRef.current;
    const p = laidRef.current.pos.get(k);
    if (!el || !p) return;
    const z = viewRef.current.z;
    // Stage flow reads left to right from its Scope column, so it keeps that
    // column in view and centres the selection vertically only.
    const x = laidRef.current.mode === 'stage' ? 0 : el.clientWidth / 2 - (p.x + p.w / 2) * z;
    setView(clamp(x, el.clientHeight / 2 - (p.y + CARD_H / 2) * z, z));
  };
  const fit = () => {
    const el = canvasRef.current;
    if (!el) return;
    const { W, H } = laidRef.current;
    const z = Math.min(MAX_Z, Math.max(MIN_Z, Math.min(el.clientWidth / W, el.clientHeight / H)));
    setView(clamp((el.clientWidth - W * z) / 2, (el.clientHeight - H * z) / 2, z));
  };
  // Centre on the selection whenever the arrangement changes, once there is a
  // canvas to measure.
  useEffect(() => {
    const t = window.setTimeout(() => centreOn(sel), 40);
    return () => window.clearTimeout(t);
  }, [prefs.layout, full, wrapTop, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // The wheel pans and Ctrl+wheel zooms. Not a React handler: it must be
  // non-passive to keep the page itself from scrolling.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        zoomAt(v.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top);
      } else setView(clamp(v.x - e.deltaX, v.y - e.deltaY, v.z));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const panStart = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-card]')) return;
    const sx = e.clientX; const sy = e.clientY; const o = viewRef.current;
    const cv = e.currentTarget;
    cv.classList.add('grabbing');
    const mv = (ev: MouseEvent) => setView(clamp(o.x + ev.clientX - sx, o.y + ev.clientY - sy, o.z));
    const up = () => { cv.classList.remove('grabbing'); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  };

  // Escape closes the menu, then leaves focus mode, then full screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (ctx) setCtx(null); else if (focusMode) setFocusMode(false); else if (full) setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctx, focusMode, full]);

  // ---- what a node does ---------------------------------------------------------
  const select = (k: string, centre = false) => {
    setSel(k); setCtx(null);
    if (!centre) return;
    if (!lanesMode) { window.setTimeout(() => centreOn(k), 30); return; }
    // Lanes: turn to the node's milestone, open its lane, and scroll it in.
    const up = ancestors(map, k);
    const m = [k, ...up].find((a) => msList.includes(a));
    if (m) setLaneMs(m);
    setCollapsed((c) => { const o = { ...c }; for (const a of up) if (node(a)?.type === 'job') o[a] = false; return o; });
    window.setTimeout(() => {
      lanesRef.current?.querySelector(`[data-mapkey="${k}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, 40);
  };
  const liveSession = (n: MapNode) => (n.session && liveNames.has(n.session) ? n.session : '');
  const openNode = (n: MapNode, el: HTMLElement | null) => {
    const s = liveSession(n);
    if (s) { openSession(s); return; }
    if (n.item) actions.openItem(n.item, el);
    else if (n.slice) actions.openSlice(n.slice, el);
  };
  const toggleFold = (k: string) => setCollapsed((c) => ({ ...c, [k]: !isFolded(k) }));
  const openCtx = (k: string, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    setSel(k);
    setCtx({ key: k, x: Math.min(e.clientX, window.innerWidth - 248), y: Math.min(e.clientY, window.innerHeight - 340) });
  };

  const metaOf = (n: MapNode) => {
    const kids = n.kids.map((k) => node(k)!);
    if (n.type === 'project') {
      const ms = kids.filter((k) => k.type === 'milestone').length;
      return `${descendants(map, ROOT).filter((k) => node(k)!.item).length} items · ${ms} milestone${ms === 1 ? '' : 's'}`;
    }
    if (n.type === 'milestone') {
      const m = n.milestone!;
      if (m.status === 'done' && m.endedAt) return `achieved ${m.endedAt.slice(0, 10)}`;
      return [`${kids.length} job${kids.length === 1 ? '' : 's'}`, m.targetOn ? `due ${m.targetOn}` : ''].filter(Boolean).join(' · ');
    }
    if (kids.length) return `${kids.filter((k) => isDone(k.status)).length}/${kids.length} ${KIDS_LABEL[n.type].toLowerCase()} done`;
    const it = n.item;
    if (!it) return n.type === 'job' ? 'no tasks yet' : '';
    if (isBuilt(it) && !it.done) return firstLine(it.builtNote) || 'built';
    if (it.refineNote.trim() && !it.claimedBy.trim()) return 'sent back';
    if (it.ready) return `ready #${it.readyRank + 1}`;
    if (it.claimedBy.trim() && !n.session) return it.claimedBy.trim();
    return it.area.trim() || '';
  };

  // ---- the attention rail (decision 2) -------------------------------------------
  const attention = useMemo(() => {
    const out: { key: string; kind: string; tone: Tone; ref: string; title: string; meta: string; onClick: () => void }[] = [];
    for (const n of map.nodes.values()) {
      if (!n.item || n.type === 'job') continue;
      const it = n.item;
      if (isBuilt(it) && !it.done && !it.reviewTag.trim()) {
        out.push({ key: n.key, kind: 'Review', tone: 'warning', ref: n.ref, title: n.title,
          meta: firstLine(it.builtNote) || 'Built and waiting for your verdict', onClick: () => select(n.key, true) });
      } else if (n.status === 'held') {
        out.push({ key: n.key, kind: 'Sign off', tone: 'neutral', ref: n.ref, title: n.title,
          meta: it.source === 'fly' ? `Filed by ${it.flySession || 'a session'}` : it.source === 'plan' ? 'From an agent plan' : 'Extracted from a push',
          onClick: () => select(n.key, true) });
      }
    }
    for (const d of mine) {
      if (!d.blocked && !d.waiting) continue;
      const claim = claimFor(d.name);
      out.push({ key: `t:${d.name}`, kind: d.blocked ? 'Blocked' : 'Waiting', tone: d.blocked ? 'danger' : 'warning',
        ref: claim?.ref || 'session', title: sessionLabel(d),
        meta: d.blocked ? 'Stopped on a permission prompt' : 'Finished its turn, waiting for you',
        onClick: () => openSession(d.name) });
    }
    return out;
  }, [map, mine]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the detail panel --------------------------------------------------------
  type Act = { label: string; primary?: boolean; run: (el: HTMLElement | null) => void };
  const nextFor = (n: MapNode): [string, Act[]] => {
    const live = liveSession(n);
    const sessionAct: Act[] = live ? [{ label: 'Open session', run: () => openSession(live) }] : [];
    if (n.type === 'project') {
      const waiting = attention.length;
      return [waiting ? `${waiting} thing${waiting === 1 ? '' : 's'} on the left need${waiting === 1 ? 's' : ''} you.` : 'Nothing on the map is waiting on you.', []];
    }
    if (n.type === 'milestone') {
      const m = n.milestone!;
      const lead = m.status === 'done' ? 'Achieved.' : m.status === 'active' ? 'The current milestone.' : 'Planned. Not yet current.';
      return [`${lead} ${firstLine(m.goal)}`.trim(), []];
    }
    if (n.type === 'job') {
      const kids = n.kids.map((k) => node(k)!);
      const review = kids.find((k) => k.status === 'review');
      const acts: Act[] = [];
      if (review) acts.push({ label: `Review ${review.ref}`, primary: true, run: () => select(review.key, true) });
      acts.push({ label: 'Open on canvas', run: (el) => actions.openSlice(n.slice!, el) });
      const built = kids.filter((k) => isDone(k.status) || k.status === 'review').length;
      return [kids.length ? `${built}/${kids.length} tasks built.${review ? ` ${review.ref} is waiting for your verdict.` : ''}` : 'No tasks yet. Open it on the canvas to add some.', acts];
    }
    const it = n.item!;
    if (isBuilt(it) && !it.done && !it.reviewTag.trim()) {
      return [firstLine(it.builtNote) ? `Built: ${firstLine(it.builtNote)}` : 'Built and waiting for your verdict.', [
        { label: 'Approve', primary: true, run: () => actions.approve(it) },
        { label: 'Send back', run: () => setSendBack('') },
        ...sessionAct,
      ]];
    }
    if (n.status === 'held') {
      return ['Held: a session filed this. Sign it off before anything can run it.', [
        { label: 'Sign off', primary: true, run: () => actions.signOff(it) },
        { label: 'Edit item', run: () => actions.edit(it) },
      ]];
    }
    if (n.status === 'active') {
      return [live ? `Being built in ${live}.` : `Claimed by ${it.claimedBy.trim() || 'a branch'}.`, [
        ...sessionAct.map((a) => ({ ...a, primary: true })),
        { label: 'Edit item', run: () => actions.edit(it) },
      ]];
    }
    if (isDone(n.status)) {
      const how = it.verdictSource === 'auto' && it.reviewTag ? ' A machine gave the verdict.' : '';
      return [`Done.${how}`, [{ label: 'Edit item', run: () => actions.edit(it) }]];
    }
    if (n.status === 'review') {
      return ['In For review by hand, with nothing built to give a verdict on yet.', [{ label: 'Edit item', run: () => actions.edit(it) }]];
    }
    const lead = n.status === 'parked' ? 'Parked: planned, and deliberately not picked up.'
      : it.refineNote.trim() ? `Sent back: ${firstLine(it.refineNote)}`
        : n.status === 'ready' ? `Ready, number ${it.readyRank + 1} in the build queue.` : 'Planned. Not started.';
    return [lead, [
      { label: 'Run in terminal', primary: true, run: () => actions.runInTerminal(it) },
      { label: it.ready ? 'Remove from Ready' : 'Add to Ready', run: () => actions.setReady(it, !it.ready) },
      { label: 'Edit item', run: () => actions.edit(it) },
    ]];
  };
  const STEP_LABELS = ['Planned', 'Building', 'For review', 'Done'];
  const stepOf = (s: NodeStatus) => (isDone(s) ? 4 : s === 'review' ? 2 : s === 'active' ? 1 : 0);

  const counts = useMemo(() => {
    const c = { active: 0, review: 0, done: 0 };
    for (const n of map.nodes.values()) {
      if (n.type !== 'task' && n.type !== 'ticket') continue;
      if (n.status === 'active') c.active += 1;
      else if (n.status === 'review') c.review += 1;
      else if (n.status === 'done') c.done += 1;
    }
    return c;
  }, [map]);

  // ---- render -----------------------------------------------------------------
  const path = new Set([...ancestors(map, sel), sel]);
  const base: string[] = []; const lit: string[] = [];
  for (const [k, p] of laid.pos) {
    const par = node(k)?.parent;
    const pp = par ? laid.pos.get(par) : undefined;
    if (!pp || !par) continue;
    (path.has(k) && path.has(par) ? lit : base).push(edgePath(pp, p));
  }

  const n = selNode;
  const [nextText, acts] = nextFor(n);
  const kids = n.kids.map((k) => node(k)!);
  const crumbs = ancestors(map, n.key).map((k) => node(k)!);
  const checks = n.item?.spec.acceptance || [];
  const step = n.item ? stepOf(n.status) : -1;
  const origin = n.item ? (n.item.source === 'fly' ? `Filed by ${n.item.flySession || 'a session'}`
    : n.item.source === 'hook' ? 'Extracted from a push' : n.item.source === 'plan' ? 'From an agent plan' : '') : '';
  const live = liveSession(n);
  const ctxNode = ctx ? node(ctx.key) : undefined;
  const cardEl = (k: string) => wrapRef.current?.querySelector<HTMLElement>(`[data-mapkey="${k}"]`) ?? null;

  const FLAGGED: NodeStatus[] = ['held', 'parked', 'ready'];
  const msIdx = shownMs ? msList.indexOf(shownMs) : -1;
  const msNode = shownMs ? node(shownMs) : undefined;
  const renderLanes = () => (
    <div ref={lanesRef} className="bm-lanes" aria-label="Lanes">
      <div className="bm-lanes-inner">
        <div className="bm-lanes-ms">
          <span className="bm-eyebrow">Milestone</span>
          {msList.length > 1 && (
            <span className="bm-pager">
              <button aria-label="Previous milestone" disabled={msIdx <= 0}
                onClick={() => setLaneMs(msList[msIdx - 1])}>‹</button>
              <span className="bm-count">{msIdx + 1}/{msList.length}</span>
              <button aria-label="Next milestone" disabled={msIdx >= msList.length - 1}
                onClick={() => setLaneMs(msList[msIdx + 1])}>›</button>
            </span>
          )}
          {msNode ? <>
            <button className="bm-lanes-mstitle" data-mapkey={msNode.key} onClick={() => select(msNode.key)}
              onContextMenu={(e) => openCtx(msNode.key, e)}>
              <span className="ref">{msNode.ref}</span><span className="t">{msNode.title}</span>
            </button>
            <Chip status={msNode.status} />
            <span className="meta">{metaOf(msNode)}</span>
          </> : <span className="meta">No milestones yet.</span>}
        </div>
        <div className="bm-lanes-cols">
          {STAGES.map((label, i) => (
            <div key={label}><span className="lbl">{label}</span><span className="bm-count">{board.counts[i]}</span></div>
          ))}
        </div>
        {board.lanes.map((l) => {
          const ln = node(l.key)!;
          const isRoot = l.key === ROOT;
          const open = !isFolded(l.key);
          return (
            <section key={l.key} className={`bm-lane${sel === l.key ? ' sel' : ''}`}>
              <div className="bm-lane-head" data-card="1" data-mapkey={l.key}
                onClick={() => select(l.key)}
                onDoubleClick={(e) => { if (isRoot) return; e.stopPropagation(); openNode(ln, e.currentTarget); }}
                onContextMenu={(e) => openCtx(l.key, e)}>
                <button className="chev" aria-label={open ? 'Collapse lane' : 'Expand lane'} aria-expanded={open}
                  onClick={(e) => { e.stopPropagation(); setCollapsed((c) => ({ ...c, [l.key]: open })); }}
                  onDoubleClick={(e) => e.stopPropagation()}>{open ? '▾' : '▸'}</button>
                <span className="bm-eyebrow">{isRoot ? 'Project' : TYPE_LABEL[ln.type]}</span>
                {!isRoot && <span className="ref">{ln.ref}</span>}
                <span className="t">{isRoot ? `Directly under ${projectName}` : ln.title}</span>
                {!isRoot && <Chip status={ln.status} small />}
                <span className="sp" />
                <span className="prog">{l.done}/{l.total} done</span>
                <span className="bar"><span style={{ width: `${l.total ? Math.round((l.done / l.total) * 100) : 0}%` }} /></span>
              </div>
              {open && !l.total && <div className="bm-lane-empty">No tasks yet.</div>}
              {open && l.total > 0 && (
                <div className="bm-lane-cols">
                  {l.cols.map((col, i) => (
                    <div key={i} className="col" aria-label={STAGES[i]}>
                      {col.map((k) => {
                        const c = node(k)!;
                        const dim = (focusMode && !hot.has(k)) || (!!needle && !matches(c));
                        const cs = liveSession(c);
                        const par = c.type === 'ticket' && c.parent ? node(c.parent) : undefined;
                        return (
                          <div key={k} data-card="1" data-mapkey={k} data-hl={c.item ? c.item.id : undefined}
                            className={`bm-lcard type-${c.type}${sel === k ? ' sel' : ''}${dim ? ' dim' : ''}${isDone(c.status) ? ' done' : ''}`}
                            onClick={(e) => { e.stopPropagation(); select(k); }}
                            onDoubleClick={(e) => { e.stopPropagation(); openNode(c, e.currentTarget); }}
                            onContextMenu={(e) => openCtx(k, e)}>
                            <div className="row">
                              <span className="bm-eyebrow">{TYPE_LABEL[c.type]}</span>
                              <span className="ref">{c.ref}</span>
                              <span className="sp" />
                              {FLAGGED.includes(c.status) && <Chip status={c.status} small />}
                            </div>
                            <div className="title">{c.title}</div>
                            <div className="foot">
                              <span className="meta">{par ? `under ${par.ref}` : metaOf(c)}</span>
                              {c.session && (
                                <span className="sess" title={cs ? 'Double-click to open its session' : 'Session ended'}>
                                  <span className={`bm-dot ${cs ? 'live' : 'gone'}`} />{c.session}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })}
        {!board.lanes.length && <div className="bm-empty">No jobs in this milestone yet. Plan them from the milestone's canvas.</div>}
        {msList.length > 1 && <div className="bm-lanes-note">Page through milestones with ‹ ›. These are the same items as the map.</div>}
      </div>
    </div>
  );

  return (
    <div ref={wrapRef} className={`bm${full ? ' full' : ''}`}
      style={full ? undefined : { height: `max(560px, calc(100vh - ${wrapTop}px - 12px))` }}
      onClick={() => setCtx(null)}>
      <div className="bm-toolbar">
        <div className="seg-control sm" role="tablist" aria-label="Board layout">
          <button role="tab" aria-selected={!lanesMode} className={`seg-opt${lanesMode ? '' : ' on'}`} onClick={() => onLayout('map')}>Map</button>
          <button role="tab" aria-selected={lanesMode} className={`seg-opt${lanesMode ? ' on' : ''}`} onClick={() => onLayout('lanes')}>Lanes</button>
          <button role="tab" aria-selected={false} className="seg-opt" onClick={() => onLayout('list')}>List</button>
        </div>
        {!lanesMode && <div className="seg-control sm bm-layouts" role="tablist" aria-label="Map arrangement">
          <button role="tab" aria-selected={prefs.layout === 'tree'} title="Tree: project to ticket, left to right"
            aria-label="Tree" className={`seg-opt${prefs.layout === 'tree' ? ' on' : ''}`} onClick={() => setPrefs({ layout: 'tree' })}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><rect x="1.5" y="6.5" width="4" height="3" rx="0.8" /><rect x="10.5" y="2" width="4" height="3" rx="0.8" /><rect x="10.5" y="11" width="4" height="3" rx="0.8" /><path d="M5.5 8h2.5M8 3.5v9M8 3.5h2.5M8 12.5h2.5" /></svg>
          </button>
          <button role="tab" aria-selected={prefs.layout === 'stage'} title="Stage flow: work moving towards done"
            aria-label="Stage flow" className={`seg-opt${prefs.layout === 'stage' ? ' on' : ''}`} onClick={() => setPrefs({ layout: 'stage' })}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><rect x="1.5" y="2" width="3.5" height="12" rx="0.8" /><rect x="6.25" y="2" width="3.5" height="8" rx="0.8" /><rect x="11" y="2" width="3.5" height="5" rx="0.8" /></svg>
          </button>
        </div>}
        <span className="searchbox sm bm-search">
          <input placeholder={lanesMode ? 'Search lanes' : 'Search map'} aria-label={lanesMode ? 'Search lanes' : 'Search map'} value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !needle) return;
              const hit = [...map.nodes.values()].find((x) => x.key !== ROOT && matches(x));
              if (!hit) return;
              setCollapsed((c) => { const o = { ...c }; for (const a of ancestors(map, hit.key)) o[a] = false; return o; });
              select(hit.key, true);
            }} />
        </span>
        <button className={`k-btn sm secondary${prefs.collapseDone ? ' on' : ''}`}
          onClick={() => { setCollapsed({}); setPrefs({ collapseDone: !prefs.collapseDone }); }}>
          {prefs.collapseDone ? 'Finished: collapsed' : 'Finished: shown'}
        </button>
        <button className={`bm-iconbtn${focusMode ? ' on' : ''}`} title={focusMode ? 'Show all work' : 'Focus active work'}
          aria-label={focusMode ? 'Show all work' : 'Focus active work'} aria-pressed={focusMode}
          onClick={() => setFocusMode(!focusMode)}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="4.5" /><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2" /></svg>
        </button>
        <button className={`bm-iconbtn${full ? ' on' : ''}`} title={full ? 'Exit full screen' : 'Full screen'}
          aria-label={full ? 'Exit full screen' : 'Full screen'} aria-pressed={full} onClick={() => setFull(!full)}>
          {full
            ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" /></svg>
            : <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" /></svg>}
        </button>
        <span className="bm-hint">{lanesMode
          ? 'The same work as the map, a lane per job · double-click a card for its session'
          : 'Drag to move · Ctrl + scroll to zoom · double-click a node for its session'}</span>
        <span className="bm-legend">
          <span>{counts.active} building</span><span>{counts.review} for review</span><span>{counts.done} done</span>
        </span>
      </div>

      <div className="bm-sessions" aria-label="Sessions">
        <span className="bm-eyebrow">Sessions</span>
        <span className="bm-count">{connected === false ? 'host offline' : `${mine.length} live`}</span>
        {mine.map((d) => {
          const claim = claimFor(d.name);
          return (
            <button key={d.name} className={`bm-sess${claim && sel === claim.key ? ' on' : ''}`}
              title={`${sessionLabel(d)} · live · click to open`}
              onClick={() => openSession(d.name)}
              onContextMenu={claim ? (e) => openCtx(claim.key, e) : undefined}>
              <span className={`bm-dot ${d.blocked ? 'danger' : d.waiting ? 'warning' : 'live'}`} />
              <span className="name">{sessionLabel(d)}</span>
              {claim && <span className="ref">{claim.ref}</span>}
            </button>
          );
        })}
        <button className="bm-sess new" onClick={() => go.projectTerminal(slug, slug)}>+ New session</button>
      </div>

      <div className="bm-body">
        {!lanesMode && <section className={`bm-attn${prefs.attnClosed ? ' closed' : ''}`} aria-label="Needs your attention">
          {prefs.attnClosed ? (
            <button className="bm-rail" title="Expand" onClick={() => setPrefs({ attnClosed: false })}>
              <span>»</span><span className="v">Needs you · {attention.length}</span>
            </button>
          ) : <>
            <button className="bm-fold" title="Collapse" aria-label="Collapse" onClick={() => setPrefs({ attnClosed: true })}>«</button>
            <div className="bm-attn-head">
              <span className="h">Needs your attention</span>
              <span className="bm-pill warning">{attention.length}</span>
            </div>
            <div className="bm-attn-list">
              {attention.map((a) => (
                <button key={a.key} className={`bm-attn-row${sel === a.key ? ' on' : ''}`} onClick={a.onClick}>
                  <span className="top"><span className={`bm-chip t-${a.tone}`}>{a.kind}</span><span className="ref">{a.ref}</span></span>
                  <span className="title">{a.title}</span>
                  <span className="meta">{a.meta}</span>
                </button>
              ))}
              {!attention.length && connected !== false && <div className="bm-empty">Nothing needs you right now.</div>}
              {connected === false && (
                <div className="bm-empty">Stack cannot see the host, so sessions waiting on you are not listed.</div>
              )}
            </div>
            <div className="bm-offmap">
              <span className="bm-eyebrow">Not on the map</span>
              <span className="note">The Icebox and session ideas stay off the map until they are sliced.</span>
              <button className="bm-link" onClick={actions.showOffMap}>
                {map.offMap.iced} in the Icebox · {map.offMap.ideas} idea{map.offMap.ideas === 1 ? '' : 's'}
              </button>
            </div>
          </>}
        </section>}

        {lanesMode ? renderLanes() : <div ref={canvasRef} className="bm-canvas" onMouseDown={panStart}
          style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${22 * view.z}px ${22 * view.z}px` }}>
          <div className="bm-inner" style={{ width: laid.W, height: laid.H, transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
            {laid.bands.map((b, i) => (
              <div key={i} className="bm-band" style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />
            ))}
            {laid.heads.map((h) => (
              <div key={h.label} className="bm-stagehead" style={{ left: h.x, top: h.y }}>
                <span className="bm-dot" style={{ background: h.tone }} />
                <span className="bm-eyebrow">{h.label}</span>
                <span className="bm-count">{h.count}</span>
              </div>
            ))}
            <svg width={laid.W} height={laid.H} className="bm-edges">
              <path d={base.join('') || 'M0 0'} className="e-base" />
              <path d={lit.join('') || 'M0 0'} className="e-lit" />
            </svg>
            {[...laid.pos].map(([k, p]) => {
              const c = node(k);
              if (!c) return null;
              const dim = (focusMode && !hot.has(k)) || (!!needle && !matches(c));
              const cs = liveSession(c);
              return (
                <div key={k} data-card="1" data-mapkey={k} data-hl={c.item ? c.item.id : undefined}
                  className={`bm-card type-${c.type}${sel === k ? ' sel' : ''}${dim ? ' dim' : ''}${isDone(c.status) ? ' done' : ''}`}
                  style={{ left: p.x, top: p.y, width: p.w, height: CARD_H }}
                  onClick={(e) => { e.stopPropagation(); select(k); }}
                  onDoubleClick={(e) => { e.stopPropagation(); openNode(c, e.currentTarget); }}
                  onContextMenu={(e) => openCtx(k, e)}>
                  <div className="row">
                    <span className="bm-eyebrow">{TYPE_LABEL[c.type]}</span>
                    {c.type !== 'project' && <span className="ref">{c.ref}</span>}
                    <span className="sp" />
                    <Chip status={c.status} small />
                  </div>
                  <div className="title">{c.title}</div>
                  <div className="foot">
                    <span className="meta">{metaOf(c)}</span>
                    {c.session && (
                      <span className="sess" title={cs ? 'Double-click to open its session' : 'Session ended'}>
                        <span className={`bm-dot ${cs ? 'live' : 'gone'}`} />{c.session}
                      </span>
                    )}
                  </div>
                  {c.kids.length > 0 && (
                    <button className="bm-toggle" title="Collapse or expand"
                      onClick={(e) => { e.stopPropagation(); toggleFold(k); }}
                      onDoubleClick={(e) => e.stopPropagation()}>
                      {p.folded ? `+${descendants(map, k).length}` : '−'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="bm-zoom" data-card="1">
            <button aria-label="Zoom out" onClick={() => zoomCenter(view.z / 1.2)}>−</button>
            <span>{Math.round(view.z * 100)}%</span>
            <button aria-label="Zoom in" onClick={() => zoomCenter(view.z * 1.2)}>+</button>
            <span className="sep" />
            <button className="fit" onClick={fit}>Fit</button>
          </div>
          {prefs.layout === 'stage' && laid.pos.size <= 1 && <div className="bm-canvas-empty">No work on the map yet.</div>}
        </div>}

        {!lanesMode && <aside className={`bm-detail${prefs.detailClosed ? ' closed' : ''}`} aria-label="Details">
          {prefs.detailClosed ? (
            <button className="bm-rail" title="Expand" onClick={() => setPrefs({ detailClosed: false })}>
              <span>«</span><span className="v">Details</span>
            </button>
          ) : <>
            <button className="bm-fold left" title="Collapse" aria-label="Collapse" onClick={() => setPrefs({ detailClosed: true })}>»</button>
            <div className="bm-sec head">
              <div className="row">
                <span className="bm-eyebrow">{TYPE_LABEL[n.type]}</span>
                <span className="ref">{n.ref}</span>
                <span className="sp" />
                <Chip status={n.status} />
              </div>
              <h2>{n.title}</h2>
              {crumbs.length > 0 && (
                <div className="crumbs">
                  {crumbs.map((c) => (
                    <span key={c.key}>
                      <button className="bm-link" onClick={() => select(c.key, true)}>{c.type === 'project' ? c.title : `${c.ref} ${c.title}`}</button>
                      <span className="slash">/</span>
                    </span>
                  ))}
                </div>
              )}
              {origin && <span className="origin">{origin}</span>}
            </div>

            <div className="bm-sec">
              <span className="bm-eyebrow accent">Next</span>
              <p className="next">{nextText}</p>
              {acts.length > 0 && (
                <div className="acts">
                  {acts.map((a) => (
                    <button key={a.label} className={`k-btn sm${a.primary ? '' : ' secondary'}`}
                      onClick={(e) => a.run(e.currentTarget)}>{a.label}</button>
                  ))}
                </div>
              )}
              {sendBack !== null && n.item && (
                <div className="sendback">
                  <textarea className="k-input" rows={3} autoFocus value={sendBack}
                    placeholder="What should change? The next session starts from this."
                    onChange={(e) => setSendBack(e.target.value)} />
                  <div className="acts">
                    <button className="k-btn sm" disabled={!sendBack.trim()}
                      onClick={() => { actions.sendBack(n.item!, sendBack.trim()); setSendBack(null); }}>Send back</button>
                    <button className="k-btn sm secondary" onClick={() => setSendBack(null)}>Cancel</button>
                  </div>
                </div>
              )}
              {step >= 0 && (
                <div className="steps">
                  {STEP_LABELS.map((label, i) => (
                    <div key={label} className={`step${i < step ? ' past' : i === step ? ' now' : ''}`}>
                      <span className="bar" /><span className="lbl">{label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {checks.length > 0 && (
              <div className="bm-sec">
                <div className="sechead"><span className="bm-eyebrow">Acceptance checks</span><span className="bm-count">{checks.length}</span></div>
                {checks.map((c, i) => (
                  <div key={i} className="check">
                    <span className="t">{c}</span>
                    <span className={`bm-chip t-${isDone(n.status) ? 'success' : 'neutral'}`}>{isDone(n.status) ? 'Met' : 'Pending'}</span>
                  </div>
                ))}
              </div>
            )}

            {n.slice?.spec.trim() && (
              <div className="bm-sec">
                <span className="bm-eyebrow">Spec</span>
                <p className="prose">{n.slice.spec.trim().slice(0, 600)}</p>
              </div>
            )}
            {n.milestone?.goal.trim() && (
              <div className="bm-sec">
                <span className="bm-eyebrow">Achieved when</span>
                <p className="prose">{n.milestone.goal.trim().slice(0, 600)}</p>
              </div>
            )}

            {kids.length > 0 && (
              <div className="bm-sec">
                <div className="sechead">
                  <span className="bm-eyebrow">{KIDS_LABEL[n.type]}</span>
                  <span className="bm-count">{kids.filter((k) => isDone(k.status)).length}/{kids.length} done</span>
                </div>
                {kids.map((k) => (
                  <button key={k.key} className="kid" onClick={() => select(k.key, true)}>
                    <span className="ref">{k.ref}</span>
                    <span className="t">{k.title}</span>
                    <Chip status={k.status} small />
                  </button>
                ))}
              </div>
            )}

            {n.item?.builtNote.trim() && (
              <div className="bm-sec">
                <span className="bm-eyebrow">What landed</span>
                <p className="prose">{n.item.builtNote.trim().slice(0, 800)}</p>
              </div>
            )}

            {n.session && (
              <div className="bm-sec session">
                <div className="who">
                  <span className="bm-eyebrow">Session</span>
                  <span className="name">{n.session}</span>
                  <span className="meta">{live ? 'live' : connected === false ? 'host offline' : 'ended'}</span>
                </div>
                {live && <button className="k-btn sm secondary" onClick={() => openSession(live)}>Open session</button>}
              </div>
            )}
          </>}
        </aside>}
      </div>

      {ctx && ctxNode && (
        <div className="bm-ctx" style={{ left: ctx.x, top: ctx.y }} onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); setCtx(null); }}>
          <div className="who"><span className="bm-eyebrow">{TYPE_LABEL[ctxNode.type]}</span><span className="ref">{ctxNode.type === 'project' ? slug : ctxNode.ref}</span></div>
          {(() => {
            const it = ctxNode.item;
            const live2 = liveSession(ctxNode);
            const row = (label: string, fn: () => void, hint = '') => (
              <button key={label} className="item" onClick={() => { setCtx(null); fn(); }}>
                <span>{label}</span>{hint && <span className="hint">{hint}</span>}
              </button>
            );
            const out = [];
            if (live2) out.push(row('Open session', () => openSession(live2), 'dbl-click'));
            if (!lanesMode) out.push(row(prefs.detailClosed ? 'Show details' : 'Centre on map', () => { setPrefs({ detailClosed: false }); select(ctxNode.key, true); }));
            if (ctxNode.slice) out.push(row('Open on canvas', () => actions.openSlice(ctxNode.slice!, cardEl(ctxNode.key))));
            if (it) {
              out.push(<span key="s1" className="sep" />);
              // Lanes has no details panel, so a verdict is given from here.
              if (lanesMode && ctxNode.status === 'review' && isBuilt(it) && !it.done && !it.reviewTag.trim()) {
                out.push(row('Approve', () => actions.approve(it)));
              }
              out.push(row('Edit item…', () => actions.edit(it)));
              if (ctxNode.status === 'held') out.push(row('Sign off', () => actions.signOff(it)));
              if (!isDone(ctxNode.status) && ctxNode.status !== 'active' && ctxNode.status !== 'review') {
                out.push(row('Run in terminal', () => actions.runInTerminal(it)));
                out.push(row(it.ready ? 'Remove from Ready' : 'Add to Ready', () => actions.setReady(it, !it.ready)));
                out.push(row(it.skipped ? 'Unpark' : 'Park', () => actions.park(it)));
              }
              out.push(row('Archive', () => actions.archive(it)));
              out.push(arming
                ? <button key="del" className="item danger" onClick={() => { setCtx(null); actions.remove(it); }}>
                    <span>Confirm delete</span><span className="hint">{it.source === 'hook' ? 'no undo; a push won’t re-add it' : 'no undo'}</span>
                  </button>
                : <button key="del" className="item danger" onClick={() => setArming(true)}><span>Delete…</span></button>);
            }
            if (ctxNode.type !== 'project') {
              out.push(<span key="s2" className="sep" />);
              out.push(row('Copy reference', () => { void navigator.clipboard?.writeText(ctxNode.ref).catch(() => {}); }, ctxNode.ref));
            }
            return out;
          })()}
        </div>
      )}
    </div>
  );
}

