// The arrange panel — two kinds of button, and the difference between them is
// the whole design.
//
//  · SIX QUICK COMMANDS hand a job to the CURATOR'S OWN SESSION, live on this
//    tab. They were arithmetic until now — pure functions over the rows on
//    screen that returned a diff to accept or discard — and the sums were exact
//    and also the ceiling: they could do the six things somebody had written a
//    function for and nothing else, and each was blind to everything the board
//    does not store. Now the press composes an instruction (lib/curatorTasks.ts,
//    pure and tested) and starts the session on it, so the answer can be argued
//    with, corrected, and told what the board could not know.
//  · TWO ✧ READS still answer in one shot and still come back as a DIFF the
//    timeline ghosts until you apply it. They run on Gemini (server/src/
//    agents.js), which is why they stay up when the host daemon is down and the
//    six commands cannot run at all.
//
// A panel where both looked alike would hide which press opens a session in
// your checkout and which one costs a read and proposes.
//
// THE COMMANDS ARE SENT, NOT TYPED, on the owner's explicit call. Everywhere
// else Stack puts text at a prompt and leaves the Enter to the human
// (console-prime.js says why, at length). Here the press starts the session
// working. The half of that rule which is NOT waived is in every brief: each
// one ends by asking for the moves as a list before anything is written, so the
// session starts immediately and stops at the write. Sent is not applied.
//
// IT FOLLOWS THE VIEW. Each action is about ONE thing — scheduling is about
// bars, trimming is about scope — and offering "close the gaps on the timeline"
// while you are cutting a feature is a button answering a question you did not
// ask. `views` on each action is what it applies to, and a view with none gets
// no panel at all rather than an empty one. The Plan boards have no bars to
// arrange, so their only action is the ✧ allocation — which is a real reason
// for the panel to be there, since untagged rows are exactly what those boards
// are full of.
//
// IT FOLLOWS THE AREA CHIP. A command names its population inside the brief, so
// filtered to `agents` the session is told to work agents and nothing else.
// THREE ACTIONS DO NOT NARROW, each for its own reason:
//   • LEVEL THE LANES moves work BETWEEN areas, so one area is not a population
//     it can work on at all.
//   • FIT THE CYCLE reads every line of a feature, because a scope total over a
//     subset reports a cycle that fits by not counting the rest.
//   • ✧ SORT THE UNALLOCATED works on the rows carrying NO area, which is the
//     one population an area chip cannot contain — under a real chip there is
//     nothing to sort, so it is disabled and says so.
//
// It is COLLAPSED by default. This is a tool, not information, and a row of
// tall buttons above the board is chrome in front of the thing you came to read.

import type { RoadmapItem, SchedSpan } from '../types';
import type { AllocatePick } from '../store';
import { areaMatches, UNALLOCATED } from '../lib/plan';
import { ARRANGE_TASKS, type ArrangeView } from '../lib/curatorTasks';

export type { ArrangeView };

/** The two actions that cost a Gemini call. The op names are the server's. */
export type ReadOp = 'arrange' | 'allocate';

export type Arrangement =
  | {
    kind: 'order';
    summary: string;
    moves: { id: number; sched: SchedSpan | null }[];
    /** Per-item reasons — the read supplies them. */
    why?: Record<number, string>;
    read: true;
  }
  /** Areas for the rows that carry none. Changes no schedule, so ghosts nothing. */
  | { kind: 'allocate'; summary: string; picks: AllocatePick[]; read: true };

export const arrangementCount = (a: Arrangement): number =>
  (a.kind === 'allocate' ? a.picks.length : a.moves.length);

/**
 * The proposed positions, for the timeline to ghost. Empty for an allocation:
 * it moves no bar, and a ghost drawn where the bar already is would say a move
 * is pending when none is.
 */
export function proposedSpans(a: Arrangement | null): Map<number, SchedSpan> {
  const m = new Map<number, SchedSpan>();
  if (a && a.kind === 'order') {
    a.moves.forEach((mv) => { if (mv.sched) m.set(mv.id, mv.sched); });
  }
  return m;
}

