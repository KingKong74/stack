// THE ROADMAP — the lists board, and the whole tab now that Scope, Tiers and
// Parked have gone with the strip that switched between them (RoadmapTab's
// header says why, and what moved onto the card rather than going with them).
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
//    parent's confirm modal, which is what says so before it happens.
//  • PARKING IS THE THIRD STATE, and this card is the only surface left that
//    can set OR clear it. `skipped` cards stay in their lane — a parked item is
//    still part of the feature — and wear a `parked` tag, because a card that
//    the runner will not pick and that says nothing about why is the same
//    silence as a NULL verdict.
//  • THE TIER IS SHOWN AND NOT SET. #227 is the run queue's primary sort and
//    HUMANS ONLY; the item modal is where it is chosen.
//  • REVIEWING FROM THE SHIPPED LANE (#382) records the SAME verdict the Review
//    room records — `review_tag: 'solid'` — and archives the card in the same
//    write. What it does NOT do is tick the item: approving has never meant
//    done (the merge job ticks, with the human's verdict already stored), and a
//    board that ticked on approval would be manufacturing the state the whole
//    verdict chain exists to keep honest. A card with no `built_note` says so
//    rather than presenting a title as evidence — the NULL-verdict rule.
//  • EVERY LANE IS THE OWNER'S (#428), AND THE CATCH-ALL IS WHY THAT IS SAFE.
//    `planned`, `progress`, `review` and `shipped` are where `listKeyOf` derives
//    cards to, so their KEYS are wiring — and they used to be locked, because a
//    board missing one had a derived column with nowhere to render and its
//    cards vanished while still counting everywhere else. Renaming was never
//    the hazard (it writes `name`; the key a card derives to is untouched), so
//    what the unlock actually needed was somewhere for an orphan to land. That
//    is the UNFILED lane at the end of the board: any card whose resolved key
//    has no column is drawn there, named, and one drag from a real lane. It is
//    rendered ONLY when it holds something — an empty "Unfiled" on a whole
//    board is furniture — and DELETING IT IS NOT POSSIBLE because it is not a
//    row. Do not remove it without putting the server-side lock back: it is the
//    entire safety argument for letting `shipped` be deleted.
//  • IN REVIEW IS A LANE, NOT A FOOTNOTE (#440). A change is waiting on a
//    verdict from the moment it is BUILT (#374), and that used to be a line of
//    text on a card in In Progress — one lane holding two states that want
//    different things from you: work a machine is still doing, and work waiting
//    on a human. It derives to its own lane now, and a verdict given from the
//    card's ✓ Review panel moves it on to Done (server/src/lists.js). The
//    per-card strip stays, because the lane says WHICH pile and the strip says
//    what the card is waiting for. The predicate is `isBuilt` from lib/plan,
//    the same one the Overview's verdict queue counts: a lane saying "3
//    waiting" beside a queue showing 4 is two answers to one question. Mission
//    Control's Review room was culled and this board is now the ONLY place a
//    verdict can be given — do not remove the ✓ Review panel with it.
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

import { useEffect, useRef, useState } from 'react';
import type { BoardArea, BoardLabel, BoardList, Priority, RoadmapItem } from '../types';
import { areaMatches, isBuilt, listKeyOf } from '../lib/plan';
import { LABEL_TONES, labelsOf } from '../lib/labels';
import { MoreMenu } from '../components/MoreMenu';

const BUCKETS: Priority[] = ['must', 'should', 'could', 'wont'];
const BUCKET_LABEL: Record<Priority, string> = {
  must: 'Must', should: 'Should', could: 'Could', wont: "Won't",
};

// The lanes where a verdict can be given — see the header. Named once so the
// per-card strip, the lane head count and the styling cannot drift apart.
//
// `review` is where a built change now derives to (#440) and is the lane this
// is really about. `shipped` stays because a verdicted card lands there and its
// verdict is still worth reading, and `progress` stays because a card DRAGGED
// there by hand keeps its stored key — dropping it from the set would take the
// ✓ Review panel away from a card that is built, on the only screen where a
// verdict can be given at all.
const REVIEW_LANES = new Set(['progress', 'review', 'shipped']);

// The catch-all lane's key. NOT a `project_lists` row and never sent to the
// server: it is a rendering slot for cards whose column was deleted. The
// underscores are what make it uncollidable — `POST /lists` slugifies a name to
// [a-z0-9-] and suffixes it with a digit, so no real key can ever be this.
// Deliberately NOT a control character: a NUL in a source file makes the file
// silently invisible to grep, which is a cost paid by every future reader.
const UNFILED = '__unfiled__';

