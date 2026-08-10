// The arrange panel — the design's "✦ Gemini" band, built as PROPOSE then APPLY.
//
// TWO DEPARTURES FROM THE DESIGN, both deliberate, both about not lying:
//
//  1. THE ARITHMETIC IS NOT LABELLED GEMINI, because no model is involved.
//     Most of the actions are deterministic sums over the rows already on
//     screen (lib/plan.ts). Badging arithmetic as an AI read would be the same
//     class of claim as rendering a NULL verdict green — it invites you to
//     trust the output for a reason that does not exist. TWO OF THEM REALLY ARE
//     CLAUDE READS (on the host, via the daemon — #364) and wear the ✦, because
//     they do the two things the sums structurally cannot: notice that a
//     dashboard cannot precede the pipeline that feeds it (order), and read what
//     an untagged item is actually about (allocate). A panel where every button
//     looked alike would hide which ones cost a call and which can be wrong in a
//     different way.
//  2. IT PROPOSES; IT DOES NOT WRITE. The design applies each action straight
//     to the board and offers "drag it back" as the undo. Here the proposal
//     comes back as a diff, the timeline draws it ghosted in the accent, and
//     nothing is stored until Apply. That keeps "the human disposes" true of a
//     button whose whole job is rearranging your plan — and unlike drag-it-back
//     it is still an undo after you have closed the tab.
//
// A proposal that would change nothing says so and offers no Apply. An empty
// answer is a real answer here, exactly as it is for the ✎ Refine draft.
//
// THE PANEL FOLLOWS THE VIEW. Each action is arithmetic over ONE thing —
// scheduling and gap-closing are about bars, trimming is about scope — and
// offering "close the gaps on the timeline" while you are cutting a feature is
// a button answering a question you did not ask. `ARRANGE_VIEWS` on each action
// is what it applies to, and a view with none gets no panel at all rather than
// an empty one. The Plan boards still have no ARITHMETIC to offer — a list, a
// tier and a park are all decisions, and there is nothing to compute about them
// — but they do have untagged rows, so ✦ Sort the unallocated is the one action
// that reaches them and the only reason the panel appears there at all.
//
// THE PANEL ALSO FOLLOWS THE AREA FILTER. An action proposes moves for the rows
// you can SEE: filter the board to `agents` and Arrange rearranges agents work
// and nothing else. A panel that quietly moved bars in six other lanes because
// they were on the same board is a diff nobody asked for and nobody was looking
// at, and it is worse for being applied in one press. The panel SAYS which
// population it is acting on rather than leaving it to be inferred.
//
// THREE ACTIONS DO NOT NARROW, and each for its own reason:
//   • LEVEL THE LANES moves work BETWEEN areas, so one area is not a population
//     it can work on at all. It is disabled under a filter and says why — a
//     "nothing to level against" summary would blame the board for the filter.
//   • FIT THE CYCLE trims a FEATURE's scope, and `scopeTotals` over a subset of
//     its lines would report a cycle that fits because the lines in other areas
//     were not counted. The arithmetic has to see every line or it is wrong, so
//     trim always reads the whole feature.
//   • SORT THE UNALLOCATED works on the rows carrying NO area, which is the one
//     population an area chip cannot contain: filtered to `agents`, every row on
//     screen already has an area and there is nothing to sort. So it is disabled
//     under a real area chip and says that, and under the Unallocated chip it is
//     the rows on screen anyway. Its dead-button reasons run capability first
//     (the agent's own off reason), then population — the same order the server
//     gates in, so the two never disagree about why nothing happened.
//
// It is COLLAPSED by default. This is a tool, not information, and three tall
// buttons above the board is chrome in front of the thing you came to read.

import type { RoadmapItem, SchedSpan } from '../types';
import type { AllocatePick } from '../store';
import {
  proposeCompact, proposeSchedule, proposeTrim, proposeCatchUp, proposeBalance, proposeByTier,
  areaMatches, UNALLOCATED,
  type Proposal, type TrimProposal,
} from '../lib/plan';

/** The two actions that cost a Curator call. The op names are the server's. */
export type ReadOp = 'arrange' | 'allocate';

export type Arrangement =
  | {
    kind: 'schedule' | 'compact' | 'catchup' | 'balance' | 'tier' | 'order';
    summary: string;
    moves: { id: number; sched: SchedSpan | null }[];
    /** Per-item reasons, only the model read supplies them. */
    why?: Record<number, string>;
    /** True for an action that spent a model call. */
    read?: boolean;
  }
  | { kind: 'trim'; summary: string; defer: number[] }
  /** Areas for the rows that carry none. Changes no schedule, so ghosts nothing. */
  | { kind: 'allocate'; summary: string; picks: AllocatePick[]; read: true };

