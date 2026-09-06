// THE QUALITY TAB IS A MOCKUP. It reads nothing and it writes nothing.
//
// `ui_kits/console/QualityScreen.jsx` ported to TS, on the kit's own sample
// rows (BUG-19 … BUG-31, 33 named checks, 7 features). It replaces
// `detail/Quality.tsx` (#278) — 1,391 lines that read `checks`, `bugs`,
// `check_runs` and `check_results` and drove all of them — at the owner's
// request, on the same terms as the board (#443), For you (#444) and the
// board's two newer tabs (#447): the kit's screen first, the wiring after.
//
// THIS ONE COSTS MORE THAN THE OTHER FOUR AND THE PRICE SHOULD BE READ BEFORE
// IT IS PAID AGAIN. Checks are Stack's ONLY automated regression net, and a
// green suite is the evidence #212 auto-merge and #263 auto-verdict spend. What
// went with the real screen:
//
//  • RUNNING A CHECK, ADDING ONE, EDITING ONE AND DELETING ONE have no surface
//    in any browser. `POST /projects/:slug/checks/run`, the CRUD routes and the
//    nightly all survive untouched — the suite still runs on its schedule and
//    the autopilot still spends its result — but a human cannot press ▶ on it
//    any more. `./stack` and the API are the way in.
//  • FILING A BUG AND MOVING ITS STATUS likewise, and with them the bug↔check
//    link (#278's own data change): a bug filed off a red check carried
//    `check_id`, and that report bar was the only path that ever set it.
//    KEEP AND DISMISS SURVIVE ELSEWHERE, unlike the held roadmap rows #444
//    stranded — the Dashboard's review deck still marks an extracted bug
//    reviewed or deletes it (`components/CommandDeck.tsx`), so a hook-filed bug
//    is not trapped. Its "open it in its tracker" link now lands here and
//    dead-ends on the kit's rows, exactly as the board's fourteen do.
//  • THE RUN LEDGER AND A CHECK'S HISTORY are unread. `check_runs` is still
//    written on every suite run, and `CHECK_HISTORY_KEEP` still trims
//    `check_results` — the ledger #212 and #263 spend against is intact and
//    invisible.
//  • THE NAV BADGE NO LONGER COUNTS RED CHECKS. It counts what THIS screen
//    shows (`QUALITY_ATTENTION` below), because a row's number and the screen
//    behind it have to agree or one of them is lying — the same call #444 made
//    on the Auto-ideas badge. So the rail can now read 2 while the real suite
//    is entirely green, or entirely red.
//  • `hl` ON THIS TAB WAS THE ONE HIGHLIGHT LEFT IN THE APP (lib/route.ts said
//    so: "only Quality still honours one — a bug key"). No tab honours one now.
//    Every deep link still RESOLVES and the highlight is ignored, exactly as
//    the board's and Activity's are.
//
// Everything below is the kit's own and all of it is local state: the three
// tabs, the severity filter, the feature folds, the area/Grouped-Flat controls,
// the two composers and the bug-area folds. Nothing persists — closing the tab
// is the undo. THE SEVERITY VOCABULARY IS THE KIT'S TOO (blocking · broken ·
// degraded · flaky · cosmetic) and it is NOT this app's `bugs.severity`
// (critical · high · medium · low) or a check's pass/fail; a wiring session
// owes a mapping decision, not a rename.

import { useState } from 'react';
import { KitIcon } from './kit/KitIcon';

type SevKey = 'blocking' | 'broken' | 'degraded' | 'flaky' | 'cosmetic';

// Rank orders the list and picks an area's worst; every COLOUR for a severity
// lives in styles.css under `.sev-<key>`, which sets four local custom
// properties (fg, bg, rule, dot) that the rows below read by role. That is the
// #444 rule — a component names the role, styles.css owns the tone — and it is
// why nothing here reaches for a `var(--red-500)`.
const SEVERITY: Record<SevKey, { label: string; rank: number }> = {
  blocking: { label: 'Blocking', rank: 1 },
  broken: { label: 'Broken', rank: 2 },
  degraded: { label: 'Degraded', rank: 3 },
  flaky: { label: 'Flaky', rank: 4 },
  cosmetic: { label: 'Cosmetic', rank: 5 },
};
const SEV_KEYS = Object.keys(SEVERITY) as SevKey[];

