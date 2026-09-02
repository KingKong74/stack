import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Roadmap as RoadmapData, RoadmapItem, Severity, Priority, Bug, BugStatus, ProjectPulse } from '../types';
import {
  getProjectDetail, getProjectPulse, type ProjectDetailData,
  createBug, patchBug, deleteBug, createRoadmapItem, patchRoadmapItem, deleteRoadmapItem,
  createCheck, patchCheck, deleteCheck, runChecks, type CheckInput,
  patchProject, createShareLink, deleteShareLink,
  getRoadDraft, setRoadDraft, type RoadDraft, assistRoadmapItem,
  agentCan, setLastViewedProject, onItemFiled,
  getProjects,
} from '../store';
import type { Project } from '../types';
import { go, hrefTo } from '../lib/route';
import { TopBar } from '../components/TopBar';
import { ConsoleNav, NavIcons, SpaceDot, type NavSection } from '../detail/ConsoleNav';
import { absoluteHref, type MenuOption } from '../components/MoreMenu';
import { Overview, type ReviewEntry, type DeployPatch } from '../detail/Overview';
import { Quality } from '../detail/Quality';
import { RoadmapTab } from '../detail/RoadmapTab';
import { Activity } from '../detail/Activity';
import { AutoIdeas } from '../detail/AutoIdeas';
import { TabStrip } from '../components/TabStrip';
import { timeAgo } from '../lib/ui';
import { Modal } from '../components/Modal';
import { BugModal } from '../components/BugModal';
import { RoadmapModal, type RoadmapFields } from '../components/RoadmapModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { useAutoRefresh } from '../lib/autoRefresh';
import { newItemSched } from '../lib/plan';

// #278 — Bugs and Audit are one tab now: Quality. They were halves of one loop
// (run → see red → file → fix → re-run) and it crossed a tab boundary twice.
//
// FOR YOU IS THREE OF THESE KEYS, NOT ONE. `overview`, `activity` and `auto`
// are the kit's three For-you tabs (ForYouScreen.jsx), and each keeps its own
// ROUTE key rather than becoming component state: `#/p/x/activity` is in
// bookmarks and in every older search payload, `hl` on it means a commit hash,
// and Quality's "open the commit that caught this" link targets it. An inner
// strip that swallowed the key would have broken all three at once.
type Tab = 'overview' | 'quality' | 'roadmap' | 'activity' | 'auto';
/** The keys that land on the For-you screen, in strip order. */
const FORYOU_TABS: Tab[] = ['overview', 'activity', 'auto'];
const isForYou = (t: Tab) => FORYOU_TABS.includes(t);
// The four readings of a project. `navSections` below is the ONE list of them
// — #432 moved them from a horizontal strip into the console's left rail, and
// a second copy anywhere is how the two would drift.
const STATUS_LABEL = { live: 'Live', building: 'Building', paused: 'Paused', archived: 'Archived' } as const;

