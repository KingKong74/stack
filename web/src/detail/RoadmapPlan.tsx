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
//  • THE LABELS ARE THE OWNER'S (#382), not a code registry, and they arrive
//    with the board read. They are a MENU rather than a strip of chips because
//    a set you can add to has no ceiling, and eleven filter chips across the top
//    of a board is a legend nobody asked for. Deleting one takes it off every
//    card — server-side, in one transaction — so the delete is a two-press
//    confirm that SAYS how many cards it touches.
//  • ARCHIVING IS NOT DELETING AND NOT PARKING. Three states, three meanings —
//    see schema.sql. The archive strip is where the third one lives, and every
//    row in it is one press from coming back — which is why "Archive all" on
//    the Shipped lane is a two-press confirm and not a modal: reversible, but
//    not so reversible that a misclick should be able to empty a lane. DELETE
//    is the one action here that is none of those things: it goes through the
//    parent's confirm modal, the same one Scope's × opens.
//  • REVIEWING FROM THE SHIPPED LANE (#382) records the SAME verdict the Review
//    room records — `review_tag: 'solid'` — and archives the card in the same
//    write. What it does NOT do is tick the item: approving has never meant
//    done (the merge job ticks, with the human's verdict already stored), and a
//    board that ticked on approval would be manufacturing the state the whole
//    verdict chain exists to keep honest. A card with no `built_note` says so
//    rather than presenting a title as evidence — the NULL-verdict rule.
//  • FOUR LANES ARE LOCKED, THE REST ARE THE OWNER'S. `idea`, `planned`,
//    `progress` and `shipped` are where `listKeyOf` derives cards to and where
//    the Review room moves work through, so their keys are wiring: rename one
//    and every derived card lands in a column that no longer exists. They carry
//    a lock and no menu. A lane the owner ADDS is pure convenience — nothing
//    derives into it — so it renames and deletes freely, and deleting it returns
//    its cards to the derived column rather than taking them with it. The real
//    guard is on the API (server/src/lists.js); this is only the affordance.
//  • IN PROGRESS AND SHIPPED ARE THE REVIEW ROOM'S TWO ENDS. A change is in the
//    Review room's queue from the moment it is BUILT (#374), which is exactly
//    while it sits in In progress — so both lanes link into that room, per card
//    and per lane, and a verdict given there brings the card back to Shipped
//    (server/src/lists.js). The predicate is `isBuilt` from lib/spine, the same
//    one the Overview's verdict queue counts: a lane saying "3 waiting" beside a
//    room showing 4 is two answers to one question.
//  • FOCUS IS READING, NOT STATE. A lane opens to ~2.3× its width so a card's
//    built note and labels are legible without opening anything, and it is
//    per-visit — the board is a place you scan, and a column left wide from
//    last week is furniture nobody asked for. One at a time: two wide lanes on
//    a 262px grid is a horizontal scroll with no board left in view. CLICKING
//    THE LANE is the gesture and the ⇥ is the label for it; `toggleFocusFromLane`
//    is what keeps the click off everything inside a lane that means something
//    else, and its comment says why that guard lives in one place.
//  • A CLICK OPENS THE CARD, A DOUBLE-CLICK OPENS THE ITEM. The inline detail is
//    for the things you change constantly (labels and scope); everything
//    else lives in the modal. A double-click toggles the detail twice on its way
//    through, which lands it back where it started — harmless, and cheaper than
//    a click-delay timer that would make every single click feel slow.
//
// Lists is one of THREE boards here; Tiers and Parked are in RoadmapBoards.tsx,
// and the switcher between them is this view's own, not the tab's.

import { useEffect, useRef, useState } from 'react';
import type { BoardArea, BoardLabel, BoardList, Priority, RoadmapItem } from '../types';
import { areaMatches, listKeyOf } from '../lib/plan';
import { isBuilt } from '../lib/spine';
import { hrefTo } from '../lib/route';
import { LABEL_TONES, labelsOf } from '../lib/labels';

