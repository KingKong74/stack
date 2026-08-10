// The Roadmap tab's PLAN view — the lists board.
//
// Cards move between owner-named columns by drag. The rules that are not
// obvious from looking at it:
//
//  • A COLUMN IS NOT A VERDICT. Dropping a card in "Shipped" moves the card and
//    nothing else — it does not tick the item. `done` is a verdict the Review
//    room owns, and a board that ticked things by drag would manufacture the
//    verdicts #263 spent so much care constraining.
//  • AN UNTOUCHED CARD HAS NO STORED COLUMN. `listKey` is '' until somebody
//    moves it, and `listKeyOf` derives where it belongs from the state the row
//    already carries. That is why an existing project opens already sorted
//    rather than with every card piled in the first column.
//  • THE LABEL SET IS FIXED (lib/labels.ts). Toggling one writes ids; the
//    server drops anything it does not know, so a card can never carry a label
//    nothing can render.
//  • ARCHIVING IS NOT DELETING AND NOT PARKING. Three states, three meanings —
//    see schema.sql. The archive strip is where the third one lives, and every
//    row in it is one press from coming back — which is why "Archive all" on
//    the Shipped lane is a two-press confirm and not a modal: reversible, but
//    not so reversible that a misclick should be able to empty a lane.
//  • AN ARCHIVED ROW REMEMBERS ITS LANE, and nothing had to be stored for that.
//    Archiving changes `archived` and nothing else, so `listKeyOf` still
//    resolves the column the card was sitting in. The strip names it, because
//    "Threading" tells you nothing about whether it shipped or was abandoned in
//    Planned — and Restore puts it back in exactly that column.
//  • A CLICK OPENS THE CARD, A DOUBLE-CLICK OPENS THE ITEM. The inline detail is
//    for the two things you change constantly (labels and scope); everything
//    else lives in the modal. A double-click toggles the detail twice on its way
//    through, which lands it back where it started — harmless, and cheaper than
//    a click-delay timer that would make every single click feel slow.
//
// Lists is one of THREE boards here; Tiers and Parked are in RoadmapBoards.tsx,
// and the switcher between them is this view's own, not the tab's.

import { useState } from 'react';
import type { BoardArea, BoardList, Priority, RoadmapItem } from '../types';
import { areaMatches, listKeyOf } from '../lib/plan';
import { LABELS, labelsOf } from '../lib/labels';

const BUCKETS: Priority[] = ['must', 'should', 'could', 'wont'];
const BUCKET_LABEL: Record<Priority, string> = {
  must: 'Must', should: 'Should', could: 'Could', wont: "Won't",
};

export interface PlanProps {
  items: RoadmapItem[];
  lists: BoardList[];
  areas: BoardArea[];
  areaFilter: string;
  labelFilter: string;
  onSetLabelFilter: (id: string) => void;
  onMoveToList: (item: RoadmapItem, listKey: string) => void;
  onSetBucket: (item: RoadmapItem, bucket: Priority) => void;
  onToggleLabel: (item: RoadmapItem, labelId: string) => void;
  onArchive: (item: RoadmapItem, archived: boolean) => void;
  /** Bulk archive, applied by the parent so a partial failure is reported once. */
  onArchiveMany: (items: RoadmapItem[]) => void;
  onAddCard: (listKey: string, title: string) => void;
  onAddList: (name: string) => void;
  onOpen: (item: RoadmapItem) => void;
}

