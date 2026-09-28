import { useEffect, useMemo, useState } from 'react';
import type { Project, ProjectStatus, Overview, Spaces, SpaceArea, WishIdea, IdeaStage, Workflow } from '../types';
import {
  getProjects, getOverview, createProject, patchProject, getSpaces, createSpaceArea, renameSpaceArea, deleteSpaceArea,
  createIdea, patchIdea, deleteIdea, createWorkflow, patchWorkflow, getAreaRailFolded, setAreaRailFolded,
} from '../store';
import { hrefTo } from '../lib/route';
import { NewProjectModal, type ModalInit, type ModalValue } from '../components/NewProjectModal';
import { ConnectGuide } from '../components/ConnectGuide';
import { HowToGuide } from '../components/HowToGuide';
import { TopBar } from '../components/TopBar';
import { ResumeHero } from '../components/CommandDeck';

// THE PROJECTS PAGE: an area rail (owner-named groupings, foldable), then one
// section per area holding its app cards and its hubs (a hub is a project
// drawn as a row of the workflows it hosts), then the wishlist: ideas per area
// that aren't projects yet. Areas, workflows and ideas come from /api/spaces;
// the rail's fold is device-local. A project whose area key is unknown is read
// as Personal, which is the server's fallback too.

type Filter = 'all' | ProjectStatus;

// True when this app is rendered inside an iframe (e.g. its own card preview).
const framed = window.self !== window.top;
const STATUS_LABEL: Record<ProjectStatus, string> = {
  live: 'Live', building: 'Building', paused: 'Paused', archived: 'Archived',
};
const STAGES: IdeaStage[] = ['spark', 'scoped', 'ready'];
const STAGE_LABEL: Record<IdeaStage, string> = { spark: 'Spark', scoped: 'Scoped', ready: 'Ready' };
const WF_LABEL: Record<Workflow['status'], string> = { ok: '', failing: 'failed', paused: 'paused', never: 'never run' };
const EMPTY: Spaces = { areas: [], workflows: [], ideas: [] };

