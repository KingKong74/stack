// THE FOR-YOU SCREEN IS A MOCKUP (#444). All three panes read nothing and write nothing.
//
// This is `ui_kits/console/ForYouScreen.jsx` ported to TS, on the kit's OWN
// sample rows (KING-18, king/col-virtualisation, AUTO-11…14). It is not a view
// of this project. What it replaced, at the owner's request:
//
//  • `detail/Overview.tsx` — the progression spine, the verdict queue, the
//    resume card, the three measured `pulse` bands, the north star, the
//    directives, the deployment and tech-stack editors.
//  • `detail/Activity.tsx` — the real per-push feed, with its Gemini notes and
//    its commit highlight.
//  • `detail/AutoIdeas.tsx` — the held queue and its ✓ Keep / ✕ Dismiss.
//
// WHAT THAT COST, stated once so nobody has to rediscover it:
//
//  • SIGNING OFF A HELD ROW HAS NO SURFACE ANYWHERE IN THE APP. Auto-ideas was
//    the last screen that could clear `reviewed_at` on a `hook` or `fly` row,
//    and dismissing one was the only way a browser could tombstone an extracted
//    fingerprint. The predicate is untouched (`lib/approval.ts`, and the two
//    copies it cannot import), so a held item is still held, still skipped
//    silently by an unattended enqueue and still refused out loud by ▶ Run now
//    — but nothing in a browser can now un-hold it. `./stack` and the API are
//    the way back, exactly as they are for the board's park/unpark.
//  • THE PULSE IS NO LONGER READ BY ANY SCREEN. `GET /projects/:slug/pulse`,
//    `pulse.js` and every partition it computes are all still there and still
//    tested; nothing fetches them. The numbers in the Model usage and Tests
//    panes below are the kit's, not this project's, and none of the rules those
//    bands enforced — spend is two populations, absent is not zero, a plan
//    night is not a failed run — is being enforced by anything on screen.
//  • THE NORTH STAR, THE DIRECTIVES, DEPLOYMENT and TECH STACK lost their
//    editors. `PATCH /projects/:slug` still takes all four and SessionStart
//    still injects the directives, so what is set stays set and only the
//    browser's way of changing it went.
//  • `hl` ON THE ACTIVITY TAB NAMES A COMMIT THIS SCREEN CANNOT DRAW. The route
//    still resolves (lib/route.ts) and the deep link still lands here; the
//    highlight is ignored rather than 404ing, same as the board's. Quality's
//    "open the commit that caught this" still crosses to this tab and now
//    dead-ends on the kit's feed — it was left pointing here on purpose rather
//    than quietly rewired, because where it should point instead is a decision.
//
// The interactions below are the kit's own and are all local state: the working
// copy's fold, the model list's open row and its Close. They persist nothing —
// leaving the tab is the undo. The three PANES are NOT state: each is its own
// route key and the strip in ProjectDetail writes it (see the Tab union there).

import { useState } from 'react';
import { KitIcon, type KitIconName } from './kit/KitIcon';

type Tone = 'info' | 'danger' | 'success' | 'warning' | 'neutral';

/* ---------- the kit's sample rows ---------- */

const RESUME = {
  title: 'Row recycling on scroll, mid-refactor',
  branch: 'king/col-virtualisation',
  base: 'main',
  behind: 4,
  id: 'KING-18',
  last: 'wip: recycle row nodes on scroll',
  ago: '17m',
  files: [
    { path: 'src/board/Column.tsx', add: 96, del: 8, state: 'modified' },
    { path: 'src/board/useVirtual.ts', add: 41, del: 0, state: 'new' },
    { path: 'src/board/Column.test.tsx', add: 11, del: 14, state: 'modified' },
  ],
  staged: 1,
  unstaged: 2,
  commits: [
    { sha: '4f2ac1d', msg: 'wip: recycle row nodes on scroll', ago: '17m' },
    { sha: '9be0742', msg: 'measure row height once per column', ago: '2h' },
    { sha: 'c14e5b8', msg: 'extract useVirtual from Column', ago: '3h' },
  ],
  checks: [
    { name: 'unit', state: 'passed', detail: '38 of 40 suites' },
    { name: 'typecheck', state: 'passed', detail: 'clean' },
    { name: 'snapshot', state: 'failed', detail: '2 failing on token rename' },
  ],
  next: 'Column.test.tsx still asserts the old node count.',
};

