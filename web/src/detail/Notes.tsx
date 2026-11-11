// NOTES — the owner's loose ideas, a rail row of their own under the board
// (owner's call, 2026-11-09), drawn as a canvas of sticky notes (Notes v2
// design, 2026-11-11). A note is not work: nothing counts it, nothing runs it,
// and no agent reads it. It is where an idea waits until it is ready to become
// a MILESTONE, a SLICE or a TASK.
//
//  • A NOTE IS A `note` ARTIFACT (routes/artifacts.js): Markdown, its first
//    line is its title. The plain Artifacts list leaves notes out.
//  • ITS PLACE IS `board` ({x, y, r, w, kind, pinned, cluster, clusterName}),
//    written only by a drag, a pin, a kind or a cluster change, and a write of
//    `board` alone never moves the note's "edited" time. The geometry is
//    lib/notesBoard.ts. A pinned note does not drag; Tidy is a view until a
//    drag (then the tidy places are saved, `flatten`).
//  • A NEW NOTE FROM A DOUBLE-CLICK IS LOCAL (negative id) until it has text:
//    blurring it empty drops it, so the canvas never files a blank note.
//  • TURNING ONE INTO WORK splits it: the first line names the new milestone,
//    slice or task, and the rest becomes its goal, spec or notes. It is an
//    ordinary create (a milestone is born Upcoming, never current; a task with
//    no slice goes to the Icebox), the same writes the board and Milestones
//    make.
//  • A CONVERTED NOTE IS KEPT, tagged `converted` and `became:<kind>:<id>`,
//    so where an idea went stays findable. It leaves the canvas for the
//    "Ideas that went somewhere" list below it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import { Markdown } from '../components/Markdown';
import type { Artifact, Milestone, NoteBoard, NoteKind, Slice } from '../types';
import { getNotes, createArtifact, patchArtifact, deleteArtifact, createMilestone, createSlice, createRoadmapItem, setStarred } from '../store';
import { StarButton } from '../components/Star';
import { SlicePicker, currentMilestone } from './Spine';
import { PRIORITY_DEFAULT, timeAgo } from '../lib/ui';
import {
  KINDS, MESS, NOTE_W, HEAD, PAD, place, tidy as tidyLayout, clusterRects, hitTest, outside, lonely, clusterName,
  type Placed, type Target,
} from '../lib/notesBoard';

type Kind = 'milestone' | 'slice' | 'task';
const KIND_LABEL: Record<Kind, string> = { milestone: 'Milestone', slice: 'Slice', task: 'Task' };

