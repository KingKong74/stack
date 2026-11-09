// MISSION CONTROL: Agents, Models and Context read and write this installation.
// Settings is a mockup and wears a Mock chip ON ITS OWN TAB (#482/#496): a chip
// over the whole screen would warn about the three tabs it is wrong for, and
// the mock looks exactly like the real thing.
//
// THE LAYOUT IS THE v5 DESIGN (claude.ai/design, "Mission Control v5"): stat
// tiles over each tab, the Agents catalogue as a table with a modal editor, the
// policy as harness-then-model, the backends grouped into harnesses and the
// rest, and Context as a file tree with a "Seen by" lens. The design assumes
// three things Stack does not have yet, and each is drawn as ABSENT rather
// than faked:
//
//  • PROJECT-SCOPED PROFILES. `agent_profiles.key` is globally UNIQUE, so every
//    profile applies to every project. The design's Scope chips and the
//    modal's Scope select would be a control that writes nothing, so the table
//    shows one "Global" group and the modal states the scope read-only.
//  • A CODEX ADVISOR OR EXECUTOR. The autopilot spawns `claude -p` and nothing
//    else, so the policy's Codex and Copilot buttons are drawn disabled, each
//    saying why. Codex is a terminal-only harness (server/src/routes/models.js).
//  • CODEX USAGE. The transcript hook is Claude Code's, so a Codex session
//    rarely leaves a model row. An empty Codex row says that, never "idle".
//
// THE FOUR ANSWERS THE AGENTS TAB OWES (from #520, unchanged by the redesign):
//  1. Whether anything spawns at all. `--agents` is passed only when an ADVISOR
//     is set; with none every profile is inert, and the tab leads with that.
//  2. What a run actually resolves to (`defaultSpawn`, the server's own answer).
//  3. What a tool grant means, in a sentence (`grantLine`).
//  4. That a spawn always has a builder: resolveSpawn falls back to the built-in
//     executor, or the expensive director would silently do the building.
// A built-in is RESET, never deleted: DELETE drops its stored override.
//
// MODELS keeps TWO POPULATIONS APART: autopilot runs answer to the policy and a
// human's own sessions never do. Every share is TOKEN-based, because an
// interactive transcript carries no price. A number that cannot be measured is
// a DASH, never a zero.
//
// CONTEXT reads each repo's CLAUDE.md and AGENTS.md LIVE off the host. Nothing
// is stored; a Save writes the file and is refused if it changed on disk since
// it was opened (`server/src/routes/context.js`'s header is the long version).
// The "Seen by" lens is a fact about the harness, not a preference: a Codex
// terminal gets no SessionStart hook, so no session-defaults block, and reads
// CLAUDE.md only where the repo's AGENTS.md points at it.
//
// NOTHING ON THE MOCK TAB IS A FACT ABOUT THIS INSTALLATION: its switches are
// local state that leaving the page undoes. `#/settings` is the real screen.

import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  AgentProfile, AgentProfilesRoom, ClaudeMdFile, ClaudeMdRead, ContextDoc, ContextRoom,
  ModelProvider, ModelsRoom,
} from '../types';
import {
  getAgentProfiles, getContextRoom, getModelsRoom, patchAgentProfile,
  createAgentProfile, deleteAgentProfile, patchSettings, getClaudeMd, putClaudeMd,
} from '../store';
import { compactTokens } from '../lib/spine';
import { hrefTo } from '../lib/route';
import { TopBar } from '../components/TopBar';

type Tone = 'info' | 'warning' | 'success' | 'danger' | 'neutral';
type McTab = 'agents' | 'models' | 'context' | 'settings';

const TABS: { value: McTab; label: string; mock?: boolean }[] = [
  { value: 'agents', label: 'Agents' },
  { value: 'models', label: 'Models' },
  { value: 'context', label: 'Context' },
  { value: 'settings', label: 'Settings', mock: true },
];

/* ---------- the pieces the tabs share ---------- */

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`mc-pill mc-t-${tone}`}>{children}</span>;
}

// A real `role="switch"` button: a toggle a keyboard cannot reach is not one.
function Switch({ checked, onChange, label, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      className={`mc-switch${checked ? ' on' : ''}`}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}>
      <span className="knob" />
    </button>
  );
}

function Tile({ label, value, line, accent }: { label: string; value: string; line: ReactNode; accent?: boolean }) {
  return (
    <div className="mc-tile">
      <span className="eyebrow">{label}</span>
      <code className={`v${accent ? ' accent' : ''}`}>{value}</code>
      <span className="line">{line}</span>
    </div>
  );
}

function Card({ title, note, children, className }: {
  title: string; note?: string; children: ReactNode; className?: string;
}) {
  return (
    <section className={`mc-card${className ? ` ${className}` : ''}`}>
      <header className="mc-cardhead"><span className="t">{title}</span>{note ? <span className="note">{note}</span> : null}</header>
      {children}
    </section>
  );
}

// A read that FAILED says so: an empty screen where a fetch died reads as
// "nothing here".
function Loading({ what }: { what: string }) {
  return <div className="mc-state">Reading {what}…</div>;
}
function Failed({ err, onRetry }: { err: string; onRetry: () => void }) {
  return (
    <div className="mc-state bad">
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

const usd = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
/** null = UNPRICED. A dash, never $0.00: a transcript carries no cost. */
const money = (n: number | null) => (n === null ? '—' : usd(n));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Each harness's tone, by ROLE: styles.css maps `h-<key>` to a token.
const HARNESS_KEYS = ['anthropic', 'codex', 'copilot'] as const;

export function MissionControl() {
  const [tab, setTab] = useState<McTab>('agents');
  // The profile modal rides at screen level, because Context's "Edit in Agents"
  // opens it from another tab.
  const [modal, setModal] = useState<string | null>(null);
  // The Agents room rides here too, because the HEADER reads it: the one fact
  // worth stating on every tab is whether a run spawns subagents at all.
  const [agents, agentsErr, agentsBusy, reloadAgents] = useRoom<AgentProfilesRoom>(getAgentProfiles);

  const live = agents?.profiles.filter((p) => p.enabled).length ?? 0;
  const spawns = agents?.policy.spawnsAgents ?? false;

  return (
    <div className="mc-ground">
      <TopBar
        crumb={[{ label: 'Projects', href: hrefTo.dashboard }, { label: 'Mission Control', href: hrefTo.control }]}
        actions={<a className="btn-repo" href={hrefTo.terminal()} title="Back to the terminal">Terminal</a>} />

      <div className="page detail mc">
        <div className="mc-head">
          <div className="mc-title">
            <span className="eyebrow">Machine room</span>
            <h1>Mission Control</h1>
          </div>
          <span className="mc-headacts">
            {agents && (
              <span className={`mc-flag${spawns ? '' : ' off'}`}>
                <span className="dot" />
                {spawns
                  ? <>Director · Claude Code <code>{agents.policy.advisorModel}</code> · {plural(live, 'profile')} on</>
                  : <>No advisor set: <code>no subagents spawn</code></>}
              </span>
            )}
            <a className="k-btn sm secondary" href={hrefTo.settings}>Settings</a>
          </span>
        </div>

        <nav className="mc-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.value} role="tab" aria-selected={tab === t.value}
              className={`mc-tab${tab === t.value ? ' on' : ''}`} onClick={() => setTab(t.value)}>
              {t.label}
              {t.mock && (
                <span className="con-navsoon mock"
                  title="A mockup. It reads and writes nothing.">Mock</span>
              )}
            </button>
          ))}
        </nav>

        {tab === 'agents' && (
          agentsBusy && !agents ? <Loading what="the agents" />
            : agentsErr ? <Failed err={agentsErr} onRetry={reloadAgents} />
              : agents ? <Agents room={agents} onChanged={reloadAgents} onOpen={setModal} /> : null
        )}
        {tab === 'models' && <Models />}
        {tab === 'context' && <Context onEditProfile={(key) => { setTab('agents'); setModal(key); }} />}
        {tab === 'settings' && <SettingsTab />}
      </div>

      {modal && agents && (
        <ProfileModal key={modal} room={agents} profileKey={modal === '+new' ? null : modal}
          onClose={() => setModal(null)} onChanged={reloadAgents} />
      )}
    </div>
  );
}