const PUSHES: { branch: string; commits: number; ago: string; ci: 'passed' | 'failed' | 'running'; note: string; add: number; del: number }[] = [
  { branch: 'king/col-virtualisation', commits: 3, ago: '17m', ci: 'running', note: 'draft PR #212', add: 148, del: 22 },
  { branch: 'king/token-split', commits: 6, ago: '4h', ci: 'failed', note: 'PR #211 · 2 checks failed', add: 302, del: 96 },
  { branch: 'main', commits: 1, ago: 'Mon', ci: 'passed', note: 'merged PR #209', add: 61, del: 340 },
];

const CI: Record<string, [Tone, KitIconName]> = {
  passed: ['success', 'circle-check'],
  failed: ['danger', 'circle-alert'],
  running: ['warning', 'clock'],
};

const USAGE = {
  scope: 'this project · last 12 weeks',
  stats: [
    { label: 'Sessions', value: '209', note: '92 autopilot runs beside them' },
    { label: 'Tokens', value: '2.8B', note: '2.3B by hand · 563.3M unattended' },
    { label: 'Median session', value: '26.0M', note: '40 delegations, 40 recorded' },
    { label: 'Spend', value: '$493', note: '80 of 92 runs priced · sessions carry no cost' },
  ],
  weeks: [
    { auto: 0, hand: 2 }, { auto: 0, hand: 3 }, { auto: 0, hand: 14 }, { auto: 0, hand: 3 },
    { auto: 8, hand: 12 }, { auto: 44, hand: 46 }, { auto: 14, hand: 52 }, { auto: 6, hand: 48 },
    { auto: 0, hand: 4 }, { auto: 0, hand: 9 }, { auto: 0, hand: 6 }, { auto: 0, hand: 2 },
  ],
  models: [
    {
      name: 'claude-opus-5', value: '2.2B', pct: 100, sessions: 46, runs: 48, share: '76.5%', cost: '$159', seen: '2026-08-31',
      ran: [
        { date: '08-31', text: 'Imported the console kit into the workspace design system, across 11 commits on main — all deployed and verified against the running app.' },
        { date: '08-30', text: 'Roadmap tab is now the board and Arrange is gone. Both commits on main and deployed.' },
        { date: '08-24', text: 'Culled, deployed and verified. Three commits, 93 files, ~22,700 lines removed.' },
        { date: '08-13', text: 'Both passes are in and verified against the deployed app; the assist route the Roadmap modal calls is unchanged.' },
      ],
    },
    {
      name: 'claude-sonnet-5', value: '298.4M', pct: 13, sessions: 92, runs: 118, share: '10.4%', cost: '$212', seen: '2026-09-02',
      ran: [
        { date: '09-02', text: 'Board column virtualisation — row recycling on scroll, six files touched, draft PR opened.' },
        { date: '09-01', text: 'Token files split by concern; snapshot tests updated in the same pass.' },
        { date: '08-28', text: 'Focus ring spec written and applied across the control set.' },
      ],
    },
    {
      name: 'claude-fable-5', value: '177.2M', pct: 8, sessions: 31, runs: 34, share: '6.2%', cost: '$61', seen: '2026-08-29',
      ran: [
        { date: '08-29', text: 'Drafted the lime accent usage rules and the surface stack guidance.' },
        { date: '08-22', text: 'Rewrote banner and hint copy to the two-line pattern.' },
      ],
    },
    {
      name: 'claude-sonnet-4-6', value: '116.7M', pct: 5, sessions: 28, runs: 28, share: '4.1%', cost: '$47', seen: '2026-08-19',
      ran: [{ date: '08-19', text: 'Legacy grey ramp replaced; 61 additions against 340 removals.' }],
    },
    {
      name: 'claude-haiku-4-5', value: '5.2M', pct: 1, sessions: 12, runs: 12, share: '0.2%', cost: '$14', seen: '2026-08-11',
      ran: [{ date: '08-11', text: 'Bulk rename of icon stems and a sweep of the asset index.' }],
    },
  ],
};

