// NOTES BOARD — the geometry behind the Notes canvas (detail/Notes.tsx). Pure,
// so scripts/notes-board.test.mjs covers it.
//
//  • A NOTE NEVER PLACED (`board` is {}) is given a spot, not saved one: it
//    flows into a masonry below the placed notes, and only a drag writes it.
//  • TIDY IS A VIEW, never a write, until a note is dragged out of it; then
//    the tidy places become the stored ones (`flatten` in Notes.tsx).
//  • A CLUSTER IS ITS MEMBERS: its box is drawn round them, and a cluster of
//    fewer than two is no cluster (`prune`).

import type { NoteBoard, NoteKind } from '../types';

export const NOTE_W = 230;
export const PAD = 20;      // a cluster's margin round its notes
export const HEAD = 44;     // a cluster's name strip above them
export const GAP = 24;
export const X0 = 40;
export const Y0 = 40;
export const MESS = 0.4;    // how far the stored tilt is drawn

export const KINDS: { id: NoteKind; label: string }[] = [
  { id: 'note', label: 'Note' },
  { id: 'idea', label: 'Idea' },
  { id: 'question', label: 'Question' },
  { id: 'bug', label: 'Bug' },
];

export interface Placed { id: number; x: number; y: number; w: number; r: number; pinned: boolean; cluster: string | null }
export interface Rect { x: number; y: number; w: number; h: number }
export interface ClusterRect extends Rect { id: string }

/** A stable tilt from the id, in the stored range (-5..5). */
export const tiltOf = (id: number) => ((Math.abs(id) * 37) % 100) / 10 - 5;

const isPlaced = (b: NoteBoard | undefined) => typeof b?.x === 'number' && typeof b?.y === 'number';

/** Where every note sits: its stored place, or a masonry slot below the placed ones. */
export function place(notes: { id: number; board?: NoteBoard }[], heightOf: (id: number) => number, cols = 4): Placed[] {
  const out: Placed[] = [];
  let bottom = 0;
  for (const n of notes) {
    const b = n.board || {};
    if (!isPlaced(b)) continue;
    const w = b.w ?? NOTE_W;
    out.push({ id: n.id, x: b.x!, y: b.y!, w, r: b.r ?? tiltOf(n.id), pinned: !!b.pinned, cluster: b.cluster || null });
    bottom = Math.max(bottom, b.y! + heightOf(n.id));
  }
  const hs = Array<number>(Math.max(1, cols)).fill(out.length ? bottom + 2 * GAP : Y0);
  for (const n of notes) {
    const b = n.board || {};
    if (isPlaced(b)) continue;
    const c = hs.indexOf(Math.min(...hs));
    out.push({ id: n.id, x: X0 + c * (NOTE_W + GAP), y: hs[c], w: b.w ?? NOTE_W, r: b.r ?? tiltOf(n.id), pinned: !!b.pinned, cluster: b.cluster || null });
    hs[c] += heightOf(n.id) + GAP;
  }
  return out;
}

/** The tidy view: each cluster a column of its own, pinned first, then the loose notes in a masonry. */
export function tidy(placed: Placed[], clusterOrder: string[], heightOf: (id: number) => number, cols: number): Placed[] {
  const COLS = Math.max(2, cols);
  const colX = (i: number) => X0 + i * (NOTE_W + GAP + 2 * PAD) + PAD;
  const pinnedFirst = (a: Placed, b: Placed) => Number(b.pinned) - Number(a.pinned);
  const out: Placed[] = [];
  let col = 0;
  for (const cid of clusterOrder) {
    if (col >= COLS - 1) break;
    let y = Y0 + HEAD;
    for (const n of placed.filter((p) => p.cluster === cid).sort(pinnedFirst)) {
      out.push({ ...n, x: colX(col), y, w: NOTE_W, r: 0 });
      y += heightOf(n.id) + GAP;
    }
    col++;
  }
  const hs = Array.from({ length: COLS }, (_, i) => (i < col ? Infinity : Y0));
  for (const n of placed.filter((p) => !out.some((o) => o.id === p.id)).sort(pinnedFirst)) {
    const c = hs.indexOf(Math.min(...hs));
    out.push({ ...n, x: colX(c), y: hs[c], w: NOTE_W, r: 0 });
    hs[c] += heightOf(n.id) + GAP;
  }
  return out;
}

/** The box drawn round each cluster's members. */
export function clusterRects(placed: Placed[], heightOf: (id: number) => number): ClusterRect[] {
  const ids = [...new Set(placed.map((p) => p.cluster).filter((c): c is string => !!c))];
  return ids.map((id) => {
    const ms = placed.filter((p) => p.cluster === id);
    const x0 = Math.min(...ms.map((n) => n.x)), y0 = Math.min(...ms.map((n) => n.y));
    const x1 = Math.max(...ms.map((n) => n.x + n.w)), y1 = Math.max(...ms.map((n) => n.y + heightOf(n.id)));
    return { id, x: x0 - PAD, y: y0 - HEAD, w: x1 - x0 + 2 * PAD, h: y1 - y0 + HEAD + PAD };
  });
}

const inside = (p: { x: number; y: number }, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

export type Target = { type: 'note'; id: number } | { type: 'cluster'; id: string } | null;

/** What a dragged note is over: another note (topmost first), else a cluster's box. Never itself or its own cluster. */
export function hitTest(pt: { x: number; y: number }, self: Placed, placed: Placed[], rects: ClusterRect[],
  heightOf: (id: number) => number, zOf: (id: number) => number): Target {
  const others = placed
    .filter((n) => n.id !== self.id && (!self.cluster || n.cluster !== self.cluster))
    .sort((a, b) => zOf(b.id) - zOf(a.id));
  const hit = others.find((n) => inside(pt, { x: n.x, y: n.y, w: n.w, h: heightOf(n.id) }));
  if (hit) return hit.cluster ? { type: 'cluster', id: hit.cluster } : { type: 'note', id: hit.id };
  const box = rects.find((c) => c.id !== self.cluster && inside(pt, c));
  return box ? { type: 'cluster', id: box.id } : null;
}

export const outside = (pt: { x: number; y: number }, r: Rect | undefined) => !r || !inside(pt, r);

/** The clusters left with a single member: that member is no longer in a cluster. */
export function lonely(notes: { id: number; board?: NoteBoard }[]): number[] {
  const count = new Map<string, number>();
  for (const n of notes) if (n.board?.cluster) count.set(n.board.cluster, (count.get(n.board.cluster) || 0) + 1);
  return notes.filter((n) => n.board?.cluster && count.get(n.board.cluster)! < 2).map((n) => n.id);
}

/** A cluster's name: the first member (by id) that carries one. */
export function clusterName(notes: { id: number; board?: NoteBoard }[], cid: string): string {
  return [...notes].sort((a, b) => a.id - b.id).find((n) => n.board?.cluster === cid && n.board.clusterName)?.board?.clusterName || '';
}
