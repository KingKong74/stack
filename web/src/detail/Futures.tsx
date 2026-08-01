import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Future } from '../types';
import {
  Galaxy, GalaxyBoard, buildGalaxy, flattenGalaxy, orbitIds,
  GX_GLYPH, GX_LABEL, GX_TONE, MAG_WORD, type GxKind, type GxModel,
} from './Galaxy';
import type { ClusterSuggestion, ConvergeDraft, JudgeSuggestion } from '../store';
import { getNorthStarOpen, setNorthStarOpen } from '../store';
import { Modal } from '../components/Modal';

export type Alignment = 'on-course' | 'tangent' | 'off-course';
export const ALIGNMENTS: { key: Alignment; label: string; hint: string }[] = [
  { key: 'on-course', label: 'On course', hint: 'Pulls toward the north star — promote when it firms up' },
  { key: 'tangent', label: 'Tangent', hint: 'Interesting but sideways — park it, revisit later' },
  { key: 'off-course', label: 'Off course', hint: 'Pulls away from the north star — usually a dismiss' },
];
const alignLabel = (a: string) => ALIGNMENTS.find((x) => x.key === a)?.label || 'Unjudged';

const LOOSE = 'loose'; // theme label for ideas with no area tag

// #312 — the sky IS the galaxy now. The old field put every idea on a verdict
// ring and gave each theme (area tag) a bearing: it said everything about how
// an idea was judged and nothing about how ideas relate. The galaxy says both,
// and the geometry that draws it lives in Galaxy.tsx. Area survives as a plain
// tag — the list groups by it and ✧ Cluster still suggests it — but it no
// longer decides where anything sits.
const KIND_LABEL: Record<GxKind, string> = {
  star: 'STAR · ITS OWN ORBIT',
  planet: 'PLANET · ORBITS A STAR',
  moon: 'MOON · PART OF A PLANET',
  shell: 'IDEA · ORBITS THE NORTH STAR',
  belt: 'IDEA · IN THE DRIFT BELT',
};

// Short relative label for the scrub ticks ("3w ago" … "now").
function ago(ms: number): string {
  const d = Math.round(ms / 86400000);
  if (d < 1) return 'today';
  if (d < 7) return `${d}d ago`;
  if (d < 60) return `${Math.round(d / 7)}w ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${(d / 365).toFixed(1)}y ago`;
}

