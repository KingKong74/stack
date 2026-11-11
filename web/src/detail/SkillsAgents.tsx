// SKILLS & AGENTS — the Claude Design "Skills and Agents redesign" project's
// v4 (131e61b4, 2026-11-11), WIRED. Two lists, each opening a three-pane
// editor (rail · the text · its settings). Both halves already had a backend,
// and this tab is a second face on each, not a second truth:
//
//  • AGENTS are `agent_profiles` (routes/agent-profiles.js), the same room
//    Mission Control → Agents draws. A profile is a spawn profile and nothing
//    else (root CLAUDE.md). The two model pickers are the autopilot policy
//    (`autopilotExecutorModel` / `autopilotAdvisorModel` through PATCH
//    /settings), with Models' catalogues as their options.
//  • SKILLS are the managed skill library (#228, routes/skills.js), the same
//    rows as #/skills. The host syncs them on its own clock, so nothing here is
//    instant and the screen says so rather than animating a success it cannot
//    observe.
//
// It is APP-WIDE, not this project's: a profile and a global skill apply to
// every project. It sits in the project rail because the design put it there.
//
// RULES THIS SCREEN KEEPS THAT THE DESIGN DID NOT STATE:
//
//  1. WITH NO ADVISOR NOTHING SPAWNS. `--agents` is only passed when an
//     advisor is set. Execution policy lives in profile details; the list footer
//     states whether automation can delegate. The ADVISOR runs the
//     session and the EXECUTOR is the subagent (#285).
//  2. THE LAST TOOL CANNOT BE REVOKED. The engine refuses an empty grant (a
//     profile that can do nothing is a no-op), so the cell refuses first.
//  3. AN UNMANAGED SKILL IS NEVER TOUCHED. Adopt copies it into the library;
//     the file on disk is unchanged until the library's copy is edited.
//  4. A SKILL IS NOT SCOPED TO AGENTS. The design's per-agent checklist and
//     "Loaded by" chips have no column and nothing on the host that would
//     honour them, so they draw as what is true: every enabled skill is on
//     disk for every session. Wiring them needs a skills→agents column AND a
//     spawn that passes it; don't draw live checkboxes before both exist.
//
// Text fields are drafts that save when they lose focus (the design saved per
// keystroke, which would be one PATCH per letter and a host re-sync each).
// Deleting a skill asks first: it deletes the file on the host's next sync.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AgentProfile, AgentProfilesRoom, ModelsRoom } from '../types';
import {
  AuthError, getAgentProfiles, patchAgentProfile, createAgentProfile, deleteAgentProfile,
  getModelsRoom, patchSettings, getSkills, createSkill, patchSkill, deleteSkill, getProjects,
  type Skill, type SkillsData, type SkillInput,
} from '../store';
import { useAutoRefresh } from '../lib/autoRefresh';
import { hrefTo } from '../lib/route';
import { ConfirmModal } from '../components/ConfirmModal';

type SaTab = 'agents' | 'skills';
type Run = (token: string, fn: () => Promise<unknown>) => Promise<void>;
type Opt = { model: string; label: string };

const short = (m: string) => m.replace(/^claude-/, '');
const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

const relative = (iso: string | null) => {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};
const place = (scope: string, slug: string) => (scope === 'project' ? `~/${slug}/.claude/skills` : '~/.claude/skills');
const diskKey = (s: { scope: string; slug: string; name: string }) => `${s.scope}:${s.slug || ''}:${s.name}`;