const RUNS = [4, 5, 3, 5, 4, 2, 5, 4, 5, 3, 5, 5, 4, 5, 2, 5, 4, 5, 5, 3, 5, 4, 5, 5, 2, 4, 3, 5, 4, 5];
const AMBER_AT = new Set([5, 14, 24, 26]);

const STATS: { v: string; l: string; good?: boolean; sev?: SevKey }[] = [
  { v: '57/59', l: 'passing' },
  { v: '0', l: 'blocking', good: true },
  { v: '2', l: 'broken or degraded', sev: 'broken' },
  { v: '4', l: 'flaky' },
  { v: '614ms', l: 'avg' },
];

type OpenItem = {
  name: string; severity: SevKey; detail: string; meta: string;
  bug: string | null; action: 'rerun' | 'quarantine' | 'write';
};

const OPEN: OpenItem[] = [
  { name: 'Bugs — collection', severity: 'broken', detail: '0.id missing from response',
    meta: 'read layer · failed 2 of 20 runs · 1h', bug: 'BUG-31', action: 'rerun' },
  { name: 'Bugs — bug→check link present', severity: 'degraded', detail: '0.checkId missing from response',
    meta: 'read layer · failed 2 of 20 runs · 1h', bug: 'BUG-30', action: 'rerun' },
  { name: 'Snapshot suite — token rename', severity: 'flaky', detail: 'passes on re-run with no code change',
    meta: 'tokens · flipped 10 times in 49 · 4h', bug: null, action: 'quarantine' },
  { name: 'Column header alignment drifts at 13px', severity: 'cosmetic', detail: 'reported by hand, no check covers it',
    meta: 'board · type · 2d', bug: 'BUG-29', action: 'write' },
];

// THE RAIL'S BADGE, and the reason it is exported rather than counted twice.
// It is the open items that are actually WRONG — blocking, broken or degraded —
// which is what the real badge meant (red checks + serious open bugs) and what
// its critical tone still claims. Flaky and cosmetic are noise at that tone.
export const QUALITY_ATTENTION = OPEN.filter((o) => SEVERITY[o.severity].rank <= 3).length;

const FEATURES: { name: string; checks: string; rate: number; avg: string; worst: SevKey | null }[] = [
  { name: 'A project and its collections', checks: '11/13', rate: 85, avg: '519ms', worst: 'broken' },
  { name: 'The read layer', checks: '15/15', rate: 100, avg: '556ms', worst: 'flaky' },
  { name: 'Mission Control', checks: '1/1', rate: 100, avg: '893ms', worst: null },
  { name: 'Settings', checks: '7/7', rate: 100, avg: '661ms', worst: null },
  { name: 'The agents', checks: '9/9', rate: 100, avg: '890ms', worst: null },
  { name: 'The automation spine', checks: '8/8', rate: 100, avg: '761ms', worst: null },
  { name: 'The front door', checks: '6/6', rate: 100, avg: '224ms', worst: 'cosmetic' },
];

type MockBug = {
  id: string; title: string; severity: SevKey; repro: string;
  cover: string | null; age: string;
};

const BUG_AREAS: { area: string; subjects: { subject: string; bugs: MockBug[] }[] }[] = [
  {
    area: 'Read layer',
    subjects: [
      {
        subject: 'Collection response',
        bugs: [
          { id: 'BUG-31', title: 'Response drops the id field', severity: 'broken', repro: 'Always', cover: 'Bugs — collection', age: '1h' },
          { id: 'BUG-30', title: 'checkId missing on linked bugs', severity: 'degraded', repro: 'Always', cover: 'Bugs — bug→check link', age: '1h' },
          { id: 'BUG-27', title: 'Empty collection returns 200 with no body', severity: 'cosmetic', repro: 'Sometimes', cover: null, age: '5d' },
        ],
      },
      {
        subject: 'Pagination',
        bugs: [
          { id: 'BUG-22', title: 'Cursor repeats the last row on page 2', severity: 'broken', repro: 'Always', cover: null, age: '12d' },
        ],
      },
    ],
  },
  {
    area: 'Board and stack',
    subjects: [
      {
        subject: 'Column headers',
        bugs: [
          { id: 'BUG-29', title: 'Alignment drifts at 13px', severity: 'cosmetic', repro: 'Always', cover: null, age: '2d' },
          { id: 'BUG-28', title: 'Count badge shifts when the menu opens', severity: 'cosmetic', repro: 'Always', cover: null, age: '2d' },
        ],
      },
      {
        subject: 'Card drag',
        bugs: [
          { id: 'BUG-19', title: 'Dropped card lands one column left at 1440px', severity: 'broken', repro: 'Sometimes', cover: 'Board — drop target', age: '8d' },
        ],
      },
    ],
  },
  {
    area: 'Print and export',
    subjects: [
      {
        subject: 'Print sheet',
        bugs: [
          { id: 'BUG-24', title: 'Last row clips on letter', severity: 'degraded', repro: 'Sometimes', cover: null, age: '9d' },
          { id: 'BUG-23', title: 'Header repeats twice on page 3', severity: 'cosmetic', repro: 'Always', cover: null, age: '9d' },
        ],
      },
    ],
  },
];

