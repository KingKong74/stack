import { Modal } from './Modal';
import { PRODUCT_NAME } from '../lib/ui';

// The "how to use" guide: what the app is for and how the pieces fit, aimed at
// someone reading the dashboard — not setting up a machine (that's ConnectGuide).
// Static content, no auth required, so the token gate can open it too.
//
// IT DESCRIBES THE APP THAT EXISTS, and keeping that true is the only rule this
// file has. It went stale once and badly: it was still teaching Must/Should/
// Could/Won't a release after #469 replaced them with five priorities, still
// sending people to a Futures tab that had been culled, and still promising
// ⌘K would search notes that no longer had a table. A guide that names screens
// nobody can find reads as a broken app rather than an out-of-date sentence.
// When a surface is renamed, culled or wired, this is part of that change.
//
// WHERE A SCREEN IS A MOCKUP, THIS SAYS SO (#472's rule, from the rail). The
// dashboard's own "What's inside" section carries the per-surface chips; what
// this owes is the same honesty in prose, so nobody reads a described feature
// as a wired one.

export function HowToGuide({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} wide>
      <h3>How {PRODUCT_NAME} works</h3>
      <div className="confirm-body" style={{ marginBottom: 20 }}>
        {PRODUCT_NAME} is the control-and-review plane over your side projects: Claude Code
        sessions do the work and checkpoint it here; you read the dashboard between sessions,
        decide what the machine builds next, and give the verdicts.
      </div>

      <div className="guide">
        <div className="guide-step">
          <div className="guide-step-title"><span className="n">1</span> The loop</div>
          <div className="guide-step-body">
            Work on any connected repo in Claude Code. Every session opens already knowing where
            the last one left off — a hook injects the project's resume context, your standing
            directives and the branch claims it must respect — and when you wrap up,{' '}
            <span className="mono">/checkpoint</span> writes a rich summary back: what happened,
            what's in progress, what's next. It's Claude-authored and free; no external API is
            called. Even without one, a silent backstop records the session's metadata, so the
            activity feed never has gaps.
          </div>
        </div>

        <div className="guide-step">
          <div className="guide-step-title"><span className="n">2</span> This screen, top to bottom</div>
          <div className="guide-step-body">
            <b>Projects</b> is the grid you came for. <b>Continue</b> is the card that makes the
            whole thing worth it — where you left off, what's mid-flight, and what the last
            session suggested doing next, with <b>Jump back in</b> opening a Claude session already
            briefed. <b>Pushes</b> is the day-grouped feed, led by last night's autopilot digest.
            <b> Priorities</b> rolls every project's board into the five buckets. <b>Audit</b> is
            what needs a human. <b>What's inside</b> is the map of the app — including which
            screens are still mockups.
          </div>
        </div>

        <div className="guide-step">
          <div className="guide-step-title"><span className="n">3</span> The review inbox</div>
          <div className="guide-step-body">
            Checkpoints auto-extract bugs and next steps into the trackers, and nothing
            auto-extracted is trusted until you've seen it — it's <b>held</b>, which means the
            overnight runner skips it. <b>Keep</b> signs it off; <b>Dismiss</b> deletes it and
            remembers the dismissal so the next push can't re-create it (which is why it has no
            undo). Work you wrote by hand is never held.
          </div>
        </div>

        <div className="guide-step">
          <div className="guide-step-title"><span className="n">4</span> Inside a project</div>
          <div className="guide-step-body">
            The left rail holds five surfaces. <b>For you</b> is where you left off, the push feed
            and the extracted-idea queue. <b>The board</b> — it wears the project's own name — is
            the committed work: a kanban that writes, and a <b>Backlog</b> tab where sprints are
            ordered. <b>Roadmap</b> is the other half of that split: ideas a push read off a
            commit, and children filed under something already on the board; <b>Promote</b> moves
            one across. <b>Plans</b> reads the stored schedule back as a timeline and a calendar.
            <b> Quality</b> is checks and bugs — still drawing the kit's sample rows, and it says
            so on its face.
          </div>
        </div>

        <div className="guide-step">
          <div className="guide-step-title"><span className="n">5</span> What the machine builds</div>
          <div className="guide-step-body">
            A <b>sprint</b> is a named, ordered box of board items, and the order inside it is the
            priority — top first. The overnight runner reads <b>only the sprint in progress</b>,
            one per project. Drag a row in and you've committed it; no active sprint means the
            night does nothing, said out loud rather than quietly falling back to the whole board.
            Priority still orders candidates below the sprint, but it no longer decides who runs.
            The arm switch, the fleet-wide worker cap and the two models are in Settings.
          </div>
        </div>

        <div className="guide-step">
          <div className="guide-step-title"><span className="n">6</span> Steering</div>
          <div className="guide-step-body">
            Each project carries a <b>north star</b> — one paragraph on what it's becoming — and{' '}
            <b>directives</b>, standing instructions injected at the start of every session above
            everything else. Both are still injected and still honoured; their editors went with
            the Overview screen, so today they're set through <span className="mono">./stack</span>{' '}
            or the API. <b>Session defaults</b> in Settings are the cross-project version: pre-
            authorised commits, verify-before-done, and the rest.
          </div>
        </div>

        <div className="guide-step">
          <div className="guide-step-title"><span className="n">✦</span> Moving fast</div>
          <div className="guide-step-body">
            <span className="mono">⌘K</span> searches projects, bugs, roadmap and activity, and
            jumps straight to the match. The resume card exports a <b>brief</b>: curated markdown
            for handing a project's state to an agent anywhere. <b>Connect</b> in the header walks
            through wiring a new machine or repo in, parallel branches included — and the ⌨
            terminal puts the host's sessions in the browser, so a permission prompt can be
            answered from a phone.
          </div>
        </div>
      </div>

      <div className="modal-actions">
        <button className="btn-submit" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
