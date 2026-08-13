import { useCallback, useEffect, useState } from 'react';
import {
  getSkills, createSkill, patchSkill, deleteSkill, getProjects, AuthError,
  type Skill, type SkillOnDisk, type SkillsData,
} from '../store';
import { go, hrefTo } from '../lib/route';
import { PRODUCT_NAME } from '../lib/ui';
import { useAutoRefresh } from '../lib/autoRefresh';
import { Modal } from '../components/Modal';
import { ConfirmModal } from '../components/ConfirmModal';

// The SKILL TREE (#228) — the skills that shape Claude, managed from one place
// instead of by hand-editing files on the host.
//
// Two things are on this screen and they are NOT the same thing, which is the
// whole reason it is a tree rather than a list: the LIBRARY (what Stack holds,
// and would write) and the DISK (what the host actually has). A row states
// both. A library skill that is enabled but not installed is waiting on the
// host's next sync; one the host reports missing has been deleted by hand; and
// a skill on disk that Stack did not plant is somebody else's file — reported,
// never touched, and adoptable rather than overwritten.
//
// The sync is the host's (`scripts/stack-skills.mjs`, on the dispatcher's
// 5-minute tick), so nothing here is instant and the screen says so rather
// than animating a success it cannot observe.

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

const placeLabel = (scope: string, slug: string) =>
  (scope === 'project' ? `~/${slug}/.claude` : '~/.claude');

// What a row says about itself, in one phrase. The order matters: "disabled"
// beats everything (it is a decision, not a state to worry about), and "not on
// disk yet" is deliberately different from "missing" — one is a wait, the
// other is a discrepancy.
const installState = (s: Skill, onDisk: boolean): { tone: string; text: string; title: string } => {
  if (!s.enabled) {
    return { tone: 'off', text: 'disabled', title: 'Kept in the library; the host removes it from disk on its next sync.' };
  }
  if (s.installedAt && onDisk) {
    return { tone: 'on', text: `installed ${relative(s.installedAt)}`, title: 'On disk on the host, and matching this content.' };
  }
  if (!s.installedAt && onDisk) {
    return { tone: 'wait', text: 'edited — sync pending', title: 'On disk, but the library has changed since. The host rewrites it on its next sync (within ~5 minutes).' };
  }
  if (s.installedAt && !onDisk) {
    return { tone: 'warn', text: 'missing from disk', title: 'Stack wrote this and the host no longer reports it — deleted by hand, or the project was never cloned on this host.' };
  }
  return { tone: 'wait', text: 'not written yet', title: 'Waiting on the host sync (within ~5 minutes), or the project has no checkout on this host.' };
};