// The tool vocabulary in four groups (server KNOWN_TOOLS). A tool the server
// adds later lands in "Other" rather than vanishing from the editor.
const GROUPS: { label: string; cap: Cap; tools: string[] }[] = [
  { label: 'Read', cap: 'read', tools: ['Read', 'Grep', 'Glob'] },
  { label: 'Write', cap: 'write', tools: ['Edit', 'Write'] },
  { label: 'Execute', cap: 'run', tools: ['Bash'] },
  { label: 'Network', cap: 'web', tools: ['WebFetch', 'WebSearch'] },
];
type Cap = 'read' | 'write' | 'run' | 'web';
const CAPS: { cap: Cap; label: string; tone: string; icon: ReactNode }[] = [
  { cap: 'read', label: 'Read', tone: 'neutral', icon: <><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></> },
  { cap: 'write', label: 'Write', tone: 'info', icon: <path d="M10.5 2.5l3 3L6 13H3v-3z" /> },
  { cap: 'run', label: 'Run', tone: 'warning', icon: <path d="M2.5 4.5L6 8l-3.5 3.5M8 12h5.5" /> },
  { cap: 'web', label: 'Web', tone: 'success', icon: <><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></> },
];

// The avatar tone is a hash of the key, so a profile keeps its colour.
const AVT = ['info', 'success', 'warning', 'neutral', 'danger'];
function Avatar({ k, name, size }: { k: string; name: string; size?: 'lg' }) {
  let x = 0;
  for (const ch of k) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  const t = AVT[x % AVT.length];
  const ini = (name || k).split(/[\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  return <span className={`sa-av${size ? ` ${size}` : ''}`} style={{ background: `var(--status-${t}-bg)`, color: `var(--status-${t}-fg)` }}>{ini}</span>;
}

// What a skill row says about itself. Same four answers as screens/Skills.tsx:
// "disabled" is a decision, "not written yet" a wait, "missing" a discrepancy.
const skillState = (s: Skill, onDisk: boolean): [string, string, string] => {
  if (!s.enabled) return ['disabled', 'neutral', 'Kept in the library. The host removes it from disk on its next sync.'];
  if (s.installedAt && onDisk) return [`installed ${relative(s.installedAt)}`, 'success', 'On disk on the host, and matching this content.'];
  if (!s.installedAt && onDisk) return ['edited · sync pending', 'info', 'On disk, but the library has changed since. The host rewrites it within ~5 minutes.'];
  if (s.installedAt && !onDisk) return ['missing from disk', 'warning', 'Stack wrote this and the host no longer reports it: deleted by hand, or the project has no checkout on this host.'];
  return ['not written yet', 'info', 'Waiting on the host sync, within ~5 minutes, or the project has no checkout on this host.'];
};

function Switch({ on, title, disabled, onToggle }: { on: boolean; title: string; disabled?: boolean; onToggle: () => void }) {
  return (
    <button className={`lp-sw${on ? ' on' : ''}`} role="switch" aria-checked={on} title={title} aria-label={title}
      disabled={disabled} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
      <span className="knob" />
    </button>
  );
}

/** A text field that holds a draft and saves on blur. The server wins over a
 *  draft nobody has touched, so a re-read after somebody else's write shows. */
function Draft({ value, onSave, area, ...rest }: {
  value: string; onSave: (v: string) => void; area?: boolean;
  className?: string; rows?: number; placeholder?: string; 'aria-label'?: string; transform?: (v: string) => string;
}) {
  const { transform, ...props } = rest;
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const set = (x: string) => setV(transform ? transform(x) : x);
  const commit = () => { if (v !== value) onSave(v); };
  return area
    ? <textarea {...props} value={v} onChange={(e) => set(e.target.value)} onBlur={commit} />
    : <input {...props} value={v} onChange={(e) => set(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />;
}

const Eyebrow = ({ children, aside }: { children: ReactNode; aside?: ReactNode }) => (
  <div className="sa-eyerow"><span className="eyebrow">{children}</span>{aside != null && <span className="k">{aside}</span>}</div>
);

export function SkillsAgents() {
  const [tab, setTab] = useState<SaTab>('agents');
  const [room, setRoom] = useState<AgentProfilesRoom | null>(null);
  const [models, setModels] = useState<ModelsRoom | null>(null);
  const [skills, setSkills] = useState<SkillsData | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [agOpen, setAgOpen] = useState<string | null>(null);
  const [skOpen, setSkOpen] = useState<number | null>(null);
  const [removing, setRemoving] = useState<Skill | null>(null);

  const fail = (e: unknown, what: string) => { if (!(e instanceof AuthError)) setErr((e as Error)?.message || what); };
  const load = useCallback(() => {
    getAgentProfiles().then(setRoom).catch((e) => fail(e, 'Could not load the agent profiles.'));
    getSkills().then(setSkills).catch((e) => fail(e, 'Could not load the skill library.'));
  }, []);
  useEffect(() => {
    load();
    getModelsRoom().then(setModels).catch(() => { /* the pickers fall back to the current values */ });
    getProjects().then((ps) => setProjects(ps.map((p) => p.id))).catch(() => { /* global skills still work */ });
  }, [load]);
  // The host syncs skills on its own clock; re-read rather than pretend.
  useAutoRefresh(load);

  const run: Run = async (token, fn) => {
    setBusy(token); setErr('');
    try { await fn(); load(); }
    catch (e) { fail(e, 'That did not save.'); }
    finally { setBusy(''); }
  };

  const freeSkillName = (base: string) => {
    const taken = new Set((skills?.skills ?? []).filter((s) => s.scope === 'global').map((s) => s.name));
    let n = base, i = 2;
    while (taken.has(n)) n = `${base}-${i++}`;
    return n;
  };
  const newSkill = (base = 'new-skill') => void run('sk:new', async () => {
    const s = await createSkill({ name: freeSkillName(base), scope: 'global', slug: '', description: '', body: '' });
    setTab('skills'); setSkOpen(s.id);
  });
  const openSkill = (id: number) => { setTab('skills'); setSkOpen(id); };

  const tabs: [SaTab, string, number | string][] = [
    ['agents', 'Agents', room ? room.profiles.length : ''],
    ['skills', 'Skills', skills ? skills.skills.length : ''],
  ];
  const agent = room && agOpen ? room.profiles.find((p) => p.key === agOpen) : undefined;
  const skill = skills && skOpen != null ? skills.skills.find((s) => s.id === skOpen) : undefined;

  return (
    <div className="sa">
      <div className="sa-head">
        <div className="sa-title">
          <h1>Skills &amp; agents</h1>
          <span>App-wide. Held here, written to the host.</span>
        </div>
        <div className="sa-tabs" role="tablist">
          {tabs.map(([k, label, n]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {label}<span className="n">{n}</span>
            </button>
          ))}
        </div>
      </div>

      {err && <div className="action-error">{err}</div>}

      {tab === 'agents' && (!room
        ? <div className="sa-loading">Loading the profiles…</div>
        : agent
          ? <AgentEditor p={agent} room={room} models={models} skills={skills} busy={busy} run={run}
              onPick={setAgOpen} onBack={() => setAgOpen(null)} onOpenSkill={openSkill}
              onNewSkill={() => newSkill(`${agent.key}-skill`)} />
          : <AgentList room={room} busy={busy} run={run} onOpen={setAgOpen} />)}

      {tab === 'skills' && (!skills
        ? <div className="sa-loading">Loading the library…</div>
        : skill
          ? <SkillEditor s={skill} data={skills} projects={projects} busy={busy} run={run}
              onPick={setSkOpen} onBack={() => setSkOpen(null)} onRemove={setRemoving} />
          : <SkillList data={skills} busy={busy} run={run} onOpen={setSkOpen} onNew={() => newSkill()} />)}

      {removing && (
        <ConfirmModal title={`Delete ${removing.name}?`} danger confirmLabel="Delete the skill"
          body={<>This removes it from the library, and the host deletes
            <code> {place(removing.scope, removing.slug)}/{removing.name}</code> on its next sync. To
            stop Claude loading it, turn it off instead: that keeps the text here.</>}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const s = removing;
            setRemoving(null);
            if (s) void run(`sk:${s.id}`, async () => { await deleteSkill(s.id); setSkOpen(null); });
          }} />
      )}
    </div>
  );
}

// A value that is not in a catalogue (an old pin, a renamed model) still gets
// an option, or the select would silently show a different one.
const withCurrent = (opts: Opt[], cur: string) => (cur && !opts.some((o) => o.model === cur) ? [...opts, { model: cur, label: cur }] : opts);

// ---------------------------------------------------------------- agents

function AgentList({ room, busy, run, onOpen }: {
  room: AgentProfilesRoom; busy: string; run: Run; onOpen: (k: string) => void;
}) {
  const { policy, knownTools } = room;
  const spawns = policy.spawnsAgents;
  const exec = room.profiles.find((p) => p.key === 'executor');

  const newAgent = () => {
    const taken = new Set(room.profiles.map((p) => p.key));
    let n = 1;
    while (taken.has(`agent-${n}`)) n++;
    const key = `agent-${n}`;
    const tools = ['Read', 'Grep', 'Glob'].filter((t) => knownTools.includes(t));
    void run('new', async () => {
      await createAgentProfile({ key, name: 'New agent', description: '', prompt: '', model: '', tools: tools.length ? tools : knownTools.slice(0, 1) });
      onOpen(key);
    });
  };

  return (<>
    <div className="sa-card">
      <div className="sa-agrow head">
        <span />
        <span className="eyebrow">Agent</span>
        <span className="eyebrow">Model</span>
        <span className="eyebrow">Capabilities</span>
        <span className="eyebrow end" title="Open items that would spawn this profile">Items</span>
        <button className="sa-new" disabled={busy === 'new'} onClick={newAgent}>+ New</button>
      </div>
      {room.profiles.map((p) => {
        const used = room.usage[p.key] ?? 0;
        return (
          <div key={p.key} className="sa-agrow" role="button" tabIndex={0} onClick={() => onOpen(p.key)}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpen(p.key); }}>
            <Avatar k={p.key} name={p.name} />
            <div className="who">
              <span className="line">
                <span className={`n${p.enabled ? '' : ' off'}`}>{p.name}</span>
                <span className="k">{p.key}</span>
                {p.builtin && <span className="sa-chip">built-in</span>}
              </span>
              <span className="d">{p.description || 'No description'}</span>
            </div>
            <span className="sa-model">{p.model ? short(p.model) : 'inherit'}</span>
            <Caps tools={p.tools} />
            <span className={`sa-usage${used ? '' : ' zero'}`}>{used}</span>
            <span className="sa-on">
              <Switch on={p.enabled} disabled={busy === `${p.key}:on`}
                title={p.enabled ? 'Available when selected for automation; requires an advisor' : 'Disabled for selection; the built-in executor remains the fallback'}
                onToggle={() => void run(`${p.key}:on`, () => patchAgentProfile(p.key, { enabled: !p.enabled }))} />
            </span>
          </div>
        );
      })}
      <div className="sa-cardfoot">
        <span>{spawns ? 'Automation can delegate to selected profiles.' : 'Automation runs without delegation until an advisor is configured in profile details.'}</span>
        <span>{exec && exec.enabled ? 'Default profile:' : 'Fallback profile:'}</span>
        <code>{room.defaultSpawn.keys.join(', ') || 'the built-in executor'}</code>
        {room.defaultSpawn.reason && <span className="why">{room.defaultSpawn.reason}</span>}
        <span className="why"><a href={hrefTo.control}>Mission Control → Agents</a> draws the same profiles.</span>
      </div>
    </div>
  </>);
}

