import { useEffect, useState, type ReactNode } from 'react';
import type { Roadmap as RoadmapData, RoadmapItem, Note, Future, Check, Severity, Priority, Bug, BugStatus, PlanStep } from '../types';
import {
  getProjectDetail, type ProjectDetailData,
  createBug, patchBug, deleteBug, createRoadmapItem, patchRoadmapItem, deleteRoadmapItem,
  createNote, patchNote, deleteNote, createFuture, patchFuture, deleteFuture,
  createCheck, patchCheck, deleteCheck, runChecks, type CheckInput,
  runAudit, getAuditPrompt, type AuditResult,
  patchProject, deleteProject, createShareLink, deleteShareLink,
  getRoadDraft, setRoadDraft, type RoadDraft, judgeFuture, assistRoadmapItem,
  cleanupRoadmap, type RoadmapCleanupSuggestion,
  replanProject, startAutopilot, AuthError,
} from '../store';
import { go, hrefTo } from '../lib/route';
import { ExportBriefModal } from '../components/ExportBriefModal';
import { Overview, type ReviewEntry, type DeployPatch } from '../detail/Overview';
import { Bugs } from '../detail/Bugs';
import { Audit } from '../detail/Audit';
import { Roadmap, type ReviewTag } from '../detail/Roadmap';
import { Futures, type Alignment } from '../detail/Futures';
import { Notes } from '../detail/Notes';
import { Activity } from '../detail/Activity';
import { Modal } from '../components/Modal';
import { BugModal } from '../components/BugModal';
import { RoadmapModal } from '../components/RoadmapModal';
import { ConfirmModal } from '../components/ConfirmModal';

type Tab = 'overview' | 'bugs' | 'audit' | 'roadmap' | 'futures' | 'notes' | 'activity';
type BugFilter = 'all' | 'open' | 'fixing' | 'fixed';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' }, { key: 'bugs', label: 'Bugs' },
  { key: 'audit', label: 'Audit' },
  { key: 'roadmap', label: 'Roadmap' }, { key: 'futures', label: 'Polaris' },
  { key: 'notes', label: 'Notes' }, { key: 'activity', label: 'Activity' },
];
const STATUS_LABEL = { live: 'Live', building: 'Building', paused: 'Paused', archived: 'Archived' } as const;

const roadmapTotal = (r: RoadmapData) => r.must.length + r.should.length + r.could.length + r.wont.length;

