// THE BOARD — the project's kanban, read from `roadmap_items` and written back.
// Cards arrive as a prop (the one payload every tab renders from), so a write
// patches that payload rather than re-reading the project. Only the column
// list is fetched here (`GET /board`). The Development tab is
// detail/Development.tsx; double-clicking a card opens detail/BoardFocus.tsx.
//
// The board is designed for the owner working it by hand (owner's call,
// 2026-11-02). Automation concerns are not this screen's to weigh: they live in
// the root CLAUDE.md and the server.
//
// TWO KINDS OF CARD (owner's call, 2026-11-02):
//  - A TASK is a plain card: a check glyph, its title, its controls.
//  - A CLUSTER is a row with parts (children, `parent_id`, one level deep). It
//    is one central idea, drawn bulkier: stacked plates behind it, a bold
//    title, the layers glyph, a progress bar, and its first few parts inside
//    the card, unfinished first. PARTS ARE NOT CARDS OF THEIR OWN while their
//    cluster is on the board; a part whose cluster is off it (archived, or
//    still an auto-idea) is an ordinary card again, so nothing vanishes. A
//    cluster's column is ROLLED UP from its parts (`clusterKeyOf` in
//    lib/plan.ts), so it does not drag and its editor shows the column
//    read-only. Search finds a cluster by any of its parts. A card becomes a
//    cluster when it gets its first part, from the focus canvas.
//    Its SIZE is derived the same way (#600): the pill reads Σ of its parts'
//    points, read-only, and a column's total counts the parts, never the
//    cluster's own number. Clicking a part opens the canvas with the editor on
//    that part (#601), and the editor's switcher moves between the cluster and
//    its parts.
//
// DECISIONS THE CODE DEPENDS ON:
//  1. THE PRIORITY CONTROL IS `bucket` (Highest…Lowest, `PRIORITY_META` in
//     lib/ui.ts).
//  2. A COLUMN IS SORTED BY `queueOrder` (lib/plan.ts), a stable sort over an
//     array that arrived in payload order. Read its header before touching it.
//  3. DRAGGING TO Done DOES NOT TICK. A drop writes `list_key` only
//     (server/src/lists.js); `done` is what progress counts. Dropping a card
//     back on the column it would derive into writes '' rather than the key.
//  4. NO WITHIN-COLUMN DRAG: `position` is scoped to the bucket, not the
//     column, so a reorder here would write a number that means something else.
//  5. NO COLUMN LIMITS and NO ASSIGNEE AVATARS: there is no data behind either,
//     and a control with nothing behind it is a lie on a wired screen.
//  6. CARDS GROUP INSIDE THE COLUMNS, by SLICE (#608, the default), by AREA
//     (Board v5) or not at all (`bview.group`). The filter row lists every
//     group as a toggle, several at once, with Clear. A drop never re-files a
//     slice or an area: it writes `list_key` alone. An area head says when its
//     lane is held; a slice head says how much of it is built.
//  7. TWO DOUBLE-CLICKS, CHOSEN BY WHAT IS UNDER THE CURSOR. The title renames
//     in place; anywhere else flies the card onto the focus canvas, and ✎ does
//     the same with the editor open. Enter commits, Escape cancels, and BLUR
//     COMMITS, because losing a typed rename to a stray click is the worst
//     outcome. The rename PATCHes `title` alone. `draggable` is off while the
//     editor is open, or the drag eats the text selection. A double press on a
//     control is that control pressed twice, never the card behind it.
//  8. A `fly` CARD SAYS A SESSION FILED IT, and the chip outlives the `held`
//     chip, so "did I ask for this?" stays answerable.
//  9. EVERY POPOVER IS PORTALLED TO THE BODY (`Popover`). `.km-cols` scrolls
//     sideways, which clips both axes; its header has the anchoring rules.
// 10. `hl` NAMES A ROW THIS SCREEN CAN DRAW. Every card carries `data-hl`, so
//     links from Overview, the Timeline and the Terminal land on their card.
// 11. A CATCH-ALL COLUMN IS NOT OPTIONAL. Columns rename and delete, and
//     `listKeyOf` still derives into four keys; without the catch-all a card
//     with a deleted column renders nowhere. `lists.js` allows the delete only
//     because this lane exists.
//
// 12. THE BOARD DRAWS SLICED WORK (#608). A kept row in no slice is in the
//     ICEBOX (For you, beside Auto-ideas), not here; `homeOf` decides. Worked
//     rows are the exception and stay, in a "No slice" group, because in-flight
//     work must never vanish. A new card is born in the one picked slice, or
//     the current milestone's only slice; with neither it goes to the Icebox,
//     and the note line says so rather than letting the card vanish silently.
//     The strip above the toolbar is the milestone (detail/Spine.tsx).
// 13. THE PROPOSITIONS COLUMN COMES FIRST (detail/Propositions.tsx). It holds
//     proposals, not cards: no drop, no `project_lists` key, nothing counted
//     in "on the board". An accept makes ordinary sliced rows, which then
//     appear in the delivery columns; the tile only points at them.
//
// THE CARD MENU: Park/Unpark, Archive, Delete (a `hook` row's delete tombstones
// its fingerprint, so it has no undo), and Sign off on a held card. Edit item…
// opens the full modal, the only writer of a human `risk`.
//
// THE VERDICT IS GIVEN HERE (2026-11-11), on an In Review card with built work:
// Approve (verdict + tick, with Undo) or Send back (refine note, claim
// released, back to To Do). Built work awaiting a verdict shows whatever
// milestone is viewed. `approve` has the reasoning. A verdicted card is drawn
// in Done and says when a machine gave it.

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { KitIcon } from './kit/KitIcon';
import type { BoardArea, BoardList, ItemKind, Milestone, Priority, RoadmapItem, Slice } from '../types';
import { listKeyOf, clusterKeyOf, queueOrder, isBoardWork, isIced, sliceStateOf, isBuilt, homeOf, bucketRank } from '../lib/plan';
import { SpineStrip, SliceDialog, MilestoneDialog, SlicePicker, liveSlices, currentMilestone, sliceLabel } from './Spine';
import { isHeld } from '../lib/approval';
import { PRIORITY_META, PRIORITY_DEFAULT, priorityMeta, dueRead, ITEM_KIND_LABEL } from '../lib/ui';
import {
  getBoardShape, createList, patchList, deleteList,
  createArea, patchArea, deleteArea,
  getBoardFolds, setBoardFolds, getBoardView, setBoardView,
  createRoadmapItem, patchRoadmapItem, deleteRoadmapItem,
  putReadyQueue,
  createSlice, patchSlice, deleteSlice, createMilestone, patchMilestone, deleteMilestone,
  startBuild,
  queueTermLaunch, setStarred,
} from '../store';
import { StarMark } from '../components/Star';
import { DevelopmentView } from './Development';
import { go, hrefTo } from '../lib/route';
import { newTermName, termClaim, launchBrief } from '../lib/termLaunch';
import type { BoardFolds, BoardView, BoardSort, BoardShow, BoardGroup } from '../store';
import { BoardListView, SORT_LABEL, SHOW_LABEL } from './BoardList';
import { BoardFocus, type FocusOpen, type FocusPhase } from './BoardFocus';
import { PropositionsColumn } from './Propositions';

// The five priorities, their glyphs and their tones come from `lib/ui.ts` —
// ONE list, shared with the ＋ dock. This file carried its own copy of it while
// the vocabulary was still MoSCoW's four, which is how a card and a dock come
// to disagree about what Medium looks like.

// The lane for a card whose derived key has no column — decision 8 above. The
// leading space is what keeps it off `project_lists`, whose keys are slugs.
const CATCH_ALL = ' unlisted';

// The scope key for a card with no `area` at all. Untagged is a REAL state, not
// a missing one: `(project, '')` is never a lane (#267), so untagged work never
// occupies one and is never blocked by one — which is the load-bearing carve-out
// that stops every untagged item collapsing into a single giant lane. The
// leading space keeps it off any area an owner could actually type.
const UNTAGGED = ' untagged';

// #608 — the group key for a worked row in NO slice (or a slice this payload
// does not know). Leading space for the same reason as UNTAGGED: no slice key
// (`slice:<id>`) can collide with it.
const NO_SLICE = ' noslice';
const sliceKeyOf = (id: number) => `slice:${id}`;

/**
 * #507 — THE STORY-POINT SCALE the picker offers. Fibonacci-ish, which is the
 * convention this exists to match: the gaps widen as the number does, because
 * the difference between a 1 and a 2 is knowable and the difference between a
 * 13 and a 14 is not.
 *
 * IT IS A UI CONVENTION AND NOT A CONSTRAINT. The column stores a plain integer
 * with no CHECK, and `PATCH /roadmap/:id` rounds and clamps rather than
 * validating against this list — a board that inherited a 4 from an import
 * renders it, because refusing it here would lose it on the next unrelated
 * write to the same row.
 *
 * null is the SEVENTH option and the one the picker leads with, because
 * unsized is where every card starts and has to be able to get back to.
 */
const POINTS: number[] = [1, 2, 3, 5, 8, 13];

/**
 * The points on a set of cards, and HOW MANY OF THEM HAD NONE. Both halves are
 * returned because the sum alone lies: "8 points" across a column of nine cards
 * reads as a small column, and it is one sized card next to eight nobody has
 * looked at. Every head that shows the total says the gap beside it.
 */
const pointsOf = (list: RoadmapItem[]) => {
  let sum = 0; let unsized = 0;
  for (const it of list) {
    if (it.points === null || it.points === undefined) unsized += 1;
    else sum += it.points;
  }
  return { sum, unsized };
};

/**
 * Where a card would sit if it carried no override. `listKeyOf` returns the
 * stored `listKey` when there is one, which is right for DRAWING and wrong for
 * deciding whether a drop still needs an override — so blank it and ask again.
 */
const derivedKeyOf = (it: RoadmapItem): string => listKeyOf({ ...it, listKey: '' });

/**
 * THE ROW THAT JUST LANDED, for as long as its animation runs — the fourth of
 * the drag's four states (styles.css, "THE DRAG, AS THE KIT DRAWS IT"), shared
 * by the kanban and the Backlog tab so the two gestures cannot drift apart.
 *
 * The only time-based state on either screen, and deliberately the only thing
 * that may be: `land` is called with the ANSWER, never on the drop, so the
 * write it celebrates has already landed — a lapsed timer costs a flourish and
 * never a row, and a failed write flashes nothing. The timer is cleared on
 * unmount because a tab switched away mid-drop would otherwise set state on a
 * screen that is gone.
 */
function useLanded(): [number | null, (id: number) => void] {
  const [landedId, setLandedId] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  const land = useCallback((id: number) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setLandedId(id);
    timer.current = window.setTimeout(() => { setLandedId(null); timer.current = null; }, 900);
  }, []);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  return [landedId, land];
}

