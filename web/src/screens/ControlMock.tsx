// MISSION CONTROL IS A MOCKUP. It reads nothing and it writes nothing.
//
// `ui_kits/console/mission-control.html` → `MissionControlScreen.jsx` ported to
// TS, on the kit's OWN sample fleet (Implementer/Reviewer/Sweeper/Advisor/Bug
// triager, four providers, six loops, seven connections, six context files).
// It is not a view of this installation. It replaces the CULLED-SKELETON
// placeholder that stood at `#/control` — the seven rooms (Now, Merge, Nights,
// Plan, Review, Roles, Agents) and `/api/control`, `/api/review`, `/api/merge`
// went long before this, and the skeleton was the honest frame drawn over the
// hole. This is the seventh kit port, on the same terms as the other six
// (#443, #444, #447, #450, #451, #453): the kit's screen first, the wiring
// after.
//
// THE KIT'S SEVEN TABS ARE NOT STACK'S SEVEN ROOMS, and a wiring session owes a
// MAPPING DECISION rather than a rename. What each tab would have to be wired
// to, and the trap in each:
//
//  • OVERVIEW is `autopilot_runs` — but the kit's "Runs today / landed / failed"
//    strip is THREE of the four buckets a night partitions into. `planned` and
//    `noCommits` are the other two and they are not failures: a plan night is
//    the advisor working, and folding it back into a land rate scores the
//    advisor as having failed to land runs nobody asked it to land. `pulse.js`
//    spells the partition out; the kit's four numbers cannot hold it.
//  • AGENTS is TWO tables that must not be merged. `agent_profiles` holds only
//    OVERRIDES on the built-ins in `server/src/agent-profiles.js`, while
//    `agent_configs` holds what the owner tunes on the REGISTERED agents in
//    `src/agents.js` — and an agent's `ops` list is CODE, not data. The kit's
//    "Can do" chips read exactly like an editable capability list; they are the
//    one thing on this screen that must never become one.
//  • MODELS is the settings row (`autopilotExecutorModel` /
//    `autopilotAdvisorModel`, inverted by #285) plus two populations of spend
//    that MUST NOT BE MIXED: `autopilot_runs` answers to the executor/advisor
//    policy, `sessions.model_usage` is the human's own interactive work and a
//    model picked by hand is not drift. The kit draws one share bar over
//    everything. Any merged share has to be token-based.
//  • CONTEXT IS THE ONE TAB THAT IS NOT SAFE TO WIRE AS DRAWN. It is the
//    managed CLAUDE.md library, and that surface was culled for cause: Stack
//    used to write each repo's CLAUDE.md from its own copy every five minutes,
//    the sync was authoritative by design, and a stale DB copy silently
//    reverted this very file for several sessions running. A repo's CLAUDE.md
//    is the repo's. The kit's Edit/Save button is a WRITE BACK INTO THAT
//    SHAPE — if anything here starts writing a CLAUDE.md again it needs an off
//    switch before it gets a schedule.
//  • LOOPS is the cron dispatcher, the nightly and the `autopilotEnabled` arm
//    switch. The kit gives every loop its own toggle; Stack has ONE arm switch
//    and three gates deciding who runs (the fleet cap, per-project
//    serialisation, the area lane), and per-project cannot become a knob.
//  • CONNECTIONS is `geminiReady`, `terminal.connected` and the provider keys
//    `terminal/model-switch.mjs` resolves. The fail-safe direction is the trap:
//    with no host daemon on the line the honest answer is "Stack cannot see",
//    never a green card — the kit has a tone for Offline and Degraded and no
//    tone at all for UNKNOWN, which is the NULL-verdict lie in card form.
//  • SETTINGS duplicates `#/settings`, which is real and wired. Two rows of it
//    have no counterpart at all (revoke every key, delete 209 transcripts) and
//    both are destructive; the fail-safe rules say an automation that destroys
//    does nothing when it cannot reach the API, and neither of these has been
//    thought through in those terms yet.
//
// WHAT THE PLACEHOLDER'S OWN RULE COST, now that this replaces it: the skeleton
// deliberately used NO semantic tone, because a skeleton must not be able to
// read as a status. This screen is full of tones — green pills, an amber
// progress bar, a red danger zone — and every one of them is the kit's sample
// data. Nothing on this page is a fact about this installation. That is why the
// header says MOCKUP in the one place a reader cannot miss it.
//
// The kit's page chrome is NOT ported. Its standalone HTML ships its own top
// bar with a search box, a New project button and a three-number status strip
// (2 agents live · 6 loops armed · $38 today); this app has one TopBar of its
// own, and the strip would have been a second copy of the three numbers the
// screen's own header and pulse already state — two places to drift.
//
// Every interaction below is the kit's and all of it is local state: the tab,
// the agent and provider folds, the context selection and its editor, the loop
// switches and the four guardrail switches. Nothing persists — leaving the page
// is the undo.

