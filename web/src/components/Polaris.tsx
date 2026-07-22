import { hrefTo } from '../lib/route';

// Polaris (#209 → #226) — once the Futures tab's inline expand panel, now an
// entry point: the session lives on its own screen, the planning studio
// (#/polaris/<slug>), with the live board panel beside the terminal. The tmux
// mapping is shared (keyed polaris:<slug>), so a session started from either
// entry re-attaches from the other.
export function Polaris({ slug }: { slug: string }) {
  return (
    <a className="polaris entry" href={hrefTo.polaris(slug)}>
      <span className="polaris-head">
        <span className="polaris-glyph">✦</span>
        <span className="polaris-name">Polaris</span>
        <span className="polaris-sub">planning studio — claude session with the live board beside it, on its own screen</span>
        <span className="chev">→</span>
      </span>
    </a>
  );
}
