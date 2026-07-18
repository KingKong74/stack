import { useState } from 'react';
import type { Roadmap as RoadmapData, RoadmapItem, Priority } from '../types';
import { PRIORITY_META } from '../lib/ui';
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
  roadmap, onAdd, onToggle, onEdit, onDelete, onReviewTag, onToggleSkip, onReorder, onCleanup, onSendToTerminal, slug, highlightId,
  draft, onResumeDraft, onDiscardDraft, liveBranches,
}: {
  roadmap: RoadmapData;
  liveBranches?: string[];
  onAdd: (p: Priority, area?: string) => void;
  onToggle: (item: RoadmapItem) => void;
  onEdit: (item: RoadmapItem) => void;
  onDelete: (item: RoadmapItem) => void;
  onReviewTag: (item: RoadmapItem, tag: ReviewTag) => void;
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
  // Send-to-terminal: pick open items (the active area tab scopes the list,
  // a priority filter narrows it, rows tick on/off), compose a work brief and
  // hand it to the terminal screen — it lands as a paste, never auto-runs.
  const [termPick, setTermPick] = useState<Set<number> | null>(null);
  const [termPrio, setTermPrio] = useState<'all' | Priority>('all');
  const termScope = openAll.filter((it) => !areaFilter || it.area === areaFilter);
  const termCandidates = termScope.filter((it) => termPrio === 'all' || it.bucket === termPrio);
  const openTermPick = () => {
    setTermPrio('all');
    // Default selection: workable items — parked and already-claimed ones start unticked.
    setTermPick(new Set(termScope.filter((it) => !it.skipped && !it.claimedBy).map((it) => it.id)));
  };
  const composeBrief = () => {
    const chosen = termCandidates.filter((it) => termPick?.has(it.id));
    const lines = chosen.map((it, i) =>
      `${i + 1}. [${it.bucket}] #${it.id} — ${it.title}${it.note ? `\n   ${it.note.replace(/\n/g, '\n   ')}` : ''}`);
    return `Work these Stack roadmap items${areaFilter ? ` (area: ${areaFilter})` : ''}, top-down:\n\n${lines.join('\n')}\n\nProtocol: claim each item's lane before starting, work one item at a time, commit each unit, and when an item is finished set built_note (what landed) alongside done:true through the Stack API. Leave items claimed by other lanes alone.`;
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
  // Archive rendering: the MoSCoW grid, or a dense paginated list + verdict filter.
  const [archView, setArchView] = useState<'grid' | 'list'>('grid');
  const [archFilter, setArchFilter] = useState<'all' | ReviewTag>('all');
  const [archPage, setArchPage] = useState(0);
  const filtered = archived.filter((it) => archFilter === 'all' || it.reviewTag === archFilter);
  const ARCH_PAGE_SIZE = 12;
  const archPages = Math.max(1, Math.ceil(filtered.length / ARCH_PAGE_SIZE));
  const archSlice = filtered.slice(archPage * ARCH_PAGE_SIZE, (archPage + 1) * ARCH_PAGE_SIZE);

  // Verdict controls, shared by both archive views and the verify strip.
  // Unverdicted rows show Solid/Rethink straight up (no picker step, no
  // needs-more-work — legacy needs-work verdicts still render); clicking an
  // existing verdict reopens the same two options.
  const VISIBLE_TAGS = REVIEW_TAGS.filter((t) => t.key !== 'needs-work');
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
          <div className="seg-control sm" role="tablist" aria-label="Roadmap view">
            <button role="tab" aria-selected={view === 'board'}
              className={`seg-opt ${view === 'board' ? 'on' : ''}`} onClick={() => setView('board')}>Board</button>
            <button role="tab" aria-selected={view === 'reviews'}
              className={`seg-opt ${view === 'reviews' ? 'on' : ''}`} onClick={() => setView('reviews')}>
              Reviews{toVerify.length > 0 ? ` · ${toVerify.length}` : ''}
            </button>
          </div>
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
                {/* An active area chip pre-tags whatever gets added under it. */}
                <button className="road-add" onClick={() => onAdd(col.key, areaFilter || undefined)}>+ Add</button>
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
            {areaFilter ? <>Scoped to the <b>{areaFilter}</b> tab. </> : null}
            The picked items become a work brief, pasted into the terminal for you to review and send.
          </div>
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

      {view === 'reviews' && (<>
      <div className="subtitle" style={{ marginBottom: 20 }}>
        Everything completed, awaiting your verdict — each row shows what was actually built.
        Solid closes it out; Rethink (or ↩ Board) sends it back into play.
      </div>

      {toVerify.length === 0 && archived.length === 0 && (
        <div className="empty-state">
          <div className="big">Nothing to review</div>
          <div>Completed items land here with a note on what was built.</div>
        </div>
      )}

      {/* to verify — completed but unverdicted: test it, verdict it, or send it back */}
      {toVerify.length > 0 && (
        <div className="verify-strip">
          <div className="verify-head">
            <span className="verify-title">To verify</span>
            <span className="verify-sub">
              {toVerify.length} completed — test each, give a verdict, or send it back to the board
            </span>
          </div>
          {toVerify.map((it) => (
            <div className="verify-row" key={it.id} data-hl={it.id}>
              <span className="arch-list-bucket">{PRIORITY_META.find((p) => p.key === it.bucket)?.short}</span>
              <div className="verify-body">
                <div className="t">
                  {it.title}
                  {it.claimedBy && <span className="claim-chip inline" title="Done by this lane">⚑ {it.claimedBy}</span>}
                </div>
                {it.note && <div className="note">{it.note}</div>}
                {it.builtNote && <div className="built"><span className="built-lbl">What landed</span>{it.builtNote}</div>}
              </div>
              <button className="verify-back" onClick={() => onToggle(it)}
                title="Didn't hold up — send it back to the board">↩ Board</button>
              {archActions(it)}
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
                              {it.title}
                              {it.source === 'hook' && <span className="auto-cue" title="Auto-extracted from a push">auto</span>}
                              {it.claimedBy && <span className="claim-chip inline" title="Done by this lane">⚑ {it.claimedBy}</span>}
                            </div>
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
                    <span className="arch-list-title">{it.title}</span>
                    {it.note && <span className="arch-list-note">{it.note}</span>}
                  </span>
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
