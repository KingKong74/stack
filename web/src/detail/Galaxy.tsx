import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Future } from '../types';
import type { Pan } from '../lib/skyView';

// The Polaris galaxy (#312) — the sky rebuilt as a solar system, from the
// Polaris Galaxy design handoff.
//
// The old sky put every idea on a verdict RING and gave each theme a bearing,
// which said everything about how an idea was judged and nothing about how
// ideas relate. The galaxy says both. Nothing here is a stored "kind": an
// idea's shape is read off two columns (`isStar`, `parentId`), so there is
// exactly one place a thing can be and no way for the two to disagree —
//
//   ★ star    a promoted idea with an orbit of its own
//   ● planet  an idea in a star's orbit
//   ○ moon    a piece of a planet
//   ◦ shell   judged, adopted by no star — rides one of the north star's
//             three shells (on course closest in, off course furthest out)
//   · belt    unjudged — the drift belt, which is also the judge queue
//
// Magnitude (1–5) is how much work an idea is, and it is the node's SIZE, so a
// glance at the sky reads as "how much is out there", not just "how much is
// judged". It is nullable on purpose: an unsized idea draws at its smallest and
// the rail says "not sized yet" rather than inventing an estimate.

export type GxKind = 'star' | 'planet' | 'moon' | 'shell' | 'belt';

export const MAG_WORD: Record<number, string> = {
  1: 'an afternoon', 2: 'a few days', 3: 'a week', 4: 'a couple of weeks', 5: 'a quarter',
};

// Verdict → the tone token it wears everywhere in the galaxy. Off course is
// --critical (the app's own convention for it) rather than a grey.
export const GX_TONE: Record<string, string> = {
  'on-course': 'var(--live)',
  tangent: 'var(--building)',
  'off-course': 'var(--critical)',
  '': 'var(--accent)',
};
export const GX_LABEL: Record<string, string> = {
  'on-course': 'on course', tangent: 'tangent', 'off-course': 'off course', '': 'unjudged',
};
const SHELLS = ['on-course', 'tangent', 'off-course'] as const;
const SHELL_LABEL: Record<string, string> = {
  'on-course': 'ON COURSE', tangent: 'TANGENT', 'off-course': 'OFF COURSE',
};
const SHELL_TIER: Record<string, number> = { 'on-course': 0, tangent: 1, 'off-course': 2 };
const SHELL_BEARING: Record<string, number> = { 'on-course': 200, tangent: 215, 'off-course': 230 };

// The stage's height is MEASURED, not assumed (#248): full screen makes it the
// window, and the geometry — the fit radius, the plate cut-offs, the vertical
// centre — is all computed off it. A constant here would lay the galaxy out for
// a box it is no longer in.
const STAGE_H_MIN = 420;
const SQ = 0.9;              // the sky is squashed: an orbit is an ellipse, not a circle
const MAG = (f: Future) => f.magnitude ?? 2;   // geometry needs a size; the panel still says "not sized"

// Wheel zoom is continuous between the ends of the stops; the stops stay as
// named presets and the dots light to whichever is nearest.
export const Z_MIN = 0.6, Z_MAX = 7;

export const ZOOM_STOPS = [
  { z: 0.6, name: 'Wide — the whole galaxy, small' },
  { z: 1, name: 'Fit — every orbit and the belt in view' },
  { z: 1.7, name: 'System — in on the focused star' },
  { z: 2.8, name: 'Close — planets and their moons' },
  { z: 4.4, name: 'Surface — one system fills the sky' },
  { z: 7, name: 'Ground — one idea, nothing else' },
];

// ---------------------------------------------------------------- the model

export type GxPlanet = { f: Future; moons: Future[] };
export type GxStar = { f: Future; planets: GxPlanet[] };
export type GxModel = {
  all: Future[];
  stars: GxStar[];
  shells: Future[];
  belt: Future[];
  kindOf: (f: Future) => GxKind;
  parentOf: (f: Future) => Future | null;
  childrenOf: (f: Future) => Future[];
  starOf: (f: Future) => Future | null;   // the system an idea belongs to
};