export function Board({ slug, projectName, items, milestones, slices, onRefresh, onEdit, onAreas, highlightId }: {
  slug: string;
  projectName: string;
  /** The project payload's own roadmap, flattened and IN PAYLOAD ORDER — see
   *  `queueOrder`, which relies on that order for its last sort key. */
  items: RoadmapItem[];

  /** #608 — the spine, from the same payload. A slice's state is derived from
   *  `items` (`sliceStateOf`), never carried on the slice. */
  milestones: Milestone[];
  slices: Slice[];
  /** Re-read the project payload. Called after every write that landed. */
  onRefresh: () => void;
  /** Open the item modal — still the only writer of a human `risk`. */
  onEdit: (it: RoadmapItem) => void;
  /** #473 — the project's REGISTERED areas, reported up whenever the board
   *  reads its shape. The item modal offers areas that are in use; this is how
   *  one registered a moment ago and used by nothing yet gets offered too. */
  onAreas?: (names: string[]) => void;
  highlightId: string | null;
}) {
  const [view, setView] = useState('board');

  // The rows this screen draws. Seeded from the payload and re-seeded whenever
  // it changes, but written THROUGH by every mutation below so a card moves
  // under the cursor rather than after a round trip. The write's own response
  // is the authority in between.
  const [rows, setRows] = useState<RoadmapItem[]>(items);
  useEffect(() => { setRows(items); }, [items]);

  // #608 — the spine, seeded the same way and written through by its dialogs.
  const [sl, setSl] = useState<Slice[]>(slices);
  useEffect(() => { setSl(slices); }, [slices]);
  const [ms, setMs] = useState<Milestone[]>(milestones);
  useEffect(() => { setMs(milestones); }, [milestones]);

  const planningSlices = useMemo(() => {
    const current = ms.find((m) => m.status === 'active');
    return sl.filter((s) => !s.archived && s.milestoneId === current?.id)
      .sort((a, b) => a.position - b.position || a.id - b.id).map((s) => s.id);
  }, [ms, sl]);

  const [lists, setLists] = useState<BoardList[] | null>(null);
  // The whole area ROW, not just its name: `dot` is what the section headers
  // and the scope chips are coloured with, and it is the owner's own choice
  // from the board's closed palette (routes/board.js).
  const [areas, setAreas] = useState<BoardArea[]>([]);
  const [err, setErr] = useState('');
  // #521 — what a write DID, when the answer is not visible on the board. A
  // queued build changes nothing you can see (the card stays where it is; the
  // dispatcher has not polled yet), so a silent success is indistinguishable
  // from a dead button. Separate from `err` because it is not one, and cleared
  // by the same presses.
  const [note, setNote] = useState('');
  // The receipt's one-press way back, for a write the owner may regret at
  // once: a verdict. Cleared by the same presses that clear the receipt.
  const [undo, setUndo] = useState<(() => Promise<void>) | null>(null);
  // The floating receipt clears itself; one with an Undo stays longer, since
  // the Undo is the only way back from a batch verdict.
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => { setNote(''); setUndo(null); }, undo ? 12000 : 6000);
    return () => window.clearTimeout(t);
  }, [note, undo]);

  // ---- THE FOLDS (#510 sections, #511 columns) -----------------------------
  //
  // Device-local, per project, through `store.ts` like everything else that
  // touches storage. Read ONCE per slug and written through on every toggle, so
  // a fold survives a tab switch and a reload without a round trip — there is
  // no server copy of this and there should not be: which columns you have
  // folded is not a fact about the work.
  //
  // Columns are keyed BOARD-WIDE and sections by area — getBoardFolds' header
  // says why the two are scoped differently, and it is the thing to read before
  // changing either.
  const [folds, setFolds] = useState<BoardFolds>(() => getBoardFolds(slug));
  useEffect(() => { setFolds(getBoardFolds(slug)); }, [slug]);
  const writeFolds = (next: BoardFolds) => { setFolds(next); setBoardFolds(slug, next); };
  const toggle = (list: string[], key: string) =>
    (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  const foldSection = (key: string) => writeFolds({ ...folds, open: toggle(folds.open, key) });
  const foldColumn = (key: string) => writeFolds({ ...folds, columns: toggle(folds.columns, key) });
  // Unfold one column without toggling it — what a drop onto a folded column
  // does. A card must never land somewhere the owner cannot see it.
  const unfoldColumn = (key: string) => {
    if (folds.columns.includes(key)) writeFolds({ ...folds, columns: folds.columns.filter((k) => k !== key) });
  };
  // …and the same for the card's area group, which folds in every column. Both
  // can fire on one drop, so this one reads what the first may have written.
  const unfoldArea = (key: string) => {
    const now = getBoardFolds(slug);
    if (!now.open.includes(key)) writeFolds({ ...now, open: [...now.open, key] });
  };

  // The palette an area may wear, served rather than duplicated here so the
  // picker can only offer what will actually store (routes/board.js). Empty
  // until the shape lands, and an empty palette simply draws no swatches.
  const [palette, setPalette] = useState<string[]>([]);

  const loadShape = useCallback(async () => {
    const shape = await getBoardShape(slug);
    setLists([...shape.lists].sort((a, b) => a.position - b.position || a.id - b.id));
    setAreas(shape.areas);
    setPalette(shape.palette || []);
    // #473 — hand the names UP. An area registered here a moment ago is on no
    // card yet, so the item modal's combobox (which offers the areas actually
    // IN USE) would not know about it — and "usable immediately on the item
    // being edited" was half the ask. The board is the only screen that reads
    // the registry, so it is the only screen that can report it.
    onAreas?.(shape.areas.map((a) => a.name));
  }, [slug]);

  useEffect(() => {
    let live = true;
    loadShape().catch((e) => {
      // A board that cannot read its columns is not a board, so this one says
      // so rather than drawing four it invented — the columns are the owner's,
      // and guessing them would file cards under names nobody chose.
      if (live) setErr((e as Error)?.message || 'Could not read this board’s columns.');
    });
    return () => { live = false; };
  }, [loadShape]);

  const guard = async (fn: () => Promise<void>) => {
    try { setErr(''); setNote(''); setUndo(null); await fn(); }
    catch (e) { setErr((e as Error)?.message || 'Something went wrong.'); }
  };

  // Replace one row in place, then re-read in the background. The in-place swap
  // is what the eye follows; the re-read is what catches everything the write
  // touched that the response does not carry.
  const wrote = (updated: RoadmapItem) => {
    setRows((r) => r.map((x) => (x.id === updated.id ? updated : x)));
    onRefresh();
  };

  // ---- filters --------------------------------------------------------------
  const [query, setQuery] = useState('');
  // THE AREA CHIPS FILTER, AND MORE THAN ONE CAN BE ON (Board v5). A press
  // toggles that area in or out of `picked`; nothing picked is every area, which
  // is what "All areas" sets. They filter rather than jump because the columns
  // lead now and the areas are groups inside them — there is no section to
  // jump to. UNTAGGED is an area like any other here: real work, and never an
  // overnight lane (#267). Screen state, not stored: a filter left on across a
  // reload is how a board looks half-empty for no reason anyone remembers.
  const [picked, setPicked] = useState<string[]>([]);
  const pickArea = (key: string) => {
    closeAll();
    setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  };
  const clearPicked = () => { closeAll(); setPicked([]); };
  // WHERE A NEW CARD IS BORN. With exactly one named area picked it is born in
  // it — the filter already said which area you are looking at, and a card that
  // vanished on creation because it landed untagged would read as a lost write.
  // Anything else files it untagged, which is never a lane and so never blocks.
  // Parked cards SHOW by default. Hiding them by default is how a parked item
  // becomes invisible work, which is the state #247 existed to end.
  const [hideParked, setHideParked] = useState(false);

  // AREAS OR LIST (owner's request, 2026-10-10). Areas is the lane-steering
  // layout below; List (detail/BoardList.tsx) is the finder: every row, area
  // as a tag, sortable, ideas included. Device-local per project, like folds.
  const [savedView, setBview] = useState<BoardView>(() => getBoardView(slug));
  // Projects organised only by area have nothing useful to group by slice.
  // Keep the preference so adding slices restores the owner's chosen view.
  const hasSlices = sl.some((s) => !s.archived);
  const bview: BoardView = savedView.group === 'slice' && !hasSlices
    ? { ...savedView, group: 'area' } : savedView;
  useEffect(() => { setBview(getBoardView(slug)); }, [slug]);
  const writeView = (patch: Partial<BoardView>) => {
    const next = { ...savedView, ...patch }; setBview(next); setBoardView(slug, next);
  };
  const [listArea, setListArea] = useState('');
  const listMode = bview.layout === 'list';
  // (#608: only while grouped by area; a slice pick names no area.)
  const homeArea = bview.group === 'area' && picked.length === 1 && picked[0] !== UNTAGGED ? picked[0] : '';

  // CLUSTERS (owner's call, 2026-11-02). A row with children on the board is a
  // cluster: one central idea whose PARTS are drawn inside its card, not as
  // cards of their own, and whose column is rolled up from them
  // (`clusterKeyOf`). A part whose parent is off the board (archived, or still
  // an auto-idea) is an ordinary card again, so no row ever vanishes.
  // #621 — GROUPED BY SLICE, THE SLICE IS THE CLUSTER: its group is drawn as
  // one (plates, bold title, a built bar), so `parent_id` clusters do not nest
  // inside it as well. Without this, a slice whose old parent card survived
  // (it had been worked) drew as a cluster card while every other slice drew
  // its parts loose, which read as two kinds of slice. Grouped by area or not
  // grouped, parent clusters draw as before.
  const partsOf = useMemo(() => {
    if (bview.group === 'slice') return new Map<number, RoadmapItem[]>();
    const onBoardIds = new Set(rows.filter((it) => !it.archived && isBoardWork(it)).map((it) => it.id));
    const m = new Map<number, RoadmapItem[]>();
    for (const it of rows) {
      if (it.archived || it.parentId === null || !onBoardIds.has(it.parentId)) continue;
      const bag = m.get(it.parentId);
      if (bag) bag.push(it); else m.set(it.parentId, [it]);
    }
    for (const bag of m.values()) bag.sort(queueOrder(planningSlices));
    return m;
  }, [rows, planningSlices, bview.group]);
  const isPart = (it: RoadmapItem) => it.parentId !== null && partsOf.has(it.parentId);
  const placeOf = (it: RoadmapItem) => clusterKeyOf(it, partsOf.get(it.id) || []);
  // WHAT THE IN REVIEW VERDICT STRIP MAY ANSWER: built and unverdicted (`isBuilt`
  // already excludes a verdict), or a cluster whose parts all are, or already
  // carry one. NOT `placeOf(it) === 'review'` alone: a card dragged into In
  // Review by hand has a stored `list_key` and nothing built to give a verdict on.
  const awaitsVerdict = (it: RoadmapItem) => {
    if (it.done || it.reviewTag) return false;
    const parts = partsOf.get(it.id) || [];
    if (!parts.length) return isBuilt(it);
    return parts.some(isBuilt) && parts.every((p) => isBuilt(p) || p.done || !!p.reviewTag);
  };

  // THE MILESTONE BEING VIEWED (owner's call, 2026-11-09): the strip's ‹ ›
  // flick through every milestone, in order, and the board shows that one's
  // slices. It starts on the current one; a row in no slice is shown only
  // there, since it belongs to no milestone. Screen state, never stored: the
  // board should always open on what is current.
  const [viewMsId, setViewMsId] = useState<number | null>(null);
  const msOrdered = useMemo(() => [...ms].sort((a, b) => a.position - b.position || a.id - b.id), [ms]);
  const curMs = currentMilestone(ms);
  const shownMs = ms.find((m) => m.id === viewMsId) || curMs || msOrdered[0] || null;
  const msOfRow = (it: RoadmapItem) => {
    const s = it.sliceId !== null ? sl.find((x) => x.id === it.sliceId) : undefined;
    return s ? s.milestoneId : null;
  };
  // THE BOARD SHOWS ONLY THE VIEWED MILESTONE (owner's call, 2026-11-12):
  // built cards from other milestones used to visit every view (2026-11-11),
  // which muddied what each milestone holds. A verdict owed elsewhere is not
  // hidden, though: the strip counts them and jumps to the nearest milestone
  // that owes one (`owedAway`), so none sits unanswerable behind a ‹ ›.
  const homeMs = (it: RoadmapItem) => msOfRow(it) ?? curMs?.id ?? shownMs?.id ?? null;
  const inView = (it: RoadmapItem) => !shownMs || homeMs(it) === shownMs.id;
  const owedAway = useMemo(() => {
    if (!shownMs) return [];
    return rows.filter((it) => !it.archived && isBoardWork(it) && !isPart(it) && awaitsVerdict(it) && homeMs(it) !== shownMs.id);
  }, [rows, partsOf, sl, shownMs?.id, curMs?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const jumpToOwed = () => {
    if (!shownMs || !owedAway.length) return;
    const at = msOrdered.findIndex((m) => m.id === shownMs.id);
    const owing = new Set(owedAway.map(homeMs));
    const next = msOrdered
      .map((m, i) => ({ m, d: Math.abs(i - at) }))
      .filter(({ m }) => owing.has(m.id))
      .sort((a, b) => a.d - b.d)[0];
    if (!next) return;
    closeAll(); setPicked([]);
    setViewMsId(next.m.id);
  };
  const stepMilestone = (dir: -1 | 1) => {
    if (!shownMs) return;
    const i = msOrdered.findIndex((m) => m.id === shownMs.id);
    const next = msOrdered[i + dir];
    if (!next) return;
    closeAll(); setPicked([]);
    setViewMsId(next.id);
  };

  // Search and the parked filter, but NOT the area filter: the chips count off
  // this, so a chip says what pressing it would show under the current search
  // (the counts follow the search box, and a picked chip does not zero the rest).
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows
      .filter((it) => !it.archived)
      // #472 — THE BOARD DRAWS COMMITTED WORK. An unsliced, untouched held row
      // is For you's Auto-ideas pane (#496); a SLICED held row is drawn here
      // with its `held` chip (2026-11-12). `homeOf` in lib/plan.ts is the one
      // line between the screens, so both cannot claim the same row. A row
      // somebody has CLAIMED OR BUILT is committed work whatever its sign-off
      // says, and lands here.
      .filter((it) => isBoardWork(it))
      .filter((it) => !isPart(it))
      .filter((it) => (hideParked ? !it.skipped : true))
      .filter(inView)
      // A cluster matches when it or any of its parts does: a part is found
      // by finding the card it is drawn inside.
      .filter((it) => !needle
        || [it, ...(partsOf.get(it.id) || [])].some((x) => x.title.toLowerCase().includes(needle)
          || x.note.toLowerCase().includes(needle)
          || String(x.id) === needle.replace(/^#/, '')));
  }, [rows, query, hideParked, partsOf, sl, shownMs?.id, curMs?.id]);

  // The List view's rows: the same search and parked filters, but NOT
  // `isBoardWork` — it is a finder across every screen (BoardList.tsx's header).
  const listRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows
      .filter((it) => !it.archived)
      .filter((it) => (hideParked ? !it.skipped : true))
      .filter((it) => !needle
        || it.title.toLowerCase().includes(needle)
        || it.note.toLowerCase().includes(needle)
        || String(it.id) === needle.replace(/^#/, ''));
  }, [rows, query, hideParked]);
  const listAreas = useMemo(() => {
    const names = new Set<string>();
    for (const it of listRows) if (it.area.trim()) names.add(it.area.trim());
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [listRows]);


  // `area` is `roadmap_items.area`, and (project, area) IS THE OVERNIGHT LANE
  // (#267) — an area with an open claimed item admits no second worker. So a
  // group says whether its lane is HELD and by which branch, which is the one
  // fact about an area that changes what the night can do.
  const areaKey = (it: RoadmapItem) => it.area.trim() || UNTAGGED;
  // #608 — the group a card is drawn in, by the board's grouping.
  const bySlice = bview.group === 'slice';
  const sliceGroup = (it: RoadmapItem) =>
    (it.sliceId !== null && sl.some((s) => s.id === it.sliceId) ? sliceKeyOf(it.sliceId) : NO_SLICE);
  const groupKey = (it: RoadmapItem) => (bySlice ? sliceGroup(it) : areaKey(it));
  const drawn = useMemo(
    () => (picked.length ? visible.filter((it) => picked.includes(groupKey(it))) : visible),
    [visible, picked, bySlice, sl],
  );
  // WHERE A NEW CARD IS BORN (#608): the one picked slice, else the current
  // milestone's only live slice, else nowhere, which is the Icebox. Guessing
  // between two slices would file work under a piece nobody chose.
  const cur = currentMilestone(ms);
  const homeSlice: Slice | null = (() => {
    if (bySlice && picked.length === 1 && picked[0] !== NO_SLICE) {
      return sl.find((s) => sliceKeyOf(s.id) === picked[0]) || null;
    }
    const inCur = liveSlices(sl, ms).filter((s) => s.milestoneId === (shownMs ?? cur)?.id);
    return inCur.length === 1 ? inCur[0] : null;
  })();
  const icedCount = rows.filter((it) => !it.archived && isIced(it)).length;

  // Registered areas first, in the board's own order, then any area that
  // exists only because some row mentions it — `area` is a free string and a
  // pushed-in area is a real area (routes/board.js says why). Untagged last.
  // Read off every row on the board, NOT the searched set: the filter row lists
  // every area whatever the search box says (Board v5), and a chip that
  // vanished mid-search would take a live pick with it.
  const areaOrder = useMemo(() => {
    const order = [...areas.map((a) => a.name)];
    let untagged = false;
    for (const it of rows) {
      if (it.archived || !isBoardWork(it)) continue;
      const k = areaKey(it);
      if (k === UNTAGGED) untagged = true;
      else if (!order.includes(k)) order.push(k);
    }
    if (untagged) order.push(UNTAGGED);
    return order;
  }, [rows, areas]);

  // #608 — the slice groups: every live slice (current milestone first, so an
  // empty one still has a chip to pick and create into), then any other slice
  // a board row is in, then "No slice" for worked rows that have none.
  const groupOrder = useMemo(() => {
    if (!bySlice) return areaOrder;
    const order = liveSlices(sl, ms).filter((s) => !shownMs || s.milestoneId === shownMs.id).map((s) => sliceKeyOf(s.id));
    let loose = false;
    for (const it of rows) {
      if (it.archived || !isBoardWork(it) || !inView(it)) continue;
      const k = sliceGroup(it);
      if (k === NO_SLICE) loose = true;
      else if (!order.includes(k)) order.push(k);
    }
    if (loose) order.push(NO_SLICE);
    return order;
  }, [bySlice, areaOrder, rows, sl, ms, shownMs?.id, partsOf]);

  // The lane holder per area: an OPEN item with a branch on it. Same predicate
  // as the server's holders query — not done, claim non-empty — and read off
  // the rows rather than fetched, so a hidden parked row can still be the
  // holder it really is. Untagged is never a lane, so it never has one.
  const holders = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of rows) {
      const k = areaKey(it);
      if (it.archived || it.done || k === UNTAGGED || m.has(k) || !it.claimedBy.trim()) continue;
      m.set(k, it.claimedBy);
    }
    return m;
  }, [rows]);
  const areaMeta = (k: string) => ({
    key: k,
    name: k === UNTAGGED ? 'No area' : k,
    dot: areas.find((a) => a.name === k)?.dot || '',
    untagged: k === UNTAGGED,
    holder: holders.get(k) || null,
  });
  const sliceOfKey = (k: string) => sl.find((s) => sliceKeyOf(s.id) === k) || null;
  const groupMeta = (k: string) => {
    if (!bySlice) return { ...areaMeta(k), slice: null as Slice | null };
    const slice = sliceOfKey(k);
    return {
      key: k, name: slice ? sliceLabel(slice, ms) : 'No slice', dot: '',
      untagged: !slice, holder: null as string | null, slice,
    };
  };

  // ---- the columns, with the AREAS GROUPED INSIDE THEM (Board v5) -----------
  //
  const searching = !!query.trim();

  // The columns lead and each one groups its cards by area, so a glance across
  // the top reads the board's state and a glance down a column reads which
  // lanes it is spread over. `grouped` off draws each column as one flat list.
  const grouped = bview.group !== 'none';
  const columns = useMemo(() => {
    const known = new Set((lists || []).map((l) => l.key));
    const byKey = new Map<string, RoadmapItem[]>();
    for (const it of drawn) {
      const derived = placeOf(it);
      const key = known.has(derived) ? derived : CATCH_ALL;
      const bag = byKey.get(key);
      if (bag) bag.push(it); else byKey.set(key, [it]);
    }
    for (const bag of byKey.values()) bag.sort(queueOrder(planningSlices));
    const cols = (lists || []).map((l) => ({ key: l.key, name: l.name, items: byKey.get(l.key) || [], real: true }));
    const orphans = byKey.get(CATCH_ALL);
    if (orphans?.length) cols.push({ key: CATCH_ALL, name: 'No column', items: orphans, real: false });
    return cols.map((col) => ({
      ...col,
      // #600 — a cluster is sized by its parts, so the column total adds the
      // parts in place of the cluster's own (unused) number.
      sized: col.items.flatMap((it) => partsOf.get(it.id) || [it]),
      groups: grouped
        ? groupOrder
          .map((k) => ({ key: k, items: col.items.filter((it) => groupKey(it) === k) }))
          .filter((g) => g.items.length > 0)
        : (col.items.length ? [{ key: '', items: col.items }] : []),
    }));
  }, [drawn, lists, groupOrder, grouped, planningSlices, partsOf]);

  // The chips: every area with cards on the board right now, plus untagged.
  // THE FILTER ROW, AS THE DESIGN HAS IT: every area on the board, each with
  // the number of its cards the search box still matches — zero included, so
  // a chip says what pressing it would show rather than disappearing.
  const chips = useMemo((): GroupOption[] => {
    const counts = new Map<string, number>();
    for (const it of visible) counts.set(groupKey(it), (counts.get(groupKey(it)) || 0) + 1);
    const opts = groupOrder.map((k) => {
      const m = groupMeta(k);
      if (!bySlice) return { key: k, name: m.name, dot: m.dot, n: counts.get(k) || 0 };
      // Under a milestone heading, the slice's own title: sliceLabel's
      // " · milestone" suffix would say the heading twice.
      const mile = m.slice ? ms.find((x) => x.id === m.slice!.milestoneId) : undefined;
      return { key: k, name: m.slice ? m.slice.title : 'No slice', n: counts.get(k) || 0, section: mile ? mile.name : '' };
    });
    // Grouped under their milestone, the current one first, the rest in
    // milestone order, and "No slice" last; stable within a milestone.
    if (!bySlice) return opts;
    const rank = (o: GroupOption) => {
      if (!o.section) return 1e9;
      const i = ms.findIndex((x) => x.name === o.section);
      const mm = ms[i];
      return (mm?.status === 'active' ? -1e6 : mm?.status === 'done' ? 1e6 : 0) + i;
    };
    return opts.map((o, i) => ({ o, i })).sort((x, y) => rank(x.o) - rank(y.o) || x.i - y.i).map((x) => x.o);
  }, [visible, areas, groupOrder, holders, sl, ms, bySlice]);
  // What an area's ⋯ says it would untag on delete: every card in it, not the
  // searched few.
  const areaTotal = (k: string) => rows.filter((it) => !it.archived && isBoardWork(it) && areaKey(it) === k).length;

  const onBoard = rows.filter((it) => !it.archived && isBoardWork(it));
  const shown = drawn.length;

  // A SEARCH SUSPENDS EVERY FOLD, and the fold controls go with it. A filter
  // that finds four cards and then draws them inside a folded strip has not
  // found them, and leaving the chevrons live during a search means pressing
  // one writes a fold whose effect you cannot see. Nothing stored is touched:
  // the folds come straight back when the box is cleared, which is why this is
  // a read-time override rather than a write.
  // Folds store the OPEN areas (an area lands folded, #524), so a search reads
  // every area as open rather than none as folded.
  const areaOpen = (key: string) => searching || folds.open.includes(key);
  const foldedColumns = searching ? [] : folds.columns;

  // An AREA fold folds that area's group in EVERY column. Collapse all folds
  // every area on screen and, once they all are, opens them.
  const groupKeys = [...new Set(columns.flatMap((c) => c.groups.map((g) => g.key)))];
  const foldsSuspended = searching && (groupKeys.some((k) => !folds.open.includes(k)) || folds.columns.length > 0);
  const allFolded = groupKeys.length > 0 && groupKeys.every((k) => !areaOpen(k));
  const collapseAll = () => {
    closeAll();
    writeFolds({
      ...folds,
      open: allFolded ? [...new Set([...folds.open, ...groupKeys])] : folds.open.filter((k) => !groupKeys.includes(k)),
    });
  };
  // A switch clears the picks: an area name means nothing as a slice filter.
  const setGroup = (group: BoardGroup) => { closeAll(); setPicked([]); writeView({ group }); };
  const parked = onBoard.filter((it) => it.skipped).length;
  // ---- card writes ----------------------------------------------------------
  const setBucket = (it: RoadmapItem, bucket: Priority) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, it.id, { bucket })); });

  // #507 — the size, or null to hand the card back to unsized. Same shape as
  // the bucket write above, and for the same reason: the card picker is the
  // board's own grammar for "one field, one press, written through".
  const setPoints = (it: RoadmapItem, points: number | null) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, it.id, { points })); });

  // #508 — the same one-field-one-press shape. The menu STAYS OPEN for both:
  // setting a kind and then a due date is one errand, and closing between them
  // would make it two.
  const setKind = (it: RoadmapItem, kind: ItemKind) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, it.id, { kind })); });
  const setDue = (it: RoadmapItem, dueOn: string | null) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, it.id, { dueOn })); });

  // Double-click a card, retype its title, Enter. The PATCH names `title` and
  // nothing else, so an inline edit cannot touch a tier, a claim or a verdict —
  // the same partial-write property that made trimming the modal safe.
  const retitle = (it: RoadmapItem, title: string) => {
    const next = title.trim();
    if (!next || next === it.title) return;
    return guard(async () => { wrote(await patchRoadmapItem(slug, it.id, { title: next })); });
  };

  // A drop writes `list_key` — and '' when the target IS the derived column, so
  // a card only carries an override for as long as it is somewhere its own
  // state would not have put it. Decision 3.
  const moveTo = (it: RoadmapItem, key: string) => {
    // A cluster's column is its parts' (`clusterKeyOf`): it has nothing to drop.
    if (key === CATCH_ALL || listKeyOf(it) === key || partsOf.has(it.id)) return;
    return guard(async () => {
      wrote(await patchRoadmapItem(slug, it.id, { listKey: derivedKeyOf(it) === key ? '' : key }));
      // THE FLASH IS FIRED BY THE ANSWER, NOT BY THE DROP. `wrote` is what
      // actually moves the card, and firing on the drop instead would start the
      // 900ms clock against a round trip — a slow one lands the card after its
      // own animation has expired, and a FAILED one flashes a card that never
      // moved. On this line the row is already in its new column.
      land(it.id);
    });
  };

  const park = (it: RoadmapItem) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, it.id, { skipped: !it.skipped })); });
  // THE SIGN-OFF IS BACK ON THIS SCREEN, because a held row can be on it again:
  // a `fly` or `hook` row a session claimed or built is committed work and is
  // drawn here (`homeOf` in lib/plan.ts), and so is a held row filed into a
  // slice, while STILL being held out of the runner by #359. Auto-ideas'
  // Promote cannot see either, so
  // without this the hold would be unanswerable from any browser — which is the
  // state #444 left and #359 called out by name.
  //
  // `reviewed` ALONE, never `parentId` with it. Promote's second half detaches
  // an idea from its feature, and a card here may legitimately be a child whose
  // work has started; silently re-parenting it as a side effect of approving it
  // would lose the filing somebody chose.
  const signOff = (it: RoadmapItem) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, it.id, { reviewed: true })); });
  const buildNow = (it: RoadmapItem) =>
    guard(async () => {
      const job = await startBuild(slug, it.id);
      // A 200 means a job for this project was ALREADY open and came back
      // instead of a second one stacking. Saying "queued" there would claim
      // this press did something it did not — the runner serialises per project
      // (CLAIM_NEXT_SQL), so the honest answer is which item is actually in
      // front of this one.
      const mine = String(job.itemId || '') === String(it.id);
      setNote(mine && job.status === 'queued'
        ? `Queued a build for #${it.id}. The dispatcher picks it up on its next poll.`
        : `This project already has a job ${job.status}${job.itemTitle ? ` — ${job.itemTitle}` : ''}. Runs are serialised per project, so #${it.id} waits for it.`);
      onRefresh();
    });
  // ⌨ RUN IN TERMINAL (#525) — the third way, and the only one that is YOU
  // working it rather than the fleet. lib/termLaunch.ts says why it is two
  // writes and no column: the claim moves the card to In Progress by
  // derivation, and the built_note the brief asks for moves it to In Review.
  //
  // THE CLAIM GOES FIRST, before anything spawns, so the night cannot take the
  // card between the click and the session starting. `listKey: ''` because a
  // card dragged into To Do by hand carries an override that would pin it
  // there through both moves.
  const runInTerminal = (it: RoadmapItem) =>
    guard(async () => {
      const tmux = newTermName();
      wrote(await patchRoadmapItem(slug, it.id, { claimed_by: termClaim(tmux), listKey: '' }));
      queueTermLaunch(tmux, launchBrief(slug, it, tmux));
      go.terminal(slug, tmux);
    });
  const readyIds = () => rows.filter((x) => x.ready && !x.done)
    .sort((a, b) => a.readyRank - b.readyRank).map((x) => x.id);
  const setReady = (it: RoadmapItem, on: boolean) =>
    guard(async () => {
      const ids = readyIds().filter((id) => id !== it.id);
      const { items: queued } = await putReadyQueue(slug, on ? [...ids, it.id] : ids);
      setRows((r) => r.map((x) => {
        const k = queued.indexOf(x.id);
        return k >= 0 ? { ...x, ready: true, readyRank: k } : x.ready ? { ...x, ready: false, readyRank: 0 } : x;
      }));
      setNote(on
        ? `#${it.id} is queued to build, ${queued.length === 1 ? 'alone in the queue' : `number ${queued.length} in the queue`}.`
        : `#${it.id} left the build queue.`);
      onRefresh();
    });
  const archive = (it: RoadmapItem) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, it.id, { archived: true })); });
  // Complete clears the visible Done cards and their parts by archiving them.
  // It preserves history and does not write a tick or a verdict.
  const [completing, setCompleting] = useState(false);
  const completeDone = (cards: RoadmapItem[]) => guard(async () => {
    setCompleting(true);
    const targets = new Map<number, RoadmapItem>();
    for (const card of cards) {
      targets.set(card.id, card);
      for (const part of partsOf.get(card.id) || []) targets.set(part.id, part);
    }
    let completed = 0;
    try {
      for (const item of targets.values()) {
        const updated = await patchRoadmapItem(slug, item.id, { archived: true });
        setRows((rs) => rs.map((x) => x.id === updated.id ? updated : x));
        completed += 1;
      }
      setNote(`${completed} item${completed === 1 ? '' : 's'} completed and archived. History is kept.`);
    } finally {
      setCompleting(false);
      onRefresh();
    }
  });
  // THE OWNER'S STAR (routes/starred.js): its own write, never the card PATCH,
  // and not priority, so nothing on this board sorts or gates by it.
  const star = (it: RoadmapItem) =>
    guard(async () => {
      const r = await setStarred(slug, 'cards', it.id, !it.starredAt);
      setRows((rs) => rs.map((x) => (x.id === it.id ? { ...x, starredAt: r.starredAt } : x)));
      onRefresh();
    });
  const derive = (it: RoadmapItem) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, it.id, { listKey: '' })); });
  const remove = (it: RoadmapItem) =>
    guard(async () => {
      await deleteRoadmapItem(slug, it.id);
      setRows((r) => r.filter((x) => x.id !== it.id));
      onRefresh();
    });

  // ---- THE VERDICT, from In Review (2026-11-11) ------------------------------
  //
  // The owner's verdict lived on `#/inbox` until that screen was removed, which
  // left built work with no way out of In Review from any browser. It is back
  // where the work is drawn.
  //
  // APPROVE IS A VERDICT AND A TICK, in one PATCH per row. The server's rule
  // that a verdict does not tick (lists.js) was written for the fleet, whose
  // merge job ticked after merging a branch. Work now lands from terminal
  // sessions committing to main, and nothing else ever ticks, so a verdict
  // alone left `done` false and every milestone at 0% for ever. The button's
  // title says the tick out loud, and Undo restores all three columns it touched.
  //
  // A CLUSTER IS ANSWERED WHOLE: the cluster row and each of its built parts.
  // Send back releases every built part's claim, or the cluster's rolled-up
  // column would still read In Review.
  const verdictRows = (it: RoadmapItem) =>
    [it, ...(partsOf.get(it.id) || []).filter((p) => isBuilt(p))];
  // APPROVE ALL, per slice group (2026-11-11): the same verdict on every card
  // in the group that is waiting for one, one PATCH per row, and ONE Undo for
  // the lot. No confirm (owner's call, 2026-11-11): the Undo is the safety.
  const approve = (it: RoadmapItem) => approveMany([it]);
  const approveMany = (cards: RoadmapItem[]) =>
    guard(async () => {
      const it = cards[0];
      if (!it) return;
      const targets = cards.flatMap(verdictRows);
      const before = targets.map((x) => ({ id: x.id, done: x.done, claimedBy: x.claimedBy, reviewTag: x.reviewTag }));
      const out: RoadmapItem[] = [];
      for (const x of targets) out.push(await patchRoadmapItem(slug, x.id, { review_tag: 'solid', done: true }));
      setRows((r) => r.map((x) => out.find((o) => o.id === x.id) || x));
      onRefresh();
      setNote(cards.length > 1
        ? `${cards.length} cards approved and ticked. They are in Done and count as landed.`
        : `#${it.id} approved and ticked${targets.length > 1 ? `, with ${targets.length - 1} built part${targets.length === 2 ? '' : 's'}` : ''}. It is in Done and counts as landed.`);
      setUndo(() => async () => {
        const back: RoadmapItem[] = [];
        for (const b of before) {
          back.push(await patchRoadmapItem(slug, b.id, { review_tag: b.reviewTag, done: b.done, claimed_by: b.claimedBy }));
        }
        setRows((r) => r.map((x) => back.find((o) => o.id === x.id) || x));
        onRefresh();
        setNote(cards.length > 1 ? `${cards.length} cards are back in In Review, with no verdict.` : `#${it.id} is back in In Review, with no verdict.`);
      });
    });
  const sendBack = (it: RoadmapItem, text: string) =>
    guard(async () => {
      const out: RoadmapItem[] = [await patchRoadmapItem(slug, it.id, { refine_note: text, claimed_by: '', listKey: '' })];
      for (const p of verdictRows(it).slice(1)) out.push(await patchRoadmapItem(slug, p.id, { claimed_by: '', listKey: '' }));
      setRows((r) => r.map((x) => out.find((o) => o.id === x.id) || x));
      onRefresh();
      setNote(`#${it.id} went back to To Do with your note. Run it in a terminal and the session starts from what you asked for.`);
    });

  // ---- the spine (#608) -----------------------------------------------------
  // Into a slice, or null to the Icebox. Icing a Ready row takes it out of the
  // build queue on the server in the same write, and the note says so.
  const moveSlice = (it: RoadmapItem, sliceId: number | null) =>
    guard(async () => {
      if (sliceId === it.sliceId) return;
      wrote(await patchRoadmapItem(slug, it.id, { sliceId }));
      if (sliceId === null) setNote(`#${it.id} went to the Icebox${it.ready ? ' and left the build queue' : ''}.`);
    });
  const [sliceEdit, setSliceEdit] = useState<{ slice: Slice | null } | null>(null);
  const [msEdit, setMsEdit] = useState(false);
  const saveSlice = (v: { title: string; spec: string; areas: string[]; milestoneId: number | null }) =>
    guard(async () => {
      const editing = sliceEdit?.slice ?? null;
      setSliceEdit(null);
      if (editing) {
        const next = await patchSlice(slug, editing.id, {
          title: v.title, spec: v.spec, areas: v.areas, ...(v.milestoneId !== null ? { milestoneId: v.milestoneId } : {}),
        });
        setSl((xs) => xs.map((x) => (x.id === next.id ? next : x)));
      } else {
        const made = await createSlice(slug, { title: v.title, spec: v.spec, areas: v.areas, ...(v.milestoneId !== null ? { milestoneId: v.milestoneId } : {}) });
        setSl((xs) => [...xs, made]);
        // Pick it, so the next card is born in it: a slice is made empty, and
        // without this the board would look exactly as it did.
        if (bySlice) setPicked([sliceKeyOf(made.id)]);
      }
      onRefresh();
    });
  const dropSlice = (slice: Slice) =>
    guard(async () => {
      setSliceEdit(null);
      const { iced } = await deleteSlice(slug, slice.id);
      setSl((xs) => xs.filter((x) => x.id !== slice.id));
      setPicked((ps) => ps.filter((k) => k !== sliceKeyOf(slice.id)));
      setNote(iced.length ? `Deleted “${slice.title}”. Its ${iced.length} item${iced.length === 1 ? '' : 's'} went to the Icebox.` : `Deleted “${slice.title}”.`);
      onRefresh();
    });
  const msWrote = (m: Milestone) => {
    // Making one current finishes the incumbent on the server; mirror that here
    // so the strip is right before the re-read lands.
    setMs((xs) => {
      const rest = xs.filter((x) => x.id !== m.id).map((x) => (m.status === 'active' && x.status === 'active' ? { ...x, status: 'done' as const } : x));
      return [...rest, m].sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || a.position - b.position || a.id - b.id);
    });
    onRefresh();
  };
  const saveMilestone = (id: number, v: { name: string; goal: string; targetOn: string | null }) =>
    guard(async () => { setMsEdit(false); msWrote(await patchMilestone(slug, id, v)); });
  const startMilestone = (v: { name: string; goal: string; targetOn: string | null }) =>
    guard(async () => { setMsEdit(false); msWrote(await createMilestone(slug, { ...v, status: 'active' })); });
  const makeCurrent = (id: number) =>
    guard(async () => { setMsEdit(false); setViewMsId(null); msWrote(await patchMilestone(slug, id, { status: 'active' })); });

  // A card born in a column that is not its derived one carries the override
  // from the start; one born in To Do does not, because it would derive there
  // anyway. Two calls rather than one because POST has no `listKey`.
  /**
   * `extra` is what the CREATE DIALOG can set and the lane composer cannot
   * (#507, #508). The composer is the fast path — a title and how necessary it
   * is — and a card born through it stays unsized, unkinded and undated, which
   * is the honest default: a size or a deadline nobody chose must not read as
   * one somebody did.
   */
  const add = (title: string, bucket: Priority, key: string, area: string,
               extra: { points?: number | null; kind?: ItemKind; dueOn?: string | null } = {}) =>
    guard(async () => {
      // A card created inside an area section is BORN in that area. It is the
      // one place this screen writes `area` at all, and it is safe precisely
      // because the section header already said what the area means: it is a
      // lane, and adding a card to one cannot take it off another.
      const made = await createRoadmapItem(slug, {
        title, note: '', bucket, ...(area ? { area } : {}), ...(homeSlice ? { sliceId: homeSlice.id } : {}), ...extra,
      });
      const final = key && key !== CATCH_ALL && derivedKeyOf(made) !== key
        ? await patchRoadmapItem(slug, made.id, { listKey: key })
        : made;
      setRows((r) => [...r, final]);
      // #608 — a card with no slice is born in the Icebox, which is not this
      // screen. Say where it went, or it reads as a lost write.
      if (final.sliceId === null) {
        setNote(`#${final.id} went to the Icebox: there is no single slice to create it in. Pick one slice to create cards on the board.`);
      }
      onRefresh();
    });

  // ---- column writes --------------------------------------------------------
  const renameCol = (key: string, name: string) =>
    guard(async () => { await patchList(slug, key, { name }); await loadShape(); });
  // A SWAP of two positions, which is what the server's PATCH takes and what a
  // left/right press actually means. The neighbour is whatever is next in the
  // drawn order, so a board with holes in its positions still moves correctly.
  const moveCol = (key: string, dir: -1 | 1) =>
    guard(async () => {
      const all = lists || [];
      const i = all.findIndex((l) => l.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= all.length) return;
      await patchList(slug, key, { position: all[j].position });
      await loadShape();
    });
  const dropCol = (key: string) =>
    guard(async () => { await deleteList(slug, key); await loadShape(); onRefresh(); });
  const addCol = (name: string) =>
    guard(async () => { await createList(slug, name); await loadShape(); });

  // ---- area writes (#473) ---------------------------------------------------
  //
  // All three answer with the WHOLE list, so each sets `areas` from the reply
  // rather than re-reading — but a RENAME and a DELETE both rewrite
  // `roadmap_items.area`, so those two also call `onRefresh()`: the cards on
  // screen carry the old string until the payload comes back, and a section
  // drawn from a stale tag is a section the drop handler will file work into
  // under a name that no longer exists.
  // AND PICK IT. An area is registered with nothing in it by definition, so
  // without this the create would land, the chip would appear, and the board
  // would look exactly as it did. Picking it alone is what makes it "usable
  // immediately": the next card created is born in it (`homeArea`). The key comes off the RESPONSE rather than off the
  // typed string, because the server normalises a name (lowercase, trimmed to
  // 40) and picking what was typed would miss.
  const addArea = (name: string) =>
    guard(async () => {
      const before = new Set(areas.map((a) => a.name));
      const next = await createArea(slug, name);
      setAreas(next);
      const made = next.find((a) => !before.has(a.name))?.name;
      if (made) setPicked([made]);
    });
  // The filter follows the area through a rename, and so does its fold.
  const renameArea = (from: string, to: string) =>
    guard(async () => {
      setAreas(await patchArea(slug, from, { name: to }));
      const key = to.trim().toLowerCase();
      setPicked((p) => p.map((k) => (k === from ? key : k)));
      if (folds.open.includes(from)) writeFolds({ ...folds, open: folds.open.map((k) => (k === from ? key : k)) });
      onRefresh();
    });
  const recolourArea = (name: string, dot: string) =>
    guard(async () => { setAreas(await patchArea(slug, name, { dot })); });
  // THE CARDS DO NOT GO WITH IT — the route clears the tag and leaves the work,
  // which lands it untagged. A filter on it follows it there rather than
  // pointing at an area that no longer exists.
  const dropArea = (name: string) =>
    guard(async () => {
      setAreas(await deleteArea(slug, name));
      setPicked((p) => (p.includes(name) ? [...new Set(p.map((k) => (k === name ? UNTAGGED : k)))] : p));
      onRefresh();
    });

  // ---- transient UI ---------------------------------------------------------
  const [selected, setSelected] = useState<number | null>(null);
  const [menu, setMenu] = useState<string | null>(null);          // open column menu
  const [areaMenu, setAreaMenu] = useState<string | null>(null);  // open area menu (#473)
  const [cardMenu, setCardMenu] = useState<number | null>(null);  // open card menu
  const [priMenu, setPriMenu] = useState<number | null>(null);
  const [ptsMenu, setPtsMenu] = useState<number | null>(null);   // open points picker (#507)
  const [composer, setComposer] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  // The card whose TITLE is being edited in place. One at a time: two open
  // editors on one board is two unsaved drafts and no way to tell them apart.
  const [inlineId, setInlineId] = useState<number | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [landedId, land] = useLanded();
  const closeAll = () => { setMenu(null); setPriMenu(null); setPtsMenu(null); setCardMenu(null); setAreaMenu(null); };

  // ---- THE FOCUS CANVAS (detail/BoardFocus.tsx) ------------------------------
  // A double-click on a card (or its ✎) flies it onto the canvas. The phase is
  // lifted here because the board itself animates with it: it steps back while
  // the card is out (`fx-out`) and comes back as it lands (`fx-in`).
  const [focus, setFocus] = useState<FocusOpen | null>(null);
  const [focusPhase, setFocusPhase] = useState<FocusPhase>('measure');
  // A SLICE ZOOMS ON THE FOCUS CANVAS (BoardFocus decision 6): the slice flies
  // out of its group head with its tasks drawn in around it. `editId` opens
  // one of them in the editor straight away.
  const openSlice = (slice: Slice, el: HTMLElement | null, editId?: number) => {
    if (focus || !el) return;
    closeAll(); setInlineId(null); setDragId(null); setOver(null);
    const head = el.closest('.km-group')?.querySelector('.km-grouphead') as HTMLElement | null;
    const r = (head || el).getBoundingClientRect();
    const main = el.closest('.con-main') || el.closest('.km');
    if (editId != null) setSelected(editId);
    setFocusPhase('measure');
    setFocus({ id: -slice.id, sliceId: slice.id, from: { l: r.left, t: r.top, w: r.width },
      edit: editId != null, editId,
      home: `.km-cols .km-group[data-area="${sliceKeyOf(slice.id)}"] .km-grouphead`,
      canvasLeft: Math.round(main?.getBoundingClientRect().left ?? 0) });
  };
  const openFocus = (it: RoadmapItem, el: HTMLElement | null, edit: boolean, editId?: number) => {
    if (focus || !el) return;
    // A task in a slice is not a thing of its own (owner's call, 2026-11-09):
    // it opens its slice, with the task in the editor.
    const home = it.sliceId !== null ? sl.find((x) => x.id === it.sliceId) : undefined;
    if (home) { openSlice(home, el, editId ?? it.id); return; }
    closeAll(); setInlineId(null); setDragId(null); setOver(null);
    const r = el.getBoundingClientRect();
    const main = el.closest('.con-main') || el.closest('.km');
    setSelected(it.id);
    setFocusPhase('measure');
    setFocus({ id: it.id, from: { l: r.left, t: r.top, w: r.width }, edit, editId,
      canvasLeft: Math.round(main?.getBoundingClientRect().left ?? 0) });
  };
  // How many children each card has, and how many are finished — the card's
  // "2/3 done" tag. Off every row, not the drawn set: a child filtered out of
  // view is still a child.
  const kidCounts = useMemo(() => {
    const m = new Map<number, { done: number; total: number }>();
    for (const it of rows) {
      if (it.archived || it.parentId === null) continue;
      const c = m.get(it.parentId) || { done: 0, total: 0 };
      c.total += 1;
      if (it.done || listKeyOf(it) === 'shipped') c.done += 1;
      m.set(it.parentId, c);
    }
    return m;
  }, [rows]);
  // A child task made on the canvas: born under its parent, in its area, as a task.
  const createChild = async (parent: RoadmapItem, title: string): Promise<RoadmapItem | undefined> => {
    let made: RoadmapItem | undefined;
    await guard(async () => {
      made = await createRoadmapItem(slug, { title, note: '', bucket: PRIORITY_DEFAULT, kind: 'task',
        parentId: parent.id, ...(parent.area.trim() ? { area: parent.area } : {}) });
      setRows((r) => [...r, made!]);
      onRefresh();
    });
    return made;
  };
  // A task made on a slice's canvas: born in the slice, as a task.
  const createInSlice = async (slice: Slice, title: string): Promise<RoadmapItem | undefined> => {
    let made: RoadmapItem | undefined;
    await guard(async () => {
      made = await createRoadmapItem(slug, { title, note: '', bucket: PRIORITY_DEFAULT, kind: 'task', sliceId: slice.id });
      setRows((r) => [...r, made!]);
      onRefresh();
    });
    return made;
  };
  const focusPatch = (it: RoadmapItem, patch: Parameters<typeof patchRoadmapItem>[2]) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, it.id, patch)); });
  const colOf = (it: RoadmapItem) => {
    const k = placeOf(it);
    return (lists || []).some((l) => l.key === k) ? k : CATCH_ALL;
  };

  // A deep link SELECTS its row; the scroll to it is ProjectDetail's, off the
  // `data-hl` each card now carries.
  useEffect(() => {
    const n = Number(highlightId);
    if (Number.isFinite(n) && n > 0) setSelected(n);
  }, [highlightId]);
  // …AND OPENS THE WAY TO IT, the drop's rule: a card the link names must not
  // sit behind a folded column or group (a slice group starts folded), or the
  // link lands on nothing. Unfold, never toggle; once per link, after the rows
  // that hold it have arrived.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    const n = Number(highlightId);
    if (!highlightId || revealed.current === highlightId || !(Number.isFinite(n) && n > 0)) return;
    const it = rows.find((x) => x.id === n);
    if (!it || !lists) return;
    revealed.current = highlightId;
    unfoldColumn(colOf(it));
    unfoldArea(groupKey(it));
  }, [highlightId, rows, lists]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className={`km${focus ? (focusPhase === 'back' ? ' fx-in' : ' fx-out') : ''}`} onClick={closeAll}
        style={focus ? { ['--km-d' as string]: `${typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 620}ms` } : undefined}>
        <div className="km-head">
          <span className="km-crumb">Spaces / {projectName}</span>
          <div className="km-headrow">
            <h1>{projectName}</h1>
            <span className="k-tag mono">{slug}</span>
            <button className="k-btn sm km-create" onClick={() => setDialog(true)}>
              <KitIcon name="plus" size={14} />Create issue
            </button>
          </div>
        </div>


        <div className="k-tabs km-tabs">
          {[
            { value: 'board', label: 'Board', count: shown },
            { value: 'backlog', label: 'Backlog' },
            { value: 'dev', label: 'Development' },
          ].map((t) => (
            <button key={t.value} className={`k-tab${view === t.value ? ' on' : ''}`}
              onClick={() => setView(t.value)}>
              {t.label}
              {t.count !== undefined && <span className="n">{t.count}</span>}
            </button>
          ))}
        </div>

        {err && <div className="km-err" role="alert">{err}</div>}
        {/* #521 — the receipt for a write with no visible effect. `status` and
            not `alert`: it is confirmation, not a problem, and an assertive
            live region would interrupt a screen reader mid-sentence to say
            something went RIGHT.
            IT FLOATS (owner's call, 2026-11-11): drawn in the flow, it pushed
            the whole board down the moment a card was approved, so the board
            jumped under the pointer. Fixed to the viewport, it moves nothing,
            and it clears itself after a while (`note`'s effect) or on ×. */}
        {note && (
          <div className="km-note km-toast" role="status">
            <span className="msg">{note}</span>
            {undo && <button className="km-undo" onClick={() => { const u = undo; void guard(u); }}>Undo</button>}
            <button className="km-toastx" aria-label="Dismiss" onClick={() => { setNote(''); setUndo(null); }}>
              <KitIcon name="x" size={13} />
            </button>
          </div>
        )}

        {view === 'backlog' && (
          <BacklogView rows={rows} slices={sl} milestones={ms} lists={lists || []}
            onCreate={() => setDialog(true)} onEdit={onEdit} />
        )}
        {view === 'dev' && <DevelopmentView slug={slug} items={rows} onOpen={onEdit} />}

        {view === 'board' && <>
        <SpineStrip milestones={ms} slices={sl} iced={icedCount}
          viewing={shownMs} position={shownMs ? msOrdered.findIndex((m) => m.id === shownMs.id) : -1} total={msOrdered.length}
          onStep={stepMilestone} onCurrent={curMs && shownMs?.id !== curMs.id ? () => { closeAll(); setPicked([]); setViewMsId(null); } : undefined}
          onMilestone={() => { closeAll(); setMsEdit(true); }}
          onNewSlice={() => { closeAll(); setSliceEdit({ slice: null }); }}
          onIcebox={() => go.detail(slug, 'auto')} milestonesHref={hrefTo.detail(slug, 'milestones')}
          owedAway={owedAway.length} onOwedAway={jumpToOwed} />
        {!listMode && !bySlice && (
          <section className="km-areas" aria-label="Project areas">
            <div className="km-areas-head">
              <div><h2>Areas</h2><p>Select an area to focus the board.</p></div>
              <button className={`k-btn sm secondary${picked.length ? '' : ' on'}`}
                aria-pressed={picked.length === 0} onClick={clearPicked}>All areas</button>
              <AddArea onAdd={addArea} />
            </div>
            <div className="km-area-grid">
              {chips.map((area) => {
                const selected = picked.includes(area.key);
                const description = areas.find((a) => a.name === area.key)?.description;
                return <button key={area.key} className={`km-area-card${selected ? ' selected' : ''}`}
                  aria-pressed={selected} aria-label={`Show ${area.name}`}
                  onClick={() => {
                    closeAll();
                    setPicked(selected && picked.length === 1 ? [] : [area.key]);
                    unfoldArea(area.key);
                  }}>
                  <span className="km-area-title">
                    {area.dot && <span className="km-dot" style={{ background: area.dot }} />}
                    <span>{area.name}</span>
                    {selected && <KitIcon name="check" size={14} />}
                  </span>
                  {description && <span className="km-area-description">{description}</span>}
                  <span className="km-area-count">{area.n} board item{area.n === 1 ? '' : 's'}</span>
                </button>;
              })}
            </div>
          </section>
        )}
        <div className="km-toolbar">
          <span className="searchbox sm km-search">
            <KitIcon name="search" size={14} />
            <input placeholder="Search board" aria-label="Search board" value={query}
              onChange={(e) => setQuery(e.target.value)} />
          </span>

          <div className="seg-control sm km-layout" role="tablist" aria-label="Board layout">
            <button role="tab" aria-selected={!listMode} className={`seg-opt${listMode ? '' : ' on'}`}
              onClick={() => writeView({ layout: 'areas' })}>Board</button>
            <button role="tab" aria-selected={listMode} className={`seg-opt${listMode ? ' on' : ''}`}
              onClick={() => writeView({ layout: 'list' })}>List</button>
          </div>

          {listMode && <>
            <select className="k-select sm" aria-label="Sort" value={bview.sort}
              onChange={(e) => writeView({ sort: e.target.value as BoardSort })}>
              {(Object.keys(SORT_LABEL) as BoardSort[]).map((k) => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
            </select>
            <select className="k-select sm" aria-label="Show" value={bview.show}
              onChange={(e) => writeView({ show: e.target.value as BoardShow })}>
              {(Object.keys(SHOW_LABEL) as BoardShow[]).map((k) => <option key={k} value={k}>{SHOW_LABEL[k]}</option>)}
            </select>
            <select className="k-select sm" aria-label="Area" value={listArea}
              onChange={(e) => setListArea(e.target.value)}>
              <option value="">All areas</option>
              {listAreas.map((a) => <option key={a} value={a}>{a}</option>)}
              <option value={UNTAGGED}>No area</option>
            </select>
          </>}

          {/* THE GROUP FILTER — slices or areas, whichever the board groups
              by. Gone in the list and when nothing is grouped. */}
          {!listMode && grouped && bySlice && (
            <GroupFilter noun={bySlice ? 'slices' : 'areas'} options={chips} picked={picked} multi
              onToggle={pickArea} onClear={clearPicked} />
          )}

          {/* Parked is a FILTER and never the default — see `hideParked`. */}
          <button className={`k-btn sm secondary km-parked${hideParked ? ' on' : ''}`}
            onClick={() => setHideParked(!hideParked)}
            title="Parked items are planned and deliberately not picked up. The autopilot skips them.">
            <KitIcon name="layers" size={14} />{hideParked ? 'Parked hidden' : `Parked shown${parked ? ` (${parked})` : ''}`}
          </button>

          {/* GROUP BY AREA is stored with the layout (device-local, per
              project): it is how you like to read this board, not a fact
              about the work. Off draws each column as one flat list. */}
          {!listMode && (
            <select className="k-select sm km-grouped" aria-label="Group cards by" value={bview.group}
              title="What each column groups its cards by"
              onChange={(e) => setGroup(e.target.value as BoardGroup)}>
              <option value="slice" disabled={!hasSlices}>Grouped by slice</option>
              <option value="area">Grouped by area</option>
              <option value="none">Not grouped</option>
            </select>
          )}

          {/* Collapse all folds every AREA in every column, and opens them all
              once they are folded; the columns keep their own folds. Gone while
              searching, like every other fold control, and with the grouping. */}
          {!searching && !listMode && grouped && (
            <button className="k-btn sm secondary km-collapseall" onClick={collapseAll}
              data-all-folded={allFolded}
              disabled={groupKeys.length === 0}
              title={allFolded ? 'Open every group' : 'Fold every group to its header, in every column'}>
              <KitIcon name={allFolded ? 'chevron-down' : 'chevron-right'} size={14} />{allFolded ? 'Expand all' : 'Collapse all'}
            </button>
          )}

          {/* #473 — registering an area. It lives in the toolbar rather than the
              filter row, which holds the areas and nothing else (Board v5). */}
          {!listMode && bySlice && <AddArea onAdd={addArea} />}

          <span className="km-count">
            {listMode
              ? `${listRows.length} item${listRows.length === 1 ? '' : 's'}, ideas included`
              : <>{shown} of {onBoard.length} on the board
                {foldsSuspended && <span className="km-unfolded"> · folds suspended while searching</span>}</>}
          </span>
        </div>

        {listMode && lists && (
          <BoardListView rows={listRows} sort={bview.sort} show={bview.show} area={listArea}
            lists={lists} areas={areas} slices={sl} milestones={ms} planningSlices={planningSlices}
            selected={selected} onOpen={(it) => { setSelected(it.id); onEdit(it); }} />
        )}

        {!listMode && <>

        {shown === 0 && (
          <div className="km-colempty">
            {query.trim() || hideParked || picked.length ? 'Nothing matches those filters.' : 'No cards on this board yet.'}
          </div>
        )}

        <div className="km-cols">
          {/* PROPOSITIONS FIRST (detail/Propositions.tsx): proposed work, not
              cards. It takes no drop and is not a `project_lists` column. */}
          <PropositionsColumn slug={slug} milestones={ms} onAccepted={onRefresh} />
          {columns.map((col, ci) => {
            const colFolded = foldedColumns.includes(col.key);
            const dragged = dragId === null ? null : rows.find((x) => x.id === dragId) || null;
            // A drop writes `list_key` and only that, so it can never re-file an
            // area: the card keeps its lane (#267) whichever column it lands in.
            const takesDrop = !!dragged && col.real;
            // THE COLUMN THE CARD IS ALREADY IN IS NOT A TARGET. `moveTo` has
            // always no-opped on it; the drag SAYS SO — no highlight, no
            // preview, no landing flash. Membership, not `listKeyOf`: a card in
            // the catch-all lane derives into a key this board has no column
            // for, and every real column is a move for it.
            const isSource = dragId !== null && col.items.some((x) => x.id === dragId);
            const wouldMove = takesDrop && !isSource;
            const isOver = over === col.key && wouldMove;
            const card = (it: RoadmapItem) => (
              <IssueCard key={it.id} item={it}
                parentItem={it.parentId !== null ? rows.find((x) => x.id === it.parentId) || null : null}
                kids={kidCounts.get(it.id) || null}
                parts={partsOf.get(it.id) || null}
                away={!!focus && focus.id === it.id && focusPhase !== 'measure'}
                onOpen={(el, edit, editId) => openFocus(it, el, edit, editId)}
                selected={selected === it.id}
                onSelect={() => setSelected(it.id)}
                dragging={dragId === it.id}
                landed={landedId === it.id}
                onDragStart={() => { closeAll(); setDragId(it.id); }}
                onDragEnd={() => { setDragId(null); setOver(null); }}
                editing={inlineId === it.id}
                onOpenInline={() => { closeAll(); setInlineId(it.id); }}
                onInline={(title) => { setInlineId(null); retitle(it, title); }}
                onCancelInline={() => setInlineId(null)}
                priOpen={priMenu === it.id}
                onPri={(e) => { e.stopPropagation(); closeAll(); setPriMenu(priMenu === it.id ? null : it.id); }}
                onPick={(v) => { setPriMenu(null); setBucket(it, v); }}
                ptsOpen={ptsMenu === it.id}
                onPts={(e) => { e.stopPropagation(); closeAll(); setPtsMenu(ptsMenu === it.id ? null : it.id); }}
                onPoints={(v) => { setPtsMenu(null); setPoints(it, v); }}
                menuOpen={cardMenu === it.id}
                onMenu={(e) => { e.stopPropagation(); closeAll(); setCardMenu(cardMenu === it.id ? null : it.id); }}
                onKind={(v) => setKind(it, v)}
                onDue={(v) => setDue(it, v)}
                onEdit={() => { setCardMenu(null); onEdit(it); }}
                onSignOff={() => { setCardMenu(null); signOff(it); }}
                onBuildNow={() => { setCardMenu(null); buildNow(it); }}
                onRun={col.key === 'planned' && !it.done && !String(it.claimedBy || '').trim() && !isHeld(it)
                  ? () => { closeAll(); setCardMenu(null); runInTerminal(it); } : undefined}
                // On ANY column, not only In Review: a built card somebody
                // dragged into Done by hand still has no verdict.
                verdict={awaitsVerdict(it) ? {
                  onApprove: () => { closeAll(); approve(it); },
                  onSendBack: (text) => { closeAll(); sendBack(it, text); },
                } : undefined}
                elsewhere={(() => {
                  const m = msOfRow(it);
                  return shownMs && m !== null && m !== shownMs.id ? ms.find((x) => x.id === m)?.name || '' : '';
                })()}
                onReady={(on) => { setCardMenu(null); setReady(it, on); }}
                slices={sl} milestones={ms}
                onSlice={(sid) => { setCardMenu(null); moveSlice(it, sid); }}
                tint={areaMeta(areaKey(it)).dot}
                showArea={!grouped}
                onPark={() => { setCardMenu(null); park(it); }}
                onArchive={() => { setCardMenu(null); archive(it); }}
                onStar={() => { setCardMenu(null); star(it); }}
                onDerive={() => { setCardMenu(null); derive(it); }}
                onDelete={() => { setCardMenu(null); remove(it); }} />
            );
            // THE `dragleave` GUARD BELOW IS WHAT STOPS THE PREVIEW STROBING.
            // `dragleave` fires on this column every time the cursor crosses
            // onto one of its own cards, and the `dragover` that follows
            // re-sets `over`, replaying the slot animation on every card
            // boundary. Only a leave off the COLUMN ITSELF counts.
            return (
              <div key={col.key} style={{ ['--ci' as string]: ci }}
                className={`km-col${colFolded ? ' folded' : ''}${isOver ? ' over' : ''}${col.real ? '' : ' catchall'}${dragged && !isOver && !isSource ? ' dim' : ''}`}
                onDragOver={(e) => { if (wouldMove) { e.preventDefault(); setOver(col.key); } }}
                onDragLeave={(e) => { if (e.currentTarget === e.target) setOver((o) => (o === col.key ? null : o)); }}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  const it = dragged;
                  setDragId(null);
                  if (it && wouldMove) {
                    moveTo(it, col.key);
                    // A FOLDED COLUMN STILL TAKES A DROP, AND OPENS TO SHOW IT —
                    // and so does the card's area group. A card that lands
                    // behind a closed strip has been filed somewhere the owner
                    // cannot see. Unfold, never toggle.
                    unfoldColumn(col.key);
                    unfoldArea(areaKey(it));
                  }
                }}>
                <ColumnHead col={col} first={ci === 0} last={ci === columns.length - 1}
                  open={menu === col.key}
                  folded={colFolded}
                  canFold={!searching}
                  onFold={() => { closeAll(); foldColumn(col.key); }}
                  onMenu={(e) => { e.stopPropagation(); closeAll(); setMenu(menu === col.key ? null : col.key); }}
                  onRename={(name) => { setMenu(null); renameCol(col.key, name); }}
                  onMove={(d) => { setMenu(null); moveCol(col.key, d); }}
                  onDelete={() => { setMenu(null); dropCol(col.key); }}
                  onComplete={col.key === 'shipped' && col.items.length > 0
                    ? () => { closeAll(); completeDone(col.items); } : undefined}
                  busy={completing} />

                {/* The drop preview, opening a space at the top of the column.
                    The top is not a claim about WHERE the card lands —
                    `queueOrder` decides that (decision 4). */}
                {isOver && dragged && !colFolded && (
                  <DropSlot
                    from={columns.find((c) => c.items.some((x) => x.id === dragged.id))?.name || 'No column'}
                    to={col.name}
                    shipped={col.key === 'shipped'} />
                )}

                {/* THE CARDS, THE EMPTY LINE AND THE COMPOSER ALL GO WITH THE
                    FOLD (#511). The head stays, and keeps its count. */}
                {!colFolded && col.groups.map((g) => {
                  if (!grouped) return g.items.map(card);
                  const meta = groupMeta(g.key);
                  const gFolded = !areaOpen(g.key);
                  const st = meta.slice ? sliceStateOf(meta.slice.id, rows) : null;
                  return (
                    <div className={`km-group${gFolded ? ' folded' : ''}${meta.slice ? ' km-slicegroup' : ''}`} key={g.key} data-area={g.key}>
                      <div className="km-grouphead"
                        onDoubleClick={(e) => {
                          if (!meta.slice || (e.target as HTMLElement).closest('button, input')) return;
                          e.stopPropagation();
                          openSlice(meta.slice, e.currentTarget);
                        }}>
                        {meta.slice && <button className="km-colbtn" aria-label={`Zoom into slice ${meta.name}`}
                          title="Zoom into this slice (or double-click its header)"
                          onClick={(e) => { e.stopPropagation(); openSlice(meta.slice!, e.currentTarget); }}>
                          <KitIcon name="layers" size={13} />
                        </button>}
                        {!searching && (
                          <button className="km-foldbtn"
                            aria-expanded={!gFolded}
                            aria-label={`${gFolded ? 'Expand' : 'Collapse'} ${bySlice ? 'slice' : 'area'} — ${meta.name}`}
                            title={gFolded ? `Expand this ${bySlice ? 'slice' : 'area'}, in every column` : `Collapse this ${bySlice ? 'slice' : 'area'}, in every column`}
                            onClick={(e) => { e.stopPropagation(); closeAll(); foldSection(g.key); }}>
                            <KitIcon name={gFolded ? 'chevron-right' : 'chevron-down'} size={13} />
                          </button>
                        )}
                        {meta.dot && <span className="km-dot" style={{ background: meta.dot }} />}
                        {meta.slice && (
                          <span className="kind" title="A slice: one shippable piece, drawn as a cluster of its cards">
                            <KitIcon name="layers" size={13} />
                          </span>
                        )}
                        <span className="nm">{meta.name}</span>
                        {meta.holder && (
                          <span className="k-tag warning"
                            title={`Lane held by ${meta.holder} — no second worker until it lands`}>held</span>
                        )}
                        {bySlice && !meta.slice && (
                          <span className="k-tag warning" title="Worked rows in no slice. Move each into a slice from its card menu.">
                            no slice
                          </span>
                        )}
                        <span className="rule" />
                        {!st && <span className="n">{g.items.length}</span>}
                        {meta.slice && (
                          <button className="km-colbtn" aria-label={`Edit slice ${meta.name}`} title="Edit this slice"
                            onClick={(e) => { e.stopPropagation(); closeAll(); setSliceEdit({ slice: meta.slice }); }}>
                            <KitIcon name="pencil" size={12} />
                          </button>
                        )}
                        {/* The area's ⋯ (rename, colour, delete), on every group
                            head it has. Not on untagged: it is not a row in
                            `project_areas`, so there is nothing to change. */}
                        {!bySlice && !meta.untagged && (
                          <AreaMenu name={g.key} count={areaTotal(g.key)} holder={meta.holder}
                            dot={meta.dot} palette={palette}
                            open={areaMenu === `${col.key}::${g.key}`}
                            onOpen={(e) => { e.stopPropagation(); closeAll(); setAreaMenu(areaMenu === `${col.key}::${g.key}` ? null : `${col.key}::${g.key}`); }}
                            onRename={(to) => { setAreaMenu(null); renameArea(g.key, to); }}
                            onColour={(dot) => { setAreaMenu(null); recolourArea(g.key, dot); }}
                            onDelete={() => { setAreaMenu(null); dropArea(g.key); }} />
                        )}
                      </div>
                      {/* ONE BAR, ONE COUNT: the slice's built share across every
                          column, the same number Course and the Backlog show. */}
                      {st && st.total > 0 && (
                        <div className="km-partbar km-slicebar" role="img"
                          aria-label={`${st.built} of ${st.total} built across every column`}
                          title={`${st.built} of ${st.total} built, ${st.done} ticked, across every column`}>
                          <span className="track"><span className="fill" style={{ width: `${Math.round((st.built / st.total) * 100)}%` }} /></span>
                          <span className="n mono">{st.built}/{st.total} built</span>
                        </div>
                      )}
                      {(() => {
                        const owed = g.items.filter(awaitsVerdict);
                        if (owed.length < 2) return null;
                        return (
                          <div className="km-approveall">
                            <button className="km-vbtn ok"
                              title={`Approve every card in this ${bySlice ? 'slice' : 'group'} that is waiting on your verdict: each gets the verdict and a tick. One Undo reverses them all.`}
                              onClick={(e) => { e.stopPropagation(); closeAll(); approveMany(owed); }}>
                              <KitIcon name="check" size={13} />Approve all {owed.length}
                            </button>
                          </div>
                        );
                      })()}
                      {!gFolded && g.items.map(card)}
                    </div>
                  );
                })}

                {!colFolded && col.items.length === 0 && <span className="km-colempty">Nothing here</span>}

                {!colFolded && col.real && (composer === col.key ? (
                  <Composer onClose={() => setComposer(null)}
                    onAdd={(text, bucket) => { setComposer(null); add(text, bucket, col.key, homeArea); }} />
                ) : (
                  <button className="km-add" onClick={(e) => { e.stopPropagation(); closeAll(); setComposer(col.key); }}
                    title={homeSlice
                      ? `Create in ${homeSlice.title}${homeArea ? `, area ${homeArea}` : ''}`
                      : 'No single slice to create in, so this files to the Icebox. Pick one slice to create on the board.'}>
                    <KitIcon name="plus" size={14} />Create
                  </button>
                ))}
              </div>
            );
          })}

          {lists && <AddColumn onAdd={addCol} />}
        </div>
        </>}
        </>}
      </div>

      {sliceEdit && (
        <SliceDialog slice={sliceEdit.slice} milestones={ms} defaultMilestoneId={shownMs?.id ?? null}
          areaNames={areaOrder.filter((k) => k !== UNTAGGED)}
          count={sliceEdit.slice ? rows.filter((it) => it.sliceId === sliceEdit.slice!.id && !it.archived).length : 0}
          onClose={() => setSliceEdit(null)} onSave={saveSlice}
          onDelete={sliceEdit.slice ? () => dropSlice(sliceEdit.slice!) : undefined} />
      )}
      {msEdit && (
        <MilestoneDialog milestones={ms} editing={shownMs} onClose={() => setMsEdit(false)}
          onSave={saveMilestone} onCreate={startMilestone} onMakeCurrent={makeCurrent}
          onDelete={(id) => guard(async () => {
            await deleteMilestone(slug, id);
            setMsEdit(false); setViewMsId(null);
            setMs((xs) => xs.filter((m) => m.id !== id));
            setSl((xs) => xs.filter((s) => s.milestoneId !== id));
            onRefresh();
          })} />
      )}

      {dialog && (
        <CreateDialog onClose={() => setDialog(false)}
          onCreate={(title, bucket, extra) => { setDialog(false); add(title, bucket, '', homeArea, extra); }} />
      )}

      {focus && (
        <BoardFocus slug={slug} open={focus} rows={rows}
          columns={(lists || []).map((l) => ({ key: l.key, name: l.name }))}
          colOf={colOf}
          areas={areaOrder.filter((k) => k !== UNTAGGED).map((k) => ({ name: k, dot: areaMeta(k).dot }))}
          phase={focusPhase} onPhase={setFocusPhase}
          onClosed={() => { setFocus(null); setFocusPhase('measure'); }}
          onPatch={focusPatch}
          onMove={(it, key) => moveTo(it, key)}
          onCreateChild={createChild}
          slices={sl} onEditSlice={(x) => setSliceEdit({ slice: x })} onCreateInSlice={createInSlice}
          onStar={star} />
      )}
    </>
  );
}