import { useState, type ReactNode } from 'react';
import { go } from '../lib/route';
import { TopBar } from '../components/TopBar';
import { KitIcon, type KitIconName } from '../detail/kit/KitIcon';

type Tone = 'info' | 'warning' | 'success' | 'danger' | 'neutral';
type McTab = 'overview' | 'agents' | 'models' | 'context' | 'loops' | 'connections' | 'settings';

const TABS: { value: McTab; label: string; icon: KitIconName; n?: number }[] = [
  { value: 'overview', label: 'Overview', icon: 'chart-no-axes-column' },
  { value: 'agents', label: 'Agents', icon: 'users', n: 5 },
  { value: 'models', label: 'Models', icon: 'terminal', n: 9 },
  { value: 'context', label: 'Context', icon: 'file-text', n: 6 },
  { value: 'loops', label: 'Loops', icon: 'clock', n: 6 },
  { value: 'connections', label: 'Connections', icon: 'git-branch', n: 7 },
  { value: 'settings', label: 'Settings', icon: 'settings' },
];

/* ---------- overview ---------- */

const PULSE: { label: string; value: string; note: string; accent?: boolean }[] = [
  { label: 'Runs today', value: '14', note: '12 landed · 1 failed · 1 no-op' },
  { label: 'Spend today', value: '$38', note: '$493 in the last 30 days', accent: true },
  { label: 'Tokens today', value: '84.2M', note: '2.8B all time' },
  { label: 'Loops firing', value: '6', note: '2 paused by you' },
];

const LIVE: { agent: string; model: string; task: string; phase: string; pct: number; tone: Tone;
  elapsed: string; tokens: string; cost: string }[] = [
  { agent: 'Implementer', model: 'claude-sonnet-5', task: 'Row recycling on scroll', phase: 'writing tests',
    pct: 62, tone: 'warning', elapsed: '4m 12s', tokens: '1.8M', cost: '$2.40' },
  { agent: 'Reviewer', model: 'claude-opus-5', task: 'PR #211 — token split', phase: 'reading diff',
    pct: 28, tone: 'info', elapsed: '1m 03s', tokens: '620K', cost: '$1.10' },
];

const RECENT: { agent: string; model: string; task: string; result: string; tone: Tone;
  commits: number; cost: string; dur: string }[] = [
  { agent: 'Implementer', model: 'claude-sonnet-5', task: 'Extract the diff bar', result: 'landed', tone: 'success', commits: 3, cost: '$1.80', dur: '6m' },
  { agent: 'Sweeper', model: 'claude-haiku-4-5', task: 'Nightly branch sweep', result: 'landed', tone: 'success', commits: 0, cost: '$0.12', dur: '48s' },
  { agent: 'Implementer', model: 'claude-opus-5', task: 'Print sheet geometry', result: 'hit a limit', tone: 'warning', commits: 1, cost: '$4.20', dur: '18m' },
  { agent: 'Advisor', model: 'claude-fable-5', task: 'Draft plan for KING-24', result: 'no commits', tone: 'neutral', commits: 0, cost: '$0.60', dur: '2m' },
];

/* ---------- agents ---------- */

const AGENTS: { name: string; role: string; model: string; fallback: string; autonomy: string;
  runs: number; land: string; spend: string; state: string; tone: Tone; caps: string[] }[] = [
  { name: 'Implementer', role: 'Writes and lands code against one work item',
    model: 'claude-sonnet-5', fallback: 'claude-opus-5', autonomy: 'Plan then run',
    runs: 118, land: '88%', spend: '$212', state: 'Running', tone: 'warning',
    caps: ['read repo', 'write branch', 'run checks', 'open PR'] },
  { name: 'Reviewer', role: 'Reads a diff and gives a verdict, never commits',
    model: 'claude-opus-5', fallback: '—', autonomy: 'Read only',
    runs: 46, land: 'n/a', spend: '$159', state: 'Running', tone: 'warning',
    caps: ['read repo', 'read PR', 'comment'] },
  { name: 'Sweeper', role: 'Housekeeping — stale branches, dead files, orphan tokens',
    model: 'claude-haiku-4-5', fallback: '—', autonomy: 'Auto',
    runs: 92, land: '96%', spend: '$14', state: 'Idle', tone: 'neutral',
    caps: ['read repo', 'write branch', 'delete files'] },
  { name: 'Advisor', role: 'Drafts plans and never touches the working copy',
    model: 'claude-fable-5', fallback: 'claude-sonnet-5', autonomy: 'Read only',
    runs: 34, land: 'n/a', spend: '$61', state: 'Idle', tone: 'neutral',
    caps: ['read repo', 'read history'] },
  { name: 'Bug triager', role: 'Grades incoming bugs and proposes a covering check',
    model: 'gpt-5.2', fallback: 'claude-sonnet-5', autonomy: 'Suggest only',
    runs: 28, land: 'n/a', spend: '$18', state: 'Paused', tone: 'info',
    caps: ['read repo', 'write bug', 'propose check'] },
];

