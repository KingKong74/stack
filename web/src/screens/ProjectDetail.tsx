import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { RoadmapItem } from '../types';
import {
  getProjectDetail, type ProjectDetailData,
  createRoadmapItem, patchRoadmapItem,
  patchProject, createShareLink, deleteShareLink,
  assistRoadmapItem,
  agentCan, setLastViewedProject, onItemFiled,
  getProjects,
} from '../store';
import type { Project } from '../types';
import { go, hrefTo } from '../lib/route';
import { TopBar } from '../components/TopBar';
import { ConsoleNav, NavIcons, SpaceDot, type NavSection } from '../detail/ConsoleNav';
import { absoluteHref, type MenuOption } from '../components/MoreMenu';
import { QualityMock, QUALITY_ATTENTION } from '../detail/QualityMock';
import { ForYouMock, AUTO_IDEA_COUNT } from '../detail/ForYouMock';
import { PlansMock } from '../detail/PlansMock';
import { Board } from '../detail/Board';
import { IdeasMock } from '../detail/IdeasMock';
import { TabStrip } from '../components/TabStrip';
import { Modal } from '../components/Modal';
import { RoadmapModal, type RoadmapFields } from '../components/RoadmapModal';
import { useAutoRefresh } from '../lib/autoRefresh';
import { newItemSched, flatRoadmap } from '../lib/plan';
import { PRIORITY_DEFAULT } from '../lib/ui';

// #278 — Bugs and Audit are one tab now: Quality. They were halves of one loop
// (run → see red → file → fix → re-run) and it crossed a tab boundary twice.
//
// FOR YOU IS THREE OF THESE KEYS, NOT ONE. `overview`, `activity` and `auto`
// are the kit's three For-you tabs (ForYouScreen.jsx), and each keeps its own
// ROUTE key rather than becoming component state: `#/p/x/activity` is in
// bookmarks and in every older search payload, `hl` on it means a commit hash,
// and Quality's "open the commit that caught this" link targets it. An inner
// strip that swallowed the key would have broken all three at once.
type Tab = 'overview' | 'quality' | 'roadmap' | 'activity' | 'auto' | 'ideas' | 'plans';
/** The keys that land on the For-you screen, in strip order. */
const FORYOU_TABS: Tab[] = ['overview', 'activity', 'auto'];
const isForYou = (t: Tab) => FORYOU_TABS.includes(t);
/** The two tabs that bring their OWN heading block — the console kit's screens
 *  open with a breadcrumb and their own title, so this screen's `detail-head`
 *  would stack a second one above them. The board is wired now (#443's mockup
 *  is Board.tsx) and still draws its own head, so it stays on this list: what
 *  the list means is "brings a heading", never "is a mockup". */
const isMockTab = (t: Tab) => t === 'roadmap' || t === 'ideas';
// The four readings of a project. `navSections` below is the ONE list of them
// — #432 moved them from a horizontal strip into the console's left rail, and
// a second copy anywhere is how the two would drift.
const STATUS_LABEL = { live: 'Live', building: 'Building', paused: 'Paused', archived: 'Archived' } as const;

const TAB_KEYS = new Set<Tab>(['overview', 'quality', 'roadmap', 'activity', 'auto', 'ideas', 'plans']);
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
  // THE PULSE'S SECOND TRIP IS GONE with the Overview that read it. It was the
  // heaviest read on a project and the only tab that wanted it, so it had its
  // own fetch and carried its own failure. `GET /projects/:slug/pulse` and
  // `store.getProjectPulse` are both still there, still tested, and nothing in
  // the client calls either — ForYouMock's header says what that cost.

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
  return <Detail data={data} setData={setData}
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

