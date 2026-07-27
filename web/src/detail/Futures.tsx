import { useEffect, useMemo, useRef, useState } from 'react';
import type { Future } from '../types';
import type { ClusterSuggestion, ConvergeDraft, JudgeSuggestion } from '../store';
import { Modal } from '../components/Modal';
import { go } from '../lib/route';

export type Alignment = 'on-course' | 'tangent' | 'off-course';
export const ALIGNMENTS: { key: Alignment; label: string; hint: string }[] = [
  { key: 'on-course', label: 'On course', hint: 'Pulls toward the north star — promote when it firms up' },
  { key: 'tangent', label: 'Tangent', hint: 'Interesting but sideways — park it, revisit later' },
  { key: 'off-course', label: 'Off course', hint: 'Pulls away from the north star — usually a dismiss' },
];
const alignLabel = (a: string) => ALIGNMENTS.find((x) => x.key === a)?.label || 'Unjudged';

// The ideas group in curation order: judged on-course first, then the unsorted
// pile, then tangents and off-course at the bottom.
const GROUPS: { key: string; label: string }[] = [
  { key: 'on-course', label: 'On course' },
  { key: '', label: 'Unsorted' },
  { key: 'tangent', label: 'Tangents' },
  { key: 'off-course', label: 'Off course' },
];

// ---- the sky's geometry (from the Stack Planning design, turn 9a) ----------
// A 700×700 field: north star at the centre, one dashed ring per verdict, and
// each theme (area tag) holding a 60°-ish arc. Verdict = ring; theme = bearing.
const SKY = 700;
const C = SKY / 2;
const RING: Record<string, number> = { 'on-course': 132, '': 178, tangent: 224, 'off-course': 296 };
const RING_COLOR: Record<string, string> = {
  'on-course': 'var(--live)', tangent: 'var(--building)', 'off-course': 'var(--paused)', '': 'var(--paused)',
};
const RING_TINT: Record<string, string> = {
  'on-course': 'var(--live-tint)', tangent: 'var(--building-tint)', 'off-course': 'var(--paused-tint)', '': 'var(--paused-tint)',
};
const Z_TICKS = [0.7, 0.85, 1, 1.2, 1.45, 1.7]; // preset dots — wheel zoom is continuous
const Z_MIN = 0.5, Z_MAX = 2.4;
const LOOSE = 'loose'; // theme key for ideas with no area tag
const TL_TICKS = 6;    // scrub points along the sky's history (design 6b/7a)

// Short relative label for the scrub ticks ("3w ago" … "now").
function ago(ms: number): string {
  const d = Math.round(ms / 86400000);
  if (d < 1) return 'today';
  if (d < 7) return `${d}d ago`;
  if (d < 60) return `${Math.round(d / 7)}w ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${(d / 365).toFixed(1)}y ago`;
}

type Theme = { key: string; label: string; a0: number; span: number; items: Future[] };

function buildThemes(list: Future[]): Theme[] {
  const byArea = new Map<string, Future[]>();
  for (const f of list) {
    const k = f.area || LOOSE;
    const arr = byArea.get(k);
    if (arr) arr.push(f); else byArea.set(k, [f]);
  }
  // Alphabetical, loose last — stable bearings as ideas come and go.
  const keys = [...byArea.keys()].sort((a, b) =>
    (a === LOOSE ? 1 : 0) - (b === LOOSE ? 1 : 0) || a.localeCompare(b));
  const step = 360 / Math.max(1, keys.length);
  const span = Math.min(60, step * 0.85);
  return keys.map((k, i) => ({
    key: k, label: k, a0: (196 + i * step) % 360, span, items: byArea.get(k)!,
  }));
}

type SkyNode = {
  f: Future; theme: string; x: number; y: number; d: number; opacity: number;
  border: string; bw: number; bg: string; dashed: boolean; sel: boolean; fresh: boolean;
  wants: boolean; showLabel: boolean; label: string; halfW: number;
  nx: number; ny: number; ca: number; sa: number; rad: number; lx: number; ly: number;
};
type SkyBubble = { key: string; label: string; count: number; x: number; y: number; d: number; opacity: number };

