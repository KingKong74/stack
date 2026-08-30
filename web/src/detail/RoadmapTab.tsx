// The Roadmap tab's SHELL — THE BOARD IS THE ROADMAP, and now it is the only
// thing here (owner's call, following #428).
//
// #428 flattened three views into one strip of four boards (Board · Scope ·
// Tiers · Parked). The strip is gone with them: the other three were the same
// rows read three more ways, and a reading you have to press for is a reading
// nobody presses. What is left is the lists board and the furniture it needs —
// the area chips, the label filter, the board's shape (areas + lists + labels,
// fetched once here).
//
// THE ARRANGE PANEL WENT IN THE SAME CUT. It had one button left — the ✧ Sort
// the unallocated read — after the Timeline took its six quick commands with
// it, and a collapsible panel drawn above every board to hold one button is
// chrome in front of the thing you came to read. Its brief catalogue
// (`lib/curatorTasks.ts`) and its test went too: a brief nothing can press is a
// command that cannot be run. As with #428's `arrange`, the SERVER survives the
// cut — `POST /roadmap/allocate`, `POST /roadmap/cleanup` and their registry
// ops are still there, unsurfaced, exactly as the branch previews are. The
// Curator itself keeps two surfaced ops (`titler` and `assist`, both in the
// item modal) and its live session on this tab, so it is still an agent with
// something to govern.
//
// WHAT THE THREE CULLED BOARDS SURFACED AND NOTHING ELSE DID moved onto the
// card rather than going with them — the same absorbing #428 did when Scope
// replaced the old board:
//   · the ⎇ branch claim (#205) was Scope's;
//   · park / unpark was Parked's only way back, and a parked item with no
//     control to unpark it is work you can lose by pressing a button once;
//   · the desire tier (#227) was the Tiers board's, and it is the run queue's
//     primary sort, so the card SHOWS it. Setting it is still the item modal's
//     and still humans-only.
// Ticking, the note-clearers and the per-bucket add button did NOT move: the
// board is deliberately not a place where a verdict is given by moving
// something (RoadmapPlan's header says why), and ＋ files a new item.
//
// THE AREA CHIPS COUNT WHAT THE BOARD DRAWS. They used to count what was in the
// cycle (`inCycle`), because the Scope drawer beside them was totalling the
// same population and two answers to one question is one too many. With Scope
// gone the chips sit over the board alone, so they count the cards it renders —
// everything not archived, parked and won't included. A chip reading 3 above a
// column of five would be the same fault the other way round. The ACTIVE chip
// is never hidden, however its count falls: the filter you are looking through
// has to stay on screen to be released. UNALLOCATED is a chip of its own and
// NOT an area (`lib/plan.ts` carries the sentinel and why it is safe): untagged
// work sits in no lane and behind no chip, which makes it the population most
// easily forgotten, so it gets the one chip that finds it.
//
// It writes through `store.ts` like every other screen and hands its children
// plain callbacks — the board itself is presentational and testable by
// inspection.
//
// One rule worth stating: EVERY WRITE HERE IS OPTIMISTIC AND REVERSIBLE. The
// local copy updates, the PATCH goes out, and a rejection puts the row back and
// says so. A planning board that silently keeps a change the server refused is
// showing a plan that does not exist.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BoardArea, BoardLabel, BoardList, Priority, Roadmap as RoadmapData, RoadmapItem,
} from '../types';
import {
  getBoardShape, patchRoadmapItem, createRoadmapItem,
  addArea, renameArea as renameAreaApi, deleteArea as deleteAreaApi, addList as addListApi,
  renameList as renameListApi, deleteList as deleteListApi,
  addLabel as addLabelApi, deleteLabel as deleteLabelApi,
  setAreaColour,
} from '../store';
import { UNALLOCATED } from '../lib/plan';
import { DEFAULT_LABELS } from '../lib/labels';
import { RoadmapPlan } from './RoadmapPlan';

// #378 — how many areas a board needs before the chip row is worth searching.
// Below this the chips all fit and a search box is furniture; above it you are
// scanning a wall of them for one name.
const AREA_SEARCH_FROM = 6;

const flat = (r: RoadmapData): RoadmapItem[] => [...r.must, ...r.should, ...r.could, ...r.wont];