function SkillModal({ skill, projects, onClose, onSave }: {
  skill: Partial<Skill> | null;
  projects: string[];
  onClose: () => void;
  onSave: (input: { name: string; scope: 'global' | 'project'; slug: string; description: string; body: string }) => Promise<void>;
}) {
  const [name, setName] = useState(skill?.name ?? '');
  const [scope, setScope] = useState<'global' | 'project'>(skill?.scope ?? 'global');
  const [slug, setSlug] = useState(skill?.slug ?? (projects[0] ?? ''));
  const [description, setDescription] = useState(skill?.description ?? '');
  const [body, setBody] = useState(skill?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setErr('');
    try { await onSave({ name, scope, slug: scope === 'project' ? slug : '', description, body }); }
    catch (e) { setErr((e as Error)?.message || 'Could not save.'); setBusy(false); }
  };

  return (
    <Modal onClose={onClose} closeOnOverlay={false}>
      <h3>{skill?.id ? `Edit ${skill.name}` : 'New skill'}</h3>
      <div className="sk-form">
        <label className="sk-field">
          <span>Name</span>
          <input className="field-input" value={name} autoFocus
            placeholder="code-review"
            onChange={(e) => setName(e.target.value)} />
          <em>Lower-case and hyphens — it is the directory name on disk.</em>
        </label>

        <label className="sk-field">
          <span>Description</span>
          <textarea className="field-input" rows={2} value={description}
            placeholder="When should Claude reach for this? This line is what decides relevance."
            onChange={(e) => setDescription(e.target.value)} />
          <em>Claude reads this to decide whether the skill applies, so write the trigger, not the summary.</em>
        </label>

        <div className="sk-field">
          <span>Where</span>
          <div className="seg-control sm">
            <button className={`seg-opt ${scope === 'global' ? 'on' : ''}`} onClick={() => setScope('global')}>
              Global
            </button>
            <button className={`seg-opt ${scope === 'project' ? 'on' : ''}`} onClick={() => setScope('project')}
              disabled={projects.length === 0}>
              One project
            </button>
          </div>
          {scope === 'project' ? (
            <select className="field-input sm" value={slug} onChange={(e) => setSlug(e.target.value)}>
              {projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          ) : (
            <em>Every session on this host, from <code>~/.claude/skills</code>.</em>
          )}
        </div>

        <label className="sk-field">
          <span>The skill</span>
          <textarea className="field-input sk-body" rows={14} value={body}
            placeholder={'The instructions themselves, in markdown.\n\nThe frontmatter is written for you — this is everything under it.'}
            onChange={(e) => setBody(e.target.value)} />
        </label>

        {err && <div className="action-error">{err}</div>}
        <div className="sk-form-actions">
          <span className="sk-hint">Saving writes it to the library — the host puts it on disk within ~5 minutes.</span>
          <button className="btn-cancel" onClick={onClose}>Cancel</button>
          <button className="btn-submit" disabled={!name.trim() || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save skill'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function Skills() {
  const [data, setData] = useState<SkillsData | null>(null);
  // The project list is only needed to say WHERE a project skill goes, so the
  // screen fetches its own rather than being handed one — same as the corner ＋.
  const [projects, setProjects] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Partial<Skill> | null>(null);
  const [removing, setRemoving] = useState<Skill | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(() => {
    getSkills().then((d) => { setData(d); setError(''); })
      .catch((e) => { if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not load the skill tree.'); });
  }, []);
  useEffect(() => {
    load();
    getProjects().then((ps) => setProjects(ps.map((p) => p.id))).catch(() => { /* global skills still work */ });
  }, [load]);
  // The host syncs on its own clock, so the screen re-reads rather than
  // pretending an edit landed on disk the moment it was saved. #312 — the
  // cadence (and the hidden-tab rule this poll already followed) is the
  // device's Auto refresh setting now.
  useAutoRefresh(load);

  const skills = data?.skills ?? [];
  const disk = data?.report.skills ?? [];
  const diskKey = (s: { scope: string; slug: string; name: string }) => `${s.scope}:${s.slug || ''}:${s.name}`;
  const onDisk = new Set(disk.map(diskKey));
  const managedNames = new Set(skills.map(diskKey));
  // Skills the host has that Stack does not manage. These are the reason the
  // report carries bodies: adopting one has to bring the real thing across.
  const unmanaged = disk.filter((d) => !d.managed && !managedNames.has(diskKey(d)));

  // The tree's groups: global first, then a group per project that has skills.
  const places = [
    { scope: 'global' as const, slug: '', label: 'Global', sub: '~/.claude/skills — every session on this host' },
    ...[...new Set(skills.filter((s) => s.scope === 'project').map((s) => s.slug))].sort()
      .map((slug) => ({ scope: 'project' as const, slug, label: slug, sub: `~/${slug}/.claude/skills — sessions in this project` })),
  ];

  const act = async (id: number, fn: () => Promise<unknown>) => {
    setBusyId(id); setError('');
    try { await fn(); load(); }
    catch (e) { if (!(e instanceof AuthError)) setError((e as Error)?.message || 'That didn’t land.'); }
    finally { setBusyId(null); }
  };

  const save = async (input: { name: string; scope: 'global' | 'project'; slug: string; description: string; body: string }) => {
    if (editing?.id) await patchSkill(editing.id, input);
    else await createSkill(input);
    setEditing(null);
    load();
  };

  const report = data?.report;
  // The host is the only side that can see ~/.claude, so an absent report is a
  // real state with its own sentence — never an empty tree implying no skills.
  const hostQuiet = !report?.when;

  return (
    <div className="term-screen">
      <div className="topbar">
        <div className="crumb">
          <span className="chev" onClick={go.dashboard}>‹</span>
          <span className="back" onClick={go.dashboard}>Projects</span>
          <span className="sep">/</span>
          <span className="here">Skills</span>
        </div>
        <div className="right">
          <a className="btn-repo" href={hrefTo.settings}>Settings</a>
          <a className="btn-repo" href={hrefTo.control()}>Mission Control</a>
          <div className="brandmark"><span className="sq" /><span className="word">{PRODUCT_NAME}</span></div>
        </div>
      </div>

      <div className="page detail sk-page">
        <div className="sk-head">
          <div className="sk-title">
            <h1>Skill tree</h1>
            <p>
              The skills that shape Claude, held here and written to the host — so how the fleet
              works is tuned from one place instead of by hand-editing files over ssh.
            </p>
          </div>
          <button className="btn-submit" onClick={() => setEditing({})}>+ New skill</button>
        </div>

        {error && <div className="action-error">{error}</div>}

        <div className="sk-hostline">
          <span className={`ddot ${hostQuiet ? '' : 'on'}`} />
          {hostQuiet ? (
            <span>
              The host has not reported yet. The library below is real; what is on disk is unknown
              until the dispatcher's next sync — it runs every ~5 minutes, or <code>./stack skills</code> by hand.
            </span>
          ) : (
            <span>
              Host synced {relative(report!.when)}{report!.detail ? ` — ${report!.detail}` : ''}.
              Edits reach disk on the next sync, within ~5 minutes.
            </span>
          )}
        </div>

        {!data ? (
          <div className="mc14-empty">Loading the tree…</div>
        ) : (<>
          {places.map((place) => {
            const rows = skills.filter((s) => s.scope === place.scope && (s.scope === 'global' || s.slug === place.slug));
            if (place.scope !== 'global' && rows.length === 0) return null;
            return (
              <div className="sk-group" key={`${place.scope}:${place.slug}`}>
                <div className="sk-group-head">
                  <span className="nm">{place.label}</span>
                  <span className="sub">{place.sub}</span>
                  <span className="hair" />
                  <span className="n">{rows.length}</span>
                </div>
                {rows.length === 0 ? (
                  <div className="sk-empty">
                    No global skills yet. A skill is a set of instructions Claude loads when its
                    description matches what you are doing — a review checklist, a deploy runbook,
                    a house style.
                  </div>
                ) : rows.map((s) => {
                  const st = installState(s, onDisk.has(diskKey(s)));
                  return (
                    <div className={`sk-row${s.enabled ? '' : ' off'}`} key={s.id}>
                      <button className={`switch sm ${s.enabled ? 'on' : ''}`} role="switch"
                        aria-checked={s.enabled} disabled={busyId === s.id}
                        aria-label={s.enabled ? `Disable ${s.name}` : `Enable ${s.name}`}
                        title={s.enabled
                          ? 'On — the host keeps this on disk'
                          : 'Off — the host removes it from disk, the library keeps it'}
                        onClick={() => void act(s.id, () => patchSkill(s.id, { enabled: !s.enabled }))}>
                        <span className="switch-knob" />
                      </button>
                      <div className="sk-row-main">
                        <div className="t">
                          <b>{s.name}</b>
                          <span className={`sk-state ${st.tone}`} title={st.title}>{st.text}</span>
                        </div>
                        <div className="d">{s.description || <em>No description — Claude has nothing to match on.</em>}</div>
                      </div>
                      <span className="sk-where" title={placeLabel(s.scope, s.slug)}>{placeLabel(s.scope, s.slug)}</span>
                      <span className="sk-acts">
                        <button className="btn-repo sm" onClick={() => setEditing(s)}>✎ Edit</button>
                        <button className="sk-x" title="Remove from the library and from disk"
                          aria-label={`Delete ${s.name}`} onClick={() => setRemoving(s)}>×</button>
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}

          {unmanaged.length > 0 && (
            <div className="sk-group unmanaged">
              <div className="sk-group-head">
                <span className="nm">Not managed by Stack</span>
                <span className="sub">on the host already — reported, never touched</span>
                <span className="hair" />
                <span className="n">{unmanaged.length}</span>
              </div>
              <div className="sk-note">
                Stack only writes and removes skills it planted, so these are left exactly as they
                are. Adopt one to bring it into the library — the file is not changed until you
                edit it here.
              </div>
              {unmanaged.map((d: SkillOnDisk) => (
                <div className="sk-row" key={`${d.scope}:${d.slug}:${d.name}`}>
                  <span className="sk-foreign" title="Not written by Stack">◇</span>
                  <div className="sk-row-main">
                    <div className="t"><b>{d.name}</b></div>
                    <div className="d">{d.description || <em>No description in its frontmatter.</em>}</div>
                  </div>
                  <span className="sk-where" title={d.path}>{placeLabel(d.scope, d.slug)}</span>
                  <span className="sk-acts">
                    <button className="btn-repo sm"
                      title="Copy this skill into the library so it can be edited and toggled here. The file on disk is untouched until you change it."
                      onClick={() => setEditing({
                        name: d.name, scope: d.scope, slug: d.slug,
                        description: d.description, body: d.body,
                      })}>
                      ↥ Adopt
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>)}
      </div>

      {editing && (
        <SkillModal skill={editing} projects={projects}
          onClose={() => setEditing(null)} onSave={save} />
      )}
      {removing && (
        <ConfirmModal
          title={`Delete ${removing.name}?`}
          danger
          confirmLabel="Delete the skill"
          body={<>This removes it from the library, and the host deletes
            <code> {placeLabel(removing.scope, removing.slug)}/skills/{removing.name}</code> on its
            next sync. If you only want Claude to stop loading it, turn it off instead — that keeps
            the text here.</>}
          onCancel={() => setRemoving(null)}
          onConfirm={() => { const s = removing; setRemoving(null); if (s) void act(s.id, () => deleteSkill(s.id)); }}
        />
      )}
    </div>
  );
}
