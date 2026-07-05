import { useEffect, useState, type ReactNode } from 'react';
import type { Roadmap as RoadmapData, RoadmapItem, Note, Future, Check, Severity, Priority, Bug, BugStatus } from '../types';
import {
  getProjectDetail, type ProjectDetailData,
  createBug, patchBug, deleteBug, createRoadmapItem, patchRoadmapItem, deleteRoadmapItem,
  createNote, patchNote, deleteNote, createFuture, patchFuture, deleteFuture,
  createCheck, deleteCheck, runChecks,
  patchProject, deleteProject, createShareLink, deleteShareLink,
  getRoadDraft, setRoadDraft, type RoadDraft, judgeFuture,
} from '../store';
import { go } from '../lib/route';
import { ExportBriefModal } from '../components/ExportBriefModal';
import { Overview, type ReviewEntry, type DeployPatch } from '../detail/Overview';
import { Bugs } from '../detail/Bugs';
import { Roadmap, type ReviewTag } from '../detail/Roadmap';
import { Futures, type Alignment } from '../detail/Futures';
import { Notes } from '../detail/Notes';
import { Activity } from '../detail/Activity';
import { Modal } from '../components/Modal';
import { BugModal } from '../components/BugModal';
import { RoadmapModal } from '../components/RoadmapModal';
import { ConfirmModal } from '../components/ConfirmModal';

type Tab = 'overview' | 'bugs' | 'roadmap' | 'futures' | 'notes' | 'activity';
type BugFilter = 'all' | 'open' | 'fixing' | 'fixed';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' }, { key: 'bugs', label: 'Bugs' },
  { key: 'roadmap', label: 'Roadmap' }, { key: 'futures', label: 'Futures' },
  { key: 'notes', label: 'Notes' }, { key: 'activity', label: 'Activity' },
];
const STATUS_LABEL = { live: 'Live', building: 'Building', paused: 'Paused', archived: 'Archived' } as const;

const roadmapTotal = (r: RoadmapData) => r.must.length + r.should.length + r.could.length + r.wont.length;