/* ---------- Agents (WIRED) ---------- */

/** '' = inherit the spawn's executor model. The rest are the CLI's own aliases. */
const PROFILE_MODELS: { model: string; label: string }[] = [
  { model: '', label: 'Inherit (executor model)' },
  { model: 'haiku', label: 'haiku' },
  { model: 'sonnet', label: 'sonnet' },
  { model: 'opus', label: 'opus' },
];

// The tool ladder, worst-last: three tools change what a subagent can DO to a
// checkout, the rest only how much it can see. KEYED OFF THE SERVER'S
// `knownTools`: a tool the server knows and this list does not lands in
// "Other" rather than vanishing, because a grant nobody can see is a grant
// nobody revokes.
const TOOL_TIERS: { id: string; label: string; note: string; tools: string[] }[] = [
  { id: 'read', label: 'Read', note: 'Look at the checkout. Cannot change it.', tools: ['Read', 'Grep', 'Glob'] },
  { id: 'run', label: 'Run', note: 'Builds, tests, git. Can change the tree.', tools: ['Bash'] },
  { id: 'write', label: 'Write', note: 'Edit and create files.', tools: ['Edit', 'Write'] },
  { id: 'reach', label: 'Reach out', note: 'Fetch URLs, search the web.', tools: ['WebFetch', 'WebSearch'] },
];

/**
 * What a grant MEANS, as one sentence. Derived, never stored, so it cannot
 * drift from the toggles. The no-write case matters most: the built-in
 * Reviewer's description promises it never writes, and ticking Edit must not
 * leave that promise standing in silence.
 */
function grantLine(tools: string[]): { text: string; tone: Tone } {
  const writes = tools.some((t) => t === 'Edit' || t === 'Write');
  const runs = tools.includes('Bash');
  const reaches = tools.some((t) => t === 'WebFetch' || t === 'WebSearch');
  const out = reaches ? ', and can reach the network' : '';
  if (writes) return { text: `Writes files${runs ? ' and runs commands' : ''}${out}. Anything it does lands in the worktree.`, tone: 'warning' };
  if (runs) return { text: `Runs commands but cannot edit a file${out}. A build or a test can still change the tree.`, tone: 'info' };
  if (reaches) return { text: 'Reads only, and can reach the network. Nothing it says lands on its own.', tone: 'neutral' };
  return { text: 'Reads only. Nothing it says lands without something else acting on it.', tone: 'neutral' };
}

/** "On" and "would actually spawn" are different questions. */
function profileState(p: AgentProfile, room: AgentProfilesRoom): { label: string; tone: Tone } {
  if (!room.policy.spawnsAgents) return { label: 'Inert: no advisor', tone: 'warning' };
  if (!p.enabled) return { label: 'Switched off', tone: 'neutral' };
  if (room.defaultSpawn.keys.includes(p.key)) return { label: 'Spawns by default', tone: 'success' };
  const named = room.usage[p.key] ?? 0;
  if (named > 0) return { label: `${plural(named, 'item')} ask for it`, tone: 'info' };
  // On, spawnable, and nothing asks for it: the state this feature fails in.
  return { label: 'Nothing requests it', tone: 'neutral' };
}

function Agents({ room, onChanged, onOpen }: {
  room: AgentProfilesRoom; onChanged: () => void; onOpen: (key: string) => void;
}) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const on = room.profiles.filter((p) => p.enabled).length;
  const builtins = room.profiles.filter((p) => p.builtin).length;
  const { policy, defaultSpawn } = room;

  const toggle = async (p: AgentProfile, v: boolean) => {
    setBusy(p.key); setErr('');
    try { await patchAgentProfile(p.key, { enabled: v }); onChanged(); }
    catch (e) { setErr((e as Error)?.message || 'That did not save.'); }
    finally { setBusy(''); }
  };

  return (
    <div className="mc-stack">
      <div className="mc-tiles">
        <Tile label="Director" value={policy.advisorModel || 'off'} line="plans, delegates, commits" />
        <Tile label="Executor model" value={policy.executorModel || 'CLI default'} line="what every profile inherits" />
        <Tile label="Default spawn" value={defaultSpawn.keys.join(', ') || '—'} line={defaultSpawn.reason} accent />
        <Tile label="Profiles on" value={`${on} of ${room.profiles.length}`}
          line={`${builtins} built-in · ${room.profiles.length - builtins} added`} />
      </div>

      {/* THE FRAME, FIRST: with no advisor nothing below spawns at all. */}
      {!policy.spawnsAgents && (
        <div className="mc-banner warning">
          Nothing on this tab spawns. A run passes <code>--agents</code> only when an advisor model is
          set; with none, it is one model on the executor and the director does its own building. Set
          one on the Models tab.
        </div>
      )}
      {defaultSpawn.fallback && (
        <div className="mc-banner info">A run naming no profile fell back to the built-in executor: {defaultSpawn.reason}</div>
      )}

      <div className="mc-sechead">
        <div>
          <h2>Subagent profiles</h2>
          <p>
            Each profile is a subagent an autopilot run can spawn: its own prompt, model and tools, with
            a context isolated from the director's. Every profile applies to every project; project
            profiles aren't wired yet.
          </p>
        </div>
        <button className="k-btn" onClick={() => onOpen('+new')}>New profile</button>
      </div>

      {err && <div className="action-error">{err}</div>}

      <div className="mc-table mc-agents">
        <div className="mc-tr head">
          <span className="who">Profile</span><span>Model</span>
          {TOOL_TIERS.map((t) => <span key={t.id} className="tier">{t.label}</span>)}
          <span>Items</span><span>Status</span><span className="end">On</span>
        </div>
        <div className="mc-group"><span className="t">Global</span><span className="note">every project</span></div>
        {room.profiles.map((p) => {
          const st = profileState(p, room);
          return (
            <div key={p.key} className={`mc-tr row${p.enabled ? '' : ' dim'}`} role="button" tabIndex={0}
              onClick={() => onOpen(p.key)}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpen(p.key); }}>
              <div className="who">
                <span className="nameline">
                  <span className="name">{p.name}</span>
                  <span className="key">{p.key}</span>
                  {p.builtin && <span className="chip">built-in</span>}
                </span>
                <span className="desc">{p.description || 'No description, so the director has nothing to decide by.'}</span>
              </div>
              <span className="model">{p.model || 'inherit'}</span>
              {TOOL_TIERS.map((t) => {
                const known = t.tools.filter((x) => room.knownTools.includes(x));
                const n = known.filter((x) => p.tools.includes(x)).length;
                return (
                  <span key={t.id} className={`tier n${n ? ' lit' : ''}${n && t.id === 'write' ? ' w' : ''}`}
                    title={n ? known.filter((x) => p.tools.includes(x)).join(', ') : 'none granted'}>
                    {n}/{known.length}
                  </span>
                );
              })}
              <span className="items">{room.usage[p.key] ?? 0}</span>
              <span><Pill tone={st.tone}>{st.label}</Pill></span>
              <span className="end">
                <Switch checked={p.enabled} label={`${p.name} on`} disabled={busy === p.key}
                  onChange={(v) => toggle(p, v)} />
              </span>
            </div>
          );
        })}
      </div>

      <div className="mc-footnotes">
        <div>
          <span className="t">Open items, not spawn history</span>
          <span className="b">Counts are open items that would spawn a profile. Stack doesn't record which subagents a run actually used, so a "last run" here would be invented.</span>
        </div>
        <div>
          <span className="t">There's always a builder</span>
          <span className="b">If no profile survives (all off, or a requested one is gone), the run falls back to the built-in executor and logs why. Otherwise the director would do the building itself.</span>
        </div>
      </div>
    </div>
  );
}