const BUCKETS: Priority[] = ['must', 'should', 'could', 'wont'];
const BUCKET_LABEL: Record<Priority, string> = {
  must: 'Must', should: 'Should', could: 'Could', wont: "Won't",
};

// The two lanes that are the Review room's ends — see the header. Named once so
// the per-card strip, the lane head link and the styling cannot drift apart.
const REVIEW_LANES = new Set(['progress', 'shipped']);

// DRAWN, not typed. A 🔒 renders as a tofu box in the display face this board
// uses — an empty rectangle where the explanation was supposed to be, which is
// worse than no affordance at all. An inline SVG in currentColor always draws
// and follows the theme.
const LockIcon = () => (
  <svg className="rp-lock-ico" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">
    <path d="M3.6 5.2V3.9a2.4 2.4 0 0 1 4.8 0v1.3" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <rect x="2.4" y="5.2" width="7.2" height="5.4" rx="1.1" fill="currentColor" />
  </svg>
);

export interface PlanProps {
  /** The project, for the Review room link — a room-wide queue needs to be told whose change. */
  slug: string;
  items: RoadmapItem[];
  lists: BoardList[];
  areas: BoardArea[];
  /** #382 — the project's own labels, in board order. */
  labels: BoardLabel[];
  /** The tones a new label may wear; falls back to the client's own set. */
  tones?: string[];
  areaFilter: string;
  labelFilter: string;
  onSetLabelFilter: (id: string) => void;
  onAddLabel: (name: string, tone: string) => void;
  onDeleteLabel: (key: string) => void;
  onMoveToList: (item: RoadmapItem, listKey: string) => void;
  onSetBucket: (item: RoadmapItem, bucket: Priority) => void;
  onToggleLabel: (item: RoadmapItem, labelId: string) => void;
  onArchive: (item: RoadmapItem, archived: boolean) => void;
  /** Bulk archive, applied by the parent so a partial failure is reported once. */
  onArchiveMany: (items: RoadmapItem[]) => void;
  /** The parent's confirm modal — deleting is not archiving and asks first. */
  onDelete: (item: RoadmapItem) => void;
  /** Verdict + archive in one write. Never ticks the item; see the header. */
  onApprove: (item: RoadmapItem) => void;
  /** It did not hold up: un-tick, clear the claim, back to the derived column. */
  onSendBack: (item: RoadmapItem) => void;
  onAddCard: (listKey: string, title: string) => void;
  onAddList: (name: string) => void;
  /** Rename an owner-added lane. Never called for a locked one. */
  onRenameList: (list: BoardList, name: string) => void;
  /** Remove an owner-added lane; its cards return to the derived column. */
  onDeleteList: (list: BoardList) => void;
  onOpen: (item: RoadmapItem) => void;
}

