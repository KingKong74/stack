// MISSION CONTROL IS BEING WIRED, THREE TABS OF SEVEN (#514). Agents, Models
// and Context read and write this installation. Overview, Loops, Connections
// and Settings are still the console kit's sample rows and each one now wears a
// Mock chip ON ITS OWN TAB — the #482/#496 rule, because a chip over the whole
// screen warns about the three panes it is wrong for, and these mockups look
// exactly like the real thing.
//
// It began as `ui_kits/console/mission-control.html` → `MissionControlScreen.jsx`
// ported to TS on the kit's own sample fleet, the seventh kit port on the same
// terms as the other six (#443, #444, #447, #450, #451, #453): the kit's screen
// first, the wiring after. It replaced the CULLED-SKELETON placeholder that
// stood at `#/control` — the seven rooms (Now, Merge, Nights, Plan, Review,
// Roles, Agents) and `/api/control`, `/api/review`, `/api/merge` went long
// before that, and the skeleton was the honest frame drawn over the hole.
//
// THE KIT'S SEVEN TABS ARE NOT STACK'S SEVEN ROOMS, and the port's header owed
// a MAPPING DECISION rather than a rename for each. Here is what the three
// wired ones decided, and what the four left owe:
//
//  • AGENTS (wired, and RE-AIMED by #520) is `agent_profiles` — the spawn
//    catalogue the overnight runner hands `claude --agents`. It used to be the
//    other thing that arrived under the same word: the tab-agent REGISTRY
//    (`server/src/agents.js` + `agent_configs`), and this header used to warn
//    that merging the two was the trap. They were never merged — the registry
//    was CULLED and the tab went to the survivor. What is left is the half that
//    decides how every night gets built.
//    THE "CAN DO" LIST IS EDITABLE NOW, and that inversion is the whole
//    difference between the two: an op was CODE, so a browser could only switch
//    one off, where a profile's tools are DATA and this screen is where they are
//    granted. So the kit's New button is back and honest, and `grantLine` exists
//    because eight checkboxes cannot say what ticking one hands a model.
//  • MODELS (wired) is the executor/advisor policy (#153, inverted by #285)
//    plus twelve weeks of measured spend, and the rule the kit's single share
//    bar could not hold: TWO POPULATIONS THAT MUST NOT BE MIXED. The bar at the
//    top of the tab is drawn as two tones and named, and every share on the
//    screen is TOKEN-based because an interactive transcript carries no price.
//    `server/src/routes/models.js` holds the arithmetic and the mapping from
//    "provider" to Stack's actual backends — a subscription, a key, and one
//    gateway the server cannot see at all.
//  • CONTEXT (wired, and the one that had to be re-aimed) — the kit draws a
//    managed CLAUDE.md library with an Edit/Save button, and THAT SURFACE STAYS
//    CULLED: Stack used to write each repo's CLAUDE.md from its own copy every
//    five minutes and a stale DB copy silently reverted this project's own file
//    for several sessions running. So the tab answers the honest version of the
//    kit's question — what text actually reaches a model here — over the three
//    things that really do: the session defaults, each SPAWN PROFILE's prompt
//    (#520 re-aimed this from the culled registry's preambles) and the ✧ assist
//    steer. Two of those are the owner's own words and carry the Edit button;
//    the rest is code and has no button at all.
//    `server/src/routes/context.js`'s header is the long version.
//  • OVERVIEW (mock) is `autopilot_runs`, and the kit's "runs today / landed /
//    failed" strip is THREE of the four buckets a night partitions into.
//    `planned` and `noCommits` are the other two and they are not failures: a
//    plan night is the advisor working, and folding it back into a land rate
//    scores the advisor as having failed to land runs nobody asked it to land.
//    `pulse.js` spells the partition out; the kit's four numbers cannot hold it.
//  • LOOPS (mock) is the cron dispatcher, the nightly and the `autopilotEnabled`
//    arm switch. The kit gives every loop its own toggle; Stack has ONE arm
//    switch and three gates deciding who runs (the fleet cap, per-project
//    serialisation, the area lane), and per-project cannot become a knob.
//  • CONNECTIONS (mock) is `geminiReady`, `terminal.connected` and the provider
//    keys `terminal/model-switch.mjs` resolves. The fail-safe direction is the
//    trap: with no host daemon on the line the honest answer is "Stack cannot
//    see", never a green card — the kit has a tone for Offline and Degraded and
//    no tone at all for UNKNOWN, which is the NULL-verdict lie in card form.
//    (The Models tab already draws that answer for OmniRoute; copy it here.)
//  • SETTINGS (mock) duplicates `#/settings`, which is real and wired. Two rows
//    of it have no counterpart at all (revoke every key, delete 209
//    transcripts) and both are destructive; the fail-safe rules say an
//    automation that destroys does nothing when it cannot reach the API, and
//    neither has been thought through in those terms yet.
//
// THE HEADER FLAG CHANGED WITH THE TAB. It reported the HOST DAEMON, because
// that was the frame around every tab-agent switch. The daemon belongs to the
// terminal and to Models now, and this screen's frame is whether an ADVISOR is
// set — with none, `--agents` is never passed and every profile on the Agents
// tab is inert. Same rule one layer in: state the thing that makes the screen
// below it true or false.
//
// NOTHING ON A MOCK TAB IS A FACT ABOUT THIS INSTALLATION — every tone on one
// (green pills, an amber bar, a red danger zone) is the kit's sample data, and
// the four switches on them are local state that leaving the page undoes. A
// wired tab's numbers are this installation's and nothing on one is invented:
// where a number cannot be measured it is a DASH, never a zero.
//
// The kit's page chrome is NOT ported. Its standalone HTML ships its own top
// bar with a search box, a New project button and a three-number status strip;
// this app has one TopBar of its own, and the strip would have been a second
// copy of numbers the screen already states.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  AgentProfile, AgentProfilesRoom, ContextRoom, ModelsRoom,
} from '../types';
import {
  getAgentProfiles, getContextRoom, getModelsRoom, patchAgentProfile,
  createAgentProfile, deleteAgentProfile, patchSettings,
} from '../store';
import { compactTokens } from '../lib/spine';
import { hrefTo } from '../lib/route';
import { TopBar } from '../components/TopBar';
import { KitIcon, type KitIconName } from '../detail/kit/KitIcon';

type Tone = 'info' | 'warning' | 'success' | 'danger' | 'neutral';
type McTab = 'overview' | 'agents' | 'models' | 'context' | 'loops' | 'connections' | 'settings';