const KEY_RE = /^[a-z][a-z0-9-]{1,39}$/;

/** The profile editor, for an existing profile or (profileKey null) a new one. */
function ProfileModal({ room, profileKey, onClose, onChanged }: {
  room: AgentProfilesRoom; profileKey: string | null; onClose: () => void; onChanged: () => void;
}) {
  const p = profileKey ? room.profiles.find((x) => x.key === profileKey) ?? null : null;
  const isNew = !profileKey;
  const [key, setKey] = useState('');
  const [name, setName] = useState(p?.name ?? '');
  const [desc, setDesc] = useState(p?.description ?? '');
  const [prompt, setPrompt] = useState(p?.prompt ?? '');
  const [model, setModel] = useState(p?.model ?? '');
  // A new profile opens READ-ONLY: anything more is a grant made on purpose.
  const [tools, setTools] = useState<string[]>(p?.tools ?? room.knownTools.filter((t) => ['Read', 'Grep', 'Glob'].includes(t)));
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  if (!isNew && !p) return null;

  const clash = isNew && room.profiles.some((x) => x.key === key);
  const valid = (isNew ? KEY_RE.test(key) && !clash : true) && prompt.trim().length > 0 && tools.length > 0;
  const dirty = isNew || !p ? true
    : name !== p.name || desc !== p.description || prompt !== p.prompt || model !== p.model
      || tools.length !== p.tools.length || tools.some((t) => !p.tools.includes(t));
  const grant = grantLine(tools);
  const st = p ? profileState(p, room) : null;

  const act = async (token: string, fn: () => Promise<unknown>, close = true) => {
    setBusy(token); setErr('');
    try { await fn(); onChanged(); if (close) onClose(); }
    catch (e) { setErr((e as Error)?.message || 'That did not save.'); }
    finally { setBusy(''); }
  };

  const save = () => {
    if (!valid) return;
    if (isNew) {
      void act('save', () => createAgentProfile({ key, name: name || key, description: desc, prompt, model, tools }));
    } else if (p) {
      void act('save', () => patchAgentProfile(p.key, { name, description: desc, prompt, model, tools }));
    }
  };

  // The engine refuses an empty grant, so the last tool cannot be removed here.
  const toggleTool = (t: string) => {
    const has = tools.includes(t);
    const next = has ? tools.filter((x) => x !== t) : room.knownTools.filter((x) => x === t || tools.includes(x));
    if (next.length) setTools(next);
  };
  const tiered = new Set(TOOL_TIERS.flatMap((t) => t.tools));
  const others = room.knownTools.filter((t) => !tiered.has(t));
  const tiers = [
    ...TOOL_TIERS.map((t) => ({ ...t, tools: t.tools.filter((x) => room.knownTools.includes(x)) })),
    ...(others.length ? [{ id: 'other', label: 'Other', note: 'The server knows these and this screen does not group them.', tools: others }] : []),
  ].filter((t) => t.tools.length);

  const models = PROFILE_MODELS.some((m) => m.model === model)
    ? PROFILE_MODELS : [...PROFILE_MODELS, { model, label: `${model} (set elsewhere)` }];

  return (
    <>
      <div className="mc-scrim" onClick={onClose} />
      <div className="mc-modal" role="dialog" aria-modal="true" aria-label={isNew ? 'New profile' : p?.name}>
        <header className="mc-modalhead">
          <div className="titles">
            <span className="titleline">
              <span className="t">{isNew ? 'New profile' : p?.name}</span>
              <span className="scope">Global</span>
            </span>
            <span className="sub">{isNew ? 'opens read-only: grant more on the right' : p?.key}</span>
          </div>
          {p && st && (
            <span className="status">
              <Pill tone={st.tone}>{st.label}</Pill>
              <Switch checked={p.enabled} label="Profile on" disabled={busy === 'on'}
                onChange={(v) => act('on', () => patchAgentProfile(p.key, { enabled: v }), false)} />
            </span>
          )}
          <button className="mc-x" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="mc-modalbody">
          <div className="left">
            {isNew && (
              <div className="pair">
                <label className="mc-field">
                  <span className="eyebrow">Key</span>
                  <input value={key} placeholder="reviewer-strict" autoFocus
                    onChange={(e) => setKey(e.target.value.toLowerCase())} />
                  <span className={`hint${clash ? ' bad' : ''}`}>
                    {clash ? 'A profile already has this key.' : 'Permanent: an item names it. Lowercase, digits, hyphens.'}
                  </span>
                </label>
                <label className="mc-field">
                  <span className="eyebrow">Name</span>
                  <input className="prose" value={name} placeholder="Strict reviewer" onChange={(e) => setName(e.target.value)} />
                </label>
              </div>
            )}
            <div className="pair">
              <label className="mc-field">
                <span className="eyebrow">Scope</span>
                <select value="global" disabled title="Project profiles aren't wired yet">
                  <option value="global">Global: every project</option>
                </select>
                <span className="hint">Project profiles aren't wired yet.</span>
              </label>
              <label className="mc-field">
                <span className="eyebrow">Model</span>
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => <option key={m.model} value={m.model}>{m.label}</option>)}
                </select>
                <span className="hint">Inherit = {room.policy.executorModel || 'the CLI default'}.</span>
              </label>
            </div>
            {!isNew && (
              <label className="mc-field">
                <span className="eyebrow">Name</span>
                <input className="prose" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
            )}
            <label className="mc-field">
              <span className="eyebrow">Description</span>
              <textarea className="prose" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)}
                placeholder="What the director reads when deciding whether to delegate…" />
              <span className="hint">The director reads this to decide whether to delegate.</span>
            </label>
            <label className="mc-field">
              <span className="eyebrow">System prompt</span>
              <textarea rows={9} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="You are…" />
              <span className="hint">Exactly what the subagent reads before it starts. No code is wrapped around it.</span>
            </label>
          </div>

          <div className="right">
            <div className="toolhead">
              <span className="eyebrow">Tools</span>
              <span className="count">{tools.length} of {room.knownTools.length} granted</span>
            </div>
            <span className={`mc-grant mc-t-${grant.tone}`}>{grant.text}</span>
            {tiers.map((t) => (
              <div className="mc-tiergroup" key={t.id}>
                <span className="head"><span className="l">{t.label}</span><span className="n">{t.note}</span></span>
                <span className="tools">
                  {t.tools.map((x) => {
                    const has = tools.includes(x);
                    return (
                      <button key={x} type="button" aria-pressed={has}
                        className={`mc-tool${has ? ' on' : ''}${has && t.id === 'write' ? ' w' : ''}`}
                        onClick={() => toggleTool(x)}>
                        {has ? '✓' : '+'} {x}
                      </button>
                    );
                  })}
                </span>
              </div>
            ))}
          </div>
        </div>

        {err && <div className="action-error mc-modalerr">{err}</div>}

        <footer className="mc-modalfoot">
          {isNew ? (
            <button className="k-btn sm secondary" onClick={onClose}>Discard</button>
          ) : p && (
            // RESET, NOT DELETE, on a built-in: DELETE drops the stored override
            // and the factory profile comes back.
            <button className="k-btn sm secondary" disabled={busy === 'del'}
              onClick={() => act('del', () => deleteAgentProfile(p.key), !p.builtin)}>
              {p.builtin ? 'Reset to factory' : 'Delete profile'}
            </button>
          )}
          <span className="grow" />
          <button className="k-btn sm ghost" onClick={onClose}>Cancel</button>
          <button className="k-btn sm" disabled={!valid || !dirty || busy === 'save'} onClick={save}>
            {busy === 'save' ? 'Saving…' : isNew ? 'Create profile' : 'Save'}
          </button>
        </footer>
      </div>
    </>
  );
}