const GROUPS: { label: string; items: { icon: KitIconName; tone: Tone; title: string; meta: string[]; right: string; trail: string }[] }[] = [
  {
    label: 'Today',
    items: [
      { icon: 'git-branch', tone: 'info', title: 'Board column virtualisation', meta: ['branch', 'KING-18', 'draft PR #212'], right: '17m', trail: '+148 / −22' },
      { icon: 'circle-alert', tone: 'danger', title: 'Snapshot test failing on token rename', meta: ['check', 'KING-12', 'run 4481'], right: '41m', trail: '2 failed' },
      { icon: 'file-text', tone: 'neutral', title: 'Lime accent usage rules', meta: ['doc', 'design system'], right: '1h', trail: 'edited' },
      { icon: 'circle-check', tone: 'success', title: 'Focus ring spec', meta: ['issue', 'KING-09'], right: '3h', trail: 'closed' },
    ],
  },
  {
    label: 'Earlier this week',
    items: [
      { icon: 'code', tone: 'info', title: 'Replace legacy grey ramp', meta: ['PR #209', 'KING-12', 'merged'], right: 'Mon', trail: '+61 / −340' },
      { icon: 'bookmark', tone: 'neutral', title: 'Audit contrast on dark surfaces', meta: ['idea', 'KING-24'], right: 'Mon', trail: '' },
      { icon: 'terminal', tone: 'neutral', title: 'Split token files by concern', meta: ['idea', 'KING-31'], right: 'Sun', trail: '' },
    ],
  },
];

// TONE IS A CLASS, NEVER AN INLINE COLOUR (#432). The kit's screen carries its
// palette inline as `var(--status-*-fg)` lookups; this app's rule is that a
// colour is a token in styles.css and a component only names the ROLE.
const TVR: {
  title: string; chip: string; chipTone: Tone;
  rows: { label: string; value: string; tone: string; bar?: number; barTone?: string }[];
  note: string; link?: string;
}[] = [
  {
    title: 'Tests', chip: '2 failing', chipTone: 'danger',
    rows: [
      { label: 'Suite pass rate', value: '93.8%', tone: 'warning', bar: 93.8, barTone: 'warning' },
      { label: 'Checks failing now', value: '2', tone: 'danger' },
      { label: 'Median suite run', value: '3s', tone: 'plain' },
      { label: 'Flaky', value: '4', tone: 'warning' },
    ],
    note: 'Last suite: 57 of 59 passed, 88 runs in the window. ✧ Overview reads like a healthy deck that has flipped 10 times in its last 49.',
    link: 'Open Quality →',
  },
  {
    title: 'Verdicts', chip: 'moving', chipTone: 'neutral',
    rows: [
      { label: 'Awaiting your verdict', value: '1', tone: 'danger' },
      { label: 'Oldest moved', value: '3 days', tone: 'warning' },
      { label: 'Reviewed clean', value: '44', tone: 'success' },
      { label: 'Concerns / blocked', value: '0', tone: 'mono' },
      { label: 'No review ran', value: '48', tone: 'muted' },
    ],
    note: 'Every verdict here was given by a human. A NULL review is a pass that never ran, not a clean one.',
  },
  {
    title: 'Runs', chip: '92 runs', chipTone: 'success',
    rows: [
      { label: 'Landed', value: '72', tone: 'plain', bar: 78, barTone: 'success' },
      { label: 'Failed or hit a limit', value: '17', tone: 'danger' },
      { label: 'Ran, committed nothing', value: '1', tone: 'plain' },
      { label: 'Plan nights', value: '2', tone: 'plain' },
      { label: 'Land rate', value: '88%', tone: 'success' },
    ],
    note: '224 commits came out of those runs. Plan nights are excluded from the rate — they commit nothing by design, so counting them would score the advisor as having failed to land work nobody asked it to land.',
  },
];

