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
//  • AGENTS (wired) is the tab-agent REGISTRY plus its config row —
//    `server/src/agents.js` and `agent_configs`. It is NOT `agent_profiles`,
//    which is the autopilot's spawn catalogue and a different thing that
//    arrived under the same word; merging the two is the trap the port's header
//    named and this screen does not go near it. The Curator is the only agent
//    left, so the room is one fold: five ops, two backends, one switch each.
//    THE "CAN DO" LIST IS STILL NOT EDITABLE. An op is CODE. What the switches
//    do is turn one OFF (`ops_off`), which is a real server field whose own
//    refusal sentence says "(Mission Control → Agents)" — this screen is the
//    surface that sentence has been pointing at.
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
//    things that really do: the session defaults, each agent's preamble, and the
//    ✧ assist steer. Two of those are the owner's own words and carry the Edit
//    button; the rest is code and has no button at all.
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
  AgentRow, AgentsRoom, ContextRoom, ModelsRoom,
} from '../types';
import {
  getAgentsRoom, getContextRoom, getModelsRoom, patchAgent, patchSettings,
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

/** "3 days ago" / "just now", off an ISO stamp. '' for a missing one. */
function ago(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function MissionControl() {
  const [tab, setTab] = useState<McTab>('agents');
  // The Agents room rides at screen level because the HEADER reads it too: the
  // host daemon is the frame around every switch on this screen, and a page
  // that says "2 agents running" while the daemon is down is the sample-data
  // lie the kit port's header was written about.
  const [agents, agentsErr, agentsBusy, reloadAgents] = useRoom<AgentsRoom>(getAgentsRoom);

  const live = agents?.agents.filter((a) => a.enabled).length ?? 0;
  const hostReady = agents?.hostReady ?? false;

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
            {/* The one fact worth stating on every tab: can anything run at all.
                A Claude-backed op needs the daemon and a Gemini-backed one needs
                the key, and they are fixed in completely different places, so
                both are named rather than reduced to one light. */}
            {agents && (
              <span className={`mcx-liveflag${hostReady ? '' : ' off'}`}>
                <span className="dot" />
                {hostReady
                  ? `Host connected · ${live} agent${live === 1 ? '' : 's'} on`
                  : 'Host daemon offline — no Claude-backed op can run'}
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

function Agents({ room, onChanged }: { room: AgentsRoom; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(room.agents[0]?.key ?? null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const write = async (key: string, patch: Parameters<typeof patchAgent>[1], token: string) => {
    setBusy(token); setErr('');
    try { await patchAgent(key, patch); onChanged(); }
    catch (e) { setErr((e as Error)?.message || 'That did not save.'); }
    finally { setBusy(''); }
  };

  const on = room.agents.filter((a) => a.enabled).length;

  return (
    <div className="mcx-stack tight">
      <div className="mcx-intro">
        <span className="lede">
          {room.agents.length === 1 ? 'One agent' : `${room.agents.length} agents`} · {on} on.
          An agent is bound to ONE surface and cannot act anywhere else, and its op list is code —
          what you set here is whether it runs, on which model, and which of its ops are switched off.
        </span>
        {/* The kit's "New agent" button is gone rather than inert: an agent is a
            registry entry in server/src/agents.js, so there is no write a
            browser could make that would create one. What the slot carries
            instead is the thing every switch below depends on. */}
        <span className="mcx-backends">
          <Pill tone={room.hostReady ? 'success' : 'warning'}>
            {room.hostReady ? 'Host daemon connected' : 'Host daemon offline'}
          </Pill>
          <Pill tone={room.geminiReady ? 'success' : 'neutral'}>
            {room.geminiReady ? 'Gemini key set' : 'Gemini absent'}
          </Pill>
        </span>
      </div>

      {err && <div className="action-error">{err}</div>}

      {room.agents.map((a) => (
        <AgentFold key={a.key} a={a} room={room} open={open === a.key}
          onToggle={() => setOpen(open === a.key ? null : a.key)}
          busy={busy} write={write} />
      ))}
    </div>
  );
}

/**
 * An agent's state in one word. FOUR answers, not two, because "on" and "able
 * to act" are different questions and the owner fixes them in different places:
 * the switch is theirs, the backend is the host's or the key's. An agent whose
 * ops straddle two backends can be HALF ready, and saying "ready" there sends
 * somebody to press a button that 503s.
 */
function agentState(a: AgentRow, room: AgentsRoom): { label: string; tone: Tone } {
  if (!a.enabled) return { label: 'Switched off', tone: 'neutral' };
  const live = a.ops.filter((o) => o.enabled);
  if (!live.length) return { label: 'Every op off', tone: 'neutral' };
  const runnable = live.filter((o) => (o.backend === 'gemini' ? room.geminiReady : room.hostReady));
  if (!runnable.length) return { label: 'No backend', tone: 'warning' };
  if (runnable.length < live.length) return { label: 'Partly ready', tone: 'info' };
  return { label: 'Ready', tone: 'success' };
}

function AgentFold({ a, room, open, onToggle, busy, write }: {
  a: AgentRow; room: AgentsRoom; open: boolean; onToggle: () => void; busy: string;
  write: (key: string, patch: Parameters<typeof patchAgent>[1], token: string) => void;
}) {
  const state = agentState(a, room);
  const live = a.ops.filter((o) => o.enabled).length;

  return (
    <section className={`mcx-fold${open ? ' on' : ''}`}>
      <header className="mcx-foldhead mcx-agenthead" onClick={onToggle}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <div className="body">
          <span className="name">{a.name}</span>
          <span className="role">{a.blurb}</span>
        </div>
        <span className="model">{a.model || 'CLI default'}</span>
        {/* The kit's "autonomy" column, answered by the rule rather than by a
            setting: an agent ANNOTATES and the human disposes. Nothing an agent
            returns writes a tracker row, and there is no level above this one to
            promote it to — so it is a fact, not a control. */}
        <span className="autonomy">annotates only</span>
        <span className="spend">{usd(a.costUsd)}</span>
        <span className="end"><Pill tone={state.tone}>{state.label}</Pill></span>
      </header>

      {open && (
        <div className="mcx-foldbody">
          <div className="mcx-facts">
            {([
              ['Surface', `${a.tabLabel} ${a.surface}`],
              ['Runs', String(a.runs)],
              ['Last run', a.lastRunAt ? `${a.lastOp || '—'} · ${ago(a.lastRunAt)}` : 'never'],
              // 0 is "has not spent", not "does not cost". Gemini ops record a
              // real 0 because the free tier prices nothing.
              ['Spend', usd(a.costUsd)],
            ] as [string, string][]).map(([l, v]) => (
              <div className="fact" key={l}>
                <span className="l">{l}</span>
                <span className="v">{v}</span>
              </div>
            ))}
          </div>

          {a.lastOutcome && a.lastOutcome !== 'ok' && (
            <div className="mcx-lastfail">Last answer: {a.lastOutcome}</div>
          )}

          <div className="mcx-caps">
            <span className="eyebrow">Can do · {live} of {a.ops.length} on</span>
            {/* AN OP IS CODE. `server/src/agents.js` is the registry and it is
                the whole restriction #361 is about — a route binds to one agent
                and throws on anybody else's op. So this list cannot be added to
                or taken from here; each row's switch writes `ops_off`, which is
                the owner saying "not this one", and is the field gateDecision's
                refusal already points at this screen for. */}
            <span className="mcx-oprows">
              {a.ops.map((o) => {
                const backendUp = o.backend === 'gemini' ? room.geminiReady : room.hostReady;
                const token = `${a.key}:${o.op}`;
                return (
                  <span className="mcx-oprow" key={o.op}>
                    <Switch checked={o.enabled} label={o.label} disabled={busy === token}
                      onChange={(v) => write(a.key, { op: o.op, opEnabled: v }, token)} />
                    <span className="body">
                      <span className="line">
                        <span className={`name${o.enabled ? '' : ' off'}`}>{o.label}</span>
                        <span className="chip">{o.op}</span>
                        {/* WHICH BACKEND, NAMED. A Gemini op needs a key on the
                            server and a Claude op needs the host on the line;
                            one "cannot run" sends the owner to restart a daemon
                            that was never involved. */}
                        <span className={`chip backend${backendUp ? '' : ' down'}`}>
                          {o.backend === 'gemini' ? 'Gemini' : 'Claude · host'}
                          {backendUp ? '' : ' · down'}
                        </span>
                      </span>
                      <span className="hint">{o.hint}</span>
                    </span>
                  </span>
                );
              })}
            </span>
            <span className="mcx-capnote">
              An agent's ops are code (server/src/agents.js) — these switches turn one off, they
              cannot add one. A switched-off op refuses with that sentence rather than failing quietly.
            </span>
          </div>

          <div className="mcx-foldacts">
            <label className="k-field inline">
              <span className="k-field-label">Model</span>
              <select className="k-select" value={a.model} disabled={busy === `${a.key}:model`}
                onChange={(e) => write(a.key, { model: e.target.value }, `${a.key}:model`)}>
                {room.models.map((m) => <option key={m.model} value={m.model}>{m.label}</option>)}
              </select>
            </label>
            {/* The pin is a CLAUDE alias and is not forwarded to a Gemini op —
                handing 'sonnet' to Gemini 404s the call — so an agent with ops
                on both backends has to be told the pick only covers one. */}
            {a.ops.some((o) => o.backend === 'gemini') && (
              <span className="mcx-modelnote">Covers its Claude ops only; the Gemini reads keep the server default.</span>
            )}
            <span className="mcx-spacer" />
            <Switch checked={a.enabled} label={a.enabled ? 'On' : 'Off'} disabled={busy === `${a.key}:enabled`}
              onChange={(v) => write(a.key, { enabled: v }, `${a.key}:enabled`)} />
          </div>

          <div className="mcx-remit">
            <span className="eyebrow">Remit</span>
            <span className="t">{a.remit}</span>
          </div>
        </div>
      )}
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
      if (doc.edit.kind === 'agent-guidance' && doc.edit.agentKey) {
        await patchAgent(doc.edit.agentKey, { guidance: draft });
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
          agent's preamble, and the ✧ steer. It is NOT a copy of any repo's CLAUDE.md.
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
