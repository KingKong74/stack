// The Roadmap tab's SHELL — one segmented control over three views.
//
// Timeline, Scope and Plan. Tiers and Parked were views of their own until they
// became BOARDS INSIDE PLAN: all five were the same rows read differently, and a
// strip whose last two entries were two more readings of the plan made one tab
// look like five screens. The move changes where they are drawn and nothing
// about what they mean — `tier` is still set only by a human, from the Tiers
// board, and the parked shelf still ages its rows (#247).
//
// THE OLD BOARD IS GONE — Scope replaced it, and replacing means ABSORBING:
// Scope carries the Board's edit/delete/park/branch tools, every tag it showed,
// and its drag-reorder, because the order within a lane IS the run queue's
// tiebreak once `tier` has sorted it (CLAUDE.md). Dropping the Board without
// moving all of that would have quietly removed controls the fleet depends on.
//
// This file owns everything the views share: the area chips and their editor,
// the label filter, the board's furniture (areas + lists, fetched once here),
// the selected bar, and the arrange proposal.
//
// THE AREA CHIPS COUNT WHAT IS IN THE CYCLE, and an area with nothing in it is
// hidden behind a "+N more" rather than drawn as a zero. `inCycle` is
// `lib/plan.ts`'s, the same predicate `scopeTotals` splits on, because a chip
// counting a different population from the drawer beside it is two answers to
// one question. The ACTIVE chip is never hidden, however its count falls: the
// filter you are looking through has to stay on screen to be released. It writes through
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
import type { TabAgentState } from '../store';
import {
  getBoardShape, patchRoadmapItem, createRoadmapItem,
  addArea, renameArea as renameAreaApi, deleteArea as deleteAreaApi, addList as addListApi,
  setAreaColour, arrangeRoadmap, agentCan, agentOffReason,
} from '../store';
import { inCycle } from '../lib/plan';
import { RoadmapTimeline } from './RoadmapTimeline';
import { RoadmapScope } from './RoadmapScope';
import { RoadmapPlan } from './RoadmapPlan';
import { RoadmapTiers, RoadmapParked } from './RoadmapBoards';
import { RoadmapArrange, proposedSpans, arrangementCount, type Arrangement } from './RoadmapArrange';
import { NOW_WEEK, whatsNext } from '../lib/plan';
import { go } from '../lib/route';

type View = 'timeline' | 'scope' | 'plan';
type PlanBoard = 'lists' | 'tiers' | 'parked';

const VIEWS: { key: View; label: string; title: string }[] = [
  { key: 'timeline', label: 'Timeline', title: 'When each area is working on what' },
  { key: 'scope', label: 'Scope', title: 'What is in this cycle and what is first to cut' },
  { key: 'plan', label: 'Plan', title: 'The boards — lists, tiers and the parked shelf' },
];

const PLAN_BOARDS: { key: PlanBoard; label: string; title: string }[] = [
  { key: 'lists', label: 'Lists', title: 'Your own columns' },
  { key: 'tiers', label: 'Tiers', title: 'What you want built next — the run queue’s primary sort' },
  { key: 'parked', label: 'Parked', title: 'Everything parked, oldest park first' },
];

const flat = (r: RoadmapData): RoadmapItem[] => [...r.must, ...r.should, ...r.could, ...r.wont];

/**
 * The callbacks that live in ProjectDetail because they open modals, write
 * through `store.ts` or navigate. Declared HERE rather than derived from a
 * component's props: it used to be `Parameters<typeof Roadmap>[0]`, and when
 * Roadmap went so did the only place this shape was written down.
 */
export interface RoadmapLegacy {
  highlightId?: string | null;
  liveBranches?: string[];
  /** #247 — days a parked item may sit before the shelf calls it stale. */
  staleItemDays?: number;
  onAdd: (p: Priority, area?: string) => void;
  /** An unfinished item from a modal that was closed — resumable, not lost. */
  draft?: { title: string } | null;
  onResumeDraft?: () => void;
  onDiscardDraft?: () => void;
  onToggle: (item: RoadmapItem) => void;
  onEdit: (item: RoadmapItem) => void;
  onDelete: (item: RoadmapItem) => void;
  onClearNote: (item: RoadmapItem, field: 'note' | 'refineNote') => void;
  onToggleSkip: (item: RoadmapItem) => void;
  onReorder?: (item: RoadmapItem, toBucket: Priority, beforeId: number | null) => void;
  /** ✧ the Curator's board cleanup — Tiers board only, where it has lived. */
  onCleanup?: () => void;
  onSendToTerminal?: (brief: string) => void;
  /** #227 — set (or clear, with '') an item's desire tier. HUMANS ONLY. */
  onSetTier?: (item: RoadmapItem, tier: Tier) => void;
  /** ⎇ claim a branch and open a primed session (#205). */
  onBranch?: (item: RoadmapItem) => void;
}