/** The first non-empty line, without a heading or list marker, and the rest. */
function split(body: string): { head: string; rest: string } {
  const lines = body.split('\n');
  const i = lines.findIndex((l) => l.trim());
  if (i < 0) return { head: '', rest: '' };
  const head = lines[i].replace(/^\s*(#+|[-*]|\d+\.)\s*/, '').trim();
  return { head, rest: lines.slice(i + 1).join('\n').trim() };
}
const titleOf = (body: string) => split(body).head.slice(0, 300) || 'Note';
const became = (n: Artifact) => {
  const tag = n.tags.find((t) => t.startsWith('became:'));
  if (!tag) return null;
  const [, kind, id] = tag.split(':');
  return { kind: kind as Kind, id: Number(id) };
};
const newKey = () => `c${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

type Drag =
  | { type: 'note'; id: number; sx: number; sy: number; ox: number; oy: number; ta: HTMLTextAreaElement | null; live: boolean }
  | { type: 'cluster'; id: string; sx: number; sy: number; members: { id: number; ox: number; oy: number }[]; live: boolean };

export function Notes({ slug, milestones, slices, onRefresh }: {
  slug: string; milestones: Milestone[]; slices: Slice[]; onRefresh: () => void;
}) {
  const [notes, setNotes] = useState<Artifact[] | null>(null);
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const [tidy, setTidy] = useState(false);
  const [dragging, setDragging] = useState<number | string | null>(null);
  const [target, setTarget] = useState<Target>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const z = useRef(new Map<number, number>());
  const top = useRef(1);
  const localId = useRef(-1);
  const heights = useRef(new Map<number, number>());
  const boardRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const ro = useRef<ResizeObserver | null>(null);

  const load = useCallback(() => {
    getNotes(slug).then(setNotes).catch((e) => setErr((e as Error)?.message || 'Could not read the notes.'));
  }, [slug]);
  useEffect(() => { setNotes(null); setSel(null); load(); }, [load]);

  const fail = (e: unknown) => setErr((e as Error)?.message || 'Something went wrong.');
  const put = (a: Artifact) => setNotes((xs) => {
    const list = xs || [];
    return list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a];
  });
  const guard = async (fn: () => Promise<void>) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); }
  };

  // ── heights, measured: a cluster's box and the tidy columns are drawn from them
  useEffect(() => {
    ro.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const en of entries) {
        const el = en.target as HTMLElement;
        const id = Number(el.dataset.note), h = el.offsetHeight;
        if (heights.current.get(id) !== h) { heights.current.set(id, h); changed = true; }
      }
      if (changed) setTick((t) => t + 1);
    });
    return () => ro.current?.disconnect();
  }, []);
  const observe = (el: HTMLDivElement | null) => { if (el && ro.current) ro.current.observe(el); };
  const hOf = (id: number) => heights.current.get(id) || 110;
  const zOf = (id: number) => z.current.get(id) || 0;
  const raise = (id: number) => { top.current += 1; z.current.set(id, top.current); };

  // ── the canvas's notes and where they sit
  const sorted = useMemo(() => [...(notes || [])].sort((a, b) => a.id - b.id), [notes]);
  const open = useMemo(() => sorted.filter((n) => !n.tags.includes('converted')), [sorted]);
  const done = useMemo(() => sorted.filter((n) => n.tags.includes('converted')).reverse(), [sorted]);
  const byId = (id: number) => open.find((n) => n.id === id);
  const cols = Math.max(2, Math.min(5, Math.floor(((boardRef.current?.clientWidth || 1200) - 40) / (NOTE_W + 64))));
  const stored = place(open, hOf, cols);
  const clusterOrder = [...new Set(open.map((n) => n.board?.cluster).filter((c): c is string => !!c))];
  const placed: Placed[] = tidy ? tidyLayout(stored, clusterOrder, hOf, cols) : stored;
  const rects = clusterRects(placed, hOf);
  const placedRef = useRef(placed); placedRef.current = placed;
  const rectsRef = useRef(rects); rectsRef.current = rects;
  const openRef = useRef(open); openRef.current = open;

  // ── writes
  // A board write is a move: the note's own state changes now, the PATCH follows,
  // and a failure re-reads the truth. A local (unsaved) note has nothing to PATCH.
  const patchBoard = (id: number, board: NoteBoard) => {
    if (id > 0) patchArtifact(slug, id, { board }).catch((e) => { fail(e); load(); });
  };
  // Never-placed notes flow below the placed ones, so the first note placed
  // would send the rest jumping. Before any placement, each one is saved
  // where it is drawn now (a one-off: after it, nothing is unplaced).
  const settle = (except: Map<number, NoteBoard> = new Map()) => {
    const fixed = new Map<number, NoteBoard>();
    for (const p of placedRef.current) {
      const n = openRef.current.find((x) => x.id === p.id);
      if (!n || except.has(p.id) || (typeof n.board?.x === 'number' && typeof n.board?.y === 'number')) continue;
      fixed.set(p.id, { ...(n.board || {}), x: p.x, y: p.y, w: p.w, r: p.r });
    }
    if (!fixed.size) return;
    setNotes((xs) => (xs || []).map((n) => (fixed.has(n.id) ? { ...n, board: fixed.get(n.id) } : n)));
    for (const [id, board] of fixed) patchBoard(id, board);
  };
  const setBoards = (patches: Map<number, NoteBoard>, save = true) => {
    if (!patches.size) return;
    settle(patches);
    setNotes((xs) => (xs || []).map((n) => (patches.has(n.id) ? { ...n, board: patches.get(n.id) } : n)));
    if (save) for (const [id, board] of patches) patchBoard(id, board);
  };
  const boardOf = (id: number): NoteBoard => {
    const n = openRef.current.find((x) => x.id === id);
    const p = placedRef.current.find((x) => x.id === id);
    return { ...(n?.board || {}), ...(p ? { x: p.x, y: p.y, w: p.w, r: n?.board?.r ?? p.r } : {}) };
  };
  /** Clear the cluster from whoever is left alone in one, on top of `next`;
   *  a clustered note keeps clear of the edge so its box stays on the board. */
  const withPrune = (next: Map<number, NoteBoard>) => {
    for (const [id, b] of next) {
      if (b.cluster) next.set(id, { ...b, x: Math.max(PAD, b.x ?? PAD), y: Math.max(HEAD, b.y ?? HEAD) });
    }
    const after = openRef.current.map((n) => ({ id: n.id, board: next.get(n.id) ?? n.board }));
    for (const id of lonely(after)) {
      const b = { ...(next.get(id) ?? after.find((a) => a.id === id)!.board ?? {}) };
      delete b.cluster; delete b.clusterName;
      next.set(id, b);
    }
    return next;
  };
  // Leaving Tidy by a drag keeps the tidy places: they become the stored ones.
  const flatten = () => {
    if (!tidy) return;
    const next = new Map<number, NoteBoard>();
    for (const p of placedRef.current) next.set(p.id, { ...boardOf(p.id), x: p.x, y: p.y, w: p.w });
    setTidy(false);
    setBoards(next);
  };

  const star = (n: Artifact) => guard(async () => {
    const r = await setStarred(slug, 'docs', n.id, !n.starredAt);
    put({ ...n, starredAt: r.starredAt });
    onRefresh();
  });

  const saveText = (n: Artifact, text: string) => {
    const body = text.trim();
    if (n.id < 0) {
      // A local note: filed on its first words, dropped if it never had any.
      if (!body) { setNotes((xs) => (xs || []).filter((x) => x.id !== n.id)); return; }
      guard(async () => {
        const made = await createArtifact(slug, { type: 'note', title: titleOf(body), body, board: n.board || {} });
        z.current.set(made.id, zOf(n.id));
        setNotes((xs) => (xs || []).map((x) => (x.id === n.id ? made : x)));
        setSel((s) => (s === n.id ? made.id : s));
      });
      return;
    }
    if (!body || body === n.body) return;
    guard(async () => { put(await patchArtifact(slug, n.id, { body, title: titleOf(body) })); });
  };

  const addAt = (x: number, y: number, cluster: string | null) => {
    settle();
    const id = localId.current--;
    raise(id);
    const board: NoteBoard = {
      x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), w: Math.round(200 + Math.random() * 50),
      r: Math.round((Math.random() * 10 - 5) * 10) / 10, kind: 'note',
      ...(cluster ? { cluster, clusterName: clusterName(openRef.current, cluster) || undefined } : {}),
    };
    const now = new Date().toISOString();
    setNotes((xs) => [...(xs || []), {
      id, type: 'note', title: '', body: '', url: '', tags: [], links: [], origin: {}, file: null, status: '', sliceId: null,
      starredAt: null, board, createdAt: now, updatedAt: now,
    }]);
    setSel(id); setFocusId(id);
  };

  const addDraft = () => {
    const body = draft.trim();
    if (!body || busy) return;
    const el = boardRef.current;
    const x = (el?.scrollLeft || 0) + 80 + Math.random() * Math.max(40, (el?.clientWidth || 800) - 400);
    const y = (el?.scrollTop || 0) + 60 + Math.random() * Math.max(40, (el?.clientHeight || 600) - 340);
    flatten();
    settle();
    guard(async () => {
      const made = await createArtifact(slug, {
        type: 'note', title: titleOf(body), body,
        board: { x: Math.round(x), y: Math.round(y), w: Math.round(200 + Math.random() * 50), r: Math.round((Math.random() * 10 - 5) * 10) / 10, kind: 'note' },
      });
      raise(made.id);
      put(made); setSel(made.id); setDraft('');
    });
  };

  const remove = (n: Artifact) => {
    setSel(null);
    const rest = openRef.current.filter((x) => x.id !== n.id);
    setNotes((xs) => (xs || []).filter((x) => x.id !== n.id));
    if (n.id > 0) deleteArtifact(slug, n.id).catch((e) => { fail(e); load(); });
    const prune = new Map<number, NoteBoard>();
    const after = rest.map((x) => ({ id: x.id, board: x.board }));
    for (const id of lonely(after)) {
      const b = { ...(rest.find((x) => x.id === id)!.board || {}) };
      delete b.cluster; delete b.clusterName;
      prune.set(id, b);
    }
    setBoards(prune);
  };

  const whereTo = (n: Artifact) => {
    const b = became(n);
    if (!b) return 'Converted';
    if (b.kind === 'milestone') return `Became milestone “${milestones.find((m) => m.id === b.id)?.name ?? `#${b.id}`}”`;
    if (b.kind === 'slice') return `Became slice “${slices.find((s) => s.id === b.id)?.title ?? `#${b.id}`}”`;
    return `Became task #${b.id}`;
  };

  const convert = (n: Artifact, kind: Kind, target: number | null) => guard(async () => {
    const { head, rest } = split(n.body);
    if (!head) throw new Error('This note has no first line to name it by.');
    let id: number;
    if (kind === 'milestone') {
      id = (await createMilestone(slug, { name: head.slice(0, 120), goal: rest })).id;
    } else if (kind === 'slice') {
      if (target === null) throw new Error('Pick the milestone this slice belongs to.');
      id = (await createSlice(slug, { title: head.slice(0, 200), spec: rest, milestoneId: target })).id;
    } else {
      id = (await createRoadmapItem(slug, {
        title: head, note: rest, bucket: PRIORITY_DEFAULT, kind: 'task', ...(target !== null ? { sliceId: target } : {}),
      })).id;
    }
    put(await patchArtifact(slug, n.id, { tags: [...n.tags.filter((t) => t !== 'converted' && !t.startsWith('became:')), 'converted', `became:${kind}:${id}`] }));
    setSel(null);
    onRefresh();
  });

  // ── dragging
  const pt = (e: { clientX: number; clientY: number }) => {
    const b = innerRef.current!.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const onMove = useRef<(e: PointerEvent) => void>(() => {});
  const onUp = useRef<(e: PointerEvent) => void>(() => {});
  const moveL = useCallback((e: PointerEvent) => onMove.current(e), []);
  const upL = useCallback((e: PointerEvent) => onUp.current(e), []);
  const unlisten = () => { window.removeEventListener('pointermove', moveL); window.removeEventListener('pointerup', upL); };
  const listen = () => { window.addEventListener('pointermove', moveL); window.addEventListener('pointerup', upL); };
  useEffect(() => unlisten, []);

  onMove.current = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.live) {
      if (Math.hypot(dx, dy) < 4) return;
      d.live = true;
      flatten();
      setDragging(d.id);
    }
    if (d.type === 'cluster') {
      const next = new Map<number, NoteBoard>();
      for (const m of d.members) next.set(m.id, { ...boardOf(m.id), x: Math.max(PAD, m.ox + dx), y: Math.max(HEAD, m.oy + dy) });
      setBoards(next, false);
      return;
    }
    setBoards(new Map([[d.id, { ...boardOf(d.id), x: Math.max(0, d.ox + dx), y: Math.max(0, d.oy + dy) }]]), false);
    const self = placedRef.current.find((p) => p.id === d.id);
    if (!self) return;
    const t = hitTest(pt(e), self, placedRef.current, rectsRef.current, hOf, zOf);
    setTarget((cur) => (JSON.stringify(cur) === JSON.stringify(t) ? cur : t));
  };

  onUp.current = (e) => {
    const d = drag.current;
    unlisten();
    drag.current = null;
    if (!d) return;
    if (!d.live) {
      if (d.type === 'note') {
        setSel(d.id);
        if (d.ta) { d.ta.focus(); const L = d.ta.value.length; d.ta.setSelectionRange(L, L); }
      }
      return;
    }
    setDragging(null);
    if (d.type === 'cluster') {
      const next = new Map<number, NoteBoard>();
      for (const m of d.members) next.set(m.id, boardOf(m.id));
      setBoards(next);
      return;
    }
    const t = target;
    setTarget(null);
    const me = boardOf(d.id);
    const next = new Map<number, NoteBoard>();
    if (t && t.type === 'note') {
      const cid = newKey();
      next.set(d.id, { ...me, cluster: cid, clusterName: undefined });
      next.set(t.id, { ...boardOf(t.id), cluster: cid, clusterName: undefined });
    } else if (t && t.type === 'cluster') {
      const name = clusterName(openRef.current, t.id);
      next.set(d.id, { ...me, cluster: t.id, ...(name ? { clusterName: name } : { clusterName: undefined }) });
    } else if (me.cluster && outside(pt(e), rectsRef.current.find((r) => r.id === me.cluster))) {
      const b = { ...me }; delete b.cluster; delete b.clusterName;
      next.set(d.id, b);
    } else {
      next.set(d.id, me);
    }
    setBoards(withPrune(next));
  };

  const startDrag = (n: Placed, e: RPointerEvent) => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    const ta = el.closest('textarea');
    raise(n.id);
    if (el.closest('button,input,select,a,.nt-panel') || (ta && document.activeElement === ta) || n.pinned) {
      setSel(n.id); setTick((t) => t + 1);
      return;
    }
    e.preventDefault();
    drag.current = { type: 'note', id: n.id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, ta, live: false };
    setTick((t) => t + 1);
    listen();
  };
  const startClusterDrag = (cid: string, e: RPointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('input')) return;
    e.preventDefault(); e.stopPropagation();
    const members = placedRef.current.filter((p) => p.cluster === cid && !p.pinned).map((p) => ({ id: p.id, ox: p.x, oy: p.y }));
    drag.current = { type: 'cluster', id: cid, sx: e.clientX, sy: e.clientY, members, live: false };
    setSel(null);
    listen();
  };

  const renameCluster = (cid: string, name: string, save: boolean) => {
    const next = new Map<number, NoteBoard>();
    for (const n of openRef.current) {
      if (n.board?.cluster !== cid) continue;
      next.set(n.id, { ...n.board, clusterName: name || undefined });
    }
    setBoards(next, save);
  };

  // Focus a new local note once it is on the canvas.
  useEffect(() => {
    if (focusId === null) return;
    document.querySelector<HTMLTextAreaElement>(`[data-note="${focusId}"] textarea`)?.focus();
    setFocusId(null);
  }, [focusId, notes]);

  const innerW = Math.max(1200, ...placed.map((p) => p.x + p.w + 200));
  const innerH = Math.max(820, ...placed.map((p) => p.y + hOf(p.id) + 220));
  const onBoard = (e: { target: EventTarget }) => !!(e.target as HTMLElement).dataset?.board;

  return (
    <div className="nt">
      <div className="nt-head">
        <h2 className="nt-title">Notes</h2>
        <div className="nt-tools">
          <span className="nt-hint">Double-click to drop a note · drag anywhere to move · drop on another to cluster</span>
          <span className="nt-count">{open.filter((n) => n.id > 0).length} notes</span>
          <button type="button" className="nt-tidy" onClick={() => setTidy((t) => !t)} aria-pressed={tidy}>
            {tidy ? 'Mess it up' : 'Tidy up'}
          </button>
        </div>
      </div>
      {err && <div className="km-err" role="alert">{err}</div>}

      <div className="nt-stage">
        <div ref={boardRef} className="nt-board" data-board="1"
          onPointerDown={(e) => { if (onBoard(e)) setSel(null); }}
          onDoubleClick={(e) => {
            if (!onBoard(e)) return;
            const p = pt(e);
            flatten();
            addAt(p.x - 100, p.y - 30, (e.target as HTMLElement).dataset.cluster || null);
          }}>
          <div ref={innerRef} className="nt-inner" data-board="1" style={{ width: innerW, height: innerH }}>
            {notes === null && !err && <span className="nt-reading">Reading…</span>}
            {notes !== null && open.length === 0 && (
              <div className="nt-empty" data-board="1">
                <p>Start anywhere.</p>
                <span>Double-click the board, or write below. A sentence is enough.</span>
              </div>
            )}
            {rects.map((r) => {
              const isT = target?.type === 'cluster' && target.id === r.id;
              const live = dragging === r.id || placed.some((p) => p.cluster === r.id && dragging === p.id);
              const name = clusterName(open, r.id);
              return (
                <div key={r.id} className={`nt-cluster${isT ? ' target' : ''}${live ? ' live' : ''}${dragging === r.id ? ' grabbing' : ''}`}
                  data-board="1" data-cluster={r.id}
                  style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                  onPointerDown={(e) => startClusterDrag(r.id, e)}>
                  <div className="nt-cluster-name" data-board="1" data-cluster={r.id}>
                    <span className="nt-grip" aria-hidden>⋮⋮</span>
                    <input value={name} placeholder="Name this cluster" aria-label="Cluster name"
                      onChange={(e) => renameCluster(r.id, e.target.value, false)}
                      onBlur={(e) => renameCluster(r.id, e.target.value.trim(), true)}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                    <span className="nt-cluster-n">{placed.filter((p) => p.cluster === r.id).length}</span>
                  </div>
                </div>
              );
            })}
            {placed.map((p) => {
              const n = byId(p.id);
              if (!n) return null;
              const isT = target?.type === 'note' && target.id === p.id;
              return (
                <Sticky key={p.id} note={n} p={p} z={zOf(p.id)} selected={sel === p.id} dragging={dragging === p.id}
                  settling={dragging !== null && (dragging === p.id || dragging === p.cluster)}
                  target={isT} busy={busy} milestones={milestones} slices={slices}
                  measure={observe}
                  onDown={(e) => startDrag(p, e)}
                  onFocus={() => { raise(p.id); setSel(p.id); }}
                  onSave={(text) => saveText(n, text)}
                  onKind={(kind) => setBoards(new Map([[p.id, { ...boardOf(p.id), kind }]]))}
                  onPin={() => setBoards(new Map([[p.id, { ...boardOf(p.id), pinned: !n.board?.pinned }]]))}
                  onUncluster={() => {
                    const b = { ...boardOf(p.id), x: p.x + 40, y: p.y + 40 }; delete b.cluster; delete b.clusterName;
                    setBoards(withPrune(new Map([[p.id, b]])));
                  }}
                  onDelete={() => remove(n)}
                  onStar={() => star(n)}
                  onConvert={(kind, t) => convert(n, kind, t)} />
              );
            })}
          </div>
        </div>

        <div className="nt-compose">
          <textarea value={draft} rows={1} placeholder="What’s on your mind?" aria-label="New note"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addDraft(); } }} />
          <span className="nt-kbd">⌘↵</span>
          <button type="button" className="k-btn sm" onClick={addDraft} disabled={busy || !draft.trim()}>Add</button>
        </div>
      </div>

      {done.length > 0 && (
        <details className="nt-done">
          <summary><span className="sp-eyebrow">Ideas that went somewhere</span><span className="sp-dim">{done.length}</span></summary>
          <div className="nt-list">
            {done.map((n) => (
              <div key={n.id} className="nt-card converted" data-hl={`note-${n.id}`}>
                <div className="nt-body"><Markdown text={n.body} /></div>
                <div className="nt-foot">
                  <span className="k-tag success">{whereTo(n)}</span>
                  <span className="sp-rule" />
                  <span className="sp-when">{timeAgo(n.updatedAt)}</span>
                  <StarButton on={!!n.starredAt} onToggle={() => star(n)} what="this note" />
                  <button className="k-btn ghost sm" disabled={busy}
                    onClick={() => guard(async () => { put(await patchArtifact(slug, n.id, { tags: n.tags.filter((t) => t !== 'converted' && !t.startsWith('became:')) })); })}>
                    Reopen
                  </button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function Sticky({ note, p, z, selected, dragging, settling, target, busy, milestones, slices, measure,
  onDown, onFocus, onSave, onKind, onPin, onUncluster, onDelete, onStar, onConvert }: {
  note: Artifact; p: Placed; z: number; selected: boolean; dragging: boolean; settling: boolean; target: boolean; busy: boolean;
  milestones: Milestone[]; slices: Slice[];
  measure: (el: HTMLDivElement | null) => void;
  onDown: (e: RPointerEvent) => void; onFocus: () => void; onSave: (text: string) => void;
  onKind: (k: NoteKind) => void; onPin: () => void; onUncluster: () => void; onDelete: () => void; onStar: () => void;
  onConvert: (kind: Kind, target: number | null) => void;
}) {
  const [text, setText] = useState(note.body);
  const [confirming, setConfirming] = useState(false);
  const [turning, setTurning] = useState(false);
  const [kind, setKind] = useState<Kind>('task');
  const live = milestones.filter((m) => m.status !== 'done');
  const [msId, setMsId] = useState<number | null>(currentMilestone(milestones)?.id ?? live[0]?.id ?? null);
  const [sliceId, setSliceId] = useState<number | null>(null);
  useEffect(() => { setText(note.body); }, [note.body]);
  useEffect(() => { if (!selected) { setTurning(false); setConfirming(false); } }, [selected]);
  const { head, rest } = split(note.body);
  const into = kind === 'milestone' ? 'its goal' : kind === 'slice' ? 'its spec' : 'its notes';
  const nk: NoteKind = note.board?.kind || 'note';
  const pinned = !!note.board?.pinned;
  const saved = note.id > 0;
  const cls = ['nt-note', `k-${nk}`, selected && 'sel', dragging && 'dragging', settling && 'still', target && 'target', pinned && 'pinned']
    .filter(Boolean).join(' ');

  return (
    <div ref={measure} className={cls} data-note={note.id} data-hl={saved ? `note-${note.id}` : undefined}
      style={{ left: p.x, top: p.y, width: p.w, zIndex: z + 1, transform: `rotate(${dragging || pinned ? 0 : p.r * MESS}deg)` }}
      onPointerDown={onDown}>
      {pinned && <span className="nt-pinhead" aria-hidden />}
      <div className="nt-in">
        <textarea value={text} rows={1} placeholder="Something half-formed…" aria-label="Note"
          onChange={(e) => setText(e.target.value)}
          onFocus={onFocus}
          onBlur={() => onSave(text)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
            if (e.key === 'Escape') { setText(note.body); (e.target as HTMLTextAreaElement).blur(); }
          }} />
        <div className="nt-meta">
          <span className="nt-kind"><span className="nt-dot" />{KINDS.find((k) => k.id === nk)?.label}</span>
          <span className="nt-age">{saved ? timeAgo(note.updatedAt) : 'just now'}</span>
          <span className="nt-gap" />
          {saved && <StarButton on={!!note.starredAt} onToggle={onStar} what="this note" size={13} />}
          <button type="button" className={`nt-pin${pinned ? ' on' : ''}`} onClick={onPin} aria-pressed={pinned}
            title={pinned ? 'Unpin' : 'Pin in place'} aria-label={pinned ? 'Unpin' : 'Pin in place'}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden>
              <path d="M9.5 1.8l4.7 4.7-1.6.8-2.6 2.6-.4 3.3-6.8-6.8 3.3-.4 2.6-2.6z" /><path d="M5.2 10.8L1.8 14.2" fill="none" />
            </svg>
          </button>
        </div>
        {selected && (
          <div className="nt-panel">
            <div className="nt-kinds" role="group" aria-label="Kind of note">
              {KINDS.map((k) => (
                <button key={k.id} type="button" className={`nt-chip${k.id === nk ? ' on' : ''}`} aria-pressed={k.id === nk}
                  onClick={() => onKind(k.id)}>{k.label}</button>
              ))}
            </div>
            <div className="nt-acts">
              {saved && (
                <button type="button" className={`nt-link${turning ? ' on' : ''}`} onClick={() => setTurning(!turning)} aria-expanded={turning}>
                  Turn into… ↗
                </button>
              )}
              <span className="nt-gap" />
              {p.cluster && <button type="button" className="nt-quiet" onClick={onUncluster}>Ungroup</button>}
              <button type="button" className="nt-quiet danger" onClick={() => (confirming ? onDelete() : setConfirming(true))}
                onBlur={() => setConfirming(false)}>
                {confirming ? 'Really delete?' : 'Delete'}
              </button>
            </div>
            {turning && (
              <div className="nt-turn">
                <div className="seg-control sm" role="tablist" aria-label="Turn this note into">
                  {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                    <button key={k} role="tab" aria-selected={kind === k} className={`seg-opt${kind === k ? ' on' : ''}`}
                      onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>
                  ))}
                </div>
                {kind === 'slice' && (
                  <select className="k-select sm" aria-label="Milestone for the new slice" value={msId === null ? '' : String(msId)}
                    onChange={(e) => setMsId(e.target.value === '' ? null : Number(e.target.value))}>
                    {live.length === 0 && <option value="">No open milestone</option>}
                    {live.map((m) => <option key={m.id} value={m.id}>{m.name}{m.status === 'active' ? ' (current)' : ''}</option>)}
                  </select>
                )}
                {kind === 'task' && (
                  <SlicePicker value={sliceId} slices={slices} milestones={milestones} onPick={setSliceId}
                    label="Slice for the new task" iceboxLabel="Icebox (no slice yet)" />
                )}
                <span className="nt-preview">
                  {head
                    ? <>“{head}”{rest ? <>, the rest as {into}</> : null}{kind === 'milestone' ? ', as an upcoming milestone' : ''}</>
                    : 'This note has no first line to name it by.'}
                </span>
                <button className="k-btn sm" disabled={busy || !head || (kind === 'slice' && msId === null)}
                  onClick={() => { setTurning(false); onConvert(kind, kind === 'slice' ? msId : kind === 'task' ? sliceId : null); }}>
                  Create {KIND_LABEL[kind].toLowerCase()}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
