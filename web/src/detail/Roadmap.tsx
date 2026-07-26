import { useEffect, useRef, useState } from 'react';
import type { Roadmap as RoadmapData, RoadmapItem, Priority, Tier } from '../types';
import { TIERS, tierRank } from '../types';
import { PRIORITY_META } from '../lib/ui';
import { go } from '../lib/route';
import { Modal } from '../components/Modal';
import { renderMarkdownLite } from '../lib/markdownLite';

export type ReviewTag = 'solid' | 'needs-work' | 'rethink';
export const REVIEW_TAGS: { key: ReviewTag; label: string }[] = [
  { key: 'solid', label: 'Solid' },
  { key: 'needs-work', label: 'Needs more work' },
  { key: 'rethink', label: 'Rethink' },
];

// Review annotations (#146): quick labels the reviewer sticks on a To-verify
// row — lighter than a verdict, they stay while the item sits in the pipeline
// and clear when it completes afresh.
export const REVIEW_NOTE_TAGS: { key: string; label: string }[] = [
  { key: 'fix', label: 'Fix' },
  { key: 'needs-more', label: 'Needs more' },
  { key: 'polish', label: 'Polish' },
  { key: 'question', label: 'Question' },
];

// MoSCoW roadmap. Open items live in their bucket columns (with lane-claim
// chips and edit/delete on hover); completed items move to the collapsed
// Archive below — still counted by the progress model, reviewable with a
// verdict tag, refinable by delta (#146), restorable by un-ticking.
export function Roadmap({
  roadmap, onAdd, onToggle, onEdit, onDelete, onToggleSkip, onReorder, onCleanup, onSendToTerminal, onPlanItems, onSetTier, onBranch, onDeleteArea, onRenameArea, slug, highlightId,
  draft, onResumeDraft, onDiscardDraft, liveBranches, staleItemDays,
}: {
  roadmap: RoadmapData;
  liveBranches?: string[];
  // #247 — days a parked item may sit before the Parked view calls it stale.
  staleItemDays?: number;
  onAdd: (p: Priority, area?: string) => void;
  onToggle: (item: RoadmapItem) => void;
  onEdit: (item: RoadmapItem) => void;
  onDelete: (item: RoadmapItem) => void;
  onToggleSkip: (item: RoadmapItem) => void;
  onReorder?: (item: RoadmapItem, toBucket: Priority, beforeId: number | null) => void;
  onCleanup?: () => void;
  onSendToTerminal?: (brief: string) => void;
  // #255 — hand an ORDERED list of open items to the planning agent: queues a
  // plan-kind autopilot session whose agenda is exactly these ids. Resolves to
  // a line about what was queued (or an already-open job).
  onPlanItems?: (ids: number[]) => Promise<string>;
  // #227 — set (or clear, with '') an item's desire tier from the Tiers view.
  onSetTier?: (item: RoadmapItem, tier: Tier) => void;
  // ⎇ Branch an item for focused work (#205): claim its lane + open a primed session.
  onBranch?: (item: RoadmapItem) => void;
  // #169 — area management: delete (clears area from all items) and rename
  onDeleteArea?: (area: string, itemIds: number[]) => Promise<void>;
  onRenameArea?: (from: string, to: string, itemIds: number[]) => Promise<void>;
  slug?: string;
  highlightId?: string | null;
  draft?: { title: string } | null;
  onResumeDraft?: () => void;
  onDiscardDraft?: () => void;
}) {
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
  // #251 — section expansion. A bucket column can be FOCUSED (it fills the board
  // width and the other three are hidden, so long titles and notes get room to
  // breathe) or COLLAPSED (header only, items folded away). Focus wins over
  // collapse: a focused column always shows its items. Session-local, like the
  // review-row collapse above.
  const [focusCol, setFocusCol] = useState<Priority | null>(null);
  const [collapsedCols, setCollapsedCols] = useState<Set<Priority>>(new Set());
  const toggleColCollapse = (k: Priority) =>
    setCollapsedCols((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const toggleColFocus = (k: Priority) =>
    setFocusCol((f) => {
      const next = f === k ? null : k;
      // Expanding a folded column unfolds it — the expand gesture means "show me this".
      if (next) setCollapsedCols((s) => { const n = new Set(s); n.delete(next); return n; });
      return next;
    });

  // Area filter — the product-area chips over the board (mirrors the Futures funnel).
  // UNCAT (#198) is the Uncategorised tab's sentinel: the leading space can
  // never collide with a real area (area input is trimmed + lowercased), and
  // it filters to items with NO area so nothing untagged hides behind the tabs.
  const UNCAT = ' uncategorised';
  const [areaFilter, setAreaFilter] = useState('');
  const inAreaTab = (it: RoadmapItem) =>
    areaFilter === UNCAT ? !it.area : (!areaFilter || it.area === areaFilter);
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
  // #255 — where the picked items go. The planning agent is the default: a
  // plan-kind autopilot session that designs each item in the picked order and
  // saves the result back as plan steps. The terminal remains as the hands-on
  // alternative (the old ⌨ To terminal, now a destination rather than a button).
  const [termDest, setTermDest] = useState<'planner' | 'terminal'>('planner');
  const [planBusy, setPlanBusy] = useState(false);
  const [planNote, setPlanNote] = useState('');
  const workable = (it: RoadmapItem) => !it.skipped && !it.claimedBy;
  // The planner's natural default: work that has no design yet.
  const unplanned = (it: RoadmapItem) => workable(it) && it.plan.length === 0;
  const termScope = openAll.filter((it) => termAreas.size === 0 || (!!it.area && termAreas.has(it.area)));
  const termCandidates = termScope.filter((it) => termPrio === 'all' || it.bucket === termPrio);
  const openTermPick = () => {
    setTermPrio('all');
    setTermDest('planner');
    setPlanNote('');
    // Start from the active area tab; more areas can be ticked in the modal.
    const areas = new Set(areaFilter && areaFilter !== UNCAT ? [areaFilter] : []);
    setTermAreas(areas);
    const scope = openAll.filter((it) => areas.size === 0 || (!!it.area && areas.has(it.area)));
    // Default selection: the work that has no design yet — parked, claimed and
    // already-planned items start unticked. That makes the default press
    // "plan everything that isn't planned", which is the point of the feature.
    setTermPick(new Set(scope.filter(unplanned).map((it) => it.id)));
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
    return `Work these Stack roadmap items${termAreas.size ? ` (areas: ${[...termAreas].sort().join(', ')})` : ''}, top-down:\n\n${lines.join('\n')}\n\nProtocol: claim each item's branch before starting, work one item at a time, commit each unit, and when an item is finished set built_note (what landed) alongside done:true through the Stack API. Leave items claimed by other branches alone.`;
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

  // #169 — area management: delete (with confirm) and rename.
  // Areas are just strings on roadmap_items — deleting an area clears/reassigns
  // the area tag across the project's items via the existing PATCH route.
  const [areaManage, setAreaManage] = useState<string | null>(null); // area being managed (popover open)
  const [areaDeleteConfirm, setAreaDeleteConfirm] = useState<string | null>(null); // area in delete-confirm modal
  const [areaDeleteTyped, setAreaDeleteTyped] = useState('');
  const [areaRename, setAreaRename] = useState<string | null>(null); // area being renamed
  const [areaRenameDraft, setAreaRenameDraft] = useState('');
  const areaPopoverRef = useRef<HTMLDivElement>(null);

  // Close the manage-popover when the user clicks outside it.
  useEffect(() => {
    if (!areaManage) return;
    const handler = (e: MouseEvent) => {
      if (areaPopoverRef.current && !areaPopoverRef.current.contains(e.target as Node)) {
        setAreaManage(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [areaManage]);

  // All items (open + done) that carry this area — used for the safety check and
  // the actual clear pass. Open items only get their area cleared; done items too.
  const allRoadmapItems = PRIORITY_META.flatMap((col) => roadmap[col.key]);
  const itemsForArea = (a: string) => allRoadmapItems.filter((it) => it.area === a);
  const openItemsForArea = (a: string) => allRoadmapItems.filter((it) => it.area === a && !it.done);

  const doDeleteArea = async (area: string) => {
    // Clear area from every item carrying it (client-side loop; fine at board scale).
    const affected = itemsForArea(area);
    if (affected.length > 0 && onDeleteArea) {
      await onDeleteArea(area, affected.map((it) => it.id));
    }
    // Also drop from the device-local custom areas list.
    const next = customAreas.filter((a) => a !== area);
    setCustomAreas(next);
    if (areasKey) { try { localStorage.setItem(areasKey, JSON.stringify(next)); } catch { /* full */ } }
    if (areaFilter === area) setAreaFilter('');
    setAreaDeleteConfirm(null);
    setAreaDeleteTyped('');
    setAreaManage(null);
  };

  const doRenameArea = async (from: string, to: string) => {
    const normalised = to.trim().toLowerCase().slice(0, 40);
    if (!normalised || normalised === from) { setAreaRename(null); setAreaRenameDraft(''); return; }
    const affected = itemsForArea(from);
    if (affected.length > 0 && onRenameArea) {
      await onRenameArea(from, normalised, affected.map((it) => it.id));
    }
    // Repoint the device-local custom list.
    setCustomAreas((prev) => {
      const next = prev.map((a) => a === from ? normalised : a);
      if (areasKey) { try { localStorage.setItem(areasKey, JSON.stringify(next)); } catch { /* full */ } }
      return next;
    });
    if (areaFilter === from) setAreaFilter(normalised);
    setAreaRename(null);
    setAreaRenameDraft('');
    setAreaManage(null);
  };

  // Completed items are no longer shown here at all (#282): verdicts, the
  // archive and the whole review pipeline live in Mission Control's Review
  // room. The board still needs the list to count progress and to answer a
  // deep link that lands on something already finished.
  const doneItems = PRIORITY_META.flatMap((col) => roadmap[col.key].filter((it) => it.done));

  // The tab's three views: Board, Tiers (#227) and Parked (#247).
  const [view, setView] = useState<'board' | 'tiers' | 'parked'>('board');

  // #247 — the parked shelf. Every open item somebody pressed ⏸ on, oldest park
  // first, aged from the park stamp (falling back to the last edit for rows
  // parked before skipped_at existed — flagged as approximate rather than
  // quietly presented as exact). Past the Settings threshold it reads STALE.
  const DAY_MS = 86_400_000;
  const parkedAge = (it: RoadmapItem) => {
    const stamp = it.skippedAt || it.updatedAt;
    if (!stamp) return null;
    const ms = Date.parse(stamp);
    if (!Number.isFinite(ms)) return null;
    return { days: Math.max(0, Math.floor((Date.now() - ms) / DAY_MS)), exact: Boolean(it.skippedAt) };
  };
  const parked = PRIORITY_META
    .flatMap((col) => roadmap[col.key].filter((it) => !it.done && it.skipped))
    .map((it) => ({ it, age: parkedAge(it) }))
    .sort((a, b) => (b.age?.days ?? -1) - (a.age?.days ?? -1));
  const staleDays = Math.max(1, staleItemDays ?? 21);
  const staleCount = parked.filter((p) => (p.age?.days ?? 0) >= staleDays).length;

  // #227 — the tier list. A desire ranking across the whole open board: drag an
  // item into S/A/B/C to say how much you want it NEXT, independently of the
  // MoSCoW bucket's sizing. The tier is the primary sort of the run queue — the
  // Plan room and the overnight runner both apply it — and unranked items sort
  // last, so a board nobody has ranked behaves exactly as it always did.
  const tierRows: { key: Tier; label: string; blurb: string }[] = [
    { key: 'S', label: 'S', blurb: 'what I want next, above everything' },
    { key: 'A', label: 'A', blurb: 'clearly wanted — right after S' },
    { key: 'B', label: 'B', blurb: 'worth doing when the top is clear' },
    { key: 'C', label: 'C', blurb: 'someday — keep it on the board' },
    { key: '', label: 'Unranked', blurb: 'no desire call yet — runs after everything ranked' },
  ];
  const [tierDrag, setTierDrag] = useState<number | null>(null);
  const [tierOver, setTierOver] = useState<Tier | null>(null);
  const openForTiers = openAll.filter(inAreaTab);
  const inTier = (t: Tier) => openForTiers.filter((it) => (it.tier || '') === t);
  const rankedCount = openForTiers.filter((it) => it.tier).length;

  return (
    <div>
      <div className="section-bar" style={{ marginBottom: 6 }}>
        <div className="titles">
          <div className="h">Roadmap</div>
          <div className="subtitle">MoSCoW prioritisation</div>
        </div>
        <div className="bar-actions">
          {(onPlanItems || onSendToTerminal) && view === 'board' && (
            <button className="gemini-btn sm" onClick={openTermPick}
              title="Pick open items and hand them to the planning agent — an unattended plan session designs each one and saves the steps back onto the item">
              ✧ To planning agent
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
          {onSetTier && (
            <button role="tab" aria-selected={view === 'tiers'}
              className={`seg-opt ${view === 'tiers' ? 'on' : ''}`} onClick={() => setView('tiers')}
              title="Rank the open board by what you actually want next — the tier order leads the run queue">
              Tiers{rankedCount > 0 ? ` · ${rankedCount}` : ''}
            </button>
          )}
          <button role="tab" aria-selected={view === 'parked'}
            className={`seg-opt ${view === 'parked' ? 'on' : ''}`} onClick={() => setView('parked')}
            title="Every parked item, oldest park first — with how long it's been sitting">
            Parked{parked.length > 0 ? ` · ${parked.length}` : ''}
            {staleCount > 0 && <span className="seg-warn" title={`${staleCount} past the ${staleDays}-day stale threshold`}>{staleCount}</span>}
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
          {/* Uncategorised (#198): shown whenever untagged open items exist, so
              nothing slips out of sight once the board lives by area tabs. */}
          {openAll.some((it) => !it.area) && (
            <button className={`chip-sm ${areaFilter === UNCAT ? 'on' : ''}`}
              title="Open items with no area tag — give them one from ✎ edit"
              onClick={() => setAreaFilter(areaFilter === UNCAT ? '' : UNCAT)}>
              uncategorised {openAll.filter((it) => !it.area).length}
            </button>
          )}
          {boardAreas.map((a) => (
            <span key={a} className="area-chip-group" style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <button className={`chip-sm ${areaFilter === a ? 'on' : ''}`}
                onClick={() => setAreaFilter(areaFilter === a ? '' : a)}>
                {a} {openAll.filter((it) => it.area === a).length}
              </button>
              {/* #169 — manage-area button: opens a small popover with Delete / Rename */}
              <button
                className="area-manage-btn"
                title={`Manage area "${a}" — delete or rename`}
                onClick={(e) => { e.stopPropagation(); setAreaManage(areaManage === a ? null : a); }}
                aria-label={`Manage area ${a}`}
              >⋯</button>
              {areaManage === a && (
                <div className="area-manage-pop" ref={areaPopoverRef}>
                  {areaRename === a ? (
                    <div className="area-rename-row">
                      <input
                        className="area-rename-input"
                        autoFocus
                        value={areaRenameDraft}
                        placeholder="new name…"
                        maxLength={40}
                        onChange={(e) => setAreaRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') doRenameArea(a, areaRenameDraft);
                          if (e.key === 'Escape') { setAreaRename(null); setAreaRenameDraft(''); }
                        }}
                      />
                      <button className="area-pop-action" onClick={() => doRenameArea(a, areaRenameDraft)}>✓</button>
                      <button className="area-pop-action" onClick={() => { setAreaRename(null); setAreaRenameDraft(''); }}>✕</button>
                    </div>
                  ) : (
                    <>
                      <button className="area-pop-action" onClick={() => { setAreaRename(a); setAreaRenameDraft(a); }}>
                        ✎ Rename
                      </button>
                      <button className="area-pop-action danger" onClick={() => {
                        setAreaManage(null);
                        setAreaDeleteConfirm(a);
                        setAreaDeleteTyped('');
                      }}>
                        × Delete area
                      </button>
                    </>
                  )}
                </div>
              )}
            </span>
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

      {focusCol && (
        <button className="road-focus-back" onClick={() => setFocusCol(null)}>
          ← all sections
        </button>
      )}
      <div className={`road-grid ${focusCol ? 'focused' : ''}`}>
        {PRIORITY_META.filter((col) => !focusCol || col.key === focusCol).map((col) => {
          const open = roadmap[col.key].filter((it) => !it.done && inAreaTab(it));
          // Parked items sink to the bottom of their bucket; within the live
          // ones the desire tier leads (#227), so the column reads in the order
          // the queue would work it. Unranked items keep their drag position.
          const live = [...open.filter((it) => !it.skipped)]
            .sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
          const items = [...live, ...open.filter((it) => it.skipped)];
          const folded = focusCol !== col.key && collapsedCols.has(col.key);
          return (
            <div className={`road-col ${folded ? 'folded' : ''} ${focusCol === col.key ? 'focus' : ''}`} key={col.key}>
              <div className="road-col-head">
                <span className="dot" style={{ background: col.color }} />
                <button className="name" onClick={() => toggleColFocus(col.key)}
                  title={focusCol === col.key
                    ? 'Back to all four sections'
                    : `Expand ${col.label} — it fills the board and the other sections fold away`}>
                  {col.label}
                </button>
                <span className="count">{items.length}</span>
                <button className="road-col-btn" aria-expanded={!folded}
                  onClick={() => toggleColCollapse(col.key)}
                  title={folded ? 'Unfold this section' : 'Fold this section away'}>
                  {folded ? '▸' : '▾'}
                </button>
                <button className={`road-col-btn ${focusCol === col.key ? 'on' : ''}`}
                  aria-pressed={focusCol === col.key}
                  onClick={() => toggleColFocus(col.key)}
                  title={focusCol === col.key ? 'Back to all four sections' : 'Expand this section to fill the board'}>
                  {focusCol === col.key ? '⤡' : '⤢'}
                </button>
              </div>
              {folded ? null : (
              <div
                className={`road-items ${overKey === `col-${col.key}` ? 'drop-into' : ''}`}
                onDragOver={(e) => { if (dragId != null) { e.preventDefault(); setOverKey(`col-${col.key}`); } }}
                onDragLeave={() => setOverKey((k) => (k === `col-${col.key}` ? null : k))}
                onDrop={(e) => { e.preventDefault(); handleDrop(col.key, null); }}
              >
                {/* An active area chip pre-tags whatever gets added under it. */}
                <button className="road-add" onClick={() => onAdd(col.key, areaFilter && areaFilter !== UNCAT ? areaFilter : undefined)}>+ Add</button>
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
                        <span className="item-num">#{it.id}</span>{it.title}
                        {it.tier && (
                          <span className={`tier-chip t${it.tier}`}
                            title={`Desire tier ${it.tier} (#227) — the run queue works S, then A, B, C, then unranked`}>
                            {it.tier}
                          </span>
                        )}
                        {it.source === 'hook' && <span className="auto-cue" title="Auto-extracted from a push">auto</span>}
                        {it.area && <span className="area-chip" title="Product area — edit the item to change it">{it.area}</span>}
                        {working && <span className="work-chip" title={`Claimed by ${it.claimedBy} — read-only while the work is in flight`}>● in progress</span>}
                        {it.skipped && <span className="skip-chip" title="Parked — not to be picked up yet">⏸ parked</span>}
                        {it.risk !== 'normal' && (
                          <span className={`risk-chip ${it.risk}`}
                            title={it.risk === 'low'
                              ? 'Low risk — a green overnight run (checks + clean review) merges itself; you still give the verdict'
                              : 'High risk — extra care; never auto-merged'}>
                            {it.risk === 'low' ? '⇣ low risk' : '⇡ high risk'}
                          </span>
                        )}
                        {it.plan.length > 0 && (
                          <span className="plan-chip"
                            title={`Implementation plan — ${it.plan.filter((s) => s.done).length} of ${it.plan.length} steps done:\n${it.plan.map((s) => `${s.done ? '☑' : '☐'} ${s.text}`).join('\n')}`}>
                            ☰ {it.plan.filter((s) => s.done).length}/{it.plan.length}
                          </span>
                        )}
                      </div>
                      {it.note && <div className="note">{it.note}</div>}
                      {it.refineNote && (
                        <div className="refine-note refine-note-rich"
                          title="Sent back for refinement — the next session changes only this, on top of what landed">
                          <span className="refine-note-icon">↻</span>
                          <span className="refine-note-body">{renderMarkdownLite(it.refineNote)}</span>
                        </div>
                      )}
                      {it.claimedBy && (
                        <div className="claim-chip"
                          title={working
                            ? 'Claimed by this branch'
                            : 'Claimed by this branch — no live session on it; edit the item to clear the claim'}>
                          ⚑ {it.claimedBy}
                        </div>
                      )}
                    </div>
                    <div className="road-actions">
                      {!working && (
                        <>
                          {onBranch && !it.claimedBy && !it.skipped && (
                            <button onClick={() => onBranch(it)} aria-label="Branch for focused work"
                              title={`Branch for focused work (#205) — claims the item’s branch and opens a terminal session primed to build it on that branch; merge back from Mission Control when it lands`}>⎇</button>
                          )}
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
              )}
            </div>
          );
        })}
      </div>
      </>)}

      {/* #227 — the tier list: a desire ranking over the whole open board,
          distinct from must/should sizing. Drag a card into a tier (or use the
          S/A/B/C buttons on it); the tier leads the run queue everywhere. */}
      {view === 'tiers' && onSetTier && (<>
        <div className="subtitle" style={{ marginBottom: 18 }}>
          What you actually want done next, ranked — separate from must/should, which is about how
          necessary the work is rather than how much you want it now. Drag a card into a tier, or use
          its S/A/B/C buttons. The tier leads the run queue: Mission Control's Plan room and the
          overnight runner both work S first, then A, B, C, then everything unranked in board order.
          {areaFilter && <> Showing the <b>{areaFilter === UNCAT ? 'uncategorised' : areaFilter}</b> tab only —
            switch to All on the Board view to rank the whole project.</>}
        </div>
        <div className="tier-board">
          {tierRows.map((row) => {
            const rowItems = inTier(row.key);
            return (
              <div className={`tier-row t${row.key || 'none'} ${tierOver === row.key ? 'over' : ''}`} key={row.key || 'none'}
                onDragOver={(e) => { if (tierDrag != null) { e.preventDefault(); setTierOver(row.key); } }}
                onDragLeave={() => setTierOver((t) => (t === row.key ? null : t))}
                onDrop={(e) => {
                  e.preventDefault();
                  const it = tierDrag != null ? openForTiers.find((x) => x.id === tierDrag) : null;
                  setTierDrag(null); setTierOver(null);
                  if (it && (it.tier || '') !== row.key) onSetTier(it, row.key);
                }}>
                <div className="tier-label">
                  <span className="k">{row.label}</span>
                  <span className="n">{rowItems.length}</span>
                  <span className="blurb">{row.blurb}</span>
                </div>
                <div className="tier-items">
                  {rowItems.map((it) => (
                    <div className={`tier-card ${tierDrag === it.id ? 'drag' : ''} ${highlightId === String(it.id) ? 'hl' : ''}`}
                      key={it.id} data-hl={it.id} draggable
                      onDragStart={(e) => { setTierDrag(it.id); e.dataTransfer.effectAllowed = 'move'; }}
                      onDragEnd={() => { setTierDrag(null); setTierOver(null); }}>
                      <button className="body" onClick={() => onEdit(it)} title="Edit this item">
                        <span className="t"><span className="item-num">#{it.id}</span>{it.title}</span>
                        <span className="m">
                          {it.bucket}{it.area ? ` · ${it.area}` : ''}
                          {it.skipped ? ' · ⏸ parked' : ''}
                          {it.claimedBy ? ` · ⚑ ${it.claimedBy}` : ''}
                        </span>
                      </button>
                      <div className="tier-pick">
                        {TIERS.map((t) => (
                          <button key={t} className={`tp ${it.tier === t ? 'on' : ''}`}
                            title={`Move #${it.id} to tier ${t}`}
                            onClick={() => onSetTier(it, it.tier === t ? '' : t)}>{t}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {rowItems.length === 0 && (
                    <div className="tier-empty">
                      {row.key === '' ? 'everything open is ranked' : 'drop items here'}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {openForTiers.length === 0 && (
          <div className="empty-state" style={{ marginTop: 14 }}>Nothing open to rank.</div>
        )}
      </>)}

      {/* #247 — the parked shelf: everything that's been set aside, how long
          it's been sitting, and which of it has gone stale. Nothing here is
          automatic — the view surfaces the age, the human decides. */}
      {view === 'parked' && (<>
        <div className="subtitle" style={{ marginBottom: 18 }}>
          Items you've parked with ⏸ — off the board's run queue and invisible to the autopilot,
          but still counted by progress. Anything sitting longer than {staleDays} day{staleDays === 1 ? '' : 's'} reads
          as stale; change that threshold in Settings → Roadmap.
        </div>
        {parked.length === 0 ? (
          <div className="empty-state">Nothing parked — every open item is in play.</div>
        ) : (
          <>
            <div className="parked-head">
              <span className="cap-sm">PARKED</span>
              <span className="n">{parked.length}</span>
              {staleCount > 0 && <span className="stale-pill">{staleCount} stale</span>}
            </div>
            <div className="parked-list">
              {parked.map(({ it, age }) => {
                const stale = (age?.days ?? 0) >= staleDays;
                return (
                  <div className={`parked-row ${stale ? 'stale' : ''} ${highlightId === String(it.id) ? 'hl' : ''}`}
                    key={it.id} data-hl={it.id}>
                    <span className="arch-list-bucket">{PRIORITY_META.find((p) => p.key === it.bucket)?.short}</span>
                    <div className="parked-body">
                      <div className="t">
                        <span className="item-num">#{it.id}</span>{it.title}
                        {it.area && <span className="area-chip">{it.area}</span>}
                        {it.claimedBy && <span className="claim-chip inline">⚑ {it.claimedBy}</span>}
                      </div>
                      {it.note && <div className="note">{it.note}</div>}
                    </div>
                    <span className={`parked-age ${stale ? 'stale' : ''}`}
                      title={age?.exact === false
                        ? 'Parked before Stack recorded park dates — aged from the last edit instead'
                        : 'Days since this item was parked'}>
                      {age === null
                        ? 'parked'
                        : `${age.exact ? '' : '~'}${age.days} day${age.days === 1 ? '' : 's'}`}
                      {stale && <span className="stale-flag">stale</span>}
                    </span>
                    <div className="road-actions arch">
                      <button onClick={() => onToggleSkip(it)} title="Unpark — back in play">▶ Unpark</button>
                      <button onClick={() => onEdit(it)} aria-label="Edit item" title="Edit">✎</button>
                      <button onClick={() => onDelete(it)} aria-label="Delete item" title="Delete">×</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </>)}

      {termPick && (onPlanItems || onSendToTerminal) && (
        <Modal onClose={() => setTermPick(null)} wide>
          <h3>✧ Push items to the planning agent</h3>
          <div className="confirm-body" style={{ marginBottom: 12 }}>
            {termDest === 'planner'
              ? 'Pick the items to have designed. An unattended plan session works them in this order — one bounded design session each, in a throwaway worktree — and saves the result back onto each item as plan steps plus a design note. It never builds and never ticks anything.'
              : 'Pick area tabs, then items — the picked items become a work brief, pasted into the terminal for you to review and send.'}
          </div>
          {onPlanItems && onSendToTerminal && (
            <div className="seg-control sm" role="tablist" aria-label="Where the picked items go"
              style={{ marginBottom: 12 }}>
              <button role="tab" aria-selected={termDest === 'planner'}
                className={`seg-opt ${termDest === 'planner' ? 'on' : ''}`}
                onClick={() => { setTermDest('planner'); setPlanNote(''); }}>✧ Planning agent</button>
              <button role="tab" aria-selected={termDest === 'terminal'}
                className={`seg-opt ${termDest === 'terminal' ? 'on' : ''}`}
                onClick={() => { setTermDest('terminal'); setPlanNote(''); }}>⌨ Terminal session</button>
            </div>
          )}
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
          {/* Bulk ticks — the whole board is a legitimate agenda for the planner,
              so "everything unplanned" is one press away (#255). */}
          <div className="chips" style={{ marginBottom: 10 }}>
            <button className="chip-sm" onClick={() => setTermPick(new Set(termCandidates.filter(workable).map((it) => it.id)))}>
              tick all workable
            </button>
            <button className="chip-sm" onClick={() => setTermPick(new Set(termCandidates.filter(unplanned).map((it) => it.id)))}>
              only unplanned {termCandidates.filter(unplanned).length}
            </button>
            <button className="chip-sm" onClick={() => setTermPick(new Set())}>none</button>
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
                    {it.plan.length > 0 && (
                      <span className="plan-chip" title="Already has an implementation plan — the planner would replace it (untouched plans only)">
                        ☰ {it.plan.filter((s) => s.done).length}/{it.plan.length}
                      </span>
                    )}
                  </span>
                  <span className="why">[{it.bucket}]{it.area ? ` · ${it.area}` : ''}</span>
                </span>
              </label>
            ))}
            {termCandidates.length === 0 && <div className="confirm-body">Nothing open under this filter.</div>}
          </div>
          {termDest === 'planner' && (
            <div className="field-hint" style={{ marginTop: 12 }}>
              The session runs on the host within a minute of queuing and works down the list until the
              night's wall-clock cap or token budget runs out — anything it doesn't reach keeps its place
              for the next push. Claimed items are skipped, as are plans a session has already ticked
              steps on; nothing in flight is replanned over. Watch it land on Mission Control.
            </div>
          )}
          {planNote && <div className="gemini-suggest" style={{ marginTop: 10 }}>✧ {planNote}</div>}
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button className="btn-cancel" onClick={() => setTermPick(null)}>Cancel</button>
            <button className="btn-submit"
              disabled={planBusy || !termCandidates.some((it) => termPick.has(it.id))}
              onClick={() => {
                // The agenda is the board's own order — the list the runner works
                // top-down — restricted to what's ticked.
                const ids = termCandidates.filter((it) => termPick.has(it.id)).map((it) => it.id);
                if (termDest === 'terminal' && onSendToTerminal) {
                  onSendToTerminal(composeBrief());
                  setTermPick(null);
                  return;
                }
                if (!onPlanItems) return;
                setPlanBusy(true);
                setPlanNote('');
                onPlanItems(ids)
                  .then((note) => setPlanNote(note))
                  .catch((e) => setPlanNote((e as Error)?.message || 'Could not queue the planning session.'))
                  .finally(() => setPlanBusy(false));
              }}>
              {termDest === 'terminal'
                ? 'Open in terminal →'
                : planBusy ? 'Queuing…' : `Plan ${termCandidates.filter((it) => termPick.has(it.id)).length} item${termCandidates.filter((it) => termPick.has(it.id)).length === 1 ? '' : 's'} →`}
            </button>
          </div>
        </Modal>
      )}

      {/* #169 — area delete confirm modal */}
      {areaDeleteConfirm && (
        <Modal onClose={() => { setAreaDeleteConfirm(null); setAreaDeleteTyped(''); }}>
          <h3>Delete area "{areaDeleteConfirm}"</h3>
          {(() => {
            const open = openItemsForArea(areaDeleteConfirm);
            const all = itemsForArea(areaDeleteConfirm);
            if (open.length > 0) {
              return (
                <>
                  <div className="confirm-body" style={{ marginBottom: 14 }}>
                    This area has <b>{open.length} open item{open.length === 1 ? '' : 's'}</b>
                    {all.length > open.length ? ` (${all.length} total including done)` : ''}.
                    Deleting it will clear the area tag from all of them — the items stay on the board,
                    just untagged. This cannot be undone. Type the area name to confirm.
                  </div>
                  <input
                    className="field-input"
                    autoFocus
                    placeholder={areaDeleteConfirm}
                    value={areaDeleteTyped}
                    onChange={(e) => setAreaDeleteTyped(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && areaDeleteTyped === areaDeleteConfirm) doDeleteArea(areaDeleteConfirm);
                    }}
                    style={{ marginBottom: 16 }}
                  />
                  <div className="modal-actions">
                    <button className="btn-cancel" onClick={() => { setAreaDeleteConfirm(null); setAreaDeleteTyped(''); }}>Cancel</button>
                    <button className="btn-submit" disabled={areaDeleteTyped !== areaDeleteConfirm}
                      onClick={() => doDeleteArea(areaDeleteConfirm)}>
                      Delete area
                    </button>
                  </div>
                </>
              );
            }
            return (
              <>
                <div className="confirm-body" style={{ marginBottom: 14 }}>
                  {all.length > 0
                    ? <>No open items carry this area, but <b>{all.length} done item{all.length === 1 ? '' : 's'}</b> will have their tag cleared.</>
                    : 'This area has no items. It will be removed from the filter bar.'}
                </div>
                <div className="modal-actions">
                  <button className="btn-cancel" onClick={() => { setAreaDeleteConfirm(null); setAreaDeleteTyped(''); }}>Cancel</button>
                  <button className="btn-submit" onClick={() => doDeleteArea(areaDeleteConfirm)}>Delete area</button>
                </div>
              </>
            );
          })()}
        </Modal>
      )}

      {/* #282 — the Reviews view moved OUT of this tab into Mission Control's
          Review room: the nights run across projects, so the morning's queue
          does too. A deep link to a completed item lands here, so say where it
          went rather than showing an empty board. */}
      {view === 'board' && highlightId && doneItems.some((it) => String(it.id) === highlightId) && (
        <div className="road-moved">
          <span>
            #{highlightId} is complete — completed work is reviewed in
            {' '}<button className="link" onClick={go.control}>Mission Control → Review</button>.
          </span>
        </div>
      )}

    </div>
  );
}
