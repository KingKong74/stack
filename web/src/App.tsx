import { lazy, Suspense, useEffect, useState } from 'react';
import { useRoute } from './lib/route';
import { Dashboard } from './screens/Dashboard';
import { ProjectDetail } from './screens/ProjectDetail';
import { Settings } from './screens/Settings';
import { Timeline } from './screens/Timeline';

// xterm.js is heavy and only the terminal needs it — loaded on first visit.
const Terminal = lazy(() =>
  import('./screens/Terminal').then((m) => ({ default: m.Terminal })));
import { TokenGate } from './components/TokenGate';
import { Showcase } from './screens/Showcase';
import { CommandPalette } from './components/CommandPalette';
import { TermStatusPill } from './components/TermStatusPill';
import { getToken, onAuthChange, getThemePref, onThemeChange } from './store';

// Resolve the stored preference to a concrete theme on <html data-theme>.
// 'system' follows prefers-color-scheme live.
function applyTheme() {
  const pref = getThemePref();
  const dark = pref === 'dark'
    || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export default function App() {
  const route = useRoute();
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The terminal dock (#137/#139): once visited, the Terminal stays mounted for
  // the life of the tab — sessions, sockets and scrollback survive navigation.
  // Away from #/terminal it minimises to a bottom-right dock while sessions
  // are alive; `termAlive` (reported up by the Terminal) also quiets the
  // global presence pill so the corner isn't doubled up.
  const [termMounted, setTermMounted] = useState(false);
  const [termAlive, setTermAlive] = useState(0);
  useEffect(() => { if (route.name === 'terminal') setTermMounted(true); }, [route]);

  // Re-read the token whenever it changes (set on unlock, cleared on any 401).
  useEffect(() => onAuthChange(() => setTokenState(getToken())), []);

  // Theme: apply on boot, on preference change (Settings), and on OS change.
  useEffect(() => {
    applyTheme();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', applyTheme);
    const off = onThemeChange(applyTheme);
    return () => { media.removeEventListener('change', applyTheme); off(); };
  }, []);

  // Global ⌘K / Ctrl+K toggles the command palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The public showcase renders without the gate — it's read-only and carries
  // its own per-project key in the URL.
  if (route.name === 'share') return <Showcase slug={route.slug} token={route.token} />;

  if (!token) return <TokenGate />;

  return (
    <>
      {route.name === 'settings' ? (
        <Settings />
      ) : route.name === 'timeline' ? (
        <Timeline />
      ) : route.name === 'control' ? (
        <Settings initialTab="control" />
      ) : route.name === 'terminal' ? (
        null /* the persistent dock below renders it */
      ) : route.name === 'detail' ? (
        <ProjectDetail id={route.id} tab={route.tab} highlight={route.highlight} onOpenSearch={() => setPaletteOpen(true)} />
      ) : (
        <Dashboard onOpenSearch={() => setPaletteOpen(true)} />
      )}
      {termMounted && (
        <Suspense fallback={null}>
          <Terminal initialCwd={route.name === 'terminal' ? route.cwd : ''}
            visible={route.name === 'terminal'} onAlive={setTermAlive} />
        </Suspense>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <TermStatusPill hidden={route.name === 'terminal' || termAlive > 0} />
    </>
  );
}
