import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  WorkbenchCard, WorkbenchData, WorkbenchOp, WorkbenchPhase,
} from '../types';
import {
  getWorkbench, addWorkbenchCard, patchWorkbenchCard, deleteWorkbenchCard,
  linkWorkbenchCards, cutWorkbenchEdge, runWorkbenchOp,
} from '../store';

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

const Z_MIN = 0.4;
const Z_MAX = 2;
const GRID = 26;

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

export function Workbench({
  slug, geminiReady, highlightId, notesNonce, onPromoteNote, onPromotePlan,
}: {
  slug: string;
  geminiReady: boolean;
  highlightId?: string | null;      // a NOTE id from a ⌘K deep-link
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
  const [hotEdge, setHotEdge] = useState<number | null>(null);
  const [linking, setLinking] = useState<number | null>(null);
  const [busyOp, setBusyOp] = useState<WorkbenchOp | null>(null);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [lastGen, setLastGen] = useState<number | null>(null);

  const groundRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef(pan); panRef.current = pan;
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  // Measured card heights, keyed by card id. Edges attach to a card's middle and
  // op output stacks under the last one, and both need the height the browser
  // actually gave a card — not one we guessed from its content.
  const nodeRef = useRef<Record<number, HTMLDivElement | null>>({});
  const [heights, setHeights] = useState<Record<number, number>>({});

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
      .then((d) => { setData(d); setError(''); })
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
      if (linking !== null) setLinking(null);
      else if (asking) { setAsking(false); setQuestion(''); }
      else setSel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [linking, asking]);

  // ---- pan + zoom ----
  // Native wheel listener with passive:false, so the page never scrolls out
  // from under the canvas mid-zoom.
  useEffect(() => {
    const el = groundRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
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
  }, []);

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
  const startDrag = (e: React.PointerEvent, card: WorkbenchCard) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (linking !== null && linking !== card.id) { void wire(linking, card.id); return; }
    setSel(card.id);
    const x0 = e.clientX, y0 = e.clientY;
    const c0 = { x: card.x, y: card.y };
    // The final position is tracked here rather than read back out of state on
    // release: a state updater that also fires a request runs twice under
    // StrictMode, and that would be two PATCHes for one drag.
    const at = { ...c0 };
    let moved = false;
    const move = (ev: PointerEvent) => {
      const z = zoomRef.current;
      const nx = Math.round(c0.x + (ev.clientX - x0) / z);
      const ny = Math.round(c0.y + (ev.clientY - y0) / z);
      if (!moved && Math.abs(nx - c0.x) < 2 && Math.abs(ny - c0.y) < 2) return;
      moved = true;
      at.x = nx; at.y = ny;
      setData((d) => (d ? { ...d, cards: d.cards.map((c) => (c.id === card.id ? { ...c, x: nx, y: ny } : c)) } : d));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) return;
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

  const addNote = () => guard(async () => {
    const at = centreOfView();
    const text = 'New note';
    const card = await addWorkbenchCard(slug, { kind: 'note', text, x: at.x, y: at.y });
    setData((d) => (d ? { ...d, cards: [...d.cards, card] } : d));
    setSel(card.id);
    say('Added a note. Click its text to write it.');
  });

  const pullIdea = (futureId: number) => guard(async () => {
    const at = centreOfView();
    const card = await addWorkbenchCard(slug, { kind: 'polaris', futureId, x: at.x, y: at.y });
    setData((d) => (d ? {
      ...d, cards: [...d.cards, card], tray: d.tray.filter((t) => t.id !== futureId),
    } : d));
    setSel(card.id);
    say(`Pulled ${card.meta} in from Polaris.`);
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
    setData((d) => (d ? {
      ...d,
      cards: d.cards.filter((c) => !gone.has(c.id)),
      edges: d.edges.filter((e) => !gone.has(e.a) && !gone.has(e.b)),
      tray: res.returnedToTray
        ? [{ id: res.returnedToTray, title: card.title, meta: card.meta }, ...d.tray]
        : d.tray,
    } : d));
    if (sel != null && gone.has(sel)) setSel(null);
    say(card.kind === 'polaris'
      ? `Put ${card.meta} back in the tray. The idea is untouched.`
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
        const { card: made, edge } = await runWorkbenchOp(slug, { op, cardId: card.id, ...at, question: q || undefined });
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

  // ---- a ⌘K deep-link lands on a NOTE id; find the card wrapping it ----
  const centred = useRef<string | null>(null);
  useEffect(() => {
    if (!data || !highlightId || centred.current === highlightId) return;
    const card = data.cards.find((c) => String(c.noteId) === highlightId);
    if (!card) return;
    centred.current = highlightId;
    setSel(card.id);
    const el = groundRef.current;
    setZoom(1);
    setPan({
      x: (el?.clientWidth ?? 900) / 2 - card.x - card.w / 2,
      y: (el?.clientHeight ?? 600) / 2 - card.y - 60,
    });
  }, [data, highlightId]);

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
        id: e.id, d, ai: e.ai,
        mx: Math.round((a.x + a.w / 2 + b.x + b.w / 2) / 2),
        my: Math.round((ay + by) / 2),
      };
    }).filter(Boolean) as { id: number; d: string; ai: boolean; mx: number; my: number }[];
  }, [data, hOf]);

  if (loading && !data) {
    return <div className="empty-state"><div className="big">Loading the workbench…</div></div>;
  }

  const cards = data?.cards ?? [];
  const selCard = cards.find((c) => c.id === sel) || null;
  const ops = data?.ops ?? [];

  return (
    <div className="wb">
      <div className="section-bar" style={{ marginBottom: 6 }}>
        <div className="titles">
          <div className="h">Workbench</div>
          <div className="subtitle">Notes, Polaris ideas and the ✧ ops that turn them into a plan</div>
        </div>
        <div className="wb-hint">drag ↔ move · wheel ↔ zoom · hover a line ↔ ✂ cut · plan text is editable</div>
      </div>

      {error && <div className="action-error">{error}</div>}

      <div className="wb-body">
        <div
          ref={groundRef}
          className={`wb-ground${linking !== null ? ' linking' : ''}`}
          onPointerDown={startPan}
          style={{
            backgroundSize: `${GRID * zoom}px ${GRID * zoom}px`,
            backgroundPosition: `${pan.x % (GRID * zoom)}px ${pan.y % (GRID * zoom)}px`,
          }}
        >
          <div className="wb-field" style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})` }}>
            <svg className="wb-wires" width="2400" height="1800">
              {paths.map((p) => (
                <path key={`w${p.id}`} d={p.d} fill="none"
                  className={`wb-wire${p.ai ? ' ai' : ''}${hotEdge === p.id ? ' hot' : ''}`} />
              ))}
              {paths.map((p) => (
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

            {cards.map((c) => (
              <CardView
                key={c.id} card={c}
                selected={c.id === sel}
                linkingFrom={linking === c.id}
                highlighted={highlightId != null && String(c.noteId) === highlightId}
                nodeRef={(el) => { if (el) nodeRef.current[c.id] = el; else delete nodeRef.current[c.id]; }}
                onDown={(e) => startDrag(e, c)}
                onTitle={(t) => saveTitle(c, t)}
                onBody={(b) => saveBody(c, b)}
                onShip={() => void shipPlan(c)}
              />
            ))}
          </div>

          {/* Both overlays sit inside the ground, so their presses have to be
              stopped or every click on them would start a pan. */}
          <div className="wb-zoom" onPointerDown={(e) => e.stopPropagation()}>
            <button onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
            <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>{Math.round(zoom * 100)}%</button>
            <button onClick={() => zoomBy(1.2)} aria-label="Zoom in">+</button>
          </div>

          <div className="wb-tray" onPointerDown={(e) => e.stopPropagation()}>
            <div className="head">
              <span className="dot" />
              <span className="k">from Polaris · unpicked</span>
              <button className="chip-sm add" onClick={addNote}>+ note</button>
            </div>
            {data && data.tray.length > 0 ? (
              <div className="chips">
                {data.tray.slice(0, 8).map((t) => (
                  <button key={t.id} className="chip-sm add" onClick={() => pullIdea(t.id)}
                    title={t.title}>{t.meta} · {t.title.slice(0, 46)}</button>
                ))}
                {data.tray.length > 8 && (
                  <span className="none">+{data.tray.length - 8} more on the Polaris tab</span>
                )}
              </div>
            ) : (
              // "None left" and "none to begin with" are different things to be
              // told, and only one of them is an achievement.
              <div className="none">
                {cards.some((c) => c.kind === 'polaris')
                  ? 'Every idea is on the canvas.'
                  : 'No Polaris ideas yet — capture them on the Polaris tab.'}
              </div>
            )}
          </div>

          {!loading && cards.length === 0 && (
            <div className="wb-empty">
              <div className="big">An empty bench</div>
              <div>Jot a note or pull an idea across from Polaris, then select it and run an ✧ op.</div>
            </div>
          )}
        </div>

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
                    {selCard.kind === 'polaris' ? '↩ to tray' : '× remove'}
                  </button>
                </div>
              )}
              {linking !== null && <div className="linking-hint">Click another card to wire them. Esc or the ground cancels.</div>}
            </div>

            {/* Keyless, the ops are ABSENT rather than disabled — the same rule
                every other ✧ surface follows. */}
            {geminiReady && (
              <div className="wb-ops">
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

const kindLine = (c: WorkbenchCard) =>
  c.kind === 'polaris' ? `Polaris idea · ${c.meta}`
    : c.kind === 'note' ? `Scratch note · ${c.meta}`
      : `✧ ${OP_LABEL[c.op as WorkbenchOp] || 'AI'} output · a suggestion, not a decision`;

// One card. Note and Polaris cards read their title through from the row they
// wrap, so editing here writes to the note or the idea, never to a copy.
function CardView({
  card, selected, linkingFrom, highlighted, nodeRef, onDown, onTitle, onBody, onShip,
}: {
  card: WorkbenchCard;
  selected: boolean;
  linkingFrom: boolean;
  highlighted: boolean;
  nodeRef: (el: HTMLDivElement | null) => void;
  onDown: (e: React.PointerEvent) => void;
  onTitle: (t: string) => void;
  onBody: (b: WorkbenchCard['body']) => void;
  onShip: () => void;
}) {
  const body = card.body;
  const lines = body.lines || [];
  const phases = body.phases || [];
  const chips = body.chips || [];
  const stop = (e: React.PointerEvent) => e.stopPropagation();

  const setPhase = (i: number, patch: Partial<WorkbenchPhase>) =>
    onBody({ ...body, phases: phases.map((p, j) => (j === i ? { ...p, ...patch } : p)) });

  return (
    <div
      ref={nodeRef}
      className={`wb-card ${card.kind}${selected ? ' on' : ''}${linkingFrom ? ' linking' : ''}${highlighted ? ' hl' : ''}`}
      onPointerDown={onDown}
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