// Built from EVERY idea, never from a filtered slice: the source filter decides
// which dots are drawn, not which orbits exist, so filtering can't orphan a
// star's planets or make the sky jump between two views of the same data.
export function buildGalaxy(list: Future[]): GxModel {
  const byId = new Map(list.map((f) => [f.id, f]));
  const kids = new Map<number, Future[]>();
  for (const f of list) {
    if (f.parentId == null || !byId.has(f.parentId)) continue;
    const arr = kids.get(f.parentId);
    if (arr) arr.push(f); else kids.set(f.parentId, [f]);
  }
  const childrenOf = (f: Future) => kids.get(f.id) || [];
  // isStar wins over a stray parent — the route clears one when it sets the
  // other, and a row that somehow carries both still has to render as one thing.
  const parentOf = (f: Future) => (f.isStar || f.parentId == null ? null : byId.get(f.parentId) || null);
  const kindOf = (f: Future): GxKind => {
    if (f.isStar) return 'star';
    const p = parentOf(f);
    if (p?.isStar) return 'planet';
    if (p && parentOf(p)?.isStar) return 'moon';
    return f.alignment ? 'shell' : 'belt';
  };
  const starOf = (f: Future): Future | null => {
    const k = kindOf(f);
    if (k === 'star') return f;
    if (k === 'planet') return parentOf(f);
    if (k === 'moon') { const p = parentOf(f); return p ? parentOf(p) : null; }
    return null;
  };

  const stars: GxStar[] = list.filter((f) => f.isStar).map((f) => ({
    f,
    planets: childrenOf(f).map((p) => ({ f: p, moons: childrenOf(p) })),
  }));
  const loose = list.filter((f) => kindOf(f) === 'shell' || kindOf(f) === 'belt');
  return {
    all: list, stars,
    shells: loose.filter((f) => f.alignment),
    belt: loose.filter((f) => !f.alignment),
    kindOf, parentOf, childrenOf, starOf,
  };
}

export const GX_GLYPH: Record<GxKind, string> = {
  star: '★', planet: '●', moon: '○', shell: '◦', belt: '·',
};

// One flat row per idea — what the Board and the cross-view counts read from.
export type GxRow = { f: Future; kind: GxKind; where: string };
export function flattenGalaxy(m: GxModel): GxRow[] {
  return m.all.map((f) => {
    const kind = m.kindOf(f);
    const parent = m.parentOf(f);
    return {
      f, kind,
      where: kind === 'star' ? 'its own orbit'
        : kind === 'shell' ? 'the north star'
        : kind === 'belt' ? 'the drift belt'
        : parent?.title || 'adrift',
    };
  });
}

// ---------------------------------------------------------------- the stage

type Vec = { dx: number; dy: number };
type Rect = { x1: number; x2: number; y1: number; y2: number };
type Dot = {
  f: Future; kind: GxKind; x: number; y: number; size: number; tone: string;
  dashed: boolean; sel: boolean; flip: boolean; z: number; tip: string; op: number;
};
type Disc = {
  f: Future; x: number; y: number; size: number; glyph: number; tone: string; op: number;
  sel: boolean; z: number; plate: boolean; plateGap: number; nameSize: number; meta: string;
  rect: Rect; fits: boolean;
};
type Ellipse = { x: number; y: number; w: number; h: number; tilt?: number; sel?: boolean };
type ShellRing = { key: string; w: number; h: number; tone: string; dashed: boolean };
type SectorLabel = { key: string; x: number; y: number; text: string; tone: string; show: boolean; rect: Rect };

const hits = (a: Rect, b: Rect) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