export interface PlanProps {
  /** The project, for the Review room link — a room-wide queue needs to be told whose change. */
  items: RoadmapItem[];
  lists: BoardList[];
  areas: BoardArea[];
  /** #382 — the project's own labels, in board order. */
  labels: BoardLabel[];
  /** The tones a new label may wear; falls back to the client's own set. */
  tones?: string[];
  areaFilter: string;
  labelFilter: string;
  /** The deep-linked row (#303) — `hl` on the roadmap tab names a card here. */
  highlightId?: string | null;
  /** A bulk write is in flight; the sweep that started it must not re-fire. */
  busy?: boolean;
  onSetLabelFilter: (id: string) => void;
  onAddLabel: (name: string, tone: string) => void;
  onDeleteLabel: (key: string) => void;
  onMoveToList: (item: RoadmapItem, listKey: string) => void;
  onSetBucket: (item: RoadmapItem, bucket: Priority) => void;
  onToggleLabel: (item: RoadmapItem, labelId: string) => void;
  onArchive: (item: RoadmapItem, archived: boolean) => void;
  /** Park / unpark (`skipped`). The board is the only surface left for it. */
  onTogglePark: (item: RoadmapItem, parked: boolean) => void;
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
  /** Rename a lane. Never called for the catch-all — it is not a row. */
  onRenameList: (list: BoardList, name: string) => void;
  /** Remove a lane; its cards return to the derived column, or to Unfiled. */
  onDeleteList: (list: BoardList) => void;
  /** ⎇ claim a branch and open a primed session (#205). Absent = not offered. */
  onBranch?: (item: RoadmapItem) => void;
  onOpen: (item: RoadmapItem) => void;
}

