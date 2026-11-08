// The Terminal screen's Swarm view, the pure parts: where a floating window
// snaps, what a tile's status is, and the tile order. No DOM, so
// scripts/termswarm.test.mjs runs it under Node.
//
// TILE STATUS LEANS TOWARDS IDLE. "working" is drawn green and invites a
// glance, so it needs evidence: real output recently (a live tab) or tmux's own
// activity clock (a session on the host). A session Stack knows nothing about
// reads idle, never working.

export type Rect = { x: number; y: number; w: number; h: number };
export type Zone = 'max' | 'left' | 'right' | 'tl' | 'tr' | 'bl' | 'br' | 'bottom';

const GAP = 8;

/** The rectangle a snap zone fills inside the area `a`. */
export function zoneRect(zone: Zone, a: Rect): Rect {
  const hw = (a.w - 3 * GAP) / 2, hh = (a.h - 3 * GAP) / 2;
  const L = a.x + GAP, R = a.x + 2 * GAP + hw, T = a.y + GAP, B = a.y + 2 * GAP + hh;
  const fw = a.w - 2 * GAP, fh = a.h - 2 * GAP;
  switch (zone) {
    case 'max': return { x: L, y: T, w: fw, h: fh };
    case 'left': return { x: L, y: T, w: hw, h: fh };
    case 'right': return { x: R, y: T, w: hw, h: fh };
    case 'tl': return { x: L, y: T, w: hw, h: hh };
    case 'tr': return { x: R, y: T, w: hw, h: hh };
    case 'bl': return { x: L, y: B, w: hw, h: hh };
    case 'br': return { x: R, y: B, w: hw, h: hh };
    case 'bottom': return { x: L, y: B, w: fw, h: hh };
  }
}

/** The zone a pointer at (x, y) is asking for: within 28px of an edge, a
 *  corner when near both. null = no snap, the window just moves. */
export function zoneAt(x: number, y: number, a: Rect): Zone | null {
  const E = 28;
  const nT = y < a.y + a.h * 0.25, nB = y > a.y + a.h * 0.75;
  const nL = x < a.x + a.w * 0.2, nR = x > a.x + a.w * 0.8;
  if (x < a.x + E) return nT ? 'tl' : nB ? 'bl' : 'left';
  if (x > a.x + a.w - E) return nT ? 'tr' : nB ? 'br' : 'right';
  if (y < a.y + E) return nL ? 'tl' : nR ? 'tr' : 'max';
  if (y > a.y + a.h - E) return nL ? 'bl' : nR ? 'br' : 'bottom';
  return null;
}

/** "Tile N windows": halves, thirds and quarters up to four, a grid past it. */
export function tileRects(n: number, a: Rect): Rect[] {
  const named: Record<number, Zone[]> = { 1: ['max'], 2: ['left', 'right'], 3: ['left', 'tr', 'br'], 4: ['tl', 'tr', 'bl', 'br'] };
  if (named[n]) return named[n].map((z) => zoneRect(z, a));
  const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
  const cw = (a.w - (cols + 1) * GAP) / cols, ch = (a.h - (rows + 1) * GAP) / rows;
  return Array.from({ length: n }, (_, i) => ({
    x: a.x + GAP + (i % cols) * (cw + GAP), y: a.y + GAP + Math.floor(i / cols) * (ch + GAP), w: cw, h: ch,
  }));
}

export const WIN_MIN = { w: 320, h: 200 };

/** Keep a window inside the area, no smaller than the minimum. */
export function clampRect(r: Rect, a: Rect): Rect {
  const w = Math.max(WIN_MIN.w, Math.min(r.w, a.w - 2 * GAP));
  const h = Math.max(WIN_MIN.h, Math.min(r.h, a.h - 2 * GAP));
  return {
    w, h,
    x: Math.max(a.x + GAP, Math.min(r.x, a.x + a.w - GAP - w)),
    y: Math.max(a.y + GAP, Math.min(r.y, a.y + a.h - GAP - h)),
  };
}

export type TileStatus = 'asking' | 'error' | 'working' | 'idle';
/** Asking first, then failed, working, idle: what "Sort by status" does. */
export const STATUS_ORDER: TileStatus[] = ['asking', 'error', 'working', 'idle'];

/** How recent output must be to count as working. */
export const WORKING_MS = 12_000;
/** A host session's activity clock arrives on a 60s push, so its window is wider. */
export const HOST_WORKING_MS = 90_000;

export function tileStatus(o: { asking: boolean; failed: boolean; activeAt: number; now: number; windowMs: number }): TileStatus {
  if (o.asking) return 'asking';
  if (o.failed) return 'error';
  if (o.activeAt > 0 && o.now - o.activeAt < o.windowMs) return 'working';
  return 'idle';
}

/** "now", "4m", "2h", "3d"; '' when the time is unknown. */
export function agoLabel(at: number, now: number): string {
  if (!at) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Tiles in the hand-made order. Keys nobody has placed keep their natural
 *  order after the placed ones, so a new session lands at the end. */
export function orderTiles<T extends { key: string }>(tiles: T[], order: string[]): T[] {
  const at = new Map(order.map((k, i) => [k, i]));
  return tiles
    .map((t, i) => ({ t, i, o: at.has(t.key) ? at.get(t.key)! : order.length + i }))
    .sort((p, q) => p.o - q.o)
    .map((x) => x.t);
}

/** Drop `from` onto `to` (null = the end), over the order currently shown. */
export function moveKey(shown: string[], from: string, to: string | null): string[] {
  if (from === to) return shown;
  const fi = shown.indexOf(from);
  if (fi < 0) return shown;
  const list = shown.filter((k) => k !== from);
  if (to == null) return [...list, from];
  const ti = shown.indexOf(to);
  let at = list.indexOf(to);
  if (at < 0) return shown;
  if (fi < ti) at += 1;
  list.splice(at, 0, from);
  return list;
}

export const GRID_OPTS: { c: number; r: number; note: string }[] = [
  { c: 3, r: 2, note: 'Roomy' }, { c: 4, r: 3, note: 'Comfortable' }, { c: 6, r: 4, note: 'Default' },
  { c: 7, r: 5, note: 'Dense' }, { c: 8, r: 6, note: 'Max' },
];

/** The client's copy of the host preview's narrowing (server/src/term-preview.js),
 *  applied to a live tab's own scrollback: trailing spaces off, blank runs
 *  collapsed, trailing blanks dropped, the last `n` lines kept. */
export function compactLines(lines: string[], n = 14): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '').slice(0, 240);
    if (!l && (!out.length || out[out.length - 1] === '')) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.slice(-n);
}