// A fixed starfield: same seed every render, so the backdrop never twinkles
// when the sky re-lays out around it.
const STARFIELD = (() => {
  const out: { x: string; y: string; size: number; accent: boolean; opacity: number }[] = [];
  let seed = 8731;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 68; i++) {
    const a = next(), b = next();
    out.push({
      x: `${(a * 100).toFixed(2)}%`, y: `${(b * 100).toFixed(2)}%`,
      size: i % 11 === 0 ? 2 : 1, accent: i % 7 === 0,
      opacity: Number((0.1 + ((i * 37) % 30) / 100).toFixed(2)),
    });
  }
  return out;
})();

export function Galaxy({
  model, northOnly, sourceFilter, focus, selId, onSelect, zoom, onZoom, pan, onPan, onFitAll,
}: {
  model: GxModel;
  northOnly: boolean;                     // the North star scope: its shells alone
  // Both filters DIM rather than hide. A sky that removes what it filters
  // stops being a map: you lose the shape you learned, and you cannot see that
  // the thing you are looking for was excluded rather than absent. Dimmed, the
  // galaxy holds still and the answer is legible against everything it is not.
  sourceFilter: '' | 'hook' | 'manual';
  focus: string | null;                   // 'core' | 'belt' | a star id — the system in the light
  selId: number | null;
  // shift = "and add it to the converge tray" — the sky's one modifier, kept
  // from the old field because picking a set across the sky is how converge starts.
  onSelect: (id: number | null, shift?: boolean) => void;
  zoom: number;
  onZoom: (z: number) => void;
  // The hand-pan, added on top of the automatic pan toward the focused system.
  // Zoomed in past Fit the sky is bigger than the stage, and without this the
  // only way to see a neighbour is to select it. Lifted to the tab (#318) so
  // "fit all" can clear it — Galaxy could reset its own state but not the
  // parent's focus, so neither half of a reset could ever be whole.
  pan: Pan;
  onPan: (p: Pan) => void;
  onFitAll: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 900, h: 860 });
  const panRef = useRef(pan);
  panRef.current = pan;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      setStage((cur) => (r.width && r.height
        && (Math.abs(r.width - cur.w) > 2 || Math.abs(r.height - cur.h) > 2)
        ? { w: r.width, h: r.height } : cur));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Wheel = continuous zoom. A native listener with passive:false, so the page
  // never scrolls out from under the sky while you are zooming it.
  //
  // It zooms about the CENTRE, not the cursor. The old field was one CSS
  // scale() and could keep the point under the pointer fixed by adjusting pan
  // in the same frame; the galaxy is re-laid-out at every zoom instead — shells,
  // orbits and node sizes each move on their own curve — so there is no single
  // transform to anchor, and a cursor anchor could only ever be approximate.
  // Centre zoom plus drag is honest and lands you in the same places.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const z0 = zoomRef.current;
      const nz = Math.min(Z_MAX, Math.max(Z_MIN, z0 * Math.exp(-e.deltaY * 0.0016)));
      if (Math.abs(nz - z0) > 0.0005) onZoomRef.current(nz);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Drag anywhere on the ground to pan. A press that never moves still delivers
  // its click to the node underneath, so dragging costs the sky no selections.
  const startPan = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY;
    const p0 = panRef.current;
    const move = (ev: MouseEvent) => onPan({ x: p0.x + ev.clientX - x0, y: p0.y + ev.clientY - y0 });
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const g = useMemo(() => {
    const sel = selId != null ? model.all.find((f) => f.id === selId) || null : null;
    const focusStar = sel ? model.starOf(sel) : null;
    const srcMatch = (f: Future) => !sourceFilter
      || (sourceFilter === 'hook' ? f.source === 'hook' : f.source !== 'hook');
    const sysMatch = (sys: string) => !focus || focus === sys;
    const W = Math.max(360, stage.w);
    const H = Math.max(STAGE_H_MIN, stage.h);
    const n = model.stars.length;
    const CX = W / 2;
    const CY = 0.46 * H;
    // The largest radius that still leaves room for a label at every edge.
    const FIT = Math.max(120, Math.min(CX - 58, (Math.min(CY, H - CY) - 72) / SQ));
    const coreR = Math.max(26, Math.min(FIT * 0.1, 46));
    // Nodes grow with zoom, but far more slowly than the field — otherwise one
    // planet swallows the system you zoomed in to read.
    const nodeK = Math.min(2.2, Math.max(0.72, zoom));
    const dotFor = (m: number) => Math.round((7 + m * 3.2) * nodeK);
    const planetDot = (m: number) => Math.round((7 + m * 2.7) * nodeK);
    const moonDot = (m: number) => Math.round((5 + m * 1.7) * nodeK);

    // ---- the north star's three shells: on course closest, off course furthest
    const maxShellDot = dotFor(Math.max(2, ...model.shells.map(MAG)));
    const shellBase = Math.max(FIT * (northOnly ? 0.3 : 0.13) * zoom, (coreR + 12 + maxShellDot / 2) / SQ);
    const shellGap = northOnly
      ? Math.max(maxShellDot + 14, FIT * 0.14 * zoom)
      : Math.max(maxShellDot * 0.85 + 5, FIT * 0.046 * zoom);
    const tierR = (k: number) => shellBase + k * shellGap;
    const shellOuter = tierR(2) + maxShellDot / 2;

    // ---- a system's reach: its star, its planet orbit, and the moons riding it
    const starRad = (s: GxStar) => ((20 + MAG(s.f) * 5) * nodeK) / 2;
    const widestPlanet = (s: GxStar) => planetDot(Math.max(2, ...s.planets.map((p) => MAG(p.f))));
    const planetOrbitOf = (s: GxStar) => starRad(s) + 20 * Math.min(1.8, nodeK) + widestPlanet(s) / 2;
    const moonOrbitOf = (p: GxPlanet) => planetDot(MAG(p.f)) / 2 + 8 * Math.min(1.7, nodeK);
    const systemRad = (s: GxStar) => planetOrbitOf(s) + widestPlanet(s) / 2
      + (s.planets.some((p) => p.moons.length) ? 10 * Math.min(1.7, nodeK) : 0);
    const SYS = model.stars.reduce((m, s) => Math.max(m, systemRad(s)), 40);

    const beltR = FIT * zoom * (northOnly ? 1 : 1.14);
    const innerPx = shellOuter + SYS + 18;
    const outerPx = Math.max(beltR - SYS - 22, innerPx + 12);
    const orbitR = (i: number) => (n < 2 ? (innerPx + outerPx) / 2 : innerPx + (outerPx - innerPx) * (i / (n - 1)));
    // Bearings derived from the star count, so no two systems share a direction.
    const bearing = (i: number) => -118 + (i * 360) / Math.max(1, n) + (i % 2 ? 7 : -7);

    const starPos: Vec[] = model.stars.map((_, i) => {
      const rad = (bearing(i) * Math.PI) / 180;
      const r = orbitR(i);
      return { dx: Math.cos(rad) * r, dy: Math.sin(rad) * r * SQ };
    });

    // The focused system slides toward the centre as you zoom past Fit, so
    // zooming in reads as "go there" rather than "crop the middle".
    const fIdx = focusStar ? model.stars.findIndex((s) => s.f.id === focusStar.id) : -1;
    const panK = Math.min(1, Math.max(0, (zoom - 1) / 0.6));
    const panX = fIdx >= 0 ? -starPos[fIdx].dx * panK : 0;
    const panY = fIdx >= 0 ? -starPos[fIdx].dy * panK : 0;
    const ax = (dx: number) => CX + dx + panX + pan.x;
    const ay = (dy: number) => CY + dy + panY + pan.y;

    const dots: Dot[] = [];
    const discs: Disc[] = [];
    const orbits: Ellipse[] = [];
    const planetOrbits: Ellipse[] = [];
    const moonOrbits: Ellipse[] = [];
    const shellRings: ShellRing[] = [];
    const sectors: SectorLabel[] = [];
    const labelRects: Rect[] = [];
    const selChips: Rect[] = [];

    const pushDot = (f: Future, kind: GxKind, sys: string, size: number, p: Vec, z: number) => {
      const x = ax(p.dx), y = ay(p.dy);
      const isSel = selId === f.id;
      const v = f.alignment || '';
      if (isSel) {
        const cw = f.title.length * 6.3 + 22;
        const flip = W - x < 230;
        const x1 = flip ? x - size / 2 - 7 - cw : x + size / 2 + 7;
        selChips.push({ x1, x2: x1 + cw, y1: y - 11, y2: y + 11 });
      }
      dots.push({
        f, kind, x: Math.round(x), y: Math.round(y), size, tone: GX_TONE[v],
        dashed: v === 'off-course', sel: isSel, flip: W - x < 230, z: isSel ? 9 : z,
        // A dimmed dot is still a dot: it keeps its place, its size and its
        // click, so filtering narrows what you read, never what is there.
        op: srcMatch(f) && sysMatch(sys) ? 1 : 0.16,
        tip: `${f.title} — ${GX_LABEL[v]}${f.magnitude ? ` · magnitude ${f.magnitude}` : ' · not sized'}`,
      });
    };

    SHELLS.forEach((key) => {
      const group = model.shells.filter((f) => f.alignment === key);
      const r = tierR(SHELL_TIER[key]);
      shellRings.push({
        key, w: Math.round(r * 2), h: Math.round(r * 2 * SQ),
        tone: GX_TONE[key], dashed: key === 'off-course',
      });
      group.forEach((f, j) => {
        // The shells fan across the sky's left-to-bottom sweep rather than
        // closing the ring, so the systems always have somewhere to be.
        const t = group.length < 2 ? 0.5 : j / (group.length - 1);
        const rad = ((-70 + t * 240) * Math.PI) / 180;
        pushDot(f, 'shell', 'core', dotFor(MAG(f)), { dx: Math.cos(rad) * r, dy: Math.sin(rad) * r * SQ }, 3);
      });
      const lrad = (SHELL_BEARING[key] * Math.PI) / 180;
      const lx = ax(Math.cos(lrad) * r), ly = ay(Math.sin(lrad) * r * SQ);
      const text = `${SHELL_LABEL[key]} · ${group.length}`;
      const w = text.length * 6.2 + 14;
      const rect = { x1: lx - w, x2: lx, y1: ly - 8, y2: ly + 8 };
      const fits = rect.x1 > 6 && rect.x2 < W - 6 && rect.y1 > 6 && rect.y2 < H - 36;
      sectors.push({ key, x: Math.round(lx), y: Math.round(ly), text, tone: GX_TONE[key], show: fits, rect });
      if (fits) labelRects.push(rect);
    });

    if (!northOnly) model.stars.forEach((s, i) => {
      const { dx, dy } = starPos[i];
      const isSel = focusStar?.id === s.f.id;
      const v = s.f.alignment || '';
      const r = orbitR(i);
      const tilt = ((i * 47) % 70) - 35;
      const trad = (tilt * Math.PI) / 180;
      const po = planetOrbitOf(s);
      const size = Math.round(starRad(s) * 2 * (isSel ? 1.14 : 1));

      orbits.push({ x: ax(0), y: ay(0), w: Math.round(r * 2), h: Math.round(r * 2 * SQ), sel: isSel });
      planetOrbits.push({
        x: ax(dx), y: ay(dy), w: Math.round(po * 2), h: Math.round(po * 2 * 0.56), tilt, sel: isSel,
      });

      const nx = ax(dx), ny = ay(dy);
      const meta = `${s.planets.length} planet${s.planets.length === 1 ? '' : 's'} · ${GX_LABEL[v]}`;
      // The plate is as wide as its WIDER line — the meta line usually wins.
      const halfW = (Math.max(s.f.title.length * 7.2, meta.length * 6.2) + 20) / 2;
      const plateGap = po * 0.56 + 10;
      const plateTop = ny - size / 2 - plateGap - 34;
      discs.push({
        f: s.f, x: Math.round(nx), y: Math.round(ny), size,
        glyph: Math.round(Math.min(26, size * 0.44)),
        nameSize: Math.round(Math.min(19, 13 * Math.max(1, Math.min(1.5, zoom)))),
        tone: isSel ? 'var(--accent)' : GX_TONE[v], sel: isSel, z: isSel ? 8 : 7,
        op: srcMatch(s.f) && sysMatch(String(s.f.id)) ? 1 : 0.22,
        plate: false, plateGap: Math.round(plateGap), meta,
        rect: { x1: nx - halfW, x2: nx + halfW, y1: plateTop, y2: plateTop + 38 },
        fits: nx - halfW > 6 && nx + halfW < W - 6 && plateTop > 6 && ny < H - 64,
      });

      s.planets.forEach((pl, j) => {
        const k = Math.max(4, s.planets.length);
        const a = ((-150 + (j * 360) / k) * Math.PI) / 180;
        const x0 = Math.cos(a) * po, y0 = Math.sin(a) * po * 0.56;
        const pdx = dx + x0 * Math.cos(trad) - y0 * Math.sin(trad);
        const pdy = dy + x0 * Math.sin(trad) + y0 * Math.cos(trad);
        pushDot(pl.f, 'planet', String(s.f.id), planetDot(MAG(pl.f)), { dx: pdx, dy: pdy }, 6);
        if (!pl.moons.length) return;
        const mo = moonOrbitOf(pl);
        moonOrbits.push({
          x: Math.round(ax(pdx)), y: Math.round(ay(pdy)),
          w: Math.round(mo * 2), h: Math.round(mo * 2 * 0.7),
        });
        pl.moons.forEach((mn, qi) => {
          const ma = ((-40 + (qi * 360) / Math.max(3, pl.moons.length)) * Math.PI) / 180;
          pushDot(mn, 'moon', String(s.f.id), moonDot(MAG(mn)),
            { dx: pdx + Math.cos(ma) * mo, dy: pdy + Math.sin(ma) * mo * 0.7 }, 5);
        });
      });
    });

    // ---- the drift belt: unjudged, at the edge of everything
    model.belt.forEach((f, i) => {
      const deg = -170 + (i * 360) / Math.max(12, model.belt.length);
      const rad = (deg * Math.PI) / 180;
      const rr = beltR * (i % 3 === 1 ? 1 : i % 3 === 2 ? 0.94 : 0.97);
      pushDot(f, 'belt', 'belt', dotFor(MAG(f)),
        { dx: Math.cos(rad) * rr, dy: Math.sin(rad) * rr * SQ }, 2);
    });

    // One nameplate per patch of sky: the focused star first, then the biggest.
    // Losers stay unlabelled rather than overprinting a neighbour.
    const taken = labelRects.slice();
    discs.map((_, i) => i)
      .sort((a, b) => (Number(discs[b].sel) - Number(discs[a].sel))
        || (MAG(discs[b].f) - MAG(discs[a].f)))
      .forEach((i) => {
        const d = discs[i];
        if (!d.fits || taken.some((q) => hits(d.rect, q))) return;
        d.plate = true;
        taken.push(d.rect);
      });

    // Ideas beat decoration: a shell label steps aside for the selected chip or
    // for any dot that would sit on top of it.
    const dotRects = dots.filter((d) => d.op === 1).map((d) => ({
      x1: d.x - d.size / 2, x2: d.x + d.size / 2, y1: d.y - d.size / 2, y2: d.y + d.size / 2,
    }));
    sectors.forEach((l) => {
      if (!l.show) return;
      if (selChips.some((c) => hits(c, l.rect)) || dotRects.some((d) => hits(d, l.rect))) l.show = false;
    });

    return {
      coreX: Math.round(ax(0)), coreY: Math.round(ay(0)), coreSize: Math.round(coreR * 2),
      coreText: Math.round(Math.min(14, 9 * Math.max(1, Math.min(1.6, zoom)))),
      beltW: Math.round(beltR * 2), beltH: Math.round(beltR * 2 * SQ),
      dots, discs, orbits, planetOrbits, moonOrbits, shellRings, sectors,
    };
  }, [model, northOnly, sourceFilter, focus, selId, zoom, stage, pan]);

  const zi = zoomIndex(zoom);
  const px = (v: number) => `${v}px`;
  const ellipse = (e: Ellipse, cls: string, key: string) => (
    <div key={key} className={`pgx-orbit ${cls}${e.sel ? ' on' : ''}`}
      style={{
        left: px(e.x), top: px(e.y), width: px(e.w), height: px(e.h),
        transform: `translate(-50%, -50%)${e.tilt ? ` rotate(${e.tilt}deg)` : ''}`,
      }} />
  );

  return (
    <div className="pgx-stage" ref={stageRef} onMouseDown={startPan}>
      <div className="pgx-glow warm" />
      <div className="pgx-glow cool" />
      {STARFIELD.map((s, i) => (
        <div key={i} className={`pgx-speck${s.accent ? ' accent' : ''}`}
          style={{ left: s.x, top: s.y, width: px(s.size), height: px(s.size), opacity: s.opacity }} />
      ))}

      {g.orbits.map((e, i) => ellipse(e, 'ring', `o${i}`))}
      {g.shellRings.map((r) => (
        <div key={r.key} className={`pgx-orbit shell${r.dashed ? ' dashed' : ''}`}
          style={{
            left: px(g.coreX), top: px(g.coreY), width: px(r.w), height: px(r.h),
            transform: 'translate(-50%, -50%)', borderColor: r.tone,
          }} />
      ))}
      <div className="pgx-orbit belt"
        style={{
          left: px(g.coreX), top: px(g.coreY), width: px(g.beltW), height: px(g.beltH),
          transform: 'translate(-50%, -50%)',
        }} />
      {g.planetOrbits.map((e, i) => ellipse(e, 'planet', `p${i}`))}
      {g.moonOrbits.map((e, i) => ellipse(e, 'moon', `m${i}`))}

      {g.sectors.map((l) => l.show && (
        <div key={l.key} className="pgx-sector" style={{ left: px(l.x), top: px(l.y), color: l.tone }}>
          {l.text}
        </div>
      ))}

      <button className="pgx-core" onClick={() => onSelect(null)}
        title="The north star — every verdict is measured against it"
        style={{ left: px(g.coreX), top: px(g.coreY), width: px(g.coreSize), height: px(g.coreSize) }}>
        <span style={{ fontSize: px(g.coreText) }}>NORTH<br />STAR</span>
      </button>

      {g.dots.map((d) => (
        <button key={d.f.id}
          className={`pgx-node ${d.kind}${d.sel ? ' sel' : ''}${d.dashed ? ' dashed' : ''}${d.flip ? ' flip' : ''}`}
          onClick={(e) => onSelect(d.f.id, e.shiftKey)} title={d.tip}
          style={{ left: px(d.x), top: px(d.y), zIndex: d.z, opacity: d.op, ['--vc' as string]: d.tone } as CSSProperties}>
          <span className="dot" style={{ width: px(d.size), height: px(d.size) }} />
          {d.sel && <span className="cap">{d.f.title}</span>}
        </button>
      ))}

      {g.discs.map((d) => (
        <button key={d.f.id} className={`pgx-disc${d.sel ? ' sel' : ''}`}
          onClick={(e) => onSelect(d.f.id, e.shiftKey)} title={`${d.f.title} — ${d.meta}`}
          style={{
            left: px(d.x), top: px(d.y), width: px(d.size), height: px(d.size), zIndex: d.z,
            opacity: d.op, ['--vc' as string]: d.tone,
          } as CSSProperties}>
          <span className="glyph" style={{ fontSize: px(d.glyph) }}>★</span>
          {d.plate && (
            <span className="plate" style={{ bottom: `calc(100% + ${d.plateGap}px)` }}>
              <span className="name" style={{ fontSize: px(d.nameSize) }}>{d.f.title}</span>
              <span className="meta">{d.meta}</span>
            </span>
          )}
        </button>
      ))}

      {model.all.length === 0 && (
        <div className="pgx-empty">
          No ideas yet — add the first one below and it lands in the drift belt, unjudged.
        </div>
      )}

      <div className="pgx-legend">
        <span className="key">
          <b>★ star</b> = promoted idea · planet = an idea in its orbit ·
          moon = a piece of that idea · size = magnitude
        </span>
        <span className="count">
          {northOnly
            ? `north star · ${model.shells.length} of its own`
            : `drift belt · ${model.belt.length} unjudged`}
        </span>
      </div>

      <div className="pgx-controls">
        <span className="hint">{ZOOM_STOPS[zi].name}</span>
        <div className="pgx-zoom">
          <button className="zbtn" aria-label="Zoom out"
            onClick={() => onZoom(ZOOM_STOPS[Math.max(0, zi - 1)].z)}>−</button>
          <span className="zticks">
            {ZOOM_STOPS.map((s, i) => (
              <button key={s.z} className={`ztick${i <= zi ? ' on' : ''}`}
                title={s.name} aria-label={s.name} onClick={() => onZoom(s.z)} />
            ))}
          </span>
          <button className="zbtn" aria-label="Zoom in"
            onClick={() => onZoom(ZOOM_STOPS[Math.min(ZOOM_STOPS.length - 1, zi + 1)].z)}>+</button>
          <span className="zpct">{Math.round(zoom * 100)}%</span>
        </div>
        <button className="pgx-fit" onClick={onFitAll}
          title="Back to Fit, centred on the north star — clears the drag and the focused system too">Recentre</button>
      </div>
    </div>
  );
}