const TAB_KEYS = new Set<Tab>(['overview', 'bugs', 'audit', 'roadmap', 'futures', 'notes', 'activity']);
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
    fromNote: number | null; editing: RoadmapItem | null; lane?: string; area?: string; fromDraft?: boolean;
  }>({ open: false, priority: 'should', title: '', note: '', fromNote: null, editing: null });
  const roadModalClosed = { open: false, priority: 'should' as Priority, title: '', note: '', fromNote: null, editing: null };
  // Device-local draft: a half-typed add-modal dismissed by a stray click.
  const [roadDraft, setRoadDraftState] = useState<RoadDraft | null>(() => getRoadDraft(slug));
  useEffect(() => { setRoadDraftState(getRoadDraft(slug)); }, [slug]);
  const updateRoadDraft = (d: RoadDraft | null) => { setRoadDraft(slug, d); setRoadDraftState(d); };
  const openRoadDraft = (d: RoadDraft) => setRoadModal({
    open: true, priority: d.priority, title: d.title, note: d.note, lane: d.lane, area: d.area,
    fromNote: null, editing: null, fromDraft: true,
  });
  const [confirmRoadDelete, setConfirmRoadDelete] = useState<RoadmapItem | null>(null);
  const [confirmBugDelete, setConfirmBugDelete] = useState<Bug | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  // Gemini's re-entry plan: null = closed, '' = loading, text = the suggestion.
  const [replan, setReplan] = useState<string | null>(null);
  const [replanErr, setReplanErr] = useState('');
  // Gemini board clean-up: null = closed, 'loading', or the suggestion list.
  const [cleanup, setCleanup] = useState<RoadmapCleanupSuggestion[] | 'loading' | null>(null);
  const [cleanupErr, setCleanupErr] = useState('');
  const [cleanupPicked, setCleanupPicked] = useState<Set<number>>(new Set());
  const [promotedNote, setPromotedNote] = useState<{ id: number; kind: 'bug' | 'roadmap' } | null>(null);
  const [promotedFuture, setPromotedFuture] = useState<number | null>(null);
  const [pendingFuture, setPendingFuture] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [checksBusy, setChecksBusy] = useState(false);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditResult, setAuditResult] = useState<AuditResult | null>(null);
  const [auditError, setAuditError] = useState('');
  const [claudeCopy, setClaudeCopy] = useState<'idle' | 'busy' | 'copied' | 'failed'>('idle');
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
  const failingChecks = data.checks.filter((c) => c.lastStatus === 'fail').length;
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

  // #161: quick-add from the inline composer — same store call, no modal needed.
  const quickAddBug = (title: string, severity: Severity) =>
    guard(async () => {
      const bug = await createBug(slug, { title, severity });
      setData({ ...data, bugs: [bug, ...bugs] });
      setBugFilter('all');
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
  const submitRoad = ({ title, note, priority, lane, area, plan }: { title: string; note: string; priority: Priority; lane: string; area: string; plan: PlanStep[] }) =>
    guard(async () => {
      const editing = roadModal.editing;
      if (editing) {
        const updated = await patchRoadmapItem(slug, editing.id, { title, note, bucket: priority, claimed_by: lane, area, plan });
        const without = { ...roadmap, [editing.bucket]: roadmap[editing.bucket].filter((i) => i.id !== editing.id) };
        setData({ ...data, roadmap: { ...without, [updated.bucket]: [...without[updated.bucket], updated] } });
        setRoadModal(roadModalClosed);
        return;
      }
      const item = await createRoadmapItem(slug, { title, note, bucket: priority, claimed_by: lane || undefined, area: area || undefined, plan: plan.length ? plan : undefined });
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

  // Drag-reorder: rebuild the target bucket's open order and renumber it. The
  // client shape doesn't carry positions, so the whole bucket renumbers 0..n —
  // buckets are small, and board order IS the autopilot queue.
  const reorderRoad = (item: RoadmapItem, toBucket: Priority, beforeId: number | null) =>
    guard(async () => {
      const target = roadmap[toBucket].filter((i) => !i.done && i.id !== item.id);
      let idx = beforeId == null ? target.length : target.findIndex((i) => i.id === beforeId);
      if (idx < 0) idx = target.length;
      const moved = { ...item, bucket: toBucket };
      const newOpen = [...target.slice(0, idx), moved, ...target.slice(idx)];
      const road = { ...roadmap };
      if (item.bucket !== toBucket) road[item.bucket] = roadmap[item.bucket].filter((i) => i.id !== item.id);
      road[toBucket] = [...newOpen, ...roadmap[toBucket].filter((i) => i.done)];
      setData({ ...data, roadmap: road });
      await Promise.all(newOpen.map((it, i) => patchRoadmapItem(slug, it.id, {
        position: i,
        ...(it.id === item.id && item.bucket !== toBucket ? { bucket: toBucket } : {}),
      })));
    });

  const toggleSkipRoad = (item: RoadmapItem) =>
    guard(async () => {
      const updated = await patchRoadmapItem(slug, item.id, { skipped: !item.skipped });
      setData({ ...data, roadmap: { ...roadmap, [item.bucket]: roadmap[item.bucket].map((i) => (i.id === item.id ? updated : i)) } });
    });

  // Board clean-up: Gemini proposes area/title/bucket fixes over the open
  // board; the human unticks what they don't want and each applied fix lands
  // through the normal PATCH path. Gemini proposes, the human disposes.
  const openCleanup = async () => {
    setCleanup('loading');
    setCleanupErr('');
    try {
      const items = await cleanupRoadmap(slug);
      setCleanup(items);
      setCleanupPicked(new Set(items.map((s) => s.id)));
    } catch (e) {
      setCleanup(null);
      setCleanupErr((e as Error)?.message || 'Gemini call failed.');
    }
  };
  const closeCleanup = () => { setCleanup(null); setCleanupErr(''); };
  const applyCleanup = () =>
    guard(async () => {
      if (!Array.isArray(cleanup)) return;
      const chosen = cleanup.filter((s) => cleanupPicked.has(s.id));
      const road = { ...roadmap };
      for (const s of chosen) {
        const updated = await patchRoadmapItem(slug, s.id, {
          ...(s.area ? { area: s.area } : {}),
          ...(s.title ? { title: s.title } : {}),
          ...(s.bucket ? { bucket: s.bucket } : {}),
        });
        for (const b of Object.keys(road) as Priority[]) road[b] = road[b].filter((i) => i.id !== s.id);
        road[updated.bucket] = [...road[updated.bucket], updated];
      }
      setData({ ...data, roadmap: road });
      closeCleanup();
    });

  // Archive review: store the verdict. Solid is the only pickable one now —
  // dissatisfaction goes through Refine (#141), not a rethink tag.
  const reviewTagRoad = (item: RoadmapItem, tag: ReviewTag) =>
    guard(async () => {
      const updated = await patchRoadmapItem(slug, item.id, { review_tag: tag });
      setData({ ...data, roadmap: { ...roadmap, [item.bucket]: roadmap[item.bucket].map((i) => (i.id === item.id ? updated : i)) } });
    });

  // Review annotations (#146): the chip row on a To-verify row — the whole
  // tag list PATCHes back each time, like plan steps.
  const reviewTagsRoad = (item: RoadmapItem, tags: string[]) =>
    guard(async () => {
      const updated = await patchRoadmapItem(slug, item.id, { review_tags: tags });
      setData({ ...data, roadmap: { ...roadmap, [item.bucket]: roadmap[item.bucket].map((i) => (i.id === item.id ? updated : i)) } });
    });

  // Shelve a review (#148): the completed row steps out of the To-verify list
  // onto the collapsed shelf — good enough for now, reviewed properly later.
  // Nothing else about the item changes; the same call brings it back.
  const shelveRoad = (item: RoadmapItem) =>
    guard(async () => {
      const updated = await patchRoadmapItem(slug, item.id, { review_shelved: !item.reviewShelved });
      setData({ ...data, roadmap: { ...roadmap, [item.bucket]: roadmap[item.bucket].map((i) => (i.id === item.id ? updated : i)) } });
    });

  // Refine (#146, replacing #141's full rework): delta-only. The item goes
  // back to the board as itself — the server clears the verdict and claim,
  // keeps built_note — carrying just the refinement instruction; optionally a
  // pinned autopilot session is queued on it straight away.
  const refineRoad = (item: RoadmapItem, refineNote: string, queueNow: boolean) =>
    guard(async () => {
      const updated = await patchRoadmapItem(slug, item.id, { done: false, refine_note: refineNote });
      setData({ ...data, roadmap: { ...roadmap, [item.bucket]: roadmap[item.bucket].map((i) => (i.id === item.id ? updated : i)) } });
      if (queueNow) await startAutopilot(slug, String(item.id));
    });

  // ＋ Bug / ＋ Audit from a review row (#146): log a ticket referencing the
  // item — the prefilled modal opens, the human finishes and saves it.
  const logBugFromReview = (item: RoadmapItem) =>
    setBugModal({ open: true, title: `#${item.id} ${item.title}: `, fromNote: null });
  const logAuditFromReview = (item: RoadmapItem) =>
    setRoadModal({
      open: true, priority: 'should', title: `Audit #${item.id} — ${item.title}`,
      note: `Audit what landed for #${item.id}: exercise it against the item's intent and log bugs for anything off.`,
      area: 'audit', fromNote: null, editing: null,
    });

  const toggleRoad = (item: RoadmapItem) =>
    guard(async () => {
      const updated = await patchRoadmapItem(slug, item.id, { done: !item.done });
      const bucket = roadmap[item.bucket].map((it) => (it.id === item.id ? updated : it));
      setData({ ...data, roadmap: { ...roadmap, [item.bucket]: bucket } });
    });

  // #169 — area management: clear or reassign the area tag across all affected
  // items via the normal PATCH route. A client-side loop is fine at board scale.
  const deleteArea = async (_area: string, itemIds: number[]) => {
    const allItems = [...roadmap.must, ...roadmap.should, ...roadmap.could, ...roadmap.wont];
    const road = { ...roadmap };
    for (const id of itemIds) {
      const item = allItems.find((it) => it.id === id);
      if (!item) continue;
      const updated = await patchRoadmapItem(slug, id, { area: '' });
      road[item.bucket] = road[item.bucket].map((it) => (it.id === id ? updated : it));
    }
    setData({ ...data, roadmap: road });
  };

  const renameArea = async (_from: string, to: string, itemIds: number[]) => {
    const allItems = [...roadmap.must, ...roadmap.should, ...roadmap.could, ...roadmap.wont];
    const road = { ...roadmap };
    for (const id of itemIds) {
      const item = allItems.find((it) => it.id === id);
      if (!item) continue;
      const updated = await patchRoadmapItem(slug, id, { area: to });
      road[item.bucket] = road[item.bucket].map((it) => (it.id === id ? updated : it));
    }
    setData({ ...data, roadmap: road });
  };

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

  const editFuture = (fid: number, patch: { title: string; note: string; area: string }) =>
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

  const moveFuture = (fid: number, x: number, y: number) =>
    guard(async () => {
      const updated = await patchFuture(slug, fid, { canvasX: x, canvasY: y });
      setData({ ...data, futures: futures.map((f) => (f.id === fid ? updated : f)) });
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

  // ---- checks (the Audit tab's test suite) ----
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

  const addCheck = (input: CheckInput) =>
    guard(async () => {
      const c = await createCheck(slug, input);
      setData({ ...data, checks: [...data.checks, c] });
    });

  const editCheck = (cid: number, patch: Partial<CheckInput>) =>
    guard(async () => {
      const c = await patchCheck(slug, cid, patch);
      setData({ ...data, checks: data.checks.map((x) => (x.id === cid ? c : x)) });
    });

  const removeCheck = (cid: number) =>
    guard(async () => {
      await deleteCheck(slug, cid);
      setData({ ...data, checks: data.checks.filter((c) => c.id !== cid) });
    });

  const checkToBug = (c: Check) =>
    setBugModal({ open: true, title: `Check failing: ${c.name} — ${c.lastError || `HTTP ${c.lastCode}`}`, fromNote: null });

  // ---- the automated bug audit (#144) ----
  // Re-runs the checks first so Gemini judges fresh evidence, then audits;
  // logged findings are review-inbox bugs, merged straight into the list.
  const runProjectAudit = async () => {
    setAuditBusy(true); setAuditError(''); setAuditResult(null);
    try {
      let checks = data.checks;
      if (checks.length) {
        const updated = await runChecks(slug);
        const byId = new Map(updated.map((c) => [c.id, c]));
        checks = checks.map((c) => byId.get(c.id) ?? c);
      }
      const result = await runAudit(slug);
      const logged = result.findings.flatMap((f) => (f.bug ? [f.bug] : []));
      setData({ ...data, checks, bugs: [...logged, ...data.bugs] });
      setAuditResult(result);
    } catch (e) {
      setAuditError((e as Error)?.message || 'Audit failed.');
    } finally {
      setAuditBusy(false);
    }
  };

  const saveAuditContext = (text: string) =>
    guard(async () => {
      await patchProject(slug, { audit_context: text });
      setData({ ...data, auditContext: text });
    });

  const copyClaudePrompt = async () => {
    setClaudeCopy('busy');
    try {
      const prompt = await getAuditPrompt(slug);
      await navigator.clipboard.writeText(prompt);
      setClaudeCopy('copied');
    } catch {
      setClaudeCopy('failed');
    }
    window.setTimeout(() => setClaudeCopy('idle'), 2600);
  };

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

  // Automode: opt this project in/out of the overnight autopilot (the runner
  // refuses projects with this off, on top of the global arm switch).
  const toggleAutomode = () =>
    guard(async () => {
      const updated = await patchProject(slug, { automode: !project.automode });
      setData({ ...data, project: { ...project, automode: updated.automode } });
    });

  const removeProject = () =>
    guard(async () => { await deleteProject(slug); go.dashboard(); });

  // Gemini drafts a first-session-back plan; the human decides whether it
  // becomes a note. Suggestion only.
  const openReplan = async () => {
    setReplan('');
    setReplanErr('');
    try {
      setReplan(await replanProject(slug));
    } catch (e) {
      if (e instanceof AuthError) return;
      setReplanErr((e as Error)?.message || 'Gemini call failed.');
    }
  };
  const saveReplanAsNote = () => {
    const text = replan;
    setReplan(null);
    if (text) addNote(`✧ Re-entry plan\n${text}`);
  };

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
          <button className="btn-repo" onClick={go.control} title="Mission Control — every project's automation">Mission Control</button>
          <a className="btn-repo" href={hrefTo.terminal(slug)} title={`Open a terminal in ~/${slug}`}>⌨</a>
          <button className="avatar sm" onClick={go.settings} aria-label="Settings" />
        </div>
      </div>

      <div className="page detail">
        <div className="detail-head">
          <div>
            <div className="titlerow">
              <div className="detail-title">{project.name}</div>
              <span className={`statusbadge ${project.status}`}><span className="dot" />{STATUS_LABEL[project.status]}</span>
              <button className={`autobadge ${project.automode ? 'on' : ''}`} onClick={toggleAutomode}
                title={project.automode
                  ? 'Automode ON — the overnight autopilot may pick up this project. Click to switch off.'
                  : 'Automode OFF — the autopilot leaves this project alone. Click to opt in.'}>
                ⚙ {project.automode ? 'auto' : 'manual'}
              </button>
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
            const n = t.key === 'bugs' ? openBugCount : t.key === 'audit' ? failingChecks
              : t.key === 'roadmap' ? openRoadCount : t.key === 'futures' ? unsortedFutures : 0;
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
            onViewAll={viewAll} onExport={() => setExportOpen(true)} onReplan={openReplan}
            onChangeDirectives={changeDirectives}
            onReviewKeep={reviewKeep} onReviewDismiss={reviewDismiss} onSaveDeploy={saveDeploy}
            onSaveStack={saveStack} />
        )}
        {tab === 'bugs' && (
          <Bugs bugs={bugs} filter={bugFilter} setFilter={setBugFilter} highlightId={highlightId}
            onReport={() => setBugModal({ open: true, title: '', fromNote: null })} onOpenLink={openBugLink}
            onSetStatus={setBugStatus} onDelete={(b) => setConfirmBugDelete(b)}
            onQuickAddBug={quickAddBug} />
        )}
        {tab === 'audit' && (
          <Audit slug={slug} checks={data.checks} siteUrl={project.siteUrl} checksBusy={checksBusy}
            onRunChecks={runProjectChecks} onAddCheck={addCheck} onEditCheck={editCheck}
            onDeleteCheck={removeCheck} onCheckToBug={checkToBug}
            auditContext={data.auditContext} onSaveAuditContext={saveAuditContext}
            auditBusy={auditBusy} auditResult={auditResult} auditError={auditError}
            onRunAudit={runProjectAudit} claudeCopy={claudeCopy} onCopyClaudePrompt={copyClaudePrompt} />
        )}
        {tab === 'roadmap' && (
          <Roadmap roadmap={roadmap} highlightId={highlightId} slug={slug} liveBranches={data.liveBranches}
            onAdd={(p, area) => roadDraft
              ? openRoadDraft(roadDraft)
              : setRoadModal({ open: true, priority: p, title: '', note: '', area, fromNote: null, editing: null })}
            draft={roadDraft} onResumeDraft={() => roadDraft && openRoadDraft(roadDraft)}
            onDiscardDraft={() => updateRoadDraft(null)}
            onToggle={toggleRoad}
            onEdit={(it) => setRoadModal({ open: true, priority: it.bucket, title: it.title, note: it.note, fromNote: null, editing: it })}
            onDelete={(it) => setConfirmRoadDelete(it)} onReviewTag={reviewTagRoad}
            onReviewTags={reviewTagsRoad} onRefine={refineRoad} onShelve={shelveRoad}
            onLogBug={logBugFromReview} onLogAudit={logAuditFromReview}
            onToggleSkip={toggleSkipRoad} onReorder={reorderRoad} onCleanup={openCleanup}
            onDeleteArea={deleteArea} onRenameArea={renameArea}
            onSendToTerminal={(brief) => {
              // One-shot handoff — the terminal screen offers it as a paste.
              try { sessionStorage.setItem('stack.term.brief', brief); } catch { /* private mode — the button just won't appear */ }
              go.terminal(slug);
            }} />
        )}
        {tab === 'futures' && (
          <Futures northStar={data.northStar} futures={futures} highlightId={highlightId} slug={slug}
            onSaveNorthStar={saveNorthStar} onAdd={addFuture} onEdit={editFuture} onAlign={alignFuture}
            onAskGemini={(id) => judgeFuture(slug, id)}
            onDelete={removeFuture} onPromote={promoteFuture} onMove={moveFuture} />
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
          initialArea={roadModal.editing?.area ?? roadModal.area ?? ''}
          initialPlan={roadModal.editing?.plan ?? []}
          lanes={[...new Set(allRoadmap.map((i) => i.claimedBy))].filter(Boolean).sort()}
          areas={[...new Set([...allRoadmap.map((i) => i.area), ...futures.map((f) => f.area)])].filter(Boolean).sort()}
          mode={roadModal.editing ? 'edit' : 'add'}
          onClose={() => { setRoadModal(roadModalClosed); setPendingFuture(null); }}
          onDismiss={(d) => updateRoadDraft(d)}
          onAssist={(note) => assistRoadmapItem(slug, note)}
          onSubmit={submitRoad} />
      )}
      {(cleanup !== null || cleanupErr) && (
        <Modal onClose={closeCleanup} wide>
          <h3>✧ Board clean-up</h3>
          {cleanupErr ? (
            <div className="gemini-suggest err">✧ {cleanupErr}</div>
          ) : cleanup === 'loading' ? (
            <div className="confirm-body">Gemini is reading the open board…</div>
          ) : Array.isArray(cleanup) && cleanup.length === 0 ? (
            <div className="confirm-body">Nothing to tidy — every open item has an area and reads cleanly.</div>
          ) : Array.isArray(cleanup) && (
            <>
              <div className="confirm-body" style={{ marginBottom: 14 }}>
                Suggestions only — untick anything you don't want, then apply.
              </div>
              <div className="cleanup-list">
                {cleanup.map((s) => (
                  <label className="cleanup-row" key={s.id}>
                    <input type="checkbox" checked={cleanupPicked.has(s.id)}
                      onChange={() => setCleanupPicked((p) => {
                        const next = new Set(p);
                        if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                        return next;
                      })} />
                    <span className="cleanup-body">
                      <span className="t">{s.currentTitle}</span>
                      <span className="changes">
                        {s.title && <span className="chg">title → “{s.title}”</span>}
                        {s.area && <span className="chg">area → {s.area}</span>}
                        {s.bucket && <span className="chg">bucket → {s.bucket}</span>}
                      </span>
                      {s.why && <span className="why">{s.why}</span>}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button className="btn-cancel" onClick={closeCleanup}>Close</button>
            {Array.isArray(cleanup) && cleanup.length > 0 && (
              <button className="btn-submit" onClick={applyCleanup} disabled={cleanupPicked.size === 0}>
                Apply {cleanupPicked.size} fix{cleanupPicked.size === 1 ? '' : 'es'}
              </button>
            )}
          </div>
        </Modal>
      )}
      {(replan !== null || replanErr) && (
        <Modal onClose={() => { setReplan(null); setReplanErr(''); }}>
          <h3>✧ Re-entry plan</h3>
          {replanErr ? (
            <div className="gemini-suggest err">✧ {replanErr}</div>
          ) : replan === '' ? (
            <div className="confirm-body">Gemini is reading the project's live state…</div>
          ) : (
            <>
              <div className="replan-text">{replan}</div>
              <div className="confirm-body" style={{ marginTop: 12, fontSize: 12 }}>
                A suggestion from the resume card, open bugs and roadmap — save it as a sticky if
                it's a keeper.
              </div>
            </>
          )}
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button className="btn-cancel" onClick={() => { setReplan(null); setReplanErr(''); }}>Close</button>
            {replan && <button className="btn-submit" onClick={saveReplanAsNote}>Save as note</button>}
          </div>
        </Modal>
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
