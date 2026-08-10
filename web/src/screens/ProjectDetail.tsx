import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Roadmap as RoadmapData, RoadmapItem, Future, Severity, Priority, Bug, BugStatus, WorkbenchPhase, ProjectPulse } from '../types';
import {
  getProjectDetail, getProjectPulse, type ProjectDetailData,
  createBug, patchBug, deleteBug, createRoadmapItem, patchRoadmapItem, deleteRoadmapItem,
  deleteNote, createFuture, patchFuture, deleteFuture, getFutures,
  createCheck, patchCheck, deleteCheck, runChecks, type CheckInput,
  patchProject, createShareLink, deleteShareLink,
  getRoadDraft, setRoadDraft, type RoadDraft, judgeFuture, clusterFutures, convergeFutures,
  type ConvergeDraft, assistRoadmapItem, proposeOrbits, restateFuture,
  cleanupRoadmap, type RoadmapCleanupSuggestion,
  takeReviewPrefill, agentCan, setLastViewedProject,
  agentConsoleCan, agentConsoleOffReason, type TabAgentKey,
  HttpError, getWorkbench, addWorkbenchCard,
} from '../store';
import { go, hrefTo } from '../lib/route';
import { planWorkbenchOpen } from '../lib/workbenchOpen';
import { Overview, type ReviewEntry, type DeployPatch } from '../detail/Overview';
import { Quality } from '../detail/Quality';
import { RoadmapTab } from '../detail/RoadmapTab';
import { Futures, type Alignment } from '../detail/Futures';
import { Workbench } from '../detail/Workbench';
import { Activity } from '../detail/Activity';
import { Modal } from '../components/Modal';
import { BugModal } from '../components/BugModal';
import { RoadmapModal, type RoadmapFields } from '../components/RoadmapModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { TabTerminal } from '../components/TabTerminal';

// #278 — Bugs and Audit are one tab now: Quality. They were halves of one loop
// (run → see red → file → fix → re-run) and it crossed a tab boundary twice.
type Tab = 'overview' | 'quality' | 'roadmap' | 'futures' | 'workbench' | 'activity';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' }, { key: 'quality', label: 'Quality' },
  { key: 'roadmap', label: 'Roadmap' }, { key: 'futures', label: 'Polaris' },
  { key: 'workbench', label: 'Workbench' }, { key: 'activity', label: 'Activity' },
];
const STATUS_LABEL = { live: 'Live', building: 'Building', paused: 'Paused', archived: 'Archived' } as const;

// #379 — which agent owns each tab, for the console strip under the tab bar.
// The BINDING is the server's (agents.js); this is only the name to draw before
// the payload has arrived, and the four tabs that have one. Overview and
// Activity are readings of what already happened — there is nobody working
// there to give a session to.
const TAB_AGENT: Partial<Record<Tab, { key: TabAgentKey; name: string }>> = {
  quality: { key: 'auditor', name: 'Auditor' },
  roadmap: { key: 'curator', name: 'Curator' },
  futures: { key: 'polaris', name: 'Polaris' },
  workbench: { key: 'drafter', name: 'Drafter' },
};

const TAB_KEYS = new Set<Tab>(['overview', 'quality', 'roadmap', 'futures', 'workbench', 'activity']);
// 'bugs' and 'audit' both land on Quality — old deep links (bookmarks, a search
// payload from an older server, a ⌘K target) keep working. 'tips' is the same
// idea: the recipe library left the tab strip for the bottom-left dock, which
// opens itself on that link (components/TipsDock) and rewrites the hash, so the
// page underneath just shows Overview. 'notes' resolves to the Workbench, which
// is where a note is read now — and `hl` on that link is still a NOTE id, which
// the canvas resolves to the card wrapping it.
const LEGACY_TABS: Record<string, Tab> = { bugs: 'quality', audit: 'quality', tips: 'overview', notes: 'workbench' };
const asTab = (t: string | undefined): Tab =>
  (t && TAB_KEYS.has(t as Tab) ? (t as Tab) : (t && LEGACY_TABS[t]) || 'overview');

