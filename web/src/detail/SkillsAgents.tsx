// SKILLS & AGENTS — the Claude Design "Roadmap Canvas" project's `agents` view
// (2026-10-12), WIRED. Both halves already had a backend and a screen, and
// this tab is a second face on each, not a second truth:
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
// THREE RULES THIS SCREEN KEEPS THAT THE DESIGN DID NOT STATE:
//
//  1. WITH NO ADVISOR NOTHING SPAWNS. `--agents` is only passed when an
//     advisor is set; the frame leads with that, because live-looking switches
//     over an inert catalogue are the most expensive lie this screen could
//     tell. The design's copy had the roles the old way round (#285 inverted
//     them): the ADVISOR runs the session and the EXECUTOR is the subagent.
//  2. THE LAST TOOL CANNOT BE REVOKED. The engine refuses an empty grant (a
//     profile that can do nothing is a no-op), so the cell refuses first.
//  3. AN UNMANAGED SKILL IS NEVER TOUCHED. Adopt copies it into the library;
//     the file on disk is unchanged until the library's copy is edited.
//
// Text fields are drafts that save when they lose focus (the design saved per
// keystroke, which would be one PATCH per letter and a host re-sync each).
// Deleting a skill asks first: it deletes the file on the host's next sync.

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
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
      disabled={disabled} onClick={onToggle}>
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

  const run = async (token: string, fn: () => Promise<unknown>) => {
    setBusy(token); setErr('');
    try { await fn(); load(); }
    catch (e) { fail(e, 'That did not save.'); }
    finally { setBusy(''); }
  };

  const tabs: [SaTab, string, number | string][] = [
    ['agents', 'Agents', room ? room.profiles.length : ''],
    ['skills', 'Skills', skills ? skills.skills.length : ''],
  ];

  return (
    <div className="sa">
      <div className="sa-inner">
        <div className="sa-head">
          <div className="sa-title">
            <h1>Skills &amp; agents</h1>
            <span>
              How Claude works across the fleet: the subagents a run can spawn, and the skills every
              session loads. Held here, written to the host. App-wide, not just this project.
            </span>
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

        {tab === 'agents' && (room
          ? <Agents room={room} models={models} busy={busy} run={run} open={agOpen} setOpen={setAgOpen} />
          : <div className="sa-loading">Loading the profiles…</div>)}
        {tab === 'skills' && (skills
          ? <Skills data={skills} projects={projects} busy={busy} run={run} open={skOpen} setOpen={setSkOpen} onRemove={setRemoving} />
          : <div className="sa-loading">Loading the library…</div>)}
      </div>

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

type Run = (token: string, fn: () => Promise<unknown>) => Promise<void>;

function Agents({ room, models, busy, run, open, setOpen }: {
  room: AgentProfilesRoom; models: ModelsRoom | null; busy: string; run: Run;
  open: string | null; setOpen: (k: string | null) => void;
}) {
  const { policy, knownTools } = room;
  const spawns = policy.spawnsAgents;
  // A value that is not in a catalogue (an old pin, a renamed model) still
  // gets an option, or the select would silently show a different one.
  const withCurrent = (opts: { model: string; label: string }[], cur: string) =>
    (cur && !opts.some((o) => o.model === cur) ? [...opts, { model: cur, label: cur }] : opts);
  const execOpts = withCurrent(models?.policy.executorCatalogue ?? [{ model: '', label: 'CLI default' }], policy.executorModel);
  const advOpts = withCurrent(models?.policy.advisorCatalogue ?? [{ model: '', label: 'None' }], policy.advisorModel);
  const cols = { gridTemplateColumns: `minmax(240px,1fr) 184px repeat(${knownTools.length},40px) 64px 48px` };
  const exec = room.profiles.find((p) => p.key === 'executor');

  const newAgent = () => {
    const taken = new Set(room.profiles.map((p) => p.key));
    let n = 1;
    while (taken.has(`agent-${n}`)) n++;
    const key = `agent-${n}`;
    const tools = ['Read', 'Grep', 'Glob'].filter((t) => knownTools.includes(t));
    void run('new', async () => {
      await createAgentProfile({ key, name: 'New agent', description: '', prompt: '', model: '', tools: tools.length ? tools : knownTools.slice(0, 1) });
      setOpen(key);
    });
  };

  return (<>
    <div className="sa-policy">
      <label className="cell">
        <span className="eyebrow">Advisor model</span>
        <select className="lp-select mono" value={policy.advisorModel} disabled={busy === 'policy'}
          onChange={(e) => { const v = e.target.value; void run('policy', () => patchSettings({ autopilotAdvisorModel: v })); }}>
          {advOpts.map((o) => <option key={o.model} value={o.model}>{o.label}</option>)}
        </select>
        <span className="note">Runs the session: plans, delegates, verifies, commits. None = a single-model run.</span>
      </label>
      <label className="cell">
        <span className="eyebrow">Executor model</span>
        <select className="lp-select mono" value={policy.executorModel} disabled={busy === 'policy'}
          onChange={(e) => { const v = e.target.value; void run('policy', () => patchSettings({ autopilotExecutorModel: v })); }}>
          {execOpts.map((o) => <option key={o.model} value={o.model}>{o.label}</option>)}
        </select>
        <span className="note">The subagent with the write tools, and what a profile set to inherit runs as.</span>
      </label>
      <div className="cell">
        <span className="eyebrow">Spawning</span>
        <span className={`sa-spawn ${spawns ? 'yes' : 'no'}`}><span className="dot" />{spawns ? 'Subagents spawn' : 'Nothing spawns'}</span>
        <span className="note">
          {spawns ? 'Runs are handed every enabled profile below via ' : 'No advisor is set, so '}
          <code>--agents</code>
          {spawns ? '.' : ' is never passed and the switches below change nothing.'}
        </span>
      </div>
    </div>

    <div className="sa-card">
      <div className="sa-cardhead">
        <h2>Profiles</h2>
        <span className="note">Click a tool to grant or revoke it. Click a name to edit the prompt.</span>
        <span className="rc-grow" />
        <button className="lp-primary" disabled={busy === 'new'} onClick={newAgent}><span className="plus">+</span>New agent</button>
      </div>
      <div className="sa-scrollx">
        <div className="sa-grid" style={{ minWidth: 560 + knownTools.length * 48 }}>
          <div className="sa-gridrow head" style={cols}>
            <span className="eyebrow">Agent</span>
            <span className="eyebrow">Model</span>
            {knownTools.map((t) => <span key={t} className="sa-toolhead">{t}</span>)}
            <span className="eyebrow end" title="Open items that would spawn this profile">Items</span>
            <span className="eyebrow end">On</span>
          </div>
          {room.profiles.map((p) => (
            <ProfileRow key={p.key} p={p} room={room} cols={cols} busy={busy} run={run}
              execOpts={withCurrent(models?.policy.executorCatalogue.filter((o) => o.model) ?? [], p.model)}
              open={open === p.key} onToggleOpen={() => setOpen(open === p.key ? null : p.key)}
              onDeleted={() => setOpen(null)} />
          ))}
        </div>
      </div>
      <div className="sa-cardfoot">
        <span>{exec && exec.enabled ? 'A run that names no profile spawns' : 'The executor is off, so a run that names no profile falls back to'}</span>
        <code>{room.defaultSpawn.keys.join(', ') || 'the built-in executor'}</code>
        {room.defaultSpawn.reason && <span className="why">{room.defaultSpawn.reason}</span>}
      </div>
    </div>
    <p className="sa-capnote">
      <a href={hrefTo.control}>Mission Control → Agents</a> draws the same profiles, with each one's
      state spelled out.
    </p>
  </>);
}

function ProfileRow({ p, room, cols, busy, run, execOpts, open, onToggleOpen, onDeleted }: {
  p: AgentProfile; room: AgentProfilesRoom; cols: CSSProperties; busy: string; run: Run;
  execOpts: { model: string; label: string }[]; open: boolean; onToggleOpen: () => void; onDeleted: () => void;
}) {
  const used = room.usage[p.key] ?? 0;
  const save = (patch: Parameters<typeof patchAgentProfile>[1], token = `${p.key}:edit`) =>
    void run(token, () => patchAgentProfile(p.key, patch));
  const inherit = `inherit · ${short(room.policy.executorModel) || 'CLI default'}`;
  return (
    <div className={`sa-prof${open ? ' open' : ''}`}>
      <div className="sa-gridrow" style={cols}>
        <button className="sa-profname" onClick={onToggleOpen} aria-expanded={open}>
          <span className="caret">{open ? '▾' : '▸'}</span>
          <span className="tx">
            <span className="line">
              <span className={`n${p.enabled ? '' : ' off'}`}>{p.name}</span>
              <span className="k">{p.key}</span>
              {p.builtin && <span className="chip">built-in</span>}
            </span>
            <span className="d">{p.description || 'No description'}</span>
          </span>
        </button>
        <select className="lp-select mono sm" value={p.model} aria-label={`${p.name} model`} disabled={busy === `${p.key}:edit`}
          onChange={(e) => save({ model: e.target.value })}>
          <option value="">{inherit}</option>
          {execOpts.map((o) => <option key={o.model} value={o.model}>{short(o.label)}</option>)}
        </select>
        {room.knownTools.map((t) => {
          const on = p.tools.includes(t);
          const last = on && p.tools.length === 1;
          return (
            <button key={t} className={`sa-tool${on ? ' on' : ''}`} aria-pressed={on} disabled={last || busy === `${p.key}:tools`}
              title={last ? `${t} is its only tool, and a profile with none can do nothing` : `${on ? 'Revoke' : 'Grant'} ${t}`}
              onClick={() => save({ tools: on ? p.tools.filter((x) => x !== t) : [...p.tools, t] }, `${p.key}:tools`)}>
              {on ? '✓' : ''}
            </button>
          );
        })}
        <span className={`sa-usage${used ? '' : ' zero'}`}>{used}</span>
        <span className="sa-on">
          <Switch on={p.enabled} disabled={busy === `${p.key}:on`}
            title={p.enabled ? 'On: handed to runs' : 'Off: kept, never spawned'}
            onToggle={() => save({ enabled: !p.enabled }, `${p.key}:on`)} />
        </span>
      </div>
      {open && (
        <div className="sa-profbody">
          <div className="col">
            <label className="sa-field">
              <span className="eyebrow">Name</span>
              <Draft className="sa-input" value={p.name} aria-label="Name" onSave={(v) => v.trim() && save({ name: v.trim() })} />
            </label>
            <label className="sa-field">
              <span className="eyebrow">Description</span>
              <Draft area className="sa-input" rows={3} value={p.description} aria-label="Description"
                placeholder="When should a run hand work to this agent?" onSave={(v) => save({ description: v })} />
            </label>
            <span className="note">{p.tools.length ? `Granted ${p.tools.join(', ')}.` : 'No tools granted. It can only answer in text.'}</span>
            <div className="sa-actions">
              {p.builtin
                ? <span className="note">Built-in profiles can be turned off, not deleted.</span>
                : <button className="lp-btn danger" disabled={busy === `${p.key}:del`}
                    onClick={() => void run(`${p.key}:del`, async () => { await deleteAgentProfile(p.key); onDeleted(); })}>
                    Delete profile
                  </button>}
            </div>
          </div>
          <label className="sa-field">
            <span className="sa-fieldhead"><span className="eyebrow">System prompt</span><span className="rc-grow" /><span className="k">{words(p.prompt)} words</span></span>
            <Draft area className="sa-input code" rows={11} value={p.prompt} aria-label="System prompt" onSave={(v) => save({ prompt: v })} />
          </label>
        </div>
      )}
    </div>
  );
}

function Skills({ data, projects, busy, run, open, setOpen, onRemove }: {
  data: SkillsData; projects: string[]; busy: string; run: Run;
  open: number | null; setOpen: (id: number | null) => void; onRemove: (s: Skill) => void;
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
  const save = (s: Skill, input: SkillInput, token = `sk:${s.id}`) => void run(token, () => patchSkill(s.id, input));
  const free = (base: string) => {
    const taken = new Set(skills.filter((s) => s.scope === 'global').map((s) => s.name));
    let n = base, i = 2;
    while (taken.has(n)) n = `${base}-${i++}`;
    return n;
  };
  const hostQuiet = !report.when;

  return (<>
    <div className="sa-hostline">
      <span className={`dot${hostQuiet ? ' quiet' : ''}`} />
      <span className="tx">
        {hostQuiet
          ? 'The host has not reported yet. The library below is real; what is on disk is unknown until the next sync (every ~5 minutes, or ./stack skills by hand).'
          : `Host synced ${relative(report.when)} · ${disk.filter((d) => d.managed).length} managed skills on disk. Edits reach disk on the next sync, within ~5 minutes.`}
      </span>
      <button className="lp-primary" disabled={busy === 'sk:new'}
        onClick={() => void run('sk:new', async () => { const s = await createSkill({ name: free('new-skill'), scope: 'global', slug: '', description: '', body: '' }); setOpen(s.id); })}>
        <span className="plus">+</span>New skill
      </button>
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
              const isOpen = open === s.id;
              return (
                <div className={`sa-skill${isOpen ? ' open' : ''}`} key={s.id}>
                  <div className="sa-skillrow">
                    <Switch on={s.enabled} disabled={busy === `sk:${s.id}:on`}
                      title={s.enabled ? 'On: the host keeps this on disk' : 'Off: the host removes it from disk, the library keeps it'}
                      onToggle={() => save(s, { enabled: !s.enabled }, `sk:${s.id}:on`)} />
                    <div className={`main${s.enabled ? '' : ' off'}`}>
                      <span className="line">
                        <span className="n">{s.name || 'unnamed'}</span>
                        <span className="state" title={title} style={{ background: `var(--status-${tone}-bg)`, color: `var(--status-${tone}-fg)` }}>{text}</span>
                      </span>
                      <span className={`d${s.description ? '' : ' none'}`}>{s.description || 'No description. Claude has nothing to match on.'}</span>
                    </div>
                    <span className="k" title={place(s.scope, s.slug)}>{place(s.scope, s.slug)}</span>
                    <button className="lp-btn" onClick={() => setOpen(isOpen ? null : s.id)} aria-expanded={isOpen}>{isOpen ? 'Done' : 'Edit'}</button>
                  </div>
                  {isOpen && (
                    <div className="sa-skillbody">
                      <div className="col">
                        <label className="sa-field">
                          <span className="eyebrow">Name</span>
                          <Draft className="sa-input mono" value={s.name} aria-label="Skill name"
                            transform={(v) => v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 64)}
                            onSave={(v) => v && save(s, { name: v })} />
                          <span className="note">Lower-case and hyphens. It is the directory name on disk.</span>
                        </label>
                        <label className="sa-field">
                          <span className="eyebrow">Description</span>
                          <Draft area className="sa-input" rows={3} value={s.description} aria-label="Skill description"
                            placeholder="When should Claude reach for this?" onSave={(v) => save(s, { description: v })} />
                          <span className="note">Claude reads this to decide whether the skill applies. Write the trigger, not the summary.</span>
                        </label>
                        <div className="sa-field">
                          <span className="eyebrow">Where</span>
                          <div className="sa-where">
                            <div className="lp-seg">
                              {([['global', 'Global'], ['project', 'One project']] as const).map(([k, label]) => (
                                <button key={k} className={s.scope === k ? 'on' : ''} disabled={k === 'project' && !projects.length}
                                  onClick={() => s.scope !== k && save(s, { scope: k, slug: k === 'project' ? projects[0] : '' })}>{label}</button>
                              ))}
                            </div>
                            {s.scope === 'project' && (
                              <select className="lp-select mono sm" value={s.slug} aria-label="Project"
                                onChange={(e) => save(s, { slug: e.target.value })}>
                                {(projects.includes(s.slug) ? projects : [s.slug, ...projects]).map((p) => <option key={p} value={p}>{p}</option>)}
                              </select>
                            )}
                          </div>
                        </div>
                        <div className="sa-actions">
                          <button className="lp-btn danger" onClick={() => onRemove(s)}>Delete</button>
                          <span className="note">To stop Claude loading it, turn it off instead.</span>
                        </div>
                      </div>
                      <label className="sa-field">
                        <span className="sa-fieldhead">
                          <span className="eyebrow">The skill</span><span className="rc-grow" />
                          <span className="k path" title={`${place(s.scope, s.slug)}/${s.name}/SKILL.md`}>{place(s.scope, s.slug)}/{s.name || '…'}/SKILL.md</span>
                        </span>
                        <Draft area className="sa-input code" rows={13} value={s.body} aria-label="Skill body"
                          placeholder="The instructions, in markdown. The frontmatter is written for you." onSave={(v) => save(s, { body: v })} />
                        <span className="note">Saved to the library when you leave the field. The host puts it on disk within ~5 minutes.</span>
                      </label>
                    </div>
                  )}
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
          <span className="hair" />
          <span className="k">{unmanaged.length}</span>
        </div>
        <div className="sa-card dashed">
          {unmanaged.map((d) => (
            <div className="sa-skillrow" key={diskKey(d)}>
              <span className="sa-foreign" title="Not written by Stack">◇</span>
              <div className="main">
                <span className="line"><span className="n dim">{d.name}</span></span>
                <span className="d none">{d.description || 'No description in its frontmatter.'}</span>
              </div>
              <span className="k" title={d.path}>{place(d.scope, d.slug)}</span>
              <button className="lp-btn" disabled={busy === `adopt:${diskKey(d)}`}
                title="Copy into the library so it can be edited and toggled here. The file is untouched until you change it."
                onClick={() => void run(`adopt:${diskKey(d)}`, async () => {
                  const s = await createSkill({ name: d.name, scope: d.scope, slug: d.slug, description: d.description, body: d.body });
                  setOpen(s.id);
                })}>↥ Adopt</button>
            </div>
          ))}
        </div>
      </div>
    )}
  </>);
}
