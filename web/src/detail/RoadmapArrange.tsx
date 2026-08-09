// The arrange panel — the design's "✦ Gemini" band, built as PROPOSE then APPLY.
//
// TWO DEPARTURES FROM THE DESIGN, both deliberate, both about not lying:
//
//  1. IT IS NOT LABELLED GEMINI, because no model is involved. All three
//     actions are deterministic arithmetic over the rows already on screen
//     (lib/plan.ts). Badging arithmetic as an AI read would be the same class
//     of claim as rendering a NULL verdict green — it invites you to trust the
//     output for a reason that does not exist. It is called what it is.
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
// It is COLLAPSED by default. This is a tool, not information, and three tall
// buttons above the board is chrome in front of the thing you came to read.

import type { RoadmapItem, SchedSpan } from '../types';
import { proposeCompact, proposeSchedule, proposeTrim, type Proposal, type TrimProposal } from '../lib/plan';

export type Arrangement =
  | { kind: 'schedule' | 'compact'; summary: string; moves: { id: number; sched: SchedSpan | null }[] }
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
  view, items, selected, proposal, onPropose, onApply, onDiscard, busy, open, onToggle,
}: {
  view: ArrangeView;
  items: RoadmapItem[];
  selected: RoadmapItem | null;
  proposal: Arrangement | null;
  onPropose: (a: Arrangement) => void;
  onApply: () => void;
  onDiscard: () => void;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const children = selected ? items.filter((i) => i.parentId === selected.id && !i.archived) : [];

  const actions: {
    key: string; name: string; note: string; views: ArrangeView[];
    disabled?: boolean; run: () => void;
  }[] = [
    {
      key: 'schedule',
      name: 'Schedule what is committed',
      note: 'Every unscheduled Must and Should onto its own area lane, after the last bar there.',
      views: ['timeline'],
      run: () => {
        const p: Proposal = proposeSchedule(items);
        onPropose({ kind: 'schedule', summary: p.summary, moves: p.moves });
      },
    },
    {
      key: 'compact',
      name: 'Close the gaps',
      note: 'Pull planned bars earlier so no lane sits idle. Finished work never moves.',
      views: ['timeline'],
      run: () => {
        const p: Proposal = proposeCompact(items);
        onPropose({ kind: 'compact', summary: p.summary, moves: p.moves });
      },
    },
    {
      key: 'trim',
      name: 'Fit the cycle',
      // Trim belongs to BOTH: it is a scope decision you take while looking at
      // scope, and while looking at the bar whose length that scope sets.
      views: ['timeline', 'scope'],
      note: selected
        ? `Defer Coulds, then Shoulds, until ${selected.title} fits. Musts are never cut.`
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
        <span className="ra-hint">
          {open
            ? 'Arithmetic over what is on the board — no model reads this, and nothing is saved until you apply it.'
            : `${mine.length} action${mine.length === 1 ? '' : 's'} for this view`}
        </span>
        {/* A proposal outlives a collapse, so the count comes with it — folding
            the panel away must not look like discarding the diff. */}
        {!open && n > 0 && <span className="ra-pending">{n} proposed</span>}
      </button>

      {open && (
        <div className="ra-actions">
          {mine.map((a) => (
            <button key={a.key} className="ra-action" disabled={!!a.disabled || busy} onClick={a.run}>
              <span className="nm">{a.name}</span>
              <span className="desc">{a.note}</span>
            </button>
          ))}
        </div>
      )}

      {open && proposal && (
        <div className={`ra-result${n ? ' actionable' : ''}`}>
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
