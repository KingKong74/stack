// The Roadmap tab's SCOPE view — MoSCoW lanes, one row per ticket.
//
// This REPLACES the old Board view, and therefore has to carry everything the
// Board carried, not just the parts that suited a scope reading:
//
//  • THE ORDER WITHIN A LANE IS THE RUN QUEUE. `position` is what the fleet
//    works through once `tier` has sorted it (CLAUDE.md), so dragging a row up
//    or down inside its lane has to keep working — losing it would have quietly
//    removed the owner's only control over the queue's tiebreak. Dropping ONTO
//    a row inserts before it; dropping on the lane's empty space appends.
//    Dropping into a different lane changes the bucket, as before.
//  • EVERY TAG THE BOARD SHOWED IS HERE: the item number, the desire tier, the
//    auto cue, area, risk (with its source), the plan's step count, the parked
//    and in-progress states, the branch claim — plus the v2 labels and schedule.
//    A tag that vanished in the move would be a property the owner could no
//    longer see, on rows they are deciding about.
//  • A LIVE CLAIM IS READ-ONLY. Same rule the Board had (BUG-2): while a real
//    session is on that branch the row dims and its edit controls go, because
//    an edit would race the worker. A STALE claim keeps the ⚑ chip — it is
//    still the autopilot's don't-re-pick marker — but stays editable.
//
// What this view still does not do is reorder ACROSS buckets by position; a
// cross-lane drop is a bucket change and lands at the end, exactly as the Board
// behaved.

import { useState } from 'react';
import type { BoardArea, Priority, RoadmapItem } from '../types';
import { labelsOf } from '../lib/labels';

const LANES: { key: Priority; name: string; meta: string }[] = [
  { key: 'must', name: 'Must', meta: 'ships or the feature does not' },
  { key: 'should', name: 'Should', meta: 'in unless the cycle goes badly' },
  { key: 'could', name: 'Could', meta: 'first to cut' },
  { key: 'wont', name: "Won't", meta: 'out of scope — returned to Polaris' },
];

export interface ScopeProps {
  items: RoadmapItem[];
  areas: BoardArea[];
  areaFilter: string;
  labelFilter: string;
  /** Branches with a live session right now — what makes a claim read-only. */
  liveBranches: string[];
  highlightId?: string | null;
  onSetBucket: (item: RoadmapItem, bucket: Priority) => void;
  /** Drag-reorder: move `item` into `bucket` before `beforeId` (null = append). */
  onReorder: (item: RoadmapItem, bucket: Priority, beforeId: number | null) => void;
  onToggleDone: (item: RoadmapItem) => void;
  onToggleSkip: (item: RoadmapItem) => void;
  onArchive: (item: RoadmapItem, archived: boolean) => void;
  onSchedule: (item: RoadmapItem) => void;
  onEdit: (item: RoadmapItem) => void;
  onDelete: (item: RoadmapItem) => void;
  onBranch?: (item: RoadmapItem) => void;
  onClearNote?: (item: RoadmapItem, field: 'note' | 'refineNote') => void;
  onAdd: (bucket: Priority) => void;
}