const ALL_BUGS = BUG_AREAS.flatMap((a) => a.subjects.flatMap((s) => s.bugs));
const worstOf = (bugs: MockBug[]): SevKey =>
  bugs.reduce<SevKey>((w, b) => (SEVERITY[b.severity].rank < SEVERITY[w].rank ? b.severity : w), 'cosmetic');

type MockCheck = {
  name: string; area: string; subject: string; assert: string;
  on: string; last: 'passed' | 'failed' | 'flaky'; ms: string; runs: string;
};
const mk = (name: string, area: string, subject: string, assert: string,
  on: string, last: MockCheck['last'], ms: string, runs: string): MockCheck =>
  ({ name, area, subject, assert, on, last, ms, runs });

const CHECKS: MockCheck[] = [
  mk('Bugs — collection', 'Read layer', 'Collection response', 'every row carries an id', 'push', 'failed', '519ms', '18/20'),
  mk('Bugs — bug→check link', 'Read layer', 'Collection response', 'checkId resolves to a check', 'push', 'failed', '544ms', '18/20'),
  mk('Bugs — single record', 'Read layer', 'Collection response', 'record matches its schema', 'push', 'passed', '486ms', '20/20'),
  mk('Bugs — empty collection', 'Read layer', 'Collection response', 'empty result returns an empty array', 'push', 'passed', '402ms', '20/20'),
  mk('Paging — first page', 'Read layer', 'Pagination', 'first page returns a cursor', 'push', 'passed', '511ms', '20/20'),
  mk('Paging — cursor advances', 'Read layer', 'Pagination', 'page 2 has no rows from page 1', 'push', 'passed', '567ms', '19/20'),
  mk('Paging — cursor expiry', 'Read layer', 'Pagination', 'a stale cursor is rejected', 'nightly', 'passed', '598ms', '20/20'),
  mk('Projects — list', 'Read layer', 'Projects', 'list is ordered by rank', 'push', 'passed', '478ms', '20/20'),
  mk('Projects — nested collections', 'Read layer', 'Projects', 'collections resolve under a project', 'push', 'passed', '622ms', '20/20'),

  mk('Board — drop target', 'Board and stack', 'Card drag', 'card lands in the column under the cursor', 'push', 'passed', '712ms', '20/20'),
  mk('Board — drag cancel', 'Board and stack', 'Card drag', 'escape returns the card to its column', 'push', 'passed', '655ms', '20/20'),
  mk('Board — WIP limit', 'Board and stack', 'Columns', 'a column refuses a pull past its limit', 'push', 'passed', '389ms', '20/20'),
  mk('Board — column reorder', 'Board and stack', 'Columns', 'order survives a reload', 'push', 'passed', '441ms', '20/20'),
  mk('Board — priority write-back', 'Board and stack', 'Priority picker', 'picking a grade persists it', 'push', 'passed', '366ms', '20/20'),
  mk('Board — composer submit', 'Board and stack', 'Composer', 'enter files the item into the column', 'push', 'passed', '398ms', '20/20'),
  mk('Board — keyboard walk', 'Board and stack', 'Keyboard', 'arrow keys move focus across columns', 'nightly', 'passed', '503ms', '20/20'),

  mk('Snapshot suite — tokens', 'Design system', 'Token layer', 'rendered output matches the stored snapshot', 'nightly', 'flaky', '3.1s', '39/49'),
  mk('Tokens — no orphan vars', 'Design system', 'Token layer', 'every var referenced is declared', 'push', 'passed', '112ms', '20/20'),
  mk('Tokens — contrast floor', 'Design system', 'Contrast', 'body text clears 4.5:1 on every surface', 'push', 'passed', '287ms', '20/20'),
  mk('Components — focus ring', 'Design system', 'Controls', 'every control shows a visible ring', 'push', 'passed', '344ms', '20/20'),
  mk('Components — hit target', 'Design system', 'Controls', 'no control is under 28px tall', 'push', 'passed', '301ms', '20/20'),

  mk('Plans — timeline dates', 'Plans', 'Timeline grid', 'a moved bar writes both dates', 'push', 'passed', '588ms', '20/20'),
  mk('Plans — status workflow', 'Plans', 'Timeline grid', 'only legal transitions are offered', 'push', 'passed', '412ms', '20/20'),
  mk('Plans — rollup maths', 'Plans', 'Progress', 'a parent equals the sum of its children', 'push', 'passed', '233ms', '20/20'),
  mk('Plans — calendar span', 'Plans', 'Calendar', 'a multi-day item renders on every day', 'nightly', 'passed', '676ms', '20/20'),
  mk('Plans — release contents', 'Plans', 'Releases', 'an item appears in exactly one release', 'push', 'passed', '349ms', '20/20'),

  mk('Quality — severity grading', 'Quality', 'Grading', 'only blocking renders red', 'push', 'passed', '198ms', '20/20'),
  mk('Quality — bug clustering', 'Quality', 'Grading', 'bugs group under their subject', 'push', 'passed', '221ms', '20/20'),
  mk('Quality — quarantine rule', 'Quality', 'Flake handling', 'a check red 3 in 20 leaves the suite', 'nightly', 'passed', '256ms', '20/20'),

  mk('Front door — cold load', 'The front door', 'First paint', 'first paint under 400ms', 'nightly', 'passed', '224ms', '20/20'),
  mk('Front door — auth redirect', 'The front door', 'Session', 'an expired session lands on sign-in', 'push', 'passed', '312ms', '20/20'),

  mk('Print — sheet geometry', 'Print and export', 'Print sheet', 'no row is clipped on letter or A4', 'nightly', 'passed', '891ms', '18/20'),
  mk('Print — repeated header', 'Print and export', 'Print sheet', 'the header prints once per page', 'nightly', 'passed', '764ms', '20/20'),
];