function Detail({ data, setData, routeTab, routeHighlight, onOpenSearch }: {
  data: ProjectDetailData; setData: (d: ProjectDetailData) => void;
  routeTab?: string; routeHighlight?: string; onOpenSearch: () => void;
}) {
  const { project } = data;
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
  // ONE HIGHLIGHT CHANNEL NOW: a row id (a bug key, a roadmap id) that the tab
  // it lands on may recognise. The second channel was the ACTIVITY tab's commit
  // hash, and that tab is the kit's mockup — it draws the kit's commits, so a
  // real hash names a row it cannot show. The route still resolves and the
  // highlight is simply ignored, which is the board's `hl` situation exactly
  // and the right nothing to do (ForYouMock's header).
  const [highlightId, setHighlightId] = useState<string | null>(routeHighlight ?? null);

  // Keep tab + highlight in sync when the route changes while staying on the
  // same project (e.g. opening another of this project's items from the palette).
  useEffect(() => {
    setTab(asTab(routeTab));
    setHighlightId(routeHighlight ?? null);
  }, [routeTab, routeHighlight]);

  // NO TAB RENDERS A `data-hl` ANCHOR ANY MORE. Quality was the last one that
  // honoured a highlight (a bug key) and it is a mockup now, so this look-up
  // matches nothing on every screen and gives up quietly after ~600ms. It is
  // kept rather than deleted because the route still CARRIES `hl` — every deep
  // link, search payload and ⌘K target still lands correctly — and the #303
  // lesson below is the part a rewiring would otherwise have to relearn.
  //
  // The row highlight is a brief flag; clear it after a moment so it doesn't
  // linger.
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
  const [roadModal, setRoadModal] = useState<{
    open: boolean; title: string; note: string;
    editing: RoadmapItem | null; area?: string;
  }>({ open: false, title: '', note: '', editing: null });
  const roadModalClosed = { open: false, title: '', note: '', editing: null };
  // The half-typed-item DRAFT went with the board's first cull (#443) and did
  // not come back with the wiring. It was saved on a stray dismiss and offered
  // back by a strip on the Roadmap tab; with no strip to offer it, keeping one
  // would be storing something nobody can ever get back — so the modal no
  // longer saves one at all.
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
  // Note this deliberately does NOT gate on the screen's own in-flight reads:
  // those are the screen waiting on the server, not the owner holding
  // something, and a refresh during one is exactly what should happen.
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
  const interacting = pointerDown || roadModal.open || shareOpen || editingUrl !== null;
  useAutoRefresh(reread, !interacting);

  const roadmap = data.roadmap;

  // MEMOISED BECAUSE THE BOARD HOLDS IT. Board.tsx re-seeds its own rows
  // whenever this array's identity changes, so a fresh array on every render
  // would throw away an in-flight optimistic move on the next keystroke
  // anywhere on the screen. The ORDER matters too: `queueOrder` uses payload
  // order as its last sort key, and this is the payload's order.
  const allRoadmap = useMemo(() => flatRoadmap(roadmap), [roadmap]);
  // THE PROJECT-SCOPED REVIEW QUEUE IS GONE with the tab that drew it. It was
  // every 'hook' and 'fly' row no human had signed off — held from the
  // overnight runner by `lib/approval.ts` until someone kept one — and
  // Auto-ideas was the last screen anywhere that could keep or dismiss one.
  // Nothing filters for them now; the holding is unchanged and only the
  // browser's way out of it went (ForYouMock's header).

  // THE BOARD ROW CARRIES A REAL COUNT AGAIN, and ROADMAP still carries none.
  // The rule is unchanged — a row's number and the screen behind it must agree
  // or one of them is lying — and the board is wired, so its badge is the open
  // cards it actually draws. IdeasMock is still the kit's sample rows and can
  // show no honest number, so the honest badge there is none.
  //
  // QUALITY'S BADGE IS THE SAME RULE, ANSWERED THE OTHER WAY. It used to be red
  // checks plus serious open bugs (#278); its screen is a mockup now, so the
  // number comes FROM that mockup (`QUALITY_ATTENTION`) and the two agree. What
  // it no longer is, is true of this project: the rail can read 2 while the
  // real suite is entirely green, or entirely red.

  const guard = async (fn: () => Promise<void>) => {
    try { setActionError(''); await fn(); }
    catch (e) { setActionError((e as Error)?.message || 'Something went wrong.'); }
  };

  // ---- mutations (each persists, then patches the loaded data in place) ----
  //
  // FILING A BUG, MOVING ITS STATUS, DELETING ONE AND EVERY CHECK MUTATION went
  // with the Quality tab. `createBug`/`patchBug`/`deleteBug` and the four check
  // calls are still in store.ts and every route still answers — the corner ＋,
  // `./stack`, the hook extractor and the nightly all keep writing — but this
  // screen no longer holds a handle to any of them. The one worth naming is
  // `check_id` (#278): a bug filed straight off a red check carried the link
  // that made the loop legible from either side, and that was the only path
  // that ever set it.

  // Create, or save an edit, depending on how the modal was opened.
  //
  // #469 — the PATCH names only what the modal still edits. Priority, tier,
  // risk and the branch claim came off it, and a PATCH that omits a field
  // LEAVES IT ALONE, so an edit here can no longer blank a tier the queue
  // sorts on or release a claim somebody is working behind. That is the whole
  // of why removing the controls was safe: the write was already a partial one.
  const submitRoad = ({ title, note, area, subArea, plan }: RoadmapFields) =>
    guard(async () => {
      const editing = roadModal.editing;
      if (editing) {
        const updated = await patchRoadmapItem(slug, editing.id, { title, note, area, subArea, plan });
        // The bucket cannot change from here any more, but the row still moves
        // between the payload's lists when something else changes it, so the
        // splice stays keyed on the bucket the response came back with.
        const without = { ...roadmap, [editing.bucket]: roadmap[editing.bucket].filter((i) => i.id !== editing.id) };
        setData({ ...data, roadmap: { ...without, [updated.bucket]: [...without[updated.bucket], updated] } });
        setRoadModal(roadModalClosed);
        return;
      }
      // #425 — an item somebody adds by hand lands ON the timeline, so deciding
      // to do something puts it on the plan rather than in the tray. It is born
      // at the DEFAULT priority; the board's card picker is where that moves.
      const item = await createRoadmapItem(slug, {
        title, note, bucket: PRIORITY_DEFAULT,
        area: area || undefined, subArea: subArea || undefined,
        plan: plan.length ? plan : undefined,
        sched: newItemSched(project.weekZero),
      });
      setData({ ...data, roadmap: { ...roadmap, [PRIORITY_DEFAULT]: [...roadmap[PRIORITY_DEFAULT], item] } });
      setRoadModal(roadModalClosed);
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

  // QUALITY'S "OPEN THE COMMIT THAT CAUGHT THIS" IS GONE ENTIRELY — the link
  // that crossed to Activity went with the screen that drew it, and Activity is
  // the kit's feed either way. The open question it stood for (where should a
  // bug's commit point, now that neither end is real?) is on the roadmap, not
  // in this file.
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
          // THE BOARD'S BADGE IS REAL AGAIN. The rule it obeys is the one #444
          // and #450 stated from the other side — a row's number and the screen
          // behind it have to agree — and the board is wired now, so the number
          // is what it draws: open, un-archived cards. Roadmap keeps no badge,
          // because IdeasMock still cannot show one honestly.
          key: 'roadmap', label: project.name, icon: NavIcons.board,
          count: allRoadmap.filter((i) => !i.done && !i.archived).length,
          menuLabel: `${project.name} board`,
          menu: placeMenu(hrefTo.detail(slug, 'roadmap'), 'board'), onClick: () => setTab('roadmap'),
        },
        {
          key: 'ideas', label: 'Roadmap', icon: NavIcons.map,
          menu: placeMenu(hrefTo.detail(slug, 'ideas'), 'ideas'), onClick: () => setTab('ideas'),
        },
        {
          key: 'plans', label: 'Plans', icon: NavIcons.route,
          menu: placeMenu(hrefTo.detail(slug, 'plans'), 'plans'), onClick: () => setTab('plans'),
        },
        {
          key: 'quality', label: 'Quality', icon: NavIcons.check, count: QUALITY_ATTENTION, bad: true,
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
        {/* THE PROJECT HEADER STANDS DOWN ON THE TWO MOCK TABS. Each of them is
            a whole kit screen and carries its own heading block — the
            breadcrumb + "Stack" + KING tag on the board, the eyebrow +
            "Roadmap" on the other — so drawing this one above them would stack
            two titles on one screen and neither would read as the page's. The
            actions that live here (Visit site, Repo, Share) are on every other
            tab, which is where they were reached from anyway. */}
        {!isMockTab(tab) && <div className="detail-head">
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
        </div>}

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
              // THE COUNT IS THE MOCKUP'S OWN. A row's number and the screen
              // behind it must agree or one of them is lying, and the pane
              // behind this one draws the kit's four suggestions.
              { key: 'auto', label: 'Auto-ideas', count: AUTO_IDEA_COUNT },
            ]}
            active={tab} onPick={setTab} />
        )}

        {/* ALL THREE FOR-YOU PANES ARE THE KIT'S MOCKUP at the owner's request.
            It takes one prop, and that prop is the ROUTE KEY — the pane is not
            component state, so every deep link and legacy spelling lands where
            it always did. It reads nothing: no `pulse`, no queue, no callback,
            and its header lists what stopped being reachable when the real
            Overview, Activity and Auto-ideas went. */}
        {isForYou(tab) && <ForYouMock pane={tab as 'overview' | 'activity' | 'auto'} />}
        {/* QUALITY IS A MOCKUP TOO at the owner's request — the kit's own
            QualityScreen on the kit's own checks and bugs. It takes no props
            because it reads nothing: neither `checks` nor `bugs` is passed and
            no callback is wired, so running a check, filing a bug and reading
            the run ledger have no surface in any browser. QualityMock's header
            lists the whole of what that costs; it is the heaviest of the five
            culls because a check is this app's only automated regression net. */}
        {tab === 'quality' && <QualityMock />}
        {/* #361 — the ✧ surfaces on the Roadmap tab belong to the CURATOR, and
            an absent callback is how each one goes away when the agent (or that
            one op) is switched off: the button is not rendered at all, rather
            than rendered to fail. Quality has no ✧ and no agent of its own —
            the Auditor was its live session and went when the consoles did. */}
        {/* THE BOARD IS WIRED — the kit's BoardScreen on this project's own
            roadmap. It takes the flattened payload (memoised above, in payload
            order, which `queueOrder` depends on), a re-read, and the item
            modal, which is still the only writer of `tier` and of a human
            `risk_source`. Its two sibling tabs, Backlog and Development, are
            still mockups; Board.tsx's header lists the eight decisions the
            wiring made and the one thing no browser can still do — give a
            verdict. ROADMAP IS STILL A MOCKUP (IdeasMock) and reads nothing. */}
        {tab === 'roadmap' && (
          <Board slug={slug} projectName={project.name} items={allRoadmap}
            onRefresh={reread} highlightId={highlightId}
            onEdit={(it) => setRoadModal({ open: true, title: it.title, note: it.note, editing: it })} />
        )}
        {tab === 'ideas' && <IdeasMock />}
        {/* PLANS IS A MOCKUP TOO at the owner's request, and it was the LAST
            project tab that read anything — the kit's own PlansScreen, all six
            sub-views, on the kit's own rows. Its one prop is a navigation
            callback and not data: "See on board" moves to the board, which is
            itself a mockup with nothing to narrow, so the kit's area+subject
            filter cannot come across. PlansMock's header lists what the real
            Plans tab (#439) took with it — the stored schedule loses its only
            reader again, and `slipOf` and `isBuilt` lose their last callers in
            the client. */}
        {tab === 'plans' && <PlansMock onBoard={() => setTab('roadmap')} />}

        {/* Deleting a project lives in Settings → Projects now. A destructive,
            once-a-year action does not belong at the foot of the screen you
            scroll past every day. */}
      </div></main>
      </div>

      {roadModal.open && (
        <RoadmapModal initialTitle={roadModal.title}
          initialNote={roadModal.note}
          initialArea={roadModal.editing?.area ?? roadModal.area ?? ''}
          initialSubArea={roadModal.editing?.subArea ?? ''}
          initialPlan={roadModal.editing?.plan ?? []}
          areas={[...new Set(allRoadmap.map((i) => i.area))].filter(Boolean).sort()}
          subAreas={[...new Set(allRoadmap
            .filter((i) => i.area === (roadModal.editing?.area ?? roadModal.area ?? ''))
            .map((i) => i.subArea))].filter(Boolean).sort()}
          mode={roadModal.editing ? 'edit' : 'add'}
          onClose={() => setRoadModal(roadModalClosed)}
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
    </div>
  );
}
