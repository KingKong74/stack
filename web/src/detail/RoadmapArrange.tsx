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

export function RoadmapArrange({
  items, selected, proposal, onPropose, onApply, onDiscard, busy,
}: {
  items: RoadmapItem[];
  selected: RoadmapItem | null;
  proposal: Arrangement | null;
  onPropose: (a: Arrangement) => void;
  onApply: () => void;
  onDiscard: () => void;
  busy: boolean;
}) {
  const children = selected ? items.filter((i) => i.parentId === selected.id && !i.archived) : [];

  const actions = [
    {
      key: 'schedule',
      name: 'Schedule what is committed',
      note: 'Every unscheduled Must and Should onto its own area lane, after the last bar there.',
      run: () => {
        const p: Proposal = proposeSchedule(items);
        onPropose({ kind: 'schedule', summary: p.summary, moves: p.moves });
      },
    },
    {
      key: 'compact',
      name: 'Close the gaps',
      note: 'Pull planned bars earlier so no lane sits idle. Finished work never moves.',
      run: () => {
        const p: Proposal = proposeCompact(items);
        onPropose({ kind: 'compact', summary: p.summary, moves: p.moves });
      },
    },
    {
      key: 'trim',
      name: 'Fit the cycle',
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

  return (
    <div className="ra">
      <div className="ra-head">
        <span className="nm">Arrange</span>
        <span className="ra-hint">
          Arithmetic over what is on the board — no model reads this, and nothing is saved until you apply it.
        </span>
      </div>

      <div className="ra-actions">
        {actions.map((a) => (
          <button key={a.key} className="ra-action" disabled={!!a.disabled || busy} onClick={a.run}>
            <span className="nm">{a.name}</span>
            <span className="desc">{a.note}</span>
          </button>
        ))}
      </div>

      {proposal && (
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