// THE GROUP FILTER (2026-11-09): ONE BUTTON, NOT A ROW OF CHIPS. The chips
// wrapped to three lines once a board had a score of slices, which is every
// board with a real spine. The button says what is showing ("All slices", the
// one picked, or "3 slices"); its menu lists every group with its dot and
// count, under its milestone when the groups are slices, and Clear sits beside
// the button while a filter is on.
//
// It owns its own open state and closes on a press anywhere outside it, so the
// Backlog (which has no board-wide closeAll) can use it too. `multi` keeps the
// menu open across picks; single-pick closes it on the press.
export type GroupOption = { key: string; name: string; dot?: string; n: number; section?: string };
function GroupFilter({ noun, options, picked, multi, onToggle, onClear }: {
  noun: string; options: GroupOption[]; picked: string[]; multi: boolean;
  onToggle: (key: string) => void; onClear: () => void;
}) {
  const anchor = useRef<HTMLSpanElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (anchor.current?.contains(t) || menu.current?.contains(t)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const one = picked.length === 1 ? options.find((o) => o.key === picked[0]) : undefined;
  const label = picked.length === 0 ? `All ${noun}` : one ? one.name : `${picked.length} ${noun}`;
  let section: string | undefined;
  return (
    <span className="km-scope" ref={anchor}>
      <button className={`k-btn sm secondary km-scopebtn${picked.length ? ' on' : ''}`}
        aria-haspopup="menu" aria-expanded={open} title={`Show only some ${noun}`}
        onClick={() => setOpen(!open)}>
        <KitIcon name="list-filter" size={14} />
        {one?.dot && <span className="km-dot" style={{ background: one.dot }} />}
        <span className="km-scopelbl">{label}</span>
        <KitIcon name="chevron-down" size={12} />
      </button>
      {picked.length > 0 && <button className="km-clearpick" onClick={onClear}>Clear</button>}
      {open && (
        <Popover anchor={anchor.current} className="km-menu km-scopemenu" align="left">
          <div ref={menu} className="km-scopelist">
            {/* Clear inside the menu too: on a narrow screen the menu opens
                over the Clear beside the button. */}
            {picked.length > 0 && (
              <div className="km-scopehead">
                <span className="km-menulbl">{picked.length} picked</span>
                <button className="km-clearpick" onClick={() => { onClear(); setOpen(false); }}>Clear</button>
              </div>
            )}
            {options.length === 0 && <span className="km-menulbl">Nothing to filter yet.</span>}
            {options.map((o) => {
              const head = o.section !== undefined && o.section !== section;
              section = o.section;
              const on = picked.includes(o.key);
              return (
                <Fragment key={o.key}>
                  {head && <span className="km-menulbl">{o.section || 'Not in a slice'}</span>}
                  <button role="menuitemcheckbox" aria-checked={on} data-area={o.key}
                    className={`km-menuitem km-scopeopt${on ? ' on' : ''}`}
                    onClick={() => { onToggle(o.key); if (!multi) setOpen(false); }}>
                    <span className="km-scopecheck" aria-hidden="true">{on && <KitIcon name="check" size={11} />}</span>
                    {o.dot && <span className="km-dot" style={{ background: o.dot }} />}
                    <span className="km-scopename">{o.name}</span>
                    <span className="n">{o.n}</span>
                  </button>
                </Fragment>
              );
            })}
          </div>
        </Popover>
      )}
    </span>
  );
}

/**
 * EVERY POPOVER ON THIS BOARD IS RENDERED INTO THE BODY, AND THAT IS NOT A
 * REFACTOR — IT IS THE ONLY WAY IT IS VISIBLE. `.km-cols` scrolls its columns
 * sideways (`overflow-x: auto`), and CSS computes the OTHER axis of a scroll
 * container to `auto` as well: a lane row clips its own contents top and
 * bottom, whatever the stylesheet says about the y axis. So an absolutely
 * positioned menu hanging off a card near the foot of a short column was cut
 * off at the row's edge — the ⋯ opened, and the half of the menu with Delete in
 * it was simply not on the screen. No z-index reaches out of a clip; leaving
 * the DOM does.
 *
 * The three rules the portal has to keep, because the stylesheet can no longer:
 *  • IT IS ANCHORED IN VIEWPORT COORDINATES and re-measured on every scroll
 *    (capture phase — the lane row's own sideways scroll does not bubble) and
 *    every resize, so the menu tracks the card it belongs to instead of
 *    floating away from it.
 *  • IT FLIPS ABOVE THE ANCHOR rather than running off the bottom of the
 *    window, and clamps into the viewport either way. The card menu opening
 *    DOWNWARD is a decision (see `.km-menu.card`) and the flip is the exception
 *    the window forces, not a second opinion about which way it should go.
 *  • A CLICK INSIDE IT STILL STOPS THERE. The board closes its menus with one
 *    `onClick` on the root; a React portal bubbles through the REACT tree, so
 *    that handler still fires for a press outside the menu and this one still
 *    has to swallow the press inside it.
 *
 * EXPORTED FOR THE PLANS TIMELINE'S COLUMN FILTERS (#515), whose grid clips the
 * same way (`.pl-grid` is `overflow: hidden` inside a sideways `.pl-scroll`).
 *
 * `inset` is the gap the stylesheet used to spell as `right: var(--space-5)` —
 * the menu's right edge sits that far inside the anchor's.
 */
export function Popover({ anchor, className, inset = 0, align = 'right', children }: {
  anchor: HTMLElement | null;
  className: string;
  inset?: number;
  /** Which anchor edge the menu lines up with. Right (the default) suits a ⋯
   *  at the end of a row; left suits a control at the start of a toolbar. */
  align?: 'left' | 'right';
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      // `top: calc(100% - 6px)` in viewport terms — the overlap the card menu
      // and the priority list both had against the bottom edge of their card.
      const gap = 6;
      let top = a.bottom - gap;
      if (top + h > window.innerHeight - 8) {
        const above = a.top + gap - h;
        top = above >= 8 ? above : Math.max(8, window.innerHeight - 8 - h);
      }
      const want = align === 'left' ? a.left + inset : a.right - inset - w;
      const left = Math.min(Math.max(8, want), Math.max(8, window.innerWidth - 8 - w));
      setAt({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, inset, align]);

  return createPortal(
    <div ref={ref} className={className} role="menu"
      style={{
        position: 'fixed', top: at ? at.top : 0, left: at ? at.left : 0,
        right: 'auto', bottom: 'auto',
        // Hidden for the one layout pass that measures it. `useLayoutEffect`
        // runs before paint, so nothing is ever drawn at 0,0.
        visibility: at ? undefined : 'hidden',
      }}
      onClick={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

function ColumnHead({ col, first, last, open, folded, canFold, onFold, onMenu, onRename, onMove, onDelete, onComplete, busy }: {
  col: { key: string; name: string; items: RoadmapItem[]; real: boolean;
    /** What the points total adds up: a cluster counts as its parts (#600). */
    sized: RoadmapItem[] };
  first: boolean; last: boolean; open: boolean;
  /** #511 — folded to its own head. The COUNT stays visible either way. */
  folded: boolean;
  /** False while a search is running, which suspends every fold — see the
   *  board's `foldedColumns`. The chevron goes with the suspension rather than
   *  sitting there writing a state nothing on screen reflects. */
  canFold: boolean;
  onFold: () => void;
  onMenu: (e: React.MouseEvent) => void;
  onRename: (name: string) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
  onComplete?: () => void;
  busy: boolean;
}) {
  const [tip, setTip] = useState(false);
  const [completeConfirm, setCompleteConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  // The anchor the menu is measured against. A ref rather than the button
  // itself: the menu opens BELOW the whole head, which is where it opened when
  // it was `top: 30px` inside it.
  const headRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState(col.name);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (!open) setConfirming(false); }, [open]);
  const pts = pointsOf(col.sized);

  if (editing) {
    const commit = () => {
      const name = draft.trim();
      setEditing(false);
      if (name && name !== col.name) onRename(name);
    };
    return (
      <div className="km-colhead">
        <input className="km-colname" autoFocus value={draft} aria-label="Column name"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') { setDraft(col.name); setEditing(false); }
          }} />
      </div>
    );
  }

  return (
    <div className="km-colhead" ref={headRef}>
      {canFold && (
        <button className="km-foldbtn"
          aria-expanded={!folded}
          aria-label={`${folded ? 'Expand' : 'Collapse'} column — ${col.name}`}
          title={folded ? 'Expand this column' : 'Collapse this column, on every area'}
          onClick={(e) => { e.stopPropagation(); onFold(); }}>
          <KitIcon name={folded ? 'chevron-right' : 'chevron-down'} size={14} />
        </button>
      )}
      <span className="nm">{col.name}</span>
      <span className="k-badge">{col.items.length}</span>
      {!folded && onComplete && (
        <button className="k-btn ghost sm" disabled={busy}
          title={`Archive the ${col.items.length} visible Done card${col.items.length === 1 ? '' : 's'} and their parts. History is kept.`}
          onClick={(e) => {
            e.stopPropagation();
            if (completeConfirm) { setCompleteConfirm(false); onComplete(); }
            else setCompleteConfirm(true);
          }}>{completeConfirm ? 'Confirm complete' : 'Complete'}</button>
      )}
      {!folded && onComplete && completeConfirm && (
        <button className="k-btn ghost sm" onClick={() => setCompleteConfirm(false)}>Cancel</button>
      )}
      {/* #507 — the column's own total, which is the number a standup actually
          reads. Same rule as the section head's: it says how many cards it left
          out, and it is absent rather than zero when nothing here is sized.
          Hidden while the column is FOLDED — the strip is 46px wide and the
          count badge is the one number that fits. */}
      {!folded && pts.sum > 0 && (
        <span className="lim km-pts-total"
          title={pts.unsized
            ? `${pts.sum} points in this column, with ${pts.unsized} card${pts.unsized === 1 ? '' : 's'} unsized and not counted`
            : `${pts.sum} points in this column — every card is sized`}>
          {/* Parallel to the section head's `12 pts · 1 unsized` right above it,
              shortened to fit a 272px column — so the `?` is read in the light
              of the full spelling one line up, and the title has it anyway. */}
          {pts.sum} pts{pts.unsized ? ` · ${pts.unsized}?` : ''}
        </span>
      )}

      {/* THE CATCH-ALL IS NOT A COLUMN and has no menu: it is where cards land
          when the column they derive into has been deleted (decision 8). It
          says what it is rather than pretending to be a lane you can rename. */}
      {!col.real && (
        <span className="lim" title="These cards derive into a column this board no longer has. Drag one anywhere, or add the column back.">
          derived
        </span>
      )}

      {col.real && (
        <span className="tools">
          {/* NAMED APART FROM A CARD'S ⋯ on purpose: `scripts/playwright/smoke.mjs`
              presses both, and two controls answering to the same
              `[aria-label^="More actions"]` would have it press one twice and
              report the other as working. */}
          <button className={`km-colbtn${open ? ' on' : ''}`} aria-label={`Column actions — ${col.name}`} onClick={onMenu}
            onMouseEnter={() => setTip(true)} onMouseLeave={() => setTip(false)}>
            <KitIcon name="ellipsis" size={15} />
          </button>
        </span>
      )}

      {tip && !open && <span className="km-tip">More actions</span>}

      {open && (
        <Popover anchor={headRef.current} className="km-menu">
          <button className="km-menuitem" onClick={() => { setDraft(col.name); setEditing(true); }}>Rename column</button>
          <span className="km-menusep" />
          <button className="km-menuitem" disabled={first} onClick={() => onMove(-1)}>Move column left</button>
          <button className="km-menuitem" disabled={last} onClick={() => onMove(1)}>Move column right</button>
          <span className="km-menusep" />
          {/* The cards do NOT go with it — the server clears their `list_key`
              and each lands back in its derived column. The second press is
              there because that is not obvious from the word "delete". */}
          <button className="km-menuitem danger" onClick={() => (confirming ? onDelete() : setConfirming(true))}>
            {confirming ? 'Really delete? Cards return to their derived column' : 'Delete column'}
          </button>
        </Popover>
      )}
    </div>
  );
}

/**
 * THE DROP PREVIEW — the kit's `TransitionSlot`, and the one piece of this
 * screen that exists to SAY WHAT THE DROP WILL WRITE before it writes it.
 * Two chips and an arrow, because the column pair is the whole of the change:
 * a drop patches `list_key` and nothing else.
 *
 * WHICH IS WHY THE Done LANE CARRIES A LINE OF ITS OWN. Dropping a card on Done
 * does not tick it (decision 3 in this file's header) — `done` is what
 * `computeProgress` weighs and what a merge writes — and Done is precisely the
 * column where somebody will expect the drop to mean more than it does. Keyed
 * on `shipped` rather than on the name: THE KEYS OUTLIVE THE NAMES
 * (server/src/lists.js), and this lane renames.
 */
function DropSlot({ from, to, shipped = false, say = 'Drop to move it here', note }: {
  from: string; to: string; shipped?: boolean;
  /** The zone's line — the kanban's "move it here" unless a surface says what
   *  its own drop writes (the Backlog tab's commit / release, #498). */
  say?: string;
  note?: string;
}) {
  return (
    <div className="km-slot" aria-hidden="true">
      <div className="hop">
        <span className="from">{from}</span>
        <span className="arr"><KitIcon name="arrow-up-right" size={13} /></span>
        <span className="to">{to}</span>
      </div>
      <div className="zone">
        {say}
        {shipped && <span className="n">Sets the column only — it does not tick the item</span>}
        {note && <span className="n">{note}</span>}
      </div>
    </div>
  );
}

// A part's state, in the board's own column words. The tones are the focus
// canvas's status tones for the same four columns.
const PART_STATE: Record<string, { glyph: string; cls: string; word: string }> = {
  planned: { glyph: '○', cls: 'todo', word: 'To do' },
  progress: { glyph: '●', cls: 'going', word: 'In progress' },
  review: { glyph: '◐', cls: 'review', word: 'In review' },
  shipped: { glyph: '✓', cls: 'done', word: 'Done' },
};
const PARTS_SHOWN = 4;

/** A cluster's body: how far its parts have got, and the first few of them. */
function ClusterParts({ parts, onPart, onMore }: {
  parts: RoadmapItem[]; onPart: (p: RoadmapItem) => void; onMore: () => void;
}) {
  const keys = parts.map(listKeyOf);
  const done = keys.filter((k) => k === 'shipped').length;
  // Unfinished parts first, so the card shows what is left rather than what is over.
  const order = parts.map((p, i) => ({ p, k: keys[i] }))
    .sort((a, b) => Number(a.k === 'shipped') - Number(b.k === 'shipped'));
  const rest = parts.length - PARTS_SHOWN;
  return (
    <div className="km-parts" onDoubleClick={(e) => e.stopPropagation()}>
      <div className="km-partbar" role="img" aria-label={`${done} of ${parts.length} parts done`}>
        <span className="track"><span className="fill" style={{ width: `${Math.round((done / parts.length) * 100)}%` }} /></span>
        <span className="n mono">{done}/{parts.length}</span>
      </div>
      <ul>
        {order.slice(0, rest > 0 ? PARTS_SHOWN - 1 : PARTS_SHOWN).map(({ p, k }) => {
          const st = PART_STATE[k] || PART_STATE.planned;
          return (
            <li key={p.id}>
              <button className={`km-part ${st.cls}`} title={`#${p.id} — ${st.word}. Click to edit it on the cluster's canvas.`}
                onClick={(e) => { e.stopPropagation(); onPart(p); }}>
                <span className="g" aria-hidden>{st.glyph}</span>
                <span className="pt">{p.title}</span>
                <span className={`pp mono${p.points == null ? ' none' : ''}`}
                  title={p.points == null ? 'Unsized' : `${p.points} ${p.points === 1 ? 'point' : 'points'}`}>
                  {p.points == null ? '–' : p.points}
                </span>
              </button>
            </li>
          );
        })}
        {rest > 0 && (
          <li>
            <button className="km-part more" onClick={(e) => { e.stopPropagation(); onMore(); }}
              title="Open the cluster to see every part">+{rest + 1} more</button>
          </li>
        )}
      </ul>
    </div>
  );
}

function IssueCard({
  item, selected, onSelect, dragging, landed, onDragStart, onDragEnd,
  editing, onOpenInline, onInline, onCancelInline,
  priOpen, onPri, onPick, ptsOpen, onPts, onPoints, menuOpen, onMenu,
  onKind, onDue, onEdit, onSignOff, onPark, onArchive, onStar, onDerive, onDelete,
  onBuildNow, onRun, onReady, tint, showArea,
  parentItem, kids, parts, away, onOpen, slices, milestones, onSlice, verdict, elsewhere,
}: {
  /** The owner's verdict, drawn only on a card with built work and no verdict
   *  yet (`awaitsVerdict`), which derives into In Review unless dragged. Approve ticks as well; Send back
   *  writes the refine note and returns the card to To Do. */
  verdict?: { onApprove: () => void; onSendBack: (text: string) => void };
  /** The milestone this card belongs to when it is not the one being viewed
   *  (built work is shown whatever milestone is), else ''. */
  elsewhere: string;
  /** #608 — the slices a card can move into, and the move (null = Icebox). */
  slices: Slice[]; milestones: Milestone[];
  onSlice: (sliceId: number | null) => void;
  item: RoadmapItem;
  /** The card this one is filed under (`parent_id`), or null. */
  parentItem: RoadmapItem | null;
  /** Its own children, counted — null when it has none. */
  kids: { done: number; total: number } | null;
  /** A CLUSTER's parts, drawn inside this card in run order — null for a plain
   *  card. A cluster does not drag: its column is rolled up from these. */
  parts: RoadmapItem[] | null;
  /** This card is out on the focus canvas: its board slot holds its place, empty. */
  away: boolean;
  /** Fly the card onto the focus canvas; `edit` opens the editor with it, on
   *  `editId` when that names one of a cluster's parts (#601). */
  onOpen: (el: HTMLElement | null, edit: boolean, editId?: number) => void;
  /** Board v5 — the card's AREA COLOUR (`project_areas.dot`), drawn as its top
   *  edge; '' for untagged or an area with no colour, which draws none. */
  tint: string;
  /** Board v5 — whether the card names its area in a tag. Off while the
   *  column is grouped by area: the group head above already says it, and
   *  the colour says it again. On in flat columns, where colour alone would
   *  leave ten similar dots to tell apart. */
  showArea: boolean;
  onBuildNow: () => void;
  /** Join (true) or leave (false) the Ready queue, which is what the automation builds. */
  onReady: (on: boolean) => void;
  /** #525 — claim this card and open a claude tab already working it. Present
   *  only on an unclaimed, unheld card in To Do: anywhere else somebody (or
   *  something) already has it, or the night could not take it either. */
  onRun?: () => void;
  selected: boolean; onSelect: () => void;
  dragging: boolean;
  /** True for the ~900ms after this card's own drop wrote. Drawn as the kit's
   *  `card-land`, in the lime that means done everywhere else in the app. */
  landed: boolean;
  onDragStart: () => void; onDragEnd: () => void;
  editing: boolean; onOpenInline: () => void;
  onInline: (title: string) => void; onCancelInline: () => void;
  priOpen: boolean; onPri: (e: React.MouseEvent) => void; onPick: (v: Priority) => void;
  /** #507 — the story-point picker. `null` is a real choice and not a cancel:
   *  it hands the card back to unsized. */
  ptsOpen: boolean; onPts: (e: React.MouseEvent) => void; onPoints: (v: number | null) => void;
  menuOpen: boolean; onMenu: (e: React.MouseEvent) => void;
  /** #508 — '' is a real choice on both: it clears the kind / the due date. */
  onKind: (v: ItemKind) => void;
  onDue: (v: string | null) => void;
  onEdit: () => void;
  /** Release the #359 hold on a `hook`/`fly` row. Only ever pressed on a held
   *  card, and the menu only draws it there. */
  onSignOff: () => void;
  onPark: () => void;
  /** Star or unstar it (the Starred tab's shortlist; not priority). */
  onStar: () => void;
  onArchive: () => void; onDerive: () => void; onDelete: () => void;
}) {
  const pri = priorityMeta(item.bucket);
  // #507 — `?? null`, not `item.points`, and for the same reason `committed` is
  // read `!== false` (shape.js): a client talking to a server that has not been
  // redeployed yet gets the field ABSENT, and `undefined` would render an empty
  // button and count as neither sized nor unsized. Absent means unsized.
  const pts = item.points ?? null;
  // #508 — both read `?? ''`/`?? null` for the reason `pts` above does: a
  // browser talking to a server that has not been redeployed yet gets these
  // fields ABSENT, and absent must mean unset rather than render as undefined.
  const kind: ItemKind = (item.kind ?? '') as ItemKind;
  const due = dueRead(item.dueOn ?? null, item.done);
  // A row a session made and worked, that nobody has signed off yet. It is on
  // the board because it is real work (`homeOf`), and it says so on its face
  // because the alternative is a card the runner will silently never take.
  const held = isHeld(item);
  // #381 — opened by a live terminal session rather than typed by a human. A
  // row keeps saying so after its hold is answered; see the chip below.
  const fly = item.source === 'fly';
  const [confirming, setConfirming] = useState(false);
  // The Send back draft, open on this card only; null = closed.
  const [backText, setBackText] = useState<string | null>(null);
  const sentBack = !!item.refineNote?.trim() && !item.claimedBy.trim() && !item.done;
  // The anchor both of this card's popovers are measured against — the card
  // itself, which is where the stylesheet anchored them before they left the
  // column's clip (see `Popover`).
  const cardRef = useRef<HTMLDivElement | null>(null);

  // TWO DOUBLE-CLICKS WITH TWO MEANINGS (see decision 7): the TITLE renames in
  // place, the rest of the card opens it on the focus canvas. A press on a control is that
  // control pressed, never the card behind it — the ⋯ and the priority glyph
  // both toggle on a single click, so a second one reaching this handler would
  // open the modal over a menu the same gesture had just closed.
  const openItem = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, textarea, [role="menu"]')) return;
    e.stopPropagation();
    onOpen(cardRef.current, false);
  };
  useEffect(() => { if (!menuOpen) setConfirming(false); }, [menuOpen]);

  const tinted = !!tint && !selected && !dragging && !landed && !editing;
  return (
    // DRAGGABLE IS OFF WHILE THE TITLE IS BEING EDITED. A `draggable` ancestor
    // eats the pointer inside a text input in Chromium — select-by-drag stops
    // working and the card starts flying instead — so the one gesture is
    // switched off for exactly as long as the other one is open.
    <div ref={cardRef} className={`km-card${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}${landed ? ' landed' : ''}${editing ? ' editing' : ''}${tinted ? ' tinted' : ''}${away ? ' away' : ''}${parts ? ' cluster' : ''}`}
      // THE AREA COLOUR IS AN INLINE `border-top-color`, and that is the
      // palette audit's rule, not taste: a data tone is exempt only on the
      // element whose own style names the property it paints. At rest it is
      // mixed 70% into the card (the design's), and the stylesheet takes it to
      // full strength on hover through `--km-tint`. A selected, dragged,
      // landed or edited card drops it, so those states keep their whole ring.
      style={tinted ? {
        borderTopColor: `color-mix(in oklch, ${tint} 70%, var(--surface-card))`,
        ['--km-tint' as string]: tint,
      } : undefined}
      data-hl={item.id} onClick={onSelect} onDoubleClick={openItem}
      draggable={!editing && !parts && backText === null} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      {editing
        ? <InlineTitle initial={item.title} onCommit={onInline} onCancel={onCancelInline} />
        : (
          <span className="t" title="Double-click the title to rename it — double-click anywhere else on the card to open it"
            onDoubleClick={(e) => { e.stopPropagation(); onOpenInline(); }}>
            {item.title}
          </span>
        )}

      {parts && <ClusterParts parts={parts} onPart={(p) => onOpen(cardRef.current, true, p.id)} onMore={() => onOpen(cardRef.current, false)} />}

      <div className="km-cardmeta">
        {/* THIS SLOT HELD THE APPROVAL ICON until #472 took every held row off
            the board. Held rows are back — the worked ones — but the hold is
            said in the TAG ROW below and answered in the card menu, not here:
            an icon in a 13px slot is the weakest place to put the one fact that
            decides whether the night touches this card. */}
        {/* THE GLYPH SAYS WHICH KIND OF CARD THIS IS: a check for a simple
            task, the stacked plates for a cluster with parts. */}
        <span className="kind" style={{ color: parts ? 'var(--accent)' : 'var(--blue-400)' }}
          title={parts ? `Cluster — ${parts.length} part${parts.length === 1 ? '' : 's'}` : 'Task'}>
          <KitIcon name={parts ? 'layers' : 'circle-check'} size={13} />
        </span>
        <span className="id">#{item.id}</span>
        {item.starredAt && <StarMark size={11} />}
        {/* #507 — THE SIZE, AND IT IS ALWAYS DRAWN, unsized included. A control
            that only appears once a card already has points is a control nobody
            finds, and unsized is the state every card starts in — so the button
            is there with a dash in it, which is also the honest reading: this
            card has no size, rather than this card is small. NOT `estimate`
            beside it: that one is WEEKS and belongs to the timeline. */}
        {parts ? (
          // #600 — A CLUSTER IS SIZED BY ITS PARTS, like its column: the pill is
          // their total, read-only, and says how many parts are unsized.
          (() => {
            const t = pointsOf(parts);
            const sized = parts.length - t.unsized;
            return (
              <span className={`km-pts static${sized === 0 ? ' none' : ''}`}
                title={sized === 0 ? 'No part is sized yet: size parts from the cluster, not the cluster itself'
                  : `${t.sum} points across ${sized} sized part${sized === 1 ? '' : 's'}${t.unsized ? `; ${t.unsized} unsized and not counted` : ''}`}>
                {sized === 0 ? '–' : `Σ${t.sum}`}
              </span>
            );
          })()
        ) : (
        <button className={`km-pts${ptsOpen ? ' on' : ''}${pts === null ? ' none' : ''}`}
          aria-label={pts === null ? 'Story points — unsized' : `Story points — ${pts}`}
          title={pts === null
            ? 'No story points — unsized, and left out of every total on this board'
            : `${pts} ${pts === 1 ? 'point' : 'points'}`}
          onClick={onPts}>
          {pts === null ? '–' : pts}
        </button>
        )}
        {item.estimate !== null && <span className="pts" title="Estimate, in weeks">{item.estimate}w</span>}

        <span className="right">
          {/* #525 — ONE CLICK, so it is on the card and not only in the menu.
              Drawn only where it can act (see `onRun`), which also keeps it off
              every card that is already moving. */}
          {onRun && (
            <button className="km-colbtn km-run" aria-label={`Run #${item.id} in a terminal session`}
              title="Run in terminal: claims this card (In Progress) and opens a Claude session already working it. The session writes a built note when it is done, which moves the card to In Review."
              onClick={(e) => { e.stopPropagation(); onRun(); }}>
              <KitIcon name="terminal" size={14} />
            </button>
          )}
          <button className="km-colbtn" aria-label={`Edit #${item.id}`} title="Edit item"
            onClick={(e) => { e.stopPropagation(); onOpen(cardRef.current, true); }}>
            <KitIcon name="pencil" size={13} />
          </button>
          <button className={`km-pri${priOpen ? ' on' : ''}`} aria-label={`Priority — ${pri.label}`}
            style={{ color: pri.color }} onClick={onPri}>
            {pri.glyph}
          </button>
          <button className={`km-colbtn${menuOpen ? ' on' : ''}`} aria-label={`More actions for #${item.id}`} onClick={onMenu}>
            <KitIcon name="ellipsis" size={15} />
          </button>
        </span>
      </div>

      {(held || item.ready || fly || kind || due || parentItem || kids || (showArea && item.area) || item.claimedBy || item.skipped || item.reviewTag || sentBack || elsewhere) && (
        <div className="km-cardtags">
          {/* SENT BACK FROM IN REVIEW, and not yet picked up again: the owner's
              note is the job, so the chip carries it in its title. */}
          {sentBack && (
            <span className="k-tag warning" title={`Sent back: ${item.refineNote}`}>sent back</span>
          )}
          {elsewhere && (
            <span className="k-tag" title={`Filed under the milestone "${elsewhere}". Built work waiting on your verdict shows whichever milestone you are viewing.`}>
              <KitIcon name="bookmark" size={11} /><span className="v">{elsewhere}</span>
            </span>
          )}

          {held && (
            <span className="k-tag warning" title={item.source === 'fly'
              ? 'Opened by a live session and not signed off — the autopilot will not take it until you do (card menu → Sign off)'
              : item.source === 'plan'
              ? 'Written by a planning run and not signed off — it cannot be queued to build until you do (card menu → Sign off)'
              : 'Auto-found on a push and not signed off — the autopilot will not take it until you do (card menu → Sign off)'}>
              held
            </span>
          )}
          {item.ready && !item.done && (
            <span className="k-tag km-sprint on" title={`In the Ready queue at position ${item.readyRank + 1}: the automation builds it${held ? ' once it is signed off' : ''}.`}>
              ready #{item.readyRank + 1}
            </span>
          )}



          {fly && (
            <span className="k-tag mono" title={item.flySession
              ? `Filed by the live session "${item.flySession}" while it worked — not typed onto this board`
              : 'Filed by a live session while it worked — not typed onto this board'}>
              <KitIcon name="terminal" size={11} />
              <span className="v">{item.flySession || 'session'}</span>
            </span>
          )}
          {/* #508 — WHAT IT IS, and only for the two real values: '' is unset
              and is most of the board (every row predating the column, and
              every card the lane composer makes), so an unset card wears
              nothing rather than a third word nobody chose. */}
          {kind && (
            <span className={`k-tag km-kind ${kind}`} title={`This is a ${kind}`}>
              {ITEM_KIND_LABEL[kind]}
            </span>
          )}
          {/* #508 — WHEN IT IS DUE. The tone is `dueRead`'s and not this
              file's: overdue, today, within three days, or neither — and a
              DONE card keeps its date and loses its tone, because red in the
              Done column is red where nothing needs doing. */}
          {due && (
            <span className={`k-tag km-due ${due.tone}`} title={due.title}>
              <KitIcon name="calendar" size={11} /><span className="v">{due.label}</span>
            </span>
          )}
          {/* WHERE IT IS FILED, both ways: a child names its parent, and a
              parent says how many of its children are finished. The focus
              canvas (double-click) draws the whole family. */}
          {parentItem && (
            <span className="k-tag mono" title={`Part of #${parentItem.id} — ${parentItem.title}`}>↳ #{parentItem.id}</span>
          )}
          {kids && !parts && (
            <span className="k-tag mono" title="Parts finished">{kids.done}/{kids.total} done</span>
          )}
          {showArea && item.area && <span className="k-tag">{item.area}</span>}
          {item.claimedBy && (
            // A BRANCH NAME IS THE ONE UNBOUNDED STRING ON A CARD. `<kind>/<id>-<summary>`
            // (#363) routinely runs past a 272px column, and `.k-tag` is
            // `white-space: nowrap`, so the first cut let one bleed straight
            // out of the card and into the next lane. It truncates in its own
            // span because `text-overflow` does nothing on a flex CONTAINER —
            // the chip is an inline-flex with an icon in it — and the `title`
            // is what makes the truncation lossless.
            <span className="k-tag mono" title={item.claimedBy}>
              <KitIcon name="git-branch" size={11} /><span className="v">{item.claimedBy}</span>
            </span>
          )}
          {item.skipped && <span className="k-tag warning" title="Parked — the autopilot skips it">parked</span>}
          {/* #263 — a verdict a machine gave SAYS SO. It is still not reversible
              from here, which is the debt named in this file's header. */}
          {item.reviewTag && (
            <span className="k-tag" title={item.verdictSource === 'auto'
              ? 'Verdict given by the auto path (#263), not by a human'
              : 'Verdict on record'}>
              {item.reviewTag}{item.verdictSource === 'auto' ? ' · auto' : ''}
            </span>
          )}
        </div>
      )}

      {/* THE VERDICT STRIP (In Review only). It stops every press and double
          press from reaching the card, so typing a note never opens the focus
          canvas, and the card is not draggable while the note is open. */}
      {verdict && (
        <div className="km-verdict" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          {item.builtNote.trim() && <p className="bn" title={item.builtNote}>{item.builtNote}</p>}
          {backText === null ? (
            <div className="acts">
              <button className="km-vbtn ok" onClick={verdict.onApprove}
                title="Approve: gives your verdict and ticks the card, so it moves to Done and counts as landed. Use it once the change is on main. Undo is offered straight after.">
                <KitIcon name="check" size={13} />Approve
              </button>
              <button className="km-vbtn" onClick={() => setBackText('')}
                title="Send back: say what should change. The card returns to To Do with your note, and Run in terminal starts a session from it.">
                Send back…
              </button>
            </div>
          ) : (
            <div className="back">
              <textarea autoFocus value={backText} rows={3} aria-label={`What should change on #${item.id}`}
                placeholder="What should change?"
                onChange={(e) => setBackText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setBackText(null);
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && backText.trim()) { verdict.onSendBack(backText.trim()); setBackText(null); }
                }} />
              <div className="acts">
                <button className="km-vbtn primary" disabled={!backText.trim()}
                  onClick={() => { verdict.onSendBack(backText.trim()); setBackText(null); }}>Send back</button>
                <button className="km-vbtn" onClick={() => setBackText(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {ptsOpen && (
        <Popover anchor={cardRef.current} className="km-prilist km-ptslist" inset={12}>
          <span className="cur">
            <span className="g">{pts === null ? '–' : pts}</span>
            {pts === null ? 'Unsized' : `${pts} ${pts === 1 ? 'point' : 'points'}`}
          </span>
          <div className="opts">
            {/* UNSIZED LEADS, and it is an option rather than a Clear at the
                bottom: it is where every card starts, so it is the row a reader
                is looking for to confirm what the dash on the card meant. */}
            <button className={`opt${pts === null ? ' on' : ''}`} onClick={() => onPoints(null)}>
              <span className="g">–</span>Unsized
            </button>
            {POINTS.map((n) => {
              const on = pts === n;
              return (
                <button key={n} className={`opt${on ? ' on' : ''}`} onClick={() => onPoints(n)}>
                  {/* The space is explicit: the flex gap separates these two
                      visually, and nothing separates them in the accessible
                      name the button computes from its own text. */}
                  <span className="g">{n}</span>{' '}{n === 1 ? 'point' : 'points'}
                </button>
              );
            })}
          </div>
        </Popover>
      )}

      {priOpen && (
        <Popover anchor={cardRef.current} className="km-prilist" inset={12}>
          <span className="cur">
            <span className="g" style={{ color: pri.color }}>{pri.glyph}</span>
            {pri.label}
          </span>
          <div className="opts">
            {PRIORITY_META.map((p) => {
              const on = p.key === item.bucket;
              return (
                <button key={p.key} className={`opt${on ? ' on' : ''}`} onClick={() => onPick(p.key)}>
                  <span className="g" style={on ? undefined : { color: p.color }}>{p.glyph}</span>
                  {p.label}
                </button>
              );
            })}
          </div>
        </Popover>
      )}

      {menuOpen && (
        <Popover anchor={cardRef.current} className="km-menu card" inset={12}>
          <button className="km-menuitem" onClick={onEdit}>Edit item…</button>
          <button className="km-menuitem" onClick={onStar}
            title={item.starredAt ? 'Takes it off this project’s Starred list' : 'Keeps it on this project’s Starred list, one click away. A star is not priority.'}>
            {item.starredAt ? '★ Unstar' : '☆ Star'}
          </button>
          {/* SIGN OFF IS HERE AGAIN, and only on a card that is actually held.
              #472 took it off this screen because no held row was drawn here
              any more; a held row a session has claimed, built or sliced IS
              drawn here now (`homeOf` in lib/plan.ts), and Auto-ideas' Promote
              (#496) cannot reach it, because it reads only unsliced, unworked rows. The wording says
              what it releases, because "approve" on a change that is already
              built reads as a verdict, which this is emphatically not. */}
          {held && (
            <button className="km-menuitem" onClick={onSignOff}
              title="Clears the #359 hold: the row counts as agreed work, and the autopilot may build it once it is in the Ready queue">
              Sign off — clear the hold
            </button>
          )}
          <span className="km-menusep" />

          <button className="km-menuitem" onClick={onBuildNow}
            title="Queues a build for this item now. The dispatcher picks it up on its next poll; runs are serialised per project, so it waits for anything already running.">
            ▶ Build now
          </button>
          {onRun && (
            <button className="km-menuitem" onClick={onRun}
              title="Claims this card for a new Claude session and opens it, already working the item. The session writes a built note when it is done, which moves the card to In Review.">
              ⌨ Run in terminal
            </button>
          )}
          {/* #608 — Ready ⇒ sliced. An unsliced card says why it cannot be
              queued instead of offering a press the server refuses. */}
          {!item.done && item.sliceId === null && (
            <span className="km-menunote">In no slice, so it cannot be queued to build. Pick a slice below.</span>
          )}
          {!item.done && item.sliceId !== null && (
            <button className="km-menuitem" onClick={() => onReady(!item.ready)}
              title={item.ready
                ? 'Takes this item out of the Ready queue. The automation stops considering it for a build.'
                : 'Queues this item to build. The automation builds the Ready queue top first, whenever it has budget.'}>
              {item.ready ? '⇤ Take out of Ready' : '⇥ Queue to build'}
            </button>
          )}
          <button className="km-menuitem" onClick={onPark}>{item.skipped ? 'Unpark' : 'Park'}</button>
          <span className="km-menusep" />
          <span className="km-menulbl">Slice</span>
          <span className="km-duerow">
            <SlicePicker value={item.sliceId} slices={slices} milestones={milestones}
              label={`Slice for #${item.id}`} iceboxLabel="Icebox (off the board)" onPick={onSlice} />
          </span>
          {/* #508 — BOTH ARE CHANGEABLE AFTER CREATION, and that is not a
              nicety. The dialog is where they are set and the dialog is not
              where most cards come from — the lane composer makes one in two
              keystrokes and the extractor makes one off a push, and neither can
              say either of these things. A field you can only ever set at birth
              is one nobody uses, because by the time you know the answer the
              moment has gone. */}
          <span className="km-menulbl">Kind</span>
          <span className="km-kindrow">
            {(['task', 'story', ''] as ItemKind[]).map((k) => (
              <button key={k || 'unset'} className={`km-kindopt${kind === k ? ' on' : ''}`}
                onClick={() => onKind(k)}>
                {k ? ITEM_KIND_LABEL[k] : 'Unset'}
              </button>
            ))}
          </span>
          <span className="km-menulbl">Due</span>
          {/* A native date input inside the menu. `onChange` fires on a full,
              valid date and gives back the `YYYY-MM-DD` the column takes, so
              nothing is parsed on the way out — and clearing the field sends
              '', which the server reads as "no due date". */}
          <span className="km-duerow">
            <input type="date" className="km-dueinput" value={item.dueOn ?? ''}
              aria-label={`Due date for #${item.id}`}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onDue(e.target.value || null)} />
            {item.dueOn && (
              <button className="km-colbtn" aria-label={`Clear the due date on #${item.id}`}
                title="Clear the due date" onClick={() => onDue(null)}>×</button>
            )}
          </span>
          <span className="km-menusep" />
          {item.listKey && (
            <button className="km-menuitem" onClick={onDerive}
              title="Drop the stored column and let this row's own state decide again">
              Return to derived column
            </button>
          )}
          <span className="km-menusep" />
          <button className="km-menuitem" onClick={onArchive}>Archive</button>
          {/* Deleting a `hook` row TOMBSTONES its fingerprint so the next push
              cannot re-create it. That is what Dismiss means and why it has no
              undo — hence the second press. */}
          <button className="km-menuitem danger" onClick={() => (confirming ? onDelete() : setConfirming(true))}>
            {confirming
              ? (item.source === 'hook' ? 'Really delete? The next push will not re-add it' : 'Really delete?')
              : 'Delete'}
          </button>
        </Popover>
      )}
    </div>
  );
}

// THE INLINE TITLE EDITOR. Double-click a card, retype, Enter.
//
// Three behaviours worth stating, because each is a choice:
//  • BLUR COMMITS, it does not discard. Clicking away from a rename you have
//    typed and losing it is the worst of the three outcomes, and Escape is
//    right there for the person who meant to abandon it.
//  • ESCAPE CANCELS, and it stops the event: the board's own key handling and
//    any modal above it should not also react to the same press.
//  • An empty or unchanged title is a no-op rather than a write. `retitle`
//    guards it too — this is only the half that avoids the round trip.
function InlineTitle({ initial, onCommit, onCancel }: {
  initial: string; onCommit: (v: string) => void; onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  return (
    <textarea ref={ref} className="km-inline" rows={1} value={text} aria-label="Card title"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        setText(e.target.value);
        e.target.style.height = 'auto';
        e.target.style.height = `${e.target.scrollHeight}px`;
      }}
      onBlur={() => onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onCommit(text); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
      }} />
  );
}

function Composer({ onClose, onAdd }: { onClose: () => void; onAdd: (text: string, bucket: Priority) => void }) {
  const [text, setText] = useState('');
  const [bucket, setBucket] = useState<Priority>(PRIORITY_DEFAULT);
  const [pick, setPick] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const submit = () => { const t = text.trim(); if (t) onAdd(t, bucket); else onClose(); };
  const meta = priorityMeta(bucket);
  return (
    <div className="km-composer" onClick={(e) => e.stopPropagation()}>
      <textarea ref={ref} rows={2} value={text} placeholder="What needs to be done?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
        }} />
      <div className="km-composer-foot">
        <button className="ic" aria-label={`Priority — ${meta.label}`} style={{ color: meta.color }}
          onClick={() => setPick(!pick)}>
          {meta.glyph}<span className="chev">▾</span>
        </button>
        {pick && (
          <span className="km-composer-pick">
            {PRIORITY_META.map((p) => (
              <button key={p.key} className={p.key === bucket ? 'on' : ''} style={{ color: p.color }}
                onClick={() => { setBucket(p.key); setPick(false); }}>{p.label}</button>
            ))}
          </span>
        )}
        <button className={`go${text.trim() ? ' armed' : ''}`} aria-label="Add item" onClick={submit}>
          {'⏎'}
        </button>
      </div>
    </div>
  );
}

