import { useEffect, useState } from 'react';

export type Route = { name: 'dashboard' } | { name: 'detail'; id: string; tab?: string };

function parse(): Route {
  const h = window.location.hash.replace(/^#/, '');
  const m = h.match(/^\/p\/([^/]+)(?:\/([^/]+))?/);
  if (m) return { name: 'detail', id: decodeURIComponent(m[1]), tab: m[2] };
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
  detail: (id: string, tab?: string) => {
    window.location.hash = `#/p/${encodeURIComponent(id)}${tab ? `/${tab}` : ''}`;
  },
};