type QTab = 'overview' | 'checks' | 'bugs';

export function QualityMock() {
  const [tab, setTab] = useState<QTab>('overview');
  const [sev, setSev] = useState<SevKey | null>(null);
  const [openFeature, setOpenFeature] = useState<string | null>(null);
  const [composeCheck, setComposeCheck] = useState(false);
  const [composeBug, setComposeBug] = useState(false);

  const rows = (sev ? OPEN.filter((o) => o.severity === sev) : OPEN)
    .slice().sort((a, b) => SEVERITY[a.severity].rank - SEVERITY[b.severity].rank);

  return (
    <div className="ql">
      <div className="ql-head">
        <div className="ql-title">
          <h1>Quality</h1>
          <span className="lede">Usable — nothing blocking. Last full run 1h ago.</span>
        </div>
        <span className="ql-headacts">
          <button className="k-btn sm"><span className="ql-play">▸</span>Run all</button>
          {tab === 'bugs' ? (
            <button className="k-btn sm secondary" onClick={() => setComposeBug(true)}>
              <KitIcon name="plus" size={13} />Report a bug
            </button>
          ) : (
            <button className="k-btn sm secondary" onClick={() => { setTab('checks'); setComposeCheck(true); }}>
              <KitIcon name="plus" size={13} />New check
            </button>
          )}
        </span>
      </div>

      {/* One strip instead of five tiles: the five numbers read as a sentence
          left to right, and the sparkline is the same suite over 30 runs. */}
      <section className="ql-stats">
        {STATS.map((s) => (
          <span className="ql-stat" key={s.l}>
            <span className={`v${s.good ? ' good' : ''}${s.sev ? ` sev-${s.sev} sev-fg` : ''}`}>{s.v}</span>
            <span className="l">{s.l}</span>
          </span>
        ))}
        <span className="ql-spark">
          <span className="bars">
            {RUNS.map((h, i) => (
              <span key={i} className={`bar${AMBER_AT.has(i) ? ' amber' : ''}`} style={{ height: `${(h / 5) * 100}%` }} />
            ))}
          </span>
          <span className="cap">last 30 runs</span>
        </span>
      </section>

      <div className="k-tabs ql-tabs">
        {([
          { value: 'overview', label: 'Overview', n: OPEN.length },
          { value: 'checks', label: 'Checks', n: CHECKS.length },
          { value: 'bugs', label: 'Bugs', n: ALL_BUGS.length },
        ] as { value: QTab; label: string; n: number }[]).map((t) => (
          <button key={t.value} className={`k-tab${tab === t.value ? ' on' : ''}`} onClick={() => setTab(t.value)}>
            {t.label}<span className="n">{t.n}</span>
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <section className="ql-panel">
            <header className="ql-panelhead">
              <span className="t">Open items</span>
              <span className="ql-sevfilter">
                {SEV_KEYS.map((k) => {
                  const n = OPEN.filter((o) => o.severity === k).length;
                  if (!n) return null;
                  const on = sev === k;
                  return (
                    <button key={k} className={`ql-sevchip sev-${k}${on ? ' on' : ''}`}
                      aria-pressed={on} onClick={() => setSev(on ? null : k)}>
                      <span className="ql-dot" />
                      {SEVERITY[k].label}<span className="n">{n}</span>
                    </button>
                  );
                })}
              </span>
            </header>
            {rows.map((o) => <OpenRow key={o.name} item={o} />)}
          </section>

          <section className="ql-panel">
            <header className="ql-panelhead">
              <span className="t">By feature</span>
              <span className="sub">59 checks · 7 features</span>
            </header>
            {FEATURES.map((f) => (
              <FeatureRow key={f.name} feature={f}
                open={openFeature === f.name}
                onToggle={() => setOpenFeature(openFeature === f.name ? null : f.name)} />
            ))}
          </section>
        </>
      )}

      {tab === 'checks' && (
        <ChecksTab composing={composeCheck} onCompose={setComposeCheck} />
      )}

      {tab === 'bugs' && (
        <>
          {composeBug && <BugComposer onClose={() => setComposeBug(false)} />}
          <section className="ql-panel">
            <header className="ql-panelhead">
              <span className="t">Bugs</span>
              <span className="sub">{ALL_BUGS.length} open · {ALL_BUGS.filter((b) => !b.cover).length} uncovered</span>
            </header>
            {BUG_AREAS.map((a) => <BugArea key={a.area} area={a} />)}
          </section>
        </>
      )}
    </div>
  );
}

function SevTag({ severity }: { severity: SevKey }) {
  return (
    <span className={`ql-sevtag sev-${severity}`}>
      <span className="ql-dot" />{SEVERITY[severity].label}
    </span>
  );
}

const ACTION = { rerun: '▸ re-run', quarantine: 'quarantine', write: 'write a check' } as const;

function OpenRow({ item }: { item: OpenItem }) {
  return (
    <div className={`ql-openrow sev-${item.severity}`}>
      <span className="ql-dot" />
      <div className="mid">
        <span className="nm">{item.name}</span>
        <span className="sub">{item.detail} · {item.meta}</span>
      </div>
      {item.bug && <span className="bug">{item.bug}</span>}
      <span className="tag"><SevTag severity={item.severity} /></span>
      <button className={`ql-act${item.action === 'write' ? ' write' : ''}`}>{ACTION[item.action]}</button>
    </div>
  );
}

function FeatureRow({ feature, open, onToggle }: {
  feature: typeof FEATURES[number]; open: boolean; onToggle: () => void;
}) {
  return (
    <>
      <button className={`ql-frow${open ? ' open' : ''}`} onClick={onToggle} aria-expanded={open}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className={`ql-dot${feature.worst ? ` sev-${feature.worst}` : ' clean'}`} />
        <span className="nm">{feature.name}</span>
        <span className="meter">
          <span className={`track${feature.rate === 100 ? '' : ' part'}`}>
            <span className="fill" style={{ width: `${feature.rate}%` }} />
          </span>
        </span>
        <span className="n">{feature.checks}</span>
        <span className="avg">{feature.avg}</span>
        <span className="tag">
          {feature.worst ? <SevTag severity={feature.worst} /> : <span className="clean">clean</span>}
        </span>
      </button>
      {open && (
        <div className="ql-fbody">
          {[
            { name: 'collection', ok: !feature.worst || feature.worst === 'cosmetic' },
            { name: 'single record', ok: true },
            { name: 'link present', ok: !feature.worst },
          ].map((c) => (
            <div className="row" key={c.name}>
              <span className={`ico${c.ok ? ' ok' : ` sev-${feature.worst || 'broken'}`}`}>
                <KitIcon name={c.ok ? 'circle-check' : 'circle-alert'} size={12} />
              </span>
              <span className="nm">{feature.name} — {c.name}</span>
              <span className="avg">{feature.avg}</span>
              <button className="ql-act">▸ re-run</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ---------- Checks ---------- */

const LAST_TONE = { passed: 'pass', failed: 'fail', flaky: 'flake' } as const;

function ChecksTab({ composing, onCompose }: {
  composing: boolean; onCompose: (v: boolean) => void;
}) {
  const [area, setArea] = useState('All areas');
  const [grouped, setGrouped] = useState(true);
  const areas = ['All areas', ...Array.from(new Set(CHECKS.map((c) => c.area)))];
  const rows = area === 'All areas' ? CHECKS : CHECKS.filter((c) => c.area === area);
  const groups = Array.from(new Set(rows.map((c) => c.area)))
    .map((a) => ({ area: a, checks: rows.filter((c) => c.area === a) }));

  return (
    <div className="ql-checks">
      <div className="ql-checkbar">
        <span className="searchbox sm ql-search">
          <KitIcon name="search" size={14} />
          <input placeholder="Search checks" aria-label="Search checks" />
        </span>
        <select className="km-select sm ql-area" aria-label="Area" value={area} onChange={(e) => setArea(e.target.value)}>
          {areas.map((a) => <option key={a}>{a}</option>)}
        </select>
        <span className="ql-seg">
          {(['Grouped', 'Flat'] as const).map((m) => (
            <button key={m} className={`opt${(m === 'Grouped') === grouped ? ' on' : ''}`}
              onClick={() => setGrouped(m === 'Grouped')}>{m}</button>
          ))}
        </span>
        <span className="ql-checkcount">
          {rows.length} of {CHECKS.length} checks · {rows.filter((c) => c.on === 'nightly').length} nightly
        </span>
        {!composing && (
          <button className="k-btn sm secondary" onClick={() => onCompose(true)}>
            <KitIcon name="plus" size={13} />New check
          </button>
        )}
      </div>

      {composing && <CheckComposer onClose={() => onCompose(false)} />}

      <section className="ql-panel">
        <div className="ql-crowhead">
          <span className="c-check">Check</span>
          <span className="c-on">Runs on</span>
          <span className="c-last">Last</span>
          <span className="c-pass">Pass</span>
          <span className="c-time">Time</span>
          <span className="c-act" />
        </div>
        {grouped
          ? groups.map((g) => <CheckGroup key={g.area} group={g} />)
          : rows.map((c) => <CheckRow key={c.name} check={c} />)}
      </section>
    </div>
  );
}

function CheckGroup({ group }: { group: { area: string; checks: MockCheck[] } }) {
  const [open, setOpen] = useState(true);
  const bad = group.checks.filter((c) => c.last !== 'passed').length;
  return (
    <>
      <button className="ql-cgroup" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="nm">{group.area}</span>
        <span className="n">{group.checks.length}</span>
        <span className={`state${bad ? ' bad' : ''}`}>{bad ? `${bad} not passing` : 'all passing'}</span>
      </button>
      {open && group.checks.map((c) => <CheckRow key={c.name} check={c} />)}
    </>
  );
}

function CheckRow({ check }: { check: MockCheck }) {
  return (
    <div className="ql-crow">
      <span className="c-check">
        <span className="nm">{check.name}</span>
        <span className="sub">{check.area} · {check.subject} — asserts {check.assert}</span>
      </span>
      <span className="c-on">{check.on}</span>
      <span className={`c-last ${LAST_TONE[check.last]}`}>{check.last}</span>
      <span className="c-pass">{check.runs}</span>
      <span className="c-time">{check.ms}</span>
      <span className="c-act">
        <button className="ql-act">▸ run</button>
        <button className="ql-act edit">edit</button>
      </span>
    </div>
  );
}

/* ---------- the two composers ----------
   Both reuse the board dialog's own field classes (`km-field`, `km-input`,
   `km-select`): they are the kit's form row, and a second spelling of a label
   over a control is how two forms drift apart. */

function Composer({ title, submit, onClose, children }: {
  title: string; submit: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <section className="ql-composer">
      <span className="t">{title}</span>
      {children}
      <div className="foot">
        <button className="k-btn sm ghost" onClick={onClose}>Cancel</button>
        <button className="k-btn sm accent" onClick={onClose}>{submit}</button>
      </div>
    </section>
  );
}

function Field({ label, placeholder, hint }: { label: string; placeholder: string; hint?: string }) {
  return (
    <label className="km-field">
      <span className="lbl">{label}</span>
      <span className="searchbox km-input"><input placeholder={placeholder} /></span>
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

function Picker({ label, options }: { label: string; options: string[] }) {
  return (
    <label className="km-field">
      <span className="lbl">{label}</span>
      <select className="km-select" defaultValue={options[0]}>
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    </label>
  );
}

const AREAS = ['Read layer', 'Board and stack', 'Design system', 'Plans', 'Print and export'];

function CheckComposer({ onClose }: { onClose: () => void }) {
  return (
    <Composer title="New check" submit="Add and run" onClose={onClose}>
      <div className="ql-fields">
        <Field label="Name" placeholder="Bugs — collection carries an id" />
        <Field label="Asserts" placeholder="every row carries an id" />
        <Picker label="Area" options={AREAS} />
        <Field label="Subject" placeholder="Collection response" />
        <Picker label="Runs on" options={['push', 'nightly', 'manual']} />
        <Picker label="Grade a failure as" options={['Broken', 'Blocking', 'Degraded', 'Cosmetic']} />
      </div>
    </Composer>
  );
}

function BugComposer({ onClose }: { onClose: () => void }) {
  const [writeCheck, setWriteCheck] = useState(true);
  return (
    <Composer title="Report a bug" submit="File bug" onClose={onClose}>
      <div className="ql-fields">
        <Field label="What happened" placeholder="Response drops the id field" />
        <Picker label="Severity" options={['Blocking', 'Broken', 'Degraded', 'Flaky', 'Cosmetic']} />
        <Picker label="Area" options={AREAS} />
        <Field label="Subject" placeholder="Collection response" hint="Groups it with related bugs" />
        <Picker label="Reproducible" options={['Always', 'Sometimes', 'Once']} />
        <Field label="Tags" placeholder="api, paging" />
      </div>
      <label className="ql-checkbox">
        <input type="checkbox" checked={writeCheck} onChange={(e) => setWriteCheck(e.target.checked)} />
        Write a check that would have caught this
      </label>
    </Composer>
  );
}

/* ---------- Bugs ---------- */

function BugArea({ area }: { area: typeof BUG_AREAS[number] }) {
  const [open, setOpen] = useState(false);
  const bugs = area.subjects.flatMap((s) => s.bugs);
  const worst = worstOf(bugs);
  const uncovered = bugs.filter((b) => !b.cover).length;

  return (
    <>
      <button className={`ql-barea sev-${worst}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="nm">{area.area}</span>
        <span className="n">{bugs.length} in {area.subjects.length}</span>
        {uncovered > 0 && <span className="unc">{uncovered} uncovered</span>}
        <span className="tag"><SevTag severity={worst} /></span>
      </button>

      {open && area.subjects.map((sub) => (
        <div className="ql-subject-group" key={sub.subject}>
          <div className="ql-subject">
            <span className={`ql-dot sev-${worstOf(sub.bugs)}`} />
            <span className="nm">{sub.subject}</span>
            <span className="n">{sub.bugs.length}</span>
            <span className="rule" />
          </div>
          {sub.bugs.map((b) => <BugRow key={b.id} bug={b} />)}
        </div>
      ))}
    </>
  );
}

function BugRow({ bug }: { bug: MockBug }) {
  return (
    <div className="ql-brow">
      <span className="id">{bug.id}</span>
      <span className="t">{bug.title}</span>
      <span className="repro">{bug.repro.toLowerCase()}</span>
      <span className="tag"><SevTag severity={bug.severity} /></span>
      <span className="age">{bug.age}</span>
      <button className={`ql-act${bug.cover ? '' : ' write'}`}>{bug.cover ? '▸ retest' : 'write a check'}</button>
    </div>
  );
}
