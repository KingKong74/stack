import { useEffect, useState } from 'react';

// Mission Control was culled: `#/control` renders screens/ControlMock.tsx, the
// placeholder standing in for the rooms until they are rebuilt. The room
// segment and the `?hl=` row handoff went with them, but the PATH still parses
// with anything after `/control` ignored rather than 404ing — `#/control/review`
// and `#/control/nights` are in live bookmarks and in the topbars of six
// screens' worth of history, and landing them on the placeholder is what says
// "this is being rebuilt" instead of "this app is broken".
export type Route =
  | { name: 'dashboard' }
  | { name: 'settings' }
  | { name: 'timeline' }
  | { name: 'control' }
  | { name: 'skills' }
  | { name: 'terminal'; cwd?: string; attach?: string; brief?: boolean }
  | { name: 'share'; slug: string; token: string }
  | { name: 'detail'; id: string; tab?: string; highlight?: string };

// PARSING IS A PURE FUNCTION OF THE HASH, and reading `window` is the caller's
// job — the same injection `util.pushCadence` uses for `today`, and for the same
// reason: a router nothing can call without a browser is a router nothing tests,
// and every rule below (the legacy spellings that must not 404, what `hl` means,
// how a slug carrying a slash survives a round trip) is silent when it breaks.
// A dead link renders a page; it just renders the wrong one.
// `scripts/route.test.mjs` is the reader.
// A PATH SEGMENT IS DECODED DEFENSIVELY. `decodeURIComponent` THROWS on a
// malformed escape — a bare `%`, or `%zz` — and a throw in here escapes
// `useState(parse)` and blanks the whole app for that URL, with nothing on
// screen to say why. A URL is user input: `#/p/%/quality` is a typo, a
// truncated paste or a link a chat client mangled, and the right answer to all
// three is to render a project page for a slug that will simply not be found.
// Query values need no equivalent — URLSearchParams already decodes them, and
// tolerantly.
const seg = (v: string): string => {
  try { return decodeURIComponent(v); } catch { return v; }
};

export function parseHash(hash: string): Route {
  const h = String(hash || '').replace(/^#/, '');
  if (h === '/settings' || h.startsWith('/settings')) return { name: 'settings' };
  if (h === '/timeline' || h.startsWith('/timeline')) return { name: 'timeline' };
  if (h === '/control' || h.startsWith('/control')) return { name: 'control' };
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
  if (s) return { name: 'share', slug: seg(s[1]), token: seg(s[2]) };
  const [pathPart, queryPart] = h.split('?');
  const m = pathPart.match(/^\/p\/([^/]+)(?:\/([^/]+))?/);
  if (m) {
    const params = new URLSearchParams(queryPart || '');
    // `hl` IS DECODED ONCE, BY URLSearchParams, and must not be decoded again.
    // It was: `decodeURIComponent(params.get('hl'))`, which is a SECOND pass
    // over an already-decoded string. A highlight carrying a literal `%` not
    // followed by two hex digits then threw a URIError out of the router — out
    // of `useState(parse)`, i.e. a blank screen for that URL and nothing in the
    // UI to say why — and one carrying a real `%2F` came back with a slash it
    // never had. The slug on the line below is different and DOES need the
    // call: it comes off the PATH, which no URLSearchParams has touched.
    const hl = params.get('hl');
    return { name: 'detail', id: seg(m[1]), tab: m[2], highlight: hl || undefined };
  }
  return { name: 'dashboard' };
}

const parse = (): Route => parseHash(window.location.hash);

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
  dashboard: '#/',
  timeline: '#/timeline',
  control: '#/control',
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
  control: () => { window.location.hash = '#/control'; },
  skills: () => { window.location.hash = '#/skills'; },
  // attach (a stack-term-* tmux name) jumps straight into that running claude
  // session.
  terminal: (cwd?: string, attach?: string, brief?: boolean) => {
    window.location.hash = hrefTo.terminal(cwd, attach, brief);
  },
  // tab picks which collection opens; highlight (when given) flags the matching
  // item/commit on that tab via the existing highlight mechanism. The tab
  // disambiguates what `highlight` means (commit hash, bug key, or row id).
  detail: (id: string, tab?: string, highlight?: string) => {
    window.location.hash = hrefTo.detail(id, tab, highlight);
  },
};
