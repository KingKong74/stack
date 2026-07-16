import { lazy, Suspense, useEffect, useState } from 'react';
import { useRoute } from './lib/route';
import { Dashboard } from './screens/Dashboard';
import { ProjectDetail } from './screens/ProjectDetail';
import { Settings } from './screens/Settings';
import { Timeline } from './screens/Timeline';
import { Control } from './screens/Control';

// xterm.js is heavy and only the terminal needs it — loaded on first visit.
const Terminal = lazy(() =>
  import('./screens/Terminal').then((m) => ({ default: m.Terminal })));
import { TokenGate } from './components/TokenGate';
import { Showcase } from './screens/Showcase';
import { CommandPalette } from './components/CommandPalette';
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
        <Control />
      ) : route.name === 'terminal' ? (
        <Suspense fallback={null}><Terminal initialCwd={route.cwd} /></Suspense>
      ) : route.name === 'detail' ? (
        <ProjectDetail id={route.id} tab={route.tab} highlight={route.highlight} onOpenSearch={() => setPaletteOpen(true)} />
      ) : (
        <Dashboard onOpenSearch={() => setPaletteOpen(true)} />
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}
