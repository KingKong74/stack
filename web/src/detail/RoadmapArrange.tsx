// The arrange panel — the design's "✦ Gemini" band, built as PROPOSE then APPLY.
//
// TWO DEPARTURES FROM THE DESIGN, both deliberate, both about not lying:
//
//  1. THE ARITHMETIC IS NOT LABELLED GEMINI, because no model is involved.
//     Five of the six actions are deterministic sums over the rows already on
//     screen (lib/plan.ts). Badging arithmetic as an AI read would be the same
//     class of claim as rendering a NULL verdict green — it invites you to
//     trust the output for a reason that does not exist. THE SIXTH REALLY IS A
//     CLAUDE READ (on the host, via the daemon — #364) and wears the ✦,
//     because it does the one thing the sums
//     structurally cannot: notice that a dashboard cannot precede the pipeline
//     that feeds it. A panel where every button looked alike would hide which
//     one costs a call and which one can be wrong in a different way.
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
// an empty one. The Plan boards have no arithmetic to offer: a list, a tier and
// a park are all decisions, and there is nothing to compute about them.
//
// THE PANEL ALSO FOLLOWS THE AREA FILTER. An action proposes moves for the rows
// you can SEE: filter the board to `agents` and Arrange rearranges agents work
// and nothing else. A panel that quietly moved bars in six other lanes because
// they were on the same board is a diff nobody asked for and nobody was looking
// at, and it is worse for being applied in one press. The panel SAYS which
// population it is acting on rather than leaving it to be inferred.
//
// TWO ACTIONS DO NOT NARROW, and each for its own reason:
//   • LEVEL THE LANES moves work BETWEEN areas, so one area is not a population
//     it can work on at all. It is disabled under a filter and says why — a
//     "nothing to level against" summary would blame the board for the filter.
//   • FIT THE CYCLE trims a FEATURE's scope, and `scopeTotals` over a subset of
//     its lines would report a cycle that fits because the lines in other areas
//     were not counted. The arithmetic has to see every line or it is wrong, so
//     trim always reads the whole feature.
//
// It is COLLAPSED by default. This is a tool, not information, and three tall
// buttons above the board is chrome in front of the thing you came to read.

import type { RoadmapItem, SchedSpan } from '../types';
import {
  proposeCompact, proposeSchedule, proposeTrim, proposeCatchUp, proposeBalance, proposeByTier,
  areaMatches, UNALLOCATED,
  type Proposal, type TrimProposal,
} from '../lib/plan';

export type Arrangement =
  | {
    kind: 'schedule' | 'compact' | 'catchup' | 'balance' | 'tier' | 'order';
    summary: string;
    moves: { id: number; sched: SchedSpan | null }[];
    /** Per-item reasons, only the model read supplies them. */
    why?: Record<number, string>;
    /** True for the one action that spent a model call. */
    read?: boolean;
  }
  | { kind: 'trim'; summary: string; defer: number[] };

export const arrangementCount = (a: Arrangement): number =>
  a.kind === 'trim' ? a.defer.length : a.moves.length;

/** The proposed positions, for the timeline to ghost. Empty for a trim. */
export function proposedSpans(a: Arrangement | null): Map<number, SchedSpan> {
  const m = new Map<number, SchedSpan>();
  if (a && a.kind !== 'trim') a.moves.forEach((mv) => { if (mv.sched) m.set(mv.id, mv.sched); });
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
  /** Ask the Curator to read the board and propose an order. */
  onRead: () => void;
  /** The Curator is registered, switched on, allowed this op AND has a host. */
  canRead: boolean;
  /** Why not, straight from agentOffReason — never a string invented here. */
  readOffReason: string;
  reading: boolean;
}) {
  // The trim reads EVERY line of the feature, filter or not — see the header.
  const children = selected ? items.filter((i) => i.parentId === selected.id && !i.archived) : [];
  // Everything else acts on exactly the rows the filter leaves on screen.
  const filtered = !!areaFilter;
  const pool = filtered ? items.filter((i) => areaMatches(i.area, areaFilter)) : items;
  const areaName = areaFilter === UNALLOCATED ? 'unallocated' : areaFilter;
  const only = filtered ? ` — ${areaName} only` : '';

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
      note: canRead
        ? `Reads what these items actually are and says what must come before what${only}. The only action here that asks Claude — on your own host, through the terminal daemon.`
        : readOffReason || 'Nothing can read the board right now.',
      views: ['timeline'],
      disabled: !canRead || reading,
      read: true,
      run: onRead,
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
        {filtered && (
          <span className="ra-scope" title={`Only items in ${areaName} — clear the area chip above for the whole board`}>
            {areaName} only<span className="n">{pool.filter((i) => !i.archived && !i.done).length}</span>
          </span>
        )}
        <span className="ra-hint">
          {open
            ? `Arithmetic over ${filtered ? `the ${areaName} rows` : 'what is on the board'}, plus one ✦ read of ${filtered ? 'them' : 'it'}. Nothing is saved until you apply it.`
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
              <span className="nm">{a.key === 'order' && reading ? '✦ Reading the board…' : a.name}</span>
              <span className="desc">{a.note}</span>
            </button>
          ))}
        </div>
      )}

      {/* The per-move list. A summary says how many will change; this says
          WHICH — and for the ✦ read, why. Applying a diff you cannot see is
          the thing propose-then-accept was supposed to prevent. */}
      {open && proposal && proposal.kind !== 'trim' && proposal.moves.length > 0 && (
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
