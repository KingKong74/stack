// THE STAR — one toggle for anything the Starred tab lists (a card, a note, a
// doc). It is the owner's shortlist, not priority: nothing that orders or runs
// work reads it (server/src/routes/starred.js says why). Starred draws filled
// in amber; unstarred is an outline that only takes colour on hover, so a row
// of stars does not shout.
//
// The caller owns the write (store.setStarred) and what to redraw after it; this
// only draws the state and says what a press will do.

import { KitIcon } from '../detail/kit/KitIcon';

export function StarButton({ on, onToggle, what, size = 14, className = '' }: {
  on: boolean; onToggle: () => void; what: string; size?: number; className?: string;
}) {
  const label = on ? `Unstar ${what}` : `Star ${what}`;
  return (
    <button type="button" className={`star-btn${on ? ' on' : ''} ${className}`.trim()} aria-pressed={on}
      aria-label={label} title={on ? 'Starred: in this project’s Starred list. Press to remove it.' : 'Star: keep it in this project’s Starred list'}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}>
      <KitIcon name="star" size={size} />
    </button>
  );
}

/** A small filled star for a face that is not the place to toggle it. */
export function StarMark({ size = 12 }: { size?: number }) {
  return <span className="star-mark" title="Starred" aria-label="Starred"><KitIcon name="star" size={size} /></span>;
}