const FEED: {
  day: string;
  events: { kind: 'push' | 'check' | 'pr' | 'merge' | 'tag'; branch: string; ago: string; text?: string; tone?: Tone; commits?: { sha: string; msg: string }[] }[];
}[] = [
  {
    day: 'Today · 2 September',
    events: [
      {
        kind: 'push', branch: 'king/col-virtualisation', ago: '17m', commits: [
          { sha: '4f2ac1d', msg: 'wip: recycle row nodes on scroll' },
          { sha: '9be0742', msg: 'measure row height once per column' },
          { sha: 'c14e5b8', msg: 'extract useVirtual from Column' },
        ],
      },
      { kind: 'check', branch: 'king/token-split', ago: '41m', text: 'Snapshot suite failed — 2 of 40 suites', tone: 'danger' },
      { kind: 'pr', branch: 'king/col-virtualisation', ago: '1h', text: 'Opened draft PR #212 · Board column virtualisation', tone: 'info' },
    ],
  },
  {
    day: 'Monday · 31 August',
    events: [
      { kind: 'merge', branch: 'main', ago: '', text: 'Merged PR #209 · Replace legacy grey ramp', tone: 'success' },
      {
        kind: 'push', branch: 'king/token-split', ago: '', commits: [
          { sha: 'a7d31f0', msg: 'split colors, type, spacing into separate files' },
          { sha: '2c88b45', msg: 'point styles.css at the new imports' },
        ],
      },
      { kind: 'tag', branch: 'main', ago: '', text: 'Tagged tokens-v1.4', tone: 'neutral' },
    ],
  },
  {
    day: 'Sunday · 30 August',
    events: [
      { kind: 'push', branch: 'king/print-styles', ago: '', commits: [{ sha: '5ea9c72', msg: 'first pass at print sheet geometry' }] },
    ],
  },
];

const KIND_ICON: Record<string, KitIconName> = {
  push: 'arrow-up-right', check: 'circle-alert', pr: 'code', merge: 'git-branch', tag: 'bookmark',
};

const AUTO: { id: string; title: string; confidence: 'high' | 'medium' | 'low'; why: string; source: string; when: string; signal: string }[] = [
  {
    id: 'AUTO-14', title: 'Extract the diff bar into a component', confidence: 'high',
    why: 'The same add/delete proportion bar was written three times in one session — working copy, pushes, tests.',
    source: 'claude-sonnet-5 · session 4f2ac1d', when: '17m ago', signal: 'repeated 3× in one session',
  },
  {
    id: 'AUTO-13', title: 'Snapshot tests need a token-rename codemod', confidence: 'high',
    why: 'Two of the last three failing runs were the same class of failure: renamed token, stale snapshot.',
    source: 'claude-opus-5 · run 4481', when: '41m ago', signal: '2 of last 3 failures',
  },
  {
    id: 'AUTO-12', title: 'king/print-styles is going stale', confidence: 'medium',
    why: 'No commits in 11 days and it now conflicts with the token split. Either rebase it or close it.',
    source: 'nightly branch sweep', when: '6h ago', signal: '11 days idle · conflicts',
  },
  {
    id: 'AUTO-11', title: 'Opus is doing work sonnet handles', confidence: 'low',
    why: 'Opus carried 76.5% of tokens but most of its runs were single-file edits under 200 lines.',
    source: 'usage rollup · last 12 weeks', when: 'Mon', signal: '$159 on small edits',
  },
];

const CONF: Record<string, Tone> = { high: 'success', medium: 'warning', low: 'neutral' };

/** What the For-you strip's Auto-ideas badge counts. A row's number and the
 *  screen behind it must agree or one of them is lying — so while this pane is
 *  the kit's rows, the badge counts the kit's rows. */
export const AUTO_IDEA_COUNT = AUTO.length;

export type ForYouPane = 'overview' | 'activity' | 'auto';