export function zoomIndex(z: number): number {
  return ZOOM_STOPS.reduce((best, s, i) =>
    (Math.abs(s.z - z) < Math.abs(ZOOM_STOPS[best].z - z) ? i : best), 0);
}

// ---------------------------------------------------------------- the board

// Every idea filed by verdict, unjudged first — the same selection as the sky,
// so "open on the board" and "reveal in the sky" are two doors into one thing.
export function GalaxyBoard({
  rows, selId, onSelect,
}: {
  rows: GxRow[];
  selId: number | null;
  onSelect: (id: number) => void;
}) {
  const columns = [
    { key: '', label: 'UNJUDGED' },
    { key: 'on-course', label: 'ON COURSE' },
    { key: 'tangent', label: 'TANGENT' },
    { key: 'off-course', label: 'OFF COURSE' },
  ];
  return (
    <div className="pgx-board">
      {columns.map((c) => {
        const items = rows
          .filter((r) => (r.f.alignment || '') === c.key)
          .sort((a, b) => MAG(b.f) - MAG(a.f));
        return (
          <div className="pgx-col" key={c.key || 'unjudged'}>
            <div className="pgx-col-head" style={{ borderBottomColor: GX_TONE[c.key] }}>
              <span className="label" style={{ color: GX_TONE[c.key] }}>{c.label}</span>
              <span className="n">{items.length}</span>
            </div>
            {items.slice(0, 12).map((r) => (
              <button key={r.f.id} className={`pgx-card${selId === r.f.id ? ' sel' : ''}`}
                onClick={() => onSelect(r.f.id)}>
                <span className="top">
                  <span className="glyph">{GX_GLYPH[r.kind]}</span>
                  <span className="title">{r.f.title}</span>
                </span>
                <span className="foot">
                  <span className="orbit">{r.where}</span>
                  <span className="mag">{r.f.magnitude ? `mag ${r.f.magnitude}` : 'unsized'}</span>
                </span>
              </button>
            ))}
            {items.length > 12 && <div className="pgx-col-more">+ {items.length - 12} more</div>}
            {items.length === 0 && <div className="pgx-col-more">nothing here</div>}
          </div>
        );
      })}
    </div>
  );
}
