import { useState } from 'react';
import type { RoadmapItem, Roadmap as RoadmapData } from '../types';
import { tierRank } from '../types';
import { isApproved } from '../lib/approval';
import { labelsOf } from '../lib/labels';
import { timeAgo } from '../lib/ui';

// THE ROADMAP TAB — the kit's IdeasScreen, on Stack's own rows.
//
// "Rough notes stay here until they earn a branch." That sentence is the whole
// boundary between this tab and the board beside it, and it is why this is not
// a second board over one table (which CLAUDE.md forbids, and rightly): the
// board is work IN FLIGHT — claimed, building, shipped, verdicted — and this is
// everything that has not started. An item leaves this tab the moment it takes
// a branch claim, and it never comes back, because from then on the board is
// the thing that knows where it is.
//
// THE THREE COLUMNS ARE READ OFF COLUMNS THAT ALREADY MEAN THIS. Nothing new is
// stored and nothing here writes a tier:
//
//   Parked   — `skipped`. An exact match: Stack's park is already "cut from
//              this cycle, still part of the feature", which is what the kit's
//              Parked column says in words.
//   Ready    — has a TIER (#227). The tier is how much the owner wants it NEXT
//              and is the run queue's primary sort, so a tiered item is by
//              definition the one ready to earn a branch.
//   Thinking — no tier. Captured, kept, and not yet ranked.
//
// HELD ITEMS ARE NOT HERE. A `hook` or `fly` row awaiting sign-off lives in
// For you → Auto-ideas (the kit: "accepting one files it into Ideas"), so this
// tab shows what you have actually kept. Two inboxes for one queue would mean
// approving the same row in two places.

type Col = { key: string; label: string; note: string; items: RoadmapItem[] };

const bucketRank: Record<string, number> = { must: 0, should: 1, could: 2, wont: 3 };

function order(a: RoadmapItem, b: RoadmapItem): number {
  const t = tierRank(a.tier) - tierRank(b.tier);
  if (t) return t;
  const k = (bucketRank[a.bucket] ?? 9) - (bucketRank[b.bucket] ?? 9);
  if (k) return k;
  return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
}

export function Ideas({ roadmap, labels, onOpen, onPark, onDelete }: {
  roadmap: RoadmapData;
  labels: { key: string; name: string; tone: string }[];
  onOpen: (it: RoadmapItem) => void;
  onPark: (it: RoadmapItem, parked: boolean) => void;
  onDelete: (it: RoadmapItem) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);

  const all = [...roadmap.must, ...roadmap.should, ...roadmap.could, ...roadmap.wont];
  // Kept, unstarted work. `claimedBy` is the line: a claim means it earned its
  // branch and the board owns it from here.
  const capture = all.filter((i) => !i.done && !i.claimedBy && isApproved(i));
  const cols: Col[] = [
    {
      key: 'ready', label: 'Ready', note: 'ranked — the runner picks from here',
      items: capture.filter((i) => !i.skipped && i.tier).sort(order),
    },
    {
      key: 'thinking', label: 'Thinking', note: 'kept, not yet ranked',
      items: capture.filter((i) => !i.skipped && !i.tier).sort(order),
    },
    {
      key: 'parked', label: 'Parked', note: 'cut from this cycle, still on the books',
      items: capture.filter((i) => i.skipped).sort(order),
    },
  ];

  const ready = cols[0].items.length;

  return (
    <div className="ideas">
      <div className="ideas-head">
        <div className="ideas-lede">
          Rough notes stay here until they earn a branch. An item leaves this tab the moment it
          takes a claim — from then on the board knows where it is.
        </div>
        <span className="ideas-count">
          {capture.length} captured · {ready} ready to pick up
        </span>
      </div>

      <div className="ideas-cols">
        {cols.map((col) => (
          <div className="ideas-col" key={col.key}>
            <div className="ideas-colhead">
              <span className={`lbl ${col.key}`}>{col.label}</span>
              <span className="n">{col.items.length}</span>
              <span className="note">{col.note}</span>
            </div>

            {col.items.length === 0 && (
              <div className="ideas-empty">Nothing {col.label.toLowerCase()}.</div>
            )}

            {col.items.map((it) => (
              <IdeaCard key={it.id} item={it} labels={labels} ready={col.key === 'ready'}
                open={open === it.id} onToggle={() => setOpen(open === it.id ? null : it.id)}
                onOpen={onOpen} onPark={onPark} onDelete={onDelete} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function IdeaCard({ item, labels, ready, open, onToggle, onOpen, onPark, onDelete }: {
  item: RoadmapItem;
  labels: { key: string; name: string; tone: string }[];
  ready: boolean; open: boolean; onToggle: () => void;
  onOpen: (it: RoadmapItem) => void;
  onPark: (it: RoadmapItem, parked: boolean) => void;
  onDelete: (it: RoadmapItem) => void;
}) {
  const mine = labelsOf(item.labels, labels);
  // Where it came from, in the words of the thing that filed it. A card that
  // cannot say this is one you have to remember writing.
  const from = item.source === 'hook' ? 'extracted from a push'
    : item.source === 'fly' ? `opened by ${item.flySession || 'a live session'}`
      : 'captured by hand';

  return (
    <div className={`idea${open ? ' open' : ''}${ready ? ' ready' : ''}${item.skipped ? ' parked' : ''}`}
      onClick={onToggle}>
      <div className="idea-top">
        <span className="mark" aria-hidden="true">{item.skipped ? '⏸' : '✦'}</span>
        <span className="t">{item.title}</span>
        {item.estimate != null && <span className="est">{item.estimate}w</span>}
      </div>

      {item.note && <p className={`idea-note${open ? '' : ' clamp'}`}>{item.note}</p>}

      <div className="idea-meta">
        <span className="id">#{item.id}</span>
        {item.tier && <span className={`tierchip t${item.tier}`}>{item.tier}</span>}
        <span className="bucket">{item.bucket}</span>
        {item.area && <span className="area">{item.area}</span>}
        {mine.map((l) => <span key={l.key} className={`rl rl-${l.tone} on`}>{l.name}</span>)}
        <span className="age">{timeAgo(item.updatedAt)}</span>
      </div>

      {open && (
        <div className="idea-acts" onClick={(e) => e.stopPropagation()}>
          <span className="from">{from}</span>
          <button className="rail-link" onClick={() => onOpen(item)}>Open</button>
          <button className="rail-link" onClick={() => onPark(item, !item.skipped)}
            title={item.skipped
              ? 'Unpark — back into this cycle, and back in front of the runner'
              : 'Park — cut from this cycle, still part of the feature and still on the books'}>
            {item.skipped ? 'Unpark' : 'Park'}
          </button>
          <button className="rail-link danger" onClick={() => onDelete(item)}
            title="Delete this item — not the same as parking it">Delete</button>
        </div>
      )}
    </div>
  );
}
