// THE BOARD TAB — its tabs (Board, Propositions, Backlog, Development) and
// the writes behind them. Rows arrive as a prop (the one payload every tab
// renders from), so a write patches that payload rather than re-reading the
// project. Only the board's shape is fetched here (`GET /board`).
//
// THE BOARD IS THE WORK MAP (detail/BoardMap.tsx): Map and Lanes. The kanban
// was removed (owner's call, 2026-11-20); List (detail/BoardList.tsx) is the
// finder beside them. The map decides nothing and writes nothing of its own:
// every action it offers is one of this file's (approve, send back, sign off,
// Ready, park, archive, delete, run in terminal), so a write keeps its receipt
// and its Undo. A double-click on the map opens detail/BoardFocus.tsx, which
// is where a row is edited, a slice zoomed and a part created.
//
// The board is designed for the owner working it by hand (owner's call,
// 2026-11-02). Automation concerns are not this screen's to weigh: they live in
// the root CLAUDE.md and the server.
//
// DECISIONS THE CODE DEPENDS ON:
//  1. A CLUSTER is a row with parts (`parent_id`, one level deep). Its stage is
//     ROLLED UP from its parts (`clusterKeyOf` in lib/plan.ts), so it never
//     moves on its own; BoardFocus shows its column read-only.
//  2. MOVING A ROW WRITES `list_key` ONLY, and '' when the target is the column
//     it would derive into. Moving to Done does not tick; `done` is what
//     progress counts.
//  3. A CATCH-ALL COLUMN IS NOT OPTIONAL. `listKeyOf` still derives into four
//     keys, and a deleted column must not lose its rows (server/src/lists.js).
//  4. `hl` NAMES A ROW. Links from Overview, the Timeline and the Terminal
//     select it on the map.
//  5. THE BOARD SHOWS SLICED WORK (#608). A kept row in no slice is in the
//     ICEBOX (the Propositions tab); `homeOf` decides. Worked rows are the
//     exception and stay, because in-flight work must never vanish. A new row is
//     born in the current milestone's only slice; with none or several it goes
//     to the Icebox, and the note line says so.
//  6. PROPOSITIONS IS ITS OWN TAB (owner's call, 2026-11-14): agent plans
//     (detail/Propositions.tsx), then held ideas and the Icebox (ForYou's pane).
//     Its route key is `auto`, so old Ideas & Icebox links land here.
//
// DELETE (from the map's menu) tombstones a `hook` row's fingerprint, so it has
// no undo; the map asks twice. Edit item… opens the full modal, the only
// writer of a human `risk`.
//
// THE VERDICT (2026-11-11): Approve is a verdict and a tick, with Undo; Send
// back writes the refine note and releases the claim. `approve` has the
// reasoning.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { KitIcon } from './kit/KitIcon';
import type { BoardArea, BoardList, ItemKind, Milestone, Priority, RoadmapItem, Slice } from '../types';
import { listKeyOf, clusterKeyOf, queueOrder, isBoardWork, isIced, isAutoIdea, isBuilt, homeOf, bucketRank } from '../lib/plan';
import { SpineStrip, SliceDialog, MilestoneDialog, liveSlices, currentMilestone } from './Spine';
import { isHeld } from '../lib/approval';
import { PRIORITY_META, PRIORITY_DEFAULT, priorityMeta } from '../lib/ui';
import {
  getBoardShape, getPropositions,
  getBoardView, setBoardView,
  createRoadmapItem, patchRoadmapItem, deleteRoadmapItem,
  putReadyQueue,
  createSlice, patchSlice, deleteSlice, createMilestone, patchMilestone, deleteMilestone,
  queueTermLaunch, setStarred,
} from '../store';
import { DevelopmentView } from './Development';
import { go, hrefTo } from '../lib/route';
import { newTermName, termClaim, launchBrief } from '../lib/termLaunch';
import type { BoardView, BoardSort, BoardShow } from '../store';
import { BoardListView, SORT_LABEL, SHOW_LABEL } from './BoardList';
import { BoardFocus, type FocusOpen, type FocusPhase } from './BoardFocus';
import { BoardMap } from './BoardMap';
import { PropositionsSection } from './Propositions';
import { ForYou } from './ForYou';

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