export interface RoadmapTabProps {
  slug: string;
  /** #361 — which of the Curator's ops may run at all on this project. */
  agents: TabAgentState;
  roadmap: RoadmapData;
  /** The Monday the timeline counts weeks from; null = no dates, no calendar. */
  weekZero: string | null;
  /** Replace one item in the parent's copy after a write. */
  onItemChanged: (item: RoadmapItem) => void;
  /** Replace SEVERAL at once. Not a convenience — see the note on `writeOnly`. */
  onItemsChanged: (items: RoadmapItem[]) => void;
  onItemAdded: (item: RoadmapItem) => void;
  legacy: RoadmapLegacy;
  onOpenItem: (item: RoadmapItem) => void;
}

export function RoadmapTab({
  slug, roadmap, weekZero, agents, onItemChanged, onItemsChanged, onItemAdded, legacy, onOpenItem,
}: RoadmapTabProps) {
  // A deep link to an item lands on SCOPE, because that is where an item now
  // lives — the Board used to reveal it and the Board is gone. Without this a
  // search result would open the Timeline, which shows bars, not rows.
  const [view, setView] = useState<View>(legacy.highlightId ? 'scope' : 'timeline');
  useEffect(() => { if (legacy.highlightId) setView('scope'); }, [legacy.highlightId]);
  const [board, setBoard] = useState<PlanBoard>('lists');
  // Collapsed by default: Arrange is a TOOL, not information, and three tall
  // buttons above the board is chrome in front of the thing you came to read.
  const [arrangeOpen, setArrangeOpen] = useState(false);
  const [showHiddenAreas, setShowHiddenAreas] = useState(false);
  const [areas, setAreas] = useState<BoardArea[]>([]);
  const [lists, setLists] = useState<BoardList[]>([]);
  // The colours an area may wear, served by the board read so the picker can
  // only offer what the server will store.
  const [palette, setPalette] = useState<string[]>([]);
  // Which area's swatch popover is open (one at a time).
  const [colourFor, setColourFor] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
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
      .then((b) => { if (alive) { setAreas(b.areas); setLists(b.lists); setPalette(b.palette || []); } })
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

  const selected = selectedId === null ? null : items.find((i) => i.id === selectedId) || null;

  // --- the arrange proposal ------------------------------------------------

  const applyProposal = async () => {
    if (!proposal) return;
    setBusy(true);
    const landed: RoadmapItem[] = [];
    try {
      if (proposal.kind === 'trim') {
        for (const id of proposal.defer) {
          const it = items.find((x) => x.id === id);
          if (it) landed.push(await writeOnly(it, { skipped: true }));
        }
      } else {
        for (const mv of proposal.moves) {
          const it = items.find((x) => x.id === mv.id);
          if (it) landed.push(await writeOnly(it, { sched: mv.sched }));
        }
      }
      setProposal(null);
    } catch (e) {
      // Partial application is the honest outcome to report: some rows moved.
      // Saying "failed" would suggest none did, and the board already shows
      // which ones landed.
      setErr(`${(e as Error)?.message || 'A change was rejected'} — the changes before it were applied.`);
    } finally {
      // Whatever landed goes back in ONE pass, on the failure path too — the
      // rows that were accepted are on the server either way, and a board that
      // did not show them would be behind the truth.
      onItemsChanged(landed);
      setBusy(false);
    }
  };

  // Sweep a lane into the archive. Sequential rather than parallel: these are
  // ordinary PATCHes and a lane can hold thirty, and firing thirty at once at a
  // single-container API to save a second is not a trade worth making.
  //
  // A PARTIAL failure is reported as one, exactly as applyProposal does — some
  // cards moved, the board already shows which, and calling that "failed" would
  // suggest none did.
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

  // The Curator's read of the timeline. It PROPOSES; the moves land in the same
  // proposal slot the arithmetic uses, so Apply and Discard work identically and
  // the timeline ghosts them the same way.
  const readTheBoard = () => {
    setReading(true);
    arrangeRoadmap(slug)
      .then((r) => {
        const why: Record<number, string> = {};
        r.moves.forEach((m) => { if (m.why) why[m.id] = m.why; });
        setProposal({
          kind: 'order',
          read: true,
          why,
          moves: r.moves.map((m) => ({ id: m.id, sched: m.sched })),
          summary: r.moves.length
            ? `Read ${items.filter((i) => !i.archived && !i.done).length} items and found ${r.moves.length} that sit before something they depend on.`
            : r.note || 'Read the board and found nothing out of order — every item is scheduled after what it needs.',
        });
      })
      .catch((e) => setErr((e as Error)?.message || 'The Curator could not read the board.'))
      .finally(() => setReading(false));
  };

  // A Claude session primed with THIS tab's state.
  //
  // The same one-shot hand-off every other surface uses (sessionStorage +
  // the terminal screen picks it up once). What makes it worth having here
  // rather than a bare "open a terminal" is the brief: a session that opens
  // knowing what is scheduled, what is late and what is still in the tray does
  // not spend its first four turns asking.
  const openSession = () => {
    const live = items.filter((i) => !i.archived && !i.done);
    const line = (i: RoadmapItem) =>
      `- #${i.id} ${i.title}${i.area ? ` [${i.area}]` : ''}${i.tier ? ` · tier ${i.tier}` : ''}`
      + `${i.sched ? ` · wk ${i.sched.start + 1}–${i.sched.start + i.sched.len}` : ''}`
      + `${i.estimate === null ? '' : ` · ${i.estimate}w`}`;
    const running = live.filter((i) => i.sched && i.sched.start <= NOW_WEEK && i.sched.start + i.sched.len > NOW_WEEK);
    const soon = whatsNext(live, 5).filter((n) => !n.running).map((n) => n.item);
    const late = live.filter((i) => i.sched && i.sched.start + i.sched.len <= NOW_WEEK);
    const tray = live.filter((i) => !i.sched);

    const brief = [
      `Roadmap — ${slug}${areaFilter ? ` · area: ${areaFilter}` : ''}`,
      '',
      'Weeks below are indexes from this project\'s week zero, not dates.',
      '',
      running.length ? `RUNNING NOW (week ${NOW_WEEK + 1}):\n${running.map(line).join('\n')}` : 'RUNNING NOW: nothing.',
      '',
      soon.length ? `NEXT UP:\n${soon.map(line).join('\n')}` : 'NEXT UP: nothing scheduled ahead.',
      '',
      // Named separately because it is the one state the chart shows and
      // nobody acts on: a bar whose whole span is behind the now-line.
      late.length ? `SCHEDULED ENTIRELY IN THE PAST (slipped, not moved):\n${late.map(line).join('\n')}` : '',
      late.length ? '' : null,
      tray.length ? `UNSCHEDULED (${tray.length}):\n${tray.slice(0, 12).map(line).join('\n')}`
        + (tray.length > 12 ? `\n…and ${tray.length - 12} more` : '') : 'UNSCHEDULED: nothing.',
      '',
      'I am looking at the Roadmap tab. Ask me what I want before changing anything.',
    ].filter((x) => x !== null && x !== '').join('\n');

    try { sessionStorage.setItem('stack.term.brief', brief); } catch { /* private mode — it just opens unprimed */ }
    go.terminal(slug);
  };

  // --- areas ----------------------------------------------------------------

  // The chips count what is IN THE CYCLE (lib/plan.ts's `inCycle`), so the
  // number on a chip and the weeks in the scope drawer describe the same rows.
  //
  // The PARKED board is the one exception, and it is not a special case so much
  // as the same rule: a parked item is BY DEFINITION not in the cycle, so
  // counting the cycle there would put "Infra 0" above a column holding two
  // Infra cards, and hide the very chip you need to filter by. The number
  // always describes the rows you are looking at.
  const parkedBoard = view === 'plan' && board === 'parked';
  const scoped = useMemo(
    () => (parkedBoard
      ? items.filter((i) => i.skipped && !i.done && !i.archived)
      : items.filter(inCycle)),
    [items, parkedBoard]);

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
  const areaChips = showHiddenAreas || editAreas ? [...shownAreas, ...hiddenAreas] : shownAreas;

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
        {/* A Claude session on this project, primed with what the tab is
            showing. Sits with the view switch because it is about the whole
            tab, not one board. */}
        <button className="rtab-session" onClick={openSession}
          title="Open a Claude session primed with this roadmap — what is running, what is next, what has slipped and what is still unscheduled">
          ✳ Claude session
        </button>
        <span className="rtab-hint">
          {view === 'timeline' ? 'Weeks from this project’s week zero — a plan, not a calendar'
            : view === 'scope' ? 'What is in the cycle, and what is first to cut'
              : board === 'tiers' ? 'What you want built NEXT — drag a card to rank it'
                : board === 'parked' ? 'Cut from this cycle, still part of the feature'
                  : 'Cards move between lists; a column is not a verdict'}
        </span>
      </div>

      {err && <div className="action-error">{err}</div>}

      <div className="rtab-chips">
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
                        onClick={() => {
                          setColourFor(null);
                          guard(setAreaColour(slug, a.name, c).then(setAreas), 'change that colour');
                        }} />
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
                title={parkedBoard
                  ? `${a.name} — ${a.n} parked`
                  : a.n === 0 ? `${a.name} — nothing in the cycle` : `${a.name} — ${a.n} in the cycle`}>
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
          {/* An area with nothing in the cycle is hidden rather than drawn as a
              zero — but it is REPORTED, because an area you cannot see is one
              you cannot file work into. Editing always shows them all. */}
          {hiddenAreas.length > 0 && !editAreas && (
            <button className="rtab-hidden" onClick={() => setShowHiddenAreas(!showHiddenAreas)}
              title={showHiddenAreas
                ? `Hide the areas with nothing ${parkedBoard ? 'parked' : 'in the cycle'}`
                : hiddenAreas.map((a) => a.name).join(', ')}>
              {showHiddenAreas ? 'Hide empty' : `+${hiddenAreas.length} empty`}
            </button>
          )}
          <button className="rtab-editareas" onClick={() => { setEditAreas(!editAreas); setAreaDraft(null); }}>
            {editAreas ? 'Done' : 'Edit areas'}
          </button>
      </div>

      {/* Arrange follows the view: each action is arithmetic over ONE thing, and
          offering "close the gaps on the timeline" while you are cutting scope
          is a button that answers a question you did not ask. A view with no
          applicable action gets no panel — see ARRANGE_VIEWS in RoadmapArrange. */}
      <RoadmapArrange
        view={view} items={items} selected={selected} proposal={proposal} busy={busy}
        open={arrangeOpen} onToggle={() => setArrangeOpen(!arrangeOpen)}
        onPropose={setProposal} onApply={applyProposal} onDiscard={() => setProposal(null)}
        onRead={readTheBoard} reading={reading}
        canRead={agentCan(agents, 'curator', 'arrange')}
        readOffReason={agentOffReason(agents, 'curator', 'arrange')} />

      {view === 'timeline' && (
        <>
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
        <>
        <div className="rtab-boards" role="tablist" aria-label="Plan board">
          {PLAN_BOARDS.map((b) => (
            <button key={b.key} role="tab" aria-selected={board === b.key} title={b.title}
              className={`rtab-board${board === b.key ? ' on' : ''}`} onClick={() => setBoard(b.key)}>
              {b.label}
            </button>
          ))}
        </div>
        </>
      )}

      {view === 'plan' && board === 'tiers' && (
        <RoadmapTiers
          items={items} areas={areas} areaFilter={areaFilter}
          onSetTier={(it, tier) => { guard(write(it, { tier }), 'rank that item'); }}
          onToggleSkip={(it) => { guard(write(it, { skipped: !it.skipped }), 'park that item'); }}
          onOpen={onOpenItem}
          onCleanup={legacy.onCleanup} onSendToTerminal={legacy.onSendToTerminal} />
      )}

      {view === 'plan' && board === 'parked' && (
        <RoadmapParked
          items={items} areas={areas} areaFilter={areaFilter} staleItemDays={legacy.staleItemDays}
          onSetTier={(it, tier) => { guard(write(it, { tier }), 'rank that item'); }}
          onToggleSkip={(it) => { guard(write(it, { skipped: !it.skipped }), 'unpark that item'); }}
          onOpen={onOpenItem} />
      )}

      {view === 'plan' && board === 'lists' && (
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
          onArchiveMany={(cards) => { void archiveMany(cards); }}
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

    </div>
  );
}

export { arrangementCount };
