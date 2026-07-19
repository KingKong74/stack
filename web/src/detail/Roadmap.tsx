import { useEffect, useState } from 'react';
import type { Roadmap as RoadmapData, RoadmapItem, Priority, AutopilotRun } from '../types';
import { PRIORITY_META, timeAgo, dayLabel } from '../lib/ui';
import { getAutopilotRuns, getReviewBrief, queueUndo, ReviewBrief } from '../store';
import { Modal } from '../components/Modal';

export type ReviewTag = 'solid' | 'needs-work' | 'rethink';
export const REVIEW_TAGS: { key: ReviewTag; label: string }[] = [
  { key: 'solid', label: 'Solid' },
  { key: 'needs-work', label: 'Needs more work' },
  { key: 'rethink', label: 'Rethink' },
];
const tagLabel = (tag: string) => REVIEW_TAGS.find((t) => t.key === tag)?.label || tag;

// MoSCoW roadmap. Open items live in their bucket columns (with lane-claim
// chips and edit/delete on hover); completed items move to the collapsed
// Archive below — still counted by the progress model, reviewable with a
// verdict tag (needs-work/rethink offer a follow-up item), restorable by
// un-ticking.
export function Roadmap({
  roadmap, onAdd, onToggle, onEdit, onDelete, onReviewTag, onRefine, onToggleSkip, onReorder, onCleanup, onSendToTerminal, slug, highlightId,
  draft, onResumeDraft, onDiscardDraft, liveBranches,
}: {
  roadmap: RoadmapData;
  liveBranches?: string[];
  onAdd: (p: Priority, area?: string) => void;
  onToggle: (item: RoadmapItem) => void;
  onEdit: (item: RoadmapItem) => void;
  onDelete: (item: RoadmapItem) => void;
  onReviewTag: (item: RoadmapItem, tag: ReviewTag) => void;
  onRefine: (item: RoadmapItem) => void;
  onToggleSkip: (item: RoadmapItem) => void;
  onReorder?: (item: RoadmapItem, toBucket: Priority, beforeId: number | null) => void;
  onCleanup?: () => void;
  onSendToTerminal?: (brief: string) => void;
  slug?: string;
  highlightId?: string | null;
  draft?: { title: string } | null;
  onResumeDraft?: () => void;
  onDiscardDraft?: () => void;
}) {
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  // Drag-reorder: which item is in flight, and what it's hovering over
  // (an item id = drop before it; `col-<bucket>` = drop at the bucket's end).
  const [dragId, setDragId] = useState<number | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const allById = new Map(PRIORITY_META.flatMap((c) => roadmap[c.key]).map((i) => [i.id, i]));
  const handleDrop = (toBucket: Priority, beforeId: number | null) => {
    const dragged = dragId != null ? allById.get(dragId) : null;
    setDragId(null);
    setOverKey(null);
    if (dragged && onReorder && dragged.id !== beforeId) onReorder(dragged, toBucket, beforeId);
  };
  // Area filter — the product-area chips over the board (mirrors the Futures funnel).
  const [areaFilter, setAreaFilter] = useState('');
  const openAll = PRIORITY_META.flatMap((col) => roadmap[col.key].filter((it) => !it.done));
  // Hand-added areas live device-local until an item actually carries them —
  // the + chip mints one, and + Add under its tab pre-tags new items with it.
  const areasKey = slug ? `stack.areas.${slug}` : '';
  const [customAreas, setCustomAreas] = useState<string[]>(() => {
    if (!areasKey) return [];
    try { return (JSON.parse(localStorage.getItem(areasKey) || '[]') as string[]).filter(Boolean); }
    catch { return []; }
  });
  const [addingArea, setAddingArea] = useState(false);
  const [areaDraft, setAreaDraft] = useState('');
  const itemAreas = new Set(openAll.map((it) => it.area).filter(Boolean));
  const boardAreas = [...new Set([...itemAreas, ...customAreas])].sort();
  // Send-to-terminal: pick open items (area chips in the modal scope the list
  // — several tabs can feed one brief (#133) — a priority filter narrows it,
  // rows tick on/off), compose a work brief and hand it to the terminal screen
  // — it lands as a paste, never auto-runs.
  const [termPick, setTermPick] = useState<Set<number> | null>(null);
  const [termPrio, setTermPrio] = useState<'all' | Priority>('all');
  const [termAreas, setTermAreas] = useState<Set<string>>(new Set()); // empty = every area
  const workable = (it: RoadmapItem) => !it.skipped && !it.claimedBy;
  const termScope = openAll.filter((it) => termAreas.size === 0 || (!!it.area && termAreas.has(it.area)));
  const termCandidates = termScope.filter((it) => termPrio === 'all' || it.bucket === termPrio);
  const openTermPick = () => {
    setTermPrio('all');
    // Start from the active area tab; more areas can be ticked in the modal.
    const areas = new Set(areaFilter ? [areaFilter] : []);
    setTermAreas(areas);
    const scope = openAll.filter((it) => areas.size === 0 || (!!it.area && areas.has(it.area)));
    // Default selection: workable items — parked and already-claimed ones start unticked.
    setTermPick(new Set(scope.filter(workable).map((it) => it.id)));
  };
  const toggleTermArea = (a: string) => {
    const next = new Set(termAreas);
    const on = !next.has(a);
    if (on) next.add(a); else next.delete(a);
    setTermAreas(next);
    // Ticks follow the area: adding one ticks its workable items, dropping one unticks them all.
    setTermPick((p) => {
      const pick = new Set(p);
      const areaItems = openAll.filter((it) => it.area === a);
      if (on) areaItems.filter(workable).forEach((it) => pick.add(it.id));
      else areaItems.forEach((it) => pick.delete(it.id));
      return pick;
    });
  };
  const allTermAreas = () => {
    setTermAreas(new Set());
    setTermPick(new Set(openAll.filter(workable).map((it) => it.id)));
  };
  const composeBrief = () => {
    const chosen = termCandidates.filter((it) => termPick?.has(it.id));
    const lines = chosen.map((it, i) =>
      `${i + 1}. [${it.bucket}] #${it.id} — ${it.title}${it.note ? `\n   ${it.note.replace(/\n/g, '\n   ')}` : ''}`);
    return `Work these Stack roadmap items${termAreas.size ? ` (areas: ${[...termAreas].sort().join(', ')})` : ''}, top-down:\n\n${lines.join('\n')}\n\nProtocol: claim each item's lane before starting, work one item at a time, commit each unit, and when an item is finished set built_note (what landed) alongside done:true through the Stack API. Leave items claimed by other lanes alone.`;
  };

  const commitNewArea = () => {
    const a = areaDraft.trim().toLowerCase().slice(0, 40);
    setAddingArea(false);
    setAreaDraft('');
    if (!a) return;
    if (!itemAreas.has(a) && !customAreas.includes(a)) {
      const next = [...customAreas, a];
      setCustomAreas(next);
      if (areasKey) { try { localStorage.setItem(areasKey, JSON.stringify(next)); } catch { /* full — fine */ } }
    }
    setAreaFilter(a);
  };
  // Done items split into the pipeline: To verify (no verdict yet — test it,
  // verdict it, or send it back) → Archive (verdict given). Latest first.
  const ts = (it: RoadmapItem) => (it.updatedAt ? Date.parse(it.updatedAt) : 0);
  const doneItems = PRIORITY_META.flatMap((col) => roadmap[col.key].filter((it) => it.done));
  const toVerify = doneItems.filter((it) => !it.reviewTag).sort((a, b) => ts(b) - ts(a));
  const archived = doneItems.filter((it) => it.reviewTag).sort((a, b) => ts(b) - ts(a));
  // The tab's two views: the open board, and Reviews (to-verify + archive).
  // A deep-link to a done item opens straight on Reviews.
  const [view, setView] = useState<'board' | 'reviews'>(
    () => (doneItems.some((it) => String(it.id) === highlightId) ? 'reviews' : 'board'));
  // Open the archive straight away when a deep-link targets an archived item.
  const [archiveOpen, setArchiveOpen] = useState(
    () => archived.some((it) => String(it.id) === highlightId));
  // The run ledger labels auto-built rows — branch, commits, tokens, cost —
  // so a verdict is made against what the session reported (#132). Fetched
  // once when the Reviews view first opens; silently absent on any failure.
  const [runs, setRuns] = useState<AutopilotRun[] | null>(null);
  useEffect(() => {
    if (view !== 'reviews' || runs !== null || !slug) return;
    let stale = false;
    getAutopilotRuns(slug)
      .then((r) => { if (!stale) setRuns(r); })
      .catch(() => { if (!stale) setRuns([]); });
    return () => { stale = true; };
  }, [view, runs, slug]);
  const runByItem = new Map<string, AutopilotRun>();
  for (const r of runs ?? []) {
    // Newest first — the first landed run per item is the one that built it.
    if (r.itemId != null && r.outcome === 'landed' && !runByItem.has(String(r.itemId))) {
      runByItem.set(String(r.itemId), r);
    }
  }
  // Who completed it (#117): the autopilot (auto/* claim or a landed run), a
  // named lane, or by hand. Claims are cleared on tick, so the run ledger is
  // what keeps merged autopilot items reading as auto.
  const originOf = (it: RoadmapItem): 'auto' | 'lane' | 'manual' =>
    it.claimedBy.startsWith('auto/') || runByItem.has(String(it.id)) ? 'auto'
      : it.claimedBy ? 'lane' : 'manual';
  const ORIGIN_LABEL = { auto: '⚙ autopilot', lane: '⚑ lane', manual: 'by hand' } as const;
  const [originFilter, setOriginFilter] = useState<'all' | 'auto' | 'lane' | 'manual'>('all');
  const byOrigin = (it: RoadmapItem) => originFilter === 'all' || originOf(it) === originFilter;
  const fmtTok = (n: number) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M tok` : n >= 1000 ? `${Math.round(n / 1000)}k tok` : `${n} tok`;
  // Completion metadata under a review row: origin, when, and the run stats.
  const reviewMeta = (it: RoadmapItem) => {
    const run = runByItem.get(String(it.id));
    const o = originOf(it);
    return (
      <div className="review-meta">
        <span className={`origin-chip ${o}`}>{o === 'lane' ? `⚑ ${it.claimedBy}` : ORIGIN_LABEL[o]}</span>
        {it.updatedAt && <span className="review-when">done {timeAgo(it.updatedAt)}</span>}
        {run && (
          <span className="run-chip" title={run.summary ? run.summary.slice(0, 600) : undefined}>
            {run.branch} · {run.commits} commit{run.commits === 1 ? '' : 's'} · {fmtTok(run.tokens)}
            {run.costUsd ? ` · $${run.costUsd.toFixed(2)}` : ''}
          </span>
        )}
        {run && run.checksFailing ? <span className="run-warn">{run.checksFailing} check{run.checksFailing === 1 ? '' : 's'} failing</span> : null}
      </div>
    );
  };
  // ✧ Reviewer's briefs (#134): Gemini's read on a completed item — what
  // shipped, how to test it, likely risks. In-memory annotation per row;
  // click toggles, nothing is stored.
  const [briefs, setBriefs] = useState<Map<number, { loading?: boolean; error?: string; data?: ReviewBrief }>>(new Map());
  const setBrief = (id: number, v: { loading?: boolean; error?: string; data?: ReviewBrief } | null) =>
    setBriefs((m) => { const next = new Map(m); if (v) next.set(id, v); else next.delete(id); return next; });
  const toggleBrief = (it: RoadmapItem) => {
    if (!slug) return;
    if (briefs.has(it.id)) { setBrief(it.id, null); return; }
    setBrief(it.id, { loading: true });
    getReviewBrief(slug, it.id)
      .then((data) => setBrief(it.id, { data }))
      .catch((e) => setBrief(it.id, { error: e instanceof Error ? e.message : 'Gemini call failed.' }));
  };
  const briefPanel = (it: RoadmapItem) => {
    const b = briefs.get(it.id);
    if (!b) return null;
    return (
      <div className="review-brief">
        {b.loading && <div className="rb-loading">✧ Reading the item, its run and the checks…</div>}
        {b.error && <div className="rb-err">{b.error}</div>}
        {b.data && (<>
          <div className="rb-summary">{b.data.summary}</div>
          {b.data.test.length > 0 && (
            <div className="rb-block">
              <div className="rb-lbl">Test it</div>
              <ol>{b.data.test.map((s, i) => <li key={i}>{s}</li>)}</ol>
            </div>
          )}
          {b.data.risks.length > 0 && (
            <div className="rb-block">
              <div className="rb-lbl">Likely risks</div>
              <ul>{b.data.risks.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          )}
          <div className="rb-foot">✧ Gemini's read — verify before trusting it.</div>
        </>)}
      </div>
    );
  };
  // ⎌ Undo (#128): confirm, then queue a revert job — the host dispatcher
  // reverts the item's #N-tagged main commits and un-ticks it. The note under
  // the row is the only feedback needed; the item reappears on the board when
  // the revert lands.
  const [undoConfirm, setUndoConfirm] = useState<RoadmapItem | null>(null);
  const [undoNotes, setUndoNotes] = useState<Map<number, string>>(new Map());
  const setUndoNote = (id: number, msg: string) =>
    setUndoNotes((m) => new Map(m).set(id, msg));
  const confirmUndo = (it: RoadmapItem) => {
    setUndoConfirm(null);
    if (!slug) return;
    setUndoNote(it.id, 'Queuing the revert…');
    queueUndo(slug, it.id)
      .then(() => setUndoNote(it.id, `Undo queued — the host reverts every main commit tagged #${it.id} and returns the item to the board within a minute or two.`))
      .catch((e) => setUndoNote(it.id, e instanceof Error ? e.message : 'Undo failed.'));
  };
  // Archive rendering: the MoSCoW grid, or a dense paginated list + verdict filter.
  const [archView, setArchView] = useState<'grid' | 'list'>('grid');
  const [archFilter, setArchFilter] = useState<'all' | ReviewTag>('all');
  const [archPage, setArchPage] = useState(0);
  const filtered = archived.filter((it) => (archFilter === 'all' || it.reviewTag === archFilter) && byOrigin(it));
  const ARCH_PAGE_SIZE = 12;
  const archPages = Math.max(1, Math.ceil(filtered.length / ARCH_PAGE_SIZE));
  const archSlice = filtered.slice(archPage * ARCH_PAGE_SIZE, (archPage + 1) * ARCH_PAGE_SIZE);

  // Verdict controls, shared by both archive views and the verify strip.
  // Solid is the only pickable verdict now (#141) — dissatisfaction goes
  // through ✎ Refine, which reworks the item and sends it back to the board.
  // Legacy rethink/needs-work verdicts still render; clicking one reopens the
  // Solid option (or Refine).
  const VISIBLE_TAGS = REVIEW_TAGS.filter((t) => t.key === 'solid');
  const verdictButtons = (it: RoadmapItem) => VISIBLE_TAGS.map((t) => (
    <button key={t.key} className={`review-pick-opt ${t.key}`}
      onClick={() => { setPickerFor(null); onReviewTag(it, t.key); }}>
      {t.label}
    </button>
  ));
  const archActions = (it: RoadmapItem) => (
    <div className="road-actions arch">
      {it.reviewTag && pickerFor !== it.id ? (
        <button className={`review-verdict ${it.reviewTag}`} onClick={() => setPickerFor(it.id)}
          title="Change the verdict">{tagLabel(it.reviewTag)}</button>
      ) : (
        verdictButtons(it)
      )}
      <button className="review-pick-opt refine" onClick={() => onRefine(it)}
        title="Not right yet — rework the item (title, note, plan, bucket) and send it back to the board">
        ✎ Refine
      </button>
      <button onClick={() => onDelete(it)} aria-label="Delete item" title="Delete">×</button>
    </div>
  );

  return (
    <div>
      <div className="section-bar" style={{ marginBottom: 6 }}>
        <div className="titles">
          <div className="h">Roadmap</div>
          <div className="subtitle">MoSCoW prioritisation</div>
        </div>
        <div className="bar-actions">
          {onSendToTerminal && view === 'board' && (
            <button className="gemini-btn sm" onClick={openTermPick}
              title="Compose a work brief from open items (the active area tab scopes it) and paste it into a terminal session">
              ⌨ To terminal
            </button>
          )}
          {onCleanup && view === 'board' && (
            <button className="gemini-btn sm" onClick={onCleanup}
              title="Gemini reviews the open board — missing areas, sloppy titles, wrong buckets — and suggests fixes for you to apply">
              ✧ Clean up
            </button>
          )}
          {draft && (
            <>
              <button className="draft-chip" onClick={onResumeDraft} title="Resume the unfinished item">
                ✎ Draft · {draft.title.trim() || 'untitled'}
              </button>
              <button className="draft-x" onClick={onDiscardDraft} aria-label="Discard draft" title="Discard draft">×</button>
            </>
          )}
        </div>
      </div>
      {/* The view switch sits above the content, on the left (#129) — the first
          thing the eye lands on, at full seg-control size. */}
      <div className="road-view-switch">
        <div className="seg-control" role="tablist" aria-label="Roadmap view">
          <button role="tab" aria-selected={view === 'board'}
            className={`seg-opt ${view === 'board' ? 'on' : ''}`} onClick={() => setView('board')}>Board</button>
          <button role="tab" aria-selected={view === 'reviews'}
            className={`seg-opt ${view === 'reviews' ? 'on' : ''}`} onClick={() => setView('reviews')}>
            Reviews{toVerify.length > 0 ? ` · ${toVerify.length}` : ''}
          </button>
        </div>
      </div>
      {view === 'board' && (<>
      <div className="subtitle" style={{ marginBottom: 20 }}>
        What must ship, what should, what could, and what won't — this round. Tick items off as you go;
        the dashboard progress is computed from Must/Should completion. Drag to reorder — the
        autopilot works its bucket top-down.
      </div>

      {(boardAreas.length > 0 || openAll.length > 0) && (
        <div className="chips" style={{ marginBottom: 18 }}>
          <button className={`chip-sm ${areaFilter === '' ? 'on' : ''}`} onClick={() => setAreaFilter('')}>
            All {openAll.length}
          </button>
          {boardAreas.map((a) => (
            <button key={a} className={`chip-sm ${areaFilter === a ? 'on' : ''}`}
              onClick={() => setAreaFilter(areaFilter === a ? '' : a)}>
              {a} {openAll.filter((it) => it.area === a).length}
            </button>
          ))}
          {addingArea ? (
            <input className="chip-input" autoFocus value={areaDraft} placeholder="new area…"
              onChange={(e) => setAreaDraft(e.target.value)}
              onBlur={commitNewArea}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitNewArea();
                if (e.key === 'Escape') { setAddingArea(false); setAreaDraft(''); }
              }} />
          ) : (
            <button className="chip-sm add" onClick={() => setAddingArea(true)}
              title="Add a project area — new items added under its tab get tagged with it">
              + area
            </button>
          )}
        </div>
      )}

      <div className="road-grid">
        {PRIORITY_META.map((col) => {
          const open = roadmap[col.key].filter((it) => !it.done && (!areaFilter || it.area === areaFilter));
          // Parked items sink to the bottom of their bucket.
          const items = [...open.filter((it) => !it.skipped), ...open.filter((it) => it.skipped)];
          return (
            <div className="road-col" key={col.key}>
              <div className="road-col-head">
                <span className="dot" style={{ background: col.color }} />
                <span className="name">{col.label}</span>
                <span className="count">{items.length}</span>
              </div>
              <div
                className={`road-items ${overKey === `col-${col.key}` ? 'drop-into' : ''}`}
                onDragOver={(e) => { if (dragId != null) { e.preventDefault(); setOverKey(`col-${col.key}`); } }}
                onDragLeave={() => setOverKey((k) => (k === `col-${col.key}` ? null : k))}
                onDrop={(e) => { e.preventDefault(); handleDrop(col.key, null); }}
              >
                {/* An active area chip pre-tags whatever gets added under it. */}
                <button className="road-add" onClick={() => onAdd(col.key, areaFilter || undefined)}>+ Add</button>
                {items.map((it) => {
                  // A claim only reads as "in progress" while a LIVE session is
                  // on that lane (BUG-2: a half-run or killed session must not
                  // leave items dimmed and read-only). Live claim: the card
                  // dims, wears the amber tag and goes read-only (edits would
                  // race the worker). Stale claim: the ⚑ chip stays — it is
                  // still the autopilot's don't-re-pick marker — but the item
                  // is fully editable. Ticking done stays live either way.
                  const working = Boolean(it.claimedBy) && (liveBranches ?? []).includes(it.claimedBy);
                  return (
                  <div
                    className={`road-item ${working ? 'working' : ''} ${it.skipped ? 'skipped' : ''} ${highlightId === String(it.id) ? 'hl' : ''} ${dragId === it.id ? 'drag' : ''} ${overKey === String(it.id) ? 'drop-before' : ''}`}
                    key={it.id} data-hl={it.id}
                    draggable={!!onReorder && !working}
                    onDragStart={(e) => { if (working) return; setDragId(it.id); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragEnd={() => { setDragId(null); setOverKey(null); }}
                    onDragOver={(e) => {
                      if (dragId != null && dragId !== it.id) { e.preventDefault(); e.stopPropagation(); setOverKey(String(it.id)); }
                    }}
                    onDragLeave={() => setOverKey((k) => (k === String(it.id) ? null : k))}
                    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleDrop(col.key, it.id); }}
                  >
                    <button
                      className="road-check"
                      onClick={() => onToggle(it)}
                      aria-label="Mark done" title="Mark done — moves to the archive"
                    />
                    <div className="road-body">
                      <div className="t">
                        {it.title}
                        {it.source === 'hook' && <span className="auto-cue" title="Auto-extracted from a push">auto</span>}
                        {it.area && <span className="area-chip" title="Product area — edit the item to change it">{it.area}</span>}
                        {working && <span className="work-chip" title={`Claimed by ${it.claimedBy} — read-only while the work is in flight`}>● in progress</span>}
                        {it.skipped && <span className="skip-chip" title="Parked — not to be picked up yet">⏸ parked</span>}
                        {it.plan.length > 0 && (
                          <span className="plan-chip"
                            title={`Implementation plan — ${it.plan.filter((s) => s.done).length} of ${it.plan.length} steps done:\n${it.plan.map((s) => `${s.done ? '☑' : '☐'} ${s.text}`).join('\n')}`}>
                            ☰ {it.plan.filter((s) => s.done).length}/{it.plan.length}
                          </span>
                        )}
                      </div>
                      {it.note && <div className="note">{it.note}</div>}
                      {it.claimedBy && (
                        <div className="claim-chip"
                          title={working
                            ? 'Claimed by this lane'
                            : 'Claimed by this lane — no live session on it; edit the item to clear the claim'}>
                          ⚑ {it.claimedBy}
                        </div>
                      )}
                    </div>
                    <div className="road-actions">
                      {!working && (
                        <>
                          <button onClick={() => onToggleSkip(it)} aria-label={it.skipped ? 'Unpark item' : 'Park item'}
                            title={it.skipped ? 'Unpark — back in play' : 'Park — skip for now'}>{it.skipped ? '▶' : '⏸'}</button>
                          <button onClick={() => onEdit(it)} aria-label="Edit item" title="Edit">✎</button>
                          <button onClick={() => onDelete(it)} aria-label="Delete item" title="Delete">×</button>
                        </>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      </>)}

      {termPick && onSendToTerminal && (
        <Modal onClose={() => setTermPick(null)} wide>
          <h3>⌨ Send to a terminal session</h3>
          <div className="confirm-body" style={{ marginBottom: 12 }}>
            Pick area tabs, then items — the picked items become a work brief, pasted into the
            terminal for you to review and send.
          </div>
          {boardAreas.length > 0 && (
            <div className="chips" style={{ marginBottom: 8 }}>
              <button className={`chip-sm ${termAreas.size === 0 ? 'on' : ''}`} onClick={allTermAreas}>
                All areas {openAll.length}
              </button>
              {boardAreas.map((a) => (
                <button key={a} className={`chip-sm ${termAreas.has(a) ? 'on' : ''}`}
                  onClick={() => toggleTermArea(a)}>
                  {a} {openAll.filter((it) => it.area === a).length}
                </button>
              ))}
            </div>
          )}
          <div className="chips" style={{ marginBottom: 12 }}>
            {(['all', ...PRIORITY_META.map((p) => p.key)] as ('all' | Priority)[]).map((k) => (
              <button key={k} className={`chip-sm ${termPrio === k ? 'on' : ''}`} onClick={() => setTermPrio(k)}>
                {k === 'all' ? `All ${termScope.length}` : `${PRIORITY_META.find((p) => p.key === k)?.label} ${termScope.filter((it) => it.bucket === k).length}`}
              </button>
            ))}
          </div>
          <div className="cleanup-list">
            {termCandidates.map((it) => (
              <label className="cleanup-row" key={it.id}>
                <input type="checkbox" checked={termPick.has(it.id)}
                  onChange={() => setTermPick((p) => {
                    const next = new Set(p);
                    if (next.has(it.id)) next.delete(it.id); else next.add(it.id);
                    return next;
                  })} />
                <span className="cleanup-body">
                  <span className="t">
                    #{it.id} {it.title}
                    {it.claimedBy && <span className="claim-chip inline">⚑ {it.claimedBy}</span>}
                    {it.skipped && <span className="skip-chip">⏸ parked</span>}
                  </span>
                  <span className="why">[{it.bucket}]{it.area ? ` · ${it.area}` : ''}</span>
                </span>
              </label>
            ))}
            {termCandidates.length === 0 && <div className="confirm-body">Nothing open under this filter.</div>}
          </div>
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button className="btn-cancel" onClick={() => setTermPick(null)}>Cancel</button>
            <button className="btn-submit"
              disabled={!termCandidates.some((it) => termPick.has(it.id))}
              onClick={() => { onSendToTerminal(composeBrief()); setTermPick(null); }}>
              Open in terminal →
            </button>
          </div>
        </Modal>
      )}

      {undoConfirm && (
        <Modal onClose={() => setUndoConfirm(null)}>
          <h3>⎌ Undo #{undoConfirm.id}</h3>
          <div className="confirm-body" style={{ marginBottom: 16 }}>
            Reverts every main-branch commit tagged <b>#{undoConfirm.id}</b> — the host dispatcher
            adds a revert commit for each and pushes, usually within a minute or two — then sends
            the item back to the board with its verdict and claim cleared. The original commits
            stay in history; nothing is rewritten.
          </div>
          <div className="modal-actions">
            <button className="btn-cancel" onClick={() => setUndoConfirm(null)}>Cancel</button>
            <button className="btn-submit" onClick={() => confirmUndo(undoConfirm)}>Revert the commits</button>
          </div>
        </Modal>
      )}

      {view === 'reviews' && (<>
      <div className="subtitle" style={{ marginBottom: 14 }}>
        Everything completed, awaiting your verdict — each row shows who built it, when, and what
        landed. Solid closes it out; ✎ Refine reworks the item itself and sends it back to the
        board; ↩ Board sends it back unchanged. Either way it returns fresh — the old verdict and
        lane claim don't come with it.
      </div>

      {/* who-built-it filter (#117) — only when completions come from more than one origin */}
      {(() => {
        const counts = { auto: 0, lane: 0, manual: 0 };
        doneItems.forEach((it) => { counts[originOf(it)]++; });
        const present = (['auto', 'lane', 'manual'] as const).filter((o) => counts[o] > 0);
        if (present.length < 2) return null;
        return (
          <div className="chips" style={{ marginBottom: 16 }}>
            <button className={`chip-sm ${originFilter === 'all' ? 'on' : ''}`} onClick={() => { setOriginFilter('all'); setArchPage(0); }}>
              All {doneItems.length}
            </button>
            {present.map((o) => (
              <button key={o} className={`chip-sm ${originFilter === o ? 'on' : ''}`}
                onClick={() => { setOriginFilter(originFilter === o ? 'all' : o); setArchPage(0); }}>
                {ORIGIN_LABEL[o]} {counts[o]}
              </button>
            ))}
          </div>
        );
      })()}

      {toVerify.length === 0 && archived.length === 0 && (
        <div className="empty-state">
          <div className="big">Nothing to review</div>
          <div>Completed items land here with a note on what was built.</div>
        </div>
      )}

      {/* to verify — completed but unverdicted, clustered by completion day (#132):
          test it, verdict it, or send it back */}
      {toVerify.filter(byOrigin).length > 0 && (
        <div className="verify-strip">
          <div className="verify-head">
            <span className="verify-title">To verify</span>
            <span className="verify-sub">
              {toVerify.filter(byOrigin).length} completed — test each, give a verdict, or send it back to the board
            </span>
          </div>
          {toVerify.filter(byOrigin).reduce<{ day: string; items: RoadmapItem[] }[]>((groups, it) => {
            const day = dayLabel(it.updatedAt);
            const last = groups[groups.length - 1];
            if (last && last.day === day) last.items.push(it);
            else groups.push({ day, items: [it] });
            return groups;
          }, []).map((g) => (
            <div key={g.day}>
              <div className="review-day">{g.day}</div>
              {g.items.map((it) => (
                <div className="verify-row" key={it.id} data-hl={it.id}>
                  <span className="arch-list-bucket">{PRIORITY_META.find((p) => p.key === it.bucket)?.short}</span>
                  <div className="verify-body">
                    <div className="t"><span className="item-num">#{it.id}</span>{it.title}</div>
                    {reviewMeta(it)}
                    {it.note && <div className="note">{it.note}</div>}
                    {it.builtNote && <div className="built"><span className="built-lbl">What landed</span>{it.builtNote}</div>}
                    {briefPanel(it)}
                    {undoNotes.has(it.id) && <div className="undo-note">⎌ {undoNotes.get(it.id)}</div>}
                  </div>
                  <button className="verify-back" onClick={() => setUndoConfirm(it)}
                    title="Revert this item's commits on main and send it back to the board">⎌ Undo</button>
                  <button className="gemini-btn sm" onClick={() => toggleBrief(it)}
                    title="✧ Gemini writes the reviewer's brief — what shipped, how to test it, likely risks">
                    ✧ Brief
                  </button>
                  <button className="verify-back" onClick={() => onToggle(it)}
                    title="Didn't hold up — send it back to the board">↩ Board</button>
                  {archActions(it)}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* archive — verdict-given items, out of the way but recoverable */}
      {archived.length > 0 && (
        <div className="road-archive">
          <div className="road-archive-bar">
            <button className="road-archive-head" onClick={() => setArchiveOpen((o) => !o)}
              aria-expanded={archiveOpen}>
              <span className="chev">{archiveOpen ? '▾' : '▸'}</span>
              Archive <span className="count">{filtered.length}</span>
              <span className="hint">reviewed items, latest first — still count toward progress</span>
            </button>
            {archiveOpen && (
              <div className="arch-controls">
                <div className="chips">
                  {([
                    { key: 'all', label: 'All', n: archived.length },
                    ...REVIEW_TAGS.map((t) => ({
                      key: t.key as 'all' | ReviewTag, label: t.label,
                      n: archived.filter((it) => it.reviewTag === t.key).length,
                    })),
                  ] as { key: 'all' | ReviewTag; label: string; n: number }[])
                    .filter((c) => c.key !== 'needs-work' || c.n > 0) // legacy verdicts only
                    .map((c) => (
                    <button key={c.key} className={`chip-sm ${archFilter === c.key ? 'on' : ''}`}
                      onClick={() => { setArchFilter(c.key); setArchPage(0); }}>
                      {c.label} {c.n}
                    </button>
                  ))}
                </div>
                <div className="seg-control sm" role="tablist" aria-label="Archive view">
                  <button role="tab" aria-selected={archView === 'grid'}
                    className={`seg-opt ${archView === 'grid' ? 'on' : ''}`} onClick={() => setArchView('grid')}>Buckets</button>
                  <button role="tab" aria-selected={archView === 'list'}
                    className={`seg-opt ${archView === 'list' ? 'on' : ''}`} onClick={() => setArchView('list')}>List</button>
                </div>
              </div>
            )}
          </div>
          {archiveOpen && archView === 'grid' && (
            <div className="road-grid arch">
              {PRIORITY_META.map((col) => {
                const items = filtered.filter((it) => it.bucket === col.key);
                return (
                  <div className="road-col" key={col.key}>
                    <div className="road-col-head">
                      <span className="dot" style={{ background: col.color }} />
                      <span className="name">{col.label}</span>
                      <span className="count">{items.length}</span>
                    </div>
                    <div className="road-items">
                      {items.map((it) => (
                        <div className="road-item done" key={it.id} data-hl={it.id}>
                          <button className="road-check on" onClick={() => onToggle(it)}
                            aria-label="Mark not done" title="Restore to the roadmap">✓</button>
                          <div className="road-body">
                            <div className="t">
                              <span className="item-num">#{it.id}</span>{it.title}
                              {it.source === 'hook' && <span className="auto-cue" title="Auto-extracted from a push">auto</span>}
                            </div>
                            {reviewMeta(it)}
                            {it.note && <div className="note">{it.note}</div>}
                            {it.builtNote && <div className="built"><span className="built-lbl">What landed</span>{it.builtNote}</div>}
                            {archActions(it)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {archiveOpen && archView === 'list' && (
            <div className="arch-list">
              {archSlice.map((it) => (
                <div className="arch-list-row" key={it.id} data-hl={it.id}>
                  <button className="road-check on sm" onClick={() => onToggle(it)}
                    aria-label="Mark not done" title="Restore to the roadmap">✓</button>
                  <span className="arch-list-bucket">{PRIORITY_META.find((p) => p.key === it.bucket)?.short}</span>
                  <span className="arch-list-text">
                    <span className="arch-list-title"><span className="item-num">#{it.id}</span>{it.title}</span>
                    {it.note && <span className="arch-list-note">{it.note}</span>}
                  </span>
                  <span className={`origin-chip ${originOf(it)}`}>
                    {originOf(it) === 'lane' ? `⚑ ${it.claimedBy}` : ORIGIN_LABEL[originOf(it)]}
                  </span>
                  {it.updatedAt && <span className="review-when">{timeAgo(it.updatedAt)}</span>}
                  {archActions(it)}
                </div>
              ))}
              {archPages > 1 && (
                <div className="arch-pager">
                  <button disabled={archPage === 0} onClick={() => setArchPage((p) => p - 1)}>‹</button>
                  <span>{archPage * ARCH_PAGE_SIZE + 1}–{Math.min((archPage + 1) * ARCH_PAGE_SIZE, filtered.length)} of {filtered.length}</span>
                  <button disabled={archPage >= archPages - 1} onClick={() => setArchPage((p) => p + 1)}>›</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      </>)}
    </div>
  );
}