/**
 * The callbacks that live in ProjectDetail because they open modals, write
 * through `store.ts` or navigate. Declared HERE rather than derived from a
 * component's props: it used to be `Parameters<typeof Roadmap>[0]`, and when
 * Roadmap went so did the only place this shape was written down.
 */
export interface RoadmapLegacy {
  highlightId?: string | null;
  /** An unfinished item from a modal that was closed — resumable, not lost. */
  draft?: { title: string } | null;
  onResumeDraft?: () => void;
  onDiscardDraft?: () => void;
  /** The parent's confirm modal — deleting is not archiving and asks first. */
  onDelete: (item: RoadmapItem) => void;
  /** ⎇ claim a branch and open a primed session (#205). */
  onBranch?: (item: RoadmapItem) => void;
}

export interface RoadmapTabProps {
  slug: string;
  roadmap: RoadmapData;
  /** Replace one item in the parent's copy after a write. */
  onItemChanged: (item: RoadmapItem) => void;
  /** Replace SEVERAL at once. Not a convenience — see the note on `writeOnly`. */
  onItemsChanged: (items: RoadmapItem[]) => void;
  onItemAdded: (item: RoadmapItem) => void;
  legacy: RoadmapLegacy;
  onOpenItem: (item: RoadmapItem) => void;
}