// `mock` is the tab's own chip. A COUNT ON A WIRED TAB IS A REAL COUNT and a
// count on a mock one counts the MOCKUP, so the wired three take theirs from
// the payload at render time and only the mock tabs carry a constant here.
const TABS: { value: McTab; label: string; icon: KitIconName; n?: number; mock?: boolean }[] = [
  { value: 'overview', label: 'Overview', icon: 'chart-no-axes-column', mock: true },
  { value: 'agents', label: 'Agents', icon: 'users' },
  { value: 'models', label: 'Models', icon: 'terminal' },
  { value: 'context', label: 'Context', icon: 'file-text' },
  { value: 'loops', label: 'Loops', icon: 'clock', n: 6, mock: true },
  { value: 'connections', label: 'Connections', icon: 'git-branch', n: 7, mock: true },
  { value: 'settings', label: 'Settings', icon: 'settings', mock: true },
];

/* ---------- overview (MOCK — the kit's own sample fleet) ---------- */

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

/* ---------- loops (MOCK) ---------- */

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

/* ---------- connections (MOCK) ---------- */

const CONNECTIONS: { name: string; kind: string; detail: string; state: string; tone: Tone; last: string }[] = [
  { name: 'GitHub', kind: 'Source', detail: 'bkane/console · main', state: 'Connected', tone: 'success', last: 'synced 17m ago' },
  { name: 'Anthropic', kind: 'Model provider', detail: '5 models · 91% of tokens', state: 'Connected', tone: 'success', last: '410ms' },
  { name: 'OpenAI', kind: 'Model provider', detail: '2 models · 6% of tokens', state: 'Connected', tone: 'success', last: '520ms' },
  { name: 'Moonshot', kind: 'Model provider', detail: '1 model · 3% of tokens', state: 'Connected', tone: 'success', last: '780ms' },
  { name: 'Ollama', kind: 'Local runtime', detail: 'localhost:11434', state: 'Offline', tone: 'neutral', last: 'unreachable' },
  { name: 'Vercel', kind: 'Deploy', detail: 'console-bkane.vercel.app', state: 'Connected', tone: 'success', last: 'deployed 4h ago' },
  { name: 'Sentry', kind: 'Telemetry', detail: 'no events in 30 days', state: 'Degraded', tone: 'warning', last: 'check the DSN' },
];

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
function Switch({ checked, onChange, label, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean;
}) {
  return (
    <span className="k-switch">
      <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
        className={`k-switch-track${checked ? ' on' : ''}`} onClick={() => onChange(!checked)}>
        <span className="k-switch-knob" />
      </button>
      {label ? <span className="k-switch-label">{label}</span> : null}
    </span>
  );
}

// THE THREE STATES A WIRED TAB HAS, and the middle one is the one that matters:
// a read that FAILED says so, because an empty screen where a fetch died reads
// as "nothing here" — the same absent-is-not-zero rule every payload on this
// screen is built around.
function Loading({ what }: { what: string }) {
  return <div className="mcx-state">Reading {what}…</div>;
}
function Failed({ err, onRetry }: { err: string; onRetry: () => void }) {
  return (
    <div className="mcx-state bad">
      <span>Stack could not read this: {err}</span>
      <button className="k-btn sm secondary" onClick={onRetry}>Try again</button>
    </div>
  );
}