export function Board({ slug, projectName, items, milestones, slices, onRefresh, onEdit, onAreas, highlightId, propositions = false, onRoute }: {
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
  /** The route asked for the Propositions tab (route key `auto`). */
  propositions?: boolean;
  /** Keep the route in step with the Propositions tab, so a reload or a link
   *  lands where the owner is. The other three tabs share `roadmap`. */
  onRoute?: (tab: 'roadmap' | 'auto') => void;
}) {
  const [view, setViewState] = useState(propositions ? 'propositions' : 'board');
  useEffect(() => {
    setViewState((v) => (propositions ? 'propositions' : v === 'propositions' ? 'board' : v));
  }, [propositions]);
  const setView = (v: string) => { setViewState(v); onRoute?.(v === 'propositions' ? 'auto' : 'roadmap'); };
  // The tab's count: live agent plans plus held ideas plus the Icebox. Plans
  // are not in the payload, so the count reads them once and the section
  // reports every change after that.
  const [propLive, setPropLive] = useState(0);
  useEffect(() => {
    getPropositions(slug).then((r) => setPropLive(r.filter((p) => p.status === 'proposed').length)).catch(() => {});
  }, [slug]);

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



  const loadShape = useCallback(async () => {
    const shape = await getBoardShape(slug);
    setLists([...shape.lists].sort((a, b) => a.position - b.position || a.id - b.id));
    setAreas(shape.areas);
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
  // Parked cards SHOW by default. Hiding them by default is how a parked item
  // becomes invisible work, which is the state #247 existed to end.
  const [hideParked, setHideParked] = useState(false);

  // MAP, LANES OR LIST (store.ts BoardView). Map and Lanes are
  // detail/BoardMap.tsx; List (detail/BoardList.tsx) is the finder: every row,
  // area as a tag, sortable, ideas included. Device-local per project.
  const [bview, setBview] = useState<BoardView>(() => getBoardView(slug));
  useEffect(() => { setBview(getBoardView(slug)); }, [slug]);
  const writeView = (patch: Partial<BoardView>) => {
    const next = { ...bview, ...patch }; setBview(next); setBoardView(slug, next);
  };
  const [listArea, setListArea] = useState('');
  const mapMode = bview.layout === 'map' || bview.layout === 'lanes';

  // CLUSTERS (owner's call, 2026-11-02). A row with parts on the board is a
  // cluster whose stage is rolled up from them (`clusterKeyOf`), the map's
  // task-and-tickets rule (lib/workMap.ts). A part whose parent is off the
  // board is an ordinary row again, so no row ever vanishes.
  const partsOf = useMemo(() => {
    const onBoardIds = new Set(rows.filter((it) => !it.archived && isBoardWork(it)).map((it) => it.id));
    const m = new Map<number, RoadmapItem[]>();
    for (const it of rows) {
      if (it.archived || it.parentId === null || !onBoardIds.has(it.parentId)) continue;
      const bag = m.get(it.parentId);
      if (bag) bag.push(it); else m.set(it.parentId, [it]);
    }
    for (const bag of m.values()) bag.sort(queueOrder(planningSlices));
    return m;
  }, [rows, planningSlices]);
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
    setViewMsId(next.m.id);
  };
  const stepMilestone = (dir: -1 | 1) => {
    if (!shownMs) return;
    const i = msOrdered.findIndex((m) => m.id === shownMs.id);
    const next = msOrdered[i + dir];
    if (!next) return;
    setViewMsId(next.id);
  };


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
  // WHERE A NEW CARD IS BORN (#608): the current milestone's only live slice, else nowhere, which is the Icebox. Guessing
  // between two slices would file work under a piece nobody chose.
  const cur = currentMilestone(ms);
  const homeSlice: Slice | null = (() => {
    const inCur = liveSlices(sl, ms).filter((s) => s.milestoneId === (shownMs ?? cur)?.id);
    return inCur.length === 1 ? inCur[0] : null;
  })();
  const icedCount = rows.filter((it) => !it.archived && isIced(it)).length;
  const ideaCount = rows.filter((it) => !it.archived && isAutoIdea(it)).length;

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


  const areaMeta = (k: string) => ({
    key: k,
    name: k === UNTAGGED ? 'No area' : k,
    dot: areas.find((a) => a.name === k)?.dot || '',
    untagged: k === UNTAGGED,
  });




  const onBoard = rows.filter((it) => !it.archived && isBoardWork(it));


  const parked = onBoard.filter((it) => it.skipped).length;
  // The tab's count: the viewed milestone's board work, the cards the map draws in it.
  const shown = onBoard.filter((it) => !isPart(it) && inView(it)).length;




  // A drop writes `list_key` — and '' when the target IS the derived column, so
  // a card only carries an override for as long as it is somewhere its own
  // state would not have put it. Decision 3.
  const moveTo = (it: RoadmapItem, key: string) => {
    // A cluster's column is its parts' (`clusterKeyOf`): it has nothing to drop.
    if (key === CATCH_ALL || listKeyOf(it) === key || partsOf.has(it.id)) return;
    return guard(async () => {
      wrote(await patchRoadmapItem(slug, it.id, { listKey: derivedKeyOf(it) === key ? '' : key }));
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
      go.projectTerminal(slug, slug, tmux);
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
  const remove = (it: RoadmapItem) =>
    guard(async () => {
      await deleteRoadmapItem(slug, it.id);
      setRows((r) => r.filter((x) => x.id !== it.id));
      onRefresh();
    });
  // THE OWNER'S STAR (routes/starred.js): its own write, never the card PATCH,
  // and not priority, so nothing on this board sorts or gates by it.
  const star = (it: RoadmapItem) =>
    guard(async () => {
      const r = await setStarred(slug, 'cards', it.id, !it.starredAt);
      setRows((rs) => rs.map((x) => (x.id === it.id ? { ...x, starredAt: r.starredAt } : x)));
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
      }
      onRefresh();
    });
  const dropSlice = (slice: Slice) =>
    guard(async () => {
      setSliceEdit(null);
      const { iced } = await deleteSlice(slug, slice.id);
      setSl((xs) => xs.filter((x) => x.id !== slice.id));
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



  // ---- transient UI ---------------------------------------------------------
  const [selected, setSelected] = useState<number | null>(null);
  const [dialog, setDialog] = useState(false);

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
    const r = el.getBoundingClientRect();
    const main = el.closest('.con-main') || el.closest('.km');
    setSelected(it.id);
    setFocusPhase('measure');
    setFocus({ id: it.id, from: { l: r.left, t: r.top, w: r.width }, edit, editId,
      canvasLeft: Math.round(main?.getBoundingClientRect().left ?? 0) });
  };
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

  return (
    <>
      <div className={`km${focus ? (focusPhase === 'back' ? ' fx-in' : ' fx-out') : ''}`}
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
            { value: 'propositions', label: 'Propositions', count: propLive + ideaCount + icedCount },
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
        {view === 'propositions' && (
          <div className="pp-view">
            <PropositionsSection slug={slug} milestones={ms} onAccepted={onRefresh} onCount={setPropLive} />
            <ForYou pane="auto" slug={slug} items={rows} slices={sl} milestones={ms} activity={[]}
              onRefresh={onRefresh} onEdit={onEdit} highlightId={highlightId} />
          </div>
        )}

        {view === 'board' && mapMode && (
          <BoardMap slug={slug} projectName={projectName} rows={rows} milestones={ms} slices={sl}
            mode={bview.layout === 'lanes' ? 'lanes' : 'map'}
            highlightId={highlightId} onLayout={(layout) => writeView({ layout })}
            actions={{
              approve, sendBack, signOff, runInTerminal, setReady, park, archive, remove, edit: onEdit,
              openItem: (it, el) => openFocus(it, el, false),
              openSlice: (slice, el) => openSlice(slice, el),
              showOffMap: () => { setView('propositions'); },
            }} />
        )}

        {view === 'board' && !mapMode && <>
        <SpineStrip milestones={ms} slices={sl} iced={icedCount}
          viewing={shownMs} position={shownMs ? msOrdered.findIndex((m) => m.id === shownMs.id) : -1} total={msOrdered.length}
          onStep={stepMilestone} onCurrent={curMs && shownMs?.id !== curMs.id ? () => { setViewMsId(null); } : undefined}
          onMilestone={() => { setMsEdit(true); }}
          onNewSlice={() => { setSliceEdit({ slice: null }); }}
          onIcebox={() => { setView('propositions'); }} milestonesHref={hrefTo.detail(slug, 'milestones')}
          owedAway={owedAway.length} onOwedAway={jumpToOwed} />
        <div className="km-toolbar">
          <span className="searchbox sm km-search">
            <KitIcon name="search" size={14} />
            <input placeholder="Search board" aria-label="Search board" value={query}
              onChange={(e) => setQuery(e.target.value)} />
          </span>

          <div className="seg-control sm km-layout" role="tablist" aria-label="Board layout">
            <button role="tab" aria-selected={false} className="seg-opt"
              onClick={() => writeView({ layout: 'map' })}>Map</button>
            <button role="tab" aria-selected={false} className="seg-opt"
              onClick={() => writeView({ layout: 'lanes' })}>Lanes</button>
            <button role="tab" aria-selected className="seg-opt on">List</button>
          </div>

          <>
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
          </>

          {/* Parked is a FILTER and never the default — see `hideParked`. */}
          <button className={`k-btn sm secondary km-parked${hideParked ? ' on' : ''}`}
            onClick={() => setHideParked(!hideParked)}
            title="Parked items are planned and deliberately not picked up. The autopilot skips them.">
            <KitIcon name="layers" size={14} />{hideParked ? 'Parked hidden' : `Parked shown${parked ? ` (${parked})` : ''}`}
          </button>

          <span className="km-count">
            {`${listRows.length} item${listRows.length === 1 ? '' : 's'}, ideas included`}
          </span>
        </div>

        {lists && (
          <BoardListView rows={listRows} sort={bview.sort} show={bview.show} area={listArea}
            lists={lists} areas={areas} slices={sl} milestones={ms} planningSlices={planningSlices}
            selected={selected} onOpen={(it) => { setSelected(it.id); onEdit(it); }} />
        )}

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
          onCreate={(title, bucket, extra) => { setDialog(false); add(title, bucket, '', '', extra); }} />
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