/**
 * ＋ NEW AREA — #473's first half, in the board's toolbar.
 *
 * Shaped exactly like `AddColumn` below it, and deliberately so: they are the
 * same gesture on the same screen (name a thing, press Enter), and two
 * different affordances for one gesture is how a board stops being learnable.
 *
 * THE NAME IS NORMALISED BY THE SERVER, not here — lowercased and trimmed to 40
 * (routes/board.js's `clean`) — so an area typed in Title Case comes back
 * lowercase and the chip shows what actually stored rather than what was typed.
 */
function AddArea({ onAdd }: { onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const commit = () => { const n = name.trim(); setOpen(false); setName(''); if (n) onAdd(n); };
  if (!open) {
    return (
      <button className="im-chip km-addarea" onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title="Register an area — it gets a colour, an order and a section of its own">
        <KitIcon name="plus" size={13} />New area
      </button>
    );
  }
  return (
    <span className="km-addarea open" onClick={(e) => e.stopPropagation()}>
      <input className="km-colname" autoFocus value={name} placeholder="Area name" aria-label="New area name"
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') { setOpen(false); setName(''); }
        }} />
    </span>
  );
}

/**
 * THE AREA MENU — #473's other half, on each section head.
 *
 * Rename, recolour, delete. The ask was create and delete; RENAME is here
 * because delete without it is a trap — an area typed wrongly could otherwise
 * only be fixed by deleting it, which strips the tag off every card that
 * carries it. A COLOUR because registering an area is what a colour is FOR: the
 * dot is drawn on every chip and every section head, and an area with no stored
 * one wears whatever its index happens to land on.
 *
 * WHAT THE DELETE SAYS IS THE POINT OF IT. Two presses, and the second one
 * spells out both consequences, because neither is guessable from the word:
 *
 *   • THE CARDS STAY. `roadmap_items.area` is cleared, not the rows — the route
 *     is explicit that deleting an area must never delete work — and they land
 *     in the untagged scope, which is the "unallocated" the ask asked for.
 *   • THE LANE GOES. `(project, area)` IS the overnight lane (#267) and untagged
 *     is never a lane at all, so deleting an area with a claim on it releases
 *     that hold. That is a change to what tonight may run, made from a menu
 *     about a colour and a name, and it has to be said before it happens.
 */
