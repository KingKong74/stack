import { useEffect, useState } from 'react';

export type Route =
  | { name: 'dashboard' }
  | { name: 'settings' }
  | { name: 'timeline' }
  | { name: 'control' }
  | { name: 'terminal'; cwd?: string; attach?: string }
  | { name: 'share'; slug: string; token: string }
  | { name: 'detail'; id: string; tab?: string; highlight?: string };

function parse(): Route {
  const h = window.location.hash.replace(/^#/, '');
  if (h === '/settings' || h.startsWith('/settings')) return { name: 'settings' };
  if (h === '/timeline' || h.startsWith('/timeline')) return { name: 'timeline' };
  if (h === '/control' || h.startsWith('/control')) return { name: 'control' };
  if (h.startsWith('/terminal')) {
    const params = new URLSearchParams(h.split('?')[1] || '');
    return { name: 'terminal', cwd: params.get('cwd') || undefined, attach: params.get('attach') || undefined };
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
  control: '#/control',
  settings: '#/settings',
  terminal: (cwd?: string, attach?: string) => {
    const q = [
      cwd ? `cwd=${encodeURIComponent(cwd)}` : '',
      attach ? `attach=${encodeURIComponent(attach)}` : '',
    ].filter(Boolean).join('&');
    return `#/terminal${q ? `?${q}` : ''}`;
  },
};

export const go = {
  dashboard: () => { window.location.hash = '#/'; },
  settings: () => { window.location.hash = '#/settings'; },
  timeline: () => { window.location.hash = '#/timeline'; },
  control: () => { window.location.hash = '#/control'; },
  // attach (a stack-term-* tmux name) jumps straight into that running claude
  // session — Mission Control's ▶ chips use it.
  terminal: (cwd?: string, attach?: string) => {
    window.location.hash = hrefTo.terminal(cwd, attach);
  },
  // tab picks which collection opens; highlight (when given) flags the matching
  // item/commit on that tab via the existing highlight mechanism. The tab
  // disambiguates what `highlight` means (commit hash, bug key, or row id).
  detail: (id: string, tab?: string, highlight?: string) => {
    const q = highlight ? `?hl=${encodeURIComponent(highlight)}` : '';
    window.location.hash = `#/p/${encodeURIComponent(id)}${tab ? `/${tab}` : ''}${q}`;
  },
};