export function RoadmapPlan({
  slug, items, lists, areas, labels, tones, areaFilter, labelFilter, onSetLabelFilter,
  onAddLabel, onDeleteLabel, onMoveToList, onSetBucket, onToggleLabel, onArchive, onArchiveMany,
  onDelete, onApprove, onSendBack, onAddCard, onAddList, onRenameList, onDeleteList, onOpen,
}: PlanProps) {
  const [openCard, setOpenCard] = useState<number | null>(null);
  const [composer, setComposer] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [listDraft, setListDraft] = useState<string | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [confirmSweep, setConfirmSweep] = useState('');
  // Which card's review panel is open, and which card's label menu is open.
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [labelsFor, setLabelsFor] = useState<number | null>(null);
  // The widened lane — '' = none. One at a time; see the header.
  const [focus, setFocus] = useState('');
  // The lane being renamed, and the lane whose delete is armed. Both are keys,
  // and both are cleared by the other: a rename box left open behind an armed
  // delete is two pending changes to one column.
  const [renaming, setRenaming] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmList, setConfirmList] = useState('');

  // The Review room, opened ON this change. `slug#id` is the room's own row key.
  const reviewHref = (it: RoadmapItem) => hrefTo.control('review', `${slug}#${it.id}`);

  // CLICKING THE LANE IS THE GESTURE; the ⇥ is the label for it.
  //
  // The click sits on the whole column rather than on the head alone, because
  // the thing you aim at when you mean "this lane" is the lane — its title, the
  // gap beside its count, the empty space under its last card. What it must
  // never do is fire for a click that meant something ELSE, and everything
  // inside a lane means something else: a card opens its detail, a button acts,
  // a link navigates, a field takes typing. So this walks up from the target
  // and bails on any of them. The alternative — stopPropagation on every child
  // — is the same rule written a dozen times, and the one place somebody
  // forgets it is a card that silently resizes the board instead of opening.
  const INERT = '.rp-card, .rp-col-tools, .rp-col-review, button, a, input, textarea, select, label';
  const toggleFocusFromLane = (e: React.MouseEvent, key: string) => {
    if ((e.target as HTMLElement).closest(INERT)) return;
    setFocus((f) => (f === key ? '' : key));
  };

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
        <LabelMenu labels={labels} tones={tones && tones.length ? tones : LABEL_TONES}
          filter={labelFilter} onFilter={onSetLabelFilter}
          countOf={(key) => items.filter((i) => !i.archived && i.labels.includes(key)).length}
          onAdd={onAddLabel} onDelete={onDeleteLabel} />
        {/* The active filter stays OUTSIDE the menu: a filter you can only see
            by opening the thing that set it is a board quietly hiding rows. */}
        {labelFilter && (
          <button className={`rl rl-${labels.find((l) => l.key === labelFilter)?.tone || 'muted'} on`}
            onClick={() => onSetLabelFilter('')} title="Clear this label filter">
            {labels.find((l) => l.key === labelFilter)?.name || labelFilter} ×
          </button>
        )}
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
              {a.reviewTag && <span className="rp-verdict" title="The verdict recorded on it">✓ {a.reviewTag}</span>}
              <button className="rail-link" onClick={() => onArchive(a, false)}>Restore</button>
            </div>
          )) : <div className="rail-empty">Nothing archived yet.</div>}
        </div>
      )}

      <div className="rp-cols">
        {lists.map((list) => {
          const cards = visible.filter((i) => listKeyOf(i) === list.key);
          // How many cards in this lane the Review room is holding. Counted off
          // the SHOWN cards, like the sweep: a lane head that counts rows the
          // area filter is hiding is a number you cannot reconcile with the
          // column under it.
          const waiting = REVIEW_LANES.has(list.key) ? cards.filter(isBuilt).length : 0;
          const wide = focus === list.key;
          return (
            <div className={`rp-col${wide ? ' focus' : ''}`} key={list.key}
              onClick={(e) => toggleFocusFromLane(e, list.key)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const it = items.find((x) => x.id === Number(e.dataTransfer.getData('text/plain')));
                if (it) onMoveToList(it, list.key);
              }}>
              <div className="rp-col-head"
                title={wide ? 'Click the lane to close it' : 'Click the lane to open it wide enough to read'}>
                {renaming === list.key ? (
                  <input className="field-input sm" autoFocus value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => setRenaming('')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const v = renameDraft.trim();
                        if (v && v !== list.name) onRenameList(list, v);
                        setRenaming('');
                      } else if (e.key === 'Escape') setRenaming('');
                    }} />
                ) : (
                  <>
                    <span className="nm">{list.name}</span>
                    <span className="n">{cards.length}</span>
                  </>
                )}
                <span className="rp-col-tools">
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

                  {/* Rename and remove, for the lanes that are the owner's. A
                      locked lane gets the lock in place of the menu — the
                      affordance says WHY rather than going missing, since a
                      button absent from one column and present on the next
                      reads as a rendering fault. */}
                  {list.locked ? (
                    <span className="rp-col-lock"
                      title="A built-in lane. Cards are sorted into it automatically and the Review room moves work through it, so it cannot be renamed or removed — lanes you add yourself can be.">
                      <LockIcon />
                    </span>
                  ) : confirmList === list.key ? (
                    <span className="rp-sweep-confirm">
                      <button className="go" onClick={() => { setConfirmList(''); onDeleteList(list); }}
                        title="The cards stay — they go back to the lane their own state puts them in">
                        Remove lane{cards.length ? ` · ${cards.length} card${cards.length === 1 ? '' : 's'} stay` : ''}?
                      </button>
                      <button className="no" onClick={() => setConfirmList('')}>Cancel</button>
                    </span>
                  ) : (
                    <>
                      <button className="rp-col-act" title="Rename this lane"
                        onClick={() => { setConfirmList(''); setRenameDraft(list.name); setRenaming(list.key); }}>✎</button>
                      <button className="rp-col-act" title="Remove this lane — its cards are not deleted"
                        onClick={() => { setRenaming(''); setConfirmList(list.key); }}>×</button>
                    </>
                  )}

                  <button className={`rp-col-act${wide ? ' on' : ''}`} aria-pressed={wide}
                    onClick={() => setFocus(wide ? '' : list.key)}
                    title={wide ? 'Close this lane back to its column width' : 'Focus this lane — open it wide enough to read'}>
                    {wide ? '⇤' : '⇥'}
                  </button>
                </span>
              </div>

              {/* The lane's own tie to the Review room. It states the NUMBER
                  rather than just linking, because these two lanes are the only
                  place on this board where work is waiting on the owner
                  personally — and it is hidden at zero rather than drawn as a
                  grey 0, which reads as "the room is empty" when what it means
                  is "nothing of THIS lane is in it".

                  ITS OWN ROW, not a chip in the head. Inside the head it fought
                  the lane name for a 262px column and won: "In progress" broke
                  across two lines and the whole board's heads went out of
                  alignment. A line that only appears sometimes must not be able
                  to reflow the line that is always there. */}
              {waiting > 0 && (
                <a className="rp-col-review" href={hrefTo.control('review')}
                  title={`${waiting} change${waiting === 1 ? '' : 's'} in this lane ${
                    waiting === 1 ? 'is' : 'are'} waiting on your verdict in Mission Control’s Review room`}>
                  {waiting} waiting on your verdict →
                </a>
              )}

              {cards.map((c) => (
                <div className="rp-card" key={c.id} draggable
                  onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(c.id)); e.dataTransfer.effectAllowed = 'move'; }}
                  onClick={() => setOpenCard(openCard === c.id ? null : c.id)}
                  onDoubleClick={() => onOpen(c)}
                  title="Click for labels and scope · double-click to open">
                  {c.labels.length > 0 && (
                    <div className="rp-stripes">
                      {labelsOf(c.labels, labels).map((l) => (
                        <span key={l.key} className={`rp-stripe rl-${l.tone}`} title={l.name} />
                      ))}
                    </div>
                  )}
                  <div className="rp-title">{c.title}</div>
                  <div className="rp-meta">
                    <span className="dot" style={{ background: dotOf(c.area) }} />
                    <span className="area">{c.area || 'untagged'}</span>
                    <span className={`rp-mos ${c.bucket}`}>{BUCKET_LABEL[c.bucket]}</span>
                    <span className="est">{c.estimate === null ? '' : `${c.estimate}w`}</span>
                    {c.reviewTag && <span className="rp-verdict" title="Verdict already recorded">✓ {c.reviewTag}</span>}
                  </div>

                  {/* The card's own end of the Review room. Two states, and the
                      difference is the whole point of the link: a change still
                      IN the queue is waiting on the owner, and a change already
                      verdicted is a receipt you can go and re-read. A card in
                      these lanes with neither — claimed but nothing built yet —
                      shows nothing, because the room has never heard of it and
                      a link landing on an empty queue teaches the wrong thing. */}
                  {REVIEW_LANES.has(list.key) && (isBuilt(c) || c.reviewTag) && (
                    <a className={`rp-card-review${isBuilt(c) ? ' waiting' : ''}`}
                      href={reviewHref(c)} onClick={(e) => e.stopPropagation()}
                      title={isBuilt(c)
                        ? 'Open this change in Mission Control’s Review room — read what landed, then give it a verdict'
                        : 'Open this change in Mission Control’s Review room — the verdict is already on record'}>
                      {isBuilt(c) ? 'Waiting on your verdict' : `Verdicted ${c.reviewTag}`} →
                    </a>
                  )}

                  {list.key === 'shipped' && (
                    <div className="rp-shipped-acts" onClick={(e) => e.stopPropagation()}>
                      <button className="rail-link"
                        onClick={() => setReviewing(reviewing === c.id ? null : c.id)}
                        title="Read what landed and give it a verdict">
                        {reviewing === c.id ? 'Close review' : '✓ Review'}
                      </button>
                    </div>
                  )}

                  {reviewing === c.id && (
                    <div className="rp-review" onClick={(e) => e.stopPropagation()}>
                      {/* The NULL-verdict rule: no built note is NOT "it went
                          fine". Say what is missing, hardest under an approve. */}
                      {c.builtNote
                        ? <div className="rp-note built">{c.builtNote}</div>
                        : (
                          <div className="rp-review-blind">
                            No built note on this card — nothing was recorded about what actually landed,
                            so there is nothing to read here but the title.
                          </div>
                        )}
                      {c.claimedBy && <div className="rp-review-branch">{c.claimedBy}</div>}
                      <div className="rp-acts">
                        <button className="rail-link go" onClick={() => { setReviewing(null); onApprove(c); }}
                          title="Records the same verdict the Review room records, and archives the card. It does not tick the item.">
                          ✓ Approve &amp; archive
                        </button>
                        <button className="rail-link" onClick={() => { setReviewing(null); onSendBack(c); }}
                          title="It did not hold up — un-ticks it, clears the branch claim and returns it to the board">
                          ↩ Send back
                        </button>
                      </div>
                    </div>
                  )}

                  {openCard === c.id && (
                    <div className="rp-detail" onClick={(e) => e.stopPropagation()}>
                      {c.note && <div className="rp-note">{c.note}</div>}

                      <div className="lbl">Labels</div>
                      <CardLabels labels={labels} on={c.labels}
                        open={labelsFor === c.id}
                        onToggleOpen={() => setLabelsFor(labelsFor === c.id ? null : c.id)}
                        onToggle={(key) => onToggleLabel(c, key)} />

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
                        {/* Deleting is not archiving: it is gone, and for a
                            hook-extracted row it tombstones the fingerprint so
                            the next push cannot re-create it. The parent's
                            modal is what says so before it happens. */}
                        <button className="rail-link danger" onClick={() => onDelete(c)}
                          title="Delete this item — not the same as archiving it">Delete</button>
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

// --- the label menu ---------------------------------------------------------

// The board's label filter AND its editor, in one menu.
//
// One menu rather than two surfaces because they answer the same question from
// either side — "which labels does this board have" — and a set the owner can
// grow has no ceiling to lay out flat. The DELETE is a two-press confirm that
// names the number of cards it will touch: the label comes off all of them, in
// one transaction, and that is not something to learn afterwards.
function LabelMenu({ labels, tones, filter, onFilter, countOf, onAdd, onDelete }: {
  labels: BoardLabel[]; tones: string[];
  filter: string; onFilter: (key: string) => void;
  countOf: (key: string) => number;
  onAdd: (name: string, tone: string) => void;
  onDelete: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [tone, setTone] = useState(tones[0] || 'muted');
  const [confirm, setConfirm] = useState('');
  const box = useRef<HTMLDivElement | null>(null);

  // A menu that only closes on its own button is a menu you fight. Any press
  // outside it closes it, and the pending delete goes with it — a confirm left
  // armed behind a closed menu is a press you did not know you had queued.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) { setOpen(false); setConfirm(''); }
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const add = () => {
    const v = name.trim();
    if (!v) return;
    onAdd(v, tone);
    setName('');
  };

  return (
    <div className="rp-labelmenu" ref={box}>
      <button className={`rp-labelbtn${open ? ' on' : ''}`} aria-expanded={open}
        onClick={() => { setOpen(!open); setConfirm(''); }}>
        Labels <span className="n">{labels.length}</span> <span className="chev" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="rp-labelpop" role="menu">
          {labels.map((l) => (
            <div className={`rp-labelrow${filter === l.key ? ' on' : ''}`} key={l.key}>
              <button className={`rl rl-${l.tone}${filter === l.key ? ' on' : ''}`} role="menuitem"
                onClick={() => onFilter(filter === l.key ? '' : l.key)}
                title={filter === l.key ? 'Clear this filter' : `Show only cards labelled ${l.name}`}>
                {l.name}
              </button>
              <span className="n">{countOf(l.key)}</span>
              {confirm === l.key ? (
                <span className="rp-labelconfirm">
                  <button className="go" onClick={() => { setConfirm(''); onDelete(l.key); }}>
                    Delete{countOf(l.key) > 0 ? ` from ${countOf(l.key)}?` : '?'}
                  </button>
                  <button className="no" onClick={() => setConfirm('')}>No</button>
                </span>
              ) : (
                <button className="x" onClick={() => setConfirm(l.key)}
                  title={`Delete ${l.name} — it comes off every card that carries it`}>×</button>
              )}
            </div>
          ))}
          {labels.length === 0 && (
            <div className="rp-labelempty">No labels on this board. Add one below.</div>
          )}
          <div className="rp-labeladd">
            <span className="rp-tones">
              {tones.map((t) => (
                <button key={t} className={`rl rl-${t}${tone === t ? ' on' : ''}`} title={t}
                  onClick={() => setTone(t)} />
              ))}
            </span>
            <input className="field-input sm" value={name} placeholder="New label, then Enter"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add();
                else if (e.key === 'Escape') { setName(''); setOpen(false); }
              }} />
          </div>
        </div>
      )}
    </div>
  );
}