export function ProjectDetail({ id, tab, highlight, onOpenSearch }: {
  id: string; tab?: string; highlight?: string; onOpenSearch: () => void;
}) {
  const [data, setData] = useState<ProjectDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  // The Overview's three measured bands, on their own trip: the heaviest read
  // on a project and the only tab that wants it, so it must not sit in front of
  // the payload every other tab renders from. Its failure is carried, not
  // swallowed — a band that could not be READ says so rather than drawing a
  // project that spent, tested and ran nothing.
  const [pulse, setPulse] = useState<ProjectPulse | null>(null);
  const [pulseError, setPulseError] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    getProjectDetail(id)
      .then((d) => {
        if (live) {
          setData(d); setLoadError('');
          setLastViewedProject(id); // the roadmap link's fallback when no app is selected — #297
        }
      })
      .catch((e) => { if (live) setLoadError(e?.message || 'Failed to load.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [id]);

  useEffect(() => {
    let live = true;
    setPulse(null);
    setPulseError('');
    getProjectPulse(id)
      .then((p) => { if (live) setPulse(p); })
      .catch((e) => { if (live) setPulseError(e?.message || 'Could not read this project’s pulse'); });
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
  return <Detail data={data} setData={setData} pulse={pulse} pulseError={pulseError}
    routeTab={tab} routeHighlight={highlight} onOpenSearch={onOpenSearch} />;
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

function Detail({ data, setData, pulse, pulseError, routeTab, routeHighlight, onOpenSearch }: {
  data: ProjectDetailData; setData: (d: ProjectDetailData) => void;
  pulse: ProjectPulse | null; pulseError: string;
  routeTab?: string; routeHighlight?: string; onOpenSearch: () => void;
}) {
  const { project, activity } = data;
  const slug = project.id;

  const initialTab = asTab(routeTab);
  const [tab, setTab] = useState<Tab>(initialTab);
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
    // #303 — the row is not always in the DOM on this first pass. A tab may
    // still be mounting, and the Roadmap board unfolds/unfilters itself to
    // reveal a deep-linked item (see its own effect), which lands a render
    // later. A single synchronous query would miss all of that and silently
    // scroll nowhere, so keep looking briefly and stop at the first hit.
    let tries = 0;
    let poll: ReturnType<typeof setTimeout>;
    const find = () => {
      const node = document.querySelector(`[data-hl="${highlightId}"]`);
      if (node) { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
      if (++tries < 12) poll = setTimeout(find, 50);   // ~600ms, then give up quietly
    };
    find();
    const t = setTimeout(() => setHighlightId(null), 2800);
    return () => { clearTimeout(t); clearTimeout(poll); };
  }, [highlightId, tab]);
  const [bugModal, setBugModal] = useState<{ open: boolean; title: string; fromNote: number | null }>(
    { open: false, title: '', fromNote: null });
  const [roadModal, setRoadModal] = useState<{
    open: boolean; priority: Priority; title: string; note: string;
    fromNote: number | null; editing: RoadmapItem | null; branch?: string; area?: string; fromDraft?: boolean;
  }>({ open: false, priority: 'should', title: '', note: '', fromNote: null, editing: null });
  const roadModalClosed = { open: false, priority: 'should' as Priority, title: '', note: '', fromNote: null, editing: null };
  // Device-local draft: a half-typed add-modal dismissed by a stray click.
  const [roadDraft, setRoadDraftState] = useState<RoadDraft | null>(() => getRoadDraft(slug));
  useEffect(() => { setRoadDraftState(getRoadDraft(slug)); }, [slug]);
  const updateRoadDraft = (d: RoadDraft | null) => { setRoadDraft(slug, d); setRoadDraftState(d); };
  const openRoadDraft = (d: RoadDraft) => setRoadModal({
    open: true, priority: d.priority, title: d.title, note: d.note, branch: d.branch, area: d.area,
    fromNote: null, editing: null, fromDraft: true,
  });
  const [confirmRoadDelete, setConfirmRoadDelete] = useState<RoadmapItem | null>(null);
  const [confirmBugDelete, setConfirmBugDelete] = useState<Bug | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  // The Curator's board clean-up: null = closed, 'loading', or the suggestion list.
  const [cleanup, setCleanup] = useState<RoadmapCleanupSuggestion[] | 'loading' | null>(null);
  const [cleanupErr, setCleanupErr] = useState('');
  const [cleanupPicked, setCleanupPicked] = useState<Set<number>>(new Set());
  const [promotedNote, setPromotedNote] = useState<{ id: number; kind: 'bug' | 'roadmap' } | null>(null);
  // Bumped whenever a note is deleted from outside the canvas, so the Workbench
  // reloads instead of drawing a card whose note no longer exists.
  const [notesNonce, setNotesNonce] = useState(0);
  // #314 — the ids a promotion actually carried through: the idea plus its
  // orbit (planets/moons), never just the one that was clicked. Keep-or-delete
  // has to cover the whole set, or a deleted star leaves its planets pointing
  // at a row that no longer exists (the server only cuts them loose when a
  // star is UN-starred, not when it's deleted).
  const [promotedFuture, setPromotedFuture] = useState<number[] | null>(null);
  const [pendingFuture, setPendingFuture] = useState<number[] | null>(null);
  const [checksBusy, setChecksBusy] = useState(false);
  const [editingUrl, setEditingUrl] = useState<'site' | 'repo' | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [actionError, setActionError] = useState('');

  // #282 — the Review room's ＋ Bug / ＋ Audit. The room has no modals and no
  // project loaded, so it stashes a prefill and opens the project; this picks it
  // up exactly once (the same one-shot idiom as the terminal brief). Runs after
  // mount so the modal state is live.
  useEffect(() => {
    const p = takeReviewPrefill(slug);
    if (!p) return;
    if (p.kind === 'bug') {
      setBugModal({ open: true, title: `#${p.itemId} ${p.title}: `, fromNote: null });
    } else {
      setRoadModal({
        open: true, priority: 'should', title: `Audit #${p.itemId} — ${p.title}`,
        note: `Audit what landed for #${p.itemId}: exercise it against the item's intent and log bugs for anything off.`,
        area: 'audit', fromNote: null, editing: null,
      });
    }
  }, [slug]);

  const bugs = data.bugs;
  const roadmap = data.roadmap;
  const notes = data.notes;
  const futures = data.futures;

  const allRoadmap = [...roadmap.must, ...roadmap.should, ...roadmap.could, ...roadmap.wont];
  // The project-scoped review queue: items nobody typed, that no human has
  // signed off. Bugs and futures can only be 'hook'; a roadmap item is also
  // 'fly' (#381 — opened by a live session), held on the same footing, so it
  // has to queue in the same place. Held and invisible is unapprovable.
  const reviewQueue: ReviewEntry[] = [
    ...bugs.filter((b) => b.source === 'hook' && !b.reviewed)
      .map((b) => ({ kind: 'bug' as const, key: b.id, title: b.title, meta: b.severity })),
    ...allRoadmap.filter((r) => (r.source === 'hook' || r.source === 'fly') && !r.reviewed)
      .map((r) => ({ kind: 'roadmap' as const, key: String(r.id), title: r.title, meta: r.bucket })),
    ...futures.filter((f) => f.source === 'hook' && !f.reviewed)
      .map((f) => ({ kind: 'future' as const, key: String(f.id), title: f.title, meta: 'idea' })),
  ];

  const openRoadCount = allRoadmap.filter((r) => !r.done).length;
  const unsortedFutures = futures.filter((f) => !f.alignment).length;
  const failingChecks = data.checks.filter((c) => c.lastStatus === 'fail').length;
  // The Quality tab's single badge (#278): red checks plus serious open bugs.
  const needsAttention = failingChecks
    + bugs.filter((b) => b.status !== 'fixed' && (b.severity === 'critical' || b.severity === 'high')).length;
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
      if (fromNote != null) setPromotedNote({ id: fromNote, kind: 'bug' });
    });

  // #161/#278: the Quality page's inline report bar. `checkId` is set when the
  // bug is filed straight off a red check — that link is what makes the loop
  // legible from either side afterwards.
  const fileBug = (title: string, severity: Severity, checkId: number | null) =>
    guard(async () => {
      const bug = await createBug(slug, { title, severity, check_id: checkId });
      setData({ ...data, bugs: [bug, ...bugs] });
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
  const submitRoad = ({ title, note, priority, branch, area, plan, risk, tier, riskChanged }: RoadmapFields) =>
    guard(async () => {
      const editing = roadModal.editing;
      if (editing) {
        const updated = await patchRoadmapItem(slug, editing.id, {
          title, note, bucket: priority, claimed_by: branch, area, plan,
          // #262 — a save the human made without touching Risk must not write the
          // tier back, because the server records any risk write with no explicit
          // source as human-set. Reclaiming it that way would freeze the tier and
          // leave the plan-time pre-pass unable to ever re-tier the item again.
          ...(riskChanged ? { risk } : {}),
          tier,
        });
        const without = { ...roadmap, [editing.bucket]: roadmap[editing.bucket].filter((i) => i.id !== editing.id) };
        setData({ ...data, roadmap: { ...without, [updated.bucket]: [...without[updated.bucket], updated] } });
        setRoadModal(roadModalClosed);
        return;
      }
      const item = await createRoadmapItem(slug, { title, note, bucket: priority, claimed_by: branch || undefined, area: area || undefined, plan: plan.length ? plan : undefined, risk: risk !== 'normal' ? risk : undefined, tier: tier || undefined });
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

  // ⎇ Branch for focused work (#205): claim the item's branch, then open a
  // terminal session primed with a build brief for that branch. The claim is
  // the board's in-progress marker (and the autopilot's keep-off signal); the
  // merge back home is Mission Control's merge strip, like any other branch.
  const branchItem = (item: RoadmapItem) =>
    guard(async () => {
      // The `lane/` ref prefix is deliberately unchanged by #277's rename: it
      // names real branches that already exist on origin, and both the host
      // dispatcher and `stack tree` group on it. The VOCABULARY is 'branch'.
      const branch = `lane/item-${item.id}`;
      const updated = await patchRoadmapItem(slug, item.id, { claimed_by: branch });
      setData({ ...data, roadmap: { ...roadmap, [item.bucket]: roadmap[item.bucket].map((i) => (i.id === item.id ? updated : i)) } });
      const brief = [
        `Build roadmap item #${item.id} — ${item.title} — on its own branch (${branch}).`,
        item.note ? `\nThe item:\n${item.note}` : '',
        item.plan.length ? `\nThe plan (work unticked steps top-down, PATCH the full list back as each lands):\n${item.plan.map((s) => `${s.done ? '[x]' : '[ ]'} ${s.text}`).join('\n')}` : '',
        `\nWork it in a worktree so this checkout stays free: git worktree add ../wt-item-${item.id} -b ${branch}`,
        `Commit in small units and push with: git push -u origin ${branch}`,
        `When it lands: PATCH built_note + done:true on the item (the branch claim is already ${branch}),`,
        'then merge the branch back from Mission Control’s merge strip (⇥ Merge) — or keep it open if it needs more nights.',
      ].filter(Boolean).join('\n');
      try { sessionStorage.setItem('stack.term.brief', brief); } catch { /* private mode — the handoff just won't appear */ }
      go.terminal(slug);
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

  // #313 — an in-place "remove this note" affordance on the board/parked
  // cards: clears just the one field (never built_note) without opening the
  // edit modal or touching the rest of the item.
  const clearRoadNote = (item: RoadmapItem, field: 'note' | 'refineNote') =>
    guard(async () => {
      const updated = await patchRoadmapItem(slug, item.id, field === 'note' ? { note: '' } : { refine_note: '' });
      setData({ ...data, roadmap: { ...roadmap, [item.bucket]: roadmap[item.bucket].map((i) => (i.id === item.id ? updated : i)) } });
    });

  // Board clean-up: the Curator proposes area/title/bucket fixes over the
  // open board; the human unticks what they don't want and each applied fix
  // lands through the normal PATCH path. The Curator proposes, the human
  // disposes.
  const openCleanup = async () => {
    setCleanup('loading');
    setCleanupErr('');
    try {
      const items = await cleanupRoadmap(slug);
      setCleanup(items);
      setCleanupPicked(new Set(items.map((s) => s.id)));
    } catch (e) {
      setCleanup(null);
      setCleanupErr((e as Error)?.message || "The Curator's call failed.");
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

  // #227 — set (or clear) an item's desire tier from the Tiers view. An ordinary
  // PATCH like every other board mutation; the tier then leads the run queue in
  // the Plan room and in the overnight runner's pick.
  const setTierRoad = (item: RoadmapItem, tier: RoadmapItem['tier']) =>
    guard(async () => {
      const updated = await patchRoadmapItem(slug, item.id, { tier });
      setData({ ...data, roadmap: { ...roadmap, [item.bucket]: roadmap[item.bucket].map((i) => (i.id === item.id ? updated : i)) } });
    });

  // The v2 Roadmap views write through store.ts themselves and hand back the
  // row the server returned. These two put it into the local copy — including
  // the case a plain replace would get wrong: a PATCH that changed the item's
  // BUCKET has to move it between the grouped arrays, not just overwrite it in
  // the one it used to be in, or the card renders in its old lane until reload.
  // Replace a BATCH in one pass. This is a list rather than a single row
  // because `roadmap` here is closed over from this render: calling the
  // one-row version N times in a loop rebuilds from the same base every time
  // and only the LAST write survives — a lane swept into the archive would put
  // one card away and silently leave the rest. Callers that write several rows
  // collect them and land them together.
  const replaceRoadItems = (updated: RoadmapItem[]) => {
    if (!updated.length) return;
    const byId = new Map(updated.map((u) => [u.id, u]));
    const next: RoadmapData = { must: [], should: [], could: [], wont: [] };
    (['must', 'should', 'could', 'wont'] as Priority[]).forEach((b) => {
      next[b] = roadmap[b].filter((it) => !byId.has(it.id));
    });
    for (const u of updated) next[u.bucket] = [...next[u.bucket], u];
    setData({ ...data, roadmap: next });
  };
  const replaceRoadItem = (updated: RoadmapItem) => replaceRoadItems([updated]);
  const addRoadItem = (created: RoadmapItem) => {
    setData({ ...data, roadmap: { ...roadmap, [created.bucket]: [...roadmap[created.bucket], created] } });
  };

  const toggleRoad = (item: RoadmapItem) =>
    guard(async () => {
      const updated = await patchRoadmapItem(slug, item.id, { done: !item.done });
      const bucket = roadmap[item.bucket].map((it) => (it.id === item.id ? updated : it));
      setData({ ...data, roadmap: { ...roadmap, [item.bucket]: bucket } });
    });

  // Notes are created and edited on the Workbench now, through its own route
  // (which writes the note AND places its card in one transaction). What is
  // left here is the one path that still deletes a note from OUTSIDE the
  // canvas: "you promoted it, delete the original?". Bumping `notesNonce` is
  // how the canvas hears about it — its card is gone server-side (the FK
  // cascades) and it would otherwise keep drawing a card for a dead note.
  const removeNote = (nid: number) =>
    guard(async () => {
      await deleteNote(slug, nid);
      setData({ ...data, notes: notes.filter((n) => n.id !== nid) });
      setNotesNonce((n) => n + 1);
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

  // #312 — where an idea sits in the galaxy and how big it is. One handler for
  // all three because the moves overlap: adopting demotes a star, promoting
  // cuts the old orbit, and the server resolves that pair in one statement.
  // It re-reads the whole collection rather than patching the one row: a
  // promotion or a dissolve moves the idea's CHILDREN too, and those rows come
  // back changed without being in the response.
  const shapeFuture = (fid: number, patch: { parentId?: number | null; isStar?: boolean; magnitude?: number | null }) =>
    guard(async () => {
      await patchFuture(slug, fid, patch);
      setData({ ...data, futures: await getFutures(slug) });
    });

  // Deleting an idea changes rows the response never mentions: `futures.parent_id`
  // is ON DELETE SET NULL, so dismissing a star cuts its planets loose in the same
  // statement (schema.sql — "returns its moons to the shells rather than deleting
  // work you kept"). Filtering the one row out of the snapshot leaves every child
  // still naming a parent that is gone, and the panel reads parentId raw: it goes
  // on offering "— cut it loose —" on an idea that is already loose. Refetch, like
  // shapeFuture — only the server knows what its own foreign key did.
  const removeFuture = (fid: number) =>
    guard(async () => {
      await deleteFuture(slug, fid);
      setData({ ...data, futures: await getFutures(slug) });
    });

  // #314 — keep-or-delete after a promotion has to cover the whole set that
  // rode through (the idea plus its orbit), or a deleted star leaves its
  // planets pointing at a row that's gone.
  const removeFutures = (ids: number[]) =>
    guard(async () => {
      for (const id of ids) await deleteFuture(slug, id);
      const removed = new Set(ids);
      setData({ ...data, futures: futures.filter((f) => !removed.has(f.id)) });
    });

  // The orbit rail's own adopt path — same two steps as shapeFuture, but NOT
  // wrapped in guard: the server legitimately rejects some adoptions (a target
  // that isn't a star or planet, self-orbit, a target that has since moved),
  // and the rail's row needs that rejection to reach it so it can show the
  // reason beside the row rather than lose it to the page banner and vanish
  // the row as though the adoption had applied.
  const adoptOrbit = async (fid: number, parentId: number) => {
    await patchFuture(slug, fid, { parentId });
    setData({ ...data, futures: await getFutures(slug) });
  };

  // Applies a ✧ Cluster batch in one go — one state write, so N area patches
  // never clobber each other on the shared snapshot.
  const applyFutureAreas = (pairs: { id: number; area: string }[]) =>
    guard(async () => {
      const updated = await Promise.all(pairs.map((p) => patchFuture(slug, p.id, { area: p.area })));
      const byId = new Map(updated.map((u) => [u.id, u]));
      setData({ ...data, futures: futures.map((f) => byId.get(f.id) || f) });
    });

  // Converge (the sky's tray → tickets): create every draft through the normal
  // roadmap POST, retire the converged ideas, then one state write for both.
  const convergeCreate = (drafts: ConvergeDraft[], retireIds: number[]) =>
    guard(async () => {
      const created: RoadmapItem[] = [];
      for (const d of drafts) {
        created.push(await createRoadmapItem(slug, {
          title: d.title.trim(), note: d.note.trim(), bucket: d.bucket,
          area: d.area.trim().toLowerCase() || undefined,
          plan: (() => {
            const steps = d.plan.map((t) => t.trim()).filter(Boolean);
            return steps.length ? steps.map((text) => ({ text, done: false })) : undefined;
          })(),
        }));
      }
      for (const id of retireIds) await deleteFuture(slug, id);
      const nextRoadmap = { ...roadmap };
      for (const it of created) nextRoadmap[it.bucket] = [...nextRoadmap[it.bucket], it];
      // Retiring converged ideas is a delete, so the same rule as removeFuture:
      // read back rather than filter, or the survivors keep orbiting a retired one.
      setData({
        ...data,
        roadmap: nextRoadmap,
        futures: retireIds.length ? await getFutures(slug) : futures,
      });
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
        // Same as removeFuture: the delete may have cut children loose, and only
        // a read back says so.
        await deleteFuture(slug, Number(e.key));
        setData({ ...data, futures: await getFutures(slug) });
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

  // ---- checks (the Quality tab's test suite) ----
  // The scope travels as the same object the store sends: undefined = the whole
  // suite, {id} = one row, {feature} = one feature's worth. '' is a real feature
  // (ungrouped), so this can never collapse into a truthiness test.
  const runProjectChecks = (scope?: { id: number } | { feature: string }) =>
    guard(async () => {
      setChecksBusy(true);
      try {
        const updated = await runChecks(slug, scope);
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

  // Promote an idea (and everything in its orbit) into the existing
  // create-roadmap flow, prefilled; after the item lands, offer to keep or
  // delete the original idea AND its orbit (delete tombstones a hook idea so
  // the next push won't re-extract it). The note carries the idea's own words
  // first — untouched when there's no orbit — with the orbit appended as a
  // plain list, same '- title — note' shape the converge tray's epic draft
  // already uses.
  const promoteFuture = (f: Future, orbit: Future[]) => {
    setPendingFuture([f.id, ...orbit.map((o) => o.id)]);
    const note = orbit.length
      ? [f.note, `Orbiting this idea:\n${orbit.map((o) => `- ${o.title}${o.note ? ` — ${o.note}` : ''}`).join('\n')}`]
        .filter(Boolean).join('\n\n')
      : f.note;
    setRoadModal({ open: true, priority: 'should', title: f.title, note, fromNote: null, editing: null });
  };

  // #321 — the sidebar's "Open in Workbench": create the idea's card if it
  // doesn't have one yet (planWorkbenchOpen decides which), then navigate to
  // it. The Workbench tab fetches its own data on mount, so there's nothing
  // to refresh here.
  const openFutureInWorkbench = (futureId: number) =>
    guard(async () => {
      try {
        const wb = await getWorkbench(slug);
        const plan = planWorkbenchOpen(wb.cards, futureId);
        if (plan.action === 'create') await addWorkbenchCard(slug, { kind: 'polaris', futureId, x: plan.x, y: plan.y });
      } catch (e) {
        // A 409 from POST /cards means the partial unique index on future_id
        // refused a second card — another tab (or a lost race between two
        // clicks) already put this idea on the canvas. The user's intent is
        // still met, so only that case is swallowed.
        // HttpError, not #321's own ApiError: the two classes were the same
        // thing under two names, and store.ts keeps the older one.
        if (!(e instanceof HttpError && e.status === 409)) throw e;
      }
      go.detail(slug, 'workbench', `f${futureId}`);
    });

  // Promote a note into the existing create-bug / create-roadmap flow, prefilled.
  // The Workbench hands over the note id and the text it is currently showing —
  // it holds cards, not Note rows, and the text on the card IS the note's text.
  const promoteNote = (noteId: number, text: string, kind: 'bug' | 'roadmap') => {
    if (kind === 'bug') setBugModal({ open: true, title: text, fromNote: noteId });
    else setRoadModal({ open: true, priority: 'should', title: text, note: '', fromNote: noteId, editing: null });
  };

  // A plan card's phases → real roadmap items. THIS is the dispose half of the
  // Workbench's propose/dispose split: everything an op writes stays a card
  // until the human presses this, and then it goes through the ordinary roadmap
  // POST like anything else. The gate travels in the item's note, because a
  // phase without its gate is just a title.
  const promotePlan = async (phases: WorkbenchPhase[]): Promise<boolean> => {
    try {
      setActionError('');
      const road = { ...roadmap };
      for (const p of phases) {
        const item = await createRoadmapItem(slug, {
          title: p.t,
          note: [p.d, p.gate ? `Gate: ${p.gate}` : ''].filter(Boolean).join('\n\n'),
          bucket: p.bucket,
        });
        road[item.bucket] = [...road[item.bucket], item];
      }
      setData({ ...data, roadmap: road });
      return true;
    } catch (e) {
      setActionError((e as Error)?.message || 'Could not promote the plan.');
      return false;
    }
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

  // #379 — this tab's agent and whether its live session may open. Three
  // outcomes, and the strip is drawn for two of them: it may open, or it may
  // not and there is a reason worth printing. An agent the server reports with
  // NO console at all yields neither, and nothing is drawn — a sentence
  // explaining the absence of a feature that was never offered is noise.
  const tabAgent = TAB_AGENT[tab];
  const consoleCan = !!tabAgent && agentConsoleCan(data.agents, tabAgent.key);
  const consoleOff = tabAgent ? agentConsoleOffReason(data.agents, tabAgent.key) : '';
  // A brief on its way to THIS TAB'S console (the Roadmap's Arrange commands).
  // It is state here rather than inside the tab because the console is drawn
  // here: the strip is one component above every tab's content, and a tab
  // reaching into it any other way would be a second channel to the same
  // session. The counter is what makes the same brief pressed twice two
  // commands rather than a no-op re-render.
  const [consoleTask, setConsoleTask] = useState<{ text: string; id: number } | null>(null);
  const consoleTaskSeq = useRef(0);

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
            // #278 — Quality wears ONE number: what's actually wrong right now
            // (red checks + serious open bugs). Two badges gave two counts and
            // no sense of how bad it was.
            const n = t.key === 'quality' ? needsAttention
              : t.key === 'roadmap' ? openRoadCount : t.key === 'futures' ? unsortedFutures
                : t.key === 'workbench' ? notes.length : 0;
            return (
              <button key={t.key} className={`tab ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>
                {t.label}{n > 0 && <span className={`tab-n${t.key === 'quality' ? ' bad' : ''}`}>{n}</span>}
              </button>
            );
          })}
        </div>

        {/* #379 — THE TAB AGENT'S CONSOLE, and it is here rather than inside
            each tab on purpose: "the same position on every tab" is the whole
            proposition. A console the Roadmap drew above its board and Quality
            drew below its health band would be four consoles that happen to
            look alike, and the muscle memory — the strip under the tab bar is
            where this tab's agent lives — would never form.

            Four of the six tabs have one. Overview and Activity are readings of
            what happened, not surfaces with an agent working on them; the
            registry says which agents own a console and this only asks. */}
        {tabAgent && (consoleCan || consoleOff) && (
          <TabTerminal agentKey={tabAgent.key} agentName={tabAgent.name} slug={slug}
            off={consoleCan ? '' : consoleOff}
            task={consoleTask} onTaskSent={() => setConsoleTask(null)} />
        )}

        {tab === 'overview' && (
          <Overview project={project} phase={data.currentPhase} activity={activity} directives={data.directives}
            reviewQueue={reviewQueue} keepResumeCard={data.keepResumeCard}
            roadmap={roadmap} futures={futures} bugs={bugs}
            cadence={data.cadence} lastPushAt={data.lastPushAt}
            pulse={pulse} pulseError={pulseError}
            onViewAll={viewAll} onJumpBack={() => setTab('roadmap')}
            onChangeDirectives={changeDirectives}
            onReviewKeep={reviewKeep} onReviewDismiss={reviewDismiss} onSaveDeploy={saveDeploy}
            onSaveStack={saveStack} />
        )}
        {tab === 'quality' && (
          <Quality slug={slug} checks={data.checks} bugs={bugs} siteUrl={project.siteUrl}
            geminiReady={data.geminiReady} highlightId={highlightId}
            checksBusy={checksBusy} onRunChecks={runProjectChecks}
            onAddCheck={addCheck} onEditCheck={editCheck} onDeleteCheck={removeCheck}
            onFileBug={fileBug} onSetBugStatus={setBugStatus} onDeleteBug={(b) => setConfirmBugDelete(b)}
            onOpenCommit={openBugLink} />
        )}
        {/* #361 — the ✧ surfaces on the Roadmap and Polaris tabs belong to the
            CURATOR and to POLARIS, and an absent callback is how each one goes
            away when its agent (or that one op) is switched off: the button is
            not rendered at all, rather than rendered to fail. Quality has no ✧
            of its own any more: the Auditor's whole surface there is the tab's
            live session, which carries its own switch. */}
        {tab === 'roadmap' && (
          // RoadmapTab owns the view switch and every board under it. `legacy`
          // is the bag of callbacks that have to live up here because they open
          // modals, navigate, or write through a path this screen owns.
          <RoadmapTab slug={slug} roadmap={roadmap} weekZero={project.weekZero} agents={data.agents}
            onItemChanged={replaceRoadItem} onItemsChanged={replaceRoadItems} onItemAdded={addRoadItem}
            onOpenItem={(it) => setRoadModal({ open: true, priority: it.bucket, title: it.title, note: it.note, fromNote: null, editing: it })}
            legacy={{
              highlightId, liveBranches: data.liveBranches,
              staleItemDays: data.staleItemDays,
              onAdd: (p, area) => roadDraft
                ? openRoadDraft(roadDraft)
                : setRoadModal({ open: true, priority: p, title: '', note: '', area, fromNote: null, editing: null }),
              draft: roadDraft,
              onResumeDraft: () => roadDraft && openRoadDraft(roadDraft),
              onDiscardDraft: () => updateRoadDraft(null),
              onToggle: toggleRoad,
              onEdit: (it) => setRoadModal({ open: true, priority: it.bucket, title: it.title, note: it.note, fromNote: null, editing: it }),
              onDelete: (it) => setConfirmRoadDelete(it),
              onClearNote: clearRoadNote,
              onToggleSkip: toggleSkipRoad,
              onReorder: reorderRoad,
              onCleanup: agentCan(data.agents, 'curator', 'cleanup') ? openCleanup : undefined,
              onSendToTerminal: (brief: string) => {
                // One-shot handoff — the terminal screen offers it as a paste.
                try { sessionStorage.setItem('stack.term.brief', brief); } catch { /* private mode — the button just won't appear */ }
                go.terminal(slug);
              },
              onSetTier: setTierRoad,
              onBranch: (it: RoadmapItem) => branchItem(it),
              // The Arrange panel's quick commands. Undefined when the console
              // cannot open, so the buttons go dead with a reason rather than
              // failing on the press.
              onSendToConsole: consoleCan
                ? (brief: string) => {
                  consoleTaskSeq.current += 1;
                  setConsoleTask({ text: brief, id: consoleTaskSeq.current });
                }
                : undefined,
              consoleOffReason: consoleOff,
            }} />
        )}
        {tab === 'futures' && (
          <Futures northStar={data.northStar} futures={futures} highlightId={highlightId} slug={slug}
            onSaveNorthStar={saveNorthStar} onAdd={addFuture} onEdit={editFuture} onAlign={alignFuture}
            onAskPolaris={agentCan(data.agents, 'polaris', 'judge') ? (id) => judgeFuture(slug, id) : undefined}
            onCluster={agentCan(data.agents, 'polaris', 'cluster') ? () => clusterFutures(slug) : undefined}
            onSetAreas={applyFutureAreas}
            onConvergeDraft={agentCan(data.agents, 'polaris', 'converge')
              ? (ids, mode) => convergeFutures(slug, ids, mode) : undefined}
            onConvergeCreate={convergeCreate}
            onShape={shapeFuture} onAdoptOrbit={adoptOrbit}
            onDelete={removeFuture} onPromote={promoteFuture}
            geminiReady={data.geminiReady}
            onProposeOrbits={() => proposeOrbits(slug)}
            onRestate={(id) => restateFuture(slug, id)}
            onOpenInWorkbench={openFutureInWorkbench} />
        )}
        {tab === 'workbench' && (
          <Workbench slug={slug} geminiReady={data.geminiReady} highlightId={highlightId}
            notesNonce={notesNonce} onPromoteNote={promoteNote} onPromotePlan={promotePlan} />
        )}
        {tab === 'activity' && (
          <Activity activity={activity} highlightRef={highlightRef} linkedBugId={linkedBugId} onClear={() => setHighlightRef(null)} />
        )}

        {/* Deleting a project lives in Settings → Projects now. A destructive,
            once-a-year action does not belong at the foot of the screen you
            scroll past every day. */}
      </div>

      {bugModal.open && (
        <BugModal initialTitle={bugModal.title}
          onClose={() => setBugModal({ open: false, title: '', fromNote: null })} onSubmit={addBug} />
      )}
      {roadModal.open && (
        <RoadmapModal initialPriority={roadModal.priority} initialTitle={roadModal.title}
          initialNote={roadModal.note} initialBranch={roadModal.editing?.claimedBy ?? roadModal.branch ?? ''}
          initialArea={roadModal.editing?.area ?? roadModal.area ?? ''}
          initialPlan={roadModal.editing?.plan ?? []}
          initialRisk={roadModal.editing?.risk ?? 'normal'}
          initialRiskSource={roadModal.editing?.riskSource ?? ''}
          initialRiskReason={roadModal.editing?.riskReason ?? ''}
          initialTier={roadModal.editing?.tier ?? ''}
          branches={[...new Set(allRoadmap.map((i) => i.claimedBy))].filter(Boolean).sort()}
          areas={[...new Set([...allRoadmap.map((i) => i.area), ...futures.map((f) => f.area)])].filter(Boolean).sort()}
          mode={roadModal.editing ? 'edit' : 'add'}
          onClose={() => { setRoadModal(roadModalClosed); setPendingFuture(null); }}
          onDismiss={(d) => updateRoadDraft(d)}
          onAssist={agentCan(data.agents, 'curator', 'assist') ? (note) => assistRoadmapItem(slug, note) : undefined}
          onSubmit={submitRoad} />
      )}
      {(cleanup !== null || cleanupErr) && (
        <Modal onClose={closeCleanup} wide>
          <h3>✧ Board clean-up</h3>
          {cleanupErr ? (
            <div className="gemini-suggest err">✧ {cleanupErr}</div>
          ) : cleanup === 'loading' ? (
            <div className="confirm-body">The Curator is reading the open board…</div>
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
          // #381 — a fly card names who would otherwise re-create it. Same
          // tombstone as a hook card, different thing doing the re-creating,
          // and naming it is what makes the sentence true rather than generic.
          body={<>Delete <b>{confirmRoadDelete.title}</b>{
            confirmRoadDelete.source === 'hook'
              ? ' — it was auto-extracted, so it won’t be re-created by the next push.'
              : confirmRoadDelete.source === 'fly'
                ? ` — it was opened by ${confirmRoadDelete.flySession || 'a live session'}, which won’t re-create it.`
                : '.'}</>}
          confirmLabel="Delete item" cancelLabel="Cancel" danger
          onConfirm={() => { const it = confirmRoadDelete; setConfirmRoadDelete(null); removeRoad(it); }}
          onCancel={() => setConfirmRoadDelete(null)} />
      )}
      {promotedFuture != null && (() => {
        const orbitCount = promotedFuture.length - 1;
        return (
          <ConfirmModal
            title="Promoted to a roadmap item"
            body={orbitCount > 0
              ? <>Keep the idea and the {orbitCount} that orbit it in Futures, or delete all {promotedFuture.length} now that they're on the roadmap?</>
              : "Keep the original idea in Futures, or delete it now that it's on the roadmap?"}
            confirmLabel={orbitCount > 0 ? `Delete ${promotedFuture.length} ideas` : 'Delete idea'}
            cancelLabel={orbitCount > 0 ? 'Keep ideas' : 'Keep idea'} danger
            onConfirm={() => { const ids = promotedFuture; setPromotedFuture(null); removeFutures(ids); }}
            onCancel={() => setPromotedFuture(null)} />
        );
      })()}
      {promotedNote && (
        <ConfirmModal
          title={promotedNote.kind === 'bug' ? 'Promoted to a bug' : 'Promoted to a roadmap item'}
          body="Keep the original note, or delete it now that it's tracked elsewhere?"
          confirmLabel="Delete note" cancelLabel="Keep note" danger
          onConfirm={deletePromotedNote} onCancel={keepPromotedNote} />
      )}
    </div>
  );
}
