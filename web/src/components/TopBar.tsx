import type { ReactNode } from 'react';
import { go } from '../lib/route';
import { PRODUCT_NAME } from '../lib/ui';

// THE HEADER, merged (#430). Six screens each drew their own topbar out of the
// same three or four pieces, in a different order, at a different height — so
// the app read as several apps stitched together. The console kit's TopBar is
// one bar with three slots (brand · search · actions) and that is the shape
// this takes, with Stack's breadcrumb folded in beside the brand rather than
// replacing it: the kit's bar names WHERE YOU ARE IN THE PRODUCT, Stack's
// crumb names where you are in your own work, and both are worth saying.
//
// The avatar is the kit's user chip doing Stack's job. Stack has no user
// model — one owner, one token — so a chip with someone's initials in it would
// be decoration claiming to be data. It carries the gear it actually does.

function TerminalMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function GearMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export type Crumb = { label: string; onClick?: () => void };

export function TopBar({ crumb, onSearch, searchLabel = 'Search…', actions, dash }: {
  /** Breadcrumb after the brand. The LAST entry is the current place. */
  crumb?: Crumb[];
  /** Opens ⌘K. Omitted on screens with nothing to search. */
  onSearch?: () => void;
  searchLabel?: string;
  /** Screen-specific buttons, left of the avatar. */
  actions?: ReactNode;
  dash?: boolean;
}) {
  return (
    <div className={`topbar${dash ? ' dash' : ''}`}>
      <a className="brandmark" href="#/" aria-label={`${PRODUCT_NAME} — all projects`}>
        <span className="sq"><TerminalMark /></span>
        <span className="word">{PRODUCT_NAME}</span>
      </a>

      {crumb && crumb.length > 0 && (
        <div className="crumb">
          {crumb.map((c, i) => {
            const last = i === crumb.length - 1;
            return (
              <span key={`${c.label}-${i}`} className="crumb-part">
                <span className="sep">/</span>
                {last
                  ? <span className="here">{c.label}</span>
                  : <span className="back" onClick={c.onClick}>{c.label}</span>}
              </span>
            );
          })}
        </div>
      )}

      {onSearch ? (
        <button className="searchbox as-button" onClick={onSearch}
          aria-label={`${searchLabel} (⌘K)`}>
          <span className="glass" />
          <span className="searchbox-label">{searchLabel}</span>
          <span className="kbd-hint">⌘K</span>
        </button>
      ) : <span className="topbar-gap" />}

      <div className="right">
        {actions}
        <button className="avatar" onClick={go.settings} aria-label="Settings"><GearMark /></button>
      </div>
    </div>
  );
}
