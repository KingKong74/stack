import { Modal } from './Modal';
import { PRODUCT_NAME } from '../lib/ui';

// The "how to use" guide: what the app is for and how the pieces fit, aimed at
// someone reading the dashboard — not setting up a machine (that's ConnectGuide).
// Static content, no auth required, so the token gate can open it too.

export function HowToGuide({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} wide>
      <h3>How {PRODUCT_NAME} works</h3>
      <div className="confirm-body" style={{ marginBottom: 20 }}>
        {PRODUCT_NAME} is the control-and-review plane over your side projects: Claude Code
        sessions do the work and checkpoint it here; you read the dashboard between sessions,
        review what happened, and steer what's next.
      </div>

      <div className="guide">
        <div className="guide-step">
          <div className="guide-step-title"><span className="n">1</span> The loop</div>
          <div className="guide-step-body">
            Work on any connected repo in Claude Code. Every session opens already knowing where
            the last one left off (a hook injects the project's resume context), and when you wrap
            up, <span className="mono">/checkpoint</span> writes a rich summary back — what
            happened, what's in progress, what's next. Even without a checkpoint, a silent backstop
            records the session's metadata, so the activity feed never has gaps.
          </div>
        </div>

        <div className="guide-step">
          <div className="guide-step-title"><span className="n">2</span> The command deck</div>
          <div className="guide-step-body">
            The top of the dashboard is the cross-project glance: a <b>pick up where you left
            off</b> hero, <b>Live now</b> (sessions running at this moment, with their branches),
            ⚑ <b>lane claims</b> (which parallel session owns which roadmap item), the <b>review
            inbox</b>, and an attention row — blocked, stale, bugs — that goes calm at zero.
            Everything clicks through to the project it belongs to.
          </div>
        </div>

        <div className="guide-step">
          <div className="guide-step-title"><span className="n">3</span> The review inbox</div>
          <div className="guide-step-body">
            Checkpoints auto-extract bugs, next steps and ideas into the trackers. Nothing
            auto-extracted is trusted until you've seen it: <b>Keep</b> approves an item into its
            tracker, <b>Dismiss</b> deletes it and remembers the dismissal so the next push can't
            re-create it. Clear the inbox and the block disappears.
          </div>
        </div>

        <div className="guide-step">
          <div className="guide-step-title"><span className="n">4</span> Inside a project</div>
          <div className="guide-step-body">
            <b>Overview</b> holds the resume card, directives, deployment and tech stack.
            <b> Bugs</b> tracks issues and hosts <b>Checks</b> — click-to-run HTTP probes against
            the live app; a failing check turns into a bug in one click. <b>Roadmap</b> buckets
            work into Must/Should/Could/Won't — ticking an item archives it, and archived work
            takes a review verdict (solid / needs work / rethink, the latter two bouncing a
            follow-up back onto the board). <b>Futures</b> is the idea funnel, <b>Notes</b> are
            stickies that promote into bugs or roadmap items, and <b>Activity</b> is every push.
          </div>
        </div>

        <div className="guide-step">
          <div className="guide-step-title"><span className="n">5</span> Steering</div>
          <div className="guide-step-body">
            Each project carries a <b>north star</b> — one paragraph on what it's becoming — and
            <b> directives</b>, standing instructions injected at the start of every session, above
            everything else. Ideas on the Futures tab are judged against the north star (on course
            / tangent / off course) so the funnel curates itself. Write the steer once; every
            future session obeys it.
          </div>
        </div>

        <div className="guide-step">
          <div className="guide-step-title"><span className="n">✦</span> Moving fast</div>
          <div className="guide-step-body">
            <span className="mono">⌘K</span> searches everything — projects, bugs, roadmap, notes,
            activity — and jumps straight to the match. Any resume card exports a <b>brief</b>:
            curated markdown for handing a project's state to an agent anywhere. And{' '}
            <b>Connect</b> in the dashboard header walks through wiring a new machine or repo in —
            including running parallel lanes on one project.
          </div>
        </div>
      </div>

      <div className="modal-actions">
        <button className="btn-submit" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
