import { useEffect, useState, type ReactNode } from 'react';
import type { Roadmap as RoadmapData, RoadmapItem, Note, Severity, Priority } from '../types';
import {
  getProjectDetail, type ProjectDetailData,
  createBug, createRoadmapItem, patchRoadmapItem,
  createNote, patchNote, deleteNote, patchProject, deleteProject,
} from '../store';
import { go } from '../lib/route';
import { downloadBrief } from '../lib/brief';
import { Overview } from '../detail/Overview';
import { Bugs } from '../detail/Bugs';
import { Roadmap } from '../detail/Roadmap';
import { Notes } from '../detail/Notes';
import { Activity } from '../detail/Activity';
import { BugModal } from '../components/BugModal';
import { RoadmapModal } from '../components/RoadmapModal';
import { ConfirmModal } from '../components/ConfirmModal';

type Tab = 'overview' | 'bugs' | 'roadmap' | 'notes' | 'activity';
type BugFilter = 'all' | 'open' | 'fixing' | 'fixed';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' }, { key: 'bugs', label: 'Bugs' },
  { key: 'roadmap', label: 'Roadmap' }, { key: 'notes', label: 'Notes' }, { key: 'activity', label: 'Activity' },
];
const STATUS_LABEL = { live: 'Live', building: 'Building', paused: 'Paused', archived: 'Archived' } as const;

const roadmapTotal = (r: RoadmapData) => r.must.length + r.should.length + r.could.length + r.wont.length;

const TAB_KEYS = new Set<Tab>(['overview', 'bugs', 'roadmap', 'notes', 'activity']);
const asTab = (t: string | undefined): Tab => (t && TAB_KEYS.has(t as Tab) ? (t as Tab) : 'overview');