export const arrangementCount = (a: Arrangement): number =>
  a.kind === 'trim' ? a.defer.length : a.kind === 'allocate' ? a.picks.length : a.moves.length;

/**
 * The proposed positions, for the timeline to ghost. Empty for a trim, and for
 * an allocation: neither moves a bar, and a ghost drawn where the bar already
 * is would say a move is pending when none is.
 */
export function proposedSpans(a: Arrangement | null): Map<number, SchedSpan> {
  const m = new Map<number, SchedSpan>();
  if (a && a.kind !== 'trim' && a.kind !== 'allocate') {
    a.moves.forEach((mv) => { if (mv.sched) m.set(mv.id, mv.sched); });
  }
  return m;
}

/** Which view an action belongs to. */
export type ArrangeView = 'timeline' | 'scope' | 'plan';

export function RoadmapArrange({
  view, items, areaFilter, selected, proposal, onPropose, onApply, onDiscard, busy, open, onToggle,
  onRead, canRead, readOffReason, reading,
}: {
  view: ArrangeView;
  items: RoadmapItem[];
  /** The area chip in force. '' = the whole board; see the header. */
  areaFilter: string;
  selected: RoadmapItem | null;
  proposal: Arrangement | null;
  onPropose: (a: Arrangement) => void;
  onApply: () => void;
  onDiscard: () => void;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  /** Ask the Curator for one of its two reads of the board. */
  onRead: (op: ReadOp) => void;
  /** The Curator is registered, switched on, allowed THIS op AND has a host. */
  canRead: (op: ReadOp) => boolean;
  /** Why not, straight from agentOffReason — never a string invented here. */
  readOffReason: (op: ReadOp) => string;
  /** Which read is in flight — one at a time, and only that button says so. */
  reading: ReadOp | '';
}) {
  // The trim reads EVERY line of the feature, filter or not — see the header.
  const children = selected ? items.filter((i) => i.parentId === selected.id && !i.archived) : [];
  // Everything else acts on exactly the rows the filter leaves on screen.
  const filtered = !!areaFilter;
  const pool = filtered ? items.filter((i) => areaMatches(i.area, areaFilter)) : items;
  const areaName = areaFilter === UNALLOCATED ? 'unallocated' : areaFilter;
  const only = filtered ? ` — ${areaName} only` : '';
  // The allocate action's population, and the same rows the server will read:
  // open, unarchived and carrying no area at all. Counted here so the button can
  // say there is nothing to do BEFORE it spends a call finding that out.
  const untagged = items.filter((i) => !i.area && !i.archived && !i.done);
  // A real area chip — the Unallocated chip is not one, it IS this population.
  const inAnArea = filtered && areaFilter !== UNALLOCATED;

  const actions: {
    key: string; name: string; note: string; views: ArrangeView[];
    disabled?: boolean; read?: boolean; run: () => void;
  }[] = [
    {
      key: 'schedule',
      name: 'Schedule what is committed',
      note: `Every unscheduled Must and Should onto its own area lane, after the last bar there${only}.`,
      views: ['timeline'],
      run: () => {
        const p: Proposal = proposeSchedule(pool);
        onPropose({ kind: 'schedule', summary: p.summary, moves: p.moves });
      },
    },
    {
      key: 'compact',
      name: 'Close the gaps',
      note: `Pull planned bars earlier so no lane sits idle${only}. Finished work never moves.`,
      views: ['timeline'],
      run: () => {
        const p: Proposal = proposeCompact(pool);
        onPropose({ kind: 'compact', summary: p.summary, moves: p.moves });
      },
    },
    {
      key: 'catchup',
      name: 'Catch up the past',
      note: `Move bars that finished before now up to now${only} — they had slipped and were still drawn as if they had not.`,
      views: ['timeline'],
      run: () => {
        const p: Proposal = proposeCatchUp(pool);
        onPropose({ kind: 'catchup', summary: p.summary, moves: p.moves });
      },
    },
    {
      key: 'balance',
      name: 'Level the lanes',
      // The one action a single area is not a population for — see the header.
      note: filtered
        ? `Levelling moves work between areas, so it needs more than one. Clear the ${areaName} filter to use it.`
        : 'Hand one unclaimed bar from the busiest area to the emptiest. Claimed work never moves.',
      views: ['timeline'],
      disabled: filtered,
      run: () => {
        const p: Proposal = proposeBalance(items);
        onPropose({ kind: 'balance', summary: p.summary, moves: p.moves });
      },
    },
    {
      key: 'tier',
      name: 'Lead with the tier',
      note: `Reorder each lane so it runs S, A, B, C — the same sort the run queue uses${only}.`,
      views: ['timeline'],
      run: () => {
        const p: Proposal = proposeByTier(pool);
        onPropose({ kind: 'tier', summary: p.summary, moves: p.moves });
      },
    },
    {
      key: 'order',
      name: '✦ Order by dependency',
      // The only one that costs a call, and the only one that can be wrong
      // about the WORK rather than the arithmetic. Named so you can tell.
      // The reason comes from agentOffReason, never from a string written here:
      // "switched off" and "the host is not connected" send you to different
      // places, and only the state knows which one it is.
      note: canRead('arrange')
        ? `Reads what these items actually are and says what must come before what${only}. Asks Claude — on your own host, through the terminal daemon.`
        : readOffReason('arrange') || 'Nothing can read the board right now.',
      views: ['timeline'],
      disabled: !canRead('arrange') || !!reading,
      read: true,
      run: () => onRead('arrange'),
    },
    {
      key: 'allocate',
      name: '✦ Sort the unallocated',
      // The second read, and the second thing arithmetic cannot do: an area is
      // what a piece of work is ABOUT, and no sum over the board can read that.
      // Untagged work is the population that quietly disappears — it draws no
      // lane on the timeline and hides behind no chip — so this is the action
      // that goes and finds it.
      //
      // The reasons run capability → filter → nothing-to-do, matching the
      // server's own order (it gates the agent before it counts the rows), and
      // each one names the thing you would actually go and change.
      note: !canRead('allocate')
        ? readOffReason('allocate') || 'Nothing can read the board right now.'
        : inAnArea
          ? `Everything in ${areaName} already has an area. Clear the chip — or pick Unallocated — to sort the rows that have none.`
          : untagged.length === 0
            ? 'Every open item already carries an area. Nothing to sort.'
            // The count is the POPULATION, not the promise: the server caps
            // each read, so "reads the 44" would be a claim it will not keep.
            // The cap is not spelled here — one number, one home — the batch is
            // what the owner needs to know and the summary names the figures.
            : `${untagged.length} item${untagged.length === 1 ? '' : 's'} carry no area. Reads them and proposes one for each, from the areas this project already uses — a big backlog comes in batches, so press again for what is left. Asks Claude on your own host.`,
      views: ['timeline', 'scope', 'plan'],
      disabled: !canRead('allocate') || !!reading || inAnArea || untagged.length === 0,
      read: true,
      run: () => onRead('allocate'),
    },
    {
      key: 'trim',
      name: 'Fit the cycle',
      // Trim belongs to BOTH: it is a scope decision you take while looking at
      // scope, and while looking at the bar whose length that scope sets.
      views: ['timeline', 'scope'],
      // The one action the area filter does NOT narrow, and it says so: a cycle
      // total missing the lines in other areas would "fit" by not counting them.
      note: selected
        ? `Defer Coulds, then Shoulds, until ${selected.title} fits. Musts are never cut.${
          filtered ? ' Reads every line of the feature, including the ones outside this filter.' : ''}`
        : 'Select a bar on the timeline first — this one trims that feature’s scope.',
      disabled: !selected,
      run: () => {
        if (!selected) return;
        const p: TrimProposal = proposeTrim(children);
        onPropose({ kind: 'trim', summary: p.summary, defer: p.defer });
      },
    },
  ];

  const n = proposal ? arrangementCount(proposal) : 0;
  const mine = actions.filter((a) => a.views.includes(view));
  // The hint has to describe THIS view's panel: the Plan boards get the ✦
  // allocation and no arithmetic at all, and telling them about sums over the
  // board would describe buttons that are not there.
  const sums = mine.filter((a) => !a.read).length;
  const reads = mine.filter((a) => a.read).length;

  // Nothing to arrange here. Not an empty panel — a panel with no buttons reads
  // as one that failed to load.
  if (mine.length === 0) return null;

  return (
    <div className={`ra${open ? ' open' : ''}`}>
      <button className="ra-head" onClick={onToggle} aria-expanded={open}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="nm">Arrange</span>
        {/* WHICH ROWS, on the heading, open or shut. The filter is a chip
            further up the tab and is easy to forget you set; an action that
            silently moved half as many bars as you expected would read as an
            action that half-worked. */}
        {/* NAMES the population and does not count it. The area chip above is
            already counting `agents`, and a second number beside it counting a
            different set — that one is the cycle, this one would be what an
            action can move — is two answers to one question. */}
        {filtered && (
          <span className="ra-scope" title={`Only items in ${areaName} — clear the area chip above for the whole board`}>
            {areaName} only
          </span>
        )}
        <span className="ra-hint">
          {open
            ? `${sums === 0
              ? 'A ✦ read of the rows carrying no area'
              : `Arithmetic over ${filtered ? `the ${areaName} rows` : 'what is on the board'}, plus ${
                reads === 1 ? 'one ✦ read that asks' : `${reads} ✦ reads that ask`} Claude`
            }. Nothing is saved until you apply it.`
            : `${mine.length} action${mine.length === 1 ? '' : 's'} for this view`}
        </span>
        {/* A proposal outlives a collapse, so the count comes with it — folding
            the panel away must not look like discarding the diff. */}
        {!open && n > 0 && <span className="ra-pending">{n} proposed</span>}
      </button>

      {open && (
        <div className="ra-actions">
          {mine.map((a) => (
            <button key={a.key} className={`ra-action${a.read ? ' read' : ''}`}
              disabled={!!a.disabled || busy} onClick={a.run}>
              {/* Only the button that is reading says so. Two ✦ actions both
                  showing "reading…" would claim two calls are out. */}
              <span className="nm">
                {reading === 'arrange' && a.key === 'order' ? '✦ Reading the board…'
                  : reading === 'allocate' && a.key === 'allocate' ? '✦ Reading the untagged…'
                    : a.name}
              </span>
              <span className="desc">{a.note}</span>
            </button>
          ))}
        </div>
      )}

      {/* The per-move list. A summary says how many will change; this says
          WHICH — and for the ✦ read, why. Applying a diff you cannot see is
          the thing propose-then-accept was supposed to prevent. */}
      {/* The same list for an allocation, reading area → area rather than week
          → week. A COINED area is tagged: the timeline gains a lane nobody
          asked for, and that is a thing to notice before applying, not after. */}
      {open && proposal && proposal.kind === 'allocate' && proposal.picks.length > 0 && (
        <div className="ra-moves">
          {proposal.picks.slice(0, 8).map((p) => (
            <div className="ra-move" key={p.id}>
              <span className="t">{p.title}</span>
              <span className="wk">
                unallocated → {p.area}
                {p.isNew && <span className="ra-newarea" title="This project has never used this area — applying it creates the lane">new</span>}
              </span>
              {p.why && <span className="why">{p.why}</span>}
            </div>
          ))}
          {proposal.picks.length > 8 && (
            <div className="ra-move more">…and {proposal.picks.length - 8} more</div>
          )}
        </div>
      )}

      {open && proposal && proposal.kind !== 'trim' && proposal.kind !== 'allocate' && proposal.moves.length > 0 && (
        <div className="ra-moves">
          {proposal.moves.slice(0, 8).map((mv) => {
            const it = items.find((x) => x.id === mv.id);
            if (!it) return null;
            return (
              <div className="ra-move" key={mv.id}>
                <span className="t">{it.title}</span>
                <span className="wk">
                  {it.sched ? `wk ${it.sched.start + 1}` : 'tray'} → {mv.sched ? `wk ${mv.sched.start + 1}` : 'tray'}
                </span>
                {proposal.why?.[mv.id] && <span className="why">{proposal.why[mv.id]}</span>}
              </div>
            );
          })}
          {proposal.moves.length > 8 && (
            <div className="ra-move more">…and {proposal.moves.length - 8} more</div>
          )}
        </div>
      )}

      {open && proposal && (
        <div className={`ra-result${n ? ' actionable' : ''}`}>
          {proposal.kind !== 'trim' && proposal.read && <span className="ra-readtag">✦ read</span>}
          <span className="txt">{proposal.summary}</span>
          {n > 0 && (
            <span className="acts">
              <button className="btn-cancel sm" onClick={onDiscard} disabled={busy}>Discard</button>
              <button className="btn-accent sm" onClick={onApply} disabled={busy}>
                {busy ? 'Applying…' : `Apply ${n} change${n === 1 ? '' : 's'}`}
              </button>
            </span>
          )}
          {n === 0 && <button className="rail-link" onClick={onDiscard}>Dismiss</button>}
        </div>
      )}
    </div>
  );
}
