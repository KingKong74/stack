import { Suspense, lazy, useState } from 'react';

// Polaris (#209) — the planning copilot pinned under the north star. Once a
// Gemini chat; now a REAL claude session over the host terminal daemon (the
// same transport as the Mission Control terminal — subscription, no external
// API). The head is the only thing in the main bundle: the terminal body
// (xterm.js) lazy-loads on first open and shares the Terminal screen's chunk.
// The session is grounded by the SessionStart hook (north star, roadmap,
// funnel, blockers land in its context automatically) and turns agreed work
// into roadmap items through the ordinary Stack API — manual source, so the
// overnight autopilot can pick it up the same night. Claude proposes in
// conversation; nothing lands without the human's yes.
const PolarisTerm = lazy(() => import('./PolarisTerm'));

export function Polaris({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`polaris ${open ? 'open' : ''}`}>
      <button className="polaris-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="polaris-glyph">✦</span>
        <span className="polaris-name">Polaris</span>
        <span className="polaris-sub">claude planning session — shape direction, land agreed work on the roadmap</span>
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <Suspense fallback={<div className="polaris-loading">loading terminal…</div>}>
          <PolarisTerm slug={slug} />
        </Suspense>
      )}
    </div>
  );
}
