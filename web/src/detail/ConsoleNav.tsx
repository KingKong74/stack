import { useState, type ReactNode } from 'react';
import { getNavFolded, setNavFolded } from '../store';
import { MoreMenu, type MenuOption } from '../components/MoreMenu';

// THE CONSOLE'S LEFT RAIL (#432) — the kit's AppShell nav, carrying Stack's
// own two levels.
//
// It replaces the horizontal tab strip, and the reason is not decoration: the
// strip could hold four labels and a count each before it ran out of width, so
// every OTHER way into the project (the other apps, the host surfaces) had to
// live in the header or in a menu. A rail has room to say what the strip could
// only imply — that a project's four readings and the other projects beside it
// are the same kind of move.
//
// SPACES ARE PROJECTS. The kit's "Spaces" section lists workspaces; Stack's
// equivalent is the apps themselves, so switching project is one click from
// inside a project rather than a trip back to the dashboard.
//
// A SECTION FOLDS FROM ITS LABEL, which is why an unlabelled section cannot
// fold: the label IS the affordance, and a bare chevron over a headingless run
// of rows names nothing. The fold is CSS, not conditional rendering, because
// the narrow layout lays the rail down into a row and hides the labels — with
// the items unmounted there would be no way to bring back a section folded on
// a wide screen, so the media query simply shows them again.
//
// A `soon` row is a PLACEHOLDER: it is announced but not a link and not a
// button, because a row that takes a click and then does nothing reads as a
// broken app. It says "Soon" on its face rather than only in a tooltip.
//
// THE ⋯ IS A SIBLING OF THE ROW, never inside it: the row is itself a button
// or an anchor, and a button nested in either is invalid and unreachable by
// keyboard. Its slot is reserved in the row's padding whether or not it is
// showing, so appearing on hover moves nothing.

export type NavKey = string;

export type NavSection = {
  /** Stable id — what the folded-shut list is stored against. */
  id: string;
  label?: string;
  items: {
    key: NavKey;
    label: string;
    icon?: ReactNode;
    /** A number worth showing beside the label. 0 renders nothing. */
    count?: number;
    /** Draws the count in the critical tone — something is wrong, not just numerous. */
    bad?: boolean;
    /** Announced but not built yet: shown, tagged, and inert. */
    soon?: boolean;
    /** What the row's ⋯ offers. Absent or empty draws no ⋯ at all. */
    menu?: MenuOption[];
    depth?: number;
    onClick?: () => void;
    href?: string;
  }[];
};

function Chevron() {
  return (
    <svg className="con-secchev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function ConsoleNav({ sections, active, footer }: {
  sections: NavSection[];
  active: NavKey;
  footer?: ReactNode;
}) {
  const [folded, setFolded] = useState<string[]>(getNavFolded);
  const toggle = (id: string) => {
    const next = folded.includes(id) ? folded.filter((f) => f !== id) : [...folded, id];
    setFolded(next);
    setNavFolded(next);
  };

  return (
    <nav className="con-nav" aria-label="Project sections">
      {sections.map((sec) => {
        const shut = !!sec.label && folded.includes(sec.id);
        return (
          <div className={`con-navgroup${shut ? ' shut' : ''}`} key={sec.id}>
            {sec.label && (
              <button className="con-seclabel" onClick={() => toggle(sec.id)}
                aria-expanded={!shut} aria-controls={`nav-${sec.id}`}>
                <Chevron />
                <span>{sec.label}</span>
              </button>
            )}
            <div className="con-navitems" id={`nav-${sec.id}`}>
              {sec.items.map((it) => {
                const on = it.key === active;
                const inner = (
                  <>
                    {it.icon && <span className="con-navico">{it.icon}</span>}
                    <span className="con-navlabel">{it.label}</span>
                    {it.soon ? <span className="con-navsoon">Soon</span> : null}
                    {it.count ? (
                      <span className={`con-navcount${it.bad ? ' bad' : ''}`}>{it.count}</span>
                    ) : null}
                  </>
                );
                const cls = `con-navitem${on ? ' on' : ''}${it.depth ? ' d1' : ''}${it.soon ? ' soon' : ''}`;
                if (it.soon) return <div key={it.key} className={cls}>{inner}</div>;
                // An anchor where there is a real URL, so middle-click still opens
                // a tab; a button where the move is state-only.
                const row = it.href
                  ? <a className={cls} href={it.href} aria-current={on ? 'page' : undefined}>{inner}</a>
                  : <button className={cls} onClick={it.onClick} aria-current={on ? 'page' : undefined}>{inner}</button>;
                return (
                  <div className="con-navrow" key={it.key}>
                    {row}
                    {it.menu && it.menu.length > 0 && (
                      <MoreMenu options={it.menu} small btnClass="con-navmore" label={`${it.label} — more`} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {footer && <div className="con-navfoot">{footer}</div>}
    </nav>
  );
}

/** The rail's icons — the kit's set, inlined so no request can fail to arrive. */
const ico = (d: ReactNode) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);

export const NavIcons = {
  layers: ico(<><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 17 9 5 9-5" /><path d="m3 12 9 5 9-5" /></>),
  check: ico(<><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></>),
  grid: ico(<><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></>),
  board: ico(<><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="M15 3v11" /></>),
  clock: ico(<><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>),
  terminal: ico(<><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>),
  route: ico(<><circle cx="6" cy="19" r="3" /><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" /><circle cx="18" cy="5" r="3" /></>),
  map: ico(<><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.618v10.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 17.382V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0Z" /><path d="M15 5.764v15" /><path d="M9 3.236v15" /></>),
  sparkle: ico(<><path d="M12 3v4" /><path d="M12 17v4" /><path d="M3 12h4" /><path d="M17 12h4" /><path d="m6.3 6.3 2.8 2.8" /><path d="m14.9 14.9 2.8 2.8" /><path d="m17.7 6.3-2.8 2.8" /><path d="m9.1 14.9-2.8 2.8" /></>),
  star: ico(<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />),
};

/** The project dots in Spaces — a project's stored tint is its identity. */
export function SpaceDot({ tint }: { tint: string }) {
  return <span className="con-spacedot" style={{ background: tint }} />;
}