export function AreaMenu({ name, count, holder, dot, palette, open, onOpen, onRename, onColour, onDelete }: {
  name: string; count: number; holder: string | null; dot: string; palette: string[];
  open: boolean;
  onOpen: (e: React.MouseEvent) => void;
  onRename: (to: string) => void;
  onColour: (dot: string) => void;
  onDelete: () => void;
}) {
  const anchor = useRef<HTMLSpanElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [confirming, setConfirming] = useState(false);
  // Both sub-states die with the menu, or reopening it lands you mid-rename or
  // one press from a delete you had walked away from.
  useEffect(() => { if (!open) { setConfirming(false); setEditing(false); } }, [open]);

  if (editing) {
    const commit = () => {
      const to = draft.trim();
      setEditing(false);
      if (to && to.toLowerCase() !== name) onRename(to);
    };
    return (
      <span className="km-arearename" onClick={(e) => e.stopPropagation()}>
        <input className="km-colname" autoFocus value={draft} aria-label={`Rename area — ${name}`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') { setDraft(name); setEditing(false); }
          }} />
      </span>
    );
  }

  return (
    <span className="km-areatools" ref={anchor}>
      {/* Named apart from a card's ⋯ and a column's, for the reason the column
          head already carries: the smoke presses all three, and three controls
          answering to one `[aria-label^="…"]` has it press one of them thrice. */}
      <button className={`km-colbtn${open ? ' on' : ''}`} aria-label={`Area actions — ${name}`} onClick={onOpen}>
        <KitIcon name="ellipsis" size={15} />
      </button>

      {open && (
        <Popover anchor={anchor.current} className="km-menu">
          <button className="km-menuitem" onClick={() => { setDraft(name); setEditing(true); }}>
            Rename area…
          </button>
          <span className="km-menusep" />
          <span className="km-menulbl">Colour</span>
          <span className="km-dots">
            {palette.map((c) => (
              <button key={c} className={`km-dotopt${c === dot ? ' on' : ''}`} style={{ background: c }}
                aria-label={`Colour ${name} ${c}`} onClick={() => onColour(c)} />
            ))}
          </span>
          <span className="km-menusep" />
          <button className="km-menuitem danger" onClick={() => (confirming ? onDelete() : setConfirming(true))}>
            {confirming
              ? `Really delete? ${count} ${count === 1 ? 'card becomes' : 'cards become'} untagged${holder ? `, and the lane ${holder} holds is released` : ''}`
              : 'Delete area'}
          </button>
        </Popover>
      )}
    </span>
  );
}