export function Futures({
  northStar, futures, highlightId, onSaveNorthStar, onAdd, onEdit, onAlign, onDelete, onPromote,
  onAskGemini, onCluster, onSetAreas, onConvergeDraft, onConvergeCreate, onShape, slug,
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
  // #314 — promoting a star has to carry its orbit with it, not just its own
  // title and note: `orbit` is every idea that rides underneath it (planets
  // and their moons for a star, moons for a planet, empty for a plain idea).
  onPromote: (future: Future, orbit: Future[]) => void;
  // Where an idea sits in the galaxy and how big it is (#312) — one call for
  // all three, because promoting and adopting are each a move of both.
  onShape: (id: number, patch: { parentId?: number | null; isStar?: boolean; magnitude?: number | null }) => void;
  onAskGemini?: (id: number) => Promise<JudgeSuggestion>;
  onCluster?: () => Promise<ClusterSuggestion[]>;
  onSetAreas: (pairs: { id: number; area: string }[]) => void;
  onConvergeDraft?: (ids: number[], mode: 'tickets' | 'epic') => Promise<ConvergeDraft[]>;
  onConvergeCreate: (drafts: ConvergeDraft[], retire: number[]) => void;
}) {
  // ---- north star strip (collapsible band, always on top) ----
  // #307 — collapsed is the DEFAULT arrival state: the band is a paragraph you
  // wrote once, and the sky below it is what you came for. The choice is
  // remembered per slug (device-local) so a session spent rewriting the
  // direction keeps the editor open across reloads.
  // An UNSET north star is the exception: collapsed it reads "Not set." with no
  // way in, so the band stays open until there is something to collapse.
  const [nsOpen, setNsOpenState] = useState(() => getNorthStarOpen(slug || '') || !northStar.trim());
  const setNsOpen = (open: boolean) => {
    setNsOpenState(open);
    setNorthStarOpen(slug || '', open);
  };
  const [editingStar, setEditingStar] = useState(false);
  const [starDraft, setStarDraft] = useState(northStar);
  const saveStar = () => {
    const t = starDraft.trim();
    if (t !== northStar) onSaveNorthStar(t);
    setEditingStar(false);
  };

  // ---- view + filters ----
  const [view, setView] = useState<'sky' | 'board'>('sky');
  const [sourceFilter, setSourceFilter] = useState<'' | 'hook' | 'manual'>('');
  const mixedSources = futures.some((f) => f.source === 'hook') && futures.some((f) => f.source !== 'hook');
  const bySource = futures
    .filter((f) => !sourceFilter || (sourceFilter === 'hook' ? f.source === 'hook' : f.source !== 'hook'));

  // ---- galaxy state (#312) ----
  // Zoom is six named stops rather than a continuum: each one is a thing you
  // wanted to see ("in on the focused star", "one idea, nothing else"), and the
  // stage pans to the selected system on its own as you pass Fit.
  const [z, setZ] = useState(1);
  const [northOnly, setNorthOnly] = useState(false);
  // Which system is in the light. Everything outside it dims rather than
  // vanishes (the design's change): the galaxy holds still, so you keep the
  // shape you learned and can see that a thing is excluded rather than absent.
  const [focus, setFocus] = useState<string | null>(null);
  const [selId, setSelId] = useState<number | null>(null);

  // #248 — the sky wants the window. The stage was a fixed 860px box inside a
  // page inside a tab, and at any real zoom you were reading a galaxy through a
  // letterbox. Full screen is a CSS mode first and a Fullscreen API request
  // second: the layout keys on the class, so a refused or unavailable request
  // still gives you the whole viewport, and nothing outside this tree can be
  // hidden by it. Transient by design — the API cannot be re-entered on load
  // without a fresh gesture, so a remembered `true` would only ever be a lie.
  const [full, setFull] = useState(false);
  const toggleFull = () => {
    const next = !full;
    setFull(next);
    if (next) void document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
  };
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setFull(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.fullscreenElement) setFull(false); };
    document.addEventListener('fullscreenchange', onChange);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  // The rail folds to a spine you can still see the count on. Collapsing it is
  // what makes full screen worth entering, so the two live together.
  const [railOpen, setRailOpen] = useState(true);

  // ---- the time window: the same sky over its own history ----
  // The design turned the six snap-to ticks into a draggable WINDOW, and the
  // window is the better instrument: "the last N days" is a question you
  // actually have ("what has landed since I last looked?"), where "as of tick
  // 3 of 6" was only ever an approximation of one. Continuous, so you can
  // close in on the week you mean.
  //
  // The span is the funnel's REAL history, not the design's fixed four weeks —
  // a track that says 4w over a nine-month funnel is a lie you drag.
  const span = useMemo(() => {
    const times = bySource.map((f) => Date.parse(f.createdAt)).filter(Number.isFinite);
    if (times.length < 4) return null;          // too little history to be worth a scrub
    const days = Math.ceil((Date.now() - Math.min(...times)) / 86400000);
    if (days < 2) return null;                  // a days-old sky has no past to visit
    // Ticks are a rhythm, not a claim: one per day while that stays legible,
    // one per week after, with every seventh (or fourth) drawn taller.
    const byDay = days <= 60;
    const step = byDay ? 1 : 7;
    const big = byDay ? 7 : 28;
    const ticks = [];
    for (let d = 0; d <= days; d += step) ticks.push({ x: (d / days) * 100, tall: d % big === 0 });
    return { days, ticks, label: ago(days * 86400000) };
  }, [bySource]);

  // null = the whole span. Any change to the population snaps back, so a fresh
  // idea is never hidden behind a window you set before it arrived.
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => { setSince(null); }, [futures.length]);
  const windowDays = span && since != null && since < span.days ? since : null;
  const trackRef = useRef<HTMLDivElement>(null);
  const dragWindow = (e: React.PointerEvent) => {
    const el = trackRef.current;
    if (!el || !span) return;
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      setSince(Math.max(1, Math.round(span.days - f * span.days)));
    };
    move(e.nativeEvent);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const cutoff = windowDays != null ? Date.now() - windowDays * 86400000 : 0;
  const arrivedCount = windowDays != null
    ? bySource.filter((f) => Date.parse(f.createdAt) >= cutoff).length : 0;

  // The galaxy is built from EVERY idea that had arrived, not from the
  // source-filtered slice: the filter decides which dots are DRAWN, not which
  // orbits exist, so switching it can never orphan a star's planets or make
  // the sky jump between two shapes of the same data.
  const arrived = useMemo(
    () => (windowDays != null ? futures.filter((f) => Date.parse(f.createdAt) >= cutoff) : futures),
    [futures, windowDays],      // eslint-disable-line react-hooks/exhaustive-deps
  );
  const galaxy = useMemo(() => buildGalaxy(arrived), [arrived]);
  const rows = useMemo(() => flattenGalaxy(galaxy), [galaxy]);
  const selected = selId != null ? galaxy.all.find((f) => f.id === selId) || null : null;
  const selKind: GxKind | null = selected ? galaxy.kindOf(selected) : null;

  // #314 — promoting an idea has to carry its orbit into the roadmap draft.
  // Walks `galaxy` (the arrived/windowed model), the same one the panel's
  // "PLANETS IN ITS ORBIT" list is drawn from, so what gets promoted matches
  // what the human can see — never the full `futures` list. `orbitIds` returns
  // the idea itself first, so drop that and hand the rest up as `Future`s: the
  // caller needs their titles and notes, and re-deriving them from bare ids
  // would just redo the walk this already did.
  const promoteWithOrbit = (f: Future) => {
    const orbit = orbitIds(galaxy, f.id).slice(1)
      .map((id) => galaxy.all.find((x) => x.id === id))
      .filter((x): x is Future => !!x);
    onPromote(f, orbit);
  };

  // #259 — the views are two doors into ONE selection, so switching has to
  // CARRY it rather than merely keep the id. Landing on a view where the
  // selected idea is filtered out or below the fold would preserve the
  // selection while losing it in every sense that matters.
  useEffect(() => {
    if (!selected || view !== 'board') return undefined;
    const t = setTimeout(() => {
      document.querySelector('.pgx-card.sel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 60);
    return () => clearTimeout(t);
  }, [view, selected?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  // A search deep-link picks the idea out of the sky and goes to its system.
  const hlDone = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightId || hlDone.current === highlightId) return;
    const f = futures.find((x) => String(x.id) === highlightId);
    if (!f) return;
    hlDone.current = highlightId;
    setSelId(f.id);
  }, [highlightId, futures]);

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
  // Every branch has to be TRUE of the galaxy as it stands, which is why each
  // one names the count it is reading. A line that says something about a shape
  // nobody has built yet is worse than no line.
  const observation = useMemo(() => {
    const heaviest = [...galaxy.stars]
      .map((s) => ({ s, on: s.planets.filter((p) => p.f.alignment === 'on-course').length }))
      .sort((a, b) => b.on - a.on)[0];
    const drifting = galaxy.stars.find((s) =>
      s.planets.length >= 3 && s.planets.every((p) => p.f.alignment === 'off-course'));
    if (drifting) {
      return `Every one of ${drifting.f.title}'s ${drifting.planets.length} planets is off course. That is a whole system pulling away from the star — worth deciding once, out loud, rather than ${drifting.planets.length} times in the queue.`;
    }
    if (galaxy.belt.length >= 5) {
      return `${galaxy.belt.length} ideas are still drifting in the belt with no verdict — one pass through the queue and the sky files itself.`;
    }
    const biggestShell = galaxy.shells
      .filter((f) => f.alignment === 'on-course')
      .sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0))[0];
    if (biggestShell && (biggestShell.magnitude ?? 0) >= 4) {
      return `${galaxy.shells.length} judged ideas still ride the north star with no star of their own — "${biggestShell.title}" is magnitude ${biggestShell.magnitude} and looks like your next star.`;
    }
    if (heaviest && heaviest.on >= 3) {
      return `${heaviest.s.f.title} holds the most on-course mass — ${heaviest.on} of its ${heaviest.s.planets.length} planets. The ripest of them belongs on the roadmap.`;
    }
    if (galaxy.stars.length === 0 && galaxy.all.length >= 4) {
      return `Nothing has been promoted to a star yet, so every idea is loose. Promote the one you keep coming back to and the rest can orbit it.`;
    }
    return '';
  }, [galaxy]);

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
  // The FULL list, never `bySource`: a filter dims a dot in the sky, it must
  // never silently drop that idea's orbit out of the drafts converge builds.
  // Order is the whole forest's own depth-first order (not tray insertion
  // order), so a parent sits immediately above its own orbit regardless of
  // which member was ticked first — the order `directDrafts('epic')` wants.
  // Walks its OWN model over the full `futures` list, deliberately not
  // `galaxy` (the arrived/windowed one): the source filter must never drop a
  // picked idea from the drafts (the original bug) and narrowing the date
  // window AFTER picking must not silently vanish one either — never drop
  // what was already picked. One rebuild per `futures` change, not per
  // render, so it stays cheap.
  const trayIdeas = useMemo(() => {
    const model = buildGalaxy(futures);
    const seen = new Set<number>();
    const out: Future[] = [];
    const walk = (f: Future) => {
      if (seen.has(f.id)) return;
      seen.add(f.id);
      if (tray.has(f.id)) out.push(f);
      model.childrenOf(f).forEach(walk);
    };
    model.all.forEach((f) => { if (model.parentOf(f) == null) walk(f); });
    return out;
  }, [futures, tray]);
  // Sweeps `galaxy` (the arrived/windowed model), not the full list: this
  // decides what the sweep can PULL from, and it should match what the
  // "PLANETS IN ITS ORBIT" list on screen shows — sweep what you can see, or
  // the Converge button would read "+5" above a visible list of two.
  // Ticking an idea sweeps its whole orbit into the tray; unticking sweeps it
  // back out. The whole set goes in, the whole set comes out — the simplest
  // rule that stays consistent when a child was already in the tray on its own.
  const toggleTray = (id: number) => {
    const orbit = orbitIds(galaxy, id);
    setTray((t) => {
      const n = new Set(t);
      if (n.has(id)) orbit.forEach((oid) => n.delete(oid));
      else orbit.forEach((oid) => n.add(oid));
      return n;
    });
  };

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
  // ---- composers ----
  const [draft, setDraft] = useState('');
  const add = () => {
    const lines = draft.split('\n');
    const title = (lines[0] || '').trim();
    if (!title) return;
    onAdd(title, lines.slice(1).join('\n').trim());
    setDraft('');
  };
  // ---- list view (the pre-sky layout, kept as a secondary view) ----

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

      {/* control row: the census · source filter · the queue's door · full screen · sky/board */}
      <div className="psky-top">
        <span className="psky-total">{bySource.length} ideas</span>
        {/* The census: what shape the galaxy is in, before you look at it. */}
        <span className="psky-census">
          <span className="stars">★ {galaxy.stars.length} stars</span>
          <span>·</span><span>{galaxy.stars.reduce((n, s) => n + s.planets.length, 0)} planets</span>
          <span>·</span>
          <span>{galaxy.stars.reduce((n, s) => n + s.planets.reduce((m, p) => m + p.moons.length, 0), 0)} moons</span>
          <span>·</span><span>{galaxy.shells.length} on the north star</span>
          <span>·</span><span>{galaxy.belt.length} in the belt</span>
        </span>
        <div style={{ flex: 1 }} />
        {mixedSources && (
          <div className="seg-control sm" role="tablist" aria-label="Idea sources">
            <button className={`seg-opt ${sourceFilter === '' ? 'on' : ''}`} onClick={() => setSourceFilter('')}>All</button>
            <button className={`seg-opt ${sourceFilter === 'hook' ? 'on' : ''}`} onClick={() => setSourceFilter('hook')}
              title="Ideas auto-extracted from pushes and reviews — the others dim, they do not vanish">Generated</button>
            <button className={`seg-opt ${sourceFilter === 'manual' ? 'on' : ''}`} onClick={() => setSourceFilter('manual')}
              title="Ideas you typed (or agreed with Polaris) — the others dim, they do not vanish">Manual</button>
          </div>
        )}
        {/* #246 — the judge queue is a BUTTON, not a rail card. It was the
            second-biggest thing in the side panel and you only want it when you
            are actually judging; as a button it carries its own count and stays
            reachable from every view. The badge is the FUNNEL's state (judged of
            all), not this session's tally — a badge reading 0/9 on arrival every
            time would be measuring the wrong thing. */}
        <button className={`psky-queue-btn${unjudged.length ? ' due' : ''}`}
          onClick={() => setQueueOut(true)}
          title={unjudged.length
            ? `${unjudged.length} idea${unjudged.length === 1 ? '' : 's'} still carry no verdict — open the queue`
            : 'Every idea carries a verdict. Open the queue anyway'}>
          ✦ Judge queue
          <span className="badge">{bySource.length - unjudged.length}/{bySource.length}</span>
        </button>
        {onCluster && bySource.length > 0 && (
          <button className="psky-all" onClick={runCluster} disabled={clusterBusy}
            title="Gemini groups the funnel into area tags — you review before anything is written">
            {clusterBusy ? '✧ clustering…' : '✧ Cluster'}
          </button>
        )}
        {/* The head bar survives full screen, so the way out is where the way
            in was — and esc leaves too, whether or not the browser granted the
            real Fullscreen API. */}
        <button className={`psky-all${full ? ' on' : ''}`} onClick={toggleFull} aria-pressed={full}
          title={full ? 'Leave full screen (esc also works)' : 'Full screen — the sky takes the whole window'}>
          {full ? '⤡' : '⤢'}
        </button>
        <div className="seg-control sm" role="tablist" aria-label="Ideas view">
          <button className={`seg-opt ${view === 'sky' ? 'on' : ''}`} onClick={() => setView('sky')}>Sky</button>
          <button className={`seg-opt ${view === 'board' ? 'on' : ''}`} onClick={() => setView('board')}>Board</button>
        </div>
      </div>

      {clusterErr && <div className="psky-cluster-err">✧ {clusterErr}</div>}

        <div className={`psky${full ? ' full' : ''}${railOpen ? '' : ' railed'}`}>
          {/* The control row is a sibling, so full screen covers the ⤢ that got
              you here. The way out lives inside the thing that covered it. */}
          {full && (
            <button className="psky-exitfull" onClick={toggleFull}
              title="Leave full screen (esc also works)">⤡ Leave full screen</button>
          )}
          {/* ---- the sky ---- */}
          <div className="psky-main">
            {view === 'sky' && (
              <>
              <div className="psky-chips">
                {/* Scope: the whole galaxy, or the north star's own shells alone.
                    Its shells crowd the middle when eight systems are drawn over
                    them, and reading them is a different job from reading the
                    systems — so it is a scope, not a zoom. */}
                <div className="seg-control sm" role="tablist" aria-label="Sky scope">
                  <button className={`seg-opt ${!northOnly ? 'on' : ''}`} onClick={() => setNorthOnly(false)}>
                    Galaxy <span className="n">{galaxy.stars.length} stars</span>
                  </button>
                  <button className={`seg-opt ${northOnly ? 'on' : ''}`} onClick={() => setNorthOnly(true)}>
                    North star <span className="n">{galaxy.shells.length} of its own</span>
                  </button>
                </div>
                <button className={`psky-chip ${focus === null ? 'on' : ''}`}
                  onClick={() => { setFocus(null); setZ(1); setSelId(null); }}
                  title="Everything lit, back at Fit">
                  <span className="name">fit all</span>
                  <span className="n">{galaxy.all.length}</span>
                </button>
                <button className={`psky-chip ${focus === 'core' ? 'on' : ''}`}
                  onClick={() => { setNorthOnly(false); setFocus('core'); setSelId(null); setZ(2.2); }}
                  title="The north star's own shells">
                  <span className="name">north star</span>
                  <span className="n">{galaxy.shells.length}</span>
                </button>
                {galaxy.stars.map((s) => (
                  <button key={s.f.id} className={`psky-chip ${focus === String(s.f.id) ? 'on' : ''}`}
                    onClick={() => { setNorthOnly(false); setFocus(String(s.f.id)); setSelId(s.f.id); setZ(2.8); }}
                    title={`Go to ${s.f.title}'s system — the rest of the sky dims`}>
                    <span className="name">{s.f.title}</span>
                    <span className="n">{s.planets.length}</span>
                  </button>
                ))}
                {galaxy.belt.length > 0 && (
                  <button className={`psky-chip ${focus === 'belt' ? 'on' : ''}`}
                    onClick={() => { setNorthOnly(false); setFocus('belt'); setZ(1); setSelId(galaxy.belt[0].id); }}
                    title="The drift belt — everything still waiting on a verdict">
                    <span className="name">belt</span>
                    <span className="n">{galaxy.belt.length}</span>
                  </button>
                )}
                <div style={{ flex: 1 }} />
                <span className="psky-lod">
                  {northOnly
                    ? 'Only the north star and its own unadopted ideas, on three tiered shells.'
                    : `${galaxy.stars.length} star systems around the north star, plus the drift belt.`}
                </span>
              </div>

              <Galaxy model={galaxy} northOnly={northOnly} sourceFilter={sourceFilter} focus={focus}
                selId={selId} zoom={z} onZoom={setZ}
                onSelect={(id, shift) => { if (shift && id != null) toggleTray(id); else setSelId(id); }} />

              {/* The time window: drag anywhere on the track. The shaded part is
                  what the window excludes, so the handle's position reads as
                  "everything to the right of here". */}
              {span && (
                <div className="psky-scrub">
                  <span className="edge">{span.label}</span>
                  <div className="track" ref={trackRef} onPointerDown={dragWindow}
                    role="slider" aria-label="How far back the sky reaches"
                    aria-valuemin={1} aria-valuemax={span.days} aria-valuenow={windowDays ?? span.days}>
                    {span.ticks.map((t, i) => (
                      <span key={i} className={`tk${t.tall ? ' tall' : ''}`} style={{ left: `${t.x}%` }} />
                    ))}
                    <span className="shade" style={{ width: `${100 - ((windowDays ?? span.days) / span.days) * 100}%` }} />
                    <span className="lit" style={{ left: `${100 - ((windowDays ?? span.days) / span.days) * 100}%` }} />
                    <span className="grip" style={{ left: `${100 - ((windowDays ?? span.days) / span.days) * 100}%` }} />
                  </div>
                  <button className={`nowlbl ${windowDays != null ? 'then' : ''}`}
                    onClick={() => setSince(null)}
                    title={windowDays != null ? 'Back to the whole span' : 'The sky as it stands'}>
                    {windowDays != null ? `last ${windowDays}d` : `all ${span.label}`}
                  </button>
                </div>
              )}
              {windowDays != null && (
                <div className="psky-scrub-caption">
                  Only the {arrivedCount} of {futures.length} idea{futures.length === 1 ? '' : 's'} added in the
                  last {windowDays} day{windowDays === 1 ? '' : 's'}. Verdicts and shapes are today's; only
                  the population is windowed — an idea whose star is outside the window draws loose.
                  <button onClick={() => setSince(null)}>▸ The whole span</button>
                </div>
              )}
              </>
            )}

            {view === 'board' && (
              <div className="pgx-board-wrap">
                <div className="pgx-board-head">
                  <span className="lede">
                    Every idea, filed by verdict. <b>Selecting here selects in the sky.</b>
                  </span>
                  <span className="key">★ star · ● planet · ○ moon · ◦ north star · · belt</span>
                </div>
                <GalaxyBoard rows={rows} selId={selId} onSelect={setSelId} />
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
                <span className="hint">shift-click anything in the sky to add more</span>
                <div style={{ flex: 1 }} />
                <button className="psky-tray-clear" onClick={() => setTray(new Set())}>clear</button>
                <button className="psky-tray-go" onClick={openConverge}>Converge → tickets</button>
              </div>
            )}
            <div className="psky-composer">
              <span className="plus">+</span>
              <input value={draft}
                placeholder="Add an idea — it lands unjudged in the belt, and the queue files it onto a shell"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); add(); }
                  else if (e.key === 'Escape') { e.preventDefault(); setDraft(''); }
                }} />
            </div>
          </div>

          {/* ---- the rail: Polaris ---- */}
          {!railOpen ? (
            <button className="psky-spine" onClick={() => setRailOpen(true)}
              title="Open the Polaris panel">
              <span className="chev">‹</span>
              <span className="name">Polaris</span>
              {unjudged.length > 0 && <span className="n">{unjudged.length}</span>}
            </button>
          ) : (
          <div className="psky-rail">
            <div className="psky-rail-head">
              <span className="name">Polaris</span>
              <span className="sub">plans only</span>
              <div style={{ flex: 1 }} />
              <button className="psky-rail-fold" onClick={() => setRailOpen(false)}
                title="Collapse the panel — the sky takes the width" aria-label="Collapse the Polaris panel">›</button>
            </div>

            <SelectedPanel selected={selected} themeLabel={selected ? (selected.area || LOOSE) : ''}
              galaxy={galaxy} kind={selKind}
              inTray={selected ? tray.has(selected.id) : false}
              orbitExtra={selected ? orbitIds(galaxy, selected.id).length - 1 : 0}
              onToggleTray={selected ? () => toggleTray(selected.id) : undefined}
              onSelect={setSelId} onShape={onShape}
              onPromote={promoteWithOrbit} onEdit={onEdit} onAlign={onAlign} onDelete={onDelete} />

            <div className="psky-rail-scroll">
              {/* What still rides the north star with no star of its own — the
                  pile the next promotion comes out of, and invisible in the sky
                  once eight systems are drawn over the shells. */}
              {galaxy.shells.length > 0 && (
                <div className="psky-shells">
                  <div className="head">
                    <span className="label">ON THE NORTH STAR</span>
                    <span className="n">{galaxy.shells.length} unadopted</span>
                  </div>
                  {(['on-course', 'tangent', 'off-course'] as const).map((v) => {
                    const items = galaxy.shells.filter((f) => f.alignment === v)
                      .sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0));
                    if (!items.length) return null;
                    return (
                      <div className="grp" key={v} style={{ ['--vc']: GX_TONE[v] } as CSSProperties}>
                        <div className="grp-head">
                          <span className="dot" />
                          <span className="name">{GX_LABEL[v]}</span>
                          <span className="n">{items.length}</span>
                          <span className="rule" />
                        </div>
                        {items.slice(0, 3).map((f) => (
                          <button key={f.id} className={`row${selId === f.id ? ' sel' : ''}`}
                            onClick={() => setSelId(f.id)}>
                            <span className="t">{f.title}</span>
                            <span className="m">{f.magnitude ? `mag ${f.magnitude}` : '—'}</span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}

              {observation && (
                <div className="psky-note">
                  <span className="label">✦ POLARIS</span>
                  <div className="text">{observation}</div>
                </div>
              )}
            </div>
          </div>
          )}
        </div>

      {/* #246 — the queue lives here now: one popup, opened by the button in
          the control row. Same state it always had, just no longer taking a
          third of the rail while you are reading the sky. */}
      {queueOut && (
        <Modal onClose={() => setQueueOut(false)}>
          <div className="psky-pop">
            <div className="psky-pop-head">
              <span className="name">Judge queue</span>
              <span className="cvg-count">
                {bySource.length - unjudged.length} of {bySource.length} judged
              </span>
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
  onJudge, onAsk, onSkip, onReset, big,
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
  big?: boolean;
}) {
  return (
    <div className={`psky-queue ${big ? 'big' : ''}`}>
      <div className="psky-queue-head">
        <span className="label">JUDGE QUEUE</span>
        <div style={{ flex: 1 }} />
        <span className="progress">{judgedCount} of {judgedCount + unjudgedCount} judged</span>
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
                <div className="verdict" style={{ color: GX_TONE[hint.s.alignment] }}>✦ {alignLabel(hint.s.alignment)}</div>
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

// The rail's selected-idea panel: what the thing IS, how big it is, what
// orbits it, and every disposition — verdict, magnitude, promote to a star,
// adopt into one, converge, edit, dismiss. Judging happens right here too; the
// queue is just the other door in.
function SelectedPanel({
  selected, themeLabel, galaxy, kind, inTray, orbitExtra, onToggleTray, onSelect, onShape,
  onPromote, onEdit, onAlign, onDelete,
}: {
  selected: Future | null;
  themeLabel: string;
  galaxy: GxModel;
  kind: GxKind | null;
  inTray: boolean;
  // How many more ideas ride in this one's orbit — 0 for a plain idea. Shown
  // on the Converge button so picking a star says up front what comes with it.
  orbitExtra: number;
  onToggleTray?: () => void;
  onSelect: (id: number) => void;
  onShape: (id: number, patch: { parentId?: number | null; isStar?: boolean; magnitude?: number | null }) => void;
  onPromote: (future: Future) => void;
  onEdit: (id: number, patch: { title: string; note: string; area: string }) => void;
  onAlign: (id: number, alignment: Alignment | '') => void;
  onDelete: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [area, setArea] = useState('');
  useEffect(() => { setEditing(false); setPicking(false); setAdopting(false); }, [selected?.id]);

  if (!selected) {
    return (
      <div className="psky-sel">
        <div className="psky-sel-empty">Pick something — click any idea in the sky and it lands here for a verdict, a size or a promotion.</div>
      </div>
    );
  }
  const f = selected;
  const v = f.alignment || '';
  const children = galaxy.childrenOf(f);
  // Only a star or a planet can be orbited, and an idea carrying moons of its
  // own can only go to a star — the same two rules the route enforces, so the
  // picker never offers a move the server would refuse.
  const adoptTargets = galaxy.all.filter((t) => {
    if (t.id === f.id || t.parentId === f.id) return false;
    const tk = galaxy.kindOf(t);
    if (tk === 'star') return true;
    return tk === 'planet' && children.length === 0;
  });

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
          <button className="psky-pill" style={{ ['--vc']: GX_TONE[v] } as CSSProperties}
            onClick={() => setPicking(true)}
            title={v ? 'Change the verdict (pick the same to clear)' : 'Judge this against the north star'}>
            {v ? alignLabel(v) : '✦ judge'}
          </button>
        )}
        <span className="theme">{themeLabel}</span>
        {f.source === 'hook' && <span className="auto-badge">✦ auto</span>}
        <span className="when">{f.when}</span>
      </div>
      {kind && <div className="psky-sel-kind">{GX_GLYPH[kind]} {KIND_LABEL[kind]}</div>}
      <div className="psky-sel-title">{f.title}</div>
      {f.note && <div className="psky-sel-note">{f.note}</div>}

      {/* Magnitude: how much work, and therefore how big it draws. Clicking the
          lit pip again clears it back to unsized — an estimate you no longer
          stand behind should be removable, not merely changeable. */}
      <div className="psky-mag">
        <span className="lbl">MAG {f.magnitude ? `${f.magnitude}/5` : '—'}</span>
        <span className="pips">
          {[1, 2, 3, 4, 5].map((i) => (
            <button key={i} className={`pip${f.magnitude && i <= f.magnitude ? ' on' : ''}`}
              title={`${i}/5 — ${MAG_WORD[i]}`} aria-label={`Magnitude ${i} of 5 — ${MAG_WORD[i]}`}
              onClick={() => onShape(f.id, { magnitude: f.magnitude === i ? null : i })} />
          ))}
        </span>
        <span className="word">{f.magnitude ? MAG_WORD[f.magnitude] : 'not sized yet'}</span>
      </div>

      {/* What orbits it — and the way in to the pieces without hunting the sky. */}
      {(kind === 'star' || kind === 'planet') && (
        <div className="psky-kids">
          <div className="lbl">{kind === 'star' ? 'PLANETS IN ITS ORBIT' : 'MOONS'}</div>
          {children.map((c) => (
            <button key={c.id} className="row" onClick={() => onSelect(c.id)}
              style={{ ['--vc']: GX_TONE[c.alignment || ''] } as CSSProperties}>
              <span className="dot" />
              <span className="t">{c.title}</span>
              <span className="m">{c.magnitude ? `mag ${c.magnitude}` : '—'}</span>
            </button>
          ))}
          {children.length === 0 && (
            <div className="empty">Nothing orbits it yet — adopt an idea from the north star or the belt.</div>
          )}
        </div>
      )}

      <div className="psky-sel-actions">
        {kind === 'star' ? (
          <button className="act" onClick={() => onShape(f.id, { isStar: false })}
            title="Back to a plain idea. Nothing loose can hold planets, so its planets return to the north star's shells.">
            ☆ Dissolve the star
          </button>
        ) : (
          <button className="act star" onClick={() => onShape(f.id, { isStar: true })}
            title={kind === 'planet'
              ? 'Its own orbit. Its moons come with it and become planets.'
              : 'Give it an orbit of its own — other ideas can then be adopted into it.'}>
            ★ Promote to its own star
          </button>
        )}
        {adopting ? (
          <select className="psky-adopt" autoFocus defaultValue=""
            aria-label="Adopt this idea into an orbit"
            onChange={(e) => { setAdopting(false); onShape(f.id, { parentId: e.target.value ? Number(e.target.value) : null }); }}
            onBlur={() => setAdopting(false)}>
            <option value="" disabled>orbit around…</option>
            {f.parentId != null && <option value="">— cut it loose —</option>}
            {adoptTargets.map((t) => (
              <option key={t.id} value={t.id}>
                {galaxy.kindOf(t) === 'star' ? '★' : '●'} {t.title}
              </option>
            ))}
          </select>
        ) : (kind !== 'star' && (adoptTargets.length > 0 || f.parentId != null)) && (
          <button className="act" onClick={() => setAdopting(true)}
            title="Put it in orbit around a star or a planet">⊙ Orbit…</button>
        )}
        <button className="act primary" onClick={() => onPromote(f)}>→ Roadmap</button>
        {onToggleTray && (
          <button className={`act ${inTray ? 'in-tray' : ''}`} onClick={onToggleTray}
            title={inTray
              ? (orbitExtra > 0 ? 'In the tray, with its orbit — untick to pull both back out' : 'In the tray')
              : (orbitExtra > 0
                ? `The converge tray — its orbit comes with it (${orbitExtra} more idea${orbitExtra === 1 ? '' : 's'})`
                : 'The converge tray — pick ideas across the sky, then converge the set into tickets')}>
            {inTray ? '✓ In tray' : orbitExtra > 0 ? `⊕ Converge +${orbitExtra}` : '⊕ Converge'}
          </button>
        )}
        <button className="act" onClick={() => { setTitle(f.title); setNote(f.note); setArea(f.area); setEditing(true); }}>✎ Edit</button>
        <button className="act quiet" onClick={() => onDelete(f.id)}>Dismiss</button>
      </div>
    </div>
  );
}
