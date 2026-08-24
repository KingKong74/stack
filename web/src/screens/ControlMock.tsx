import { go } from '../lib/route';
import { PRODUCT_NAME } from '../lib/ui';

// Mission Control, culled and awaiting a rebuild.
//
// The seven rooms (Now, Merge, Nights, Plan, Review, Roles, Agents) and the
// `/api/control`, `/api/review` and `/api/merge` layers behind them are gone.
// What is left is this: the SHELL, drawn honestly as unfinished.
//
// Why a skeleton rather than a 404 or a redirect to the dashboard:
// `#/control` is linked from six screens' topbars and from live bookmarks, and
// a link that lands nowhere reads as a broken app rather than as a surface
// being rebuilt. The rail names the rooms that are coming back so the frame is
// legible; the panels are deliberately inert — nothing here fetches, so there
// is no state to mistake for real data. Same rule as a NULL `review_verdict`:
// absence must not be able to read as good news, so nothing is drawn in a
// colour that could pass for a status.
const ROOMS = ['Now', 'Merge', 'Nights', 'Plan', 'Review', 'Roles', 'Agents'];

// Bar widths (in %) per panel. Fixed rather than random so the page is stable
// across renders — a skeleton that reshuffles on every paint reads as loading.
const PANELS: { title: string; bars: number[] }[] = [
  { title: 'Fleet', bars: [72, 46] },
  { title: 'Tonight', bars: [88] },
  { title: 'Queue', bars: [54, 80, 38] },
  { title: 'Spend', bars: [63, 44] },
];

export function ControlMock() {
  return (
    <div>
      <div className="topbar">
        <div className="crumb">
          <span className="chev" onClick={go.dashboard}>‹</span>
          <span className="back" onClick={go.dashboard}>Projects</span>
          <span className="sep">/</span>
          <span className="here">Mission Control</span>
        </div>
        <div className="right">
          <div className="brandmark"><span className="sq" /><span className="word">{PRODUCT_NAME}</span></div>
        </div>
      </div>

      <div className="page detail">
        <div className="dash-head" style={{ marginBottom: 16 }}>
          <div>
            <div className="dash-title">
              Mission Control
              <span className="mcx-badge">being rebuilt</span>
            </div>
            <div className="dash-count">
              The rooms have been stripped out. This is the frame they will come back into.
            </div>
          </div>
        </div>

        {/* The rail names what is coming back. Spans, not anchors: none of
            these resolve yet, and a link that goes nowhere is worse than a
            label that never claimed to. */}
        <div className="mcx-rail" role="list" aria-label="Mission Control rooms — not yet rebuilt">
          {ROOMS.map((r) => (
            <span key={r} role="listitem" className="mcx-tab" aria-disabled="true">{r}</span>
          ))}
        </div>

        <div className="mcx-grid">
          {PANELS.map((p) => (
            <section key={p.title} className="mcx-panel" aria-hidden="true">
              <div className="mcx-panel-head">{p.title}</div>
              <div className="mcx-bars">
                {p.bars.map((w, i) => <span key={i} className="mcx-bar" style={{ width: `${w}%` }} />)}
              </div>
            </section>
          ))}
        </div>

        <div className="mcx-foot">
          Nothing on this screen reads from the API — the panels are placeholders, not empty results.
          <button className="band-link" onClick={go.dashboard}>← Back to the dashboard</button>
        </div>
      </div>
    </div>
  );
}