/* ---------- models ---------- */

const PROVIDERS: { name: string; state: string; tone: Tone; key: string; latency: string; share: number;
  models: { id: string; ctx: string; use: string; cost: string; p: string; pick: string | null }[] }[] = [
  { name: 'Anthropic', state: 'Connected', tone: 'success', key: 'sk-ant-…7f2c', latency: '410ms', share: 91,
    models: [
      { id: 'claude-opus-5', ctx: '500K', use: '2.2B', cost: '$159', p: '$8 / $34', pick: 'Reviewer' },
      { id: 'claude-sonnet-5', ctx: '500K', use: '298.4M', cost: '$212', p: '$3 / $15', pick: 'Implementer' },
      { id: 'claude-fable-5', ctx: '200K', use: '177.2M', cost: '$61', p: '$2 / $10', pick: 'Advisor' },
      { id: 'claude-sonnet-4-6', ctx: '200K', use: '116.7M', cost: '$47', p: '$3 / $15', pick: null },
      { id: 'claude-haiku-4-5', ctx: '200K', use: '5.2M', cost: '$14', p: '$0.80 / $4', pick: 'Sweeper' },
    ] },
  { name: 'OpenAI', state: 'Connected', tone: 'success', key: 'sk-proj-…91ab', latency: '520ms', share: 6,
    models: [
      { id: 'gpt-5.2', ctx: '400K', use: '61.4M', cost: '$18', p: '$4 / $16', pick: 'Bug triager' },
      { id: 'o5-mini', ctx: '128K', use: '8.1M', cost: '$3', p: '$0.50 / $2', pick: null },
    ] },
  { name: 'Moonshot', state: 'Connected', tone: 'success', key: 'sk-kimi-…3d80', latency: '780ms', share: 3,
    models: [
      { id: 'kimi-k3', ctx: '256K', use: '22.6M', cost: '$4', p: '$0.60 / $2.50', pick: null },
    ] },
  { name: 'Local (Ollama)', state: 'Offline', tone: 'neutral', key: 'localhost:11434', latency: '—', share: 0,
    models: [
      { id: 'qwen3-coder:32b', ctx: '128K', use: '0', cost: '$0', p: 'free', pick: null },
    ] },
];

/* ---------- loops ---------- */

const LOOPS: { name: string; when: string; agent: string; guard: string; last: string; state: 'on' | 'paused'; runs: number }[] = [
  { name: 'Land the green ones', when: 'every push', agent: 'Implementer', guard: 'checks pass and 0 behind main',
    last: 'landed 17m ago', state: 'on', runs: 212 },
  { name: 'Nightly branch sweep', when: '02:00 daily', agent: 'Sweeper', guard: 'no commits in 7 days',
    last: 'ran 6h ago · flagged 1', state: 'on', runs: 92 },
  { name: 'Quarantine flaky checks', when: 'after each suite', agent: 'Sweeper', guard: 'red 3 of last 20 runs',
    last: 'ran 1h ago · no action', state: 'on', runs: 48 },
  { name: 'Grade new bugs', when: 'on bug filed', agent: 'Bug triager', guard: 'never sets Blocking',
    last: 'paused by you 2d ago', state: 'paused', runs: 28 },
  { name: 'Plan night', when: 'Sun 21:00', agent: 'Advisor', guard: 'commits nothing, ever',
    last: 'ran Sun · 2 plans drafted', state: 'on', runs: 12 },
  { name: 'Auto-rebase stale branches', when: '03:00 daily', agent: 'Implementer', guard: 'stops if conflicts exceed 2 files',
    last: 'paused by you 11d ago', state: 'paused', runs: 34 },
];

/* ---------- connections ---------- */