/* ---------- Models (WIRED) ---------- */

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
  // `group` arrived with the v5 room; an older server sends none, so fall back
  // to "Claude Code is the harness" rather than drawing every row as Other.
  const isHarness = (p: ModelProvider) => (p.group ? p.group === 'harness' : p.key === 'anthropic');
  const harnesses = room.providers.filter(isHarness);
  const others = room.providers.filter((p) => !isHarness(p));
  const measuredH = harnesses.filter((p) => p.models.length);
  const modelCount = room.providers.reduce((n, p) => n + p.models.length, 0);
  const maxH = Math.max(1, ...harnesses.map((p) => p.tokens));
  const share = (n: number) => (t.tokens > 0 ? (n / t.tokens) * 100 : 0);

  return (
    <div className="mc-stack">
      <p className="mc-lede">
        {harnesses.filter((h) => !h.planned).length} harness{harnesses.filter((h) => !h.planned).length === 1 ? '' : 'es'}, {harnesses.filter((h) => h.planned).length} planned
        · {plural(modelCount, 'model')} measured over the last {room.windowDays} days. Shares are by
        tokens: an interactive session carries no price, so a cost share would describe the autopilot alone.
      </p>

      <div className="mc-tiles">
        <Tile label="Tokens" value={t.measured ? compactTokens(t.tokens) : '—'}
          line={t.measured ? measuredH.map((h) => `${h.name} ${compactTokens(h.tokens)}`).join(' · ') || 'none on a harness' : 'nothing in the window'} />
        {/* Priced runs ONLY: `n of m` stops this reading as the whole bill. */}
        <Tile label="Cost" value={t.pricedRuns ? usd(t.costUsd) : '—'}
          line={`${t.pricedRuns} of ${plural(t.runs, 'run')} priced · sessions never are`} />
        <Tile label="Delegations" value={t.measured ? String(t.delegations.calls) : '—'}
          line={`${t.delegations.recorded} with a transcript`} />
        <Tile label="Models seen" value={String(modelCount)}
          line={room.providers.filter((p) => p.models.length).map((p) => `${p.name} ${p.models.length}`).join(' · ') || 'none'} />
      </div>

      {saveErr && <div className="action-error">{saveErr}</div>}

      {/* THE POLICY governs ONE of the two populations below. #285: the ADVISOR
          runs the session and the EXECUTOR is the subagent it hands the write
          tools to. Only Claude Code can hold either role today. */}
      <Card title="Autopilot policy" note="which harness and model an unattended run uses for each role">
        <div className="mc-policy">
          <PolicyRole role="Advisor" note="runs the session: plans, delegates, verifies, commits"
            value={room.policy.advisor} catalogue={room.policy.advisorCatalogue} busy={saving === 'advisor'}
            onChange={(v) => setPolicy({ autopilotAdvisorModel: v }, 'advisor')} />
          <span className="arrow">delegates to →</span>
          <PolicyRole role="Executor" note="the subagent with the write tools"
            value={room.policy.executor} catalogue={room.policy.executorCatalogue} busy={saving === 'executor'}
            onChange={(v) => setPolicy({ autopilotExecutorModel: v }, 'executor')} />
        </div>
        {!room.policy.advisor && (
          <div className="mc-banner warning">No advisor: a run is one model on the executor, and no profile on Agents spawns.</div>
        )}
      </Card>

      {/* TWO POPULATIONS, NEVER ONE BAR: the autopilot's spend answers to the
          policy, and a model the owner picked by hand in a session is not drift. */}
      <section className="mc-card">
        <header className="mc-cardhead">
          <span className="t">Where the tokens went</span>
          <span className="note mono">{room.windowDays} days</span>
          <span className="grow" />
          <span className="mc-key"><span className="sw solid" />Autopilot runs · governed by the policy</span>
          <span className="mc-key"><span className="sw faint" />Your own sessions · picked by hand, not drift</span>
        </header>
        {t.measured ? (
          <div className="mc-table mc-usage flat">
            <div className="mc-tr head">
              <span>Harness</span><span>Tokens · runs vs sessions</span>
              <span className="r">Tokens</span><span className="r">Share</span><span className="r">Runs · sessions</span>
            </div>
            {harnesses.map((h) => {
              const none = h.planned || !h.models.length;
              return (
                <div className={`mc-tr h-${h.key}${none ? ' quiet' : ''}`} key={h.key}>
                  <span className="hname"><span className="hdot" />{h.name}</span>
                  <span className="mc-bar">
                    <span className="auto" style={{ width: `${((h.autoTokens ?? 0) / maxH) * 100}%` }} />
                    <span className="inter" style={{ width: `${((h.tokens - (h.autoTokens ?? 0)) / maxH) * 100}%` }} />
                  </span>
                  <span className="r mono">{none ? '—' : compactTokens(h.tokens)}</span>
                  <span className="r mono">{none ? '—' : `${share(h.tokens).toFixed(1)}%`}</span>
                  <span className="r mono sec" title="Model appearances: a session on two models counts under both.">
                    {h.planned ? 'not connected' : none ? 'not measured' : h.runs === undefined ? '—' : `${plural(h.runs, 'run')} · ${plural(h.sessions, 'session')}`}
                  </span>
                </div>
              );
            })}
            {others.some((o) => o.models.length) && (
              <span className="mc-caption">
                Plus {others.filter((o) => o.models.length).map((o) => `${o.name} ${compactTokens(o.tokens)}`).join(' · ')} on backends that never run a session.
              </span>
            )}
          </div>
        ) : (
          // NOT a row of zeroes: nothing in the window carried a model.
          <span className="mc-absent">Nothing in the last {room.windowDays} days carried a model. No sessions, no runs: not a bill of $0.</span>
        )}
      </section>

      <div className="mc-sechead"><div><h2>Harnesses &amp; backends</h2></div></div>
      <div className="mc-table mc-backends">
        <div className="mc-tr head">
          <span>Name</span><span>Reached via</span><span>Token share</span><span>Models</span><span>Status</span>
        </div>
        {([
          ['Coding harnesses', 'can run a session', harnesses],
          ['Other backends', 'never run a session', others],
        ] as [string, string, ModelProvider[]][]).map(([title, note, rows]) => (
          <Fragment key={title}>
            <div className="mc-group"><span className="t">{title}</span><span className="note">{note}</span></div>
            {rows.map((p) => (
              <Backend key={p.key} p={p} room={room} open={open === p.key}
                onToggle={() => setOpen(open === p.key ? null : p.key)} />
            ))}
          </Fragment>
        ))}
      </div>
      <span className="mc-caption">
        A policy role tags a model by alias ("sonnet" matches every Sonnet the window saw). "Default" matches nothing.
      </span>
    </div>
  );
}