function AddColumn({ onAdd }: { onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const commit = () => { const n = name.trim(); setOpen(false); setName(''); if (n) onAdd(n); };
  if (!open) {
    return (
      <button className="km-addcol" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        <KitIcon name="plus" size={14} />Add column
      </button>
    );
  }
  return (
    <div className="km-addcol open" onClick={(e) => e.stopPropagation()}>
      <input className="km-colname" autoFocus value={name} placeholder="Column name" aria-label="New column name"
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') { setOpen(false); setName(''); }
        }} />
    </div>
  );
}

// The item modal is the other way in, and it is the one that can set a tier, a
// risk, an area and a plan. This dialog is the FAST way — a title and how
// necessary it is — so it deliberately asks for nothing else.
function CreateDialog({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (title: string, bucket: Priority,
             extra: { points: number | null; kind: ItemKind; dueOn: string | null }) => void;
}) {
  const [title, setTitle] = useState('');
  const [bucket, setBucket] = useState<Priority>(PRIORITY_DEFAULT);
  // #507 — UNSIZED IS THE DEFAULT and the first option. This dialog is one
  // press from empty, and a size preselected here would be a number nobody
  // chose sitting in every total on the board.
  const [points, setPoints] = useState<number | null>(null);
  // #508 — TASK IS THE DEFAULT, and it is the one field here that does NOT
  // default to unset. The ask was to be able to file a thing as "either a story
  // or task", which is a binary somebody is choosing between rather than a
  // property they might leave blank — and most things on a board are tasks. It
  // costs nothing to be wrong: the chip is one press to change on the card.
  // Nothing is backfilled, so every row that predates this stays unset.
  const [kind, setKind] = useState<ItemKind>('task');
  // '' = no due date, which is the default and stays the majority. A native
  // date input, so the value is already the `YYYY-MM-DD` the column takes and
  // no parsing happens on the way out.
  const [dueOn, setDueOn] = useState('');
  const submit = () => {
    const t = title.trim();
    if (t) onCreate(t, bucket, { points, kind, dueOn: dueOn || null });
  };
  return (
    <div className="km-scrim" onClick={onClose}>
      <div className="km-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="km-dialog-head">
          <span className="t">Create issue</span>

          <span className="d">
            It lands in To Do, in this bucket, at the end of the queue. A due date is yours to
            watch — it does not change what the autopilot builds.
          </span>
        </div>
        <label className="km-field">
          <span className="lbl">Summary</span>
          <span className="searchbox km-input">
            <input autoFocus placeholder="Short, imperative" value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          </span>
        </label>
        <label className="km-field">
          <span className="lbl">Priority</span>
          <select className="km-select" value={bucket} onChange={(e) => setBucket(e.target.value as Priority)}>
            {PRIORITY_META.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
        <label className="km-field">
          <span className="lbl">Points</span>
          <select className="km-select" value={points === null ? '' : String(points)}
            onChange={(e) => setPoints(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">Unsized</option>
            {POINTS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="km-field">
          <span className="lbl">Kind</span>
          <select className="km-select" value={kind} onChange={(e) => setKind(e.target.value as ItemKind)}>
            <option value="task">Task</option>
            <option value="story">Story</option>
            <option value="">Unset</option>
          </select>
        </label>
        <label className="km-field">
          <span className="lbl">Due</span>
          <input className="km-select" type="date" value={dueOn} aria-label="Due date"
            onChange={(e) => setDueOn(e.target.value)} />
        </label>
        <div className="km-dialog-foot">
          <button className="k-btn ghost" onClick={onClose}>Cancel</button>
          <button className="k-btn" onClick={submit} disabled={!title.trim()}>Create</button>
        </div>
      </div>
    </div>
  );
}

// Backlog keeps unfinished work under its milestone and slice. Icebox and
// proposals stay visible as distinct groups; opening an item uses its usual editor.
function BacklogView({ rows, slices, milestones, lists, onCreate, onEdit }: {
  rows: RoadmapItem[]; slices: Slice[]; milestones: Milestone[]; lists: BoardList[];
  onCreate: () => void; onEdit: (it: RoadmapItem) => void;
}) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('');
  const open = rows.filter((it) => !it.archived && listKeyOf(it) !== 'shipped');
  const matches = (it: RoadmapItem) => !query.trim() ||
    `${it.id} ${it.title} ${it.area}`.toLowerCase().includes(query.trim().toLowerCase());
  const ordered = [...milestones].sort((a, b) =>
    Number(b.status === 'active') - Number(a.status === 'active') || a.position - b.position || a.id - b.id);
  const groups: { key: string; title: string; items: RoadmapItem[]; slice?: Slice; milestone?: Milestone }[] = [];
  for (const m of ordered) {
    if (scope && scope !== String(m.id)) continue;
    for (const slice of slices.filter((s) => s.milestoneId === m.id)
      .sort((a, b) => a.position - b.position || a.id - b.id)) {
      groups.push({ key: `slice-${slice.id}`, title: slice.title, slice, milestone: m,
        items: open.filter((it) => it.sliceId === slice.id && homeOf(it) === 'board' && matches(it))
          .sort((a, b) => a.sliceRank - b.sliceRank || bucketRank(a.bucket) - bucketRank(b.bucket)) });
    }
  }
  if (!scope) {
    groups.push({ key: 'unsliced', title: 'No slice · work in progress', items: open.filter((it) =>
      homeOf(it) === 'board' && !slices.some((s) => s.id === it.sliceId) && matches(it)) });
    groups.push({ key: 'icebox', title: 'Icebox · awaiting a slice', items: open.filter((it) => homeOf(it) === 'icebox' && matches(it)) });
    groups.push({ key: 'ideas', title: 'Auto-ideas · awaiting sign-off', items: open.filter((it) => homeOf(it) === 'auto' && matches(it)) });
  }
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  return <div className="km-backlog">
    <div className="km-toolbar">
      <input className="k-input" aria-label="Search backlog" placeholder="Search backlog…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <select className="k-select" aria-label="Backlog milestone" value={scope} onChange={(e) => setScope(e.target.value)}>
        <option value="">Every milestone & Icebox</option>
        {ordered.map((m) => <option key={m.id} value={m.id}>{m.name}{m.status === 'active' ? ' · Current' : ''}</option>)}
      </select>
      <span className="k-tag">{count} unfinished</span>
      <button className="k-btn sm" onClick={onCreate}>＋ New item</button>
    </div>
    <p className="km-menunote">Planning follows the current milestone’s slices. Builds take only the Ready queue. Open an item to change its slice.</p>
    {groups.filter((g) => !query.trim() || g.items.length > 0).map((g) => <section className="km-blbox" key={g.key}>
      <div className="km-blhead">
        <span className="lbl">{g.milestone ? `${g.milestone.name} / ` : ''}{g.title}</span>
        {g.milestone?.status === 'active' && <span className="k-tag info">Current milestone</span>}
        {g.slice?.archived && <span className="k-tag">Archived slice</span>}
        <span className="k-tag">{g.items.length}</span>
      </div>
      {g.items.map((it) => <button type="button" className="km-blrow" key={it.id} data-hl={it.id} onClick={() => onEdit(it)}>
        <span className="id">#{it.id}</span><span className="t">{it.title}</span>
        <span className="k-tag">{homeOf(it) === 'board' ? lists.find((l) => l.key === listKeyOf(it))?.name || 'No column' : homeOf(it) === 'auto' ? 'Auto-idea' : 'Icebox'}</span>
        {isHeld(it) && <span className="k-tag warning">held</span>}
        {it.ready && <span className="k-tag info">Ready #{it.readyRank + 1}</span>}
        {it.skipped && <span className="k-tag warning">parked</span>}
        <span className="k-tag">{it.area || 'no area'}</span>
        <span className="pri" title={priorityMeta(it.bucket).label}>{priorityMeta(it.bucket).glyph}</span>
      </button>)}
      {g.items.length === 0 && <div className="km-colempty">No unfinished items.</div>}
    </section>)}
    {groups.length === 0 && <div className="km-colempty">No slices yet. Create a slice on the board, or keep ideas in the Icebox.</div>}
  </div>;
}