/** A tab's read, with its own loading and failure states. */
function useRoom<T>(read: () => Promise<T>): [T | null, string, boolean, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(true);
  const load = useCallback(() => {
    setBusy(true);
    read()
      .then((d) => { setData(d); setErr(''); })
      .catch((e: unknown) => setErr((e as Error)?.message || 'Something went wrong.'))
      .finally(() => setBusy(false));
    // `read` is re-created per render by the caller's closure; the tab mounts
    // once, so depending on it would refetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { load(); }, [load]);
  return [data, err, busy, load];
}

/** Dollars, to the cent. NEVER used for a null — see `money` below. */
const usd = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
/** null = UNPRICED. A dash, never $0.00: a transcript carries no cost. */
const money = (n: number | null) => (n === null ? '—' : usd(n));

// `ago()` LIVED HERE and went with the Agents room's ledger (#520). The tab
// agents carried `runs` / `last_run_at` / `last_outcome` in `agent_configs` and
// the fold drew all three; a spawn profile has no such ledger, because
// `autopilot_runs` records the RUN and not which subagents it spawned. So the
// room reports how many open items would spawn a profile — a real number — and
// says out loud that it cannot report how often one actually has. An invented
// "last run" would have been the easier thing to draw.

export function MissionControl() {
  const [tab, setTab] = useState<McTab>('agents');
  // The Agents room rides at screen level because the HEADER reads it too, and
  // since #520 it reads a different fact: not "is the host daemon up" (the tab
  // agents' frame, and they are culled) but WHETHER A RUN SPAWNS SUBAGENTS AT
  // ALL. A page saying "2 agents on" over an installation with no advisor set —
  // where `--agents` is never passed and every profile is inert — is the same
  // sample-data lie the kit port's header was written about, one layer in.
  const [agents, agentsErr, agentsBusy, reloadAgents] = useRoom<AgentProfilesRoom>(getAgentProfiles);

  const live = agents?.profiles.filter((p) => p.enabled).length ?? 0;
  const spawns = agents?.policy.spawnsAgents ?? false;

  return (
    <div className="mcx-ground">
      <TopBar
        crumb={[{ label: 'Projects', href: hrefTo.dashboard }, { label: 'Mission Control', href: hrefTo.control }]}
        actions={
          // BACK TO THE TERMINAL. The terminal's own topbar has carried a
          // Mission Control button since it was built and the return trip was a
          // browser Back away, which is not a trip a bookmark or a fresh tab
          // has. Same button, same class, pointing the other way.
          <a className="btn-repo" href={hrefTo.terminal()} title="Back to the terminal">Terminal</a>
        } />

      <div className="page detail mcx">
        <div className="mcx-head">
          <div className="mcx-title">
            <span className="eyebrow">Machine room</span>
            <h1>Mission Control</h1>
          </div>
          <span className="mcx-headacts">
            {/* The one fact worth stating on every tab: does the fleet this
                screen configures actually exist. `--agents` is passed only when
                an advisor model is set, so with none there is no subagent on
                this installation and no switch on the Agents tab does anything.
                (The host daemon, which this flag used to report, belongs to the
                terminal and to Models — it stopped being this screen's frame
                when the tab agents went.) */}
            {agents && (
              <span className={`mcx-liveflag${spawns ? '' : ' off'}`}>
                <span className="dot" />
                {spawns
                  ? `Director ${agents?.policy.advisorModel} · ${live} profile${live === 1 ? '' : 's'} on`
                  : 'No advisor set — a run spawns no subagents at all'}
              </span>
            )}
            <a className="k-btn sm secondary" href={hrefTo.settings}>
              <KitIcon name="settings" size={13} />Settings
            </a>
          </span>
        </div>

        <div className="k-tabs mcx-tabs">
          {TABS.map((t) => (
            <button key={t.value} className={`k-tab${tab === t.value ? ' on' : ''}`} onClick={() => setTab(t.value)}>
              <KitIcon name={t.icon} size={14} />{t.label}
              {t.n ? <span className="n">{t.n}</span> : null}
              {/* THE CHIP RIDES ON THE TAB (#482, #496). Three of these tabs now
                  read this installation and four do not, and they look exactly
                  alike — one chip over the screen would warn about the wrong
                  three. */}
              {t.mock && (
                <span className="con-navsoon mock"
                  title="A mockup — the console kit's own sample rows. It reads and writes nothing.">Mock</span>
              )}
            </button>
          ))}
        </div>

        {tab === 'overview' && <Overview />}
        {tab === 'agents' && (
          agentsBusy && !agents ? <Loading what="the agents" />
            : agentsErr ? <Failed err={agentsErr} onRetry={reloadAgents} />
              : agents ? <Agents room={agents} onChanged={reloadAgents} /> : null
        )}
        {tab === 'models' && <Models />}
        {tab === 'context' && <Context />}
        {tab === 'loops' && <Loops />}
        {tab === 'connections' && <Connections />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}

/* ---------- Overview (MOCK) ---------- */

function Overview() {
  return (
    <div className="mcx-stack">
      <MockNote>
        These are the console kit's sample rows. A night's outcomes actually
        partition across FOUR buckets — landed, failed, planned and noCommits —
        and the kit's three-number strip cannot hold the partition, so wiring
        this one is a decision rather than a fetch.
      </MockNote>

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

/** The sentence a mock tab owes, above the sample rows rather than after them. */
function MockNote({ children }: { children: ReactNode }) {
  return (
    <div className="mcx-mocknote">
      <span className="con-navsoon mock">Mock</span>
      <span className="t">{children}</span>
    </div>
  );
}

/* ---------- Agents (WIRED) ---------- */

// THE AGENTS ARE THE SPAWN PROFILES (#520). This room drew the tab-agent
// REGISTRY until the cull that finally reached it; what it draws now is the
// catalogue the overnight runner hands `claude --agents` — the subagents a
// build actually spawns, on the models they run on, with the tools they are
// granted. That is the other thing two branches called "agents", and it is the
// one with teeth: the registry governed two ✧ buttons at the end, this decides
// how every night gets built.
//
// THE KIT'S "NEW AGENT" BUTTON IS BACK, and its return is the clearest marker
// of what changed. It was removed rather than left inert because an agent used
// to be a registry entry in code and there was no write a browser could make
// that would create one. A profile is DATA — a row in `agent_profiles` — so the
// button is honest now.
//
// FOUR THINGS THIS SCREEN HAS TO SAY THAT THE CATALOGUE ALONE CANNOT:
//
//  1. WHETHER ANY OF IT SPAWNS AT ALL. `--agents` is passed only when an
//     ADVISOR model is set; with none, the runner resolves a spawn and throws
//     the answer away. Every switch below would then be decoration, so the
//     warning goes at the TOP of the room rather than in a footnote.
//  2. WHAT A RUN ACTUALLY RESOLVES TO, not what is in the catalogue. A profile
//     nothing requests never spawns, and a catalogue of those is this feature's
//     failure mode — `defaultSpawn` is the server resolving one for real,
//     `reason` and all.
//  3. WHAT A TOOL GRANT MEANS, in a sentence, per profile. `tools` is eight
//     checkboxes and a reader cannot see the difference between a reviewer that
//     cannot write and one that can. `grantLine` says it in words.
//  4. THAT THE EXECUTOR CANNOT BE LOST. resolveSpawn falls back to the built-in
//     executor when nothing survives filtering, because a spawn with no builder
//     silently makes the expensive director do all the building itself. The
//     room states the invariant rather than letting the fallback be a surprise.
//
// A BUILT-IN IS RESET, NEVER DELETED, and the button says which — DELETE on a
// builtin drops its stored override and hands the factory profile back, so a
// "Delete" label there would promise something the server will not do.

/** '' = inherit the spawn's executor model. The rest are the CLI's own aliases. */
const PROFILE_MODELS: { model: string; label: string }[] = [
  { model: '', label: 'Inherit the executor model' },
  { model: 'haiku', label: 'Haiku' },
  { model: 'sonnet', label: 'Sonnet' },
  { model: 'opus', label: 'Opus' },
];

// The tool ladder. `tools` arrives as eight flat names and a flat list of eight
// checkboxes reads as eight equal preferences — they are not: three of them
// change what a subagent can DO to a checkout, and the rest only change how
// much it can see. Grouped, worst-last, so the grant is legible before it is
// made.
//
// KEYED OFF THE SERVER'S `knownTools`, never off this list: a tool the server
// knows and this file does not lands in "Other" rather than vanishing, which is
// the same rule the Models room's `providerOf` follows for an unrecognised
// model id. A grant that disappears from a screen is a grant nobody revokes.
const TOOL_TIERS: { id: string; label: string; note: string; tools: string[] }[] = [
  { id: 'read', label: 'Read', note: 'Look at the checkout. Cannot change it.', tools: ['Read', 'Grep', 'Glob'] },
  { id: 'run', label: 'Run', note: 'Shell commands — builds, tests, git. Can change the tree.', tools: ['Bash'] },
  { id: 'write', label: 'Write', note: 'Edit and create files directly.', tools: ['Edit', 'Write'] },
  { id: 'reach', label: 'Reach out', note: 'Leaves the machine — fetches URLs and searches.', tools: ['WebFetch', 'WebSearch'] },
];

const WRITING_TOOLS = ['Edit', 'Write'];

/**
 * What this grant MEANS, as one sentence. Derived, never stored — the whole
 * point is that it cannot drift from the checkboxes above it.
 *
 * The no-write case is the one worth spelling out: the built-in Reviewer's own
 * description promises "it never writes: no Edit or Write tool, so nothing it
 * says can land without a human or the executor acting on it", and a screen
 * that let you tick Edit while leaving that sentence on the card would have
 * broken a documented promise in silence.
 */
function grantLine(tools: string[]): { text: string; tone: Tone } {
  const writes = tools.some((t) => WRITING_TOOLS.includes(t));
  const runs = tools.includes('Bash');
  const reaches = tools.some((t) => t === 'WebFetch' || t === 'WebSearch');
  const out = tools.some((t) => t === 'WebFetch' || t === 'WebSearch') ? ', and can reach the network' : '';
  if (writes) return { text: `Writes files${runs ? ' and runs commands' : ''}${out}. Anything it does lands in the worktree.`, tone: 'warning' };
  if (runs) return { text: `Runs commands but cannot edit a file${out}. A build or a test can still change the tree.`, tone: 'info' };
  if (reaches) return { text: 'Reads only, and can reach the network. Nothing it says can land on its own.', tone: 'neutral' };
  return { text: 'Reads only. Nothing it says can land without something else acting on it.', tone: 'neutral' };
}

function Agents({ room, onChanged }: { room: AgentProfilesRoom; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(room.profiles[0]?.key ?? null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);

  const run = async (token: string, fn: () => Promise<unknown>) => {
    setBusy(token); setErr('');
    try { await fn(); onChanged(); }
    catch (e) { setErr((e as Error)?.message || 'That did not save.'); }
    finally { setBusy(''); }
  };

  const on = room.profiles.filter((p) => p.enabled).length;

  return (
    <div className="mcx-stack tight">
      <div className="mcx-intro">
        <span className="lede">
          {room.profiles.length === 1 ? 'One profile' : `${room.profiles.length} profiles`} · {on} on.
          A profile is a SUBAGENT an overnight run spawns: its own prompt, its own model and its own
          tools, with a context isolated from the director's. What you set here is what
          `claude --agents` is handed.
        </span>
        <span className="mcx-backends">
          {/* The kit's New button, and it is honest again — a profile is a row,
              not a registry entry in code. */}
          <button className="k-btn sm" onClick={() => setAdding(true)}>New profile</button>
        </span>
      </div>

      {/* THE FRAME, FIRST. Not a footnote: with no advisor nothing below spawns
          at all, and a screen of live-looking switches over that is the most
          expensive lie this room could tell. */}
      {!room.policy.spawnsAgents ? (
        <div className="mcx-framewarn">
          <Pill tone="warning">No advisor</Pill>
          <span className="t">
            Nothing on this screen spawns. A run only passes <code>--agents</code> when an ADVISOR
            model is set; with none, it is a single-model session on the executor and the director
            does its own building. Set one in <a href={hrefTo.settings}>Settings → Autopilot models</a>.
          </span>
        </div>
      ) : (
        <div className="mcx-frame">
          <span className="mcx-framebit">
            <span className="l">Director</span>
            <span className="v">{room.policy.advisorModel}</span>
          </span>
          <span className="mcx-framebit">
            <span className="l">Executor</span>
            <span className="v">{room.policy.executorModel || 'CLI default'}</span>
            <span className="note">what a profile inherits</span>
          </span>
          <span className="mcx-framebit grow">
            <span className="l">A run naming no profile spawns</span>
            <span className="v">{room.defaultSpawn.keys.join(', ') || '—'}</span>
            <span className="note">{room.defaultSpawn.reason}</span>
          </span>
          {/* The fallback is not an error and must not be drawn as one — it is
              the invariant working. It is still worth saying out loud, because
              the profile that spawned is not the one the catalogue implies. */}
          {room.defaultSpawn.fallback && (
            <Pill tone="info">Fell back to the built-in executor</Pill>
          )}
        </div>
      )}

      {err && <div className="action-error">{err}</div>}

      {adding && (
        <NewProfile knownTools={room.knownTools} busy={busy === 'new'}
          onCancel={() => setAdding(false)}
          onCreate={async (p) => {
            await run('new', () => createAgentProfile(p));
            setAdding(false);
            setOpen(p.key);
          }} />
      )}

      {room.profiles.map((p) => (
        <ProfileFold key={p.key} p={p} room={room} open={open === p.key}
          onToggle={() => setOpen(open === p.key ? null : p.key)}
          busy={busy} run={run} />
      ))}

      <p className="mcx-capnote">
        Nothing here reports how often a profile has actually spawned. `autopilot_runs` records the
        RUN, not which subagents it used, so the counts above are open items that WOULD spawn one —
        the honest number this installation can answer. A "last run" column would have been
        invented.
      </p>

      <p className="mcx-capnote">
        A spawn ALWAYS gets at least one building agent. If nothing survives — every profile off, or
        a run naming one that no longer exists — the runner falls back to the built-in executor and
        logs why. That is deliberate: a spawn with no builder does not fail loudly, it quietly makes
        the expensive director model do all the building itself.
      </p>
    </div>
  );
}

/** A profile's state in one word, on the same four-answer principle the room has
 *  always used: "on" and "would actually spawn" are different questions. */
function profileState(p: AgentProfile, room: AgentProfilesRoom): { label: string; tone: Tone } {
  if (!room.policy.spawnsAgents) return { label: 'Inert — no advisor', tone: 'warning' };
  if (!p.enabled) return { label: 'Switched off', tone: 'neutral' };
  if (room.defaultSpawn.keys.includes(p.key)) return { label: 'Spawns by default', tone: 'success' };
  const named = room.usage[p.key] ?? 0;
  if (named > 0) return { label: `${named} item${named === 1 ? '' : 's'} ask for it`, tone: 'info' };
  // On, spawnable, and nothing asks for it. Not an error — but it is the state
  // this feature fails in, so it is named rather than drawn as ready.
  return { label: 'Nothing requests it', tone: 'neutral' };
}

function ProfileFold({ p, room, open, onToggle, busy, run }: {
  p: AgentProfile; room: AgentProfilesRoom; open: boolean; onToggle: () => void; busy: string;
  run: (token: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState(p.prompt);
  const [desc, setDesc] = useState(p.description);
  // The server is the source of truth: a reload after somebody else's write has
  // to win over a draft nobody has touched.
  useEffect(() => { setPrompt(p.prompt); setDesc(p.description); }, [p.prompt, p.description]);

  const state = profileState(p, room);
  const grant = grantLine(p.tools);
  const used = room.usage[p.key] ?? 0;
  const dirty = prompt !== p.prompt || desc !== p.description;

  const toggleTool = (tool: string, want: boolean) => {
    const next = want ? [...p.tools, tool] : p.tools.filter((t) => t !== tool);
    // The engine refuses an empty grant (a profile that can do nothing is a
    // silent no-op, not a customisation) — say so here rather than letting the
    // 400 be the first anyone hears of it.
    if (!next.length) return;
    void run(`${p.key}:tools`, () => patchAgentProfile(p.key, { tools: next }));
  };

  // Keyed off the SERVER's vocabulary — anything it knows that TOOL_TIERS does
  // not still gets a row (see the ladder's comment).
  const tiered = new Set(TOOL_TIERS.flatMap((t) => t.tools));
  const others = room.knownTools.filter((t) => !tiered.has(t));

  return (
    <section className={`mcx-fold${open ? ' on' : ''}`}>
      <header className="mcx-foldhead mcx-agenthead" onClick={onToggle}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <div className="body">
          <span className="name">
            {p.name}
            {p.builtin && <span className="chip">built-in</span>}
          </span>
          <span className="role">{p.description || <em>no description</em>}</span>
        </div>
        <span className="model">{p.model || room.policy.executorModel || 'CLI default'}</span>
        <span className="autonomy">{p.tools.length} tools</span>
        <span className="spend">{used} item{used === 1 ? '' : 's'}</span>
        <span className="end"><Pill tone={state.tone}>{state.label}</Pill></span>
      </header>

      {open && (
        <div className="mcx-foldbody">
          <div className="mcx-facts">
            {([
              ['Key', p.key],
              ['Model', p.model ? `pinned to ${p.model}` : `inherits ${room.policy.executorModel || 'the CLI default'}`],
              ['Open items asking for it', String(used)],
              ['Context', 'isolated from the director'],
            ] as [string, string][]).map(([l, v]) => (
              <div className="fact" key={l}>
                <span className="l">{l}</span>
                <span className="v">{v}</span>
              </div>
            ))}
          </div>

          <div className="mcx-caps">
            <span className="eyebrow">Tools · {p.tools.length} of {room.knownTools.length} granted</span>
            {/* WHAT THE GRANT MEANS, IN WORDS. The checkboxes below are the
                control; this is the only thing on the screen that says what
                ticking one actually hands a model. */}
            <span className={`mcx-grant t-${grant.tone}`}>{grant.text}</span>
            <span className="mcx-tiers">
              {TOOL_TIERS.map((tier) => {
                const tools = tier.tools.filter((t) => room.knownTools.includes(t));
                if (!tools.length) return null;
                return (
                  <span className="mcx-tier" key={tier.id}>
                    <span className="head">
                      <span className="l">{tier.label}</span>
                      <span className="n">{tier.note}</span>
                    </span>
                    {tools.map((t) => (
                      <span className="mcx-oprow" key={t}>
                        <Switch checked={p.tools.includes(t)} label={t}
                          disabled={busy === `${p.key}:tools`}
                          onChange={(v) => toggleTool(t, v)} />
                        <span className="body">
                          <span className="line"><span className={`name${p.tools.includes(t) ? '' : ' off'}`}>{t}</span></span>
                        </span>
                      </span>
                    ))}
                  </span>
                );
              })}
              {others.length > 0 && (
                <span className="mcx-tier" key="other">
                  <span className="head">
                    <span className="l">Other</span>
                    <span className="n">This server knows these and this screen does not group them.</span>
                  </span>
                  {others.map((t) => (
                    <span className="mcx-oprow" key={t}>
                      <Switch checked={p.tools.includes(t)} label={t}
                        disabled={busy === `${p.key}:tools`}
                        onChange={(v) => toggleTool(t, v)} />
                      <span className="body">
                        <span className="line"><span className={`name${p.tools.includes(t) ? '' : ' off'}`}>{t}</span></span>
                      </span>
                    </span>
                  ))}
                </span>
              )}
            </span>
            <span className="mcx-capnote">
              A grant is validated server-side against its own list — an unknown tool is a 400, never
              a silent drop. The last tool cannot be removed: a profile with none can do nothing, and
              an empty grant is a no-op rather than a customisation.
            </span>
          </div>

          <label className="mcx-promptfield">
            <span className="eyebrow">System prompt</span>
            <textarea className="field-input" rows={7} value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What this subagent is told before it starts…" />
            <span className="hint">
              The whole of what this subagent reads before it starts. No code is wrapped around it —
              unlike the session defaults, what you write here is exactly what the model sees.
            </span>
          </label>

          {/* A TEXTAREA AND NOT AN INPUT, because this field holds PROSE — the
              built-in executor's own description is 120 characters of it. In a
              single-line input all but the first few words scroll out of sight,
              so the field the director actually reads is the one field nobody
              editing it can see. (The UI smoke caught this as an overflow-x
              finding, which is the shape that bug takes from the outside.) */}
          <label className="mcx-promptfield">
            <span className="eyebrow">Description</span>
            <textarea className="field-input" rows={2} value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="What the director reads when deciding whether to delegate to it…" />
            <span className="hint">
              This is what the DIRECTOR sees in its agent list — it is how the model decides whether
              to delegate at all, so it is a working field and not a label.
            </span>
          </label>

          <div className="mcx-foldacts">
            <label className="k-field inline">
              <span className="k-field-label">Model</span>
              <select className="k-select" value={p.model} disabled={busy === `${p.key}:model`}
                onChange={(e) => run(`${p.key}:model`, () => patchAgentProfile(p.key, { model: e.target.value }))}>
                {/* A model set through the API that this catalogue does not list
                    still shows, rather than being silently rewritten on the next
                    save — same rule as the tool ladder's "Other". */}
                {(PROFILE_MODELS.some((m) => m.model === p.model)
                  ? PROFILE_MODELS
                  : [...PROFILE_MODELS, { model: p.model, label: `${p.model} (set elsewhere)` }]
                ).map((m) => <option key={m.model} value={m.model}>{m.label}</option>)}
              </select>
            </label>

            <button className="k-btn sm" disabled={!dirty || busy === `${p.key}:text`}
              onClick={() => run(`${p.key}:text`, () => patchAgentProfile(p.key, { prompt, description: desc }))}>
              {busy === `${p.key}:text` ? 'Saving…' : 'Save text'}
            </button>

            {/* RESET, NOT DELETE, on a built-in — DELETE drops its stored
                override and hands the factory profile back, because the spawn
                path always needs 'executor' to exist. A "Delete" label would
                promise something the server will not do. */}
            <button className="k-btn sm secondary" disabled={busy === `${p.key}:del`}
              onClick={() => run(`${p.key}:del`, () => deleteAgentProfile(p.key))}>
              {p.builtin ? 'Reset to factory' : 'Delete profile'}
            </button>

            <span className="mcx-spacer" />
            <Switch checked={p.enabled} label={p.enabled ? 'On' : 'Off'} disabled={busy === `${p.key}:enabled`}
              onChange={(v) => run(`${p.key}:enabled`, () => patchAgentProfile(p.key, { enabled: v }))} />
          </div>
        </div>
      )}
    </section>
  );
}

/** The New-profile form. A key is permanent (it is what a roadmap item names),
 *  so it is only ever set here and never edited on a fold. */
function NewProfile({ knownTools, busy, onCancel, onCreate }: {
  knownTools: string[]; busy: boolean; onCancel: () => void;
  onCreate: (p: { key: string; name: string; description: string; prompt: string; model: string; tools: string[] }) => void;
}) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  // A NEW PROFILE OPENS READ-ONLY, deliberately. The engine's own default for an
  // unspecified `tools` is the full building set, which is the right default for
  // the executor it was written for and the wrong one for a form: a screen that
  // opens with write access ticked grants it to everybody who never looked.
  const [tools, setTools] = useState<string[]>(['Read', 'Grep', 'Glob']);
  const grant = grantLine(tools);

  const ok = /^[a-z][a-z0-9-]{1,39}$/.test(key) && prompt.trim().length > 0 && tools.length > 0;

  return (
    <section className="mcx-fold on">
      <header className="mcx-foldhead mcx-agenthead">
        <span className="caret">＋</span>
        <div className="body"><span className="name">New profile</span>
          <span className="role">A subagent an overnight run can be told to spawn.</span></div>
      </header>
      <div className="mcx-foldbody">
        <div className="mcx-newgrid">
          <label className="k-field">
            <span className="k-field-label">Key</span>
            <input className="field-input sm" value={key} placeholder="reviewer-strict"
              onChange={(e) => setKey(e.target.value.toLowerCase())} />
            <span className="hint">Permanent — it is what a roadmap item names. Lowercase, digits and hyphens.</span>
          </label>
          <label className="k-field">
            <span className="k-field-label">Name</span>
            <input className="field-input sm" value={name} placeholder="Strict reviewer"
              onChange={(e) => setName(e.target.value)} />
            <span className="hint">Blank falls back to the key.</span>
          </label>
        </div>
        <label className="mcx-promptfield">
          <span className="eyebrow">Description</span>
          <textarea className="field-input" rows={2} value={description}
            placeholder="What the director reads when deciding whether to delegate to it…"
            onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="mcx-promptfield">
          <span className="eyebrow">System prompt</span>
          <textarea className="field-input" rows={6} value={prompt}
            placeholder="You are…"
            onChange={(e) => setPrompt(e.target.value)} />
          <span className="hint">Required. A profile with no prompt is a blank, not a customisation.</span>
        </label>
        <div className="mcx-caps">
          <span className="eyebrow">Tools · {tools.length} of {knownTools.length} granted</span>
          <span className={`mcx-grant t-${grant.tone}`}>{grant.text}</span>
          <span className="mcx-tiers">
            {TOOL_TIERS.map((tier) => {
              const ts = tier.tools.filter((t) => knownTools.includes(t));
              if (!ts.length) return null;
              return (
                <span className="mcx-tier" key={tier.id}>
                  <span className="head"><span className="l">{tier.label}</span><span className="n">{tier.note}</span></span>
                  {ts.map((t) => (
                    <span className="mcx-oprow" key={t}>
                      <Switch checked={tools.includes(t)} label={t}
                        onChange={(v) => setTools(v ? [...tools, t] : tools.filter((x) => x !== t))} />
                      <span className="body"><span className="line">
                        <span className={`name${tools.includes(t) ? '' : ' off'}`}>{t}</span></span></span>
                    </span>
                  ))}
                </span>
              );
            })}
          </span>
        </div>
        <div className="mcx-foldacts">
          <button className="k-btn sm" disabled={!ok || busy}
            onClick={() => onCreate({ key, name, description, prompt, model: '', tools })}>
            {busy ? 'Creating…' : 'Create profile'}
          </button>
          <button className="k-btn sm secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </section>
  );
}


/* ---------- Models (WIRED) ---------- */

const MODEL_COLS: [string, string][] = [
  ['Model', 'c-id'], ['Seen in', 'c-ctx'], ['Tokens', 'c-use'],
  ['Cost', 'c-cost'], ['Share', 'c-p'], ['Policy', 'c-pick'],
];

function Models() {
  const [room, err, busy, reload] = useRoom<ModelsRoom>(getModelsRoom);
  const [open, setOpen] = useState<string | null>('anthropic');
  const [saving, setSaving] = useState('');
  const [saveErr, setSaveErr] = useState('');

  const setPolicy = async (patch: { autopilotExecutorModel?: string; autopilotAdvisorModel?: string }, token: string) => {
    setSaving(token); setSaveErr('');
    try { await patchSettings(patch); reload(); }
    catch (e) { setSaveErr((e as Error)?.message || 'That did not save.'); }
    finally { setSaving(''); }
  };

  if (busy && !room) return <Loading what="the model ledger" />;
  if (err) return <Failed err={err} onRetry={reload} />;
  if (!room) return null;

  const t = room.totals;
  const modelCount = room.providers.reduce((n, p) => n + p.models.length, 0);
  const autoPct = t.tokens > 0 ? (t.autoTokens / t.tokens) * 100 : 0;

  return (
    <div className="mcx-stack tight">
      <div className="mcx-intro">
        <span className="lede">
          {room.providers.length} backends · {modelCount} model{modelCount === 1 ? '' : 's'} measured
          over the last {room.windowDays} days. Every share on this screen is TOKEN-based: an
          interactive transcript carries no price, so cost-weighting one would describe the autopilot alone.
        </span>
      </div>

      {saveErr && <div className="action-error">{saveErr}</div>}

      {/* THE POLICY — and it governs ONE of the two populations below. #285
          inverted the pair: the ADVISOR runs the session and the EXECUTOR is
          the subagent it hands the write tools to. */}
      <Panel title="Autopilot policy" note="what an unattended run is spawned on">
        <div className="mcx-panelbody pairs">
          <label className="k-field">
            <span className="k-field-label">Advisor — runs the session</span>
            <select className="k-select" value={room.policy.advisor} disabled={saving === 'advisor'}
              onChange={(e) => setPolicy({ autopilotAdvisorModel: e.target.value }, 'advisor')}>
              {room.policy.advisorCatalogue.map((m) => <option key={m.model} value={m.model}>{m.label}</option>)}
            </select>
            <span className="k-field-hint">Main loop: plans, delegates, verifies, commits. Off = single-model on the executor.</span>
          </label>
          <label className="k-field">
            <span className="k-field-label">Executor — the subagent with the write tools</span>
            <select className="k-select" value={room.policy.executor} disabled={saving === 'executor'}
              onChange={(e) => setPolicy({ autopilotExecutorModel: e.target.value }, 'executor')}>
              {room.policy.executorCatalogue.map((m) => <option key={m.model} value={m.model}>{m.label}</option>)}
            </select>
            <span className="k-field-hint">Cheap hands. Default = whatever the CLI itself picks.</span>
          </label>
        </div>
      </Panel>

      {/* TWO POPULATIONS, NEVER ONE BAR. They answer to different policies —
          the autopilot's spend is what the picks above govern, and a model the
          owner chose by hand in a session is NOT drift. */}
      <Panel title="Where the tokens went" note={`${room.windowDays} days`}>
        {t.measured ? (
          <div className="mcx-panelbody rows">
            <span className="mcx-split">
              <span className="mcx-track wide two">
                <span className="fill auto" style={{ width: `${autoPct}%` }} />
              </span>
            </span>
            <div className="mcx-splitkeys">
              <span className="key auto">
                <span className="sw" />Autopilot runs — {compactTokens(t.autoTokens)} over {t.runs} run{t.runs === 1 ? '' : 's'}
              </span>
              <span className="key inter">
                <span className="sw" />Your own sessions — {compactTokens(t.interactiveTokens)} over {t.sessions} session{t.sessions === 1 ? '' : 's'}
              </span>
            </div>
            <div className="mcx-facts">
              {([
                ['Tokens', compactTokens(t.tokens)],
                // Priced runs ONLY. `n of m` is what stops this reading as the
                // whole bill: an interactive session has no price at all.
                ['Cost', `${usd(t.costUsd)} · ${t.pricedRuns} of ${t.runs} runs priced`],
                // A delegation whose transcript was lost is UNPRICED, not free,
                // and neither source counts every one — so `calls` is the max of
                // the two and `recorded` is how many left evidence.
                ['Delegations', `${t.delegations.calls} · ${t.delegations.recorded} with a transcript`],
                ['Models seen', String(modelCount)],
              ] as [string, string][]).map(([l, v]) => (
                <div className="fact" key={l}>
                  <span className="l">{l}</span>
                  <span className="v">{v}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          // NOT a row of zeroes. Nothing in the window carried a model, which is
          // a different statement from "the models did nothing".
          <div className="mcx-panelbody rows">
            <span className="mcx-absent">Nothing in the last {room.windowDays} days carried a model. No sessions, no runs — not a bill of $0.</span>
          </div>
        )}
      </Panel>

      {room.providers.map((p) => {
        const on = open === p.key;
        return (
          <section className={`mcx-fold${on ? ' on' : ''}`} key={p.key}>
            <header className="mcx-foldhead mcx-provhead" onClick={() => setOpen(on ? null : p.key)}>
              <span className="caret">{on ? '▾' : '▸'}</span>
              <span className="name">{p.name}</span>
              <span className="key">{p.reach}</span>
              <span className="share">
                <span className="mcx-track wide"><span className="fill viz" style={{ width: `${p.share}%` }} /></span>
                <span className="pct">{Math.round(p.share)}%</span>
              </span>
              <span className="latency">{p.models.length} model{p.models.length === 1 ? '' : 's'}</span>
              <span className="end"><Pill tone={p.tone}>{p.state}</Pill></span>
            </header>

            {on && (
              <>
                <div className="mcx-provdetail">{p.detail}</div>
                {p.models.length ? (
                  <>
                    <div className="mcx-row mcx-modelrow head">
                      {MODEL_COLS.map(([l, c]) => <span className={c} key={c}>{l}</span>)}
                    </div>
                    {p.models.map((m) => (
                      <div className="mcx-row mcx-modelrow hoverable" key={m.model}>
                        <span className="c-id" title={m.model}>{m.label}</span>
                        {/* The POPULATION SPLIT, per row. Two numbers rather
                            than one total, because a model that appears in both
                            is the case the merged bar would have hidden. */}
                        <span className="c-ctx">{m.runs}r · {m.sessions}s</span>
                        <span className="c-use">{compactTokens(m.tokens)}</span>
                        <span className="c-cost">{money(m.costUsd)}</span>
                        <span className="c-p">{m.share.toFixed(1)}%</span>
                        {/* "unassigned" is an ANSWER, not decoration, so it does
                            not take the kit's --text-disabled: that tone
                            measures under AA, and the Plans dash refused it for
                            the same reason.
                            THE MATCH IS BY ALIAS AND THE TOOLTIP SAYS SO. The
                            policy holds 'sonnet' and a transcript records the id
                            the CLI resolved it to, so a role lands on every
                            sonnet the window saw — which is the truth about what
                            the setting covers, and misreads as a claim about one
                            model unless the alias is named. */}
                        <span className={`c-pick${m.roles.length ? ' picked' : ''}`}
                          title={m.roles.length
                            ? m.roles.map((r) => `${r} = "${r === 'executor' ? room.policy.executor : room.policy.advisor}"`).join(' · ')
                            : 'Neither policy alias matches this id'}>
                          {m.roles.length ? m.roles.join(' + ') : 'unassigned'}
                        </span>
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="mcx-provempty">
                    Nothing measured on this backend in the window.
                    {p.key === 'omniroute' ? ' Stack cannot see it from here either way — this is not a claim that it is idle.' : ''}
                  </div>
                )}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* ---------- Loops (MOCK) ---------- */

function Loops() {
  const [states, setStates] = useState<Record<string, boolean>>(
    () => Object.fromEntries(LOOPS.map((l) => [l.name, l.state === 'on'])),
  );
  const active = Object.values(states).filter(Boolean).length;

  return (
    <div className="mcx-stack tight">
      <MockNote>
        The kit's sample loops. Stack has ONE arm switch (`autopilotEnabled`) and three gates
        deciding who runs — the fleet cap, per-project serialisation and the area lane — and
        per-project cannot become a knob, so a per-loop toggle is not the shape this wires to.
      </MockNote>
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

/* ---------- Connections (MOCK) ---------- */

function Connections() {
  return (
    <div className="mcx-stack tight">
      <MockNote>
        The kit's sample integrations. The real answer is `geminiReady`, `terminal.connected` and the
        provider keys `terminal/model-switch.mjs` resolves — and the trap is that the kit has a tone
        for Offline and Degraded and none at all for UNKNOWN. The Models tab already draws that one.
      </MockNote>
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

/* ---------- Context (WIRED) ----------

   NOT a CLAUDE.md library. Read this file's header and
   server/src/routes/context.js's before changing anything here: the managed
   library was culled for cause, and the Edit button below writes exactly two
   fields — an agent's standing guidance and the ✧ assist steer — both of which
   were already hand-written settings with their own PATCH routes. A doc with no
   `edit` has no button at all, which is what stops this shape drifting back
   into a writer. */

const DOC_KIND: Record<string, { icon: KitIconName; label: string }> = {
  root: { icon: 'terminal', label: 'Root' },
  agent: { icon: 'users', label: 'Agent' },
  assist: { icon: 'file-text', label: 'Assist' },
};

function Context() {
  const [room, err, busy, reload] = useRoom<ContextRoom>(getContextRoom);
  const [sel, setSel] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');

  if (busy && !room) return <Loading what="the context" />;
  if (err) return <Failed err={err} onRetry={reload} />;
  if (!room) return null;

  const doc = room.docs.find((d) => d.id === sel) ?? room.docs[0];
  const words = room.docs.reduce((n, d) => n + d.words, 0);

  const pick = (id: string) => { setSel(id); setEditing(false); setSaveErr(''); };
  const startEdit = () => { setDraft(doc.edit?.value ?? ''); setEditing(true); setSaveErr(''); };

  const save = async () => {
    if (!doc.edit) return;
    setSaving(true); setSaveErr('');
    try {
      if (doc.edit.kind === 'profile-prompt' && doc.edit.agentKey) {
        await patchAgentProfile(doc.edit.agentKey, { prompt: draft });
      } else {
        await patchSettings({ assistGuidance: draft });
      }
      setEditing(false);
      reload();
    } catch (e) {
      setSaveErr((e as Error)?.message || 'That did not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mcx-stack tight">
      <div className="mcx-intro">
        <span className="lede">
          {room.docs.length} pieces of prompt text · {words.toLocaleString()} words. This is what
          Stack itself puts in front of a model — the session block every session starts with, each
          spawn profile's prompt, and the ✧ steer. It is NOT a copy of any repo's CLAUDE.md.
        </span>
      </div>

      <div className="mcx-ctx">
        <section className="mcx-doctree">
          {room.docs.map((d) => {
            const k = DOC_KIND[d.kind] ?? DOC_KIND.assist;
            const root = d.kind === 'root';
            return (
              <button key={d.id} type="button"
                className={`mcx-docrow kind-${d.kind}${root ? ' root' : ''}${doc.id === d.id ? ' on' : ''}`}
                onClick={() => pick(d.id)}>
                {!root ? <span className="tick" /> : null}
                <span className="ic" aria-label={k.label}><KitIcon name={k.icon} size={root ? 14 : 12} /></span>
                <span className="path">{d.path}</span>
                {/* A null read count is a DASH. Nothing counts how often the ✧
                    steer is read, and a 0 there would be a claim nobody made. */}
                <span className="reads">{d.reads === null ? '—' : d.reads}</span>
              </button>
            );
          })}
          <div className="mcx-docfoot">
            A repo's CLAUDE.md is the repo's. Stack holds no copy and nothing here writes one —
            the managed library that did was culled after a stale copy silently reverted a project's
            own file for several sessions running.
          </div>
        </section>

        <section className={`mcx-docview kind-${doc.kind}`}>
          <header className="mcx-docviewhead">
            <span className="path">{doc.path}</span>
            <Pill tone={doc.reads ? 'success' : 'neutral'}>
              {doc.reads === null ? 'not counted' : doc.reads ? `${doc.reads} ${doc.readsLabel}` : `no ${doc.readsLabel || 'reads'} yet`}
            </Pill>
            <span className="meta">{doc.words} words · {doc.meta}</span>
            <span className="acts">
              {/* NO `edit`, NO BUTTON. The session-defaults block is rendered
                  from a code catalogue and switched in Settings; offering an
                  Edit here would be a second place to set one truth. */}
              {doc.edit ? (
                editing ? (
                  <>
                    <button className="k-btn sm ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
                    <button className="k-btn sm accent" onClick={save} disabled={saving}>
                      <KitIcon name="check" size={13} />{saving ? 'Saving…' : 'Save'}
                    </button>
                  </>
                ) : (
                  <button className="k-btn sm secondary" onClick={startEdit}>
                    <KitIcon name="pencil" size={13} />Edit {doc.edit.label.toLowerCase()}
                  </button>
                )
              ) : (
                <a className="k-btn sm ghost" href={hrefTo.settings}>
                  <KitIcon name="settings" size={13} />Settings
                </a>
              )}
            </span>
          </header>

          <div className="mcx-docscope">
            <span className="line">
              <span className="eyebrow">Read by</span>
              <span className="who">{doc.scope}</span>
              {doc.inherits ? <span className="inherits">plus the session block</span> : null}
            </span>
            <span className="summary">{doc.summary}</span>
            {doc.note ? <span className="summary quiet">{doc.note}</span> : null}
          </div>

          {saveErr && <div className="action-error">{saveErr}</div>}

          {editing && doc.edit ? (
            <>
              <div className="mcx-edithint">{doc.edit.hint}</div>
              <textarea className="mcx-doceditor" value={draft} spellCheck={false}
                aria-label={doc.edit.label} onChange={(e) => setDraft(e.target.value)} />
            </>
          ) : doc.body ? (
            <div className="mcx-docbody">
              {doc.body.split('\n').map((line, i) => <MdLine key={i} line={line} n={i + 1} />)}
            </div>
          ) : (
            <div className="mcx-docempty">
              <span className="t">
                {doc.edit ? 'Nothing written yet.' : 'Every line of this block is switched off, so nothing is injected.'}
              </span>
              {doc.edit
                ? <button className="k-btn sm accent" onClick={startEdit}><KitIcon name="pencil" size={13} />Write it</button>
                : <a className="k-btn sm secondary" href={hrefTo.settings}>Turn some on</a>}
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
      <span className={cls}>{text || ' '}</span>
    </div>
  );
}

/* ---------- Settings (MOCK) ---------- */

function SettingsTab() {
  const [approve, setApprove] = useState(true);
  const [cap, setCap] = useState(true);
  const [local, setLocal] = useState(false);
  const [log, setLog] = useState(true);

  return (
    <div className="mcx-stack tight narrow">
      <MockNote>
        The kit's sample guardrails. `#/settings` is the real, wired screen; two rows below have no
        counterpart at all (revoke every key, delete 209 transcripts) and both destroy, which the
        fail-safe rules have a direction for that nobody has applied to them yet.
      </MockNote>

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