export function ForYouMock({ pane }: { pane: ForYouPane }) {
  if (pane === 'activity') return <ActivityPane />;
  if (pane === 'auto') return <AutoPane />;
  return <OverviewPane />;
}

/* ---------- Overview ---------- */

function OverviewPane() {
  return (
    <div className="fy">
      <WorkingCopy />
      <Pushes />
      <TestsVerdictsRuns />
      <ModelUsage />
      <div className="fy-block">
        <span className="fy-h">Your trail</span>
        <Trail />
      </div>
    </div>
  );
}

function WorkingCopy() {
  const [open, setOpen] = useState(false);
  const r = RESUME;
  const add = r.files.reduce((n, f) => n + f.add, 0);
  const del = r.files.reduce((n, f) => n + f.del, 0);

  return (
    <section className="fy-wc">
      <header className="fy-wc-head" onClick={() => setOpen(!open)}>
        <span className="fy-caret">{open ? '▾' : '▸'}</span>
        <div className="fy-wc-titles">
          <span className="fy-eyebrow accent">Where you left off · {r.ago} ago</span>
          <span className="t">{r.title}</span>
        </div>
        <span className="fy-wc-right">
          <span className="fy-branch"><KitIcon name="git-branch" size={13} />{r.branch}</span>
          <span className="fy-add">+{add}</span>
          <span className="fy-del">−{del}</span>
          <button className="k-btn accent sm" onClick={(e) => e.stopPropagation()}>
            <KitIcon name="code" size={14} />Resume
          </button>
        </span>
      </header>

      <div className="fy-wc-body">
        <div className="fy-wc-meta">
          <span className="fy-dim">← {r.base} · {r.behind} behind</span>
          <span className="k-tag mono">{r.id}</span>
          <span className="fy-dim staged"><KitIcon name="check" size={12} />{r.staged} staged · {r.unstaged} unstaged</span>
        </div>

        <div className="fy-files">
          {r.files.map((f) => {
            const total = Math.max(1, f.add + f.del);
            return (
              <div className="fy-file" key={f.path}>
                <span className={`st${f.state === 'new' ? ' new' : ''}`}>{f.state === 'new' ? 'A' : 'M'}</span>
                <span className="path">{f.path}</span>
                <span className="bar">
                  <span className="a" style={{ flex: f.add / total }} />
                  <span className="d" style={{ flex: f.del / total }} />
                </span>
                <span className="n">+{f.add} −{f.del}</span>
              </div>
            );
          })}
        </div>

        {open ? (
          <div className="fy-wc-grid">
            <div className="fy-col">
              <span className="fy-eyebrow">Commits on this branch</span>
              {r.commits.map((c) => (
                <div className="fy-commit" key={c.sha}>
                  <span className="sha">{c.sha}</span>
                  <span className="msg">{c.msg}</span>
                  <span className="ago">{c.ago}</span>
                </div>
              ))}
            </div>
            <div className="fy-col">
              <span className="fy-eyebrow">Checks</span>
              {r.checks.map((c) => (
                <div className="fy-check" key={c.name}>
                  <span className={`ico tone-${c.state === 'passed' ? 'success' : 'danger'}`}>
                    <KitIcon name={c.state === 'passed' ? 'circle-check' : 'circle-alert'} size={14} />
                  </span>
                  <span className="nm">{c.name}</span>
                  <span className="det">{c.detail}</span>
                </div>
              ))}
              <span className="fy-next">Next: {r.next}</span>
            </div>
          </div>
        ) : (
          <span className="fy-wc-last">{r.last}</span>
        )}
      </div>
    </section>
  );
}