const TAB_KEYS = new Set<Tab>(['overview', 'quality', 'roadmap', 'activity', 'auto']);
// 'bugs' and 'audit' both land on Quality — old deep links (bookmarks, a search
// payload from an older server, a ⌘K target) keep working. 'tips' still
// resolves too: the recipe library was a tab, then the bottom-left dock, and
// is now neither — the corner holds the quick ＋ instead — so an old link lands
// on Overview rather than 404ing. 'futures' and 'notes' join them now that
// Polaris and the Workbench are culled — both tabs are gone, but
// `#/p/<slug>/futures` and `#/p/<slug>/notes` are in bookmarks and in every
// older search payload, and landing them on Overview is the same courtesy the
// three above already get. `hl` on such a link names a row that no longer has
// a tab to be highlighted on; Overview ignores an `hl` it does not recognise,
// which is the right nothing to do.
const LEGACY_TABS: Record<string, Tab> = {
  bugs: 'quality', audit: 'quality', tips: 'overview', notes: 'overview', futures: 'overview',
};
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
      <TopBar crumb={[{ label: 'Projects', onClick: go.dashboard }]} />
      <div className="con-main"><div className="con-inner">{children}</div></div>
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

  // SPACES (#432) — the rail lists the other apps, so switching project no
  // longer means a trip back to the dashboard. Its own trip, and a failure is
  // simply an empty section: a rail that cannot list the other projects is
  // still a working rail, and blocking the screen on it would be absurd.
  const [spaces, setSpaces] = useState<Project[]>([]);
  useEffect(() => {
    let live = true;
    getProjects().then((ps) => { if (live) setSpaces(ps); }).catch(() => { /* rail degrades to this project */ });
    return () => { live = false; };
  }, []);

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
  const [bugModal, setBugModal] = useState<{ open: boolean; title: string }>({ open: false, title: '' });
  const [roadModal, setRoadModal] = useState<{
    open: boolean; priority: Priority; title: string; note: string;
    editing: RoadmapItem | null; branch?: string; area?: string; fromDraft?: boolean;
  }>({ open: false, priority: 'should', title: '', note: '', editing: null });
  const roadModalClosed = { open: false, priority: 'should' as Priority, title: '', note: '', editing: null };
  // Device-local draft: a half-typed add-modal dismissed by a stray click.
  const [roadDraft, setRoadDraftState] = useState<RoadDraft | null>(() => getRoadDraft(slug));
  useEffect(() => { setRoadDraftState(getRoadDraft(slug)); }, [slug]);
  const updateRoadDraft = (d: RoadDraft | null) => { setRoadDraft(slug, d); setRoadDraftState(d); };
  const openRoadDraft = (d: RoadDraft) => setRoadModal({
    open: true, priority: d.priority, title: d.title, note: d.note, branch: d.branch, area: d.area,
    editing: null, fromDraft: true,
  });
  const [confirmRoadDelete, setConfirmRoadDelete] = useState<RoadmapItem | null>(null);
  const [confirmBugDelete, setConfirmBugDelete] = useState<Bug | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  // The Curator's board clean-up: null = closed, 'loading', or the suggestion list.
  // The corner ＋ writes through store.ts, not through this screen, so an item
  // filed into the project already on screen would otherwise be saved and
  // invisible. Re-read the payload (no loading flash — the page is already
  // drawn).
  const reread = useCallback(() => {
    getProjectDetail(slug)
      .then((d) => { setData(d); })
      .catch(() => { /* the write succeeded; a stale read is not worth an error banner */ });
  }, [slug]);
  useEffect(() => onItemFiled((filedSlug) => {
    if (filedSlug === slug) reread();
  }), [slug, reread]);

  // #314 — the ids a promotion actually carried through: the idea plus its
  // orbit (planets/moons), never just the one that was clicked. Keep-or-delete
  // has to cover the whole set, or a deleted star leaves its planets pointing
  // at a row that no longer exists (the server only cuts them loose when a
  // star is UN-starred, not when it's deleted).
  const [checksBusy, setChecksBusy] = useState(false);
  const [editingUrl, setEditingUrl] = useState<'site' | 'repo' | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [actionError, setActionError] = useState('');

  // #409 — an AGENT's edits have no event to fire. The Curator rewrites a title
  // on the host, the Foreman re-tags a change, a night lands a `built_note`, and
  // this screen went on drawing whatever it fetched when it mounted, so the only
  // way to see any of it was a manual reload. One re-read fixes it for EVERY tab
  // rather than only the Roadmap, because `data` is the single payload all of
  // them render from — which is also why this must not be done per-tab.
  //
  // Through `useAutoRefresh` (#312), never a bare setInterval: the device-local
  // Auto refresh setting governs the cadence and a hidden tab stops polling.
  //
  // GATED ON THE OWNER'S OWN HANDS. Replacing `data` under a drag makes the bar
  // you are holding jump, and under an open modal it can swap the very row being
  // edited — a background read is worth nothing if it fights the foreground. So
  // it waits on a pointer that is currently DOWN, which covers every drag
  // surface at once (timeline bars, calendar grips, the board's reorder, the
  // canvas) without threading a flag up through four components, plus any modal
  // or confirm this screen owns. Every one of those is brief and the next tick
  // is seconds behind it, so nothing is lost by waiting — whereas a refresh that
  // lands mid-gesture is a bug the owner sees.
  //
  // Note this deliberately does NOT gate on `checksBusy` or the Curator's own
  // in-flight reads: those are the screen waiting on the server, not the owner
  // holding something, and a refresh during one is exactly what should happen.
  const [pointerDown, setPointerDown] = useState(false);
  useEffect(() => {
    const down = () => setPointerDown(true);
    const up = () => setPointerDown(false);
    window.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    // A pointer released outside the window never fires pointerup on it, and a
    // stuck `true` here would silently stop the screen refreshing for good.
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
    };
  }, []);
  const interacting = pointerDown
    || bugModal.open || roadModal.open || shareOpen || editingUrl !== null
    || confirmRoadDelete !== null || confirmBugDelete !== null;
  useAutoRefresh(reread, !interacting);

  const bugs = data.bugs;
  const roadmap = data.roadmap;

  const allRoadmap = [...roadmap.must, ...roadmap.should, ...roadmap.could, ...roadmap.wont];
  // The project-scoped review queue: items nobody typed, that no human has
  // signed off. A bug can only be 'hook'; a roadmap item is also 'fly' (#381 —
  // opened by a live session), held on the same footing, so it has to queue in
  // the same place. Held and invisible is unapprovable.
  const reviewQueue: ReviewEntry[] = [
    ...bugs.filter((b) => b.source === 'hook' && !b.reviewed)
      .map((b) => ({
        kind: 'bug' as const, key: b.id, title: b.title, meta: `${b.severity} severity`,
        origin: 'hook', when: b.meta,
      })),
    ...allRoadmap.filter((r) => (r.source === 'hook' || r.source === 'fly') && !r.reviewed)
      .map((r) => ({
        kind: 'roadmap' as const, key: String(r.id), title: r.title,
        meta: [r.bucket, r.area].filter(Boolean).join(' · '),
        note: r.note, origin: r.source, when: timeAgo(r.updatedAt),
      })),
  ];

  const openRoadCount = allRoadmap.filter((r) => !r.done).length;
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
      setData({ ...data, bugs: [bug, ...bugs] });
      setBugModal({ open: false, title: '' });
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
  const submitRoad = ({ title, note, priority, branch, area, subArea, plan, risk, tier, riskChanged }: RoadmapFields) =>
    guard(async () => {
      const editing = roadModal.editing;
      if (editing) {
        const updated = await patchRoadmapItem(slug, editing.id, {
          title, note, bucket: priority, claimed_by: branch, area, subArea, plan,
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
      // #425 — an item somebody adds by hand lands ON the timeline, so deciding
      // to do something puts it on the plan rather than in the tray.
      const item = await createRoadmapItem(slug, { title, note, bucket: priority, claimed_by: branch || undefined, area: area || undefined, subArea: subArea || undefined, plan: plan.length ? plan : undefined, risk: risk !== 'normal' ? risk : undefined, tier: tier || undefined, sched: newItemSched(project.weekZero) });
      if (roadModal.fromDraft) updateRoadDraft(null); // the draft landed — clear it
      setData({ ...data, roadmap: { ...roadmap, [priority]: [...roadmap[priority], item] } });
      setRoadModal(roadModalClosed);
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

  const openBugLink = (hash: string) => { setHighlightRef(hash); setTab('activity'); };
  const viewAll = () => { setHighlightRef(null); setTab('activity'); };
  // EVERY RAIL ROW IS A PLACE, so its ⋯ offers the two things you do with a
  // place rather than a menu invented per row: open it somewhere else, or hand
  // someone the link. THE COPY'S OWN LABEL IS ITS RECEIPT — this app has no
  // toast, and a copy that reports nothing is a copy you press twice — so that
  // item keeps the menu open long enough to say what happened, including when
  // the browser refuses the clipboard, which it does on an insecure origin.
  const [copiedRow, setCopiedRow] = useState('');
  useEffect(() => {
    if (!copiedRow) return;
    const t = setTimeout(() => setCopiedRow(''), 1800);
    return () => clearTimeout(t);
  }, [copiedRow]);
  const placeMenu = (href: string, id: string): MenuOption[] => [
    {
      key: 'newtab', label: 'Open in new tab', title: 'Open this in a second browser tab',
      onSelect: () => window.open(absoluteHref(href), '_blank', 'noopener'),
    },
    {
      key: 'copy', keepOpen: true, title: 'Copy a link that lands straight here',
      label: copiedRow === id ? 'Link copied' : copiedRow === `${id}:no` ? "Couldn't copy" : 'Copy link',
      onSelect: () => {
        navigator.clipboard.writeText(absoluteHref(href))
          .then(() => setCopiedRow(id))
          .catch(() => setCopiedRow(`${id}:no`));
      },
    },
  ];
  // THE RAIL'S CONTENTS (#432). Three sections: an unlabelled top block that is
  // where you LAND and what is yours, Workspace as the readings of THIS
  // project, and Spaces as every other app.
  //
  // THE BOARD'S ROW IS THE PROJECT'S NAME, not "Roadmap" — the board is the
  // project's own surface, so it wears the project's name and its tint dot,
  // the same identity Spaces gives every other app. `Roadmap` is a DIFFERENT
  // thing now and takes the name back as a coming-soon row beside it; the tab
  // KEY stays 'roadmap', so every deep link, legacy spelling and `hl` target
  // keeps resolving exactly as before — this is a label change, not a route.
  //
  // A `soon` row is announced and inert (ConsoleNav's header says why). It has
  // no tab key, so nothing about `asTab` or the route needs to know it exists.
  //
  // The counts are the ones the strip already wore: Quality carries what is
  // actually WRONG (red checks + serious open bugs) in the critical tone, and
  // the board carries how much is open, which is volume and not alarm.
  const navSections: NavSection[] = [
    {
      id: 'home',
      items: [
        // FOR YOU IS THE OVERVIEW, one row rather than two. The kit's own shape
        // says so: its rail has no Overview row at all — Overview is the first
        // TAB inside For you, because "what is waiting on me" and "how is this
        // project" are one question asked on open, and two rows made you pick
        // which half to read first. Its KEY is still `overview`, so every deep
        // link, legacy spelling and `hl` target resolves as before.
        {
          key: 'overview', label: 'For you', icon: NavIcons.inbox,
          menu: placeMenu(hrefTo.detail(slug, 'overview'), 'overview'), onClick: () => setTab('overview'),
        },
        { key: 'soon:starred', label: 'Starred', icon: NavIcons.star, soon: true },
      ],
    },
    {
      id: 'workspace',
      label: 'Workspace',
      items: [
        {
          key: 'roadmap', label: project.name, icon: NavIcons.board, count: openRoadCount,
          menuLabel: `${project.name} board`,
          menu: placeMenu(hrefTo.detail(slug, 'roadmap'), 'board'), onClick: () => setTab('roadmap'),
        },
        { key: 'soon:roadmap', label: 'Roadmap', icon: NavIcons.map, soon: true },
        { key: 'soon:plans', label: 'Plans', icon: NavIcons.route, soon: true },
        {
          key: 'quality', label: 'Quality', icon: NavIcons.check, count: needsAttention, bad: true,
          menu: placeMenu(hrefTo.detail(slug, 'quality'), 'quality'), onClick: () => setTab('quality'),
        },
      ],
    },
    {
      id: 'spaces',
      label: 'Spaces',
      items: spaces.map((sp) => ({
        key: `space:${sp.id}`,
        label: sp.name,
        icon: <SpaceDot tint={sp.tint} />,
        depth: 1,
        menuLabel: `${sp.name} space`,
        menu: placeMenu(hrefTo.detail(sp.id), `space:${sp.id}`),
        // The project you are already in is the rail's other selected row, so
        // `active` cannot be the tab key alone.
        href: hrefTo.detail(sp.id),
      })),
    },
  ];

  const open = (url: string) => { if (url) window.open(url, '_blank', 'noopener'); };

  return (
    <div>
      <TopBar
        crumb={[{ label: 'Projects', onClick: go.dashboard }, { label: project.name }]}
        onSearch={onOpenSearch}
        actions={
          <>
            <button className="btn-repo" onClick={go.control} title="Mission Control — every project's automation">Mission Control</button>
            <a className="btn-repo" href={hrefTo.terminal(slug)} title={`Open a terminal in ~/${slug}`} aria-label="Terminal">⌨</a>
          </>
        } />

      <div className="con-shell">
        {/* THE RAIL'S SELECTION IS THE SCREEN, NOT THE ROUTE KEY. Activity and
            Auto-ideas are For-you tabs, so all three light the same row —
            otherwise pressing a strip tab silently deselects the rail. */}
        <ConsoleNav active={isForYou(tab) ? 'overview' : tab} sections={navSections} footer={
          <a className="con-navitem" href={hrefTo.terminal(slug)}>
            <span className="con-navico">{NavIcons.terminal}</span>
            <span className="con-navlabel">Terminal</span>
          </a>
        } />

      <main className="con-main"><div className={`con-inner${tab === 'roadmap' ? ' wide' : ''}`}>
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


        {/* THE TAB AGENTS' CONSOLES ARE CULLED, and the strip that sat here —
            in the same position on every tab, which was the whole proposition —
            went with them. What it held was a live Claude session in this
            project's checkout, spawned as the tab's agent and reachable from
            the Terminal screen like any other. The Terminal screen is what is
            left: `⌨` in the topbar and the rail's footer open one in this
            project's directory, unprimed and belonging to nobody. */}

        {/* FOR YOU — the kit's ForYouScreen: one strip, three panes. The strip
            writes the ROUTE key (see the Tab union), so a deep link into any of
            the three still lands where it always did and every `hl` keeps its
            meaning. Auto-ideas wears its count because that count is the whole
            reason to press it; Overview and Activity carry none. */}
        {isForYou(tab) && (
          <TabStrip<Tab>
            tabs={[
              { key: 'overview', label: 'Overview' },
              { key: 'activity', label: 'Activity' },
              { key: 'auto', label: 'Auto-ideas', count: reviewQueue.length },
            ]}
            active={tab} onPick={setTab} />
        )}

        {tab === 'overview' && (
          <Overview project={project} phase={data.currentPhase} activity={activity} directives={data.directives}
            reviewQueue={reviewQueue} keepResumeCard={data.keepResumeCard}
            roadmap={roadmap} bugs={bugs}
            northStar={data.northStar} onSaveNorthStar={saveNorthStar}
            cadence={data.cadence} lastPushAt={data.lastPushAt}
            pulse={pulse} pulseError={pulseError}
            onViewAll={viewAll} onJumpBack={() => setTab('roadmap')}
            onChangeDirectives={changeDirectives}
            onOpenAutoIdeas={() => setTab('auto')} onSaveDeploy={saveDeploy}
            onSaveStack={saveStack} />
        )}
        {tab === 'auto' && (
          <AutoIdeas queue={reviewQueue} onKeep={reviewKeep} onDismiss={reviewDismiss} />
        )}
        {tab === 'quality' && (
          <Quality slug={slug} checks={data.checks} bugs={bugs} siteUrl={project.siteUrl}
            geminiReady={data.geminiReady} highlightId={highlightId}
            checksBusy={checksBusy} onRunChecks={runProjectChecks}
            onAddCheck={addCheck} onEditCheck={editCheck} onDeleteCheck={removeCheck}
            onFileBug={fileBug} onSetBugStatus={setBugStatus} onDeleteBug={(b) => setConfirmBugDelete(b)}
            onOpenCommit={openBugLink} />
        )}
        {/* #361 — the ✧ surfaces on the Roadmap tab belong to the CURATOR, and
            an absent callback is how each one goes away when the agent (or that
            one op) is switched off: the button is not rendered at all, rather
            than rendered to fail. Quality has no ✧ and no agent of its own —
            the Auditor was its live session and went when the consoles did. */}
        {tab === 'roadmap' && (
          // RoadmapTab owns the board and the furniture around it. `legacy` is
          // the bag of callbacks that have to live up here because they open
          // modals, navigate, or write through a path this screen owns.
          <RoadmapTab slug={slug} roadmap={roadmap}
            onItemChanged={replaceRoadItem} onItemsChanged={replaceRoadItems} onItemAdded={addRoadItem}
            onOpenItem={(it) => setRoadModal({ open: true, priority: it.bucket, title: it.title, note: it.note, editing: it })}
            legacy={{
              highlightId,
              draft: roadDraft,
              onResumeDraft: () => roadDraft && openRoadDraft(roadDraft),
              onDiscardDraft: () => updateRoadDraft(null),
              onDelete: (it) => setConfirmRoadDelete(it),
              onBranch: (it: RoadmapItem) => branchItem(it),
            }} />
        )}
        {tab === 'activity' && (
          <Activity activity={activity} highlightRef={highlightRef} linkedBugId={linkedBugId} onClear={() => setHighlightRef(null)} />
        )}

        {/* Deleting a project lives in Settings → Projects now. A destructive,
            once-a-year action does not belong at the foot of the screen you
            scroll past every day. */}
      </div></main>
      </div>

      {bugModal.open && (
        <BugModal initialTitle={bugModal.title}
          onClose={() => setBugModal({ open: false, title: '' })} onSubmit={addBug} />
      )}
      {roadModal.open && (
        <RoadmapModal initialPriority={roadModal.priority} initialTitle={roadModal.title}
          initialNote={roadModal.note} initialBranch={roadModal.editing?.claimedBy ?? roadModal.branch ?? ''}
          initialArea={roadModal.editing?.area ?? roadModal.area ?? ''}
          initialSubArea={roadModal.editing?.subArea ?? ''}
          initialPlan={roadModal.editing?.plan ?? []}
          initialRisk={roadModal.editing?.risk ?? 'normal'}
          initialRiskSource={roadModal.editing?.riskSource ?? ''}
          initialRiskReason={roadModal.editing?.riskReason ?? ''}
          initialTier={roadModal.editing?.tier ?? ''}
          branches={[...new Set(allRoadmap.map((i) => i.claimedBy))].filter(Boolean).sort()}
          areas={[...new Set(allRoadmap.map((i) => i.area))].filter(Boolean).sort()}
          subAreas={[...new Set(allRoadmap
            .filter((i) => i.area === (roadModal.editing?.area ?? roadModal.area ?? ''))
            .map((i) => i.subArea))].filter(Boolean).sort()}
          mode={roadModal.editing ? 'edit' : 'add'}
          onClose={() => setRoadModal(roadModalClosed)}
          onDismiss={(d) => updateRoadDraft(d)}
          onAssist={agentCan(data.agents, 'curator', 'assist') ? (note) => assistRoadmapItem(slug, note) : undefined}
          onSubmit={submitRoad} />
      )}
      {shareOpen && (
        <Modal onClose={() => setShareOpen(false)}>
          <h3>Public showcase</h3>
          <div className="confirm-body" style={{ marginBottom: 16 }}>
            Anyone with this link sees a read-only view — name, progress, summary and recent
            activity. No bugs, roadmap or checks, and no API token needed.
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
    </div>
  );
}
