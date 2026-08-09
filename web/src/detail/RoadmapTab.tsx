// The Roadmap tab's SHELL — one segmented control over six views.
//
// Three of them are the redesign (Timeline, Scope, Plan) and two are the
// surviving run-queue surfaces (Tiers, Parked).
//
// THE OLD BOARD IS GONE — Scope replaced it, and replacing means ABSORBING:
// Scope carries the Board's edit/delete/park/branch tools, every tag it showed,
// and its drag-reorder, because the order within a lane IS the run queue's
// tiebreak once `tier` has sorted it (CLAUDE.md). Tiers stays because it is
// where that primary sort is set, and Parked because a parked item has to be
// findable. Dropping the Board without moving all three of those would have
// quietly removed controls the fleet depends on.
//
// This file owns everything the three new views share: the area chips and their
// editor, the label filter, the board's furniture (areas + lists, fetched once
// here), the selected bar, and the arrange proposal. It writes through
// `store.ts` like every other screen and hands its children plain callbacks —
// the views themselves are presentational and testable by inspection.
//
// One rule worth stating: EVERY WRITE HERE IS OPTIMISTIC AND REVERSIBLE. The
// local copy updates, the PATCH goes out, and a rejection puts the row back and
// says so. A planning board that silently keeps a change the server refused is
// showing a plan that does not exist.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BoardArea, BoardList, Priority, Roadmap as RoadmapData, RoadmapItem, Tier,
} from '../types';
import {
  getBoardShape, patchRoadmapItem, createRoadmapItem,
  addArea, renameArea as renameAreaApi, deleteArea as deleteAreaApi, addList as addListApi,
} from '../store';
import { Roadmap } from './Roadmap';
import { RoadmapTimeline } from './RoadmapTimeline';
import { RoadmapScope } from './RoadmapScope';
import { RoadmapPlan } from './RoadmapPlan';
import { RoadmapArrange, proposedSpans, arrangementCount, type Arrangement } from './RoadmapArrange';

type View = 'timeline' | 'scope' | 'plan' | 'tiers' | 'parked';
const PLAN_VIEWS = new Set<View>(['timeline', 'scope', 'plan']);

const VIEWS: { key: View; label: string; title: string }[] = [
  { key: 'timeline', label: 'Timeline', title: 'When each area is working on what' },
  { key: 'scope', label: 'Scope', title: 'What is in this cycle and what is first to cut' },
  { key: 'plan', label: 'Plan', title: 'The lists board' },
  { key: 'tiers', label: 'Tiers', title: 'What you want built next — the run queue’s primary sort' },
  { key: 'parked', label: 'Parked', title: 'Everything parked, oldest first' },
];

const flat = (r: RoadmapData): RoadmapItem[] => [...r.must, ...r.should, ...r.could, ...r.wont];

export interface RoadmapTabProps {
  slug: string;
  roadmap: RoadmapData;
  /** The Monday the timeline counts weeks from; null = no dates, no calendar. */
  weekZero: string | null;
  /** Replace one item in the parent's copy after a write. */
  onItemChanged: (item: RoadmapItem) => void;
  onItemAdded: (item: RoadmapItem) => void;
  /** Everything the existing Board/Tiers/Parked views need, passed straight through. */
  legacy: Omit<Parameters<typeof Roadmap>[0], 'roadmap' | 'controlledView' | 'slug'>;
  onOpenItem: (item: RoadmapItem) => void;
  onSetTier?: (item: RoadmapItem, tier: Tier) => void;
}