const CONNECTIONS: { name: string; kind: string; detail: string; state: string; tone: Tone; last: string }[] = [
  { name: 'GitHub', kind: 'Source', detail: 'bkane/console · main', state: 'Connected', tone: 'success', last: 'synced 17m ago' },
  { name: 'Anthropic', kind: 'Model provider', detail: '5 models · 91% of tokens', state: 'Connected', tone: 'success', last: '410ms' },
  { name: 'OpenAI', kind: 'Model provider', detail: '2 models · 6% of tokens', state: 'Connected', tone: 'success', last: '520ms' },
  { name: 'Moonshot', kind: 'Model provider', detail: '1 model · 3% of tokens', state: 'Connected', tone: 'success', last: '780ms' },
  { name: 'Ollama', kind: 'Local runtime', detail: 'localhost:11434', state: 'Offline', tone: 'neutral', last: 'unreachable' },
  { name: 'Vercel', kind: 'Deploy', detail: 'console-bkane.vercel.app', state: 'Connected', tone: 'success', last: 'deployed 4h ago' },
  { name: 'Sentry', kind: 'Telemetry', detail: 'no events in 30 days', state: 'Degraded', tone: 'warning', last: 'check the DSN' },
];

/* ---------- context ----------
   The kit's own note: stack.md is the root context every model reads, scoped
   files inherit from it and layer on top, and an agent or provider only ever
   sees root + the files it is scoped to. Read the header above before wiring
   any of it — this is the shape that used to overwrite CLAUDE.md. */

type DocKind = 'root' | 'agent' | 'provider';
type Doc = {
  path: string; kind: DocKind; scope: string; words: number; edited: string;
  reads: number; tone: Tone; summary: string; body: string;
};

const DOCS: Doc[] = [
  {
    path: 'stack.md', kind: 'root', scope: 'Every model, every run',
    words: 812, edited: '2h ago', reads: 209, tone: 'success',
    summary: 'What the product is, how the repo is laid out, the rules that never change.',
    body: [
      '# Stack',
      '',
      'A work surface for one developer. There is no team: no assignees, no review queues,',
      'no standups. Anything that assumes more than one person is wrong here.',
      '',
      '## Layout',
      '',
      '- `components/` — design system primitives, inline styles only',
      '- `ui_kits/console/` — the screens, one file per screen',
      '- `tokens/` — colour, type, spacing; never hardcode a hex',
      '',
      '## Rules that never change',
      '',
      '1. Severity is set by hand. Red means work stops, nothing else.',
      '2. Roadmap ideas are not work items and never count toward completion.',
      '3. Every check names the area and subject it covers.',
      '4. No emoji. No gradients. Lime is rationed to one moment per view.',
      '',
      '## Voice',
      '',
      'Plain and operational. Sentence case. Verb-first buttons. State the fact, then',
      'the consequence. If it needs a paragraph, it belongs in a doc, not a banner.',
    ].join('\n'),
  },
  {
    path: 'agents/implementer.md', kind: 'agent', scope: 'Implementer',
    words: 460, edited: '1d ago', reads: 118, tone: 'success',
    summary: 'How to land a change: branch naming, commit style, when to stop and ask.',
    body: [
      '# Implementer',
      '',
      'Inherits stack.md.',
      '',
      '## Branches',
      '',
      'One branch per work item, named `king/<slug>`. Never commit to main.',
      '',
      '## Commits',
      '',
      'Imperative subject under 60 characters. No trailing period. Body only when the',
      'reason is not obvious from the diff.',
      '',
      '## Stop and ask when',
      '',
      '- the change touches more than 12 files',
      '- a token would need a new value',
      '- a check would have to be deleted to pass',
    ].join('\n'),
  },
  {
    path: 'agents/reviewer.md', kind: 'agent', scope: 'Reviewer',
    words: 295, edited: '3d ago', reads: 46, tone: 'success',
    summary: 'What a verdict means, and the difference between a concern and a block.',
    body: '',
  },
  {
    path: 'agents/sweeper.md', kind: 'agent', scope: 'Sweeper',
    words: 180, edited: '1 wk ago', reads: 92, tone: 'success',
    summary: 'What is safe to delete without asking. Everything else gets flagged.',
    body: '',
  },
  {
    path: 'providers/openai.md', kind: 'provider', scope: 'OpenAI models',
    words: 140, edited: '4d ago', reads: 28, tone: 'success',
    summary: 'Formatting quirks and the tool-call shape gpt-5.2 expects.',
    body: '',
  },
  {
    path: 'providers/local.md', kind: 'provider', scope: 'Ollama models',
    words: 96, edited: '2 wk ago', reads: 0, tone: 'neutral',
    summary: 'Shortened rules for a 128K window. Drops the voice section.',
    body: '',
  },
];

const DOC_KIND: Record<DocKind, { icon: KitIconName; label: string }> = {
  root: { icon: 'terminal', label: 'Root' },
  agent: { icon: 'users', label: 'Agent' },
  provider: { icon: 'git-branch', label: 'Provider' },
};

