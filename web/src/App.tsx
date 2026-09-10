import { lazy, Suspense, useEffect, useState } from 'react';
import { useRoute } from './lib/route';
import { Dashboard } from './screens/Dashboard';
import { ProjectDetail } from './screens/ProjectDetail';
import { Settings } from './screens/Settings';
import { ControlMock } from './screens/ControlMock';
import { Timeline } from './screens/Timeline';

// xterm.js is heavy and only the terminal needs it — loaded on first visit.
const Terminal = lazy(() =>
  import('./screens/Terminal').then((m) => ({ default: m.Terminal })));
// The skill tree (#228): its own screen, lazy — it is a place you go to
// change how Claude works, not something every page load needs in the bundle.
const Skills = lazy(() => import('./screens/Skills'));
import { TokenGate } from './components/TokenGate';
import { Showcase } from './screens/Showcase';
import { CommandPalette } from './components/CommandPalette';
import { ToTop } from './components/ToTop';
import { getToken, onAuthChange } from './store';

// The app is DARK-ONLY: the imported console kit ships one palette and no
// light counterpart, so there is no preference to resolve, no attribute to
// stamp and no listener to keep. styles.css states each colour once.


export default function App() {
  const route = useRoute();
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The terminal dock (#137): once visited, the Terminal stays mounted for the
  // life of the tab — sessions, sockets and scrollback survive navigation.
  // Away from #/terminal it is hidden outright (#492 removed the floating
  // panel and its corner chip), so the global presence pill is what says a
  // session is still alive.
  const [termMounted, setTermMounted] = useState(false);
  useEffect(() => { if (route.name === 'terminal') setTermMounted(true); }, [route]);

  // Re-read the token whenever it changes (set on unlock, cleared on any 401).
  useEffect(() => onAuthChange(() => setTokenState(getToken())), []);

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
        <ControlMock />
      ) : route.name === 'terminal' ? (
        null /* the persistent dock below renders it */
      ) : route.name === 'skills' ? (
        <Suspense fallback={null}><Skills /></Suspense>
      ) : route.name === 'detail' ? (
        <ProjectDetail id={route.id} tab={route.tab} highlight={route.highlight} onOpenSearch={() => setPaletteOpen(true)} />
      ) : (
        <Dashboard onOpenSearch={() => setPaletteOpen(true)} />
      )}
      {termMounted && (
        <Suspense fallback={null}>
          <Terminal initialCwd={route.name === 'terminal' ? route.cwd : ''}
            initialAttach={route.name === 'terminal' ? route.attach : undefined}
            initialBrief={route.name === 'terminal' ? route.brief : undefined}
            visible={route.name === 'terminal'} />
        </Suspense>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {route.name !== 'terminal' && <ToTop />}
    </>
  );
}