export function RoadmapTab({
  slug, roadmap, onItemChanged, onItemsChanged, onItemAdded, legacy, onOpenItem,
}: RoadmapTabProps) {
  const [showHiddenAreas, setShowHiddenAreas] = useState(false);
  const [areas, setAreas] = useState<BoardArea[]>([]);
  const [lists, setLists] = useState<BoardList[]>([]);
  // #382 — the project's own labels. DEFAULT_LABELS until the read lands (and
  // for a server too old to serve them), never an empty list: a filter that
  // renders as "no labels" while five are on the cards is a lie about the data.
  const [labels, setLabels] = useState<BoardLabel[]>(DEFAULT_LABELS);
  const [tones, setTones] = useState<string[]>([]);
  // The colours an area may wear, served by the board read so the picker can
  // only offer what the server will store.
  const [palette, setPalette] = useState<string[]>([]);
  // Which area's swatch popover is open (one at a time).
  const [colourFor, setColourFor] = useState<string | null>(null);
  const [areaFilter, setAreaFilter] = useState('');
  // #378 — narrows which area CHIPS are drawn; never which items are shown.
  const [areaQuery, setAreaQuery] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [editAreas, setEditAreas] = useState(false);
  const [areaDraft, setAreaDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const items = useMemo(() => flat(roadmap), [roadmap]);

  useEffect(() => {
    let alive = true;
    getBoardShape(slug)
      .then((b) => {
        if (!alive) return;
        setAreas(b.areas); setLists(b.lists); setPalette(b.palette || []);
        setTones(b.tones || []);
        if (b.labels) setLabels(b.labels);
      })
      .catch((e) => { if (alive) setErr(e?.message || 'Could not read the board’s areas.'); });
    return () => { alive = false; };
  }, [slug]);

  // A DEEP LINK RELEASES THE FILTERS. `hl` names one card and the board is the
  // only surface left that can show it, so a chip or a label left on from
  // earlier would scroll to nothing and highlight nothing — the deep link would
  // silently do nothing at all, which is worse than landing on an unfiltered
  // board. Both filters are one press to put back.
  useEffect(() => {
    if (!legacy.highlightId) return;
    setAreaFilter(''); setLabelFilter('');
  }, [legacy.highlightId]);

  useEffect(() => { if (!err) return; const t = setTimeout(() => setErr(''), 6000); return () => clearTimeout(t); }, [err]);

  // Every write goes through here: PATCH, push the row back to the parent, and
  // surface a rejection rather than leaving the screen ahead of the server.
  const write = useCallback(
    async (item: RoadmapItem, patch: Parameters<typeof patchRoadmapItem>[2]) => {
      const next = await patchRoadmapItem(slug, item.id, patch);
      onItemChanged(next);
      return next;
    }, [slug, onItemChanged]);

  // The same PATCH WITHOUT the push back. A MULTI-ROW write must collect its
  // rows and hand them over together: the parent's replace closes over the
  // board from its own render, so N pushes in a loop each rebuild from the same
  // base and only the last one survives. That bug archived one card of four and
  // moved one bar of six, and looked exactly like a server that had refused the
  // rest.
  const writeOnly = useCallback(
    (item: RoadmapItem, patch: Parameters<typeof patchRoadmapItem>[2]) =>
      patchRoadmapItem(slug, item.id, patch),
    [slug]);

  const guard = (p: Promise<unknown>, what: string) =>
    p.catch((e) => { setErr((e as Error)?.message || `Could not ${what}.`); });

  // Sweep a lane into the archive. Sequential rather than parallel: these are
  // ordinary PATCHes and a lane can hold thirty, and firing thirty at once at a
  // single-container API to save a second is not a trade worth making.
  //
  // A PARTIAL failure is reported as one — some cards moved, the board already
  // shows which, and calling that "failed" would suggest none did.
  const archiveMany = async (cards: RoadmapItem[]) => {
    setBusy(true);
    const landed: RoadmapItem[] = [];
    try {
      for (const it of cards) landed.push(await writeOnly(it, { archived: true }));
    } catch (e) {
      setErr(landed.length === 0
        ? `${(e as Error)?.message || 'That was rejected'} — nothing was archived.`
        : `${(e as Error)?.message || 'A change was rejected'} — ${landed.length} of ${cards.length} were archived.`);
    } finally {
      onItemsChanged(landed);
      setBusy(false);
    }
  };

  // --- areas ----------------------------------------------------------------

  // An area's colour, changed from the chips' edit mode. The write returns the
  // whole collection, so every dot recolours without a re-read.
  const recolour = (name: string, dot: string) =>
    guard(setAreaColour(slug, name, dot).then(setAreas), 'change that colour');

  // --- labels (#382) ---------------------------------------------------------
  //
  // Both writers answer with the whole set. A DELETE also takes the label off
  // every card server-side; the local rows still carry the dead id for this
  // render, which is harmless — `labelsOf` only draws labels the board knows,
  // and the next PATCH that sends the id back has it dropped again. What is not
  // harmless is leaving the board filtered by a label that no longer exists, so
  // the filter is released in the same step.
  const addLabel = (name: string, tone: string) =>
    guard(addLabelApi(slug, name, tone).then(setLabels), 'add that label');
  const removeLabel = (key: string) =>
    guard(deleteLabelApi(slug, key).then((next) => {
      setLabels(next);
      if (labelFilter === key) setLabelFilter('');
    }), 'delete that label');

  // The chips count the cards the BOARD draws — see the header. Archived rows
  // are the one exclusion, and they are excluded because the board keeps them
  // in a rail of their own rather than in a lane.
  const scoped = useMemo(() => items.filter((i) => !i.archived), [items]);

  const { shownAreas, hiddenAreas } = useMemo(() => {
    const counts = new Map<string, number>();
    scoped.forEach((i) => counts.set(i.area, (counts.get(i.area) || 0) + 1));
    const withCounts = areas.map((a) => ({ ...a, n: counts.get(a.name) || 0 }));
    return {
      // The chip you are filtered BY stays whatever its count does — hiding it
      // would leave the board filtered with no way to see or clear the filter.
      shownAreas: withCounts.filter((a) => a.n > 0 || a.name === areaFilter),
      hiddenAreas: withCounts.filter((a) => a.n === 0 && a.name !== areaFilter),
    };
  }, [areas, scoped, areaFilter]);
  // #378 — the chip row is the only way to reach an area, and it grows without
  // limit: one chip per area, on one line, so past a handful you are reading a
  // wall to find the one you want. The search narrows the CHIPS, not the items —
  // picking a chip is still what filters the board.
  //
  // It appears only once there are enough areas to hunt through. A search box
  // over three chips is furniture, the same judgement that keeps "Unallocated 0"
  // off a tidy board.
  const areaQ = areaQuery.trim().toLowerCase();
  const searchableAreas = areas.length >= AREA_SEARCH_FROM;
  const areaChips = useMemo(() => {
    const base = showHiddenAreas || editAreas ? [...shownAreas, ...hiddenAreas] : shownAreas;
    if (!areaQ) return base;
    // The chip you are filtered BY survives the search for the same reason it
    // survives an empty count: hiding it would leave the board filtered with the
    // filter itself off screen, and no way back to All areas except guessing.
    return base.filter((a) => a.name.toLowerCase().includes(areaQ) || a.name === areaFilter);
  }, [shownAreas, hiddenAreas, showHiddenAreas, editAreas, areaQ, areaFilter]);

  // UNALLOCATED is a chip of its own, not an area (lib/plan.ts says why the
  // filter value is a sentinel). Untagged work is the population most likely to
  // be forgotten — it is in no lane and behind no chip — so it gets the one chip
  // that can find it. Drawn only when there IS some, or while you are filtered
  // by it: an "Unallocated 0" on a tidy board is furniture, but a filter with no
  // way back is a trap.
  const unallocated = scoped.filter((i) => !i.area).length;
  // What a NEW row filed while a filter is on should be tagged with. Under
  // UNALLOCATED that is nothing — the sentinel is a filter value, never an area,
  // and passing it through would create an area literally called "unallocated".
  const filterArea = areaFilter === UNALLOCATED ? '' : areaFilter;

  return (
    <div className="rtab">
      {err && <div className="action-error">{err}</div>}

      {/* The unfinished item. The add modal saves what was typed when it is
          dismissed, and this is the only thing that says so — without it a
          draft is kept and never offered back, which is the same as losing it.
          It was Scope's ＋ that resumed one; Scope is gone, so the strip is. */}
      {legacy.draft && (
        <div className="rtab-draft">
          <span>Unfinished item: “{legacy.draft.title || 'untitled'}”</span>
          {legacy.onResumeDraft && (
            <button className="rail-link" onClick={legacy.onResumeDraft}>Resume</button>
          )}
          {legacy.onDiscardDraft && (
            <button className="rail-link danger" onClick={legacy.onDiscardDraft}>Discard</button>
          )}
        </div>
      )}

      <div className="rtab-chips">
          {searchableAreas && (
            <span className="rtab-areasearch">
              <input className="field-input sm" type="search" value={areaQuery}
                placeholder={`Find one of ${areas.length} areas`}
                aria-label="Filter the area chips by name"
                onChange={(e) => setAreaQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setAreaQuery(''); }} />
            </span>
          )}
          {/* All areas is never searched away: it is the way back from a filter,
              and a filter with no way back is a trap. */}
          <button className={`chip-sm${areaFilter === '' ? ' on' : ''}`} onClick={() => setAreaFilter('')}>
            All areas<span className="n">{scoped.length}</span>
          </button>
          {areaChips.map((a) => (
            editAreas ? (
              <span className="rtab-areaedit" key={a.name}>
                {/* The swatch IS the picker. A colour a lane wears has to be
                    changeable from where you can see the lanes. */}
                <button className="rtab-swatch" style={{ background: a.dot }}
                  title={`Colour for ${a.name}`}
                  onClick={() => setColourFor(colourFor === a.name ? null : a.name)} />
                {colourFor === a.name && (
                  <span className="rtab-palette" role="menu">
                    {palette.map((c) => (
                      <button key={c} role="menuitem" style={{ background: c }}
                        className={c === a.dot ? 'on' : ''} title={c}
                        onClick={() => { setColourFor(null); recolour(a.name, c); }} />
                    ))}
                  </span>
                )}
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
              <button key={a.name} className={`chip-sm${areaFilter === a.name ? ' on' : ''}${a.n === 0 ? ' empty' : ''}`}
                onClick={() => setAreaFilter(areaFilter === a.name ? '' : a.name)}
                title={a.n === 0 ? `${a.name} — nothing on the board` : `${a.name} — ${a.n} on the board`}>
                {a.name}<span className="n">{a.n}</span>
              </button>
            )
          ))}
          {/* A search that matches no area says so. An empty row would read as
              "this board has no areas", which is a different and wrong answer —
              the same reason a NULL verdict is not drawn as green. */}
          {areaQ && areaChips.length === 0 && (
            <span className="rtab-nomatch">No area matching “{areaQuery.trim()}”</span>
          )}
          {(unallocated > 0 || areaFilter === UNALLOCATED)
            && (!areaQ || 'unallocated'.includes(areaQ) || areaFilter === UNALLOCATED) && !editAreas && (
            <button className={`chip-sm unalloc${areaFilter === UNALLOCATED ? ' on' : ''}`}
              onClick={() => setAreaFilter(areaFilter === UNALLOCATED ? '' : UNALLOCATED)}
              title={`Items with no area at all — ${unallocated} on the board`}>
              Unallocated<span className="n">{unallocated}</span>
            </button>
          )}
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
          {/* An area with nothing on the board is hidden rather than drawn as a
              zero — but it is REPORTED, because an area you cannot see is one
              you cannot file work into. Editing always shows them all. */}
          {hiddenAreas.length > 0 && !editAreas && (
            <button className="rtab-hidden" onClick={() => setShowHiddenAreas(!showHiddenAreas)}
              title={showHiddenAreas
                ? 'Hide the areas with nothing on the board'
                : hiddenAreas.map((a) => a.name).join(', ')}>
              {showHiddenAreas ? 'Hide empty' : `+${hiddenAreas.length} empty`}
            </button>
          )}
          <button className="rtab-editareas" onClick={() => { setEditAreas(!editAreas); setAreaDraft(null); }}>
            {editAreas ? 'Done' : 'Edit areas'}
          </button>
      </div>

      <RoadmapPlan
        items={items} lists={lists} areas={areas} areaFilter={areaFilter}
        labels={labels} tones={tones} busy={busy}
        labelFilter={labelFilter} onSetLabelFilter={setLabelFilter}
        highlightId={legacy.highlightId}
        onAddLabel={addLabel} onDeleteLabel={removeLabel}
        onDelete={legacy.onDelete}
        onBranch={legacy.onBranch}
        onApprove={(it) => {
          // The Review room's verdict, made from the board: `review_tag`
          // and the archive in ONE write. Deliberately no `done` — approving
          // has never meant ticked (CLAUDE.md), and the item's own merge is
          // what ticks it.
          guard(write(it, { review_tag: 'solid', archived: true }), 'record that verdict');
        }}
        onSendBack={(it) => {
          // Un-ticking clears review_tag and claimed_by server-side; clearing
          // listKey returns the card to its DERIVED column, so a card dragged
          // into Shipped by hand leaves the lane too.
          guard(write(it, { done: false, listKey: '' }), 'send that card back');
        }}
        onMoveToList={(it, listKey) => { guard(write(it, { listKey }), 'move that card'); }}
        onSetBucket={(it, bucket) => { guard(write(it, { bucket }), 'change that card’s scope'); }}
        // Parked (`skipped`) is one of the three states in schema.sql and the
        // only one with no board of its own now. The card carries the toggle so
        // it stays reversible: parking work you cannot unpark is losing it.
        onTogglePark={(it) => { guard(write(it, { skipped: !it.skipped }), it.skipped ? 'unpark that item' : 'park that item'); }}
        onToggleLabel={(it, id) => {
          const next = it.labels.includes(id) ? it.labels.filter((l) => l !== id) : [...it.labels, id];
          guard(write(it, { labels: next }), 'change that card’s labels');
        }}
        onArchive={(it, archived) => { guard(write(it, { archived }), 'archive that card'); }}
        onArchiveMany={(cards) => { void archiveMany(cards); }}
        onAddCard={(listKey, title) => {
          guard(
            createRoadmapItem(slug, { title, note: '', bucket: 'should' as Priority, area: filterArea || undefined })
              .then((created) => {
                onItemAdded(created);
                return patchRoadmapItem(slug, created.id, { listKey }).then(onItemChanged);
              }),
            'add that card');
        }}
        onAddList={(name) => { guard(addListApi(slug, name).then((l) => setLists((ls) => [...ls, l])), 'add that list'); }}
        onRenameList={(list, name) => {
          guard(renameListApi(slug, list.key, name)
            .then((l) => setLists((ls) => ls.map((x) => (x.key === l.key ? l : x)))), 'rename that lane');
        }}
        onDeleteList={(list) => {
          // The lane goes; its cards do not. The server clears their
          // `list_key`, which returns them to the DERIVED column — so the
          // same clear is mirrored into the rows in hand. Without it the
          // board would keep every one of those cards filed under a lane that
          // no longer renders: work that is still there, and invisible.
          const freed = items.filter((i) => i.listKey === list.key).map((i) => ({ ...i, listKey: '' }));
          guard(deleteListApi(slug, list.key).then(() => {
            setLists((ls) => ls.filter((x) => x.key !== list.key));
            if (freed.length) onItemsChanged(freed);
          }), 'remove that lane');
        }}
        onOpen={onOpenItem} />

    </div>
  );
}
