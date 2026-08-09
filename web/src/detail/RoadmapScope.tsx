// The Roadmap tab's SCOPE view — MoSCoW lanes, one row per ticket.
//
// This is the design's "scope board": the same four buckets the board has
// always had, but read as a scope decision (what is in this cycle, what is
// first to cut) rather than as four parallel to-do columns. Dragging a ticket
// between lanes changes its bucket, which is the only thing a bucket means.
//
// What this view deliberately does NOT do: reorder within a lane. `position` IS
// the run queue (CLAUDE.md), and a lane laid out for reading scope is the wrong
// instrument for setting the order the fleet builds in — that stays on the
// Board and Tiers views, which are still here. A scope view that quietly
// reshuffled the queue would be changing something the owner cannot see from
// where they are standing.

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
  onSetBucket: (item: RoadmapItem, bucket: Priority) => void;
  onToggleSkip: (item: RoadmapItem) => void;
  onArchive: (item: RoadmapItem, archived: boolean) => void;
  onSchedule: (item: RoadmapItem) => void;
  onOpen: (item: RoadmapItem) => void;
  onAdd: (bucket: Priority) => void;
}

export function RoadmapScope({
  items, areas, areaFilter, labelFilter,
  onSetBucket, onToggleSkip, onArchive, onSchedule, onOpen, onAdd,
}: ScopeProps) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [overLane, setOverLane] = useState<Priority | null>(null);

  const dotOf = (area: string) => areas.find((a) => a.name === area)?.dot || 'var(--line-3)';
  const visible = items.filter((i) =>
    !i.archived && !i.done
    && (areaFilter === '' || i.area === areaFilter)
    && (labelFilter === '' || i.labels.includes(labelFilter)));

  return (
    <div className="rs">
      {LANES.map((lane) => {
        const rows = visible.filter((i) => i.bucket === lane.key);
        const sized = rows.filter((r) => r.estimate !== null);
        const weeks = Math.round(sized.reduce((n, r) => n + (r.estimate ?? 0), 0) * 10) / 10;
        return (
          <div className={`rs-lane ${lane.key}${overLane === lane.key ? ' over' : ''}`} key={lane.key}
            onDragOver={(e) => { e.preventDefault(); setOverLane(lane.key); }}
            onDragLeave={() => setOverLane((k) => (k === lane.key ? null : k))}
            onDrop={(e) => {
              e.preventDefault();
              setOverLane(null);
              const it = items.find((x) => x.id === Number(e.dataTransfer.getData('text/plain')));
              if (it && it.bucket !== lane.key) onSetBucket(it, lane.key);
            }}>
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
              {rows.map((it) => (
                <div className={`rs-item${it.skipped ? ' cut' : ''}`} key={it.id} draggable
                  onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(it.id)); e.dataTransfer.effectAllowed = 'move'; }}
                  onClick={() => setOpenId(openId === it.id ? null : it.id)}>
                  <span className="dot" style={{ background: dotOf(it.area) }} />
                  <span className="t">{it.title}</span>
                  {labelsOf(it.labels).map((l) => (
                    <span key={l.id} className={`rl rl-${l.tone}`}>{l.name}</span>
                  ))}
                  {it.claimedBy && <span className="rs-claim" title={it.claimedBy}>⎇ claimed</span>}
                  {it.sched && <span className="rs-sched">wk {it.sched.start + 1}</span>}
                  <span className="w">{it.estimate === null ? '—' : `${it.estimate}w`}</span>

                  {openId === it.id && (
                    <div className="rs-detail" onClick={(e) => e.stopPropagation()}>
                      {it.note && <div className="rs-note">{it.note}</div>}
                      <div className="rs-acts">
                        {LANES.filter((l) => l.key !== it.bucket).map((l) => (
                          <button key={l.key} className="rs-move" onClick={() => onSetBucket(it, l.key)}>
                            → {l.name}
                          </button>
                        ))}
                        <button className="rs-move accent" onClick={() => onSchedule(it)}>
                          {it.sched ? 'On the timeline' : 'Schedule'}
                        </button>
                        <button className="rs-move" onClick={() => onToggleSkip(it)}>
                          {it.skipped ? 'Bring back' : 'Defer'}
                        </button>
                        <button className="rs-move" onClick={() => onArchive(it, true)}>Archive</button>
                        <button className="rs-move" onClick={() => onOpen(it)}>Open</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {rows.length === 0 && <div className="rs-empty">Drop a ticket here</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
