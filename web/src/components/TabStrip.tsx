// THE KIT'S TAB STRIP (Claude Design project 7ff15c0c, ui_kits/console).
//
// An underline strip, not a pill row: it names sub-views INSIDE one screen,
// and the rail already carries the pills that move you between screens. Two
// pill rows on one page and neither one reads as the outer of the two.
//
// A count is part of a tab's identity here — "Auto-ideas 3" is what makes the
// tab worth pressing — so it sits in the tab, not in a badge floated over it.
// Zero renders nothing, the same rule the rail's counts follow: a grey 0 reads
// as "this is empty" when what it means is "there is nothing waiting".

// A MOCK CHIP RIDES ON THE TAB, not on the screen (#482, #496). Where a tab
// strip covers a part-wired screen, the chip has to say WHICH sub-view is the
// kit's rows — one over the whole screen warns about the panes it is wrong for,
// and these mockups look exactly like the real thing.
export type StripTab<K extends string> = { key: K; label: string; count?: number; mock?: boolean };

export function TabStrip<K extends string>({ tabs, active, onPick, right }: {
  tabs: StripTab<K>[];
  active: K;
  onPick: (key: K) => void;
  /** Anything that belongs on the strip's line rather than under it. */
  right?: React.ReactNode;
}) {
  return (
    <div className="k-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={t.key === active}
          className={`k-tab${t.key === active ? ' on' : ''}`}
          onClick={() => onPick(t.key)}>
          {t.label}
          {t.count ? <span className="n">{t.count}</span> : null}
          {t.mock && (
            <span className="con-navsoon mock"
              title="A mockup — the console kit's own sample rows. It reads and writes nothing.">Mock</span>
          )}
        </button>
      ))}
      {right && <span className="k-tabs-right">{right}</span>}
    </div>
  );
}
