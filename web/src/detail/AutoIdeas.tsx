import type { ReviewEntry } from './Overview';

// AUTO-IDEAS — the kit's third For-you tab, on Stack's own data.
//
// The kit describes it as "suggestions the agent lifted out of session
// transcripts … accepting one files it into Ideas", and Stack already has
// exactly that population and has had it for longer: a roadmap item or bug the
// push extractor read off a commit (`source:'hook'`), or one a live session
// opened for its own work (`source:'fly'`, #381). Both are HELD from the
// overnight runner until a human keeps them — `lib/approval.ts` is the rule —
// so this tab is not a new idea, it is the review inbox finally given the room
// the Overview band could not spare it.
//
// WHY IT LEFT THE OVERVIEW. As a band it was capped at four rows with "N more
// waiting" under it, and the only way to reach the fifth was to keep one of the
// first four. A queue you cannot see all of is a queue you approve blind.
//
// EACH ROW SAYS WHERE IT CAME FROM, which is the kit's point about a suggestion
// being a judgement rather than a guess: what it is, what it says, which origin
// held it, and when. Keep and Dismiss are the two answers, and Dismiss is drawn
// as the destructive one it is — for a hook row it TOMBSTONES the fingerprint,
// so the next push cannot re-create it, and that is why it has no undo.

const ORIGIN_NOTE: Record<string, string> = {
  hook: 'read off a push by the extractor',
  fly: 'opened by a live session for its own work',
};

export function AutoIdeas({ queue, onKeep, onDismiss }: {
  queue: ReviewEntry[];
  onKeep: (e: ReviewEntry) => void;
  onDismiss: (e: ReviewEntry) => void;
}) {
  if (queue.length === 0) {
    return (
      <div className="ai-empty">
        <div className="h">Nothing waiting</div>
        <p>
          Items the push extractor lifts out of a commit, and cards a live session opens for its own
          work, land here first — they are held from the overnight runner until you keep one.
          Nothing is held right now.
        </p>
      </div>
    );
  }

  return (
    <div className="ai">
      <div className="ai-lede">
        Lifted from your pushes and your sessions. Each one is <strong>held from the overnight
        runner</strong> until you keep it; dismissing a push-extracted row also stops the next push
        re-creating it.
      </div>

      {queue.map((e) => (
        <div className={`ai-row ${e.kind}`} key={`${e.kind}:${e.key}`}>
          <span className="ai-ico" aria-hidden="true">{e.kind === 'bug' ? '⚠' : '✦'}</span>

          <div className="ai-body">
            <div className="ai-top">
              <span className="ai-title">{e.title}</span>
              {e.when && <span className="ai-when">{e.when}</span>}
            </div>

            {e.note && <p className="ai-why">{e.note}</p>}

            <div className="ai-meta">
              <span className="ai-src">{e.kind === 'bug' ? e.key : `roadmap #${e.key}`}</span>
              <span className="ai-signal">{e.meta}</span>
              {e.origin && (
                <span className={`ai-origin ${e.origin}`} title={ORIGIN_NOTE[e.origin] || ''}>
                  {e.origin}
                </span>
              )}
            </div>
          </div>

          <div className="ai-acts">
            <button className="ai-keep" onClick={() => onKeep(e)}
              title="Keep — signs it off, and the overnight runner may pick it up">
              ✓ Keep
            </button>
            <button className="ai-dismiss" onClick={() => onDismiss(e)}
              title={e.origin === 'hook'
                ? 'Dismiss — deletes it and tombstones the fingerprint, so the next push cannot re-create it. No undo.'
                : 'Dismiss — deletes it. No undo.'}>
              ✕ Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