export function RoadmapPlan({
  items, lists, areas, labels, tones, areaFilter, labelFilter, onSetLabelFilter,
  highlightId, busy, onAddLabel, onDeleteLabel, onMoveToList, onSetBucket, onToggleLabel,
  onArchive, onArchiveMany, onTogglePark,
  onDelete, onApprove, onSendBack, onAddCard, onAddList, onRenameList, onDeleteList, onBranch, onOpen,
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
  // The lane a drag is currently over, and the card being dragged. Both are
  // presentation only — a board where the column you are about to drop into
  // looks exactly like the four beside it is a board you aim at by counting.
  const [over, setOver] = useState('');
  const [dragging, setDragging] = useState<number | null>(null);

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
  const INERT = '.rp-card, .rp-col-tools, .rp-col-review, .rp-col-confirm, button, a, input, textarea, select, label';
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

  // WHERE EVERY VISIBLE CARD IS DRAWN, the catch-all included.
  //
  // A card resolves to a key through `listKeyOf` — its stored one, else the one
  // its own state derives to — and since the lanes were unlocked (#428) that
  // key can name a column the owner has deleted. Those cards get the UNFILED
  // lane at the end rather than being dropped from the render: a card that
  // still counts everywhere else and appears on no board is exactly the loss
  // the old lock existed to prevent, and it is silent.
  //
  // It is drawn only when it holds something, and it is not a `project_lists`
  // row — so it has no rename, no remove and no composer. `list: null` is what
  // every one of those checks off.
  const byKey = new Map<string, RoadmapItem[]>();
  visible.forEach((i) => {
    const derived = listKeyOf(i);
    const key = lists.some((l) => l.key === derived) ? derived : UNFILED;
    const at = byKey.get(key);
    if (at) at.push(i); else byKey.set(key, [i]);
  });
  const columns: { key: string; name: string; cards: RoadmapItem[]; list: BoardList | null }[] =
    lists.map((l) => ({ key: l.key, name: l.name, cards: byKey.get(l.key) || [], list: l }));
  const orphans = byKey.get(UNFILED) || [];
  if (orphans.length) columns.push({ key: UNFILED, name: 'Unfiled', cards: orphans, list: null });

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
        {columns.map((col) => {
          const { cards } = col;
          // How many cards in this lane are built and waiting on a verdict.
          // Counted off the SHOWN cards, like the sweep: a lane head that counts
          // rows the area filter is hiding is a number you cannot reconcile with
          // the column under it.
          const waiting = REVIEW_LANES.has(col.key) ? cards.filter(isBuilt).length : 0;
          const wide = focus === col.key;
          return (
            <div className={`rp-col${wide ? ' focus' : ''}${over === col.key ? ' over' : ''}${col.list ? '' : ' unfiled'}`}
              key={col.key}
              onClick={(e) => toggleFocusFromLane(e, col.key)}
              onDragOver={(e) => { e.preventDefault(); if (over !== col.key) setOver(col.key); }}
              onDragLeave={(e) => {
                // Only when the pointer has actually left the COLUMN — dragging
                // across the cards inside it fires a leave per card, and a
                // highlight that flickers off under the cursor reads as a lane
                // refusing the drop.
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver('');
              }}
              onDrop={(e) => {
                e.preventDefault();
                setOver(''); setDragging(null);
                const it = items.find((x) => x.id === Number(e.dataTransfer.getData('text/plain')));
                // Dropping onto Unfiled CLEARS the stored column rather than
                // storing this key — the key is a rendering slot, not a lane,
                // and writing it would file the card under a column no server
                // knows about.
                if (it) onMoveToList(it, col.list ? col.key : '');
              }}>
              <div className="rp-col-head"
                title={wide ? 'Click the lane to close it' : 'Click the lane to open it wide enough to read'}>
                {renaming === col.key && col.list ? (
                  <input className="field-input sm" autoFocus value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => setRenaming('')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const v = renameDraft.trim();
                        if (v && col.list && v !== col.name) onRenameList(col.list, v);
                        setRenaming('');
                      } else if (e.key === 'Escape') setRenaming('');
                    }} />
                ) : (
                  <>
                    <span className="nm">{col.name}</span>
                    <span className="n">{cards.length}</span>
                  </>
                )}
                <span className="rp-col-tools">
                  {/* Shipped is the one lane work PILES UP in — every other column
                      is somewhere a card is passing through. The sweep archives
                      exactly the cards ON SCREEN, so it can never touch rows the
                      area or label filter is hiding: a bulk action whose reach is
                      wider than its view is how you lose work you never saw. */}
                  {col.key === 'shipped' && cards.length > 0 && confirmSweep !== col.key && (
                    <button className="rp-sweep" onClick={() => setConfirmSweep(col.key)}
                      title={`Archive the ${cards.length} card${cards.length === 1 ? '' : 's'} shown here${
                        areaFilter || labelFilter ? ' — the filter is on, so only these' : ''}`}>
                      Archive all
                    </button>
                  )}

                  {/* Rename and remove, on EVERY lane (#428) — behind one ⋯
                      rather than as a ✎ and a × the reader has to decode. The
                      catch-all is the one column without them, because it is
                      not a row — it is where a deleted lane's cards are drawn,
                      and it says so rather than offering tools that would have
                      nothing to write to.

                      THE ⋯ IS THE TRIGGER, NEVER THE CONSEQUENCE: Remove lane
                      opens the same two-press confirm the × opened, naming the
                      cards that stay. Focus keeps its own button — it is a
                      toggle you flip while reading, not an edit, and burying a
                      view control costs a press every time. */}
                  {!col.list ? (
                    <span className="rp-col-note"
                      title="These cards were in a column that has since been removed. Drag each one into a lane — this is a place they are drawn, not a lane of its own, so it cannot be renamed or removed.">
                      no lane
                    </span>
                  ) : (
                    <MoreMenu btnClass="rp-col-act" label={`${col.name} — lane options`}
                      options={[
                        {
                          key: 'rename', label: 'Rename lane', title: 'Rename this lane',
                          onSelect: () => { setConfirmList(''); setRenameDraft(col.name); setRenaming(col.key); },
                        },
                        {
                          key: 'remove', label: 'Remove lane', danger: true,
                          title: 'Remove this lane — its cards are not deleted',
                          onSelect: () => { setRenaming(''); setConfirmList(col.key); },
                        },
                      ]} />
                  )}

                  <button className={`rp-col-act${wide ? ' on' : ''}`} aria-pressed={wide}
                    onClick={() => setFocus(wide ? '' : col.key)}
                    title={wide ? 'Close this lane back to its column width' : 'Focus this lane — open it wide enough to read'}>
                    {wide ? '⇤' : '⇥'}
                  </button>
                </span>
              </div>

              {/* A CONFIRM GETS ITS OWN ROW, for the same reason the review
                  line below does: inside the head it fought a 272px lane for
                  width, wrapped the lane's name onto two lines and pushed its
                  own Cancel out over the NEXT column, where the press landed on
                  that column instead. A control that only appears sometimes
                  must never be able to reflow the line that is always there —
                  and a confirm whose Cancel cannot be hit is worse than no
                  confirm at all. Both live here: only one can be armed, since
                  arming either closes the menu the other came from. */}
              {(confirmSweep === col.key || confirmList === col.key) && (
                <span className="rp-col-confirm">
                  {confirmSweep === col.key ? (
                    <>
                      <button className="go" disabled={busy}
                        onClick={() => { onArchiveMany(cards); setConfirmSweep(''); }}>
                        Archive {cards.length}?
                      </button>
                      <button className="no" onClick={() => setConfirmSweep('')}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button className="go danger" onClick={() => { setConfirmList(''); onDeleteList(col.list!); }}
                        title="The cards stay — they go back to the lane their own state puts them in, or to Unfiled if that lane is gone too">
                        Remove lane{cards.length ? ` · ${cards.length} card${cards.length === 1 ? '' : 's'} stay` : ''}?
                      </button>
                      <button className="no" onClick={() => setConfirmList('')}>Cancel</button>
                    </>
                  )}
                </span>
              )}

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
                <span className="rp-col-review"
                  title={`${waiting} change${waiting === 1 ? '' : 's'} in this lane ${
                    waiting === 1 ? 'is' : 'are'} built and waiting on your verdict`}>
                  {waiting} waiting on your verdict
                </span>
              )}

              {/* The cards scroll INSIDE the lane, so the head and the
                  composer stay put and the board's height is the viewport's
                  rather than the tallest column's. A board you scroll the whole
                  page to reach the bottom of is a list of lists. */}
              <div className="rp-col-cards">
                {cards.map((c) => (
                  <div key={c.id} data-hl={c.id} draggable
                    className={`rp-card${dragging === c.id ? ' dragging' : ''}`
                      + `${c.skipped ? ' parked' : ''}${highlightId === String(c.id) ? ' hl' : ''}`}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', String(c.id));
                      e.dataTransfer.effectAllowed = 'move';
                      setDragging(c.id);
                    }}
                    onDragEnd={() => { setDragging(null); setOver(''); }}
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
                      {/* THE DESIRE TIER IS READ-ONLY HERE (#227). It is the run
                          queue's PRIMARY sort, so a board that shows the bucket
                          and hides the tier shows the second key and not the
                          first — but it is set in the item modal and by humans
                          only, and a control on a card is one mis-drag from an
                          agent-shaped write. The Tiers board was where it was
                          ranked; the card is where it is now READ. */}
                      {c.tier && (
                        <span className={`rp-tier t${c.tier}`}
                          title={`Desire tier ${c.tier} (#227) — the run queue works S, then A, B, C, then unranked. Set it in the item.`}>
                          {c.tier}
                        </span>
                      )}
                      {c.skipped && (
                        <span className="rp-parked" title="Parked — cut from this cycle, still part of the feature">parked</span>
                      )}
                      <span className="est">{c.estimate === null ? '' : `${c.estimate}w`}</span>
                      {c.reviewTag && <span className="rp-verdict" title="Verdict already recorded">✓ {c.reviewTag}</span>}
                    </div>

                    {/* The card's verdict state. It was a link into the Review
                        room; the room was culled and the LABEL stayed, because
                        the two states are what the lane is read for — a change
                        still waiting on the owner, against one already verdicted.
                        A card in these lanes with neither — claimed but nothing
                        built yet — shows nothing. Deliberately not a link now:
                        the verdict is given from the ✓ Review panel on the card
                        itself, and a link to a culled room would teach a route
                        that no longer exists. */}
                    {REVIEW_LANES.has(col.key) && (isBuilt(c) || c.reviewTag) && (
                      <span className={`rp-card-review${isBuilt(c) ? ' waiting' : ''}`}
                        title={isBuilt(c)
                          ? 'Built and waiting on your verdict — give it from ✓ Review on this card'
                          : 'The verdict is already on record'}>
                        {isBuilt(c) ? 'Waiting on your verdict' : `Verdicted ${c.reviewTag}`}
                      </span>
                    )}

                    {col.key === 'shipped' && (
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
                          {/* ⎇ was Scope's, and Scope is gone (RoadmapTab's
                              header). Claiming a branch is how work leaves this
                              board for a session, so it comes with it. */}
                          {onBranch && !c.claimedBy && (
                            <button className="rail-link" onClick={() => onBranch(c)}
                              title="Claim a branch for this item and open a session primed on it">⎇ Branch</button>
                          )}
                          {/* Parking is not archiving and not deleting — three
                              states, three meanings (schema.sql). This is the
                              only way back from it now that the Parked board is
                              gone, which is why it is a toggle and not a one-way
                              press. */}
                          <button className="rail-link" onClick={() => onTogglePark(c, !c.skipped)}
                            title={c.skipped
                              ? 'Unpark — back into this cycle, and back in front of the runner'
                              : 'Park — cut from this cycle, still part of the feature and still on the board'}>
                            {c.skipped ? 'Unpark' : 'Park'}
                          </button>
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
              </div>

              {/* No composer on the catch-all: a new card filed into a
                  rendering slot would have nowhere to be written. */}
              {col.list && (composer === col.key ? (
                <input className="field-input sm" autoFocus value={draft} placeholder="Card title, then Enter"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={submit((v) => onAddCard(col.key, v))} />
              ) : (
                <button className="rp-add" onClick={() => { setComposer(col.key); setDraft(''); }}>+ Add a card</button>
              ))}
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