// A card's own labels: the ones it wears, plus a menu to change them. The chips
// stay visible with the menu shut — what a card is labelled is information, and
// only CHANGING it needs a menu.
function CardLabels({ labels, on, open, onToggleOpen, onToggle }: {
  labels: BoardLabel[]; on: string[];
  open: boolean; onToggleOpen: () => void; onToggle: (key: string) => void;
}) {
  const mine = labelsOf(on, labels);
  return (
    <div className="rp-cardlabels">
      <div className="rp-toggles">
        {mine.map((l) => (
          <span key={l.key} className={`rl rl-${l.tone} on`}>{l.name}</span>
        ))}
        <button className="rp-labelbtn sm" aria-expanded={open} onClick={onToggleOpen}>
          {mine.length ? 'Change' : 'Add a label'} <span className="chev" aria-hidden="true">▾</span>
        </button>
      </div>
      {open && (
        <div className="rp-labelpop inline" role="menu">
          {labels.map((l) => (
            <div className="rp-labelrow" key={l.key}>
              <button className={`rl rl-${l.tone}${on.includes(l.key) ? ' on' : ''}`} role="menuitemcheckbox"
                aria-checked={on.includes(l.key)} onClick={() => onToggle(l.key)}>
                {l.name}
              </button>
              {on.includes(l.key) && <span className="tick" aria-hidden="true">✓</span>}
            </div>
          ))}
          {labels.length === 0 && (
            <div className="rp-labelempty">No labels on this board yet — add one from the Labels menu above.</div>
          )}
        </div>
      )}
    </div>
  );
}