export function RoadmapScope({
  items, areas, areaFilter, labelFilter, liveBranches, highlightId,
  onSetBucket, onReorder, onToggleDone, onToggleSkip, onArchive, onSchedule,
  onEdit, onDelete, onBranch, onClearNote, onAdd,
}: ScopeProps) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  // What the dragged row is hovering: an item id = insert before it,
  // `lane-<bucket>` = append to that lane.
  const [over, setOver] = useState<string | null>(null);

  const dotOf = (area: string) => areas.find((a) => a.name === area)?.dot || 'var(--line-3)';
  const visible = items.filter((i) =>
    !i.archived && !i.done
    && (areaFilter === '' || i.area === areaFilter)
    && (labelFilter === '' || i.labels.includes(labelFilter)));

  const drop = (bucket: Priority, beforeId: number | null) => {
    const it = items.find((x) => x.id === dragId);
    setDragId(null);
    setOver(null);
    if (!it) return;
    if (it.bucket === bucket && beforeId === it.id) return;
    if (it.bucket !== bucket && beforeId === null) onSetBucket(it, bucket);
    else onReorder(it, bucket, beforeId);
  };

  return (
    <div className="rs">
      {LANES.map((lane) => {
        const rows = visible.filter((i) => i.bucket === lane.key);
        const sized = rows.filter((r) => r.estimate !== null);
        const weeks = Math.round(sized.reduce((n, r) => n + (r.estimate ?? 0), 0) * 10) / 10;
        return (
          <div className={`rs-lane ${lane.key}${over === `lane-${lane.key}` ? ' over' : ''}`} key={lane.key}
            onDragOver={(e) => { if (dragId != null) { e.preventDefault(); setOver(`lane-${lane.key}`); } }}
            onDragLeave={() => setOver((k) => (k === `lane-${lane.key}` ? null : k))}
            onDrop={(e) => { e.preventDefault(); drop(lane.key, null); }}>
            <div className="rs-head">
              <div className="nm">{lane.name}</div>
              <div className="meta">{lane.meta}</div>
              <div className="tot">
                {rows.length} item{rows.length === 1 ? '' : 's'}
                {/* The weeks figure counts only what has been sized, and says
                    so — a lane total that silently treated unsized lines as
                    zero would make an unplanned lane look cheap. */}
                {sized.length > 0 && ` · ${weeks}w`}
                {sized.length < rows.length && ` (${rows.length - sized.length} unsized)`}
              </div>
              <button className="rs-add" onClick={() => onAdd(lane.key)}>+ Add</button>
            </div>

            <div className="rs-body">
              {rows.map((it) => {
                // BUG-2: only a LIVE session makes a claim read-only. A stale
                // claim keeps its chip but the row stays fully editable.
                const working = !!it.claimedBy && liveBranches.includes(it.claimedBy);
                return (
                  <div className={`rs-item${it.skipped ? ' cut' : ''}${working ? ' working' : ''}`
                    + `${dragId === it.id ? ' drag' : ''}${over === String(it.id) ? ' drop-before' : ''}`
                    + `${highlightId === String(it.id) ? ' hl' : ''}`}
                    key={it.id} data-hl={it.id}
                    draggable={!working}
                    onDragStart={(e) => {
                      if (working) return;
                      setDragId(it.id);
                      e.dataTransfer.setData('text/plain', String(it.id));
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => { setDragId(null); setOver(null); }}
                    onDragOver={(e) => {
                      if (dragId != null && dragId !== it.id) {
                        e.preventDefault(); e.stopPropagation(); setOver(String(it.id));
                      }
                    }}
                    onDragLeave={() => setOver((k) => (k === String(it.id) ? null : k))}
                    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); drop(lane.key, it.id); }}
                    onClick={() => setOpenId(openId === it.id ? null : it.id)}>

                    <button className="rs-check" title="Mark done — moves to the Review room"
                      aria-label="Mark done"
                      onClick={(e) => { e.stopPropagation(); onToggleDone(it); }} />

                    <span className="rs-main">
                      <span className="num">#{it.id}</span>
                      <span className="dot" style={{ background: dotOf(it.area) }} />
                      <span className="t">{it.title}</span>

                      {it.tier && (
                        <span className={`tier-chip t${it.tier}`}
                          title={`Desire tier ${it.tier} (#227) — the run queue works S, then A, B, C, then unranked`}>
                          {it.tier}
                        </span>
                      )}
                      {it.source === 'hook' && <span className="auto-cue" title="Auto-extracted from a push">auto</span>}
                      {it.area && <span className="area-chip">{it.area}</span>}
                      {labelsOf(it.labels).map((l) => (
                        <span key={l.id} className={`rl rl-${l.tone}`}>{l.name}</span>
                      ))}
                      {it.risk !== 'normal' && (
                        <span className={`risk-chip ${it.risk}`}
                          title={(it.risk === 'low'
                            ? 'Low risk — a green overnight run merges itself; you still give the verdict'
                            : 'High risk — extra care; never auto-merged') + (it.riskReason ? `\n${it.riskReason}` : '')}>
                          {it.risk === 'low' ? '⇣ low risk' : '⇡ high risk'}
                          {it.riskSource === 'auto' && <span className="src">auto</span>}
                        </span>
                      )}
                      {it.plan.length > 0 && (
                        <span className="plan-chip"
                          title={`Implementation plan — ${it.plan.filter((s) => s.done).length} of ${it.plan.length} steps done`}>
                          ☰ {it.plan.filter((s) => s.done).length}/{it.plan.length}
                        </span>
                      )}
                      {working && <span className="work-chip" title={`Claimed by ${it.claimedBy} — read-only while the work is in flight`}>● in progress</span>}
                      {!working && it.claimedBy && <span className="rs-claim" title={`Claimed by ${it.claimedBy} — no live session on it`}>⚑ {it.claimedBy}</span>}
                      {it.skipped && <span className="skip-chip" title="Parked — not to be picked up yet">⏸ parked</span>}
                      {it.sched && <span className="rs-sched" title="Scheduled on the timeline">wk {it.sched.start + 1}</span>}
                    </span>

                    <span className="w">{it.estimate === null ? '—' : `${it.estimate}w`}</span>

                    {!working && (
                      <span className="rs-tools" onClick={(e) => e.stopPropagation()}>
                        {onBranch && !it.claimedBy && !it.skipped && (
                          <button onClick={() => onBranch(it)} aria-label="Branch for focused work"
                            title="Branch for focused work (#205) — claims the branch and opens a primed session">⎇</button>
                        )}
                        <button onClick={() => onToggleSkip(it)} aria-label={it.skipped ? 'Unpark' : 'Park'}
                          title={it.skipped ? 'Unpark — back in play' : 'Park — skip for now'}>{it.skipped ? '▶' : '⏸'}</button>
                        <button onClick={() => onEdit(it)} aria-label="Edit item" title="Edit">✎</button>
                        <button onClick={() => onDelete(it)} aria-label="Delete item" title="Delete">×</button>
                      </span>
                    )}

                    {openId === it.id && (
                      <div className="rs-detail" onClick={(e) => e.stopPropagation()}>
                        {it.note && (
                          <div className="rs-note-row">
                            <div className="rs-note">{it.note}</div>
                            {onClearNote && (
                              <button className="note-clear" title="Remove this note"
                                onClick={() => onClearNote(it, 'note')}>×</button>
                            )}
                          </div>
                        )}
                        {it.refineNote && (
                          <div className="rs-note-row">
                            <div className="rs-note refine">✎ {it.refineNote}</div>
                            {onClearNote && (
                              <button className="note-clear" title="Remove this pending refinement"
                                onClick={() => onClearNote(it, 'refineNote')}>×</button>
                            )}
                          </div>
                        )}
                        <div className="rs-acts">
                          {LANES.filter((l) => l.key !== it.bucket).map((l) => (
                            <button key={l.key} className="rs-move" onClick={() => onSetBucket(it, l.key)}>
                              → {l.name}
                            </button>
                          ))}
                          <button className="rs-move accent" onClick={() => onSchedule(it)}>
                            {it.sched ? 'On the timeline' : 'Schedule'}
                          </button>
                          <button className="rs-move" onClick={() => onArchive(it, true)}>Archive</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {rows.length === 0 && <div className="rs-empty">Drop a ticket here</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