function Caps({ tools }: { tools: string[] }) {
  return (
    <div className="sa-caps">
      {CAPS.map(({ cap, label, tone, icon }) => {
        const got = GROUPS.filter((g) => g.cap === cap).flatMap((g) => g.tools).filter((t) => tools.includes(t));
        if (!got.length) return null;
        return (
          <span key={cap} className="sa-cap" title={got.join(', ')} style={{ background: `var(--status-${tone}-bg)`, color: `var(--status-${tone}-fg)` }}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
            {label}
          </span>
        );
      })}
    </div>
  );
}

function AgentEditor({ p, room, models, skills, busy, run, onPick, onBack, onOpenSkill, onNewSkill }: {
  p: AgentProfile; room: AgentProfilesRoom; models: ModelsRoom | null; skills: SkillsData | null; busy: string; run: Run;
  onPick: (k: string) => void; onBack: () => void; onOpenSkill: (id: number) => void; onNewSkill: () => void;
}) {
  const used = room.usage[p.key] ?? 0;
  const save = (patch: Parameters<typeof patchAgentProfile>[1], token = `${p.key}:edit`) =>
    void run(token, () => patchAgentProfile(p.key, patch));
  const execOpts = withCurrent(models?.policy.executorCatalogue.filter((o) => o.model) ?? [], p.model);
  const known = new Set(GROUPS.flatMap((g) => g.tools));
  const groups = [
    ...GROUPS.map((g) => ({ label: g.label, tools: g.tools.filter((t) => room.knownTools.includes(t)) })),
    { label: 'Other', tools: room.knownTools.filter((t) => !known.has(t)) },
  ].filter((g) => g.tools.length);
  const lib = skills?.skills ?? [];
  const loaded = lib.filter((s) => s.enabled);

  return (
    <div className="sa-edit">
      <nav className="sa-rail">
        <button className="sa-back" onClick={onBack}>← All agents</button>
        {room.profiles.map((x) => (
          <button key={x.key} className={`sa-railrow${x.key === p.key ? ' on' : ''}${x.enabled ? '' : ' off'}`} onClick={() => onPick(x.key)}>
            <span className={`sa-dot ${x.enabled ? 'ok' : 'idle'}`} />{x.name}
          </button>
        ))}
      </nav>

      <div className="sa-main">
        <div className="sa-titlerow">
          <Avatar k={p.key} name={p.name} size="lg" />
          <Draft className="sa-bigname" value={p.name} aria-label="Name" onSave={(v) => v.trim() && save({ name: v.trim() })} />
          <span className="sa-keytag">{p.key}</span>
        </div>
        <Draft area rows={2} className="sa-descin" value={p.description} aria-label="Description"
          placeholder="When should a run hand work to this agent?" onSave={(v) => save({ description: v })} />
        <Eyebrow aside={`${words(p.prompt)} words · saves on blur`}>System prompt</Eyebrow>
        <Draft area className="sa-body" value={p.prompt} aria-label="System prompt" onSave={(v) => save({ prompt: v })} />
      </div>

      <aside className="sa-side">
        <div className="sa-onrow">
          <div className="tx">
            <span className="sa-ontitle">{p.enabled ? 'On · available for selection' : 'Off · excluded from selection'}</span>
            <span className="note">{used} open item{used === 1 ? '' : 's'} assigned · {room.policy.spawnsAgents ? 'delegation configured' : 'delegation not configured'}</span>
          </div>
          <Switch on={p.enabled} disabled={busy === `${p.key}:on`}
            title={p.enabled ? 'Available when selected for automation; requires an advisor' : 'Disabled for selection; the built-in executor remains the fallback'}
            onToggle={() => save({ enabled: !p.enabled }, `${p.key}:on`)} />
        </div>

        <label className="sa-sect">
          <Eyebrow>Model</Eyebrow>
          <select className="lp-select mono" value={p.model} aria-label={`${p.name} model`} disabled={busy === `${p.key}:edit`}
            onChange={(e) => save({ model: e.target.value })}>
            <option value="">inherit · {short(room.policy.executorModel) || 'CLI default'}</option>
            {execOpts.map((o) => <option key={o.model} value={o.model}>{short(o.label)}</option>)}
          </select>
        </label>

        <details className="sa-sect">
          <summary>Automation execution policy</summary>
          <p className="note">App-wide automation settings. The advisor runs the parent session; selected profiles are its subagents. These settings do not change your interactive Claude or Codex terminals.</p>
          <label className="sa-sect">
            <Eyebrow>Advisor model</Eyebrow>
            <select className="lp-select mono" aria-label="Automation advisor model" value={room.policy.advisorModel} disabled={busy === 'policy'}
              onChange={(e) => { const v = e.target.value; void run('policy', () => patchSettings({ autopilotAdvisorModel: v })); }}>
              {withCurrent(models?.policy.advisorCatalogue ?? [{ model: '', label: 'None' }], room.policy.advisorModel).map((o) => <option key={o.model} value={o.model}>{o.label}</option>)}
            </select>
            <span className="note">None means a single-model run with no profile delegation.</span>
          </label>
          <label className="sa-sect">
            <Eyebrow>Default subagent model</Eyebrow>
            <select className="lp-select mono" aria-label="Automation default subagent model" value={room.policy.executorModel} disabled={busy === 'policy'}
              onChange={(e) => { const v = e.target.value; void run('policy', () => patchSettings({ autopilotExecutorModel: v })); }}>
              {withCurrent(models?.policy.executorCatalogue ?? [{ model: '', label: 'CLI default' }], room.policy.executorModel).map((o) => <option key={o.model} value={o.model}>{o.label}</option>)}
            </select>
            <span className="note">Inherited by profiles without their own model. Changing a profile model affects that profile only.</span>
          </label>
          <p className="note">Available profiles are selected per run; availability does not prove invocation. The built-in executor remains the fallback when no suitable executor is selected.</p>
        </details>

        <div className="sa-sect">
          <Eyebrow aside={`${loaded.length} of ${lib.length} on disk`}>Skills</Eyebrow>
          <div className="sa-sklist">
            {lib.map((s) => (
              <button key={s.id} className="sa-skitem" onClick={() => onOpenSkill(s.id)} title="Open this skill">
                <span className={`sa-check${s.enabled ? ' on' : ''}`}>{s.enabled ? '✓' : ''}</span>
                <span className="tx">
                  <span className={`n${s.enabled ? '' : ' off'}`}>{s.name}</span>
                  <span className="d">{s.description || 'No description'}</span>
                </span>
                <span className="scope">{s.scope === 'project' ? s.slug : 'global'}</span>
              </button>
            ))}
            <button className="sa-sknew" disabled={busy === 'sk:new'} onClick={onNewSkill}>+ New skill</button>
          </div>
          <span className="note">Skills are not scoped to agents: an enabled skill is on disk for every session, this agent's included.</span>
        </div>

        <div className="sa-sect">
          <Eyebrow aside={`${p.tools.length}/${room.knownTools.length} granted`}>Tools</Eyebrow>
          {groups.map((g) => (
            <div key={g.label} className="sa-toolgrp">
              <span className="sa-grplbl">{g.label}</span>
              <div className="sa-toolgrid">
                {g.tools.map((t) => {
                  const on = p.tools.includes(t);
                  const last = on && p.tools.length === 1;
                  return (
                    <button key={t} className={`sa-toolbtn${on ? ' on' : ''}`} aria-pressed={on} disabled={last || busy === `${p.key}:tools`}
                      title={last ? `${t} is its only tool, and a profile with none can do nothing` : `${on ? 'Revoke' : 'Grant'} ${t}`}
                      onClick={() => save({ tools: on ? p.tools.filter((x) => x !== t) : [...p.tools, t] }, `${p.key}:tools`)}>
                      <span className="box">{on ? '✓' : ''}</span>{t}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {p.builtin
          ? <span className="note">Built-in profiles can be turned off, not deleted.</span>
          : <button className="lp-btn danger sa-del" disabled={busy === `${p.key}:del`}
              onClick={() => void run(`${p.key}:del`, async () => { await deleteAgentProfile(p.key); onBack(); })}>
              Delete profile
            </button>}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------- skills

function SkillList({ data, busy, run, onOpen, onNew }: {
  data: SkillsData; busy: string; run: Run; onOpen: (id: number) => void; onNew: () => void;
}) {
  const { skills, report } = data;
  const disk = report.skills;
  const onDisk = new Set(disk.map(diskKey));
  const managed = new Set(skills.map(diskKey));
  const unmanaged = disk.filter((d) => !d.managed && !managed.has(diskKey(d)));
  const places = [
    { scope: 'global' as const, slug: '', label: 'Global' },
    ...[...new Set(skills.filter((s) => s.scope === 'project').map((s) => s.slug))].sort()
      .map((slug) => ({ scope: 'project' as const, slug, label: slug })),
  ];
  const hostQuiet = !report.when;

  return (<>
    <div className="sa-bar">
      <span className={`sa-dot ${hostQuiet ? 'idle' : 'ok'}`} />
      <span className="tx">
        {hostQuiet
          ? 'The host has not reported yet. The library below is real; what is on disk is unknown until the next sync (every ~5 minutes, or ./stack skills by hand).'
          : <>Host synced <span className="mono">{relative(report.when)}</span>. Edits reach disk on the next sync, within ~5 minutes.</>}
      </span>
      <button className="lp-primary" disabled={busy === 'sk:new'} onClick={onNew}><span className="plus">+</span>New skill</button>
    </div>

    {places.map((pl) => {
      const rows = skills.filter((s) => s.scope === pl.scope && (pl.scope === 'global' || s.slug === pl.slug));
      if (pl.scope !== 'global' && !rows.length) return null;
      return (
        <div className="sa-group" key={`${pl.scope}:${pl.slug}`}>
          <div className="sa-grouphead">
            <h2>{pl.label}</h2>
            <span className="k">{place(pl.scope, pl.slug)}</span>
            <span className="hair" />
            <span className="k">{rows.length}</span>
          </div>
          <div className="sa-card">
            {rows.length === 0 && (
              <div className="sa-empty">
                No global skills yet. A skill is a set of instructions Claude loads when its description
                matches what you are doing: a review checklist, a deploy runbook, a house style.
              </div>
            )}
            {rows.map((s) => {
              const [text, tone, title] = skillState(s, onDisk.has(diskKey(s)));
              return (
                <div className="sa-skrow" key={s.id} role="button" tabIndex={0} onClick={() => onOpen(s.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') onOpen(s.id); }}>
                  <Switch on={s.enabled} disabled={busy === `sk:${s.id}:on`}
                    title={s.enabled ? 'On: the host keeps this on disk' : 'Off: the host removes it from disk, the library keeps it'}
                    onToggle={() => void run(`sk:${s.id}:on`, () => patchSkill(s.id, { enabled: !s.enabled }))} />
                  <div className="who">
                    <span className={`n${s.enabled ? '' : ' off'}`}>{s.name || 'unnamed'}</span>
                    <span className="d">{s.description || 'No description. Claude has nothing to match on.'}</span>
                  </div>
                  <span className="sa-all" title="Stack does not scope a skill to agents">All agents</span>
                  <span className="sa-state" title={title} style={{ background: `var(--status-${tone}-bg)`, color: `var(--status-${tone}-fg)` }}>{text}</span>
                </div>
              );
            })}
          </div>
        </div>
      );
    })}

    {unmanaged.length > 0 && (
      <div className="sa-group">
        <div className="sa-grouphead">
          <h2>Not managed by Stack</h2>
          <span className="note">On the host already. Reported, never touched.</span>
        </div>
        <div className="sa-card dashed">
          {unmanaged.map((d) => (
            <div className="sa-foreignrow" key={diskKey(d)}>
              <div className="who">
                <span className="n">{d.name}</span>
                <span className="d">{d.description || 'No description in its frontmatter.'}</span>
              </div>
              <span className="k" title={d.path}>{place(d.scope, d.slug)}</span>
              <button className="lp-btn" disabled={busy === `adopt:${diskKey(d)}`}
                title="Copy into the library so it can be edited and toggled here. The file is untouched until you change it."
                onClick={() => void run(`adopt:${diskKey(d)}`, async () => {
                  const s = await createSkill({ name: d.name, scope: d.scope, slug: d.slug, description: d.description, body: d.body });
                  onOpen(s.id);
                })}>Adopt</button>
            </div>
          ))}
        </div>
      </div>
    )}
  </>);
}

function SkillEditor({ s, data, projects, busy, run, onPick, onBack, onRemove }: {
  s: Skill; data: SkillsData; projects: string[]; busy: string; run: Run;
  onPick: (id: number) => void; onBack: () => void; onRemove: (s: Skill) => void;
}) {
  const onDisk = new Set(data.report.skills.map(diskKey));
  const stateOf = (x: Skill) => skillState(x, onDisk.has(diskKey(x)));
  const [text, tone, title] = stateOf(s);
  const save = (input: SkillInput, token = `sk:${s.id}`) => void run(token, () => patchSkill(s.id, input));
  const path = `${place(s.scope, s.slug)}/${s.name || '…'}/SKILL.md`;

  return (
    <div className="sa-edit">
      <nav className="sa-rail">
        <button className="sa-back" onClick={onBack}>← All skills</button>
        {data.skills.map((x) => (
          <button key={x.id} className={`sa-railrow mono${x.id === s.id ? ' on' : ''}${x.enabled ? '' : ' off'}`} onClick={() => onPick(x.id)}>
            <span className="sa-dot" style={{ background: `var(--status-${stateOf(x)[1]}-fg)` }} />{x.name || 'unnamed'}
          </button>
        ))}
      </nav>

      <div className="sa-main">
        <Draft className="sa-bigname mono" value={s.name} aria-label="Skill name"
          transform={(v) => v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 64)}
          onSave={(v) => v && save({ name: v })} />
        <Draft area rows={2} className="sa-descin" value={s.description} aria-label="Skill description"
          placeholder="When should Claude reach for this?" onSave={(v) => save({ description: v })} />
        <Eyebrow aside={path}>SKILL.md</Eyebrow>
        <Draft area className="sa-body" value={s.body} aria-label="Skill body"
          placeholder="The instructions, in markdown. The frontmatter is written for you." onSave={(v) => save({ body: v })} />
      </div>

      <aside className="sa-side">
        <div className="sa-onrow">
          <span className="sa-state" title={title} style={{ background: `var(--status-${tone}-bg)`, color: `var(--status-${tone}-fg)` }}>{text}</span>
          <Switch on={s.enabled} disabled={busy === `sk:${s.id}:on`}
            title={s.enabled ? 'On: the host keeps this on disk' : 'Off: the host removes it from disk, the library keeps it'}
            onToggle={() => save({ enabled: !s.enabled }, `sk:${s.id}:on`)} />
        </div>
        <span className="note">{title}</span>

        <div className="sa-sect">
          <Eyebrow>Where</Eyebrow>
          <div className="lp-seg">
            {([['global', 'Global'], ['project', 'One project']] as const).map(([k, label]) => (
              <button key={k} className={s.scope === k ? 'on' : ''} disabled={k === 'project' && !projects.length}
                onClick={() => s.scope !== k && save({ scope: k, slug: k === 'project' ? projects[0] : '' })}>{label}</button>
            ))}
          </div>
          {s.scope === 'project' && (
            <select className="lp-select mono sm" value={s.slug} aria-label="Project" onChange={(e) => save({ slug: e.target.value })}>
              {(projects.includes(s.slug) ? projects : [s.slug, ...projects]).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
        </div>

        <div className="sa-sect">
          <Eyebrow>Loaded by</Eyebrow>
          <div><span className="sa-all">All agents</span></div>
          <span className="note">Stack does not scope a skill to agents. Once on disk, Claude loads it in any session whose work matches the description.</span>
        </div>

        <button className="lp-btn danger sa-del" onClick={() => onRemove(s)}>Delete skill</button>
      </aside>
    </div>
  );
}