export function RoadmapPlan({
  items, lists, areas, areaFilter, labelFilter, onSetLabelFilter,
  onMoveToList, onSetBucket, onToggleLabel, onArchive, onArchiveMany, onAddCard, onAddList, onOpen,
}: PlanProps) {
  const [openCard, setOpenCard] = useState<number | null>(null);
  const [composer, setComposer] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [listDraft, setListDraft] = useState<string | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [confirmSweep, setConfirmSweep] = useState('');

  const dotOf = (area: string) => areas.find((a) => a.name === area)?.dot || 'var(--line-3)';

  const visible = items.filter((i) =>
    !i.archived
    && areaMatches(i.area, areaFilter)
    && (labelFilter === '' || i.labels.includes(labelFilter)));
  const archived = items.filter((i) => i.archived);
  // The column an archived card was sitting in. `listKeyOf` still answers,
  // because archiving does not touch `listKey`, `done` or `claimedBy`. A key
  // with no list left (its column was deleted) says so rather than rendering a
  // blank — the row went somewhere, and "somewhere" is not nowhere.
  const laneOf = (it: RoadmapItem) => {
    const key = listKeyOf(it);
    return lists.find((l) => l.key === key)?.name || 'a list since removed';
  };

  const submit = (fn: (v: string) => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const v = draft.trim();
      if (v) fn(v);
      setDraft(''); setComposer(null);
    } else if (e.key === 'Escape') { setDraft(''); setComposer(null); }
  };

  return (
    <div className="rp">
      <div className="rp-bar">
        <span className="lbl">Labels</span>
        {LABELS.map((l) => (
          <button key={l.id} className={`rl rl-${l.tone}${labelFilter === l.id ? ' on' : ''}`}
            onClick={() => onSetLabelFilter(labelFilter === l.id ? '' : l.id)}>{l.name}</button>
        ))}
        <button className="rp-archive-toggle" onClick={() => setShowArchive(!showArchive)}>
          {showArchive ? 'Hide archive' : `Archive${archived.length ? ` · ${archived.length}` : ''}`}
        </button>
      </div>

      {showArchive && (
        <div className="rp-archive">
          <div className="lbl">Archive</div>
          {archived.length ? archived.map((a) => (
            <div className="rp-archive-row" key={a.id}>
              <span className="dot" style={{ background: dotOf(a.area) }} />
              <span className="t">{a.title}</span>
              <span className="lane" title="The list it was archived from — Restore puts it back there">
                {laneOf(a)}
              </span>
              <button className="rail-link" onClick={() => onArchive(a, false)}>Restore</button>
            </div>
          )) : <div className="rail-empty">Nothing archived yet.</div>}
        </div>
      )}

      <div className="rp-cols">
        {lists.map((list) => {
          const cards = visible.filter((i) => listKeyOf(i) === list.key);
          return (
            <div className="rp-col" key={list.key}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const it = items.find((x) => x.id === Number(e.dataTransfer.getData('text/plain')));
                if (it) onMoveToList(it, list.key);
              }}>
              <div className="rp-col-head">
                <span className="nm">{list.name}</span>
                <span className="n">{cards.length}</span>
                {/* Shipped is the one lane work PILES UP in — every other column
                    is somewhere a card is passing through. The sweep archives
                    exactly the cards ON SCREEN, so it can never touch rows the
                    area or label filter is hiding: a bulk action whose reach is
                    wider than its view is how you lose work you never saw. */}
                {list.key === 'shipped' && cards.length > 0 && (
                  confirmSweep === list.key ? (
                    <span className="rp-sweep-confirm">
                      <button className="go" onClick={() => { onArchiveMany(cards); setConfirmSweep(''); }}>
                        Archive {cards.length}?
                      </button>
                      <button className="no" onClick={() => setConfirmSweep('')}>Cancel</button>
                    </span>
                  ) : (
                    <button className="rp-sweep" onClick={() => setConfirmSweep(list.key)}
                      title={`Archive the ${cards.length} card${cards.length === 1 ? '' : 's'} shown here${
                        areaFilter || labelFilter ? ' — the filter is on, so only these' : ''}`}>
                      Archive all
                    </button>
                  )
                )}
              </div>

              {cards.map((c) => (
                <div className="rp-card" key={c.id} draggable
                  onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(c.id)); e.dataTransfer.effectAllowed = 'move'; }}
                  onClick={() => setOpenCard(openCard === c.id ? null : c.id)}
                  onDoubleClick={() => onOpen(c)}
                  title="Click for labels and scope · double-click to open">
                  {c.labels.length > 0 && (
                    <div className="rp-stripes">
                      {labelsOf(c.labels).map((l) => (
                        <span key={l.id} className={`rp-stripe rl-${l.tone}`} title={l.name} />
                      ))}
                    </div>
                  )}
                  <div className="rp-title">{c.title}</div>
                  <div className="rp-meta">
                    <span className="dot" style={{ background: dotOf(c.area) }} />
                    <span className="area">{c.area || 'untagged'}</span>
                    <span className={`rp-mos ${c.bucket}`}>{BUCKET_LABEL[c.bucket]}</span>
                    <span className="est">{c.estimate === null ? '' : `${c.estimate}w`}</span>
                  </div>

                  {openCard === c.id && (
                    <div className="rp-detail" onClick={(e) => e.stopPropagation()}>
                      {c.note && <div className="rp-note">{c.note}</div>}

                      <div className="lbl">Labels</div>
                      <div className="rp-toggles">
                        {LABELS.map((l) => (
                          <button key={l.id} className={`rl rl-${l.tone}${c.labels.includes(l.id) ? ' on' : ''}`}
                            onClick={() => onToggleLabel(c, l.id)}>{l.name}</button>
                        ))}
                      </div>

                      <div className="lbl">Scope</div>
                      <div className="rp-toggles">
                        {BUCKETS.map((b) => (
                          <button key={b} className={`rp-mos ${b}${c.bucket === b ? ' on' : ''}`}
                            onClick={() => onSetBucket(c, b)}>{BUCKET_LABEL[b]}</button>
                        ))}
                      </div>

                      <div className="rp-acts">
                        <button className="rail-link" onClick={() => onOpen(c)}>Open</button>
                        <button className="rail-link" onClick={() => onArchive(c, true)}>Archive</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {composer === list.key ? (
                <input className="field-input sm" autoFocus value={draft} placeholder="Card title, then Enter"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={submit((v) => onAddCard(list.key, v))} />
              ) : (
                <button className="rp-add" onClick={() => { setComposer(list.key); setDraft(''); }}>+ Add a card</button>
              )}
            </div>
          );
        })}

        <div className="rp-col newlist">
          {listDraft !== null ? (
            <input className="field-input sm" autoFocus value={listDraft} placeholder="List name, then Enter"
              onChange={(e) => setListDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { const v = listDraft.trim(); if (v) onAddList(v); setListDraft(null); }
                else if (e.key === 'Escape') setListDraft(null);
              }} />
          ) : (
            <button className="rp-add-list" onClick={() => setListDraft('')}>+ Add another list</button>
          )}
        </div>
      </div>
    </div>
  );
}