export function RoadmapArrange({
  view, items, areaFilter, selected, proposal, onApply, onDiscard, busy, open, onToggle,
  onRead, canRead, readOffReason, reading, onCommand, consoleOffReason, sentNote,
}: {
  view: ArrangeView;
  items: RoadmapItem[];
  /** The area chip in force. '' = the whole board; see the header. */
  areaFilter: string;
  selected: RoadmapItem | null;
  proposal: Arrangement | null;
  onApply: () => void;
  onDiscard: () => void;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  /** Ask the Curator for one of its two reads of the board. */
  onRead: (op: ReadOp) => void;
  /** The Curator is switched on, allowed THIS op AND its backend is up. */
  canRead: (op: ReadOp) => boolean;
  /** Why not, straight from agentOffReason — never a string invented here. */
  readOffReason: (op: ReadOp) => string;
  /** Which read is in flight — one at a time, and only that button says so. */
  reading: ReadOp | '';
  /** Send a brief to the Curator's console. Undefined = the console cannot take one. */
  onCommand?: (key: string) => void;
  /** Why the console cannot, straight from agentConsoleOffReason. */
  consoleOffReason: string;
  /** The last command handed over, so the panel can say it went. */
  sentNote: string;
}) {
  const filtered = !!areaFilter;
  const areaName = areaFilter === UNALLOCATED ? 'unallocated' : areaFilter;
  const only = filtered ? ` — ${areaName} only` : '';
  // The allocate action's population, and the same rows the server will read:
  // open, unarchived and carrying no area at all. Counted here so the button can
  // say there is nothing to do BEFORE it spends a call finding that out.
  const untagged = items.filter((i) => !i.area && !i.archived && !i.done);
  // A real area chip — the Unallocated chip is not one, it IS this population.
  const inAnArea = filtered && areaFilter !== UNALLOCATED;
  // What a command will be told to work on, for the line under the buttons.
  const inScope = items.filter((i) => !i.archived && !i.done && areaMatches(i.area, areaFilter));

  type Action = {
    key: string; name: string; note: string; views: ArrangeView[];
    disabled?: boolean; read?: boolean; cmd?: boolean; run: () => void;
  };

  // The six that drive the session. A dead one says WHY, and the reasons run
  // console → selection, which is the order the owner would fix them in: no
  // session at all, then nothing for this one to act on.
  const commands: Action[] = ARRANGE_TASKS.map((t) => ({
    key: t.key,
    name: t.name,
    views: t.views,
    cmd: true,
    disabled: !onCommand || (!!t.needsFeature && !selected),
    note: !onCommand
      ? consoleOffReason || 'The Curator’s session cannot open, so there is nothing to send this to.'
      : t.needsFeature && !selected
        ? 'Select a bar on the timeline first — this one trims that feature’s scope.'
        : `${t.note}${t.needsFeature && selected ? ` Reads every line of ${selected.title}.` : ''}${t.wide ? '' : only}`,
    run: () => onCommand?.(t.key),
  }));

  const reads: Action[] = [
    {
      key: 'order',
      name: '✧ Order by dependency',
      // The read that can be wrong about the WORK rather than the arithmetic.
      // The reason comes from agentOffReason, never from a string written here:
      // "switched off" and "Gemini is not configured" send you to different
      // places, and only the state knows which one it is.
      note: canRead('arrange')
        ? `Reads what these items actually are and says what must come before what${only}. One Gemini read, back as a diff you apply.`
        : readOffReason('arrange') || 'Nothing can read the board right now.',
      views: ['timeline'],
      disabled: !canRead('arrange') || !!reading,
      read: true,
      run: () => onRead('arrange'),
    },
    {
      key: 'allocate',
      name: '✧ Sort the unallocated',
      // The other axis: `arrange` says WHEN a row runs, this says WHERE it
      // belongs. Untagged work draws no lane and hides behind no chip, so this
      // is the action that goes and finds it. Reasons run capability → filter →
      // nothing-to-do, matching the server's own order.
      note: !canRead('allocate')
        ? readOffReason('allocate') || 'Nothing can read the board right now.'
        : inAnArea
          ? `Everything in ${areaName} already has an area. Clear the chip — or pick Unallocated — to sort the rows that have none.`
          : untagged.length === 0
            ? 'Every open item already carries an area. Nothing to sort.'
            : `${untagged.length} item${untagged.length === 1 ? '' : 's'} carry no area. Reads them and proposes one for each, from the areas this project already uses — a big backlog comes in batches, so press again for what is left.`,
      views: ['timeline', 'scope', 'plan'],
      disabled: !canRead('allocate') || !!reading || inAnArea || untagged.length === 0,
      read: true,
      run: () => onRead('allocate'),
    },
  ];

  const n = proposal ? arrangementCount(proposal) : 0;
  const mine = [...commands, ...reads].filter((a) => a.views.includes(view));
  const cmds = mine.filter((a) => a.cmd).length;

  // Nothing to arrange here. Not an empty panel — a panel with no buttons reads
  // as one that failed to load.
  if (mine.length === 0) return null;

  return (
    <div className={`ra${open ? ' open' : ''}`}>
      <button className="ra-head" onClick={onToggle} aria-expanded={open}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="nm">Arrange</span>
        {/* WHICH ROWS, on the heading, open or shut. The filter is a chip
            further up the tab and is easy to forget you set; a command that
            silently worked half the board would read as one that half-worked.
            It NAMES the population and does not count it — the area chip above
            is already counting, and a second number beside it counting a
            different set is two answers to one question. */}
        {filtered && (
          <span className="ra-scope" title={`Only items in ${areaName} — clear the area chip above for the whole board`}>
            {areaName} only
          </span>
        )}
        <span className="ra-hint">
          {open
            ? `${cmds ? `${cmds} command${cmds === 1 ? '' : 's'} for the Curator’s session, plus ` : ''}${
              mine.length - cmds === 1 ? 'one ✧ read' : `${mine.length - cmds} ✧ reads`} of ${
              filtered ? `the ${areaName} rows` : 'the board'}.`
            : `${mine.length} action${mine.length === 1 ? '' : 's'} for this view`}
        </span>
        {/* A proposal outlives a collapse, so the count comes with it — folding
            the panel away must not look like discarding the diff. */}
        {!open && n > 0 && <span className="ra-pending">{n} proposed</span>}
      </button>

      {open && (
        <>
          <div className="ra-actions">
            {mine.map((a) => (
              <button key={a.key} className={`ra-action${a.read ? ' read' : ' cmd'}`}
                disabled={!!a.disabled || busy} onClick={a.run}>
                {/* Only the button that is reading says so. Two ✧ actions both
                    showing "reading…" would claim two calls are out. */}
                <span className="nm">
                  {reading === 'arrange' && a.key === 'order' ? '✧ Reading the board…'
                    : reading === 'allocate' && a.key === 'allocate' ? '✧ Reading the untagged…'
                      : a.name}
                </span>
                <span className="desc">{a.note}</span>
              </button>
            ))}
          </div>

          {/* What a command press actually does, said once under the row rather
              than repeated on six buttons. The owner needs to know that a press
              starts a session TALKING — not that it computed something. */}
          {cmds > 0 && (
            <div className="ra-cmdnote">
              {onCommand
                ? (
                  <span>
                    A command opens <strong>the Curator’s session</strong> below and sets it working
                    on {filtered ? `the ${areaName} rows` : `all ${inScope.length} open items`}. It
                    shows you the moves and asks before it writes anything.
                  </span>
                )
                : <span>{consoleOffReason}</span>}
              {sentNote && <span className="sent">{sentNote}</span>}
            </div>
          )}
        </>
      )}

      {/* The per-item list. A summary says how many will change; this says
          WHICH — and why. Applying a diff you cannot see is the thing
          propose-then-accept was supposed to prevent. A COINED area is tagged:
          the timeline gains a lane nobody asked for, and that is a thing to
          notice before applying, not after. */}
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

      {open && proposal && proposal.kind === 'order' && proposal.moves.length > 0 && (
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
          <span className="ra-readtag">✧ read</span>
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