/* ---------- the pieces the tabs share ---------- */

// The kit's Panel. `rule` is a NAMED role rather than a colour, so the two
// places a left rule means something (a live panel, a destructive one) stay
// re-tonable from styles.css — the #444 rule: a component names the role and
// styles.css owns the tone.
function Panel({ title, note, right, rule, children }: {
  title: string; note?: string; right?: ReactNode;
  rule?: 'live' | 'danger'; children: ReactNode;
}) {
  return (
    <section className={`mcx-panel${rule ? ` rule-${rule}` : ''}`}>
      <header className="mcx-panelhead">
        <span className="t">{title}</span>
        {note ? <span className="note">{note}</span> : null}
        {right ? <span className="right">{right}</span> : null}
      </header>
      {children}
    </section>
  );
}

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`mcx-pill mcx-t-${tone}`}>
      <span className="dot" />{children}
    </span>
  );
}

// The kit's Switch, as a real `role="switch"` button rather than a clickable
// span — the app already spells one this way in ExportBriefModal, and a toggle
// a keyboard cannot reach is not a toggle.
function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <span className="k-switch">
      <button type="button" role="switch" aria-checked={checked} aria-label={label}
        className={`k-switch-track${checked ? ' on' : ''}`} onClick={() => onChange(!checked)}>
        <span className="k-switch-knob" />
      </button>
      {label ? <span className="k-switch-label">{label}</span> : null}
    </span>
  );
}

