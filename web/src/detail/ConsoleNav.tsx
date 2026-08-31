import type { ReactNode } from 'react';

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

export type NavKey = string;

export type NavSection = {
  label?: string;
  items: {
    key: NavKey;
    label: string;
    icon?: ReactNode;
    /** A number worth showing beside the label. 0 renders nothing. */
    count?: number;
    /** Draws the count in the critical tone — something is wrong, not just numerous. */
    bad?: boolean;
    depth?: number;
    onClick?: () => void;
    href?: string;
  }[];
};

export function ConsoleNav({ sections, active, footer }: {
  sections: NavSection[];
  active: NavKey;
  footer?: ReactNode;
}) {
  return (
    <nav className="con-nav" aria-label="Project sections">
      {sections.map((sec, i) => (
        <div className="con-navgroup" key={sec.label ?? `g${i}`}>
          {sec.label && <div className="con-seclabel">{sec.label}</div>}
          {sec.items.map((it) => {
            const on = it.key === active;
            const inner = (
              <>
                {it.icon && <span className="con-navico">{it.icon}</span>}
                <span className="con-navlabel">{it.label}</span>
                {it.count ? (
                  <span className={`con-navcount${it.bad ? ' bad' : ''}`}>{it.count}</span>
                ) : null}
              </>
            );
            const cls = `con-navitem${on ? ' on' : ''}${it.depth ? ' d1' : ''}`;
            // An anchor where there is a real URL, so middle-click still opens
            // a tab; a button where the move is state-only.
            return it.href
              ? <a key={it.key} className={cls} href={it.href} aria-current={on ? 'page' : undefined}>{inner}</a>
              : <button key={it.key} className={cls} onClick={it.onClick} aria-current={on ? 'page' : undefined}>{inner}</button>;
          })}
        </div>
      ))}
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
  clock: ico(<><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>),
  terminal: ico(<><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>),
};

/** The project dots in Spaces — a project's stored tint is its identity. */
export function SpaceDot({ tint }: { tint: string }) {
  return <span className="con-spacedot" style={{ background: tint }} />;
}
