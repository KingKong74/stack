// The kit's Icon, as inline SVG (components/media/Icon.jsx + assets/icons/*).
//
// The kit's own component FETCHES each `assets/icons/<name>.svg` at render and
// injects it. That cannot come across: this app ships one bundle behind nginx
// with no icon directory to fetch from, and an icon that arrives one round trip
// after the card it sits in is a card that visibly reflows. So the paths are
// inlined here, verbatim from the Lucide sources the kit copied, and the only
// two edits are the ones the kit's own loader makes anyway — `width`/`height`
// become the caller's size, and `stroke` stays `currentColor` so an icon
// inherits the tone of whatever it sits in.
//
// ADD AN ICON BY COPYING ITS PATHS, never by reaching for a font or a sprite:
// the whole reason these are inline is that they take a colour from CSS and
// cost no request.

import type { CSSProperties, ReactNode } from 'react';

export type KitIconName =
  | 'plus' | 'users' | 'list-filter' | 'layers' | 'search' | 'layout-grid'
  | 'list' | 'ellipsis' | 'circle-check' | 'bookmark' | 'calendar'
  | 'arrow-up-right' | 'pencil' | 'trash-2'
  | 'git-branch' | 'circle-alert' | 'file-text' | 'code' | 'terminal'
  | 'clock' | 'check';

const PATHS: Record<KitIconName, ReactNode> = {
  plus: <><path d="M5 12h14" /><path d="M12 5v14" /></>,
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <path d="M16 3.128a4 4 0 0 1 0 7.744" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <circle cx="9" cy="7" r="4" />
    </>
  ),
  'list-filter': <><path d="M2 5h20" /><path d="M6 12h12" /><path d="M9 19h6" /></>,
  layers: (
    <>
      <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
      <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
      <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
    </>
  ),
  search: <><path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /></>,
  'layout-grid': (
    <>
      <rect width="7" height="7" x="3" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="14" rx="1" />
      <rect width="7" height="7" x="3" y="14" rx="1" />
    </>
  ),
  list: (
    <>
      <path d="M3 5h.01" /><path d="M3 12h.01" /><path d="M3 19h.01" />
      <path d="M8 5h13" /><path d="M8 12h13" /><path d="M8 19h13" />
    </>
  ),
  ellipsis: <><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>,
  'circle-check': <><circle cx="12" cy="12" r="10" /><path d="m16 9-5.5 5.5L8 12" /></>,
  bookmark: <path d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z" />,
  calendar: (
    <>
      <path d="M8 2v3" /><path d="M16 2v3" />
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
    </>
  ),
  'arrow-up-right': <><path d="M7 7h10v10" /><path d="M7 17 17 7" /></>,
  pencil: (
    <>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </>
  ),
  'trash-2': (
    <>
      <path d="M10 11v6" /><path d="M14 11v6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
  'git-branch': (
    <>
      <path d="M15 6a9 9 0 0 0-9 9V3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
    </>
  ),
  'circle-alert': (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </>
  ),
  'file-text': (
    <>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" />
    </>
  ),
  code: <><path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" /></>,
  terminal: <><path d="M12 19h8" /><path d="m4 17 6-6-6-6" /></>,
  clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
};

export function KitIcon({ name, size = 16, style }: {
  name: KitIconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden="true" focusable="false"
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block', flex: '0 0 auto', ...style }}
    >
      {PATHS[name]}
    </svg>
  );
}