export function RoadmapTab({
  slug, roadmap, weekZero, onItemChanged, onItemAdded, legacy, onOpenItem,
}: RoadmapTabProps) {
  // A deep link to an item lands on SCOPE, because that is where an item now
  // lives — the Board used to reveal it and the Board is gone. Without this a
  // search result would open the Timeline, which shows bars, not rows.
  const [view, setView] = useState<View>(legacy.highlightId ? 'scope' : 'timeline');
  useEffect(() => { if (legacy.highlightId) setView('scope'); }, [legacy.highlightId]);
  const [areas, setAreas] = useState<BoardArea[]>([]);
  const [lists, setLists] = useState<BoardList[]>([]);
  const [areaFilter, setAreaFilter] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [editAreas, setEditAreas] = useState(false);
  const [areaDraft, setAreaDraft] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [proposal, setProposal] = useState<Arrangement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const items = useMemo(() => flat(roadmap), [roadmap]);

  useEffect(() => {
    let alive = true;
    getBoardShape(slug)
      .then((b) => { if (alive) { setAreas(b.areas); setLists(b.lists); } })
      .catch((e) => { if (alive) setErr(e?.message || 'Could not read the board’s areas.'); });
    return () => { alive = false; };
  }, [slug]);

  useEffect(() => { if (!err) return; const t = setTimeout(() => setErr(''), 6000); return () => clearTimeout(t); }, [err]);

  // Every write goes through here: PATCH, push the row back to the parent, and
  // surface a rejection rather than leaving the screen ahead of the server.
  const write = useCallback(
    async (item: RoadmapItem, patch: Parameters<typeof patchRoadmapItem>[2]) => {
      const next = await patchRoadmapItem(slug, item.id, patch);
      onItemChanged(next);
      return next;
    }, [slug, onItemChanged]);

  const guard = (p: Promise<unknown>, what: string) =>
    p.catch((e) => { setErr((e as Error)?.message || `Could not ${what}.`); });

  const selected = selectedId === null ? null : items.find((i) => i.id === selectedId) || null;

  // --- the arrange proposal ------------------------------------------------

  const applyProposal = async () => {
    if (!proposal) return;
    setBusy(true);
    try {
      if (proposal.kind === 'trim') {
        for (const id of proposal.defer) {
          const it = items.find((x) => x.id === id);
          if (it) await write(it, { skipped: true });
        }
      } else {
        for (const mv of proposal.moves) {
          const it = items.find((x) => x.id === mv.id);
          if (it) await write(it, { sched: mv.sched });
        }
      }
      setProposal(null);
    } catch (e) {
      // Partial application is the honest outcome to report: some rows moved.
      // Saying "failed" would suggest none did, and the board already shows
      // which ones landed.
      setErr(`${(e as Error)?.message || 'A change was rejected'} — the changes before it were applied.`);
    } finally {
      setBusy(false);
    }
  };

  // --- areas ----------------------------------------------------------------

  const areaChips = useMemo(() => {
    const counts = new Map<string, number>();
    items.filter((i) => !i.archived).forEach((i) => counts.set(i.area, (counts.get(i.area) || 0) + 1));
    return areas.map((a) => ({ ...a, n: counts.get(a.name) || 0 }));
  }, [areas, items]);

  return (
    <div className="rtab">
      <div className="rtab-bar">
        <div className="seg-control" role="tablist" aria-label="Roadmap view">
          {VIEWS.map((v) => (
            <button key={v.key} role="tab" aria-selected={view === v.key} title={v.title}
              className={`seg-opt ${view === v.key ? 'on' : ''}`} onClick={() => setView(v.key)}>
              {v.label}
            </button>
          ))}
        </div>
        {PLAN_VIEWS.has(view) && (
          <span className="rtab-hint">
            {view === 'timeline' ? 'Weeks from this project’s week zero — a plan, not a calendar'
              : view === 'scope' ? 'What is in the cycle, and what is first to cut'
                : 'Cards move between lists; a column is not a verdict'}
          </span>
        )}
      </div>

      {err && <div className="action-error">{err}</div>}

      {PLAN_VIEWS.has(view) && (
        <div className="rtab-chips">
          <button className={`chip-sm${areaFilter === '' ? ' on' : ''}`} onClick={() => setAreaFilter('')}>
            All areas<span className="n">{items.filter((i) => !i.archived).length}</span>
          </button>
          {areaChips.map((a) => (
            editAreas ? (
              <span className="rtab-areaedit" key={a.name}>
                <span className="dot" style={{ background: a.dot }} />
                <input defaultValue={a.name} onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  const to = (e.target as HTMLInputElement).value.trim();
                  if (!to || to === a.name) return;
                  guard(renameAreaApi(slug, a.name, to).then(setAreas), 'rename that area');
                }} />
                <button title="Delete area — the items keep their work, they just lose the tag"
                  onClick={() => guard(deleteAreaApi(slug, a.name).then(setAreas), 'delete that area')}>×</button>
              </span>
            ) : (
              <button key={a.name} className={`chip-sm${areaFilter === a.name ? ' on' : ''}`}
                onClick={() => setAreaFilter(areaFilter === a.name ? '' : a.name)}>
                <span className="dot" style={{ background: a.dot }} />
                {a.name}<span className="n">{a.n}</span>
              </button>
            )
          ))}
          {editAreas && (
            areaDraft !== null ? (
              <input className="field-input sm" autoFocus value={areaDraft} placeholder="Area name, then Enter"
                onChange={(e) => setAreaDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const v = areaDraft.trim();
                    if (v) guard(addArea(slug, v).then(setAreas), 'add that area');
                    setAreaDraft(null);
                  } else if (e.key === 'Escape') setAreaDraft(null);
                }} />
            ) : <button className="chip-sm dashed" onClick={() => setAreaDraft('')}>+ Add area</button>
          )}
          <button className="rtab-editareas" onClick={() => { setEditAreas(!editAreas); setAreaDraft(null); }}>
            {editAreas ? 'Done' : 'Edit areas'}
          </button>
        </div>
      )}

      {view === 'timeline' && (
        <>
          <RoadmapArrange
            items={items} selected={selected} proposal={proposal} busy={busy}
            onPropose={setProposal} onApply={applyProposal} onDiscard={() => setProposal(null)} />
          <RoadmapTimeline
            items={items} areas={areas} weekZero={weekZero} areaFilter={areaFilter}
            selectedId={selectedId} onSelect={setSelectedId}
            proposed={proposedSpans(proposal)}
            onSchedule={(it, sched) => write(it, { sched }).then(() => undefined)}
            onRebaseline={(it) => write(it, { rebaseline: true }).then(() => undefined)}
            onOpen={onOpenItem}
            onToggleSkip={(it) => { guard(write(it, { skipped: !it.skipped }), 'defer that line'); }} />
        </>
      )}

      {view === 'scope' && (
        <RoadmapScope
          items={items} areas={areas} areaFilter={areaFilter} labelFilter={labelFilter}
          liveBranches={legacy.liveBranches || []} highlightId={legacy.highlightId}
          onEdit={legacy.onEdit} onDelete={legacy.onDelete} onBranch={legacy.onBranch}
          onClearNote={legacy.onClearNote} onToggleDone={legacy.onToggle}
          onReorder={(it, bucket, beforeId) => legacy.onReorder?.(it, bucket, beforeId)}
          onSetBucket={(it, bucket) => { guard(write(it, { bucket }), 'move that ticket'); }}
          onToggleSkip={(it) => { guard(write(it, { skipped: !it.skipped }), 'defer that line'); }}
          onArchive={(it, archived) => { guard(write(it, { archived }), 'archive that ticket'); }}
          onSchedule={(it) => {
            setView('timeline');
            setSelectedId(it.id);
            if (!it.sched) {
              const len = Math.max(1, Math.round(it.estimate ?? 2));
              const end = items
                .filter((x) => x.area === it.area && x.sched)
                .reduce((n, x) => Math.max(n, x.sched!.start + x.sched!.len), 0);
              guard(write(it, { sched: { start: end, len } }), 'schedule that ticket');
            }
          }}
          onAdd={(bucket: Priority) => legacy.onAdd(bucket, areaFilter || undefined)} />
      )}

      {view === 'plan' && (
        <RoadmapPlan
          items={items} lists={lists} areas={areas} areaFilter={areaFilter}
          labelFilter={labelFilter} onSetLabelFilter={setLabelFilter}
          onMoveToList={(it, listKey) => { guard(write(it, { listKey }), 'move that card'); }}
          onSetBucket={(it, bucket) => { guard(write(it, { bucket }), 'change that card’s scope'); }}
          onToggleLabel={(it, id) => {
            const next = it.labels.includes(id) ? it.labels.filter((l) => l !== id) : [...it.labels, id];
            guard(write(it, { labels: next }), 'change that card’s labels');
          }}
          onArchive={(it, archived) => { guard(write(it, { archived }), 'archive that card'); }}
          onAddCard={(listKey, title) => {
            guard(
              createRoadmapItem(slug, { title, note: '', bucket: 'should', area: areaFilter || undefined })
                .then((created) => {
                  onItemAdded(created);
                  return patchRoadmapItem(slug, created.id, { listKey }).then(onItemChanged);
                }),
              'add that card');
          }}
          onAddList={(name) => { guard(addListApi(slug, name).then((l) => setLists((ls) => [...ls, l])), 'add that list'); }}
          onOpen={onOpenItem} />
      )}

      {!PLAN_VIEWS.has(view) && (
        <Roadmap {...legacy} roadmap={roadmap} slug={slug} controlledView={view as 'tiers' | 'parked'} />
      )}
    </div>
  );
}

export { arrangementCount };
