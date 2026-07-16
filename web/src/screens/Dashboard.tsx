import { useEffect, useMemo, useState } from 'react';
import type { Project, ProjectStatus, Overview } from '../types';
import { getProjects, getOverview, createProject } from '../store';
import { go } from '../lib/route';
import { PRODUCT_NAME } from '../lib/ui';
import { NewProjectModal } from '../components/NewProjectModal';
import { ConnectGuide } from '../components/ConnectGuide';
import { HowToGuide } from '../components/HowToGuide';
import { CommandDeck } from '../components/CommandDeck';

type Filter = 'all' | ProjectStatus;

// True when this app is rendered inside an iframe (e.g. its own card preview).
const framed = window.self !== window.top;
const STATUS_LABEL: Record<ProjectStatus, string> = {
  live: 'Live', building: 'Building', paused: 'Paused', archived: 'Archived',
};

export function Dashboard({ onOpenSearch }: { onOpenSearch: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [newOpen, setNewOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [howToOpen, setHowToOpen] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [deckLoading, setDeckLoading] = useState(true);
  const [deckError, setDeckError] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    getProjects()
      .then((ps) => { if (live) { setProjects(ps); setError(''); } })
      .catch((e) => { if (live) setError(e?.message || 'Failed to load projects.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  // The deck loads independently so an overview hiccup never blanks the grid
  // (and vice versa). A 401 in either clears the token and routes to the gate.
  useEffect(() => {
    let live = true;
    setDeckLoading(true);
    getOverview()
      .then((o) => { if (live) { setOverview(o); setDeckError(''); } })
      .catch((e) => { if (live) setDeckError(e?.message || 'Failed to load the deck.'); })
      .finally(() => { if (live) setDeckLoading(false); });
    return () => { live = false; };
  }, []);

  const counts = useMemo(() => ({
    all: projects.length,
    live: projects.filter((p) => p.status === 'live').length,
    building: projects.filter((p) => p.status === 'building').length,
    paused: projects.filter((p) => p.status === 'paused').length,
    archived: projects.filter((p) => p.status === 'archived').length,
  }), [projects]);

  const visible = useMemo(() => {
    if (filter === 'all') return projects;
    return projects.filter((p) => p.status === filter);
  }, [projects, filter]);

  const chips: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'live', label: 'Live' },
    { key: 'building', label: 'Building' }, { key: 'paused', label: 'Paused' },
    { key: 'archived', label: 'Archived' },
  ];

  const onCreate = async (v: { name: string; subtitle: string; status: ProjectStatus }) => {
    try {
      const p = await createProject(v);
      setNewOpen(false);
      go.detail(p.id);
    } catch (e) {
      setNewOpen(false);
      setError((e as Error)?.message || 'Could not create the project.');
    }
  };

  return (
    <div>
      <div className="topbar dash">
        <div className="brandmark"><span className="sq" /><span className="word">{PRODUCT_NAME}</span></div>
        <div className="right">
          <button className="searchbox lg as-button" style={{ width: 250 }} onClick={onOpenSearch}
            aria-label="Search everything (⌘K)">
            <span className="glass" />
            <span style={{ color: 'var(--faint)' }}>Search everything…</span>
            <span className="kbd-hint">⌘K</span>
          </button>
          <button className="btn-repo" onClick={() => setHowToOpen(true)}>Guide</button>
          <button className="btn-repo" onClick={() => setGuideOpen(true)}>Connect</button>
          <button className="btn-accent" onClick={() => setNewOpen(true)}>New project</button>
          <button className="avatar" onClick={go.settings} aria-label="Settings" />
        </div>
      </div>

      <div className="page">
        {deckLoading ? (
          <div className="deck deck-skeleton" aria-busy="true">Loading the deck…</div>
        ) : deckError ? (
          <div className="deck-error">Couldn’t load the command deck — {deckError}</div>
        ) : overview ? (
          <CommandDeck data={overview} />
        ) : null}

        <div className="dash-head">
          <div>
            <div className="dash-title">All projects</div>
            <div className="dash-count">{counts.live} live · {counts.building} building · {counts.paused} paused</div>
          </div>
          <div className="chips">
            {chips.map((c) => (
              <button key={c.key} className={`chip ${filter === c.key ? 'on' : ''}`} onClick={() => setFilter(c.key)}>
                {c.label} <span className="n">{counts[c.key]}</span>
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="empty-state"><div className="big">Loading…</div><div>Fetching your projects from the API.</div></div>
        ) : error ? (
          <div className="empty-state"><div className="big">Couldn't load projects</div><div>{error}</div></div>
        ) : (
          <div className="grid">
            {visible.map((p) => (
              <button key={p.id} className="pcard" style={{ background: p.tint }} onClick={() => go.detail(p.id)} aria-label={`Open ${p.name}`}>
                <span className="stripe" />
                {p.siteUrl && !framed && (
                  // Live view of the deployed site, scaled to the card (à la Vercel).
                  // Inert to the pointer/keyboard; the tint shows while it loads or
                  // if the site refuses framing. Skipped when Stack is itself framed
                  // so its own card can't recurse.
                  <span className="preview" aria-hidden="true">
                    <iframe src={p.siteUrl} loading="lazy" tabIndex={-1} title="" referrerPolicy="no-referrer" />
                  </span>
                )}
                <span className="scrim" />
                <span className="statuspill">{STATUS_LABEL[p.status]}</span>
                {p.automode && <span className="autopill" title="Automode — the overnight autopilot may work this project">⚙ auto</span>}
                <span className="meta">
                  <span className="pname">{p.name}</span>
                  <span className="track"><span className="fill" style={{ width: `${p.progress}%` }} /></span>
                  <span className="metarow"><span>{p.metaLine}</span><span>{p.progress}%</span></span>
                </span>
              </button>
            ))}
            <button className="newtile" onClick={() => setNewOpen(true)}>
              <span className="plus">+</span>
              <span className="lab">New project</span>
            </button>
          </div>
        )}
      </div>

      {newOpen && <NewProjectModal onClose={() => setNewOpen(false)} onCreate={onCreate} />}
      {guideOpen && <ConnectGuide onClose={() => setGuideOpen(false)} />}
      {howToOpen && <HowToGuide onClose={() => setHowToOpen(false)} />}
    </div>
  );
}