function PolicyRole({ role, note, value, catalogue, busy, onChange }: {
  role: string; note: string; value: string; catalogue: { model: string; label: string }[];
  busy: boolean; onChange: (v: string) => void;
}) {
  const known = catalogue.some((m) => m.model === value);
  return (
    <div className="mc-role">
      <span className="rolehead"><span className="eyebrow">{role}</span><span className="note">{note}</span></span>
      <span className="mc-seg">
        <button type="button" className="on" aria-pressed="true">Claude Code</button>
        <button type="button" disabled title="The autopilot runs Claude Code only. Codex is terminal-only for now.">Codex</button>
        <button type="button" disabled title="Not connected">GitHub Copilot</button>
      </span>
      <select className="k-select" value={value} disabled={busy} onChange={(e) => onChange(e.target.value)} aria-label={`${role} model`}>
        {(known ? catalogue : [...catalogue, { model: value, label: `${value} (set elsewhere)` }])
          .map((m) => <option key={m.model} value={m.model}>{m.label}</option>)}
      </select>
    </div>
  );
}

function Backend({ p, room, open, onToggle }: { p: ModelProvider; room: ModelsRoom; open: boolean; onToggle: () => void }) {
  const isH = (HARNESS_KEYS as readonly string[]).includes(p.key);
  return (
    <div className={`mc-backend h-${p.key}${open ? ' open' : ''}`}>
      <div className="mc-tr row" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter') onToggle(); }}>
        <span className="hname">
          <span className="chev">{open ? '▾' : '▸'}</span>
          <span className="hdot" />
          <span className="names"><span className="n">{p.name}</span><span className="k">{p.kind}</span></span>
        </span>
        <span className="mono sec">{p.reach}</span>
        <span className="sharecell">
          <span className="mc-bar thin"><span className="auto" style={{ width: `${p.planned ? 0 : p.share}%` }} /></span>
          <span className="mono pct">{p.planned ? '—' : `${Math.round(p.share)}%`}</span>
        </span>
        <span className="mono">{p.planned ? '—' : p.models.length}</span>
        <span><Pill tone={p.tone}>{p.state}</Pill></span>
      </div>
      {open && (
        <div className="mc-backenddetail">
          <span className="detail">{p.detail}</span>
          {p.models.length ? (
            <div className="mc-table mc-models">
              <div className="mc-tr head">
                <span>Model</span><span>Runs · sessions</span><span>Tokens</span><span>Cost</span><span>Share of all</span><span>Policy role</span>
              </div>
              {p.models.map((m) => (
                <div className="mc-tr" key={m.model}>
                  <span className="names"><span className="n">{m.label}</span><span className="k mono">{m.model}</span></span>
                  <span className="mono sec">{m.runs}r · {m.sessions}s</span>
                  <span className="mono">{compactTokens(m.tokens)}</span>
                  <span className="mono sec">{money(m.costUsd)}</span>
                  <span className="sharecell">
                    <span className="mc-bar thin"><span className="auto" style={{ width: `${m.share}%` }} /></span>
                    <span className="mono pct">{m.share.toFixed(1)}%</span>
                  </span>
                  <span className="roles"
                    title={m.roles.length
                      ? m.roles.map((r) => `${r} = "${r === 'executor' ? room.policy.executor : room.policy.advisor}"`).join(' · ')
                      : 'Neither policy alias matches this id'}>
                    {m.roles.length ? m.roles.map((r) => <Pill key={r} tone="info">{r}</Pill>) : <span className="sec">unassigned</span>}
                  </span>
                </div>
              ))}
            </div>
          ) : !p.planned ? (
            <span className="mc-absent">{p.absent || 'Nothing measured on this backend in the window.'}</span>
          ) : null}
          {isH && !p.planned && p.key !== 'anthropic' && p.models.length > 0 && (
            <span className="mc-caption">Measured from the transcripts that reached Stack. Codex has no role in the policy yet.</span>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Context (WIRED) ----------

   The Edit button writes three things: a spawn profile's prompt (on the Agents
   tab now), the ✧ assist steer, and a repo's CLAUDE.md or AGENTS.md. The last
   goes to the file on the host, carrying the sha256 the editor opened, and the
   host refuses it if the file changed since; that refusal is shown verbatim
   and the draft is kept. A doc with no `edit` has no button at all. */

type Reader = 'claude' | 'codex' | 'codex-via' | 'assist';
type Lens = 'all' | 'claude' | 'codex';

const READER_LABEL: Record<Reader, string> = {
  claude: 'Claude Code', codex: 'Codex', 'codex-via': 'Codex, via AGENTS.md', assist: '✧ assist',
};

const kb = (n: number) => (n < 1000 ? `${n} B` : `${(n / 1000).toFixed(1)} KB`);

interface CtxFile { doc: ContextDoc; readers: Reader[]; size: string; off: boolean; group: string }

// A repo's instruction file as a doc. Built here, not on the server, because it
// comes from a different read (the host, live) with its own failure states.
function claudeMdDoc(slug: string, name: string, f: ClaudeMdFile): ContextDoc {
  const fileName = f.path.split('/').pop() || 'CLAUDE.md';
  const pct = f.budget ? Math.round((f.bytes / f.budget) * 100) : null;
  return {
    id: `md:${slug}:${f.path}`,
    path: `${slug}/${f.path}`,
    kind: 'repo',
    scope: name,
    inherits: true,
    summary: '',
    meta: [f.budget ? `${kb(f.bytes)} of ${kb(f.budget)} budget (${pct}%)` : kb(f.bytes), f.truncated ? 'shown in part' : null]
      .filter(Boolean).join(' · '),
    body: f.body,
    words: f.body.trim() ? f.body.trim().split(/\s+/).length : 0,
    reads: null,
    readsLabel: '',
    edit: f.truncated ? null : {
      kind: 'claude-md', slug, path: f.path, sha: f.sha, value: f.body, label: fileName,
      hint: 'Saving writes the file on disk and does not commit. It is refused if the file changed since you opened it.',
    },
    note: f.truncated ? 'This file is over the host’s read cap, so only the start is shown, and it cannot be edited here.' : '',
  };
}

/** Who reads a repo file. Codex reads CLAUDE.md only where AGENTS.md sends it. */
function repoReaders(f: ClaudeMdFile, files: ClaudeMdFile[]): Reader[] {
  const base = f.path.split('/').pop();
  if (base === 'AGENTS.md') return ['codex'];
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
  const agents = files.find((x) => x.path === `${dir}AGENTS.md`);
  return agents && /CLAUDE\.md/.test(agents.body) ? ['claude', 'codex-via'] : ['claude'];
}

function noteFor(file: CtxFile): string {
  const { doc, readers } = file;
  if (doc.kind === 'root') return `Every Claude Code session starts with this block: the SessionStart hook injects it. Codex terminals get no hook, so they never see it. ${doc.note}`;
  if (doc.kind === 'agent') return 'Handed to Claude Code through --agents when an autopilot run spawns this profile. Codex never sees it. Edit it on the Agents tab.';
  if (doc.kind === 'assist') return `Prepended to the requests the ✧ Fill-from-note button makes. ${doc.summary}`;
  const proj = doc.scope;
  const nested = doc.path.split('/').length > 2;
  if (readers.includes('codex')) return `Codex reads this file directly in ${proj}. Claude Code does not. Read live from the host.`;
  return `${nested ? `Claude Code reads this when it works under ${doc.path.slice(doc.path.indexOf('/') + 1, doc.path.lastIndexOf('/') + 1)} in ${proj}` : `Every Claude Code session opened in ${proj} reads this file`}${readers.includes('codex-via')
    ? '. Codex reads it too, because AGENTS.md points here, so shared rules live here once for both.'
    : '. Codex does not.'} Read live from the host.${doc.note ? ` ${doc.note}` : ''}`;
}

function Context({ onEditProfile }: { onEditProfile: (key: string) => void }) {
  const [room, err, busy, reload] = useRoom<ContextRoom>(getContextRoom);
  const [md, mdErr, mdBusy, reloadMd] = useRoom<ClaudeMdRead>(getClaudeMd);
  const [sel, setSel] = useState('');
  const [lens, setLens] = useState<Lens>('all');
  const [folded, setFolded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');

  if (busy && !room) return <Loading what="the context" />;
  if (err) return <Failed err={err} onRetry={reload} />;
  if (!room) return null;

  const built: CtxFile[] = room.docs.map((d) => ({
    doc: d,
    readers: d.kind === 'assist' ? ['assist'] : ['claude'],
    size: `${d.words} w`,
    off: d.kind === 'agent' && d.meta.startsWith('switched off'),
    group: 'Stack-built',
  }));
  const repos = (md?.projects ?? []).filter((p) => p.checkout && p.files.length);
  const repoFiles: CtxFile[] = repos.flatMap((p) => [...p.files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => ({ doc: claudeMdDoc(p.slug, p.name, f), readers: repoReaders(f, p.files), size: kb(f.bytes), off: false, group: p.name })));
  const all = [...built, ...repoFiles];
  const groups: { title: string; note: string; files: CtxFile[] }[] = [
    { title: 'Stack-built', note: 'every project', files: built },
    ...repos.map((p) => ({ title: p.name, note: p.more ? `${p.more} more not listed` : 'read live', files: repoFiles.filter((f) => f.group === p.name) })),
  ];
  const noCheckout = (md?.projects ?? []).filter((p) => !p.checkout);
  const noFiles = (md?.projects ?? []).filter((p) => p.checkout && !p.files.length);

  const sees = (f: CtxFile, l: Lens) => l === 'all' || f.readers.some((r) => r === l || (l === 'codex' && r === 'codex-via'));
  const seen = all.filter((f) => sees(f, lens) && !f.off);
  const words = seen.reduce((n, f) => n + f.doc.words, 0);
  const file = all.find((f) => f.doc.id === sel) ?? all[0];
  const doc = file?.doc;

  const pick = (id: string) => { setSel(id); setEditing(false); setSaveErr(''); };
  const startEdit = () => { setDraft(doc?.edit?.value ?? ''); setEditing(true); setSaveErr(''); };

  const save = async () => {
    if (!doc?.edit) return;
    setSaving(true); setSaveErr('');
    try {
      if (doc.edit.kind === 'claude-md' && doc.edit.slug && doc.edit.path && doc.edit.sha) {
        await putClaudeMd(doc.edit.slug, doc.edit.path, doc.edit.sha, draft);
        setEditing(false);
        reloadMd();
        return;
      }
      await patchSettings({ assistGuidance: draft });
      setEditing(false);
      reload();
    } catch (e) {
      setSaveErr((e as Error)?.message || 'That did not save.');
    } finally {
      setSaving(false);
    }
  };

  // FAIL SILENT: no daemon means Stack cannot see the files, which must never
  // be drawn as "no instruction files anywhere".
  const hostLine = mdBusy && !md ? 'Reading the repos’ CLAUDE.md and AGENTS.md files off the host…'
    : mdErr ? `Could not ask the host for the repos’ files: ${mdErr}`
      : md && !md.connected ? 'Stack cannot see the host (the terminal daemon is not connected), so no repo files are shown. That is not the same as having none.'
        : md && !md.ok ? `The host could not read the repos’ files: ${md.reason}`
          : [
            noFiles.length ? `No CLAUDE.md or AGENTS.md in ${noFiles.map((p) => p.name).join(', ')}.` : '',
            noCheckout.length ? `No checkout on this host for ${noCheckout.map((p) => p.name).join(', ')}.` : '',
          ].filter(Boolean).join(' ') || 'Each file is read live; Stack keeps no copy.';

  const isProfile = doc?.kind === 'agent';
  const profileKey = isProfile ? doc.id.replace(/^agent:/, '') : '';

  return (
    <div className="mc-stack">
      <div className="mc-ctxtop">
        <p className="mc-lede">
          Everything Stack puts in front of a model: the session block, each spawn profile's prompt, the
          ✧ steer, and each project's CLAUDE.md and AGENTS.md, read live off the host.
        </p>
        <div className="lens">
          <span className="chips">
            <span className="l">Seen by</span>
            {(['all', 'claude', 'codex'] as Lens[]).map((l) => (
              <button key={l} type="button" aria-pressed={lens === l}
                className={`mc-chip lens-${l}${lens === l ? ' on' : ''}`} onClick={() => setLens(l)}>
                <span className="dot" />{l === 'all' ? 'Everything' : READER_LABEL[l]}
              </button>
            ))}
          </span>
          <span className="sum">{lens === 'all' ? '' : `${READER_LABEL[lens]} sees `}{plural(seen.length, 'piece')} · {words.toLocaleString('en-AU')} words</span>
        </div>
      </div>

      <div className={`mc-ctx${folded ? ' folded' : ''}`}>
        <aside className="mc-files">
          {folded ? (
            <div className="foldedbar">
              <button className="mc-sq" onClick={() => setFolded(false)} title="Show files" aria-label="Show files">»</button>
              <span className="vert">{plural(all.length, 'file')}</span>
            </div>
          ) : (
            <>
              <div className="fhead">
                <span className="t">Files <span className="mono">{all.length}</span></span>
                <button className="mc-sq" onClick={() => setFolded(true)} title="Collapse" aria-label="Collapse files">«</button>
              </div>
              <div className="flist">
                {groups.map((g) => (
                  <Fragment key={g.title}>
                    <div className="fgroup"><span className="t">{g.title}</span><span className="note">{g.note}</span></div>
                    {g.files.map((f) => (
                      <button key={f.doc.id} type="button"
                        className={`mc-file${f.doc.id === doc?.id ? ' on' : ''}${!sees(f, lens) ? ' unseen' : f.off ? ' off' : ''}`}
                        onClick={() => pick(f.doc.id)}>
                        <span className="path">{f.doc.path}</span>
                        <span className="dots">{f.readers.map((r) => <span key={r} className={`rdot r-${r}`} title={READER_LABEL[r]} />)}</span>
                        <span className="size">{f.size}</span>
                      </button>
                    ))}
                  </Fragment>
                ))}
              </div>
              <div className="ffoot">
                <span className="legend">
                  <span><span className="rdot r-claude" />Claude Code</span>
                  <span><span className="rdot r-codex" />Codex</span>
                  <span><span className="rdot r-codex-via" />Codex, via AGENTS.md</span>
                </span>
                <span className="host">{hostLine}</span>
                {md && !mdBusy ? <button className="k-btn sm secondary" onClick={reloadMd}>Re-read from host</button> : null}
              </div>
            </>
          )}
        </aside>

        {doc && file ? (
          <section className={`mc-viewer kind-${doc.kind}`}>
            <header className="vhead">
              <div className="titles">
                <span className="pathline"><span className="path">{doc.path}</span><span className="meta">{[doc.words ? `${doc.words.toLocaleString('en-AU')} words` : '', doc.meta].filter(Boolean).join(' · ')}</span></span>
                <span className="readby">
                  <span className="l">Read by</span>
                  {file.readers.map((r) => <span key={r} className="mc-chip static"><span className={`rdot r-${r}`} />{READER_LABEL[r]}</span>)}
                </span>
              </div>
              {isProfile ? (
                <button className="k-btn sm secondary" onClick={() => onEditProfile(profileKey)}>Edit in Agents</button>
              ) : doc.edit ? (
                !editing && <button className="k-btn sm secondary" onClick={startEdit}>Edit {doc.edit.label}</button>
              ) : (
                <span className="locked">{doc.kind === 'root' ? 'Switched in Settings' : 'Read-only here'}</span>
              )}
            </header>
            <div className="vnote">{noteFor(file)}</div>
            {saveErr && <div className="action-error">{saveErr}</div>}
            {editing && doc.edit ? (
              <div className="veditor">
                <textarea value={draft} spellCheck={false} aria-label={doc.edit.label} onChange={(e) => setDraft(e.target.value)} />
                <div className="vacts">
                  <span className="hint">{doc.edit.hint}</span>
                  <button className="k-btn sm ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
                  <button className="k-btn sm" onClick={save} disabled={saving}>
                    {saving ? 'Saving…' : doc.edit.kind === 'claude-md' ? 'Save to disk' : 'Save'}
                  </button>
                </div>
              </div>
            ) : doc.body ? (
              <div className="vbody">
                {doc.body.split('\n').map((line, i) => <MdLine key={i} line={line} n={i + 1} />)}
              </div>
            ) : (
              <div className="vempty">
                {doc.edit ? <>Nothing written yet. <button className="k-btn sm" onClick={startEdit}>Write it</button></>
                  : <>Every line of this block is switched off, so nothing is injected. <a href={hrefTo.settings}>Turn some on</a></>}
              </div>
            )}
          </section>
        ) : (
          <section className="mc-viewer"><div className="vempty">Nothing to show yet.</div></section>
        )}
      </div>
    </div>
  );
}

function MdLine({ line, n }: { line: string; n: number }) {
  const level = line.startsWith('# ') ? 1 : /^#{2,}\s/.test(line) ? 2 : 0;
  const text = level ? line.replace(/^#+\s*/, '') : line;
  return (
    <div className={`mc-mdline${level ? ` h${level}` : ''}`}>
      <span className="n">{n}</span>
      <span className="text">{text || ' '}</span>
    </div>
  );
}

/* ---------- Settings (MOCK) ----------

   The v5 design's sections, as local state. Every switch below is undone by
   leaving the page, and none of these rows is wired: `#/settings` is the real
   screen. Two rows (revoke every key, delete transcripts) have no counterpart
   at all, and both destroy: the fail-safe rules have a direction for that
   nobody has applied to them yet. */

type SetSec = 'term' | 'ai' | 'access' | 'budget' | 'danger';
const SET_SECS: [SetSec, string, string][] = [
  ['term', 'Terminals', 'How each harness behaves in a terminal: whether it keeps going on its own, when it checkpoints, and whether it asks before running commands.'],
  ['ai', 'AI & API keys', 'How each harness signs in on the host, and the keys Stack reads.'],
  ['access', 'Access', 'What agents may do without asking, where they run, and who can open this console.'],
  ['budget', 'Budgets', 'Token caps for unattended runs.'],
  ['danger', 'Danger zone', 'Destructive actions. Each asks twice.'],
];

function SetRow({ label, desc, children }: { label: string; desc: string; children: ReactNode }) {
  return (
    <div className="mc-setrow">
      <span className="txt"><span className="l">{label}</span><span className="d">{desc}</span></span>
      {children}
    </div>
  );
}

function SettingsTab() {
  const [sec, setSec] = useState<SetSec>('term');
  const [term, setTerm] = useState({ claude: { auto: true, ckpt: true, skip: false }, codex: { auto: false, ckpt: false, skip: false } });
  const [contLimit, setContLimit] = useState('5');
  const [ckpt, setCkpt] = useState('compact');
  const [defH, setDefH] = useState<'claude' | 'codex'>('claude');
  const [keepAlive, setKeepAlive] = useState(true);
  const [guards, setGuards] = useState({ plan: true, budget: true, worktree: true, network: false, transcripts: true });
  const [devices, setDevices] = useState([
    { id: 1, name: 'MacBook Pro · Chrome', meta: 'Melbourne · active now', current: true },
    { id: 2, name: 'iPhone · Safari', meta: 'Melbourne · 2 days ago', current: false },
    { id: 3, name: 'Work PC · Edge', meta: 'Sydney · 3 weeks ago', current: false },
  ]);
  const [runCap, setRunCap] = useState('40M');
  const [dayCap, setDayCap] = useState('200M');
  const [onCap, setOnCap] = useState('pause');
  const [armed, setArmed] = useState('');
  const cur = SET_SECS.find((s) => s[0] === sec)!;

  const ROWS: ['auto' | 'ckpt' | 'skip', string, string][] = [
    ['auto', 'Auto-continue', 'Answers the model’s “continue?” pauses so long tasks keep going, up to the limit below.'],
    ['ckpt', 'Run /checkpoint automatically', 'Saves a checkpoint on the trigger below, so a crash or compaction loses little.'],
    ['skip', 'Skip permission prompts', 'Runs commands and edits without asking each time. Only inside a worktree.'],
  ];
  const GUARDS: [keyof typeof guards, string, string][] = [
    ['plan', 'Every plan needs my approval before it runs', 'An autopilot run stops after planning until you approve.'],
    ['budget', 'Stop a run when it passes its token budget', 'Uses the caps under Budgets.'],
    ['worktree', 'Agents work only in a git worktree', 'Never in the checkout you have open.'],
    ['network', 'Allow network tools in autopilot runs', 'WebFetch and WebSearch. Off means a profile’s grant of them is ignored.'],
    ['transcripts', 'Keep full session transcripts', 'Needed for the token and delegation counts on Models.'],
  ];
  const DANGER: [string, string, string, string][] = [
    ['keys', 'Revoke every provider key and stop all loops', 'Agents keep their settings. You will need to re-add each key.', 'Revoke keys'],
    ['tx', 'Delete 209 session transcripts', 'Usage totals stay; per-model drill-downs on Models will empty.', 'Delete transcripts'],
    ['host', 'Unpair the host daemon', 'Every terminal and run stops until you pair again.', 'Unpair host'],
  ];

  return (
    <div className="mc-stack">
      <div className="mc-mocknote">
        <span className="con-navsoon mock">Mock</span>
        <span>Sample rows from the design. Nothing here reads or writes this installation; <a href={hrefTo.settings}>Settings</a> is the real screen.</span>
      </div>
      <div className="mc-settings">
        <nav className="mc-setnav">
          {SET_SECS.map(([id, label]) => (
            <button key={id} type="button" className={`${sec === id ? 'on' : ''}${id === 'danger' ? ' danger' : ''}`}
              onClick={() => { setSec(id); setArmed(''); }}>{label}</button>
          ))}
        </nav>
        <div className="mc-setbody">
          <div className="sethead"><h2>{cur[1]}</h2><p>{cur[2]}</p></div>

          {sec === 'term' && (
            <>
              <Card title="Behaviour by harness" note="each CLI is set separately">
                <div className="mc-matrix">
                  <div className="mrow head">
                    <span />
                    <span className="h h-anthropic"><span className="hdot" />Claude Code</span>
                    <span className="h h-codex"><span className="hdot" />Codex</span>
                  </div>
                  {ROWS.map(([k, label, desc]) => (
                    <div className="mrow" key={k}>
                      <span className="txt"><span className="l">{label}</span><span className="d">{desc}</span></span>
                      {(['claude', 'codex'] as const).map((h) => (
                        <span className="cell" key={h}>
                          <Switch checked={term[h][k]} label={`${label}, ${h}`}
                            onChange={(v) => setTerm((t) => ({ ...t, [h]: { ...t[h], [k]: v } }))} />
                          {k === 'skip' && term[h][k] && <Pill tone="warning">no prompts</Pill>}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              </Card>
              <Card title="Limits and triggers" note="apply to every terminal">
                <SetRow label="Auto-continue limit" desc="Continues in a row before it stops and waits for you.">
                  <input className="k-input mc-num" value={contLimit} onChange={(e) => setContLimit(e.target.value)} aria-label="Auto-continue limit" />
                </SetRow>
                <SetRow label="When /checkpoint runs" desc="Only for harnesses with auto /checkpoint on.">
                  <select className="k-select mc-wide" value={ckpt} onChange={(e) => setCkpt(e.target.value)} aria-label="When /checkpoint runs">
                    <option value="compact">Before the context is compacted</option>
                    <option value="turns">Every 20 turns</option>
                    <option value="idle">After 10 minutes idle</option>
                    <option value="commit">After each commit</option>
                  </select>
                </SetRow>
                <SetRow label="Default harness for new terminals" desc="You can still pick another when you open one.">
                  <span className="mc-seg">
                    <button type="button" className={defH === 'claude' ? 'on' : ''} onClick={() => setDefH('claude')}>Claude Code</button>
                    <button type="button" className={defH === 'codex' ? 'on' : ''} onClick={() => setDefH('codex')}>Codex</button>
                    <button type="button" disabled title="Not connected">GitHub Copilot</button>
                  </span>
                </SetRow>
                <SetRow label="Keep terminals running when the tab closes" desc="The session stays on the host and reattaches when you come back.">
                  <Switch checked={keepAlive} onChange={setKeepAlive} label="Keep terminals running" />
                </SetRow>
              </Card>
            </>
          )}

          {sec === 'ai' && (
            <>
              <Card title="Harness sign-in" note="how each CLI authenticates on the host">
                {([
                  ['anthropic', 'Claude Code', 'Owner’s subscription, signed in on the host', 'Signed in', 'success', 'Re-authenticate'],
                  ['codex', 'Codex', 'ChatGPT plan, signed in on the host', 'Signed in', 'success', 'Re-authenticate'],
                  ['copilot', 'GitHub Copilot', 'Not set up', 'Not connected', 'neutral', 'Connect'],
                ] as [string, string, string, string, Tone, string][]).map(([k, name, how, state, tone, action]) => (
                  <div className={`mc-setrow h-${k}`} key={k}>
                    <span className="hdot" />
                    <span className="txt"><span className="l strong">{name}</span><span className="d">{how}</span></span>
                    <Pill tone={tone}>{state}</Pill>
                    <button className="k-btn sm secondary">{action}</button>
                  </div>
                ))}
              </Card>
              <Card title="API keys" note="values are never shown in full">
                <div className="mc-keys">
                  <div className="krow head"><span>Name</span><span>Used by</span><span>Value</span><span>Source</span><span /></div>
                  {([
                    ['GEMINI_API_KEY', 'Gemini second opinion', 'AIza••••••3fQk', 'environment', 'Replace'],
                    ['OPENAI_API_KEY', 'Not needed while Codex uses the ChatGPT sign-in', 'unset', '—', 'Add'],
                    ['OMNIROUTE_MODEL', 'OmniRoute gateway', 'free default', 'environment', 'Change'],
                    ['SENTRY_DSN', 'Runtime error reporting', 'https://••••@o4…', 'stored', 'Replace'],
                  ]).map(([n, by, v, src, act]) => (
                    <div className="krow" key={n}>
                      <span className="mono">{n}</span><span className="d">{by}</span>
                      <span className={`mono${v === 'unset' ? ' sec' : ''}`}>{v}</span><span className="d">{src}</span>
                      <span className="end"><button className="k-btn sm secondary">{act}</button></span>
                    </div>
                  ))}
                </div>
                <div className="mc-banner warning flush">
                  <span className="txt"><strong>Sentry has seen no events in 30 days</strong> Telemetry looks disconnected, so runtime errors may not be reaching you.</span>
                  <button className="k-btn sm secondary">Check the DSN</button>
                </div>
              </Card>
            </>
          )}

          {sec === 'access' && (
            <>
              <Card title="Guardrails" note="every agent and every run">
                {GUARDS.map(([k, label, desc]) => (
                  <SetRow key={k} label={label} desc={desc}>
                    <Switch checked={guards[k]} label={label} onChange={(v) => setGuards((g) => ({ ...g, [k]: v }))} />
                  </SetRow>
                ))}
              </Card>
              <Card title="Host daemon" note="where every terminal and run executes">
                <SetRow label="stack-host" desc="paired 2026-10-02 · last seen just now">
                  <Pill tone="success">Connected</Pill>
                  <button className="k-btn sm secondary">Re-pair</button>
                </SetRow>
              </Card>
              <Card title="Signed-in devices" note="who can open this console">
                {devices.map((d) => (
                  <SetRow key={d.id} label={d.name} desc={d.meta}>
                    {d.current ? <span className="mc-caption">this device</span>
                      : <button className="k-btn sm secondary" onClick={() => setDevices((ds) => ds.filter((x) => x.id !== d.id))}>Sign out</button>}
                  </SetRow>
                ))}
              </Card>
            </>
          )}

          {sec === 'budget' && (
            <Card title="Token caps" note="subscriptions carry no price, so caps are in tokens">
              <div className="mc-capgrid">
                <label className="mc-field"><span className="eyebrow">Per-run token cap</span>
                  <input value={runCap} onChange={(e) => setRunCap(e.target.value)} />
                  <span className="hint">One autopilot run, director and subagents together.</span></label>
                <label className="mc-field"><span className="eyebrow">Daily token cap</span>
                  <input value={dayCap} onChange={(e) => setDayCap(e.target.value)} />
                  <span className="hint">Autopilot only. Your own sessions are never capped.</span></label>
                <label className="mc-field"><span className="eyebrow">On cap</span>
                  <select value={onCap} onChange={(e) => setOnCap(e.target.value)}>
                    <option value="pause">Pause and ask me</option>
                    <option value="queue">Queue until tomorrow</option>
                    <option value="stop">Stop the run</option>
                  </select></label>
              </div>
            </Card>
          )}

          {sec === 'danger' && (
            <Card title="Danger zone" note="these cannot be undone" className="danger">
              {DANGER.map(([id, label, desc, btn]) => (
                <SetRow key={id} label={label} desc={desc}>
                  <button className={`k-btn sm ${armed === id ? 'mc-armed' : 'danger'}`}
                    onClick={() => setArmed(armed === id ? '' : id)}>
                    {armed === id ? 'Click again to confirm' : btn}
                  </button>
                </SetRow>
              ))}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