function Pushes() {
  return (
    <section className="fy-panel">
      <header className="fy-panel-head">
        <span className="fy-eyebrow">Recent pushes</span>
        <button className="k-btn ghost sm">All branches<KitIcon name="arrow-up-right" size={13} /></button>
      </header>
      <div className="fy-panel-body">
        {PUSHES.map((p) => {
          const [tone, icon] = CI[p.ci];
          return (
            <div className="fy-push" key={p.branch}>
              <span className={`fy-chip tone-${tone}`}><KitIcon name={icon} size={13} /></span>
              <div className="fy-push-mid">
                <span className="br">{p.branch}</span>
                <span className="sub">{p.commits} commits · {p.note}</span>
              </div>
              <span className="fy-add">+{p.add}</span>
              <span className="fy-del">−{p.del}</span>
              <span className="fy-ago">{p.ago}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TestsVerdictsRuns() {
  return (
    <section className="fy-tvr">
      <div className="fy-tvr-head">
        <span className="fy-h">Tests, verdicts and runs</span>
        <span className="fy-dim">last 12 weeks</span>
      </div>
      <div className="fy-tvr-grid">
        {TVR.map((p) => (
          <div className="fy-tvr-panel" key={p.title}>
            <div className="fy-tvr-top">
              <span className="t">{p.title}</span>
              <span className={`fy-outline tone-${p.chipTone}`}>{p.chip}</span>
            </div>
            <div className="fy-kvs">
              {p.rows.map((r) => (
                <div className="fy-kvwrap" key={r.label}>
                  <div className="fy-kv">
                    <span className="k">{r.label}</span>
                    <span className={`v ${r.tone}`}>{r.value}</span>
                  </div>
                  {r.bar !== undefined && (
                    <span className="fy-bar">
                      <span className={`fill ${r.barTone}`} style={{ width: `${r.bar}%` }} />
                    </span>
                  )}
                </div>
              ))}
            </div>
            <span className="fy-note">{p.note}</span>
            {p.link && <span className="fy-link">{p.link}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}

function ModelUsage() {
  const [open, setOpen] = useState<string | null>('claude-opus-5');
  const openModel = USAGE.models.find((m) => m.name === open) || null;
  const MAX = 56;

  return (
    <section className="fy-usage">
      <div className="fy-tvr-head">
        <span className="fy-h">Model usage</span>
        <span className="fy-dim">{USAGE.scope}</span>
      </div>

      <div className="fy-stats">
        {USAGE.stats.map((st) => (
          <div className="fy-stat" key={st.label}>
            <span className="fy-eyebrow">{st.label}</span>
            <span className="num">{st.value}</span>
            <span className="note">{st.note}</span>
          </div>
        ))}
      </div>

      <div className="fy-usage-grid">
        <div className="fy-col">
          <div className="fy-weeks">
            {USAGE.weeks.map((w, i) => (
              <div className="fy-week" key={i}>
                <div className="up"><span className="auto" style={{ height: `${(w.auto / MAX) * 100}%` }} /></div>
                <span className="axis" />
                <div className="dn"><span className="hand" style={{ height: `${(w.hand / MAX) * 100}%` }} /></div>
              </div>
            ))}
          </div>
          <div className="fy-weeks-legend">
            <span>12 weeks ago</span>
            <span className="mid">tokens per week · unattended above, by hand below</span>
            <span className="now">this week</span>
          </div>
        </div>

        <div className="fy-col">
          <span className="fy-eyebrow">By model · open one</span>
          {USAGE.models.map((m) => {
            const on = open === m.name;
            return (
              <button key={m.name} className={`fy-model${on ? ' on' : ''}`} onClick={() => setOpen(on ? null : m.name)}>
                <span className="row">
                  <span className="fy-caret">{on ? '▾' : '▸'}</span>
                  <span className="nm">{m.name}</span>
                  <span className="val">{m.value}</span>
                </span>
                <span className="fy-model-bar" style={{ width: `${m.pct}%` }} />
              </button>
            );
          })}
        </div>
      </div>

      {openModel && (
        <div className="fy-mdetail">
          <div className="fy-mdetail-head">
            <span className="nm">{openModel.name}</span>
            <span className="fy-dim">{openModel.sessions} sessions · {openModel.runs} runs</span>
            <button className="fy-close" onClick={() => setOpen(null)}>Close</button>
          </div>
          <div className="fy-mdetail-grid">
            <div className="fy-mtiles">
              {[
                { label: 'Tokens', value: openModel.value },
                { label: 'Share', value: openModel.share },
                { label: 'Cost', value: openModel.cost },
                { label: 'Last seen', value: openModel.seen },
              ].map((t) => (
                <div className="fy-mtile" key={t.label}>
                  <span className="fy-eyebrow">{t.label}</span>
                  <span className="v">{t.value}</span>
                </div>
              ))}
            </div>
            <div className="fy-col">
              <span className="fy-eyebrow">Where it ran</span>
              {openModel.ran.map((r) => (
                <div className="fy-ran" key={r.date + r.text}>
                  <span className="d">{r.date}</span>
                  <span className="t">{r.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Trail() {
  return (
    <div className="fy-trail">
      <span className="searchbox sm fy-filter">
        <KitIcon name="search" size={14} />
        <input placeholder="Filter your trail" aria-label="Filter your trail" />
      </span>
      {GROUPS.map((g) => (
        <div className="fy-trailgroup" key={g.label}>
          <span className="fy-dim">{g.label}</span>
          {g.items.map((it) => (
            <div className="fy-trow" key={it.title}>
              <span className={`fy-chip lg tone-${it.tone}`}><KitIcon name={it.icon} size={14} /></span>
              <div className="mid">
                <span className="t">{it.title}</span>
                <span className="meta">{it.meta.join('  ·  ')}</span>
              </div>
              {it.trail && <span className="trail">{it.trail}</span>}
              <span className="fy-ago">{it.right}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ---------- Activity ---------- */

function ActivityPane() {
  return (
    <div className="fy-feed">
      {FEED.map((g) => (
        <div className="fy-day" key={g.day}>
          <span className="fy-dim">{g.day}</span>
          {g.events.map((e, i) => {
            const isPush = e.kind === 'push';
            const tone: Tone = isPush ? 'info' : (e.tone || 'neutral');
            return (
              <div className="fy-event" key={i}>
                <span className={`fy-chip tone-${tone}`}><KitIcon name={KIND_ICON[e.kind]} size={13} /></span>
                <div className="mid">
                  <div className="top">
                    <span className="t">{isPush ? `Pushed ${e.commits?.length} commits to` : e.text}</span>
                    <span className={isPush ? 'br' : 'br dim'}>{e.branch}</span>
                    {e.ago && <span className="fy-ago">{e.ago}</span>}
                  </div>
                  {isPush && (
                    <div className="fy-col tight">
                      {e.commits?.map((c) => (
                        <div className="fy-commit" key={c.sha}>
                          <span className="sha">{c.sha}</span>
                          <span className="msg">{c.msg}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ---------- Auto-ideas ---------- */
// The rows reuse the `.ai-*` classes the real queue wore, because the kit's row
// and Stack's were already the same shape: what it is, what it says, where it
// came from, and the two answers. Keep and Dismiss are drawn and inert — the
// header says what that cost.

function AutoPane() {
  return (
    <div className="ai">
      <div className="ai-lede">
        Lifted from your last 30 sessions. Accepting one files it into Ideas.
      </div>
      {AUTO.map((a) => (
        <div className="ai-row" key={a.id}>
          <span className={`ai-ico tone-${CONF[a.confidence]}`}><KitIcon name="terminal" size={13} /></span>
          <div className="ai-body">
            <div className="ai-top">
              <span className="ai-title">{a.title}</span>
              <span className="ai-when">{a.when}</span>
            </div>
            <p className="ai-why">{a.why}</p>
            <div className="ai-meta">
              <span className="ai-src">{a.source}</span>
              <span className="ai-signal">{a.signal}</span>
              <span className={`k-tag ${CONF[a.confidence]}`}>{a.confidence} confidence</span>
            </div>
          </div>
          <div className="ai-acts">
            <button className="k-btn secondary sm"><KitIcon name="plus" size={13} />Keep</button>
            <button className="k-btn ghost sm">Dismiss</button>
          </div>
        </div>
      ))}
    </div>
  );
}
