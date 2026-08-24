// The arrange panel — two kinds of button, and the difference between them is
// the whole design.
//
//  · QUICK COMMANDS hand a job to the CURATOR'S OWN SESSION, live on this tab.
//    They were arithmetic until #379/#380 — pure functions over the rows on
//    screen that returned a diff to accept or discard — and the sums were exact
//    and also the ceiling: they could do the things somebody had written a
//    function for and nothing else, and each was blind to everything the board
//    does not store. Now the press composes an instruction (lib/curatorTasks.ts,
//    pure and tested) and starts the session on it, so the answer can be argued
//    with, corrected, and told what the board could not know. THERE ARE NONE
//    LEFT at top level: all six were timeline arithmetic and went with the
//    Timeline (#428). The row simply does not draw, and the catalogue is where
//    the next board-shaped command goes.
//  · ONE ✧ READ still answers in one shot and still comes back as a DIFF to
//    apply or discard. It runs on Gemini (server/src/agents.js), which is why it
//    stays up when the host daemon is down and a command could not run at all.
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
// IT FOLLOWS THE BOARD. Each action is about ONE thing, and offering an action
// that answers a question this board does not ask is chrome. `views` on each
// action is what it applies to, and a board with none gets no panel at all
// rather than an empty one.
//
// IT FOLLOWS THE AREA CHIP — except for ✧ SORT THE UNALLOCATED, which works on
// the rows carrying NO area. That is the one population an area chip cannot
// contain: under a real chip there is nothing to sort, so it is disabled and
// says so.
//
// It is COLLAPSED by default. This is a tool, not information, and a row of
// tall buttons above the board is chrome in front of the thing you came to read.

import type { RoadmapItem } from '../types';
import type { AllocatePick } from '../store';
import { areaMatches, UNALLOCATED } from '../lib/plan';
import { TOP_LEVEL_TASKS, type ArrangeView } from '../lib/curatorTasks';

export type { ArrangeView };

/**
 * The action that costs a Gemini call. The op name is the server's.
 *
 * A UNION OF ONE, deliberately. `arrange` was the other — it proposed {id,
 * sched} moves for the Timeline to ghost, and with no timeline there is nowhere
 * to see a proposed bar, so the read went with the surface it answered to
 * (CLAUDE.md's one-surface-one-switch, #428). The server route and the registry
 * op survive the cut, unsurfaced, exactly as the branch previews do.
 */
export type ReadOp = 'allocate';

/** Areas for the rows that carry none. */
export type Arrangement = { kind: 'allocate'; summary: string; picks: AllocatePick[]; read: true };

export const arrangementCount = (a: Arrangement): number => a.picks.length;

export function RoadmapArrange({
  view, items, areaFilter, proposal, onApply, onDiscard, busy, open, onToggle,
  onRead, canRead, readOffReason, reading, onCommand, consoleOffReason, sentNote,
}: {
  view: ArrangeView;
  items: RoadmapItem[];
  /** The area chip in force. '' = the whole board; see the header. */
  areaFilter: string;
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
  /** Which read is in flight, and only that button says so. */
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
    /**
     * A SECOND WAY TO RUN THE SAME JOB, drawn inside the card. The ✧ read
     * answers in one shot, capped and quota-bound; the session reads every row
     * and can be argued with. They are two routes to one outcome, so they
     * belong on one card — two top-level buttons with the same name would be a
     * puzzle, not a choice — and they go dead independently, because what stops
     * one (a spent Gemini quota) is not what stops the other (no console).
     */
    side?: { label: string; title: string; disabled: boolean; run: () => void };
  };

  // The ones that drive the session. A dead one says WHY rather than just
  // going grey. EMPTY since the Timeline went (#428) — the catalogue is still
  // read rather than the row deleted, so the next command added draws itself.
  const commands: Action[] = TOP_LEVEL_TASKS.map((t) => ({
    key: t.key,
    name: t.name,
    views: t.views,
    cmd: true,
    disabled: !onCommand,
    note: !onCommand
      ? consoleOffReason || 'The Curator’s session cannot open, so there is nothing to send this to.'
      : `${t.note}${t.wide ? '' : only}`,
    run: () => onCommand?.(t.key),
  }));

  const reads: Action[] = [
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
      views: ['scope', 'board'],
      disabled: !canRead('allocate') || !!reading || inAnArea || untagged.length === 0,
      read: true,
      run: () => onRead('allocate'),
      // The same job, handed to the session instead. It is the route that
      // survives what stops the read: the ✧ pass is capped at a batch and
      // spends free-tier quota, and with that quota gone this is the only way
      // to run it at all. It also reads EVERY untagged row rather than a batch,
      // and can say why it could not place one.
      //
      // Its tooltip carries its OWN reasons, in its own order. The card's
      // sentence explains the ✧ read, and the two do not fail for the same
      // things: a spent quota is the read's problem and never this one's, a
      // missing console is this one's and never the read's. A dead control
      // repeating the other one's excuse is a dead control saying nothing.
      side: {
        label: '⌨ In the session',
        title: !onCommand
          ? consoleOffReason || 'The Curator’s session cannot open, so there is nothing to send this to.'
          : inAnArea
            ? `Everything in ${areaName} already has an area. Clear the chip — or pick Unallocated — to sort the rows that have none.`
            : untagged.length === 0
              ? 'Every open item already carries an area. Nothing to sort.'
              : `Hand the same job to the Curator’s session — it reads all ${untagged.length}, in one conversation, and asks before it writes`,
        disabled: !onCommand || inAnArea || untagged.length === 0,
        run: () => onCommand?.('allocate'),
      },
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
          {/* A card is a DIV holding its button, not a button itself: one of
              them carries a second action, and a button inside a button is not
              a thing. `off` on the card is what the disabled styling hangs off,
              since the card itself can no longer be :disabled. */}
          <div className="ra-actions">
            {mine.map((a) => {
              const off = !!a.disabled || busy;
              return (
                <div key={a.key} className={`ra-action${a.read ? ' read' : ' cmd'}${off ? ' off' : ''}`}>
                  <button className="ra-main" disabled={off} onClick={a.run}>
                    {/* Only the button that is reading says so — a second ✧
                        action showing "reading…" would claim two calls are out. */}
                    <span className="nm">
                      {reading === 'allocate' && a.key === 'allocate' ? '✧ Reading the untagged…' : a.name}
                    </span>
                    <span className="desc">{a.note}</span>
                  </button>
                  {a.side && (
                    <button className="ra-side" disabled={a.side.disabled || busy}
                      title={a.side.title} onClick={a.side.run}>
                      {a.side.label}
                    </button>
                  )}
                </div>
              );
            })}
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
          the board gains a chip nobody asked for, and that is a thing to notice
          before applying, not after. */}
      {open && proposal && proposal.picks.length > 0 && (
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
