import { useEffect, useState } from 'react';
import { useRoute, go } from '../lib/route';
import { Tips } from '../detail/Tips';

// The recipe library was a project tab, but it is app-wide — every project's
// tab showed the same recipes — and it sat in the tab strip taking a slot from
// work that IS per-project. It lives in the bottom-left corner instead: a quiet
// launcher on every screen that opens the library over whatever you were doing.
// ▶ Run still needs a project to open the session in, so the dock hands it the
// one you're looking at; from a screen that isn't a project the session just
// opens without a cwd.
export function TipsDock() {
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const slug = route.name === 'detail' ? route.id : undefined;

  // Old deep links (#/p/<slug>/tips — a bookmark, a ⌘K target from an older
  // server) still mean "open the library": honour them, then rewrite the hash
  // to the plain project so closing the sheet doesn't leave a dead tab in it.
  useEffect(() => {
    if (route.name === 'detail' && route.tab === 'tips') {
      setOpen(true);
      go.detail(route.id);
    }
  }, [route]);

  // Escape closes the sheet — but not while a modal is up over it (add/edit a
  // recipe, confirm a delete): that Escape belongs to the modal, and closing
  // both would throw away a half-written recipe.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.overlay')) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button className={`tips-dock ${open ? 'on' : ''}`} onClick={() => setOpen((o) => !o)}
        title="Recipes — the Claude prompt library" aria-label="Open the recipe library">
        <span className="glyph">✧</span>
        <span className="label">Recipes</span>
      </button>
      {open && (
        <>
          <div className="tips-scrim" onClick={() => setOpen(false)} />
          <div className="tips-sheet" role="dialog" aria-label="Recipe library">
            <Tips slug={slug} onClose={() => setOpen(false)} />
          </div>
        </>
      )}
    </>
  );
}
