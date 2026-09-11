import type { ReactNode } from 'react';
import { hrefTo } from '../lib/route';
import { Brandmark } from './Brandmark';

// THE HEADER, merged (#432). Six screens each drew their own topbar out of the
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

function GearMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// A CRUMB STEP IS A LINK, INCLUDING THE LAST ONE. Every step used to be
// a span with an onClick, so a middle click — the standard "open this
// elsewhere" gesture — did nothing at all, and neither did ⌘/ctrl-click. The
// browser only offers those on an anchor with a real href, so a step carrying
// one is drawn as an <a> and left click needs no handler: the href IS the hash,
// which IS the router. The LAST step gets one too, pointing at where you
// already are — on the project screen that means the tab you are on, which the
// hash does not otherwise carry (the rail switches tabs in state), so a new tab
// opens on the same reading rather than on the default one.
export type Crumb = { label: string; href?: string; onClick?: () => void };

export function TopBar({ crumb, onSearch, searchLabel = 'Search…', actions, dash, noAvatar }: {
  /** Breadcrumb after the brand. The LAST entry is the current place. */
  crumb?: Crumb[];
  /** Opens ⌘K. Omitted on screens with nothing to search. */
  onSearch?: () => void;
  searchLabel?: string;
  /** Screen-specific buttons, left of the avatar. */
  actions?: ReactNode;
  dash?: boolean;
  /** The public showcase: its reader is not signed in, so there is no
      Settings to send them to and no identity to represent. */
  noAvatar?: boolean;
}) {
  return (
    <div className={`topbar${dash ? ' dash' : ''}`}>
      {/* 24px is the smallest the mark keeps all three plates (Brandmark.tsx),
          which is why the bar's logo is that and not the 22px square it
          replaced — a topbar is where the logo is seen most and least often
          looked at, so it gets the full form. */}
      <Brandmark size={24} href="#/" />

      {crumb && crumb.length > 0 && (
        <div className="crumb">
          {crumb.map((c, i) => {
            const last = i === crumb.length - 1;
            return (
              <span key={`${c.label}-${i}`} className="crumb-part">
                <span className="sep">/</span>
                {c.href
                  ? <a className={last ? 'here' : 'back'} href={c.href} onClick={c.onClick}>{c.label}</a>
                  : last
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
        {!noAvatar && (
          <a className="avatar" href={hrefTo.settings} aria-label="Settings"><GearMark /></a>
        )}
      </div>
    </div>
  );
}
