import { useEffect, useState } from 'react';

// #316 — Mission Control's rooms are part of the URL: `#/control/review` is a
// link straight to the Review room, so giving a verdict is one press from
// anywhere rather than Mission Control plus a tab hunt. `#/control` stays the
// canonical form of the default room, and an unrecognised room reads as the
// default rather than as a dead end — a link that outlives a renamed room
// should still land somewhere useful.
// ('build' was a room until its tab was removed; `#/control/build` now falls
// back to the default room, which is what the unknown-room rule is for.)
// #361 — 'agents' joins them: the three tab agents are controlled from their
// own room, so `#/control/agents` is the link to "why is the Auditor quiet".
// #363 — and 'merge': the house-wide branch ledger, so `#/control/merge` is
// the link to "what is waiting to land".
export const CONTROL_ROOMS = ['now', 'merge', 'nights', 'plan', 'review', 'roles', 'agents'] as const;
export type ControlRoom = (typeof CONTROL_ROOMS)[number];
export const isControlRoom = (v: unknown): v is ControlRoom =>
  typeof v === 'string' && (CONTROL_ROOMS as readonly string[]).includes(v);

export type Route =
  | { name: 'dashboard' }
  | { name: 'settings' }
  | { name: 'timeline' }
  | { name: 'control'; room?: ControlRoom }
  | { name: 'skills' }
  | { name: 'terminal'; cwd?: string; attach?: string; brief?: boolean }
  | { name: 'share'; slug: string; token: string }
  | { name: 'detail'; id: string; tab?: string; highlight?: string };

function parse(): Route {
  const h = window.location.hash.replace(/^#/, '');
  if (h === '/settings' || h.startsWith('/settings')) return { name: 'settings' };
  if (h === '/timeline' || h.startsWith('/timeline')) return { name: 'timeline' };
  if (h === '/control' || h.startsWith('/control')) {
    const room = h.split('?')[0].split('/')[2];
    return { name: 'control', room: isControlRoom(room) ? room : undefined };
  }
  // The skill tree (#228) — the managed Claude skill library.
  if (h === '/skills' || h.startsWith('/skills')) return { name: 'skills' };
  if (h.startsWith('/terminal')) {
    const params = new URLSearchParams(h.split('?')[1] || '');
    return {
      name: 'terminal',
      cwd: params.get('cwd') || undefined,
      attach: params.get('attach') || undefined,
      brief: params.get('brief') === '1' ? true : undefined,
    };
  }
  // The public showcase — rendered without the token gate (read-only, its own key).
  const s = h.match(/^\/share\/([^/]+)\/([^/?]+)/);
  if (s) return { name: 'share', slug: decodeURIComponent(s[1]), token: decodeURIComponent(s[2]) };
  const [pathPart, queryPart] = h.split('?');
  const m = pathPart.match(/^\/p\/([^/]+)(?:\/([^/]+))?/);
  if (m) {
    const params = new URLSearchParams(queryPart || '');
    const hl = params.get('hl');
    return { name: 'detail', id: decodeURIComponent(m[1]), tab: m[2], highlight: hl ? decodeURIComponent(hl) : undefined };
  }
  return { name: 'dashboard' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

// Href twins of go.* for anchor-based navigation: a real href lets
// middle/ctrl-click open a new tab, while a plain left click just changes the
// hash — which IS the router, so no onClick is needed for pure navigation.
export const hrefTo = {
  // A room other than the default is named in the path; the default room keeps
  // the bare '#/control' as its one canonical URL, so nothing has two spellings.
  control: (room?: ControlRoom) => (room && room !== 'now' ? `#/control/${room}` : '#/control'),
  settings: '#/settings',
  skills: '#/skills',
  terminal: (cwd?: string, attach?: string, brief?: boolean) => {
    const q = [
      cwd ? `cwd=${encodeURIComponent(cwd)}` : '',
      attach ? `attach=${encodeURIComponent(attach)}` : '',
      brief ? 'brief=1' : '',
    ].filter(Boolean).join('&');
    return `#/terminal${q ? `?${q}` : ''}`;
  },
  // tab picks which collection opens; highlight (when given) flags the matching
  // item/commit on that tab via the existing highlight mechanism. The tab
  // disambiguates what `highlight` means (commit hash, bug key, or row id).
  detail: (id: string, tab?: string, highlight?: string) => {
    const q = highlight ? `?hl=${encodeURIComponent(highlight)}` : '';
    return `#/p/${encodeURIComponent(id)}${tab ? `/${tab}` : ''}${q}`;
  },
};

export const go = {
  dashboard: () => { window.location.hash = '#/'; },
  settings: () => { window.location.hash = '#/settings'; },
  timeline: () => { window.location.hash = '#/timeline'; },
  // The argument is VALIDATED rather than trusted: several call sites pass this
  // straight to onClick, which would hand it a mouse event as the room.
  control: (room?: unknown) => {
    window.location.hash = hrefTo.control(isControlRoom(room) ? room : undefined);
  },
  skills: () => { window.location.hash = '#/skills'; },
  // attach (a stack-term-* tmux name) jumps straight into that running claude
  // session — Mission Control's ▶ chips use it.
  terminal: (cwd?: string, attach?: string, brief?: boolean) => {
    window.location.hash = hrefTo.terminal(cwd, attach, brief);
  },
  // tab picks which collection opens; highlight (when given) flags the matching
  // item/commit on that tab via the existing highlight mechanism. The tab
  // disambiguates what `highlight` means (commit hash, bug key, or row id).
  // workbench takes either a bare note id or f<futureId> for a Polaris idea.
  detail: (id: string, tab?: string, highlight?: string) => {
    window.location.hash = hrefTo.detail(id, tab, highlight);
  },
};
