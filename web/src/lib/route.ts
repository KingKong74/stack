import { useEffect, useState } from 'react';

export type Route =
  | { name: 'dashboard' }
  | { name: 'settings' }
  | { name: 'share'; slug: string; token: string }
  | { name: 'detail'; id: string; tab?: string; highlight?: string };

function parse(): Route {
  const h = window.location.hash.replace(/^#/, '');
  if (h === '/settings' || h.startsWith('/settings')) return { name: 'settings' };
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

export const go = {
  dashboard: () => { window.location.hash = '#/'; },
  settings: () => { window.location.hash = '#/settings'; },
  // tab picks which collection opens; highlight (when given) flags the matching
  // item/commit on that tab via the existing highlight mechanism. The tab
  // disambiguates what `highlight` means (commit hash, bug key, or row id).
  detail: (id: string, tab?: string, highlight?: string) => {
    const q = highlight ? `?hl=${encodeURIComponent(highlight)}` : '';
    window.location.hash = `#/p/${encodeURIComponent(id)}${tab ? `/${tab}` : ''}${q}`;
  },
};
