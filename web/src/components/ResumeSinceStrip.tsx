import type { ResumeSince } from '../types';
import { go } from '../lib/route';

// The gap between the resume card's TIMESTAMP and its CONTENT, stated.
//
// The card's summary and three sub-lists are written only by an authored
// /checkpoint; `last_session_at` moves on every push, the SessionEnd metadata
// backstop included. So a night of sessions that ended without /checkpoint —
// reaped by the idle reaper, stopped on the usage limit, or just closed — left
// the card wearing a fresh time over days-old content, and the night read as
// "nothing happened" while its pushes sat in the activity feed.
//
// This band goes ABOVE the checkpoint content, because the newest push is the
// fresher fact. It renders nothing when the card is current (since = null), so
// a project that checkpoints every session never sees it.
//
// IT IS DELIBERATELY SMALL. It used to be a head row, a paragraph and a
// two-line explanation — three blocks of chrome in front of the thing you came
// to read. The warning is the same size as the fact it carries now: one dense
// line, the session's own sign-off clamped, and the "run /checkpoint" advice as
// a title rather than a third block. Shrinking it is not hiding it — the label
// is still the first accent-coloured thing on the page.
export function ResumeSinceStrip({ since, slug }: { since: ResumeSince | null | undefined; slug: string }) {
  if (!since) return null;
  const { authoredWhen, count, hash, branch, when, summary } = since;
  return (
    <div className="resume-since"
      title={authoredWhen
        ? 'The checkpoint below has not moved. This is the latest session’s own sign-off — run /checkpoint to make it the card.'
        : 'Nothing has authored a checkpoint here yet, so this is the latest session’s own sign-off rather than a written resume point.'}>
      <div className="rs-head">
        <span className="rs-lbl">Since that checkpoint</span>
        <span className="rs-n">
          {authoredWhen
            ? `${count} push${count === 1 ? '' : 'es'} · checkpoint ${authoredWhen}`
            : 'no checkpoint on record'}
        </span>
        {hash && (
          <button className="rs-open" onClick={() => go.detail(slug, 'activity', hash)}
            title="Open this push in the activity feed">
            {hash} · {branch} · {when} <span className="arr">→</span>
          </button>
        )}
      </div>
      {summary && <div className="rs-sum">{summary}</div>}
    </div>
  );
}