export function ProjectDetail({ id, tab, highlight, onOpenSearch }: {
  id: string; tab?: string; highlight?: string; onOpenSearch: () => void;
}) {
  const [data, setData] = useState<ProjectDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    getProjectDetail(id)
      .then((d) => { if (live) { setData(d); setLoadError(''); } })
      .catch((e) => { if (live) setLoadError(e?.message || 'Failed to load.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [id]);

  if (loading) return <Shell><div className="empty-state"><div className="big">Loading…</div></div></Shell>;
  if (loadError || !data) {
    return (
      <Shell>
        <div className="empty-state">
          <div className="big">{loadError === 'No such project.' ? 'Project not found' : "Couldn't load this project"}</div>
          <div style={{ marginBottom: 16 }}>{loadError || 'It may have been removed.'}</div>
          <button className="btn-accent" onClick={go.dashboard} style={{ display: 'inline-flex' }}>Back to projects</button>
        </div>
      </Shell>
    );
  }
  return <Detail data={data} setData={setData} routeTab={tab} routeHighlight={highlight} onOpenSearch={onOpenSearch} />;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div>
      <div className="topbar">
        <div className="crumb">
          <span className="chev" onClick={go.dashboard}>‹</span>
          <span className="back" onClick={go.dashboard}>Projects</span>
        </div>
      </div>
      <div className="page detail" style={{ paddingTop: 40 }}>{children}</div>
    </div>
  );
}

function Detail({ data, setData, routeTab, routeHighlight, onOpenSearch }: {
  data: ProjectDetailData; setData: (d: ProjectDetailData) => void;
  routeTab?: string; routeHighlight?: string; onOpenSearch: () => void;
}) {
  const { project, activity } = data;
  const slug = project.id;

  const initialTab = asTab(routeTab);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [bugFilter, setBugFilter] = useState<BugFilter>('all');
  // Two highlight channels: a commit hash (the existing activity highlight) and
  // a row id (bug key / roadmap id / note id) for the other tabs. A search
  // deep-link sets whichever matches the tab it lands on.
  const [highlightRef, setHighlightRef] = useState<string | null>(
    initialTab === 'activity' ? (routeHighlight ?? null) : null);
  const [highlightId, setHighlightId] = useState<string | null>(
    initialTab !== 'activity' ? (routeHighlight ?? null) : null);

  // Keep tab + highlight in sync when the route changes while staying on the
  // same project (e.g. opening another of this project's items from the palette).
  useEffect(() => {
    const t = asTab(routeTab);
    setTab(t);
    if (t === 'activity') { setHighlightRef(routeHighlight ?? null); setHighlightId(null); }
    else { setHighlightId(routeHighlight ?? null); setHighlightRef(null); }
  }, [routeTab, routeHighlight]);

  // The row highlight is a brief flag; clear it after a moment so it doesn't
  // linger. (The activity highlight keeps its own explicit clear control.)
  useEffect(() => {
    if (!highlightId) return;
    const node = document.querySelector(`[data-hl="${highlightId}"]`);
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const t = setTimeout(() => setHighlightId(null), 2800);
    return () => clearTimeout(t);
  }, [highlightId, tab]);
  const [bugModal, setBugModal] = useState<{ open: boolean; title: string; fromNote: number | null }>(
    { open: false, title: '', fromNote: null });
  const [roadModal, setRoadModal] = useState<{ open: boolean; priority: Priority; title: string; fromNote: number | null }>(
    { open: false, priority: 'should', title: '', fromNote: null });
  const [promotedNote, setPromotedNote] = useState<{ id: number; kind: 'bug' | 'roadmap' } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingUrl, setEditingUrl] = useState<'site' | 'repo' | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [actionError, setActionError] = useState('');

  const bugs = data.bugs;
  const roadmap = data.roadmap;
  const notes = data.notes;

  const openBugCount = bugs.filter((b) => b.status !== 'fixed').length;
  const fixingCount = bugs.filter((b) => b.status === 'fixing').length;
  const roadmapCount = roadmapTotal(roadmap);
  const linkedBugId = bugs.find((b) => b.linkRef === highlightRef)?.id ?? null;

  const guard = async (fn: () => Promise<void>) => {
    try { setActionError(''); await fn(); }
    catch (e) { setActionError((e as Error)?.message || 'Something went wrong.'); }
  };

  // ---- mutations (each persists, then patches the loaded data in place) ----
  const addBug = ({ title, severity }: { title: string; severity: Severity }) =>
    guard(async () => {
      const bug = await createBug(slug, { title, severity });
      const fromNote = bugModal.fromNote;
      setData({ ...data, bugs: [bug, ...bugs] });
      setBugModal({ open: false, title: '', fromNote: null });
      setBugFilter('all');
      if (fromNote != null) setPromotedNote({ id: fromNote, kind: 'bug' });
    });

  const addRoad = ({ title, note, priority }: { title: string; note: string; priority: Priority }) =>
    guard(async () => {
      const item = await createRoadmapItem(slug, { title, note, bucket: priority });
      const fromNote = roadModal.fromNote;
      setData({ ...data, roadmap: { ...roadmap, [priority]: [...roadmap[priority], item] } });
      setRoadModal({ open: false, priority, title: '', fromNote: null });
      if (fromNote != null) setPromotedNote({ id: fromNote, kind: 'roadmap' });
    });

  const toggleRoad = (item: RoadmapItem) =>
    guard(async () => {
      const updated = await patchRoadmapItem(slug, item.id, { done: !item.done });
      const bucket = roadmap[item.bucket].map((it) => (it.id === item.id ? updated : it));
      setData({ ...data, roadmap: { ...roadmap, [item.bucket]: bucket } });
    });

  const addNote = (text: string) =>
    guard(async () => {
      const note = await createNote(slug, { text });
      setData({ ...data, notes: [note, ...notes] });
    });

  const editNote = (nid: number, text: string) =>
    guard(async () => {
      const updated = await patchNote(slug, nid, { text });
      setData({ ...data, notes: notes.map((n) => (n.id === nid ? updated : n)) });
    });

  const removeNote = (nid: number) =>
    guard(async () => {
      await deleteNote(slug, nid);
      setData({ ...data, notes: notes.filter((n) => n.id !== nid) });
    });

  // Promote a note into the existing create-bug / create-roadmap flow, prefilled.
  const promoteNote = (note: Note, kind: 'bug' | 'roadmap') => {
    if (kind === 'bug') setBugModal({ open: true, title: note.text, fromNote: note.id });
    else setRoadModal({ open: true, priority: 'should', title: note.text, fromNote: note.id });
  };

  const keepPromotedNote = () => setPromotedNote(null);
  const deletePromotedNote = () => {
    const target = promotedNote;
    if (!target) return;
    setPromotedNote(null);
    removeNote(target.id);
  };

  // ---- inline site/repo URL editing ----
  const startUrl = (kind: 'site' | 'repo') => {
    setUrlDraft(kind === 'site' ? project.siteUrl : project.repoUrl);
    setEditingUrl(kind);
  };
  const saveUrl = () =>
    guard(async () => {
      const value = urlDraft.trim();
      const updated = editingUrl === 'site'
        ? await patchProject(slug, { site_url: value })
        : await patchProject(slug, { repo_url: value });
      setData({ ...data, project: { ...project, siteUrl: updated.siteUrl, repoUrl: updated.repoUrl } });
      setEditingUrl(null);
    });

  const removeProject = () =>
    guard(async () => { await deleteProject(slug); go.dashboard(); });

  const exportBrief = () =>
    downloadBrief({ project, currentPhase: data.currentPhase, blockers: data.blockers, activity, bugs, roadmap });

  const openBugLink = (hash: string) => { setHighlightRef(hash); setTab('activity'); };
  const viewAll = () => { setHighlightRef(null); setTab('activity'); };
  const open = (url: string) => { if (url) window.open(url, '_blank', 'noopener'); };

  return (
    <div>
      <div className="topbar">
        <div className="crumb">
          <span className="chev" onClick={go.dashboard}>‹</span>
          <span className="back" onClick={go.dashboard}>Projects</span>
          <span className="sep">/</span>
          <span className="here">{project.name}</span>
        </div>
        <div className="right">
          <button className="searchbox sm lg as-button" onClick={onOpenSearch} aria-label="Search everything (⌘K)">
            <span className="glass" />
            <span style={{ color: 'var(--faint)' }}>Search…</span>
            <span className="kbd-hint">⌘K</span>
          </button>
          <button className="avatar sm" onClick={go.settings} aria-label="Settings" />
        </div>
      </div>

      <div className="page detail">
        <div className="detail-head">
          <div>
            <div className="titlerow">
              <div className="detail-title">{project.name}</div>
              <span className={`statusbadge ${project.status}`}><span className="dot" />{STATUS_LABEL[project.status]}</span>
            </div>
            {project.subtitle && <div className="detail-sub">{project.subtitle}</div>}
          </div>
          <div className="head-actions">
            {editingUrl ? (
              <div className="url-edit">
                <input className="field-input sm" autoFocus value={urlDraft}
                  placeholder={editingUrl === 'site' ? 'https://your-site.example…' : 'https://github.com/owner/repo…'}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveUrl(); else if (e.key === 'Escape') setEditingUrl(null); }} />
                <button className="btn-submit sm" onClick={saveUrl}>Save</button>
                <button className="btn-cancel sm" onClick={() => setEditingUrl(null)}>Cancel</button>
              </div>
            ) : (
              <>
                {project.siteUrl
                  ? <button className="btn-accent btn-visit" onClick={() => open(project.siteUrl)}>Visit site <span style={{ fontSize: 12 }}>↗</span></button>
                  : <button className="btn-visit btn-muted" onClick={() => startUrl('site')}>Set site URL</button>}
                {project.repoUrl
                  ? <button className="btn-repo" onClick={() => open(project.repoUrl)}><span className="blk" />Repo</button>
                  : <button className="btn-repo btn-muted" onClick={() => startUrl('repo')}><span className="blk" />Set repo</button>}
              </>
            )}
          </div>
        </div>

        {actionError && <div className="action-error">{actionError}</div>}

        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`tab ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>

        {tab === 'overview' && (
          <Overview project={project} activity={activity} keepResumeCard={data.keepResumeCard}
            openBugCount={openBugCount} fixingCount={fixingCount} roadmapCount={roadmapCount}
            onViewAll={viewAll} onExport={exportBrief} />
        )}
        {tab === 'bugs' && (
          <Bugs bugs={bugs} filter={bugFilter} setFilter={setBugFilter} highlightId={highlightId}
            onReport={() => setBugModal({ open: true, title: '', fromNote: null })} onOpenLink={openBugLink} />
        )}
        {tab === 'roadmap' && (
          <Roadmap roadmap={roadmap} highlightId={highlightId}
            onAdd={(p) => setRoadModal({ open: true, priority: p, title: '', fromNote: null })} onToggle={toggleRoad} />
        )}
        {tab === 'notes' && (
          <Notes notes={notes} highlightId={highlightId} onAdd={addNote} onEdit={editNote} onDelete={removeNote} onPromote={promoteNote} />
        )}
        {tab === 'activity' && (
          <Activity activity={activity} highlightRef={highlightRef} linkedBugId={linkedBugId} onClear={() => setHighlightRef(null)} />
        )}

        <div className="danger-zone">
          <button className="delete-project" onClick={() => setConfirmDelete(true)}>Delete this project</button>
        </div>
      </div>

      {bugModal.open && (
        <BugModal initialTitle={bugModal.title}
          onClose={() => setBugModal({ open: false, title: '', fromNote: null })} onSubmit={addBug} />
      )}
      {roadModal.open && (
        <RoadmapModal initialPriority={roadModal.priority} initialTitle={roadModal.title}
          onClose={() => setRoadModal({ open: false, priority: roadModal.priority, title: '', fromNote: null })} onSubmit={addRoad} />
      )}
      {promotedNote && (
        <ConfirmModal
          title={promotedNote.kind === 'bug' ? 'Promoted to a bug' : 'Promoted to a roadmap item'}
          body="Keep the original note, or delete it now that it's tracked elsewhere?"
          confirmLabel="Delete note" cancelLabel="Keep note" danger
          onConfirm={deletePromotedNote} onCancel={keepPromotedNote} />
      )}
      {confirmDelete && (
        <ConfirmModal
          title="Delete project?"
          body={<>Permanently delete <b>{project.name}</b> and everything under it — its sessions, bugs, roadmap and notes. This can’t be undone.</>}
          confirmLabel="Delete project" cancelLabel="Cancel" danger
          onConfirm={removeProject} onCancel={() => setConfirmDelete(false)} />
      )}
    </div>
  );
}