export function Futures({
  northStar, futures, highlightId, onSaveNorthStar, onAdd, onEdit, onAlign, onDelete, onPromote,
  onAskGemini, onCluster, onSetAreas, onConvergeDraft, onConvergeCreate, slug,
}: {
  northStar: string;
  futures: Future[];
  slug?: string;
  highlightId?: string | null;
  onSaveNorthStar: (text: string) => void;
  onAdd: (title: string, note: string) => void;
  onEdit: (id: number, patch: { title: string; note: string; area: string }) => void;
  onAlign: (id: number, alignment: Alignment | '') => void;
  onDelete: (id: number) => void;
  onPromote: (future: Future) => void;
  onAskGemini?: (id: number) => Promise<JudgeSuggestion>;
  onCluster?: () => Promise<ClusterSuggestion[]>;
  onSetAreas: (pairs: { id: number; area: string }[]) => void;
  onConvergeDraft?: (ids: number[], mode: 'tickets' | 'epic') => Promise<ConvergeDraft[]>;
  onConvergeCreate: (drafts: ConvergeDraft[], retire: number[]) => void;
}) {
  // ---- north star strip (collapsible band, always on top) ----
  const [nsOpen, setNsOpen] = useState(true);
  const [editingStar, setEditingStar] = useState(false);
  const [starDraft, setStarDraft] = useState(northStar);
  const saveStar = () => {
    const t = starDraft.trim();
    if (t !== northStar) onSaveNorthStar(t);
    setEditingStar(false);
  };

  // ---- view + filters ----
  const [view, setView] = useState<'sky' | 'list'>('sky');
  const [sourceFilter, setSourceFilter] = useState<'' | 'hook' | 'manual'>('');
  const mixedSources = futures.some((f) => f.source === 'hook') && futures.some((f) => f.source !== 'hook');
  const bySource = futures
    .filter((f) => !sourceFilter || (sourceFilter === 'hook' ? f.source === 'hook' : f.source !== 'hook'));

  // ---- sky state ----
  const [z, setZ] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Buttons/ticks glide (CSS transition); wheel + drag track the pointer raw.
  const [glide, setGlide] = useState(true);
  const [allIdeas, setAllIdeas] = useState(false);
  const [openTheme, setOpenTheme] = useState<string | null>(null);
  const [selId, setSelId] = useState<number | null>(null);
  const panRef = useRef<{ x0: number; y0: number; px: number; py: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const zRef = useRef(z);
  zRef.current = z;
  const panLive = useRef(pan);
  panLive.current = pan;

  const themes = useMemo(() => buildThemes(bySource), [bySource]);
  const selected = selId != null ? bySource.find((f) => f.id === selId) || null : null;

  // #259 — the sky and the list are two views of ONE selection, so switching
  // between them has to CARRY the selection rather than merely keep the id.
  // Landing on a view where the selected idea is filtered out, folded away or
  // below the fold would technically preserve the selection while losing it in
  // every sense that matters, so each view is made to actually show it.
  useEffect(() => {
    if (!selected) return;
    if (view === 'list') {
      // The list groups by verdict and filters by area — clear a filter that
      // would hide the selection, then bring the row into view.
      if (areaFilter && areaFilter !== (selected.area || '')) setAreaFilter('');
      const t = setTimeout(() => {
        document.querySelector(`.future-row[data-hl="${selected.id}"]`)
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 60);
      return () => clearTimeout(t);
    }
    // The sky collapses unopened themes into a bubble, so open the selected
    // idea's own theme — otherwise the star it points at isn't drawn.
    const theme = selected.area || LOOSE;
    if (!allIdeas && openTheme !== theme) setOpenTheme(theme);
    return undefined;
  }, [view, selected?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  // A search deep-link picks the idea out of the sky: select it and open its theme.
  const hlDone = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightId || hlDone.current === highlightId) return;
    const f = futures.find((x) => String(x.id) === highlightId);
    if (!f) return;
    hlDone.current = highlightId;
    setSelId(f.id);
    setOpenTheme(f.area || LOOSE);
  }, [highlightId, futures]);

  const expandAll = allIdeas || z >= 1.2;
  const labelAll = z >= 1.2;

  // ---- the time scrub (design 6b/7a): the same sky over time ----
  // Ticks are evenly spaced across the sky's real history (idea created_at);
  // scrubbing back hides ideas that hadn't arrived yet and glows the ones
  // born since the previous tick. View-only and session-local — the queue,
  // list and composer keep working on today's data.
  const [tlStep, setTlStep] = useState<number | null>(null); // null = now
  const timeline = useMemo(() => {
    const times = bySource.map((f) => Date.parse(f.createdAt)).filter(Number.isFinite);
    if (times.length < 4) return null; // not enough history to be worth a scrub
    const first = Math.min(...times);
    const now = Date.now();
    if (now - first < 2 * 86400000) return null; // a days-old sky has no past to visit
    const ticks = Array.from({ length: TL_TICKS }, (_, i) => {
      const at = first + ((now - first) * i) / (TL_TICKS - 1);
      return { at, label: i === TL_TICKS - 1 ? 'now' : ago(now - at) };
    });
    return { ticks, spanLabel: ago(now - first) };
  }, [bySource]);
  // Any change to the population snaps back to now, so a fresh idea is never
  // hidden behind an old cutoff.
  useEffect(() => { setTlStep(null); }, [futures.length]);
  const scrub = timeline && tlStep != null && tlStep < timeline.ticks.length - 1
    ? {
        cutoff: timeline.ticks[tlStep].at,
        prev: tlStep > 0 ? timeline.ticks[tlStep - 1].at : Infinity, // the origin tick glows nothing
        label: timeline.ticks[tlStep].label,
      }
    : null;
  const arrivedCount = scrub ? bySource.filter((f) => Date.parse(f.createdAt) <= scrub.cutoff).length : 0;
  const freshCount = scrub
    ? bySource.filter((f) => { const t = Date.parse(f.createdAt); return t <= scrub.cutoff && t > scrub.prev; }).length
    : 0;

  // Nodes, bubbles and the caption collision pass (ported from the design).
  const { nodes, bubbles } = useMemo(() => {
    const nodes: SkyNode[] = [];
    const bubbles: SkyBubble[] = [];
    for (const t of themes) {
      // A scrubbed sky only holds the ideas that had arrived by the cutoff.
      const items = scrub ? t.items.filter((f) => Date.parse(f.createdAt) <= scrub.cutoff) : t.items;
      if (!items.length) continue;
      const mid = ((t.a0 + t.span / 2) * Math.PI) / 180;
      const expanded = expandAll || openTheme === t.key;
      if (!expanded) {
        const r = 178, rad = 26 + Math.min(16, items.length * 1.8);
        bubbles.push({
          key: t.key, label: t.label, count: items.length,
          x: C + Math.cos(mid) * r - rad, y: C + Math.sin(mid) * r - rad, d: rad * 2,
          opacity: openTheme ? 0.3 : 1,
        });
        continue;
      }
      const dim = openTheme && openTheme !== t.key ? 0.28 : 1;
      items.forEach((f, i) => {
        const a = ((t.a0 + (t.span * (i + 0.5)) / items.length) * Math.PI) / 180;
        const v = f.alignment || '';
        const r = RING[v], rad = 10;
        const nx = C + Math.cos(a) * r, ny = C + Math.sin(a) * r;
        const on = selId === f.id;
        const fresh = !!scrub && Date.parse(f.createdAt) > scrub.prev;
        const disp = f.title.length > 20 ? f.title.slice(0, 19).trim() + '…' : f.title;
        nodes.push({
          f, theme: t.label, x: nx - rad, y: ny - rad, d: rad * 2, opacity: dim,
          border: fresh && !on ? 'var(--accent-soft)' : v ? RING_COLOR[v] : 'var(--keyline)',
          bw: on ? 3 : 2, dashed: !v && !fresh,
          bg: on ? RING_TINT[v] : 'var(--surface)', sel: on, fresh,
          wants: labelAll || on, showLabel: false, label: disp, halfW: disp.length * 3.2 + 6,
          nx, ny, ca: Math.cos(a), sa: Math.sin(a), rad, lx: 0, ly: 0,
        });
      });
    }
    // Collision pass: push each caption outward until its box clears every placed box.
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    const hit = (a: typeof boxes[0], b: typeof boxes[0]) =>
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    nodes.forEach((n) => { if (n.wants) boxes.push({ x: n.x - 3, y: n.y - 3, w: n.d + 6, h: n.d + 6 }); });
    nodes.filter((n) => n.wants).sort((a, b) => (b.sel ? 1 : 0) - (a.sel ? 1 : 0)).forEach((n) => {
      for (let k = 0; k <= 132; k += 22) {
        const lx = Math.min(Math.max(n.ca * (n.rad + 12 + k + n.halfW), n.halfW + 10 - n.nx), SKY - 10 - n.halfW - n.nx);
        const ly = Math.min(Math.max(n.sa * (n.rad + 14 + k), 16 - n.ny), SKY - 16 - n.ny);
        const box = { x: n.nx + lx - n.halfW - 5, y: n.ny + ly - 9, w: n.halfW * 2 + 10, h: 18 };
        if (!boxes.some((b) => hit(box, b))) {
          n.showLabel = true; n.lx = Math.round(lx); n.ly = Math.round(ly);
          boxes.push(box);
          return;
        }
      }
    });
    return { nodes, bubbles };
  }, [themes, expandAll, labelAll, openTheme, selId, scrub]);

  const startPan = (e: React.MouseEvent) => {
    setGlide(false);
    panRef.current = { x0: e.clientX, y0: e.clientY, px: pan.x, py: pan.y };
    const move = (ev: MouseEvent) => {
      const p = panRef.current;
      if (p) setPan({ x: p.px + ev.clientX - p.x0, y: p.py + ev.clientY - p.y0 });
    };
    const up = () => {
      panRef.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const zoomBy = (dir: 1 | -1) => {
    setGlide(true);
    setZ((cur) => Math.min(Z_MAX, Math.max(Z_MIN, dir > 0 ? cur * 1.18 : cur / 1.18)));
  };
  // Wheel = continuous zoom toward the cursor: the point under the pointer
  // stays put while the sky scales around it. Native listener (passive:false)
  // so the page never scrolls behind the sky.
  useEffect(() => {
    if (view !== 'sky') return;
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const z0 = zRef.current;
      const nz = Math.min(Z_MAX, Math.max(Z_MIN, z0 * Math.exp(-e.deltaY * 0.0016)));
      if (nz === z0) return;
      const r = el.getBoundingClientRect();
      const p = panLive.current;
      // Cursor position in field space (origin = the field's centre).
      const fx = (e.clientX - (r.left + r.width / 2) - p.x) / z0;
      const fy = (e.clientY - (r.top + r.height / 2) - p.y) / z0;
      setGlide(false);
      setZ(nz);
      setPan({ x: p.x + fx * (z0 - nz), y: p.y + fy * (z0 - nz) });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [view]);
  const offCentre = pan.x !== 0 || pan.y !== 0 || Math.abs(z - 1) > 0.01;
  const lodNote = z < 0.85 ? 'Zoomed out — themes only.'
    : z < 1.2 ? 'Theme bodies. Open one, or keep zooming.'
    : 'Every idea, every name — drag the sky to move around it.';

  // ---- the judge queue (rail): unsorted ideas, one verdict at a time ----
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [judgedCount, setJudgedCount] = useState(0);
  const [hint, setHint] = useState<{ id: number; s: JudgeSuggestion } | null>(null);
  const [hintBusy, setHintBusy] = useState(false);
  const [hintErr, setHintErr] = useState('');
  const unjudged = bySource.filter((f) => !f.alignment);
  const queue = unjudged.filter((f) => !skipped.has(f.id));
  const cur = queue[0] || null;
  const judge = (f: Future, v: Alignment) => {
    onAlign(f.id, v);
    setJudgedCount((n) => n + 1);
    setHint(null);
    setHintErr('');
  };
  const askPolaris = async (f: Future) => {
    if (!onAskGemini || hintBusy) return;
    setHintBusy(true);
    setHintErr('');
    try {
      setHint({ id: f.id, s: await onAskGemini(f.id) });
    } catch (e) {
      setHintErr((e as Error)?.message || 'Gemini call failed.');
    } finally {
      setHintBusy(false);
    }
  };
  const skipCur = () => {
    if (!cur) return;
    setSkipped(new Set([...skipped, cur.id]));
    setHint(null);
    setHintErr('');
  };
  const resetSkips = () => setSkipped(new Set());

  // ---- Polaris's computed observation — honest arithmetic, no API ----
  const observation = useMemo(() => {
    for (const t of themes) {
      if (t.key !== LOOSE && t.items.length >= 3 && t.items.every((f) => f.alignment === 'off-course')) {
        return `${t.label} is ${t.items.length} ideas and every one sits on the outer ring. That's a whole theme pulling away from the star — worth deciding once, out loud, rather than ${t.items.length} times in the queue.`;
      }
    }
    for (const t of themes) {
      if (t.key !== LOOSE && t.items.length >= 3 && t.items.every((f) => f.alignment === 'on-course')) {
        return `${t.label} is pulling hard toward the star — all ${t.items.length} on course. The ripest of them belongs on the roadmap.`;
      }
    }
    if (unjudged.length >= 5) {
      return `${unjudged.length} ideas still carry no verdict — one pass through the queue and the sky sorts itself.`;
    }
    const biggest = [...themes].sort((a, b) => b.items.length - a.items.length)[0];
    if (biggest && biggest.items.length >= 4) {
      const on = biggest.items.filter((f) => f.alignment === 'on-course').length;
      const off = biggest.items.filter((f) => f.alignment === 'off-course').length;
      return `${biggest.label} is the biggest constellation at ${biggest.items.length} ideas — ${on} on course, ${off} drifting.`;
    }
    return '';
  }, [themes, unjudged.length]);

  // ---- judge queue pop-out + Gemini theme clustering ----
  const [queueOut, setQueueOut] = useState(false);
  const [clusterBusy, setClusterBusy] = useState(false);
  const [clusterErr, setClusterErr] = useState('');
  const [clusterSugs, setClusterSugs] = useState<ClusterSuggestion[] | null>(null);
  const [clusterPicks, setClusterPicks] = useState<Set<number>>(new Set());
  const runCluster = async () => {
    if (!onCluster || clusterBusy) return;
    setClusterBusy(true);
    setClusterErr('');
    try {
      const items = await onCluster();
      if (!items.length) {
        setClusterErr('Gemini had no theme suggestions — the funnel may already be sorted.');
      } else {
        setClusterSugs(items);
        setClusterPicks(new Set(items.map((s) => s.id)));
        // #254 — a fresh run starts from Gemini's grouping, not the last
        // session's hand-edits.
        setClusterExtraThemes([]);
        setClusterRename(null);
        setClusterAdding(false);
      }
    } catch (e) {
      setClusterErr((e as Error)?.message || 'Gemini call failed.');
    } finally {
      setClusterBusy(false);
    }
  };
  const applyCluster = () => {
    if (!clusterSugs) return;
    const pairs = clusterSugs
      .filter((s) => clusterPicks.has(s.id))
      .map((s) => ({ id: s.id, area: s.area }));
    if (pairs.length) onSetAreas(pairs);
    setClusterSugs(null);
  };

  // #254 — the suggestion list is EDITABLE before it is applied: rename a
  // theme, move a single idea between themes, or coin a theme Gemini never
  // proposed. All of it is local state over the draft — the only write is
  // still applyCluster's one onSetAreas call, so an edit costs nothing and
  // Cancel really does mean nothing happened.
  //
  // Themes come from the suggestions themselves plus any the human has coined
  // (kept separately so a brand-new, still-empty theme doesn't vanish from the
  // list the moment it's created).
  const [clusterExtraThemes, setClusterExtraThemes] = useState<string[]>([]);
  const [clusterRename, setClusterRename] = useState<string | null>(null);
  const [clusterRenameDraft, setClusterRenameDraft] = useState('');
  const [clusterAdding, setClusterAdding] = useState(false);
  const [clusterNewDraft, setClusterNewDraft] = useState('');
  const clusterThemes = [...new Set([
    ...(clusterSugs ?? []).map((s) => s.area),
    ...clusterExtraThemes,
  ])].sort();
  const normTheme = (v: string) => v.trim().toLowerCase().slice(0, 40);

  const moveClusterItem = (id: number, area: string) => {
    setClusterSugs((sugs) => sugs && sugs.map((s) => (s.id === id ? { ...s, area } : s)));
    // Moving an idea is a decision about it, so it ticks itself back on — a
    // move you then had to remember to re-tick would be a trap.
    setClusterPicks((p) => new Set(p).add(id));
  };
  const commitClusterRename = (from: string) => {
    const to = normTheme(clusterRenameDraft);
    setClusterRename(null);
    setClusterRenameDraft('');
    if (!to || to === from) return;
    setClusterSugs((sugs) => sugs && sugs.map((s) => (s.area === from ? { ...s, area: to } : s)));
    setClusterExtraThemes((t) => [...new Set(t.map((x) => (x === from ? to : x)))]);
  };
  const commitClusterNew = () => {
    const a = normTheme(clusterNewDraft);
    setClusterAdding(false);
    setClusterNewDraft('');
    if (a && !clusterThemes.includes(a)) setClusterExtraThemes((t) => [...t, a]);
  };

  // ---- the converge tray: pick ideas across the sky, converge into tickets ----
  const [tray, setTray] = useState<Set<number>>(new Set());
  const [convergeOpen, setConvergeOpen] = useState(false);
  const [convergeMode, setConvergeMode] = useState<'tickets' | 'epic'>('tickets');
  const [convergeDrafts, setConvergeDrafts] = useState<ConvergeDraft[]>([]);
  const [convergeBusy, setConvergeBusy] = useState(false);
  const [convergeErr, setConvergeErr] = useState('');
  const [retire, setRetire] = useState(true);
  const trayIdeas = bySource.filter((f) => tray.has(f.id));
  const toggleTray = (id: number) =>
    setTray((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // The keyless drafts: a direct mapping of the picked ideas — Gemini is the
  // enrichment on top, never the gate.
  const directDrafts = (mode: 'tickets' | 'epic'): ConvergeDraft[] => {
    if (!trayIdeas.length) return [];
    if (mode === 'epic') {
      return [{
        title: trayIdeas[0].title,
        note: trayIdeas.map((f) => `- ${f.title}${f.note ? ` — ${f.note}` : ''}`).join('\n'),
        bucket: 'should',
        area: trayIdeas.find((f) => f.area)?.area || '',
        plan: trayIdeas.map((f) => f.title),
        sources: trayIdeas.map((f) => f.id),
      }];
    }
    return trayIdeas.map((f) => ({
      title: f.title, note: f.note, bucket: 'should' as const, area: f.area, plan: [], sources: [f.id],
    }));
  };
  const openConverge = () => {
    setConvergeMode('tickets');
    setConvergeDrafts(directDrafts('tickets'));
    setConvergeErr('');
    setRetire(true);
    setConvergeOpen(true);
  };
  const switchConvergeMode = (mode: 'tickets' | 'epic') => {
    setConvergeMode(mode);
    setConvergeDrafts(directDrafts(mode));
    setConvergeErr('');
  };
  const draftWithGemini = async () => {
    if (!onConvergeDraft || convergeBusy) return;
    setConvergeBusy(true);
    setConvergeErr('');
    try {
      setConvergeDrafts(await onConvergeDraft(trayIdeas.map((f) => f.id), convergeMode));
    } catch (e) {
      setConvergeErr((e as Error)?.message || 'Gemini call failed.');
    } finally {
      setConvergeBusy(false);
    }
  };
  const editDraft = (i: number, patch: Partial<ConvergeDraft>) =>
    setConvergeDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const createConverged = () => {
    const drafts = convergeDrafts.filter((d) => d.title.trim());
    if (!drafts.length) return;
    // Retire only ideas that actually fed a created ticket.
    const used = new Set(drafts.flatMap((d) => d.sources));
    onConvergeCreate(drafts, retire ? trayIdeas.map((f) => f.id).filter((id) => used.has(id)) : []);
    setConvergeOpen(false);
    setTray(new Set());
  };
  const convergeInStudio = () => {
    if (!slug) return;
    try {
      sessionStorage.setItem('stack.polaris.thought',
        `Let's converge these ideas into concrete roadmap tickets (design first, then create via the API after my yes): ` +
        trayIdeas.map((f) => `"${f.title}"${f.note ? ` (${f.note.slice(0, 120)})` : ''}`).join('; '));
    } catch { /* private mode — the handoff just won't appear */ }
    go.polaris(slug);
  };

  // ---- composers ----
  const [draft, setDraft] = useState('');
  const add = () => {
    const lines = draft.split('\n');
    const title = (lines[0] || '').trim();
    if (!title) return;
    onAdd(title, lines.slice(1).join('\n').trim());
    setDraft('');
  };
  const [polDraft, setPolDraft] = useState('');
  const thinkOutLoud = () => {
    if (!slug) return;
    const t = polDraft.trim();
    if (t) {
      try { sessionStorage.setItem('stack.polaris.thought', t); } catch { /* private mode — the handoff just won't appear */ }
    }
    go.polaris(slug);
  };

  // ---- list view (the pre-sky layout, kept as a secondary view) ----
  const [areaFilter, setAreaFilter] = useState('');
  const areas = [...new Set(futures.map((f) => f.area).filter(Boolean))].sort();
  const visible = bySource.filter((f) => !areaFilter || f.area === areaFilter);
  const judged = futures.some((f) => f.alignment);
  const listGroups = GROUPS
    .map((g) => ({ ...g, items: visible.filter((f) => f.alignment === g.key) }))
    .filter((g) => g.items.length > 0);

  return (
    <div>
      {/* north star — the collapsible band the whole sky orbits */}
      <div className="pns">
        {nsOpen ? (
          <div className="pns-open">
            <div className="pns-head">
              <span className="pns-label">NORTH STAR</span>
              <div className="pns-rule" />
              {!editingStar && (
                <button className="pns-ctl" onClick={() => { setStarDraft(northStar); setEditingStar(true); }}>
                  {northStar ? 'edit' : 'set it'}
                </button>
              )}
              <button className="pns-ctl" onClick={() => { setEditingStar(false); setNsOpen(false); }}>collapse ▲</button>
            </div>
            {editingStar ? (
              <div className="northstar-editor">
                <textarea value={starDraft} autoFocus rows={3}
                  placeholder="One paragraph: what is this project becoming?"
                  onChange={(e) => setStarDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveStar(); }
                    else if (e.key === 'Escape') { e.preventDefault(); setEditingStar(false); }
                  }} />
                <div className="row">
                  <span className="hint">⏎ to save · esc to cancel</span>
                  <span style={{ display: 'flex', gap: 8 }}>
                    <button className="btn-cancel sm" onClick={() => setEditingStar(false)}>Cancel</button>
                    <button className="btn-submit sm" onClick={saveStar}>Save</button>
                  </span>
                </div>
              </div>
            ) : northStar ? (
              <div className="pns-text">{northStar}</div>
            ) : (
              <div className="pns-empty">
                Not set. One paragraph on what this project is becoming — it's injected into every
                session, so every agent pulls in the same direction.
              </div>
            )}
          </div>
        ) : (
          <button className="pns-closed" onClick={() => setNsOpen(true)}>
            <span className="pns-label">NORTH STAR</span>
            <span className="pns-summary">{northStar || 'Not set.'}</span>
            <span className="pns-chev">expand ▼</span>
          </button>
        )}
      </div>

      {/* control row: total · source · sky/list · themes/all */}
      <div className="psky-top">
        <span className="psky-total">{bySource.length} ideas</span>
        <div style={{ flex: 1 }} />
        {mixedSources && (
          <div className="seg-control sm" role="tablist" aria-label="Idea sources">
            <button className={`seg-opt ${sourceFilter === '' ? 'on' : ''}`} onClick={() => setSourceFilter('')}>All</button>
            <button className={`seg-opt ${sourceFilter === 'hook' ? 'on' : ''}`} onClick={() => setSourceFilter('hook')}
              title="Ideas auto-extracted from pushes and reviews">Generated</button>
            <button className={`seg-opt ${sourceFilter === 'manual' ? 'on' : ''}`} onClick={() => setSourceFilter('manual')}
              title="Ideas you typed (or agreed with Polaris)">Manual</button>
          </div>
        )}
        {view === 'sky' && onCluster && bySource.length > 0 && (
          <button className="psky-all" onClick={runCluster} disabled={clusterBusy}
            title="Gemini groups the funnel into themes — you review before anything is written">
            {clusterBusy ? '✧ clustering…' : '✧ Cluster'}
          </button>
        )}
        {view === 'sky' && (
          <button className={`psky-all ${allIdeas ? 'on' : ''}`}
            onClick={() => { setAllIdeas((v) => !v); setOpenTheme(null); }}>
            {allIdeas ? 'Themes' : 'All ideas'}
          </button>
        )}
        <div className="seg-control sm" role="tablist" aria-label="Ideas view">
          <button className={`seg-opt ${view === 'sky' ? 'on' : ''}`} onClick={() => setView('sky')}>Sky</button>
          <button className={`seg-opt ${view === 'list' ? 'on' : ''}`} onClick={() => setView('list')}>List</button>
        </div>
      </div>

      {clusterErr && <div className="psky-cluster-err">✧ {clusterErr}</div>}

      {view === 'list' ? (
        <>
          {areas.length > 0 && (
            <div className="chips" style={{ marginBottom: 10 }}>
              <button className={`chip-sm ${areaFilter === '' ? 'on' : ''}`} onClick={() => setAreaFilter('')}>
                All {futures.length}
              </button>
              {areas.map((a) => (
                <button key={a} className={`chip-sm ${areaFilter === a ? 'on' : ''}`}
                  onClick={() => setAreaFilter(areaFilter === a ? '' : a)}>
                  {a} {futures.filter((f) => f.area === a).length}
                </button>
              ))}
            </div>
          )}
          <div className="composer">
            <textarea
              value={draft}
              placeholder={'Could this become… ?\nFirst line is the idea — add lines below for the why.'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); }
                else if (e.key === 'Escape') { e.preventDefault(); setDraft(''); }
              }}
            />
            <div className="row">
              <span className="hint">⏎ to add · ⇧⏎ for a "why" line</span>
              <button className="add" onClick={add}>Add idea</button>
            </div>
          </div>
          {futures.length ? (
            listGroups.map((g) => (
              <div className="futures-group" key={g.key || 'unsorted'}>
                {judged && <div className={`futures-group-head ${g.key || 'unsorted'}`}>{g.label} <span className="n">{g.items.length}</span></div>}
                <div className="futures-list">
                  {g.items.map((f) => (
                    <IdeaRow key={f.id} future={f} highlighted={highlightId === String(f.id)}
                      selected={selId === f.id}
                      onSelect={() => setSelId(selId === f.id ? null : f.id)}
                      onEdit={onEdit} onAlign={onAlign} onDelete={onDelete} onPromote={onPromote}
                      onAskGemini={onAskGemini} />
                  ))}
                </div>
              </div>
            ))
          ) : (
            <div className="empty-state">
              <div className="big">No ideas yet</div>
              <div>Futures land here from you or from checkpoints — the loose "what ifs" worth keeping.</div>
            </div>
          )}
        </>
      ) : (
        <div className="psky">
          {/* ---- the sky ---- */}
          <div className="psky-main">
            <div className="psky-chips">
              {themes.map((t) => (
                <button key={t.key} className={`psky-chip ${openTheme === t.key ? 'on' : ''}`}
                  onClick={() => { setOpenTheme(openTheme === t.key ? null : t.key); setAllIdeas(false); }}>
                  <span className="name">{t.label}</span>
                  <span className="n">{t.items.length}</span>
                </button>
              ))}
              <div style={{ flex: 1 }} />
              <span className="psky-lod">{lodNote}</span>
              <div className="psky-zoom">
                <button className="zbtn" onClick={() => zoomBy(-1)} aria-label="Zoom out">−</button>
                <span className="zticks">
                  {Z_TICKS.map((v) => (
                    <button key={v} className={`ztick ${v <= z + 0.001 ? 'on' : ''}`}
                      onClick={() => { setGlide(true); setZ(v); }}
                      aria-label={`Zoom ${Math.round(v * 100)}%`} />
                  ))}
                </span>
                <button className="zbtn" onClick={() => zoomBy(1)} aria-label="Zoom in">+</button>
                <span className="zpct">{Math.round(z * 100)}%</span>
              </div>
              {offCentre && (
                <button className="psky-recentre"
                  onClick={() => { setGlide(true); setPan({ x: 0, y: 0 }); setZ(1); }}>Recentre</button>
              )}
            </div>

            <div className="psky-viewport" ref={viewportRef}>
              <div className="psky-field" onMouseDown={startPan}
                style={{
                  transform: `translate(${pan.x}px,${pan.y}px) scale(${z})`,
                  transition: glide ? undefined : 'none',
                }}>
                {(['on-course', 'tangent', 'off-course'] as const).map((v) => (
                  <div key={v}>
                    <div className="psky-ring" style={{ left: C - RING[v], top: C - RING[v], width: RING[v] * 2, height: RING[v] * 2 }} />
                    <div className="psky-ring-name" style={{ left: C - RING[v], top: C + RING[v] + 8, width: RING[v] * 2, color: RING_COLOR[v] }}>
                      {alignLabel(v).toLowerCase()}
                    </div>
                  </div>
                ))}
                <div className="psky-star" style={{ left: C - 46, top: C - 46 }}>
                  <span>NORTH<br />STAR</span>
                </div>
                {bubbles.map((b) => (
                  <button key={b.key} className="psky-bubble"
                    style={{ left: b.x, top: b.y, width: b.d, height: b.d, opacity: b.opacity }}
                    onClick={() => setOpenTheme(b.key)}>
                    <span className="count">{b.count}</span>
                    <span className="name">{b.label}</span>
                  </button>
                ))}
                {nodes.map((n) => (
                  <button key={n.f.id} className={`psky-node ${tray.has(n.f.id) ? 'tray' : ''} ${n.fresh ? 'fresh' : ''}`}
                    style={{
                      left: n.x, top: n.y, width: n.d, height: n.d, opacity: n.opacity,
                      background: n.bg, borderWidth: n.bw, borderColor: n.border,
                      borderStyle: n.dashed ? 'dashed' : 'solid',
                    }}
                    onClick={(e) => { if (e.shiftKey) toggleTray(n.f.id); else setSelId(n.f.id); }}>
                    {n.showLabel && (
                      <span className={`psky-caption ${n.sel ? 'sel' : ''}`}
                        style={{ transform: `translate(${n.lx}px,${n.ly}px) translate(-50%,-50%)` }}>
                        {n.label}
                      </span>
                    )}
                  </button>
                ))}
                {bySource.length === 0 && (
                  <div className="psky-empty">No ideas yet — add the first one below and it takes its place in the sky.</div>
                )}
              </div>
            </div>

            {/* The growth scrub (design 6b/7a): the same sky along its own history. */}
            {timeline && (
              <div className="psky-scrub">
                <span className="edge">{timeline.spanLabel}</span>
                <div className="hairline">
                  <div className="hair" />
                  {timeline.ticks.map((t, i) => {
                    const curIdx = tlStep ?? timeline.ticks.length - 1;
                    return (
                      <button key={i}
                        className={`ptick ${i === curIdx ? 'cur' : i < curIdx ? 'past' : ''}`}
                        style={{ left: `${(i / (timeline.ticks.length - 1)) * 100}%` }}
                        onClick={() => setTlStep(i === timeline.ticks.length - 1 ? null : i)}
                        title={t.label} aria-label={`The sky as of ${t.label}`} />
                    );
                  })}
                </div>
                <button className={`nowlbl ${scrub ? 'then' : ''}`} onClick={() => setTlStep(null)}
                  title={scrub ? 'Back to now' : 'The sky as it stands'}>
                  {scrub ? scrub.label : 'now'}
                </button>
              </div>
            )}
            {scrub && (
              <div className="psky-scrub-caption">
                The sky as it stood {scrub.label} — {arrivedCount} of {bySource.length} idea{bySource.length === 1 ? '' : 's'} had
                arrived{freshCount > 0 ? `; the ${freshCount} newest glow terracotta` : ''}.
                <button onClick={() => setTlStep(null)}>▸ Back to now</button>
              </div>
            )}

            {trayIdeas.length > 0 && (
              <div className="psky-tray">
                <span className="label">CONVERGE</span>
                {trayIdeas.map((f) => (
                  <span className="psky-tray-chip" key={f.id}>
                    {f.title.length > 26 ? f.title.slice(0, 25).trim() + '…' : f.title}
                    <button onClick={() => toggleTray(f.id)} aria-label="Remove from the tray">×</button>
                  </span>
                ))}
                <span className="hint">shift-click stars to add more</span>
                <div style={{ flex: 1 }} />
                <button className="psky-tray-clear" onClick={() => setTray(new Set())}>clear</button>
                <button className="psky-tray-go" onClick={openConverge}>Converge → tickets</button>
              </div>
            )}
            <div className="psky-composer">
              <span className="plus">+</span>
              <input value={draft}
                placeholder="Add an idea — it lands unjudged, and the queue files it onto a ring"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); add(); }
                  else if (e.key === 'Escape') { e.preventDefault(); setDraft(''); }
                }} />
            </div>
          </div>

          {/* ---- the rail: Polaris ---- */}
          <div className="psky-rail">
            <div className="psky-rail-head">
              <span className="name">Polaris</span>
              <span className="sub">plans only</span>
            </div>

            <SelectedPanel selected={selected} themeLabel={selected ? (selected.area || LOOSE) : ''}
              inTray={selected ? tray.has(selected.id) : false}
              onToggleTray={selected ? () => toggleTray(selected.id) : undefined}
              onPromote={onPromote} onEdit={onEdit} onAlign={onAlign} onDelete={onDelete}
              onBuildOn={slug ? () => {
                if (selected) {
                  try {
                    sessionStorage.setItem('stack.polaris.thought',
                      `Let's build on this idea: "${selected.title}"${selected.note ? ` — ${selected.note}` : ''}. Pressure-test it against the north star and design the concrete work.`);
                  } catch { /* private mode — the handoff just won't appear */ }
                  go.polaris(slug);
                }
              } : undefined} />

            <div className="psky-rail-scroll">
              <QueueCard cur={cur} unjudgedCount={unjudged.length} judgedCount={judgedCount}
                hint={hint} hintBusy={hintBusy} hintErr={hintErr} canAsk={!!onAskGemini}
                onJudge={judge} onAsk={askPolaris} onSkip={skipCur} onReset={resetSkips}
                onPopOut={() => setQueueOut(true)} />

              {observation && (
                <div className="psky-note">
                  <span className="label">✦ POLARIS</span>
                  <div className="text">{observation}</div>
                </div>
              )}
            </div>

            {slug && (
              <div className="psky-think">
                <div className="box">
                  <span className="mark">›</span>
                  <input value={polDraft} placeholder="Think out loud with Polaris…"
                    onChange={(e) => setPolDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); thinkOutLoud(); } }} />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* judge queue, popped out — same state, roomier controls */}
      {queueOut && (
        <Modal onClose={() => setQueueOut(false)}>
          <div className="psky-pop">
            <div className="psky-pop-head">
              <span className="name">Judge queue</span>
              <button className="psky-pop-close" onClick={() => setQueueOut(false)} aria-label="Close">×</button>
            </div>
            <QueueCard big cur={cur} unjudgedCount={unjudged.length} judgedCount={judgedCount}
              hint={hint} hintBusy={hintBusy} hintErr={hintErr} canAsk={!!onAskGemini}
              onJudge={judge} onAsk={askPolaris} onSkip={skipCur} onReset={resetSkips} />
          </div>
        </Modal>
      )}

      {/* the converge panel — picked ideas become editable ticket drafts */}
      {convergeOpen && (
        <Modal onClose={() => setConvergeOpen(false)} closeOnOverlay={false} wide>
          <div className="psky-pop cvg">
            <div className="psky-pop-head">
              <span className="name">Converge → tickets</span>
              <span className="cvg-count">{trayIdeas.length} idea{trayIdeas.length === 1 ? '' : 's'}</span>
              <button className="psky-pop-close" onClick={() => setConvergeOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="cvg-bar">
              <div className="seg-control sm" role="tablist" aria-label="Converge mode">
                <button className={`seg-opt ${convergeMode === 'tickets' ? 'on' : ''}`}
                  onClick={() => switchConvergeMode('tickets')}>Ticket per idea</button>
                <button className={`seg-opt ${convergeMode === 'epic' ? 'on' : ''}`}
                  onClick={() => switchConvergeMode('epic')}>One epic</button>
              </div>
              <div style={{ flex: 1 }} />
              {onConvergeDraft && (
                <button className="psky-all" onClick={draftWithGemini} disabled={convergeBusy}
                  title="Gemini drafts the tickets against the north star — everything stays editable">
                  {convergeBusy ? '✧ drafting…' : '✧ Draft with Gemini'}
                </button>
              )}
            </div>
            {convergeErr && <div className="psky-cluster-err">✧ {convergeErr}</div>}
            <div className="cvg-list">
              {convergeDrafts.map((d, i) => (
                <div className="cvg-card" key={i}>
                  <div className="cvg-row">
                    <input className="field-input sm cvg-title" value={d.title}
                      placeholder="Ticket title" onChange={(e) => editDraft(i, { title: e.target.value })} />
                    <div className="seg-control sm" role="tablist" aria-label="Bucket">
                      {(['must', 'should', 'could'] as const).map((b) => (
                        <button key={b} className={`seg-opt ${d.bucket === b ? 'on' : ''}`}
                          onClick={() => editDraft(i, { bucket: b })}>{b}</button>
                      ))}
                    </div>
                  </div>
                  <textarea className="field-area" value={d.note} placeholder="What does done look like?"
                    onChange={(e) => editDraft(i, { note: e.target.value })} />
                  <div className="cvg-row">
                    <input className="field-input sm" style={{ maxWidth: 180 }} value={d.area}
                      placeholder="area (optional)" onChange={(e) => editDraft(i, { area: e.target.value })} />
                    <span className="cvg-sources">
                      from {d.sources.length ? d.sources.map((s) => `#${s}`).join(' ') : 'the tray'}
                    </span>
                  </div>
                  <textarea className="field-area cvg-plan" value={d.plan.join('\n')}
                    placeholder={'plan steps — one per line (optional)'}
                    onChange={(e) => editDraft(i, { plan: e.target.value.split('\n') })} />
                </div>
              ))}
            </div>
            <div className="psky-pop-foot cvg-foot">
              {slug && (
                <button className="cvg-studio" onClick={convergeInStudio}
                  title="Take the set to the Polaris studio and design it in conversation instead">
                  ✦ Design in the studio instead
                </button>
              )}
              <label className="cvg-retire">
                <input type="checkbox" checked={retire} onChange={() => setRetire((r) => !r)} />
                retire the converged ideas from the funnel
              </label>
              <div style={{ flex: 1 }} />
              <button className="btn-cancel sm" onClick={() => setConvergeOpen(false)}>Cancel</button>
              <button className="btn-submit sm" onClick={createConverged}
                disabled={!convergeDrafts.some((d) => d.title.trim())}>
                Create {convergeDrafts.filter((d) => d.title.trim()).length} ticket{convergeDrafts.filter((d) => d.title.trim()).length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Gemini's suggested clustering — nothing is written until Apply */}
      {/* #254 — the suggestions are a DRAFT you edit, not a list you accept or
          reject wholesale. Rename a theme, move an idea to another theme, coin
          a theme Gemini never thought of — then apply. Nothing is written until
          you do, so every edit here is free. */}
      {clusterSugs && (
        <Modal onClose={() => setClusterSugs(null)} closeOnOverlay={false} wide>
          <div className="psky-pop psky-cluster-pop">
            <div className="psky-pop-head">
              <span className="name">✧ Suggested themes</span>
              <button className="psky-pop-close" onClick={() => setClusterSugs(null)} aria-label="Close">×</button>
            </div>
            <div className="psky-cluster-hint">
              Gemini's grouping of the funnel against the north star — a draft, not a verdict.
              Untick what's wrong, rename a theme, move an idea with its ▾ picker, or coin a new
              theme below. Nothing is written until you apply.
            </div>
            <div className="psky-cluster-list">
              {clusterThemes.map((a) => {
                const rows = clusterSugs.filter((s) => s.area === a);
                return (
                <div className="psky-cluster-group" key={a}>
                  <div className="theme">
                    {clusterRename === a ? (
                      <input className="psky-theme-input" autoFocus value={clusterRenameDraft}
                        maxLength={40} placeholder="theme name…"
                        onChange={(e) => setClusterRenameDraft(e.target.value)}
                        onBlur={() => commitClusterRename(a)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitClusterRename(a);
                          if (e.key === 'Escape') { setClusterRename(null); setClusterRenameDraft(''); }
                        }} />
                    ) : (
                      <button className="psky-theme-name"
                        onClick={() => { setClusterRename(a); setClusterRenameDraft(a); }}
                        title="Rename this theme — it's just a draft until you apply">
                        {a} <span className="n">{rows.length}</span> <span className="pencil">✎</span>
                      </button>
                    )}
                  </div>
                  {rows.map((s) => (
                    <div className="psky-cluster-row" key={s.id}>
                      <label>
                        <input type="checkbox" checked={clusterPicks.has(s.id)}
                          onChange={() => setClusterPicks((p) => {
                            const n = new Set(p);
                            if (n.has(s.id)) n.delete(s.id); else n.add(s.id);
                            return n;
                          })} />
                        <span>{s.currentTitle}</span>
                      </label>
                      {/* Move ONE idea without touching the rest of its theme. */}
                      <select className="psky-cluster-move" value={s.area}
                        aria-label={`Theme for ${s.currentTitle}`}
                        title="Move this idea to another theme"
                        onChange={(e) => moveClusterItem(s.id, e.target.value)}>
                        {clusterThemes.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                  ))}
                  {rows.length === 0 && <div className="psky-cluster-empty">empty — move an idea here</div>}
                </div>
                );
              })}
            </div>
            <div className="psky-cluster-new">
              {clusterAdding ? (
                <input className="psky-theme-input" autoFocus value={clusterNewDraft}
                  maxLength={40} placeholder="new theme name… (Enter)"
                  onChange={(e) => setClusterNewDraft(e.target.value)}
                  onBlur={commitClusterNew}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitClusterNew();
                    if (e.key === 'Escape') { setClusterAdding(false); setClusterNewDraft(''); }
                  }} />
              ) : (
                <button className="chip-sm add" onClick={() => setClusterAdding(true)}
                  title="Coin a theme Gemini didn't suggest, then move ideas into it">
                  + new theme
                </button>
              )}
            </div>
            <div className="psky-pop-foot">
              <button className="btn-cancel sm" onClick={() => setClusterSugs(null)}>Cancel</button>
              <button className="btn-submit sm" onClick={applyCluster} disabled={clusterPicks.size === 0}>
                Apply {clusterPicks.size} idea{clusterPicks.size === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// The judge queue's card — one unsorted idea at a time, three verdicts, the
// Gemini hint behind "What would Polaris say?". Rendered small in the rail
// (with the ⤢ pop-out) and big inside the pop-out modal; same state both ways.
function QueueCard({
  cur, unjudgedCount, judgedCount, hint, hintBusy, hintErr, canAsk,
  onJudge, onAsk, onSkip, onReset, onPopOut, big,
}: {
  cur: Future | null;
  unjudgedCount: number;
  judgedCount: number;
  hint: { id: number; s: JudgeSuggestion } | null;
  hintBusy: boolean;
  hintErr: string;
  canAsk: boolean;
  onJudge: (f: Future, v: Alignment) => void;
  onAsk: (f: Future) => void;
  onSkip: () => void;
  onReset: () => void;
  onPopOut?: () => void;
  big?: boolean;
}) {
  return (
    <div className={`psky-queue ${big ? 'big' : ''}`}>
      <div className="psky-queue-head">
        <span className="label">JUDGE QUEUE</span>
        <div style={{ flex: 1 }} />
        <span className="progress">{judgedCount} of {judgedCount + unjudgedCount} judged</span>
        {onPopOut && (
          <button className="psky-pop-btn" onClick={onPopOut} title="Pop the queue out" aria-label="Pop the queue out">⤢</button>
        )}
      </div>
      {cur ? (
        <div>
          <div className="psky-queue-title">{cur.title}</div>
          {cur.note && <div className="psky-queue-note">{cur.note}</div>}
          {big && cur.area && <div className="psky-queue-theme">{cur.area}</div>}
          <div className="psky-queue-opts">
            {ALIGNMENTS.map((a) => (
              <button key={a.key} className={`psky-verdict ${a.key}`} title={a.hint}
                onClick={() => onJudge(cur, a.key)}>
                <span className="dot" />
                <span>{a.label}</span>
              </button>
            ))}
          </div>
          <div className="psky-queue-foot">
            {canAsk && (!hint || hint.id !== cur.id) && !hintErr && (
              <button className="psky-ask" onClick={() => onAsk(cur)} disabled={hintBusy}>
                {hintBusy ? '✦ asking…' : '✦ What would Polaris say?'}
              </button>
            )}
            {hintErr && <span className="psky-hint-err">✦ {hintErr}</span>}
            {hint && hint.id === cur.id && (
              <div className="psky-hint">
                <div className="verdict" style={{ color: RING_COLOR[hint.s.alignment] }}>✦ {alignLabel(hint.s.alignment)}</div>
                <div className="why">{hint.s.why}</div>
              </div>
            )}
            <div style={{ flex: 1 }} />
            <button className="psky-skip" onClick={onSkip}>skip →</button>
          </div>
        </div>
      ) : unjudgedCount ? (
        <div className="psky-queue-done">
          {unjudgedCount} skipped this pass.{' '}
          <button className="link" onClick={onReset}>Bring them back</button>
        </div>
      ) : (
        <div className="psky-queue-done">Queue clear — every idea carries a verdict, yours where you gave one.</div>
      )}
    </div>
  );
}

// The rail's selected-idea panel: verdict pill + theme, title, and the
// dispositions (promote / build on / edit / dismiss). Judging an unjudged
// selection happens right here too — the queue is just the other door in.
function SelectedPanel({
  selected, themeLabel, inTray, onToggleTray, onPromote, onEdit, onAlign, onDelete, onBuildOn,
}: {
  selected: Future | null;
  themeLabel: string;
  inTray: boolean;
  onToggleTray?: () => void;
  onPromote: (future: Future) => void;
  onEdit: (id: number, patch: { title: string; note: string; area: string }) => void;
  onAlign: (id: number, alignment: Alignment | '') => void;
  onDelete: (id: number) => void;
  onBuildOn?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [area, setArea] = useState('');
  useEffect(() => { setEditing(false); setPicking(false); }, [selected?.id]);

  if (!selected) {
    return (
      <div className="psky-sel">
        <div className="psky-sel-empty">Pick a star — click any idea in the sky and it lands here for a verdict or a promotion.</div>
      </div>
    );
  }
  const f = selected;
  const v = f.alignment || '';

  const save = () => {
    const t = title.trim();
    if (t && (t !== f.title || note.trim() !== f.note || area.trim().toLowerCase() !== f.area)) {
      onEdit(f.id, { title: t, note: note.trim(), area: area.trim().toLowerCase() });
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="psky-sel">
        <input className="field-input sm" value={title} autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') setEditing(false); }} />
        <textarea className="field-area" style={{ marginTop: 8, minHeight: 46 }} value={note}
          placeholder="Why it might matter…" onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
            else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
          }} />
        <input className="field-input sm" style={{ marginTop: 8 }} value={area}
          placeholder="theme — e.g. agents, mirrors (optional)"
          onChange={(e) => setArea(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') setEditing(false); }} />
        <div className="future-edit-row">
          <button className="btn-cancel sm" onClick={() => setEditing(false)}>Cancel</button>
          <button className="btn-submit sm" onClick={save}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <div className="psky-sel">
      <div className="psky-sel-meta">
        {picking ? (
          <span className="review-pick">
            {ALIGNMENTS.map((a) => (
              <button key={a.key} className={`review-pick-opt ${a.key}`} title={a.hint}
                onClick={() => { setPicking(false); onAlign(f.id, f.alignment === a.key ? '' : a.key); }}>
                {a.label}
              </button>
            ))}
          </span>
        ) : (
          <button className="psky-pill" style={{ background: RING_TINT[v], color: RING_COLOR[v] }}
            onClick={() => setPicking(true)}
            title={v ? 'Change the verdict (pick the same to clear)' : 'Judge this against the north star'}>
            {v ? alignLabel(v) : '✦ judge'}
          </button>
        )}
        <span className="theme">{themeLabel}</span>
        {f.source === 'hook' && <span className="auto-badge">✦ auto</span>}
        <span className="when">{f.when}</span>
      </div>
      <div className="psky-sel-title">{f.title}</div>
      {f.note && <div className="psky-sel-note">{f.note}</div>}
      <div className="psky-sel-actions">
        <button className="act primary" onClick={() => onPromote(f)}>→ Roadmap</button>
        {onToggleTray && (
          <button className={`act ${inTray ? 'in-tray' : ''}`} onClick={onToggleTray}
            title="The converge tray — pick ideas across the sky, then converge the set into tickets">
            {inTray ? '✓ In tray' : '⊕ Converge'}
          </button>
        )}
        {onBuildOn && <button className="act" onClick={onBuildOn}>Build on it</button>}
        <button className="act" onClick={() => { setTitle(f.title); setNote(f.note); setArea(f.area); setEditing(true); }}>✎ Edit</button>
        <button className="act quiet" onClick={() => onDelete(f.id)}>Dismiss</button>
      </div>
    </div>
  );
}

function IdeaRow({
  future: f, highlighted, selected, onSelect, onEdit, onAlign, onDelete, onPromote, onAskGemini,
}: {
  future: Future;
  highlighted?: boolean;
  // #259 — the sky and the list are two views of ONE selection. A row wears the
  // selection the sky made and can make it itself, so switching views never
  // loses your place.
  selected?: boolean;
  onSelect?: () => void;
  onEdit: (id: number, patch: { title: string; note: string; area: string }) => void;
  onAlign: (id: number, alignment: Alignment | '') => void;
  onDelete: (id: number) => void;
  onPromote: (future: Future) => void;
  onAskGemini?: (id: number) => Promise<JudgeSuggestion>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(f.title);
  const [note, setNote] = useState(f.note);
  const [area, setArea] = useState(f.area);
  const [picking, setPicking] = useState(false);
  // Gemini's suggested verdict: shown until applied or waved away, never
  // written to the idea by itself.
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<JudgeSuggestion | null>(null);
  const [suggestErr, setSuggestErr] = useState('');

  const askGemini = async () => {
    if (!onAskGemini || suggesting) return;
    setSuggesting(true);
    setSuggestErr('');
    try {
      setSuggestion(await onAskGemini(f.id));
    } catch (e) {
      setSuggestErr((e as Error)?.message || 'Gemini call failed.');
    } finally {
      setSuggesting(false);
    }
  };

  const save = () => {
    const t = title.trim();
    const a = area.trim().toLowerCase();
    if (t && (t !== f.title || note.trim() !== f.note || a !== f.area)) {
      onEdit(f.id, { title: t, note: note.trim(), area: a });
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="future-row editing" data-hl={f.id}>
        <div className="future-body">
          <input className="field-input sm" value={title} autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') setEditing(false); }} />
          <textarea className="field-area" style={{ marginTop: 8, minHeight: 46 }} value={note}
            placeholder="Why it might matter…" onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
              else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            }} />
          <input className="field-input sm" style={{ marginTop: 8, maxWidth: 220 }} value={area}
            placeholder="area — e.g. settings, mobile (optional)"
            onChange={(e) => setArea(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') setEditing(false); }} />
          <div className="future-edit-row">
            <button className="btn-cancel sm" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn-submit sm" onClick={save}>Save</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`future-row ${highlighted ? 'hl' : ''} ${selected ? 'sel' : ''}`} data-hl={f.id}>
      <div className="future-body">
        <button className="future-title" onClick={onSelect}
          title="Select this idea — the Polaris rail and the sky follow the same selection">
          {f.title}
        </button>
        {f.note && <div className="future-note">{f.note}</div>}
        <div className="future-meta">
          {picking ? (
            <span className="review-pick">
              {ALIGNMENTS.map((a) => (
                <button key={a.key} className={`review-pick-opt ${a.key}`} title={a.hint}
                  onClick={() => { setPicking(false); onAlign(f.id, f.alignment === a.key ? '' : a.key); }}>
                  {a.label}
                </button>
              ))}
            </span>
          ) : (
            <button className={`align-chip ${f.alignment || 'none'}`} onClick={() => setPicking(true)}
              title={f.alignment ? 'Change the verdict (pick the same to clear)' : 'Judge this against the north star'}>
              {f.alignment ? alignLabel(f.alignment) : '✦ Judge'}
            </button>
          )}
          {onAskGemini && !suggestion && (
            <button className="gemini-btn" onClick={askGemini} disabled={suggesting}
              title="Ask Gemini for a suggested verdict — you still make the call">
              {suggesting ? '✧ Asking…' : '✧ Ask Gemini'}
            </button>
          )}
          {f.area && <span className="area-chip" title="Product area — edit the idea to change it">{f.area}</span>}
          {f.source === 'hook' && <span className="auto-badge">✦ auto</span>}
          <span className="when">{f.when}</span>
        </div>
        {suggestErr && <div className="gemini-suggest err">✧ {suggestErr}</div>}
        {suggestion && (
          <div className="gemini-suggest">
            <span className="g-verdict">✧ Gemini suggests <b>{alignLabel(suggestion.alignment)}</b></span>
            <span className="g-why">— {suggestion.why}</span>
            <button className="g-apply" onClick={() => { onAlign(f.id, suggestion.alignment); setSuggestion(null); }}>
              Apply
            </button>
            <button className="g-dismiss" onClick={() => setSuggestion(null)} aria-label="Dismiss suggestion">×</button>
          </div>
        )}
      </div>
      <div className="future-actions">
        <button className="edit" onClick={() => { setTitle(f.title); setNote(f.note); setEditing(true); }} aria-label="Edit idea" title="Edit idea">✎</button>
        <button className="promote" onClick={() => onPromote(f)}>→ Roadmap</button>
        <button className="dismiss" onClick={() => onDelete(f.id)}>Dismiss</button>
      </div>
    </div>
  );
}