export function Dashboard({ onOpenSearch }: { onOpenSearch: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [spaces, setSpaces] = useState<Spaces>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [area, setArea] = useState<string>('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [menu, setMenu] = useState<string | null>(null);
  const [closedHubs, setClosedHubs] = useState<Record<string, boolean>>({});
  const [modal, setModal] = useState<ModalInit | null>(null);
  const [folded, setFolded] = useState(getAreaRailFolded);
  const [addingArea, setAddingArea] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; name: string } | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [howToOpen, setHowToOpen] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [deckError, setDeckError] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([getProjects(), getSpaces()])
      .then(([ps, sp]) => { if (live) { setProjects(ps); setSpaces(sp); setError(''); } })
      .catch((e) => { if (live) setError(e?.message || 'Failed to load projects.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  // The resume card loads on its own so an overview hiccup never blanks the grid.
  useEffect(() => {
    let live = true;
    getOverview()
      .then((o) => { if (live) { setOverview(o); setDeckError(''); } })
      .catch((e) => { if (live) setDeckError(e?.message || 'Failed to load the resume card.'); });
    return () => { live = false; };
  }, []);

  // Close an open card menu on Escape or a press anywhere else.
  useEffect(() => {
    if (!menu) return;
    const shut = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'mousedown' && (e.target as HTMLElement).closest?.('.sp-menu, .sp-corner')) return;
      setMenu(null);
    };
    window.addEventListener('mousedown', shut);
    window.addEventListener('keydown', shut);
    return () => { window.removeEventListener('mousedown', shut); window.removeEventListener('keydown', shut); };
  }, [menu]);

  const fail = (what: string) => (e: unknown) => setActionError((e as Error)?.message || `Could not ${what}.`);

  const areaKeys = useMemo(() => new Set(spaces.areas.map((a) => a.key)), [spaces.areas]);
  const areaOf = (p: { category: string }) => (areaKeys.has(p.category) ? p.category : 'personal');
  const apps = projects.filter((p) => p.kind === 'app');
  const hubs = projects.filter((p) => p.kind === 'hub');
  const unarchived = apps.filter((p) => p.status !== 'archived');
  const wfOf = (slug: string) => spaces.workflows.filter((w) => w.hub === slug);
  const liveHubs = hubs.filter((h) => h.status !== 'archived');
  const wfCount = liveHubs.reduce((n, h) => n + wfOf(h.id).length, 0);
  const countIn = (key: string) =>
    unarchived.filter((p) => areaOf(p) === key).length
    + liveHubs.filter((h) => areaOf(h) === key).reduce((n, h) => n + wfOf(h.id).length, 0);
  const failing = spaces.workflows.filter((w) => w.status === 'failing'
    && liveHubs.some((h) => h.id === w.hub)).length;

  const counts: Record<Filter, number> = {
    all: unarchived.length,
    live: apps.filter((p) => p.status === 'live').length,
    building: apps.filter((p) => p.status === 'building').length,
    paused: apps.filter((p) => p.status === 'paused').length,
    archived: projects.filter((p) => p.status === 'archived').length,
  };
  // Archived is a tab only while something is archived (or it is the one open).
  const tabs = (['all', 'live', 'building', 'paused', 'archived'] as Filter[])
    .filter((k) => k !== 'archived' || counts.archived > 0 || filter === 'archived');
  const shows = (p: Project) => (filter === 'all' ? p.status !== 'archived' : p.status === filter);

  // ---- writes ----

  const putProject = (p: Project) => setProjects((ps) => ps.map((x) => (x.id === p.id ? p : x)));
  const patch = async (p: Project, body: Parameters<typeof patchProject>[1]) => {
    setMenu(null);
    try { putProject(await patchProject(p.id, body)); } catch (e) { fail('update the project')(e); }
  };

  const addArea = async (name: string): Promise<string | null> => {
    try {
      const a = await createSpaceArea(name);
      setSpaces((s) => ({ ...s, areas: [...s.areas, a] }));
      return a.key;
    } catch (e) { fail('add the area')(e); return null; }
  };
  const saveRename = async () => {
    if (!renaming) return;
    const { key, name } = renaming;
    setRenaming(null);
    if (!name.trim()) return;
    try {
      const a = await renameSpaceArea(key, name.trim());
      setSpaces((s) => ({ ...s, areas: s.areas.map((x) => (x.key === key ? a : x)) }));
    } catch (e) { fail('rename the area')(e); }
  };
  const dropArea = async (a: SpaceArea) => {
    try {
      await deleteSpaceArea(a.key);
      setSpaces((s) => ({ ...s, areas: s.areas.filter((x) => x.key !== a.key) }));
      if (area === a.key) setArea('all');
    } catch (e) { fail('delete the area')(e); }
  };

  const addIdea = async (areaKey: string, title: string) => {
    try {
      const i = await createIdea({ area: areaKey, title });
      setSpaces((s) => ({ ...s, ideas: [...s.ideas, i] }));
    } catch (e) { fail('add the idea')(e); }
  };
  const putIdea = (i: WishIdea) => setSpaces((s) => ({ ...s, ideas: s.ideas.map((x) => (x.id === i.id ? i : x)) }));
  const cycle = async (i: WishIdea) => {
    const stage = STAGES[(STAGES.indexOf(i.stage) + 1) % STAGES.length];
    putIdea({ ...i, stage });
    try { putIdea(await patchIdea(i.id, { stage })); } catch (e) { putIdea(i); fail('change the stage')(e); }
  };
  const dropIdea = async (i: WishIdea) => {
    setSpaces((s) => ({ ...s, ideas: s.ideas.filter((x) => x.id !== i.id) }));
    try { await deleteIdea(i.id); } catch (e) { setSpaces((s) => ({ ...s, ideas: [...s.ideas, i] })); fail('remove the idea')(e); }
  };

  const toggleWorkflow = async (w: Workflow) => {
    try {
      const n = await patchWorkflow(w.id, { enabled: !w.enabled });
      setSpaces((s) => ({ ...s, workflows: s.workflows.map((x) => (x.id === n.id ? n : x)) }));
    } catch (e) { fail('change the workflow')(e); }
  };

  const openNew = (init: Partial<ModalInit> = {}) => {
    setMenu(null);
    setModal({ mode: 'new', area: area === 'all' ? 'personal' : area, ...init });
  };

  const submit = async (v: ModalValue) => {
    const m = modal!;
    setModal(null);
    try {
      if (m.mode === 'edit') {
        const p = projects.find((x) => x.id === m.slug);
        if (p) await patch(p, { name: v.name.trim(), subtitle: v.pitch, category: v.area, status: v.status });
        return;
      }
      if (v.type === 'workflow') {
        const w = await createWorkflow({ hub: v.hub, name: v.name, description: v.pitch, enabled: v.status !== 'paused' });
        setSpaces((s) => ({ ...s, workflows: [...s.workflows, w] }));
        setClosedHubs((c) => ({ ...c, [v.hub]: false }));
      } else {
        const p = await createProject({ name: v.name.trim(), subtitle: v.pitch, status: v.status, category: v.area, kind: v.type });
        setProjects((ps) => [...ps, p]);
      }
      // The idea only goes once its project exists; a failed delete leaves it listed.
      if (m.fromIdea) {
        const id = m.fromIdea;
        setSpaces((s) => ({ ...s, ideas: s.ideas.filter((x) => x.id !== id) }));
        await deleteIdea(id).catch(() => undefined);
      }
    } catch (e) { fail(m.mode === 'edit' ? 'save the project' : 'create it')(e); }
  };

  const foldRail = (f: boolean) => { setFolded(f); setAreaRailFolded(f); };

  // ---- pieces ----

  const card = (p: Project) => (
    <article key={p.id} className="sp-card" onMouseLeave={() => { if (menu === p.id) setMenu(null); }}>
      <a className="sp-card-link" href={hrefTo.detail(p.id)} aria-label={`Open ${p.name}`}>
        <span className="sp-preview">
          {p.siteUrl && !framed ? (
            // Live view of the deployed site, scaled to the card. Inert to the
            // pointer and keyboard, and skipped when Stack is itself framed so
            // its own card can't recurse.
            <span className="frame" aria-hidden="true">
              <iframe src={p.siteUrl} loading="lazy" tabIndex={-1} title="" referrerPolicy="no-referrer" />
            </span>
          ) : <span className="ph">preview</span>}
          <span className={`sp-pill st-${p.status}`}>{STATUS_LABEL[p.status]}</span>
          {p.automode && <span className="sp-pill auto" title="Automode — the overnight autopilot may work this project">⚙ auto</span>}
        </span>
        <span className="sp-card-body">
          <span className="name"><span className="dot" style={{ background: p.tint }} />{p.name}</span>
          <span className="meta"><span className="pushed">{p.metaLine}</span><span>{p.progress}%</span></span>
          <span className="track"><span className="fill" style={{ width: `${p.progress}%` }} /></span>
        </span>
      </a>
      <button className={`sp-corner${menu === p.id ? ' on' : ''}`} title="Project actions" aria-haspopup="menu"
        aria-expanded={menu === p.id} onClick={() => setMenu(menu === p.id ? null : p.id)}>
        {menu === p.id ? '▴' : '▾'}
      </button>
      {menu === p.id && (
        <div className="sp-menu" role="menu">
          <button role="menuitem" onClick={() => { setMenu(null); setModal({ mode: 'edit', slug: p.id, name: p.name, pitch: p.subtitle, area: areaOf(p), status: p.status }); }}>
            Edit details
          </button>
          {p.status !== 'archived' && (
            <button role="menuitem" onClick={() => patch(p, { status: p.status === 'paused' ? 'building' : 'paused' })}>
              {p.status === 'paused' ? 'Resume' : 'Pause'}
            </button>
          )}
          <div className="sep" />
          {p.status === 'archived'
            ? <button role="menuitem" onClick={() => patch(p, { status: 'building' })}>Restore</button>
            : <button role="menuitem" className="danger" onClick={() => patch(p, { status: 'archived' })}>Archive</button>}
        </div>
      )}
    </article>
  );

  const hubRow = (h: Project) => {
    const wfs = wfOf(h.id);
    const bad = wfs.filter((w) => w.status === 'failing').length;
    const open = !closedHubs[h.id];
    return (
      <div key={h.id} className="sp-hub">
        <div className="sp-hub-h" role="button" tabIndex={0} aria-expanded={open}
          onClick={() => setClosedHubs((c) => ({ ...c, [h.id]: open }))}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setClosedHubs((c) => ({ ...c, [h.id]: open })); } }}>
          <span className="caret">{open ? '▾' : '▸'}</span>
          <div className="titles">
            <div className="row">
              <a className="name" href={hrefTo.detail(h.id)} onClick={(e) => e.stopPropagation()}>{h.name}</a>
              <span className="tag">Hub</span>
              {h.status !== 'live' && <span className={`sp-pill st-${h.status}`}>{STATUS_LABEL[h.status]}</span>}
            </div>
            {h.subtitle && <span className="desc">{h.subtitle}</span>}
          </div>
          <span className="meta">{wfs.length} workflow{wfs.length === 1 ? '' : 's'}</span>
          {/* No workflows, or none reported, is not "healthy": say what is known. */}
          <span className={`sp-pill ${bad ? 'bad' : wfs.some((w) => w.status === 'ok') ? 'good' : 'none'}`}>
            {bad ? `${bad} failing` : wfs.some((w) => w.status === 'ok') ? 'Healthy' : 'No runs yet'}
          </span>
        </div>
        {open && (
          <div className="sp-hub-body">
            {wfs.map((w) => (
              <div key={w.id} className={`sp-wf wf-${w.status}`}>
                <span className="dot" />
                <span className="name">{w.name}</span>
                <span className="desc" title={w.lastNote || w.description}>{w.description || '—'}</span>
                <span className="trig">{w.trigger}</span>
                <span className="last">{w.status === 'ok' ? w.lastRun : w.status === 'failing' ? `failed ${w.lastRun}` : WF_LABEL[w.status]}</span>
                <button className="toggle" onClick={() => toggleWorkflow(w)}>{w.enabled ? 'Pause' : 'Resume'}</button>
              </div>
            ))}
            <button className="sp-wf-add" onClick={() => openNew({ type: 'workflow', hub: h.id, area: areaOf(h) })}>
              + Add workflow to {h.name}
            </button>
          </div>
        )}
      </div>
    );
  };

  const ideaInput = (key: string, placeholder: string) => (
    <input className="sp-idea-input" placeholder={placeholder}
      onKeyDown={(e) => {
        const el = e.currentTarget; const v = el.value.trim();
        if (e.key === 'Enter' && v) { addIdea(key, v); el.value = ''; }
      }} />
  );

  // ---- layout ----

  const shownAreas = spaces.areas.filter((a) => area === 'all' || a.key === area);
  const areaName = area === 'all' ? 'Overview' : spaces.areas.find((a) => a.key === area)?.name || 'Overview';
  const ready = spaces.ideas.filter((i) => i.stage === 'ready').length;

  const rail = (
    <aside className={`sp-rail${folded ? ' folded' : ''}`}>
      <div className="sp-rail-h">
        {!folded && <span className="sp-eyebrow">Areas</span>}
        <button className="sp-fold" onClick={() => foldRail(!folded)}
          title={folded ? 'Show the areas' : 'Fold the areas away'} aria-expanded={!folded}>
          {folded ? '»' : '«'}
        </button>
      </div>
      {!folded && (
        <>
          <div className="sp-rail-list">
            {[{ key: 'all', name: 'All areas', position: -1 }, ...spaces.areas].map((a) => {
              const n = a.key === 'all' ? unarchived.length + wfCount : countIn(a.key);
              const empty = a.key !== 'all' && a.key !== 'personal' && n === 0
                && !spaces.ideas.some((i) => i.area === a.key)
                && !projects.some((p) => areaOf(p) === a.key);
              if (renaming?.key === a.key) {
                return (
                  <input key={a.key} className="sp-rail-input" autoFocus value={renaming.name}
                    onChange={(e) => setRenaming({ key: a.key, name: e.target.value })}
                    onBlur={saveRename}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') setRenaming(null); }} />
                );
              }
              return (
                <div key={a.key} className={`sp-rail-row${area === a.key ? ' on' : ''}`}>
                  <button className="pick" onClick={() => setArea(a.key)}>
                    <span>{a.name}</span><span className="n">{n}</span>
                  </button>
                  {a.key !== 'all' && (
                    <span className="acts">
                      <button title={`Rename ${a.name}`} onClick={() => setRenaming({ key: a.key, name: a.name })}>✎</button>
                      {empty && <button title={`Delete ${a.name}`} onClick={() => dropArea(a as SpaceArea)}>×</button>}
                    </span>
                  )}
                </div>
              );
            })}
            {addingArea === null ? (
              <button className="sp-rail-add" onClick={() => setAddingArea('')}>+ New area</button>
            ) : (
              <input className="sp-rail-input" autoFocus value={addingArea} placeholder="Area name — Enter"
                onChange={(e) => setAddingArea(e.target.value)}
                onBlur={() => { if (!addingArea.trim()) setAddingArea(null); }}
                onKeyDown={async (e) => {
                  if (e.key === 'Escape') setAddingArea(null);
                  if (e.key === 'Enter' && addingArea.trim()) {
                    const k = await addArea(addingArea.trim());
                    if (k) { setAddingArea(null); setArea(k); }
                  }
                }} />
            )}
          </div>
          <div className="sp-totals">
            <span className="sp-eyebrow">Totals</span>
            <div><span>Live</span><span className="v">{counts.live}</span></div>
            <div><span>Building</span><span className="v">{counts.building}</span></div>
            <div><span>Workflows failing</span><span className={`v${failing ? ' bad' : ''}`}>{failing}</span></div>
            <div><span>Ideas</span><span className="v">{spaces.ideas.length}</span></div>
            <button onClick={() => setFilter('archived')} disabled={!counts.archived}>
              <span>Archived</span><span className="v">{counts.archived}</span>
            </button>
          </div>
        </>
      )}
    </aside>
  );

  return (
    <div className="sp-screen">
      {/* No crumb: the dashboard IS the root the crumb points back to. */}
      <TopBar dash onSearch={onOpenSearch} searchLabel="Search everything…" actions={
        <>
          {/* An anchor, not a button — middle/ctrl-click opens it in a new tab */}
          <a className="btn-repo" href="#/control" title="Every project's automation from one point">Mission Control</a>
          <button className="btn-repo" onClick={() => setHowToOpen(true)}>Guide</button>
          <button className="btn-repo" onClick={() => setGuideOpen(true)}>Connect</button>
          <button className="btn-accent" onClick={() => openNew()}>New project</button>
        </>
      } />

      <div className={`sp-layout${folded ? ' folded' : ''}`}>
        {rail}

        <main className="sp-main">
          {deckError ? (
            <div className="deck-error">Couldn’t load where you left off — {deckError}</div>
          ) : overview ? (
            <ResumeHero overview={overview} project={projects.find((p) => p.id === overview.resume?.slug)} />
          ) : null}

          {actionError && (
            <div className="action-error" role="alert">
              {actionError} <button className="sp-link" onClick={() => setActionError('')}>Dismiss</button>
            </div>
          )}

          <div className="sp-head">
            <div className="titles">
              <h1>{areaName}</h1>
              <span className="summary">
                {unarchived.length} app{unarchived.length === 1 ? '' : 's'} · {liveHubs.length} hub{liveHubs.length === 1 ? '' : 's'} · {wfCount} workflow{wfCount === 1 ? '' : 's'} · {spaces.ideas.length} idea{spaces.ideas.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="sp-tabs" role="tablist">
              {tabs.map((k) => (
                <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
                  {k === 'all' ? 'All' : STATUS_LABEL[k]} <span className="n">{counts[k]}</span>
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="empty-state"><div className="big">Loading…</div><div>Fetching your projects from the API.</div></div>
          ) : error ? (
            <div className="empty-state"><div className="big">Couldn't load projects</div><div>{error}</div></div>
          ) : (
            <>
              {shownAreas.map((a) => {
                const secApps = apps.filter((p) => areaOf(p) === a.key && shows(p));
                const secHubs = hubs.filter((h) => areaOf(h) === a.key && (filter === 'archived' ? h.status === 'archived' : h.status !== 'archived'));
                const secWf = secHubs.reduce((n, h) => n + wfOf(h.id).length, 0);
                const secIdeas = spaces.ideas.filter((i) => i.area === a.key).length;
                const parts = [
                  secApps.length && `${secApps.length} app${secApps.length === 1 ? '' : 's'}`,
                  secHubs.length && `${secWf} workflow${secWf === 1 ? '' : 's'}`,
                  secIdeas && `${secIdeas} idea${secIdeas === 1 ? '' : 's'}`,
                ].filter(Boolean);
                const empty = !secApps.length && !secHubs.length;
                return (
                  <section key={a.key} className="sp-section">
                    <div className="sp-section-h">
                      <h2>{a.name}</h2>
                      <span className="meta">{parts.join(' · ') || 'empty'}</span>
                    </div>
                    {(secApps.length > 0 || empty || area === a.key) && (
                      <div className="sp-grid">
                        {secApps.map(card)}
                        {(empty || area === a.key) && filter !== 'archived' && (
                          <button className="sp-newtile" onClick={() => openNew({ area: a.key })}>
                            <span className="plus">+</span>
                            <span>New {a.name.toLowerCase()} project</span>
                          </button>
                        )}
                      </div>
                    )}
                    {secHubs.map(hubRow)}
                  </section>
                );
              })}

              <section className="sp-section sp-wishlist">
                <div className="sp-section-h">
                  <h2 className="big">Wishlist</h2>
                  <span className="meta">{spaces.ideas.length} idea{spaces.ideas.length === 1 ? '' : 's'} · {ready} ready to start</span>
                </div>
                <div className="sp-wish-grid">
                  {shownAreas.map((a) => {
                    const ideas = spaces.ideas.filter((i) => i.area === a.key);
                    return (
                      <div key={a.key} className="sp-wish">
                        <div className="sp-wish-h"><span>{a.name}</span><span className="n">{ideas.length}</span></div>
                        {ideas.map((i) => (
                          <div key={i.id} className="sp-idea">
                            <div className="row">
                              <span className="t">{i.title}</span>
                              <button className={`sp-pill stage-${i.stage}`} onClick={() => cycle(i)} title="Next stage">{STAGE_LABEL[i.stage]}</button>
                              <button className="x" title="Remove this idea" onClick={() => dropIdea(i)}>×</button>
                            </div>
                            <div className="row">
                              <span className="note">{i.note || '—'}</span>
                              <button className="sp-link" onClick={() => openNew({ name: i.title, pitch: i.note, area: i.area, fromIdea: i.id })}>Start →</button>
                            </div>
                          </div>
                        ))}
                        {ideaInput(a.key, 'Add an idea — Enter')}
                      </div>
                    );
                  })}
                </div>
              </section>
            </>
          )}
        </main>
      </div>

      {modal && (
        <NewProjectModal init={modal} areas={spaces.areas} hubs={liveHubs}
          onClose={() => setModal(null)} onSubmit={submit} onNewArea={addArea} />
      )}
      {guideOpen && <ConnectGuide onClose={() => setGuideOpen(false)} />}
      {howToOpen && <HowToGuide onClose={() => setHowToOpen(false)} />}
    </div>
  );
}