const TAB_KEYS = new Set<Tab>(['overview', 'bugs', 'roadmap', 'futures', 'notes', 'activity']);
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
  const [roadModal, setRoadModal] = useState<{
    open: boolean; priority: Priority; title: string; note: string;
    fromNote: number | null; editing: RoadmapItem | null; lane?: string; fromDraft?: boolean;
  }>({ open: false, priority: 'should', title: '', note: '', fromNote: null, editing: null });
  const roadModalClosed = { open: false, priority: 'should' as Priority, title: '', note: '', fromNote: null, editing: null };
  // Device-local draft: a half-typed add-modal dismissed by a stray click.
  const [roadDraft, setRoadDraftState] = useState<RoadDraft | null>(() => getRoadDraft(slug));
  useEffect(() => { setRoadDraftState(getRoadDraft(slug)); }, [slug]);
  const updateRoadDraft = (d: RoadDraft | null) => { setRoadDraft(slug, d); setRoadDraftState(d); };
  const openRoadDraft = (d: RoadDraft) => setRoadModal({
    open: true, priority: d.priority, title: d.title, note: d.note, lane: d.lane,
    fromNote: null, editing: null, fromDraft: true,
  });
  const [confirmRoadDelete, setConfirmRoadDelete] = useState<RoadmapItem | null>(null);
  const [confirmBugDelete, setConfirmBugDelete] = useState<Bug | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [promotedNote, setPromotedNote] = useState<{ id: number; kind: 'bug' | 'roadmap' } | null>(null);
  const [promotedFuture, setPromotedFuture] = useState<number | null>(null);
  const [pendingFuture, setPendingFuture] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [checksBusy, setChecksBusy] = useState(false);
  const [editingUrl, setEditingUrl] = useState<'site' | 'repo' | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [actionError, setActionError] = useState('');

  const bugs = data.bugs;
  const roadmap = data.roadmap;
  const notes = data.notes;
  const futures = data.futures;

  const allRoadmap = [...roadmap.must, ...roadmap.should, ...roadmap.could, ...roadmap.wont];
  // The project-scoped review queue: hook-created items no human has looked at.
  const reviewQueue: ReviewEntry[] = [
    ...bugs.filter((b) => b.source === 'hook' && !b.reviewed)
      .map((b) => ({ kind: 'bug' as const, key: b.id, title: b.title, meta: b.severity })),
    ...allRoadmap.filter((r) => r.source === 'hook' && !r.reviewed)
      .map((r) => ({ kind: 'roadmap' as const, key: String(r.id), title: r.title, meta: r.bucket })),
    ...futures.filter((f) => f.source === 'hook' && !f.reviewed)
      .map((f) => ({ kind: 'future' as const, key: String(f.id), title: f.title, meta: 'idea' })),
  ];

  const openBugCount = bugs.filter((b) => b.status !== 'fixed').length;
  const openRoadCount = allRoadmap.filter((r) => !r.done).length;
  const unsortedFutures = futures.filter((f) => !f.alignment).length;
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

  const setBugStatus = (b: Bug, status: BugStatus) =>
    guard(async () => {
      const updated = await patchBug(slug, b.id, { status });
      setData({ ...data, bugs: bugs.map((x) => (x.id === b.id ? updated : x)) });
    });

  const removeBug = (b: Bug) =>
    guard(async () => {
      await deleteBug(slug, b.id);
      setData({ ...data, bugs: bugs.filter((x) => x.id !== b.id) });
    });

  // Create, or save an edit, depending on how the modal was opened.
  const submitRoad = ({ title, note, priority, lane }: { title: string; note: string; priority: Priority; lane: string }) =>
    guard(async () => {
      const editing = roadModal.editing;
      if (editing) {
        const updated = await patchRoadmapItem(slug, editing.id, { title, note, bucket: priority, claimed_by: lane });
        const without = { ...roadmap, [editing.bucket]: roadmap[editing.bucket].filter((i) => i.id !== editing.id) };
        setData({ ...data, roadmap: { ...without, [updated.bucket]: [...without[updated.bucket], updated] } });
        setRoadModal(roadModalClosed);
        return;
      }
      const item = await createRoadmapItem(slug, { title, note, bucket: priority, claimed_by: lane || undefined });
      const fromNote = roadModal.fromNote;
      const fromFuture = pendingFuture;
      if (roadModal.fromDraft) updateRoadDraft(null); // the draft landed — clear it
      setData({ ...data, roadmap: { ...roadmap, [priority]: [...roadmap[priority], item] } });
      setRoadModal(roadModalClosed);
      setPendingFuture(null);
      if (fromNote != null) setPromotedNote({ id: fromNote, kind: 'roadmap' });
      else if (fromFuture != null) setPromotedFuture(fromFuture);
    });

  const removeRoad = (item: RoadmapItem) =>
    guard(async () => {
      await deleteRoadmapItem(slug, item.id);
      setData({ ...data, roadmap: { ...roadmap, [item.bucket]: roadmap[item.bucket].filter((i) => i.id !== item.id) } });
    });

  const toggleSkipRoad = (item: RoadmapItem) =>
    guard(async () => {
      const updated = await patchRoadmapItem(slug, item.id, { skipped: !item.skipped });
      setData({ ...data, roadmap: { ...roadmap, [item.bucket]: roadmap[item.bucket].map((i) => (i.id === item.id ? updated : i)) } });
    });

  // Archive review: store the verdict; needs-work/rethink offer a follow-up
  // item straight back onto the board (prefilled, cancellable).
  const reviewTagRoad = (item: RoadmapItem, tag: ReviewTag) =>
    guard(async () => {
      const updated = await patchRoadmapItem(slug, item.id, { review_tag: tag });
      setData({ ...data, roadmap: { ...roadmap, [item.bucket]: roadmap[item.bucket].map((i) => (i.id === item.id ? updated : i)) } });
      if (tag !== 'solid') {
        setRoadModal({
          open: true, priority: 'should',
          title: `Follow up: ${item.title}`,
          note: `Spun off while reviewing the archived item (verdict: ${tag === 'needs-work' ? 'needs more work' : 'rethink'}).`,
          fromNote: null, editing: null,
        });
      }
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

  // ---- futures (the ideas curated against the north star) ----
  const addFuture = (title: string, note: string) =>
    guard(async () => {
      const f = await createFuture(slug, { title, note });
      setData({ ...data, futures: [f, ...futures] });
    });

  const editFuture = (fid: number, patch: { title: string; note: string }) =>
    guard(async () => {
      const updated = await patchFuture(slug, fid, patch);
      setData({ ...data, futures: futures.map((f) => (f.id === fid ? updated : f)) });
    });

  const alignFuture = (fid: number, alignment: Alignment | '') =>
    guard(async () => {
      const updated = await patchFuture(slug, fid, { alignment });
      setData({ ...data, futures: futures.map((f) => (f.id === fid ? updated : f)) });
    });

  const removeFuture = (fid: number) =>
    guard(async () => {
      await deleteFuture(slug, fid);
      setData({ ...data, futures: futures.filter((f) => f.id !== fid) });
    });

  const saveNorthStar = (text: string) =>
    guard(async () => {
      await patchProject(slug, { north_star: text });
      setData({ ...data, northStar: text });
    });

  // Keep = mark reviewed (stays in its tracker); Dismiss = delete (hook items
  // tombstone server-side, so the next push can't re-create them).
  const reviewKeep = (e: ReviewEntry) =>
    guard(async () => {
      if (e.kind === 'bug') {
        const u = await patchBug(slug, e.key, { reviewed: true });
        setData({ ...data, bugs: bugs.map((b) => (b.id === e.key ? u : b)) });
      } else if (e.kind === 'roadmap') {
        const id = Number(e.key);
        const u = await patchRoadmapItem(slug, id, { reviewed: true });
        setData({ ...data, roadmap: { ...roadmap, [u.bucket]: roadmap[u.bucket].map((i) => (i.id === id ? u : i)) } });
      } else {
        const id = Number(e.key);
        const u = await patchFuture(slug, id, { reviewed: true });
        setData({ ...data, futures: futures.map((f) => (f.id === id ? u : f)) });
      }
    });

  const reviewDismiss = (e: ReviewEntry) =>
    guard(async () => {
      if (e.kind === 'bug') {
        await deleteBug(slug, e.key);
        setData({ ...data, bugs: bugs.filter((b) => b.id !== e.key) });
      } else if (e.kind === 'roadmap') {
        const id = Number(e.key);
        const item = allRoadmap.find((i) => i.id === id);
        if (!item) return;
        await deleteRoadmapItem(slug, id);
        setData({ ...data, roadmap: { ...roadmap, [item.bucket]: roadmap[item.bucket].filter((i) => i.id !== id) } });
      } else {
        const id = Number(e.key);
        await deleteFuture(slug, id);
        setData({ ...data, futures: futures.filter((f) => f.id !== id) });
      }
    });

  const saveDeploy = (patch: DeployPatch) =>
    guard(async () => {
      const updated = await patchProject(slug, patch);
      setData({
        ...data,
        project: { ...project, status: updated.status, deployPlatform: patch.deploy_platform, logsUrl: patch.logs_url },
      });
    });

  // ---- checks (the Bugs tab's testing panel) ----
  const runProjectChecks = (id?: number) =>
    guard(async () => {
      setChecksBusy(true);
      try {
        const updated = await runChecks(slug, id);
        const byId = new Map(updated.map((c) => [c.id, c]));
        setData({ ...data, checks: data.checks.map((c) => byId.get(c.id) ?? c) });
      } finally {
        setChecksBusy(false);
      }
    });

  const addCheck = (input: { name: string; url: string; expect_status?: number }) =>
    guard(async () => {
      const c = await createCheck(slug, input);
      setData({ ...data, checks: [...data.checks, c] });
    });

  const removeCheck = (cid: number) =>
    guard(async () => {
      await deleteCheck(slug, cid);
      setData({ ...data, checks: data.checks.filter((c) => c.id !== cid) });
    });

  const checkToBug = (c: Check) =>
    setBugModal({ open: true, title: `Check failing: ${c.name} — ${c.lastError || `HTTP ${c.lastCode}`}`, fromNote: null });

  const saveStack = (next: string[]) =>
    guard(async () => {
      await patchProject(slug, { tech_stack: next });
      setData({ ...data, project: { ...project, meta: { ...project.meta, stack: next } } });
    });

  const changeDirectives = (next: string[]) =>
    guard(async () => {
      await patchProject(slug, { directives: next });
      setData({ ...data, directives: next });
    });

  // Promote an idea into the existing create-roadmap flow, prefilled; after the
  // item lands, offer to keep or delete the original idea (delete tombstones a
  // hook idea so the next push won't re-extract it).
  const promoteFuture = (f: Future) => {
    setPendingFuture(f.id);
    setRoadModal({ open: true, priority: 'should', title: f.title, note: f.note, fromNote: null, editing: null });
  };

  // Promote a note into the existing create-bug / create-roadmap flow, prefilled.
  const promoteNote = (note: Note, kind: 'bug' | 'roadmap') => {
    if (kind === 'bug') setBugModal({ open: true, title: note.text, fromNote: note.id });
    else setRoadModal({ open: true, priority: 'should', title: note.text, note: '', fromNote: note.id, editing: null });
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

  // ---- public showcase link ----
  const shareUrl = data.shareToken
    ? `${window.location.origin}/#/share/${encodeURIComponent(slug)}/${encodeURIComponent(data.shareToken)}`
    : '';
  const enableShare = () =>
    guard(async () => { setData({ ...data, shareToken: await createShareLink(slug) }); });
  const disableShare = () =>
    guard(async () => {
      await deleteShareLink(slug);
      setData({ ...data, shareToken: '' });
      setShareOpen(false);
    });
  const copyShare = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 1600);
    } catch { /* clipboard blocked — the field is selectable */ }
  };

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
                <button className={`btn-repo ${data.shareToken ? '' : 'btn-muted'}`}
                  onClick={() => { if (!data.shareToken) enableShare(); setShareOpen(true); }}
                  title={data.shareToken ? 'The public showcase link is live' : 'Create a public showcase link'}>
                  {data.shareToken ? '● Shared' : 'Share'}
                </button>
              </>
            )}
          </div>
        </div>

        {actionError && <div className="action-error">{actionError}</div>}

        <div className="tabs">
          {TABS.map((t) => {
            const n = t.key === 'bugs' ? openBugCount : t.key === 'roadmap' ? openRoadCount : t.key === 'futures' ? unsortedFutures : 0;
            return (
              <button key={t.key} className={`tab ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>
                {t.label}{n > 0 && <span className="tab-n">{n}</span>}
              </button>
            );
          })}
        </div>

        {tab === 'overview' && (
          <Overview project={project} activity={activity} directives={data.directives}
            reviewQueue={reviewQueue} keepResumeCard={data.keepResumeCard}
            openBugCount={openBugCount} fixingCount={fixingCount} roadmapCount={roadmapCount}
            onViewAll={viewAll} onExport={() => setExportOpen(true)} onChangeDirectives={changeDirectives}
            onReviewKeep={reviewKeep} onReviewDismiss={reviewDismiss} onSaveDeploy={saveDeploy}
            onSaveStack={saveStack} />
        )}
        {tab === 'bugs' && (
          <Bugs bugs={bugs} filter={bugFilter} setFilter={setBugFilter} highlightId={highlightId}
            onReport={() => setBugModal({ open: true, title: '', fromNote: null })} onOpenLink={openBugLink}
            onSetStatus={setBugStatus} onDelete={(b) => setConfirmBugDelete(b)}
            checks={data.checks} siteUrl={project.siteUrl} checksBusy={checksBusy}
            onRunChecks={runProjectChecks} onAddCheck={addCheck} onDeleteCheck={removeCheck}
            onCheckToBug={checkToBug} />
        )}
        {tab === 'roadmap' && (
          <Roadmap roadmap={roadmap} highlightId={highlightId}
            onAdd={(p) => roadDraft
              ? openRoadDraft(roadDraft)
              : setRoadModal({ open: true, priority: p, title: '', note: '', fromNote: null, editing: null })}
            draft={roadDraft} onResumeDraft={() => roadDraft && openRoadDraft(roadDraft)}
            onDiscardDraft={() => updateRoadDraft(null)}
            onToggle={toggleRoad}
            onEdit={(it) => setRoadModal({ open: true, priority: it.bucket, title: it.title, note: it.note, fromNote: null, editing: it })}
            onDelete={(it) => setConfirmRoadDelete(it)} onReviewTag={reviewTagRoad}
            onToggleSkip={toggleSkipRoad} />
        )}
        {tab === 'futures' && (
          <Futures northStar={data.northStar} futures={futures} highlightId={highlightId}
            onSaveNorthStar={saveNorthStar} onAdd={addFuture} onEdit={editFuture} onAlign={alignFuture}
            onAskGemini={(id) => judgeFuture(slug, id)}
            onDelete={removeFuture} onPromote={promoteFuture} />
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
          initialNote={roadModal.note} initialLane={roadModal.editing?.claimedBy ?? roadModal.lane ?? ''}
          mode={roadModal.editing ? 'edit' : 'add'}
          onClose={() => { setRoadModal(roadModalClosed); setPendingFuture(null); }}
          onDismiss={(d) => updateRoadDraft(d)}
          onSubmit={submitRoad} />
      )}
      {shareOpen && (
        <Modal onClose={() => setShareOpen(false)}>
          <h3>Public showcase</h3>
          <div className="confirm-body" style={{ marginBottom: 16 }}>
            Anyone with this link sees a read-only view — name, progress, summary and recent
            activity. No bugs, roadmap, notes or ideas, and no API token needed.
          </div>
          {data.shareToken ? (
            <>
              <input className="field-input mono" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
              <div className="modal-actions split" style={{ marginTop: 16 }}>
                <button className="btn-cancel" onClick={disableShare}>Disable link</button>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="btn-repo" onClick={copyShare}>{shareCopied ? '✓ Copied' : 'Copy link'}</button>
                  <button className="btn-submit" onClick={() => setShareOpen(false)}>Done</button>
                </div>
              </div>
            </>
          ) : (
            <div className="confirm-body">Creating the link…</div>
          )}
        </Modal>
      )}
      {confirmBugDelete && (
        <ConfirmModal
          title="Delete bug?"
          body={<>Delete <b>{confirmBugDelete.title}</b>{confirmBugDelete.source === 'hook'
            ? ' — it was auto-extracted, so it won’t be re-created by the next push.' : '.'}</>}
          confirmLabel="Delete bug" cancelLabel="Cancel" danger
          onConfirm={() => { const b = confirmBugDelete; setConfirmBugDelete(null); removeBug(b); }}
          onCancel={() => setConfirmBugDelete(null)} />
      )}
      {confirmRoadDelete && (
        <ConfirmModal
          title="Delete roadmap item?"
          body={<>Delete <b>{confirmRoadDelete.title}</b>{confirmRoadDelete.source === 'hook'
            ? ' — it was auto-extracted, so it won’t be re-created by the next push.' : '.'}</>}
          confirmLabel="Delete item" cancelLabel="Cancel" danger
          onConfirm={() => { const it = confirmRoadDelete; setConfirmRoadDelete(null); removeRoad(it); }}
          onCancel={() => setConfirmRoadDelete(null)} />
      )}
      {promotedFuture != null && (
        <ConfirmModal
          title="Promoted to a roadmap item"
          body="Keep the original idea in Futures, or delete it now that it's on the roadmap?"
          confirmLabel="Delete idea" cancelLabel="Keep idea" danger
          onConfirm={() => { const id = promotedFuture; setPromotedFuture(null); removeFuture(id); }}
          onCancel={() => setPromotedFuture(null)} />
      )}
      {exportOpen && (
        <ExportBriefModal projectName={project.name} onClose={() => setExportOpen(false)}
          loadInput={async () => ({
            project, currentPhase: data.currentPhase, blockers: data.blockers,
            directives: data.directives, activity, bugs, roadmap,
          })} />
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
          body={<>Delete <b>{project.name}</b> from Stack. Everything is kept — you can
            restore it (or delete it forever) from Settings → Deleted projects.</>}
          confirmLabel="Delete project" cancelLabel="Cancel" danger
          onConfirm={removeProject} onCancel={() => setConfirmDelete(false)} />
      )}
    </div>
  );
}