export function ControlMock() {
  const [tab, setTab] = useState<McTab>('overview');

  return (
    <div className="mcx-ground">
      <TopBar crumb={[{ label: 'Projects', onClick: go.dashboard }, { label: 'Mission Control' }]} />

      <div className="page detail mcx">
        <div className="mcx-head">
          <div className="mcx-title">
            <span className="eyebrow">Machine room</span>
            <h1>
              Mission Control
              {/* Said once, where it cannot be missed: none of the numbers below
                  are this installation's. */}
              <span className="mcx-badge">the kit's screen · sample data</span>
            </h1>
          </div>
          <span className="mcx-headacts">
            <span className="mcx-liveflag"><span className="dot" />2 agents running</span>
            <button className="k-btn sm danger">Stop everything</button>
          </span>
        </div>

        <div className="k-tabs mcx-tabs">
          {TABS.map((t) => (
            <button key={t.value} className={`k-tab${tab === t.value ? ' on' : ''}`} onClick={() => setTab(t.value)}>
              <KitIcon name={t.icon} size={14} />{t.label}
              {t.n ? <span className="n">{t.n}</span> : null}
            </button>
          ))}
        </div>

        {tab === 'overview' && <Overview />}
        {tab === 'agents' && <Agents />}
        {tab === 'models' && <Models />}
        {tab === 'context' && <Context />}
        {tab === 'loops' && <Loops />}
        {tab === 'connections' && <Connections />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}

/* ---------- Overview ---------- */

function Overview() {
  return (
    <div className="mcx-stack">
      <section className="mcx-pulse">
        {PULSE.map((p) => (
          <div className="mcx-pulseitem" key={p.label}>
            <span className="l">{p.label}</span>
            <span className={`v${p.accent ? ' accent' : ''}`}>{p.value}</span>
            <span className="note">{p.note}</span>
          </div>
        ))}
      </section>

      <Panel title="Running now" note="live agents" rule="live">
        {LIVE.map((l) => (
          <div className={`mcx-row mcx-liverow mcx-t-${l.tone}`} key={l.agent}>
            <span className="mcx-liveicon"><KitIcon name="terminal" size={13} /></span>
            <div className="body">
              <span className="line">
                <span className="who">{l.agent}</span>
                <span className="model">{l.model}</span>
                <span className="what">{l.task} — {l.phase}</span>
              </span>
              <span className="mcx-track"><span className="fill" style={{ width: `${l.pct}%` }} /></span>
            </div>
            <span className="num el">{l.elapsed}</span>
            <span className="num tok">{l.tokens}</span>
            <span className="num cost strong">{l.cost}</span>
            <button className="mcx-link">watch</button>
            <button className="mcx-link danger">stop</button>
          </div>
        ))}
      </Panel>

      <Panel title="Last runs" note="today" right={<button className="mcx-link">Full log</button>}>
        {RECENT.map((r) => (
          <div className="mcx-row mcx-runrow hoverable" key={r.task}>
            <span className="who">{r.agent}</span>
            <span className="what">{r.task}</span>
            <span className="model">{r.model}</span>
            <span className="num commits">{r.commits} commits</span>
            <span className="num dur">{r.dur}</span>
            <span className="num cost strong">{r.cost}</span>
            <span className="end"><Pill tone={r.tone}>{r.result}</Pill></span>
          </div>
        ))}
      </Panel>
    </div>
  );
}

/* ---------- Agents ---------- */

function Agents() {
  const [open, setOpen] = useState<string | null>('Implementer');
  return (
    <div className="mcx-stack tight">
      <div className="mcx-intro">
        <span className="lede">Five agents · 2 running · 1 paused. Autonomy is set per agent and never inherited.</span>
        <button className="k-btn sm secondary"><KitIcon name="plus" size={13} />New agent</button>
      </div>

      {AGENTS.map((a) => {
        const on = open === a.name;
        return (
          <section className={`mcx-fold${on ? ' on' : ''}`} key={a.name}>
            <header className="mcx-foldhead mcx-agenthead" onClick={() => setOpen(on ? null : a.name)}>
              <span className="caret">{on ? '▾' : '▸'}</span>
              <div className="body">
                <span className="name">{a.name}</span>
                <span className="role">{a.role}</span>
              </div>
              <span className="model">{a.model}</span>
              <span className="autonomy">{a.autonomy}</span>
              <span className="spend">{a.spend}</span>
              <span className="end"><Pill tone={a.tone}>{a.state}</Pill></span>
            </header>

            {on && (
              <div className="mcx-foldbody">
                <div className="mcx-facts">
                  {([['Runs', String(a.runs)], ['Land rate', a.land], ['Fallback', a.fallback], ['Spend', a.spend]] as [string, string][]).map(([l, v]) => (
                    <div className="fact" key={l}>
                      <span className="l">{l}</span>
                      <span className="v">{v}</span>
                    </div>
                  ))}
                </div>
                {/* THE CAPABILITY LIST IS THE ONE THING HERE THAT MUST NOT
                    BECOME EDITABLE. An agent's `ops` list is CODE (src/agents.js
                    is the registry); `agent_configs` holds only what the owner
                    tunes. Drawn as chips, deliberately, not as controls. */}
                <div className="mcx-caps">
                  <span className="eyebrow">Can do</span>
                  <span className="chips">
                    {a.caps.map((c) => <span className="chip" key={c}>{c}</span>)}
                  </span>
                </div>
                <div className="mcx-foldacts">
                  <button className="k-btn sm secondary">Change model</button>
                  <button className="k-btn sm secondary">Autonomy</button>
                  <button className="k-btn sm ghost">{a.state === 'Paused' ? 'Resume' : 'Pause'}</button>
                  <button className="k-btn sm ghost"><KitIcon name="terminal" size={13} />Session log</button>
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* ---------- Models ---------- */

const MODEL_COLS: [string, string][] = [
  ['Model', 'c-id'], ['Context', 'c-ctx'], ['Tokens', 'c-use'],
  ['Cost', 'c-cost'], ['In / out per M', 'c-p'], ['Used by', 'c-pick'],
];

function Models() {
  const [open, setOpen] = useState<string | null>('Anthropic');
  return (
    <div className="mcx-stack tight">
      <div className="mcx-intro">
        <span className="lede">Four providers · 9 models wired in. Share is measured on tokens over the last 12 weeks.</span>
        <button className="k-btn sm secondary"><KitIcon name="plus" size={13} />Add provider</button>
      </div>

      {PROVIDERS.map((p) => {
        const on = open === p.name;
        return (
          <section className={`mcx-fold${on ? ' on' : ''}`} key={p.name}>
            <header className="mcx-foldhead mcx-provhead" onClick={() => setOpen(on ? null : p.name)}>
              <span className="caret">{on ? '▾' : '▸'}</span>
              <span className="name">{p.name}</span>
              <span className="key">{p.key}</span>
              <span className="share">
                <span className="mcx-track wide"><span className="fill viz" style={{ width: `${p.share}%` }} /></span>
                <span className="pct">{p.share}%</span>
              </span>
              <span className="latency">{p.latency}</span>
              <span className="end"><Pill tone={p.tone}>{p.state}</Pill></span>
            </header>

            {on && (
              <>
                <div className="mcx-row mcx-modelrow head">
                  {MODEL_COLS.map(([l, c]) => <span className={c} key={c}>{l}</span>)}
                </div>
                {p.models.map((m) => (
                  <div className="mcx-row mcx-modelrow hoverable" key={m.id}>
                    <span className="c-id">{m.id}</span>
                    <span className="c-ctx">{m.ctx}</span>
                    <span className="c-use">{m.use}</span>
                    <span className="c-cost">{m.cost}</span>
                    <span className="c-p">{m.p}</span>
                    {/* "unassigned" is an ANSWER, not decoration, so it does not
                        take the kit's --text-disabled: that tone measures under
                        AA, and the Plans dash refused it for the same reason. */}
                    <span className={`c-pick${m.pick ? ' picked' : ''}`}>{m.pick || 'unassigned'}</span>
                  </div>
                ))}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* ---------- Loops ---------- */

function Loops() {
  const [states, setStates] = useState<Record<string, boolean>>(
    () => Object.fromEntries(LOOPS.map((l) => [l.name, l.state === 'on'])),
  );
  const active = Object.values(states).filter(Boolean).length;

  return (
    <div className="mcx-stack tight">
      <div className="mcx-intro">
        <span className="lede">Loops run without you. Each one names its guard — the condition that stops it before it does damage.</span>
        <button className="k-btn sm secondary"><KitIcon name="plus" size={13} />New loop</button>
      </div>

      <Panel title="Automation" note={`${active} of ${LOOPS.length} active`}>
        {LOOPS.map((l) => (
          <div className="mcx-row mcx-looprow hoverable" key={l.name}>
            <Switch checked={states[l.name]} label={l.name}
              onChange={(v) => setStates({ ...states, [l.name]: v })} />
            <div className="body">
              <span className="line">
                <span className={`name${states[l.name] ? '' : ' off'}`}>{l.name}</span>
                <span className="when">{l.when}</span>
                <span className="who">{l.agent}</span>
              </span>
              <span className="guard">guard: {l.guard}</span>
            </div>
            <span className="num">{l.runs}</span>
            <span className="last">{l.last}</span>
            <button className="mcx-link">edit</button>
          </div>
        ))}
      </Panel>
    </div>
  );
}

/* ---------- Connections ---------- */

function Connections() {
  return (
    <div className="mcx-stack tight">
      <div className="mcx-intro">
        <span className="lede">Seven integrations · 1 offline, 1 degraded.</span>
        <button className="k-btn sm secondary"><KitIcon name="plus" size={13} />Add connection</button>
      </div>

      <div className="mcx-conns">
        {CONNECTIONS.map((c) => {
          const off = c.state !== 'Connected';
          return (
            <section className={`mcx-conn mcx-t-${c.tone}${off ? ' off' : ''}`} key={c.name}>
              <div className="top">
                <span className="kind">{c.kind}</span>
                <span className="end"><Pill tone={c.tone}>{c.state}</Pill></span>
              </div>
              <span className="name">{c.name}</span>
              <span className="detail">{c.detail}</span>
              <div className="foot">
                <span className="last">{c.last}</span>
                <span className="act">{off ? 'reconnect' : 'manage'}</span>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Context ---------- */

function Context() {
  const [sel, setSel] = useState('stack.md');
  const [editing, setEditing] = useState(false);
  const doc = DOCS.find((d) => d.path === sel) ?? DOCS[0];
  const words = DOCS.reduce((n, d) => n + d.words, 0);

  return (
    <div className="mcx-stack tight">
      <div className="mcx-intro">
        <span className="lede">
          Six files · {words.toLocaleString()} words in context. Every run reads stack.md; scoped files layer on top of it.
        </span>
        <button className="k-btn sm secondary"><KitIcon name="plus" size={13} />New context file</button>
      </div>

      <div className="mcx-ctx">
        <section className="mcx-doctree">
          {DOCS.map((d) => {
            const k = DOC_KIND[d.kind];
            const root = d.kind === 'root';
            return (
              <button key={d.path} type="button"
                className={`mcx-docrow kind-${d.kind}${root ? ' root' : ''}${sel === d.path ? ' on' : ''}`}
                onClick={() => { setSel(d.path); setEditing(false); }}>
                {!root ? <span className="tick" /> : null}
                <span className="ic" aria-label={k.label}><KitIcon name={k.icon} size={root ? 14 : 12} /></span>
                <span className="path">{d.path}</span>
                <span className="reads">{d.reads || '—'}</span>
              </button>
            );
          })}
          <div className="mcx-docfoot">Indented files inherit stack.md. Nothing is read twice.</div>
        </section>

        <section className={`mcx-docview kind-${doc.kind}`}>
          <header className="mcx-docviewhead">
            <span className="path">{doc.path}</span>
            <Pill tone={doc.tone}>{doc.reads ? `${doc.reads} reads` : 'never read'}</Pill>
            <span className="meta">{doc.words} words · edited {doc.edited}</span>
            <span className="acts">
              {/* Inert, and the header says why this one matters more than the
                  rest: this is the shape that used to overwrite a repo's
                  CLAUDE.md on a five-minute schedule. */}
              <button className={`k-btn sm ${editing ? 'accent' : 'secondary'}`} onClick={() => setEditing(!editing)}>
                <KitIcon name={editing ? 'check' : 'pencil'} size={13} />{editing ? 'Save' : 'Edit'}
              </button>
              <button className="k-btn sm ghost">History</button>
            </span>
          </header>

          <div className="mcx-docscope">
            <span className="line">
              <span className="eyebrow">Read by</span>
              <span className="who">{doc.scope}</span>
              {doc.kind !== 'root' ? <span className="inherits">inherits stack.md</span> : null}
            </span>
            <span className="summary">{doc.summary}</span>
          </div>

          {doc.body ? (
            editing ? (
              <textarea className="mcx-doceditor" defaultValue={doc.body} spellCheck={false} aria-label={`${doc.path} source`} />
            ) : (
              <div className="mcx-docbody">
                {doc.body.split('\n').map((line, i) => <MdLine key={i} line={line} n={i + 1} />)}
              </div>
            )
          ) : (
            <div className="mcx-docempty">
              <span className="t">Not written yet.</span>
              <button className="k-btn sm accent" onClick={() => setEditing(true)}><KitIcon name="pencil" size={13} />Draft it</button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function MdLine({ line, n }: { line: string; n: number }) {
  const heading = line.startsWith('#');
  const level = heading ? (line.match(/^#+/) || [''])[0].length : 0;
  const bullet = /^\s*[-\d]/.test(line) && !heading;
  const text = heading ? line.replace(/^#+\s*/, '') : line;
  const cls = heading ? `h h${level > 1 ? 2 : 1}` : bullet ? 'bullet' : 'plain';
  return (
    <div className="mcx-mdline">
      <span className="n">{n}</span>
      <span className={cls}>{text || ' '}</span>
    </div>
  );
}

/* ---------- Settings ---------- */

function SettingsTab() {
  const [approve, setApprove] = useState(true);
  const [cap, setCap] = useState(true);
  const [local, setLocal] = useState(false);
  const [log, setLog] = useState(true);

  return (
    <div className="mcx-stack tight narrow">
      <Panel title="Guardrails" note="applies to every agent and loop">
        <div className="mcx-panelbody rows">
          <Switch checked={approve} onChange={setApprove} label="Every plan needs my approval before it runs" />
          <Switch checked={cap} onChange={setCap} label="Stop a run when it passes its token budget" />
          <Switch checked={log} onChange={setLog} label="Keep full session transcripts" />
          <Switch checked={local} onChange={setLocal} label="Prefer the local model when it is reachable" />
        </div>
      </Panel>

      <Panel title="Budgets">
        <div className="mcx-panelbody pairs">
          <label className="k-field">
            <span className="k-field-label">Daily spend cap</span>
            <input className="k-input" defaultValue="$60" />
            <span className="k-field-hint">Runs queue rather than fail</span>
          </label>
          <label className="k-field">
            <span className="k-field-label">Per-run token cap</span>
            <input className="k-input" defaultValue="40M" />
          </label>
          <label className="k-field">
            <span className="k-field-label">On cap</span>
            <select className="k-select" defaultValue="Pause and ask me">
              {['Pause and ask me', 'Fall back to a cheaper model', 'Stop the run'].map((o) => <option key={o}>{o}</option>)}
            </select>
          </label>
          <label className="k-field">
            <span className="k-field-label">Default model</span>
            <select className="k-select" defaultValue="claude-sonnet-5">
              {['claude-sonnet-5', 'claude-opus-5', 'gpt-5.2', 'kimi-k3'].map((o) => <option key={o}>{o}</option>)}
            </select>
          </label>
        </div>
      </Panel>

      <div className="k-banner warning">
        <div className="k-banner-text">
          <span className="k-banner-title">Sentry has seen no events in 30 days</span>
          <span className="k-banner-body">Telemetry looks disconnected, so runtime errors may not be reaching you.</span>
        </div>
        <button className="k-btn sm secondary">Check the DSN</button>
      </div>

      <Panel title="Danger zone" rule="danger">
        <div className="mcx-panelbody rows">
          <div className="mcx-dangerrow">
            <span className="t">Revoke every provider key and stop all loops. Agents keep their settings.</span>
            <button className="k-btn sm danger">Revoke keys</button>
          </div>
          <div className="mcx-dangerrow">
            <span className="t">Delete 209 session transcripts. Usage totals stay.</span>
            <button className="k-btn sm danger">Delete transcripts</button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
