import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getControl, patchProject, patchSettings, startAutopilot,
  patchAutopilotSchedule, deleteAutopilotSchedule,
  resumeAutopilotJob, hangupAutopilotJob, dismissAutopilotJob,
  labelTerminalSessions, queueMerge, AuthError,
  startPreview, getPreviews, stopPreview, extendPreview, type Preview,
  getControlRailOpen, setControlRailOpen, getControlRailHeight, setControlRailHeight,
  type ControlData, type ControlProject, type AutopilotJob, type AutopilotSchedule,
} from '../store';
import { SessionPlanModal } from '../components/SessionPlanModal';
import { NightsRoom, PlanRoom, BuildRoom } from './ControlRooms';
import { RolesRoom } from './ControlRoles';
import { ReviewRoom } from './ControlReview';
import { SessionLanes } from './ControlLanes';
import { FALLBACK_ADVISORS, FALLBACK_EXECUTORS, modelLabel } from '../lib/ui';
import { go, hrefTo } from '../lib/route';
import type { ProjectStatus } from '../types';

const STATUS_LABEL: Record<ProjectStatus, string> = {
  live: 'Live', building: 'Building', paused: 'Paused', archived: 'Archived',
};
const CAPS = [
  { minutes: 60, label: '1h' }, { minutes: 120, label: '2h' },
  { minutes: 180, label: '3h' }, { minutes: 360, label: '6h' },
];
const BUDGETS = [
  { tokens: 500_000, label: '500k' }, { tokens: 1_500_000, label: '1.5M' },
  { tokens: 5_000_000, label: '5M' }, { tokens: 0, label: '∞ Unlimited' },
];
// Items per night. 0 = UNLIMITED (#260) — the wall-clock cap and the token
// budget are then the only governors, exactly like a 0 token budget.
const NIGHT_ITEMS = [1, 2, 3, 5, 8, 0];
export const nightItemsLabel = (n: number) => (n === 0 ? '∞' : String(n));
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const OPEN_JOB = new Set(['queued', 'claimed', 'running']);

const fmtDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M tok` : n >= 1000 ? `${Math.round(n / 1000)}k tok` : `${n} tok`;

const sessionAge = (startedAt: number) => {
  const min = Math.max(0, Math.round((Date.now() - startedAt) / 60_000));
  return min < 1 ? 'just opened' : min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
};




// Mission Control — every project's automation from one point: the autopilot
// console (arm, session cap, token budget incl. unlimited, nightly time,
// items/night), manual Run-now per project, the scheduled-sessions calendar,
// and one row per project (automode, presence, claims, reviews, blockers).
// Rendered as a tab of the Settings screen (#/control deep-links to it).
// #269 — a metric's direction: the arrow, whether the movement is good, and a
// plain-language delta for the tooltip. A metric with no prior period reads as
// "from nothing" rather than as an infinite improvement.
function trend(now: number, prev: number, higherIsBetter: boolean) {
  const eps = 1e-9;
  if (Math.abs(now - prev) < eps) return { mark: '·', cls: 'flat', delta: 'unchanged from the week before' };
  const up = now > prev;
  const pct = prev > eps ? Math.round(((now - prev) / prev) * 100) : null;
  return {
    mark: up ? '▲' : '▼',
    cls: up === higherIsBetter ? 'good' : 'bad',
    delta: pct === null
      ? `${up ? 'up' : 'down'} from nothing the week before`
      : `${up ? 'up' : 'down'} ${Math.abs(pct)}% on the week before`,
  };
}

const pct1 = (n: number) => `${Math.round(n * 100)}%`;

const JOB_LABEL: Record<AutopilotJob['status'], string> = {
  queued: 'queued', claimed: 'starting', running: 'running', done: 'done', failed: 'failed',
  paused: 'hung up',
};

// #142 — a paused session in the strip: a resume job holding for the limit
// reset (queued + notBefore) or hung up by hand (status 'paused').
const isPausedSession = (j: AutopilotJob) =>
  j.kind === 'resume' && (j.status === 'paused' || j.status === 'queued');
const resumeWhen = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : `${DAY_LABELS[d.getDay()]} ${t}`;
};

export function ControlPanel() {
  const [data, setData] = useState<ControlData | null>(null);
  const [error, setError] = useState('');
  // #228 — the session planner: null = closed; row = editing; row: null = new.
  const [planner, setPlanner] = useState<{ row: AutopilotSchedule | null } | null>(null);
  const [labelBusy, setLabelBusy] = useState(false);
  // #154 — merge confirm: the branch the user has clicked ⇥ Merge on, or null.
  // mergeClean rides along from the branch report (#207) so the modal can warn
  // about a probe-known conflict before the job is queued.
  const [mergePending, setMergePending] = useState<{ slug: string; branch: string; itemId: string; itemTitle: string; mergeClean?: boolean | null } | null>(null);
  // #193 — a dirty branch may opt into the dispatcher's AI conflict resolution.
  const [mergeAiResolve, setMergeAiResolve] = useState(false);
  // (#208) Branch previews. Their own poll rather than a field on the control
  // payload: a preview changes state on the host's clock (queued → building →
  // live), so it needs to be watched while everything else sits still.
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [previewErr, setPreviewErr] = useState('');
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);
  const [stopPending, setStopPending] = useState<Preview | null>(null);
  const loadPreviews = () => {
    getPreviews().then(setPreviews).catch((e) => {
      // An older server without the routes must not make the whole room shout.
      if (!(e instanceof AuthError)) setPreviews([]);
    });
  };
  useEffect(() => {
    loadPreviews();
    // Poll faster while something is mid-flight — a docker build reports
    // progress, and a finished one should not sit reading "building".
    const t = setInterval(loadPreviews, 15_000);
    return () => clearInterval(t);
  }, []);
  const previewFor = (slug: string, branch: string) =>
    previews.find((v) => v.slug === slug && v.branch === branch
      && ['queued', 'starting', 'live', 'stopping'].includes(v.status)) || null;
  const openPreview = async (slug: string, branch: string, itemId: string | null) => {
    setPreviewBusy(`${slug}:${branch}`);
    setPreviewErr('');
    try {
      const pv = await startPreview(slug, branch, { itemId });
      setPreviews((cur) => [pv, ...cur.filter((v) => v.id !== pv.id)]);
    } catch (e) {
      if (!(e instanceof AuthError)) setPreviewErr((e as Error)?.message || 'Could not queue the preview.');
    } finally {
      setPreviewBusy(null);
    }
  };
  const confirmStopPreview = async () => {
    if (!stopPending) return;
    const pv = stopPending;
    setStopPending(null);
    try {
      const next = await stopPreview(pv.id);
      setPreviews((cur) => cur.map((v) => (v.id === next.id ? next : v)));
    } catch (e) {
      if (!(e instanceof AuthError)) setPreviewErr((e as Error)?.message || 'Could not stop the preview.');
    }
  };
  // (#208) Every preview still on the host, in the order it will matter to you:
  // live first, then the ones on their way. `stopped`/`failed` are history and
  // belong to the failure banner, not here.
  const MIRROR_ORDER = ['live', 'stopping', 'starting', 'queued'];
  const openMirrors = previews
    .filter((v) => MIRROR_ORDER.includes(v.status))
    .sort((a, b) => MIRROR_ORDER.indexOf(a.status) - MIRROR_ORDER.indexOf(b.status));
  // How long this URL has left. Expiry is a safety property here rather than
  // tidiness — the URL is public while it lives — so it is stated as a
  // countdown, not as a timestamp you would have to do arithmetic on.
  const mirrorLeft = (iso: string | null) => {
    if (!iso) return '';
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'expiring now';
    const mins = Math.round(ms / 60_000);
    if (mins < 60) return `${mins}m left`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m left`;
  };
  const [mirrorBusy, setMirrorBusy] = useState('');
  const extendMirror = async (pv: Preview) => {
    setMirrorBusy(pv.id);
    setPreviewErr('');
    try {
      const next = await extendPreview(pv.id, 1);
      setPreviews((cur) => cur.map((v) => (v.id === next.id ? next : v)));
    } catch (e) {
      if (!(e instanceof AuthError)) setPreviewErr((e as Error)?.message || 'Could not extend the preview.');
    } finally {
      setMirrorBusy('');
    }
  };
  // #177 — the usage card's per-session agent breakdown, collapsed by default.
  const [agentBreakdown, setAgentBreakdown] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  // 14a — the shell: Now / Nights / Plan / Build are rooms behind one pinned
  // live strip and a persistent rail; the autopilot config folds away.
  const [room, setRoom] = useState<'now' | 'nights' | 'plan' | 'build' | 'review' | 'roles'>('now');
  // #282 — how many changes are waiting on a verdict, for the room's badge.
  // The Review room owns the fetch and reports the count back up.
  const [reviewN, setReviewN] = useState(0);
  // The Build room's open gates, reported up the same way (the room owns the
  // per-project detail fetches the plan steps come from), plus the change the
  // room's verdict gate has asked the Review room to open on ("slug#id").
  const [buildN, setBuildN] = useState(0);
  const [reviewFocus, setReviewFocus] = useState('');
  const [cfgOpen, setCfgOpen] = useState(false);
  // The rail collapses to the 76px slim rail (design 1b). What survives the
  // collapse is budget pressure, spend and connection; the model breakdown,
  // the throughput table and NEXT UP are expand-only. Device-local.
  const [railOpen, setRailOpen] = useState(getControlRailOpen);
  const toggleRail = () => setRailOpen((v) => { setControlRailOpen(!v); return !v; });
  // #306 — the collapse must not change the rail's LENGTH. The slim rail was
  // built for a height it never got: it ends in a flex spacer meant to settle
  // the daemon dot at the bottom, which does nothing in a card sized by its own
  // content. It was waiting on a number. So the expanded
  // rail is measured while it is open (ResizeObserver, the same trick the
  // dashboard's SubNav uses on the topbar) and that height is handed to the
  // slim rail as a floor — the column keeps its length through the toggle and
  // the sections settle top and bottom instead of the whole rail shrinking to a
  // stub beside a full-height page. The measurement is remembered device-local
  // so a reload that STARTS collapsed still has one; with nothing measured ever,
  // the slim rail falls back to its natural height, which is the old behaviour.
  const railRef = useRef<HTMLDivElement | null>(null);
  const [railH, setRailH] = useState(getControlRailHeight);
  useEffect(() => {
    const el = railRef.current;
    if (!railOpen || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h > 0) setRailH((prev) => (Math.abs(prev - h) < 2 ? prev : (setControlRailHeight(h), h)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [railOpen]);
  const [projFilter, setProjFilter] = useState<'all' | 'auto' | 'live'>('all');
  const [pickSlug, setPickSlug] = useState(''); // the Plan/Build rooms' project
  const load = useCallback(() => {
    getControl()
      .then(setData)
      .catch((e) => { if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Failed to load mission control.'); });
  }, []);

  // Refresh on a slow tick so queued → running → done progresses on screen
  // (the dispatcher polls the queue once a minute).
  useEffect(() => {
    load();
    const t = window.setInterval(load, 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  // Optimistic with rollback — same contract as Settings.
  const setAutopilot = async (patch: {
    autopilotEnabled?: boolean; autopilotMinutes?: number;
    autopilotTokens?: number; autopilotTime?: string; autopilotMaxItems?: number;
    autopilotPlanSweep?: boolean;   // #255 — the standing plan sweep
    autopilotExecutorModel?: string; autopilotAdvisorModel?: string;
  }) => {
    if (!data) return;
    const prev = data.autopilot;
    setData({
      ...data,
      autopilot: {
        enabled: patch.autopilotEnabled ?? prev.enabled,
        minutes: patch.autopilotMinutes ?? prev.minutes,
        tokens: patch.autopilotTokens ?? prev.tokens,
        time: patch.autopilotTime ?? prev.time,
        maxItems: patch.autopilotMaxItems ?? prev.maxItems,
        planSweep: patch.autopilotPlanSweep ?? prev.planSweep,
        executorModel: patch.autopilotExecutorModel ?? prev.executorModel,
        advisorModel: patch.autopilotAdvisorModel ?? prev.advisorModel,
      },
    });
    try {
      const s = await patchSettings(patch);
      setData((cur) => cur && {
        ...cur,
        autopilot: {
          enabled: s.autopilotEnabled, minutes: s.autopilotMinutes,
          tokens: s.autopilotTokens ?? prev.tokens, time: s.autopilotTime ?? prev.time,
          maxItems: s.autopilotMaxItems ?? prev.maxItems,
          planSweep: s.autopilotPlanSweep ?? prev.planSweep,
          executorModel: s.autopilotExecutorModel ?? prev.executorModel,
          advisorModel: s.autopilotAdvisorModel ?? prev.advisorModel,
        },
      });
    } catch (e) {
      setData((cur) => cur && { ...cur, autopilot: prev });
      if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not update the autopilot.');
    }
  };

  const toggleAutomode = async (p: ControlProject) => {
    if (!data) return;
    const flip = (v: boolean) => (cur: ControlData | null) => cur && {
      ...cur,
      projects: cur.projects.map((x) => (x.slug === p.slug ? { ...x, automode: v } : x)),
      totals: { ...cur.totals, automode: cur.totals.automode + (v ? 1 : -1) },
    };
    setData(flip(!p.automode));
    try {
      await patchProject(p.slug, { automode: !p.automode });
    } catch (e) {
      setData(flip(p.automode));
      if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not update the project.');
    }
  };

  const openJobFor = (slug: string) => data?.jobs.find((j) => j.slug === slug && OPEN_JOB.has(j.status));

  // #122 — the nightly pick's area filter, per project ('' = whole board).
  const setTargetArea = async (p: ControlProject, area: string) => {
    const apply = (v: string) => (cur: ControlData | null) => cur && {
      ...cur,
      projects: cur.projects.map((x) => (x.slug === p.slug ? { ...x, autopilotArea: v } : x)),
    };
    setData(apply(area));
    try {
      await patchProject(p.slug, { autopilot_area: area });
      load(); // nextPick moves with the target — refetch rather than mirror the pick logic here
    } catch (e) {
      setData(apply(p.autopilotArea));
      if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not set the target area.');
    }
  };

  const runNow = async (p: ControlProject) => {
    try {
      const job = await startAutopilot(p.slug);
      setData((cur) => cur && { ...cur, jobs: [job, ...cur.jobs.filter((j) => j.id !== job.id)] });
    } catch (e) {
      if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not queue the run.');
    }
  };

  // #142 — the paused-session controls: resume clears the hold (the dispatcher
  // picks it up within a minute), hang-up parks it, dismiss drops it.
  const replaceJob = (job: AutopilotJob) =>
    setData((cur) => cur && { ...cur, jobs: cur.jobs.map((j) => (j.id === job.id ? job : j)) });
  const resumeJob = async (j: AutopilotJob) => {
    try {
      replaceJob(await resumeAutopilotJob(j.id));
    } catch (e) {
      if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not resume the session.');
    }
  };
  const hangupJob = async (j: AutopilotJob) => {
    try {
      replaceJob(await hangupAutopilotJob(j.id));
    } catch (e) {
      if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not hang up the session.');
    }
  };
  const dismissJob = async (j: AutopilotJob) => {
    const prev = data?.jobs || [];
    setData((cur) => cur && { ...cur, jobs: cur.jobs.filter((x) => x.id !== j.id) });
    try {
      await dismissAutopilotJob(j.id);
    } catch (e) {
      setData((cur) => cur && { ...cur, jobs: prev });
      if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not dismiss the session.');
    }
  };

  // #154 — confirm then queue a merge job for the pending branch.
  const confirmMerge = async () => {
    if (!mergePending || mergeBusy) return;
    setMergeBusy(true);
    setError('');
    try {
      const job = await queueMerge(mergePending.slug, mergePending.branch, mergePending.itemId || undefined,
        mergePending.mergeClean === false && mergeAiResolve ? true : undefined);
      setData((cur) => cur && { ...cur, jobs: [job, ...cur.jobs.filter((j) => j.id !== job.id)] });
      setMergePending(null);
      setMergeAiResolve(false);
    } catch (e) {
      if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not queue the merge.');
    } finally {
      setMergeBusy(false);
    }
  };

  // #228 — the planner modal saves through the schedule API itself; this just
  // folds the returned row back into the list.
  const plannerSaved = (row: AutopilotSchedule, isNew: boolean) =>
    setData((cur) => cur && {
      ...cur,
      schedules: isNew ? [...cur.schedules, row] : cur.schedules.map((s) => (s.id === row.id ? row : s)),
    });

  const toggleSchedule = async (id: string, enabled: boolean) => {
    setData((cur) => cur && { ...cur, schedules: cur.schedules.map((s) => (s.id === id ? { ...s, enabled } : s)) });
    try {
      await patchAutopilotSchedule(id, { enabled });
    } catch (e) {
      setData((cur) => cur && { ...cur, schedules: cur.schedules.map((s) => (s.id === id ? { ...s, enabled: !enabled } : s)) });
      if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not update the schedule.');
    }
  };

  const removeSchedule = async (id: string) => {
    const prev = data?.schedules || [];
    setData((cur) => cur && { ...cur, schedules: cur.schedules.filter((s) => s.id !== id) });
    try {
      await deleteAutopilotSchedule(id);
    } catch (e) {
      setData((cur) => cur && { ...cur, schedules: prev });
      if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not remove the schedule.');
    }
  };

  const labelSessions = async (silent = false) => {
    if (labelBusy) return;
    setLabelBusy(true);
    try {
      const { sessions, detached } = await labelTerminalSessions();
      setData((cur) => cur && { ...cur, terminal: { connected: cur.terminal?.connected ?? true, sessions, detached } });
    } catch (e) {
      // silent = the auto-label pass — a keyless server (503) just leaves the
      // chips unlabelled, no error banner.
      if (!silent && !(e instanceof AuthError)) setError((e as Error)?.message || 'Could not label the sessions.');
    } finally {
      setLabelBusy(false);
    }
  };

  // ✧ Auto-label: whenever sessions without a Gemini label show up (a fresh
  // load, a new session, a new detached survivor), ask once. The tried-key
  // guard stops the 30s tick re-asking for sessions Gemini already saw but
  // couldn't name (no output yet, or no server key).
  const labelTried = useRef('');
  useEffect(() => {
    const t = data?.terminal;
    if (!t) return;
    const unlabelled = [
      ...(t.sessions ?? []).filter((s) => !s.label).map((s) => `s${s.sid}`),
      ...(t.detached ?? []).filter((d) => !d.label).map((d) => d.name),
    ].sort().join(',');
    if (!unlabelled || unlabelled === labelTried.current) return;
    labelTried.current = unlabelled;
    void labelSessions(true);
  }, [data?.terminal]); // eslint-disable-line react-hooks/exhaustive-deps


  // (#194) Budget bar fill — % of per-night budget consumed across active nights this week;
  // null hides the bar. Uses weekNights (not weekRuns) because autopilot_tokens is a
  // per-night cap shared across all items that night, not per item attempt.
  const usageBar = data?.usage && data.usage.budgetPerNight > 0 && data.usage.weekNights > 0
    ? Math.min(100, Math.round(data.usage.weekTokens / (data.usage.budgetPerNight * data.usage.weekNights) * 100))
    : null;

  // ---- 14a derived bits ----
  // #271 — pickSlug '' is the whole house, and it is the DEFAULT. A director's
  // chair shows every project; picking one narrows it. (There is deliberately
  // no auto-pick here any more: landing on whichever project sorted first was
  // exactly the single-project framing this replaces.)
  const runNowSlug = (slug: string) => {
    const p = data?.projects.find((x) => x.slug === slug);
    if (p) void runNow(p);
  };
  // The live strip's primary session: a claude tab first, any web session next,
  // then a detached survivor. Everything else is "N more" + the Now-room chips.
  const sess = data?.terminal?.sessions ?? [];
  const det = (data?.terminal?.detached ?? []).filter((d) => !sess.some((s) => s.tmux === d.name));
  const primary = sess.find((s) => s.cmd === 'claude') ?? sess[0] ?? null;
  const primaryDet = primary ? null : det[0] ?? null;
  const liveCount = sess.length + det.length;
  const homely = (cwd: string) => cwd.replace(/^\/home\/[^/]+\/?/, '') || '~';
  const projectNameOf = (cwd: string) => {
    const seg = homely(cwd).split('/')[0];
    return data?.projects.find((p) => p.slug === seg)?.name ?? (seg === '~' ? 'home' : seg);
  };
  const seriousTotal = data?.projects.reduce((n, p) => n + p.bugs.serious, 0) ?? 0;
  // #268's slots and capacity are read inside <SessionLanes> now (#283) — it
  // owns the merged list and still renders idle capacity rather than omitting it.
  // #270 — the honest reason the fleet is or is not running. Absent only on a
  // server that pre-dates the resolver, where the line simply doesn't render.
  const fleetStatus = data?.fleet?.status;
  const shownProjects = (data?.projects ?? []).filter((p) =>
    projFilter === 'auto' ? p.automode : projFilter === 'live' ? !!p.live : true);
  // Per-project run history for the row bars — oldest → newest, this week.
  const historyFor = (slug: string) =>
    (data?.usage?.recentRuns ?? []).filter((r) => r.slug === slug).slice(0, 6).reverse();
  // The rail's plan meters (#220). Computed once for both rail states: the
  // full rail names each window, the slim rail abbreviates it, and the same
  // 10-minute staleness gate applies to both — a snapshot older than that is
  // no longer "right now", so neither rail claims it is.
  const planMeters = (() => {
    const snap = data?.planUsage;
    if (!snap || Date.now() - snap.at >= 10 * 60_000) return [];
    const p = snap.plan;
    const fmtReset = (msAt: number | null | undefined, withDay = false): string => {
      if (!msAt) return '';
      const d = new Date(msAt);
      const h = d.getHours() % 12 || 12;
      const t = `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() >= 12 ? 'pm' : 'am'}`;
      return withDay ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${t}` : t;
    };
    // The per-model window's short name: drop the vendor prefix and the date
    // suffix, then let the slim rail ellipsis what is still too long (the row
    // carries the full name as its title, so nothing is lost, only folded).
    const shortModel = (m: string) =>
      (m || 'model').toLowerCase().replace(/^claude-/, '').replace(/-\d{6,}$/, '');
    return [
      p.session && { name: 'Session window', short: 'sess', pct: p.session.pct, reset: p.session.resetAt ? `resets ${fmtReset(p.session.resetAt)}` : '' },
      p.week && { name: 'Week', short: 'week', pct: p.week.pct, reset: p.week.resetAt ? `resets ${fmtReset(p.week.resetAt, true)}` : '' },
      p.weekModel && { name: `Week · ${(p.weekModel.model || 'model').toLowerCase()}`, short: shortModel(p.weekModel.model || ''), pct: p.weekModel.pct, reset: '' },
    ].filter(Boolean) as { name: string; short: string; pct: number; reset: string }[];
  })();

  // The rail's NEXT UP: the coming week's bookings, tonight's nightly first.
  const upcoming = (() => {
    if (!data) return [] as { key: string; day: string; time: string; what: string; count: string }[];
    const out: { key: string; day: string; time: string; what: string; count: string }[] = [];
    for (let i = 0; i < 7 && out.length < 5; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const date = fmtDate(d);
      const day = i === 0 ? 'Tonight' : i === 1 ? 'Tomorrow' : DAY_LABELS[d.getDay()];
      if (i === 0 && data.autopilot.enabled && data.totals.automode > 0) {
        out.push({
          key: `n${date}`, day, time: data.autopilot.time,
          what: `nightly — ${data.totals.automode} automode project${data.totals.automode === 1 ? '' : 's'}`,
          count: data.autopilot.maxItems === 0 ? '∞' : `≤${data.autopilot.maxItems}`,
        });
      }
      for (const s of data.schedules) {
        if (!s.enabled || out.length >= 5) continue;
        if (s.runDate ? s.runDate === date : s.days.includes(d.getDay())) {
          out.push({
            key: `${s.id}·${date}`, day, time: s.atTime,
            what: `${s.name}${s.kind !== 'build' ? ` · ${s.kind}` : ''}`,
            count: s.agenda.length ? `☰${s.agenda.length}` : s.itemId ? `#${s.itemId}` : '',
          });
        }
      }
    }
    return out;
  })();

  return (
    <div>
      {error && <div className="action-error">{error}</div>}
      {previewErr && <div className="action-error">{previewErr}</div>}
      {/* (#208) A preview that failed is worth saying out loud — it usually
          means the branch itself doesn't come up, which is a review finding. */}
      {previews.filter((v) => v.status === 'failed').slice(0, 2).map((v) => (
        <div className="action-error" key={v.id}>
          Preview of <b>{v.slug}/{v.branch}</b> failed — {v.detail || 'no reason reported'}
        </div>
      ))}
      {/* (#208) Stop confirm — tearing a preview down drops its containers and
          its throwaway database, so ask rather than doing it on a stray click. */}
      {stopPending && (
        <div className="overlay" onClick={() => setStopPending(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Stop the preview of {stopPending.branch}?</h3>
            <p style={{ fontSize: 13.5, lineHeight: 1.55, marginBottom: 20 }}>
              The host tears the stack down within a minute: its containers stop, its throwaway
              database is deleted and the public URL stops working. The branch itself is untouched —
              you can preview it again whenever you like.
            </p>
            <div className="modal-actions">
              <button className="btn-cancel" onClick={() => setStopPending(null)}>Keep it running</button>
              <button className="btn-submit" onClick={() => void confirmStopPreview()}>Stop the preview</button>
            </div>
          </div>
        </div>
      )}
      {/* #154 — merge confirm modal */}
      {mergePending && (
        <div className="overlay" onClick={() => !mergeBusy && setMergePending(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Merge {mergePending.branch}?</h3>
            <p style={{ fontSize: 13.5, lineHeight: 1.55, marginBottom: 20 }}>
              Merges <code>origin/{mergePending.branch}</code> into <code>main</code> on the host, then deletes the remote branch.
              {mergePending.itemId && <> After the merge, tick item <strong>#{mergePending.itemId}</strong> ({mergePending.itemTitle}) in the roadmap to close it out.</>}
              {' '}Conflicts fail safely — you will see the error in the job strip.
            </p>
            {mergePending.mergeClean === false && (
              <>
                <p className="mc-merge-warn">
                  ⚠ The host's last probe found <strong>conflicts with main</strong> — this merge will fail
                  and need resolving by hand (or rebase the branch first).
                </p>
                {/* #193 — AI-assisted resolution: claude resolves in the throwaway
                    worktree; anything short of fully clean still aborts safely. */}
                <label className="mc-merge-ai" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, marginBottom: 16, cursor: 'pointer' }}>
                  <input type="checkbox" checked={mergeAiResolve} onChange={(e) => setMergeAiResolve(e.target.checked)} />
                  <span>Let claude attempt the conflict resolution on the host (bounded; an unclean result
                  still aborts — the merge commit is flagged for your review).</span>
                </label>
              </>
            )}
            <div className="modal-actions">
              <button className="btn-cancel" disabled={mergeBusy} onClick={() => setMergePending(null)}>Cancel</button>
              <button className="btn-submit" disabled={mergeBusy} onClick={confirmMerge}>
                {mergeBusy ? 'Queueing…' : '⇥ Merge'}
              </button>
            </div>
          </div>
        </div>
      )}

        {!data ? (
          !error && <div className="empty-state"><div className="big">Loading…</div></div>
        ) : (
          <>
            {/* ---- 14a: the shell — rooms behind one live strip + rail ---- */}
            <div className="mc14-tabs" role="tablist" aria-label="Mission Control rooms">
              {/* #271 — with no project picked the Plan badge counts the whole
                  house, not zero; picking one narrows the badge with the room.
                  #282 — Review badges what is waiting on a verdict, reported up
                  by the room itself (it owns that fetch). */}
              {([['now', 'Now', liveCount], ['nights', 'Nights', data.schedules.filter((s) => s.enabled).length], ['plan', 'Plan', pickSlug ? (data.projects.find((p) => p.slug === pickSlug)?.reviewCount ?? 0) : data.totals.review], ['build', 'Build', buildN], ['review', 'Review', reviewN], ['roles', 'Roles', (data.roles?.assignments ?? []).filter((a) => a.drift && a.drift !== 'no-runs').length]] as const).map(([key, label, n]) => (
                <button key={key} role="tab" aria-selected={room === key}
                  className={`mc14-tab ${room === key ? 'on' : ''}`} onClick={() => setRoom(key)}>
                  {label}{n > 0 && <span className="n">{n}</span>}
                </button>
              ))}
              <div style={{ flex: 1 }} />
              <a className="mc14-headlink" href={hrefTo.terminal()}>▸ Terminal</a>
            </div>

            {/* the live strip — pinned above every room */}
            <div className={`mc14-livebar ${primary || primaryDet ? 'live' : ''}`}>
              {primary ? (<>
                <span className="dot" />
                <span className="state">LIVE</span>
                <span className="proj">{projectNameOf(primary.cwd)}</span>
                <span className="tail">{primary.label || `${primary.cmd} session in ~/${homely(primary.cwd)}`}</span>
                <span className="when">{sessionAge(primary.startedAt)}</span>
                {liveCount > 1 && <span className="more">+{liveCount - 1} more</span>}
                <a className="attach" href={hrefTo.terminal(primary.cwd === '~' ? undefined : primary.cwd, primary.tmux || undefined)}>Attach</a>
              </>) : primaryDet ? (<>
                <span className="dot" />
                <span className="state">UNATTENDED</span>
                <span className="proj">{projectNameOf(primaryDet.cwd || '~')}</span>
                <span className="tail">{primaryDet.label || `claude running detached (tmux ${primaryDet.name})`}</span>
                {liveCount > 1 && <span className="more">+{liveCount - 1} more</span>}
                <a className="attach" href={hrefTo.terminal(primaryDet.cwd || undefined, primaryDet.name)}>Attach</a>
              </>) : (<>
                <span className="dot quiet" />
                <span className="state quiet">ALL QUIET</span>
                <span className="tail">no sessions live{data.autopilot.enabled && data.totals.automode > 0 ? ` — the next window is the nightly at ${data.autopilot.time}` : ''}</span>
                <a className="attach" href={hrefTo.terminal()}>⌨ Terminal</a>
              </>)}
            </div>

            <div className={`mc14-cols ${railOpen ? '' : 'rail-slim'}`}>
              <div className="mc14-body">
                {room === 'now' && (<>
            {/* #270 — LOUD IDLE. The most important fact about an automation
                system is whether it is actually running, so it gets the first
                line of the room, with the one-click fix beside it. */}
            {fleetStatus && (
              <div className={`mc-idle ${fleetStatus.tone}`} role={fleetStatus.tone === 'bad' ? 'alert' : undefined}>
                <span className="dot" />
                <span className="txt">
                  {fleetStatus.text}
                  {fleetStatus.hint && <em>{fleetStatus.hint}</em>}
                </span>
                {fleetStatus.fix?.kind === 'arm' && (
                  <button className="fix" onClick={() => setAutopilot({ autopilotEnabled: true })}>
                    {fleetStatus.fix.label}
                  </button>
                )}
                {fleetStatus.fix?.kind === 'plan' && (
                  <button className="fix" onClick={() => setRoom('plan')}>{fleetStatus.fix.label}</button>
                )}
                {fleetStatus.fix?.kind === 'resume' && (() => {
                  const j = data.jobs.find(isPausedSession);
                  return j ? (
                    <button className="fix" onClick={() => resumeJob(j)}>{fleetStatus.fix!.label}</button>
                  ) : null;
                })()}
              </div>
            )}

            {/* #283 (design 22a) — ONE lane list over both sources: the
                autopilot's workers and every terminal session the daemon can
                see. Replaces the separate fleet strip and terminal chip strip,
                which split "what is running" across two widgets fed by two
                unrelated paths. */}
            <SessionLanes data={data} labelBusy={labelBusy} onLabel={() => labelSessions()}
              onConfigureRoles={() => setCfgOpen(true)} onReload={load} />

            {/* (#208) MIRROR SITES. A preview used to be visible only as a chip
                on its own branch in the merge strip — which answers "is this
                branch previewed?" but not "what is running, and what is the
                link?", and the link is the entire point of a mirror site: it is
                how the branch reaches a phone, or anyone you want to show. So
                the running previews get their own line in the room that says
                what is running now, beside the sessions.
                Rendered even when empty, on the same reasoning as the fleet's
                idle slots (#268): a feature you cannot see when it is idle is a
                feature nobody finds. */}
            <div className="mc-mirrors">
              <div className="mc-mirror-cap">
                <span className="cap">MIRROR SITES</span>
                <span className="note">
                  one branch running on its own stack, own empty database — the link is public while it lives
                </span>
              </div>
              {openMirrors.length === 0 ? (
                <div className="mc-mirror-empty">
                  Nothing mirrored right now. ◱ Preview on a branch in the merge strip below brings one
                  up — a minute or two for a warm build.
                </div>
              ) : (
                <ul className="mc-mirror-list">
                  {openMirrors.map((v) => (
                    <li key={v.id} className={`mc-mirror ${v.status}`}>
                      <span className="st">
                        {v.status === 'live' ? 'LIVE'
                          : v.status === 'stopping' ? 'STOPPING'
                            : v.status === 'starting' ? 'BUILDING' : 'QUEUED'}
                      </span>
                      <span className="who">
                        <b>{v.name || v.slug}</b>
                        <code>{v.branch}</code>
                        {v.itemTitle && <em>#{v.itemId} {v.itemTitle}</em>}
                      </span>
                      {/* A live row with no url yet is still arriving — say that
                          rather than rendering a dead link. */}
                      {v.status === 'live' && v.url ? (
                        <a className="url" href={v.url} target="_blank" rel="noreferrer noopener"
                          title="Opens the mirror in a new tab — public link, no sign-in wall in front of it">
                          {v.url.replace(/^https?:\/\//, '')}
                        </a>
                      ) : (
                        <span className="detail">{v.detail || 'starting on the host'}</span>
                      )}
                      <span className="left">{mirrorLeft(v.expiresAt)}</span>
                      <span className="acts">
                        {(v.status === 'live' || v.status === 'starting') && (
                          <button className="mc-mirror-more" disabled={mirrorBusy === v.id}
                            title="Give this mirror another hour before it expires"
                            onClick={() => void extendMirror(v)}>
                            {mirrorBusy === v.id ? '◴' : '＋1h'}
                          </button>
                        )}
                        {v.status !== 'stopping' && (
                          <button className="mc-mirror-x" title="Stop this mirror and free the host"
                            onClick={() => setStopPending(v)}>× Stop</button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>


            {/* the live session card + the tiles (11a) */}
            <div className="mc14-toprow">
              <div className={`mc14-livecard ${primary || primaryDet ? 'live' : ''}`}>
                <div className="cap-row">
                  <span className="cap">LIVE SESSION</span>
                  <span className="host">{data.terminal?.connected ? 'host daemon online' : 'host daemon offline'}</span>
                </div>
                {(primary || primaryDet) ? (<>
                  <div className="name-row">
                    <span className="nm">{projectNameOf((primary?.cwd ?? primaryDet?.cwd) || '~')}</span>
                    <span className="path">~/{homely((primary?.cwd ?? primaryDet?.cwd) || '')}</span>
                  </div>
                  <div className="task">{(primary?.label ?? primaryDet?.label) || 'Working — ✧ labelling names the task as output arrives.'}</div>
                  {liveCount > 1 && <span className="others">{liveCount - 1} other session{liveCount === 2 ? '' : 's'} live — the chips below jump in</span>}
                </>) : (
                  <div className="task quiet">Nothing running. ▶ Run now on a project queues an unattended session; the terminal is one key away.</div>
                )}
              </div>
              <div className="mc14-tiles">
                <button className="mc14-review" onClick={() => go.dashboard()}
                  title="Auto-extracted items waiting for keep/dismiss — the deck's review inbox">
                  <span className="n">{data.totals.review}</span>
                  <span className="l">awaiting review</span>
                  <span className="note">{data.totals.review > 0 ? 'keep or dismiss from the deck — approvals stick across pushes' : 'inbox clear'}</span>
                </button>
                <div className="mc14-minis">
                  <div className="mc14-mini"><span className="n">{seriousTotal}</span><span className={`l ${seriousTotal ? 'bad' : ''}`}>serious bugs</span></div>
                  <div className="mc14-mini"><span className="n">{data.totals.claims}</span><span className="l">claimed branches</span></div>
                </div>
              </div>
            </div>

            {/* the autopilot, settled into one line — config folds open (11a) */}
            <div className="mc14-settle">
              <div className="row">
                <button role="switch" aria-checked={data.autopilot.enabled} aria-label="Autopilot armed"
                  className={`switch ${data.autopilot.enabled ? 'on' : ''}`}
                  onClick={() => setAutopilot({ autopilotEnabled: !data.autopilot.enabled })}>
                  <span className="switch-knob" />
                </button>
                <span className="lbl">Autopilot {data.autopilot.enabled ? 'armed' : 'off'}</span>
                <span className="sum">
                  {data.autopilot.enabled
                    ? `nightly ${data.autopilot.time} · ${data.autopilot.maxItems === 0 ? '∞' : `≤${data.autopilot.maxItems}`}/night · ${data.autopilot.minutes % 60 === 0 ? `${data.autopilot.minutes / 60}h` : `${data.autopilot.minutes}m`} cap · ${data.autopilot.tokens === 0 ? '∞ tokens' : fmtTok(data.autopilot.tokens)}${data.autopilot.executorModel ? ` · ${data.autopilot.executorModel}` : ''}${data.autopilot.advisorModel ? ` → ${data.autopilot.advisorModel}` : ''}`
                    : 'nightly + scheduled sessions paused — Run now still works'}
                </span>
                <button className="cfg" onClick={() => setCfgOpen((v) => !v)} aria-expanded={cfgOpen}>
                  {cfgOpen ? '▾ close' : '▸ configure'}
                </button>
              </div>
              {cfgOpen && (
              <div className="mc14-cfg">
              <div className="mc-console-clusters">
                {/* Night budget cluster */}
                <div className="mc-cluster">
                  <div className="mc-cluster-label">Night budget</div>
                  <div className="mc-knobs">
                    <label className="mc-knob">
                      <span className="mc-knob-label">Session cap</span>
                      <span className="seg-control sm" role="tablist" aria-label="Session cap">
                        {CAPS.map((c) => (
                          <button key={c.minutes} role="tab" aria-selected={data.autopilot.minutes === c.minutes}
                            className={`seg-opt ${data.autopilot.minutes === c.minutes ? 'on' : ''}`}
                            onClick={() => setAutopilot({ autopilotMinutes: c.minutes })}>
                            {c.label}
                          </button>
                        ))}
                      </span>
                    </label>
                    <label className="mc-knob">
                      <span className="mc-knob-label">Token budget</span>
                      <span className="seg-control sm" role="tablist" aria-label="Token budget per run">
                        {BUDGETS.map((b) => (
                          <button key={b.tokens} role="tab" aria-selected={data.autopilot.tokens === b.tokens}
                            className={`seg-opt ${data.autopilot.tokens === b.tokens ? 'on' : ''}`}
                            title={b.tokens === 0 ? 'No token ceiling — the session cap is the only governor' : `${b.label} tokens per run`}
                            onClick={() => setAutopilot({ autopilotTokens: b.tokens })}>
                            {b.label}
                          </button>
                        ))}
                      </span>
                    </label>
                    <label className="mc-knob">
                      <span className="mc-knob-label">Nightly at</span>
                      <input type="time" className="mc-time" value={data.autopilot.time}
                        aria-label="Nightly start time (host local)"
                        onChange={(e) => e.target.value && setAutopilot({ autopilotTime: e.target.value })} />
                    </label>
                    <label className="mc-knob">
                      <span className="mc-knob-label">Items / night</span>
                      <span className="seg-control sm" role="tablist" aria-label="Most items per night">
                        {NIGHT_ITEMS.map((n) => (
                          <button key={n} role="tab" aria-selected={data.autopilot.maxItems === n}
                            className={`seg-opt ${data.autopilot.maxItems === n ? 'on' : ''}`}
                            title={n === 0
                              ? 'Unlimited — the night works items until the wall-clock cap or the token budget runs out'
                              : `At most ${n} item${n === 1 ? '' : 's'} a night`}
                            onClick={() => setAutopilot({ autopilotMaxItems: n })}>
                            {nightItemsLabel(n)}
                          </button>
                        ))}
                      </span>
                    </label>
                    {/* #255 — the standing plan sweep. The board's ✧ To planning
                        agent is the pressed version of this; here it becomes the
                        default behaviour, so work never reaches a build night
                        without a design. Same gates as the nightly. */}
                    <label className="mc-knob">
                      <span className="mc-knob-label">Plan sweep</span>
                      <button type="button" role="switch" aria-checked={data.autopilot.planSweep}
                        className={`switch ${data.autopilot.planSweep ? 'on' : ''}`}
                        title={data.autopilot.planSweep
                          ? 'On — a project with unplanned must/should work gets a plan session queued for it automatically. The arm switch and the project’s automode still gate the run.'
                          : 'Off — items are only designed when you press ✧ To planning agent or book a plan night.'}
                        onClick={() => setAutopilot({ autopilotPlanSweep: !data.autopilot.planSweep })} />
                    </label>
                  </div>
                </div>

                {/* Models cluster with hierarchy viz */}
                <div className="mc-cluster">
                  <div className="mc-cluster-label">Models</div>
                  <div className="mc-knobs">
                    <label className="mc-knob">
                      <span className="mc-knob-label">Executor</span>
                      <span className="seg-control sm" role="tablist" aria-label="Executor model — runs the session">
                        {(data.models?.executors ?? FALLBACK_EXECUTORS).map((m) => (
                          <button key={m.model} role="tab" aria-selected={data.autopilot.executorModel === m.model}
                            className={`seg-opt ${data.autopilot.executorModel === m.model ? 'on' : ''}`}
                            title={m.model === '' ? "The claude CLI's own default model runs the session" : `Sessions run on ${m.label}`}
                            onClick={() => setAutopilot({ autopilotExecutorModel: m.model })}>
                            {m.label}
                          </button>
                        ))}
                      </span>
                    </label>
                    <label className="mc-knob">
                      <span className="mc-knob-label">Advisor</span>
                      <span className="seg-control sm" role="tablist" aria-label="Advisor model — a stronger model the session consults">
                        {(data.models?.advisors ?? FALLBACK_ADVISORS).map((m) => (
                          <button key={m.model} role="tab" aria-selected={data.autopilot.advisorModel === m.model}
                            className={`seg-opt ${data.autopilot.advisorModel === m.model ? 'on' : ''}`}
                            title={m.model === '' ? 'No advisor — single-model sessions' : `The executor consults ${m.label} for plans and unblocking`}
                            onClick={() => setAutopilot({ autopilotAdvisorModel: m.model })}>
                            {m.label}
                          </button>
                        ))}
                      </span>
                    </label>
                  </div>
                  {/* Hierarchy diagram — shows the dual-model flow when an advisor is set */}
                  <div className="mc-hierarchy">
                    {data.autopilot.advisorModel ? (
                      <>
                        <div className="mc-hier-node exec" title="Runs every turn of the session">
                          <span className="mc-hier-role">Executor</span>
                          <span className="mc-hier-model">
                            {modelLabel(data.models?.executors ?? FALLBACK_EXECUTORS, data.autopilot.executorModel)}
                          </span>
                        </div>
                        <div className="mc-hier-arrow" aria-hidden>
                          <span className="mc-hier-edge">consults</span>
                          <span className="mc-hier-line">→</span>
                        </div>
                        <div className="mc-hier-node advisor" title="Read-only counsel — plans, unblocking, sanity check">
                          <span className="mc-hier-role">Advisor</span>
                          <span className="mc-hier-model">
                            {modelLabel(data.models?.advisors ?? FALLBACK_ADVISORS, data.autopilot.advisorModel, 'Off')}
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="mc-hier-node exec single" title="Single-model session — no advisor">
                        <span className="mc-hier-role">Executor</span>
                        <span className="mc-hier-model">
                          {modelLabel(data.models?.executors ?? FALLBACK_EXECUTORS, data.autopilot.executorModel)}
                        </span>
                        <span className="mc-hier-sub">single-model</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              </div>
              )}
            </div>
              {/* The running-sessions chips moved into the #283 lane list above —
                  one place for what is running, rather than the same sessions
                  described twice in two shapes. */}
              {/* #142 — paused sessions: limit-hit resumes holding for the reset,
                  or hung up by hand. Resume clears the hold, hang-up parks it. */}
              {data.jobs.some(isPausedSession) && (
                <div className="mc-paused" aria-label="Paused sessions">
                  {data.jobs.filter(isPausedSession).map((j) => (
                    <span key={j.id} className={`mc-pause ${j.status}`}
                      title={[j.itemTitle && `#${j.itemId} ${j.itemTitle}`, j.detail].filter(Boolean).join(' — ') || undefined}>
                      ⏸ {j.name}{j.itemId ? ` #${j.itemId}` : ''} ·{' '}
                      {j.status === 'paused' ? 'hung up — resumes only by hand'
                        : j.notBefore ? `paused on the usage limit · resumes ${resumeWhen(j.notBefore)}`
                        : 'resuming — the host picks it up within a minute'}
                      {(j.status === 'paused' || j.notBefore) && (
                        <button className="mc-run" onClick={() => resumeJob(j)}
                          title="Resume this session now — the dispatcher picks it up within a minute">
                          ▶ Resume now
                        </button>
                      )}
                      {j.status === 'queued' && j.notBefore && (
                        <button className="btn-repo sm" onClick={() => hangupJob(j)}
                          title="Hang up — hold the session so it only resumes when you say">
                          ⏸ Hang up
                        </button>
                      )}
                      <button className="mc-pause-x" onClick={() => dismissJob(j)}
                        aria-label="Dismiss this paused session"
                        title="Dismiss — drop the pending resume entirely">×</button>
                    </span>
                  ))}
                </div>
              )}
              {data.jobs.some((j) => !isPausedSession(j)) && (
                <div className="mc-jobs" aria-label="Recent autopilot jobs">
                  {data.jobs.filter((j) => !isPausedSession(j)).slice(0, 6).map((j) => (
                    <span key={j.id} className={`mc-job ${j.status}`}
                      title={[j.itemTitle && `#${j.itemId} ${j.itemTitle}`, j.detail].filter(Boolean).join(' — ') || undefined}>
                      {j.name} · {j.kind}{j.itemId ? ` #${j.itemId}` : ''} · {JOB_LABEL[j.status]}
                      {OPEN_JOB.has(j.status) ? '' : ` ${j.when}`}
                      {/* #150 — the kill channel: pausing a RUNNING job asks the
                          dispatcher to kill the session (within ~30s); partial
                          work stays on the branch, the job parks as paused. */}
                      {j.status === 'running' && (
                        <button className="btn-repo sm" onClick={() => hangupJob(j)}
                          title="Hang up this running session — the host kills it within ~30s; partial commits stay on its branch">
                          ⏸ Hang up
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}

            {/* the projects become the page (11a) — hairline + filters, then rows */}
            <div className="mc14-projhead">
              <span className="cap">PROJECTS</span>
              <span className="hair" />
              {([['all', 'All'], ['auto', 'Automode'], ['live', 'Live']] as const).map(([key, label]) => (
                <button key={key} className={`mc14-filter ${projFilter === key ? 'on' : ''}`}
                  onClick={() => setProjFilter(key)}>{label}</button>
              ))}
            </div>
            <div className="mc-list">
              {shownProjects.map((p) => {
                const job = openJobFor(p.slug);
                const hist = historyFor(p.slug);
                return (
                <div className={`mc-row ${p.automode ? 'auto' : ''}`} key={p.slug}>
                  <div className="mc-main">
                    <button className="mc-name" onClick={() => go.detail(p.slug)}>
                      <span className="tintdot" style={{ background: p.tint || 'var(--sand)' }} />
                      {p.name}
                    </button>
                    <span className={`statusbadge ${p.status}`}><span className="dot" />{STATUS_LABEL[p.status]}</span>
                    {hist.length > 0 && (
                      <span className="mc14-hist" title="This week's runs, oldest first">
                        {hist.map((r, i) => (
                          <i key={i} className={r.outcome}
                            title={`${r.itemId ? `#${r.itemId} ` : ''}${r.itemTitle || 'general'} — ${r.outcome} ${r.when}`} />
                        ))}
                      </span>
                    )}
                    {p.live && (
                      <span className="mc-live" title={`${p.live.count} live session${p.live.count === 1 ? '' : 's'}`}>
                        ● {p.live.branches.join(' · ')}
                      </span>
                    )}
                    <a className="mc-term" href={hrefTo.terminal(p.slug)}
                      aria-label={`Open terminal for ${p.name}`}
                      title={`Open a terminal in ~/${p.slug}`}>⌨</a>
                    <span className="mc-push">{p.lastPush ? `pushed ${p.lastPush}` : 'no pushes yet'}</span>
                    {job ? (
                      <span className={`mc-job ${job.status}`} title={job.detail || undefined}>
                        {job.kind === 'resume' && job.notBefore
                          ? `resumes ${resumeWhen(job.notBefore)}` : JOB_LABEL[job.status]}
                        {job.itemId ? ` #${job.itemId}` : ''}
                      </span>
                    ) : (
                      <button className="mc-run" onClick={() => runNow(p)}
                        title="Queue an autopilot session on this project now — the host picks it up within a minute">
                        ▶ Run now
                      </button>
                    )}
                    <button role="switch" aria-checked={p.automode} aria-label={`Automode for ${p.name}`}
                      className={`switch sm ${p.automode ? 'on' : ''}`} onClick={() => toggleAutomode(p)}
                      title={p.automode ? 'Automode on — the autopilot may work this project' : 'Automode off — hands off'}>
                      <span className="switch-knob" />
                    </button>
                  </div>
                  <div className="mc-facts">
                    <span className="mc-fact">
                      {p.automode ? (
                        p.nextPick
                          ? <>tonight: <button className="mc-pick" onClick={() => go.detail(p.slug, 'roadmap', p.nextPick!.id)}>#{p.nextPick.id} {p.nextPick.title}</button></>
                          : <span className="quiet">tonight: nothing eligible{p.autopilotArea ? ` in ${p.autopilotArea}` : ''}</span>
                      ) : (
                        <span className="quiet">manual only</span>
                      )}
                    </span>
                    {p.automode && (p.areas.length > 0 || p.autopilotArea) && (
                      <select className="mc-area" value={p.autopilotArea} aria-label={`Target area for ${p.name}`}
                        title="Point the nightly pick at one product area; the whole board otherwise"
                        onChange={(e) => setTargetArea(p, e.target.value)}>
                        <option value="">target: all areas</option>
                        {[...new Set([...p.areas, ...(p.autopilotArea ? [p.autopilotArea] : [])])].map((a) => (
                          <option key={a} value={a}>target: {a}</option>
                        ))}
                      </select>
                    )}
                    {p.lastAuto && (
                      <span className="mc-fact" title={p.lastAuto.summary}>
                        last run: <button className="mc-pick" onClick={() => go.detail(p.slug, 'activity')}>{p.lastAuto.branch}</button> {p.lastAuto.when}
                      </span>
                    )}
                    {p.claims.map((c) => (
                      <button key={c.id} className="mc-claim" title={c.title}
                        onClick={() => go.detail(p.slug, 'roadmap', c.id)}>⚑ {c.branch}</button>
                    ))}
                    {p.reviewCount > 0 && (
                      <button className="mc-review" onClick={() => go.detail(p.slug)}>
                        {p.reviewCount} to review
                      </button>
                    )}
                    {p.bugs.serious > 0 && (
                      <button className="mc-bugs" onClick={() => go.detail(p.slug, 'quality')}>
                        {p.bugs.serious} serious bug{p.bugs.serious === 1 ? '' : 's'}
                      </button>
                    )}
                    {/* #206 — audit pass rate from the checks' stored results */}
                    {p.audit && (
                      <button
                        className={`mc-fact mc-audit${p.audit.passing < p.audit.run ? ' warn' : ''}`}
                        title={`${p.audit.passing} of ${p.audit.run} checks passing (last stored results) — open the Quality tab`}
                        onClick={() => go.detail(p.slug, 'quality')}>
                        ⚗ {Math.round((p.audit.passing / p.audit.run) * 100)}% audit
                      </button>
                    )}
                    {p.blockers.length > 0 && (
                      <span className="mc-fact mc-blocked" title={p.blockers.join('\n')}>
                        ⛔ {p.blockers.length} blocker{p.blockers.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                  {/* #154 — branch management strip: one chip per open branch,
                      enriched with the host's git report where it exists (#207) */}
                  {(p.branches.length > 0 || (p.absorbedBranches ?? 0) > 0) && (
                    <div className="mc-branches" aria-label={`Open branches for ${p.name}`}
                      title={p.branchesWhen ? `git state as of ${p.branchesWhen}` : undefined}>
                      {[...p.branches].sort((a, b) => {
                        // #288 — order by what needs a HUMAN, the same rule the
                        // lane list sorts on. A conflicting branch is the one
                        // the machine cannot finish at all; a clean one is a
                        // decision away; an unprobed one is neither yet.
                        // Within a group, most work first — a branch with one
                        // commit on it is rarely what you came to deal with.
                        const rank = (x: typeof a) => (x.mergeClean === false ? 0 : x.mergeClean === true ? 1 : 2);
                        return rank(a) - rank(b) || (b.ahead ?? 0) - (a.ahead ?? 0)
                          || a.branch.localeCompare(b.branch);
                      }).map((b) => {
                        const mergeJob = data?.jobs.find(
                          (j) => j.slug === p.slug && j.kind === 'merge' && j.detail.includes(b.branch),
                        );
                        const chipTitle = [
                          b.itemTitle ? `#${b.itemId} ${b.itemTitle}` : b.branch,
                          b.subject ? `Last commit: ${b.subject}${b.when ? ` (${b.when})` : ''}` : '',
                        ].filter(Boolean).join('\n');
                        return (
                          <span key={b.branch}
                            className={`mc-branch ${mergeJob ? mergeJob.status : ''}`
                              + (b.mergeClean === false ? ' conflicts' : b.mergeClean === true ? ' clean' : '')}
                            title={chipTitle}>
                            <button className="mc-branch-name"
                              onClick={() => go.detail(p.slug, 'roadmap', b.itemId)}>
                              {b.branch}
                            </button>
                            {b.itemId && (
                              <span className="mc-branch-item">
                                #{b.itemId}
                              </span>
                            )}
                            {typeof b.ahead === 'number' && (
                              <span className="mc-branch-diff"
                                title={`${b.ahead} commit${b.ahead === 1 ? '' : 's'} ahead of main${b.behind ? `, ${b.behind} behind` : ''}`}>
                                ↑{b.ahead}{(b.behind ?? 0) > 0 && <> ↓{b.behind}</>}
                              </span>
                            )}
                            {b.mergeClean === true && (
                              <span className="mc-branch-clean" title="Merges cleanly into main">✓</span>
                            )}
                            {b.mergeClean === false && (
                              <span className="mc-branch-conflict" title="Conflicts with main — rebase or merge by hand">⚠</span>
                            )}
                            {/* #288 — the last commit's AGE, on the chip rather
                                than behind a hover. It is the one field that
                                separates live work from a stranded lane, and a
                                strip that hides it makes every branch look
                                equally current. */}
                            {b.when && (
                              <span className="mc-branch-age"
                                title={b.subject ? `Last commit ${b.when}: ${b.subject}` : `Last commit ${b.when}`}>
                                {b.when}
                              </span>
                            )}
                            {mergeJob ? (
                              <span className="mc-branch-status">{
                                mergeJob.status === 'queued' || mergeJob.status === 'claimed' ? 'queuing…'
                                  : mergeJob.status === 'running' ? 'merging…'
                                  : mergeJob.status === 'done' ? 'merged'
                                  : mergeJob.detail.slice(0, 60) || mergeJob.status
                              }</span>
                            ) : (
                              <button className="mc-branch-merge"
                                title={`Merge origin/${b.branch} into main on the host — conflicts fail safely`}
                                onClick={() => setMergePending({ slug: p.slug, branch: b.branch, itemId: b.itemId, itemTitle: b.itemTitle, mergeClean: b.mergeClean })}>
                                ⇥ Merge
                              </button>
                            )}
                            {/* (#208) Look at the branch RUNNING before deciding
                                on it. The chip shows the live state, because a
                                preview is a slow thing on someone else's clock. */}
                            {(() => {
                              const pv = previewFor(p.slug, b.branch);
                              const busy = previewBusy === `${p.slug}:${b.branch}`;
                              if (!pv) {
                                return (
                                  <button className="mc-branch-preview" disabled={busy}
                                    title={`Bring ${b.branch} up as an isolated stack on the host and open it on a temporary public URL. Expires in 2 hours.`}
                                    onClick={() => void openPreview(p.slug, b.branch, b.itemId || null)}>
                                    {busy ? '◴ …' : '◱ Preview'}
                                  </button>
                                );
                              }
                              if (pv.status === 'live' && pv.url) {
                                return (
                                  <span className="mc-branch-previewlive">
                                    <a className="url" href={pv.url} target="_blank" rel="noopener noreferrer"
                                      title={`${pv.url} — public while it lives, expires ${pv.expiresAt ? new Date(pv.expiresAt).toLocaleTimeString() : 'soon'}`}>
                                      ◱ Open
                                    </a>
                                    <button className="x" aria-label="Stop preview" title="Stop this preview and free the host"
                                      onClick={() => setStopPending(pv)}>×</button>
                                  </span>
                                );
                              }
                              return (
                                <span className="mc-branch-status" title={pv.detail}>
                                  {pv.status === 'stopping' ? 'stopping…'
                                    : pv.status === 'queued' ? 'preview queued…'
                                    : 'preview building…'}
                                </span>
                              );
                            })()}
                          </span>
                        );
                      })}
                      {/* #193 — the merge train: queue every probe-clean branch in one
                          press; they run sequentially (one dispatcher job at a time),
                          each merging into the main the previous one pushed. */}
                      {p.branches.filter((b) => b.mergeClean === true
                        && !data.jobs.some((j) => j.slug === p.slug && j.kind === 'merge' && j.detail.includes(`origin/${b.branch} into`) && ['queued', 'claimed', 'running'].includes(j.status))).length >= 2 && (
                        <button className="mc-branch-merge mc-train"
                          title="Queue a merge for every branch the probe calls clean — they merge one after another, each onto the main the last one produced"
                          onClick={async () => {
                            const clean = p.branches.filter((b) => b.mergeClean === true);
                            for (const b of clean) {
                              try {
                                const job = await queueMerge(p.slug, b.branch, b.itemId || undefined);
                                setData((cur) => cur && { ...cur, jobs: [job, ...cur.jobs.filter((j) => j.id !== job.id)] });
                              } catch (e) {
                                if (!(e instanceof AuthError)) setError((e as Error)?.message || `Could not queue ${b.branch}.`);
                                break;
                              }
                            }
                          }}>
                          ⇥ Merge train ({p.branches.filter((b) => b.mergeClean === true).length} clean)
                        </button>
                      )}
                      {(p.absorbedBranches ?? 0) > 0 && (
                        <span className="mc-branch-absorbed"
                          title="Fully merged into main but never deleted on origin — prune with: git push origin --delete <branch>">
                          🧹 {p.absorbedBranches} merged branch{p.absorbedBranches === 1 ? '' : 'es'} to prune
                        </span>
                      )}
                      {/* #288 — every number on this strip is a SNAPSHOT: the
                          host fetches and probes on its own ~10-minute cycle,
                          not when this page loads. That was a hover on the
                          container, which is exactly where a reader who has
                          been given precise-looking counts will not look. */}
                      <span className="mc-branch-asof"
                        title="The host dispatcher fetches each repo and re-probes every ~10 minutes; the ahead/behind counts and the conflict probe are from that pass, not from this page load.">
                        {p.branchesWhen ? `git as of ${p.branchesWhen}` : 'no git report yet — chips are claims only'}
                      </span>
                    </div>
                  )}
                </div>
                );
              })}
              {data.projects.length === 0 && (
                <div className="empty-state">
                  <div className="big">No projects yet</div>
                  <div>Connect a repo from the dashboard and it'll appear here.</div>
                </div>
              )}
            </div>
                </>)}

                {room === 'nights' && (
                  <NightsRoom data={data} pickSlug={pickSlug} onPick={setPickSlug}
                    onOpenPlanner={(row) => setPlanner({ row })} onRunNow={runNowSlug}
                    onToggleSchedule={toggleSchedule} onRemoveSchedule={removeSchedule}
                    onMerge={(branch, itemId, itemTitle, mergeClean) => {
                      // #286 — the debrief's MERGE decision. The slug comes from
                      // the branch's own project, not the room's picker, since
                      // the calendar shows the whole house when nothing is picked.
                      const owner = data.projects.find((p) => (p.branches ?? []).some((b) => b.branch === branch));
                      setMergePending({ slug: owner?.slug ?? pickSlug, branch, itemId, itemTitle, mergeClean });
                    }} />
                )}
                {room === 'plan' && (
                  <PlanRoom data={data} pickSlug={pickSlug} onPick={setPickSlug}
                    onSetMaxItems={(n) => void setAutopilot({ autopilotMaxItems: n })}
                    onSetModel={(p) => void setAutopilot(p)} />
                )}
                {room === 'build' && (
                  <BuildRoom data={data} pickSlug={pickSlug} onPick={setPickSlug} onGoNow={() => setRoom('now')}
                    onCount={setBuildN}
                    onGoReview={(slug, itemId) => { setReviewFocus(`${slug}#${itemId}`); setRoom('review'); }} />
                )}
                {/* #281 — Roles: the fleet-wide half of turn 23. "Edit the
                    policy" lands you on the Now room's model pickers, which
                    are the one place the policy is actually written. */}
                {/* #282 — Review: the cross-project queue and the night
                    debrief, moved out of the Roadmap tab. */}
                {room === 'review' && <ReviewRoom onCount={setReviewN} focus={reviewFocus} />}
                {room === 'roles' && (
                  <RolesRoom data={data} onReload={load}
                    onConfigure={() => { setRoom('now'); setCfgOpen(true); }} />
                )}
              </div>

              {/* ---- the rail: plan windows, usage, next up — stays put across rooms ---- */}
              {railOpen ? (
              <div className="mc14-rail" ref={railRef}>
                {/* The collapse control lives on the rail itself, not in the
                    first card's header: which card is first depends on what
                    the host has reported, so a chevron pinned to one of them
                    would vanish exactly when the daemon was quiet. #306 — the
                    same bar, the same 22px button, at the same distance from
                    the rail's right edge in BOTH states, so the control you
                    press to collapse is under the cursor that expands again. */}
                <div className="mc14-railbar">
                  <button className="mc14-railtoggle" onClick={toggleRail} aria-expanded={true}
                    aria-label="Collapse the rail" title="Collapse the rail">‹</button>
                </div>
                {planMeters.length > 0 && (
                  <div className="mc14-rail-sec">
                    <div className="cap-row"><span className="cap">CLAUDE PLAN</span><span className="sub">right now</span></div>
                    {planMeters.map((m) => (
                      <div key={m.name} className="mc14-meter">
                        <div className="row"><span className="nm">{m.name}</span><span className={`pct ${m.pct >= 85 ? 'warn' : ''}`}>{m.pct}%</span></div>
                        <div className="bar"><span className={m.pct >= 85 ? 'warn' : ''} style={{ width: `${Math.min(100, m.pct)}%` }} /></div>
                        {m.reset && <span className="reset">{m.reset}</span>}
                      </div>
                    ))}
                  </div>
                )}

                {data.usage && data.usage.weekRuns > 0 && (
                  <div className="mc14-rail-sec">
                    <div className="cap-row">
                      <span className="cap">USAGE</span><span className="sub">last 7 days</span>
                      <div style={{ flex: 1 }} />
                      {data.usage.weekCostUsd > 0.005 && <span className="spend">${data.usage.weekCostUsd.toFixed(2)}</span>}
                    </div>
                    <div className="mc14-tok">
                      <span className="big">{fmtTok(data.usage.weekTokens)}</span>
                      <span className="sub">{data.usage.weekRuns} run{data.usage.weekRuns === 1 ? '' : 's'} · {data.usage.weekNights} night{data.usage.weekNights === 1 ? '' : 's'}</span>
                    </div>
                    {usageBar !== null && (
                      <div className="mc14-budgetbar"
                        title={`${fmtTok(data.usage.weekTokens)} of ${fmtTok(data.usage.budgetPerNight * data.usage.weekNights)} budgeted this week — ${usageBar}%`}>
                        <span style={{ width: `${usageBar}%` }} />
                      </div>
                    )}
                    {data.usage.models.length > 0 && (
                      <>
                        <div className="mc14-stack">
                          {data.usage.models.map((m, i) => (
                            <span key={m.model || '__x'} className={`seg c${i % 4}`}
                              style={{ width: `${Math.max(2, Math.round((m.tokens / data.usage!.weekTokens) * 100))}%` }} />
                          ))}
                        </div>
                        {data.usage.models.map((m, i) => (
                          <div key={m.model || '__x'} className="mc14-model">
                            <span className={`sw c${i % 4}`} />
                            <span className="nm">{m.model || 'single-model'}</span>
                            <span className="tok">{fmtTok(m.tokens)}</span>
                            {m.costUsd > 0.005 && <span className="cost">${m.costUsd.toFixed(2)}</span>}
                          </div>
                        ))}
                      </>
                    )}
                    {(data.usage.monthTokens ?? 0) > 0 && (
                      <div className="mc14-month" title={`Month to date, UTC calendar month — ${data.usage.monthRuns ?? 0} runs`}>
                        <span className="nm">month to date</span>
                        <span className="tok">{fmtTok(data.usage.monthTokens!)}</span>
                        {(data.usage.monthCostUsd ?? 0) > 0.005 && <span className="cost">${data.usage.monthCostUsd!.toFixed(2)}</span>}
                      </div>
                    )}
                    {/* #177 — agent breakdown, collapsed; the newest runs' model split */}
                    {(data.usage.recentRuns?.length ?? 0) > 0 && (
                      <div className="mc-agents">
                        <button className="mc-agents-toggle" onClick={() => setAgentBreakdown((v) => !v)}
                          aria-expanded={agentBreakdown}>
                          {agentBreakdown ? '▾' : '▸'} agent breakdown
                        </button>
                        {agentBreakdown && (
                          <div className="mc-agents-list">
                            {data.usage.recentRuns!.slice(0, 12).map((r, i) => (
                              <div className="mc-agents-row" key={i}>
                                <button className="mc-agents-run" title={r.itemTitle || undefined}
                                  onClick={() => r.itemId && go.detail(r.slug, 'roadmap', r.itemId)}>
                                  {r.name}{r.itemId ? ` #${r.itemId}` : ''} · {r.outcome} · {r.when}
                                </button>
                                <span className="mc-agents-models">
                                  {r.models.length > 0 ? r.models.map((m) => (
                                    <span key={m.model} className="mc-usage-model">
                                      <span className="mc-usage-model-name">{m.model}</span>
                                      <span className="mc-usage-model-tok">{fmtTok(m.tokens)}</span>
                                    </span>
                                  )) : (
                                    <span className="mc-usage-model">
                                      <span className="mc-usage-model-name">single-model</span>
                                      <span className="mc-usage-model-tok">{fmtTok(r.tokens)}</span>
                                    </span>
                                  )}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* #269 — the throughput ledger. Mission Control shows what IS;
                    this is the only place that says whether the machine is
                    getting BETTER. Current number and direction, never a table. */}
                {data.ledger && data.ledger.days.some((d) => d.runs > 0) && (() => {
                  const L = data.ledger;
                  const maxLanded = Math.max(1, ...L.days.map((d) => d.landed));
                  const mergeShare = (m: { total: number; auto: number }) => (m.total ? m.auto / m.total : 0);
                  const stats: { key: string; label: string; value: string; t: ReturnType<typeof trend>; title: string }[] = [
                    {
                      key: 'perNight', label: 'landed / night', value: L.now.perNight.toFixed(1),
                      t: trend(L.now.perNight, L.prev.perNight, true),
                      title: `${L.now.landed} item${L.now.landed === 1 ? '' : 's'} landed over the last 7 days, averaged across the nights that actually ran (idle nights are not counted against it).`,
                    },
                    {
                      key: 'costPerItem', label: 'cost / item', value: `$${L.now.costPerItem.toFixed(2)}`,
                      t: trend(L.now.costPerItem, L.prev.costPerItem, false),
                      title: `Spend per landed item over the last 7 days — ${fmtTok(Math.round(L.now.tokensPerItem))} each. Down is better.`,
                    },
                    {
                      key: 'noCommit', label: 'no-commit runs', value: pct1(L.now.noCommitRate),
                      t: trend(L.now.noCommitRate, L.prev.noCommitRate, false),
                      title: 'Share of build runs that finished without committing anything — wasted nights. Plan nights are excluded; they never commit by design.',
                    },
                    {
                      key: 'autoMerge', label: 'merges by machine', value: pct1(mergeShare(L.merges.now)),
                      t: trend(mergeShare(L.merges.now), mergeShare(L.merges.prev), true),
                      title: `${L.merges.now.auto} of ${L.merges.now.total} completed merges over the last 7 days were the runner's own low-risk auto-merges rather than a hand-pressed ⇥ Merge.`,
                    },
                    {
                      key: 'reverts', label: 'reverts', value: String(L.reverts.now),
                      t: trend(L.reverts.now, L.reverts.prev, false),
                      title: 'Undo jobs queued in the last 7 days — work that landed and had to be taken back out.',
                    },
                  ];
                  return (
                    <div className="mc14-rail-sec">
                      <div className="cap-row">
                        <span className="cap">THROUGHPUT</span><span className="sub">14 days</span>
                      </div>
                      <div className="mc-led-spark" aria-label="Items landed per day, oldest left">
                        {L.days.map((d) => (
                          <i key={d.day} className={d.landed ? '' : 'zero'}
                            style={{ height: `${Math.max(8, (d.landed / maxLanded) * 100)}%` }}
                            title={`${d.day}: ${d.landed} landed of ${d.runs} run${d.runs === 1 ? '' : 's'}`} />
                        ))}
                      </div>
                      {stats.map((s) => (
                        <div key={s.key} className="mc-led-stat" title={`${s.title}\n\n${s.t.delta}`}>
                          <span className="l">{s.label}</span>
                          <span className="v">{s.value}</span>
                          <span className={`d ${s.t.cls}`}>{s.t.mark}</span>
                        </div>
                      ))}
                      {L.firstPass.verdicted > 0 && (
                        <div className="mc-led-stat"
                          title={`${L.firstPass.solid} of ${L.firstPass.verdicted} landed items you have verdicted came back solid. Verdicts are read as they stand now, so an item that was refined and later passed still counts — treat this as the ceiling of the true first-pass rate.`}>
                          <span className="l">verdicted solid</span>
                          <span className="v">{pct1(L.firstPass.solid / L.firstPass.verdicted)}</span>
                          <span className="d flat">of {L.firstPass.verdicted}</span>
                        </div>
                      )}
                      {/* #153's claim — cheap hands, strong minds — made measurable.
                          Attribution is the same alias match the Roles room and the
                          lanes use; `assumed` is the share the fallback placed, and
                          the tooltip says so rather than claiming a measured total. */}
                      {L.roles.advisor.tokens > 0 && (() => {
                        const totalTok = L.roles.executor.tokens + L.roles.advisor.tokens;
                        const assumedTok = L.roles.assumed?.tokens ?? 0;
                        const assumedPct = totalTok > 0 ? Math.round((assumedTok / totalTok) * 100) : 0;
                        return (
                        <div className="mc-led-roles"
                          title={`Executor vs advisor spend over 14 days, attributed by the configured models — the same rule the Roles room and the fleet lanes use.${
                            assumedPct > 0
                              ? ` ${assumedPct}% of these tokens ran on a model the current policy names for neither role (usually a run from before a settings change); that share is split the old way — highest-token model as the executor — and is an assumption, not a reading.`
                              : ' Every token here ran on a model the current policy names, so none of it is guesswork.'}`}>
                          <div className="row">
                            <span className="rl">hands</span>
                            <span className="rt">{fmtTok(L.roles.executor.tokens)}</span>
                            <span className="rc">${L.roles.executor.costUsd.toFixed(2)}</span>
                          </div>
                          <div className="row">
                            <span className="rl">minds</span>
                            <span className="rt">{fmtTok(L.roles.advisor.tokens)}</span>
                            <span className="rc">${L.roles.advisor.costUsd.toFixed(2)}</span>
                          </div>
                          {assumedPct > 0 && (
                            <div className="row assumed">
                              <span className="rl">{assumedPct}% assumed</span>
                            </div>
                          )}
                        </div>
                        );
                      })()}
                    </div>
                  );
                })()}

                <div className="mc14-rail-sec grow">
                  <div className="cap-row">
                    <span className="cap">NEXT UP</span>
                    <div style={{ flex: 1 }} />
                    <button className="link" onClick={() => setRoom('nights')}>all nights →</button>
                  </div>
                  {upcoming.map((u) => (
                    <div key={u.key} className="mc14-up">
                      <span className="when"><b>{u.day}</b><i>{u.time}</i></span>
                      <span className="what">{u.what}</span>
                      {u.count && <span className="cnt">{u.count}</span>}
                    </div>
                  ))}
                  {upcoming.length === 0 && <span className="mc14-quiet">Nothing booked this week — the Nights room plans one.</span>}
                  <div className="daemon-row">
                    <span className={`ddot ${data.terminal?.connected ? 'on' : ''}`} />
                    <span>{data.terminal?.connected ? 'stack-term connected' : 'host daemon offline'}</span>
                  </div>
                </div>
              </div>
              ) : (
              /* ---- the slim rail (design 1b) — 76px, numeric. The rule is
                 that budget pressure, spend and connection survive the
                 collapse and everything else is expand-only: the model
                 breakdown, the throughput table, month-to-date and NEXT UP
                 are all reading, not watching. Every value stays legible
                 without hover, and each block is gated on the same data as
                 its full-width counterpart, so the slim rail never draws a
                 frame around nothing. ---- */
              <div className="mc14-rail mc14-railslim"
                style={railH > 0 ? ({ '--rail-h': `${railH}px` } as React.CSSProperties) : undefined}>
                <div className="mc14-railbar">
                  <button className="mc14-railtoggle" onClick={toggleRail} aria-expanded={false}
                    aria-label="Expand the rail" title="Expand the rail">›</button>
                </div>
                <div className="mc14-railmini">

                {planMeters.length > 0 && (
                  <div className="mini-sec">
                    <div className="mini-cap">PLAN</div>
                    {planMeters.map((m) => (
                      <div key={m.name} className="mini-meter" title={`${m.name} — ${m.pct}%${m.reset ? `, ${m.reset}` : ''}`}>
                        <div className="row">
                          <span className="nm">{m.short}</span>
                          <span className={`pct ${m.pct >= 85 ? 'warn' : ''}`}>{m.pct}%</span>
                        </div>
                        <div className="bar"><span className={m.pct >= 85 ? 'warn' : ''} style={{ width: `${Math.min(100, m.pct)}%` }} /></div>
                      </div>
                    ))}
                  </div>
                )}

                {data.usage && data.usage.weekRuns > 0 && (() => {
                  const u = data.usage;
                  const spend = u.weekCostUsd > 0.005 ? `$${u.weekCostUsd.toFixed(2)}` : '';
                  return (
                    <div className="mini-sec"
                      title={`Last 7 days — ${fmtTok(u.weekTokens)} over ${u.weekRuns} run${u.weekRuns === 1 ? '' : 's'} across ${u.weekNights} night${u.weekNights === 1 ? '' : 's'}`}>
                      <div className="mini-cap">7 DAYS</div>
                      <div className="mini-big">{spend || fmtTok(u.weekTokens)}</div>
                      {spend && <div className="mini-sub">{fmtTok(u.weekTokens)}</div>}
                      {u.models.length > 0 && (
                        <div className="mc14-stack">
                          {u.models.map((m, i) => (
                            <span key={m.model || '__x'} className={`seg c${i % 4}`}
                              title={`${m.model || 'single-model'} — ${fmtTok(m.tokens)}`}
                              style={{ width: `${Math.max(2, Math.round((m.tokens / u.weekTokens) * 100))}%` }} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {data.ledger && data.ledger.days.some((d) => d.runs > 0) && (() => {
                  const L = data.ledger;
                  const perNight = trend(L.now.perNight, L.prev.perNight, true);
                  const costItem = trend(L.now.costPerItem, L.prev.costPerItem, false);
                  return (
                    <div className="mini-sec">
                      <div className="mini-cap">FLOW</div>
                      <div className="mini-stat" title={`${L.now.landed} item${L.now.landed === 1 ? '' : 's'} landed per active night over the last 7 days — ${perNight.delta}.`}>
                        <span className="v">{L.now.perNight.toFixed(1)}<i className={perNight.cls}>{perNight.mark}</i></span>
                        <span className="l">ld/night</span>
                      </div>
                      <div className="mini-stat" title={`Spend per landed item over the last 7 days — ${costItem.delta}. Down is better.`}>
                        <span className="v">${L.now.costPerItem.toFixed(2)}<i className={costItem.cls}>{costItem.mark}</i></span>
                        <span className="l">cost/item</span>
                      </div>
                      {L.firstPass.verdicted > 0 && (
                        <div className="mini-stat" title={`${L.firstPass.solid} of ${L.firstPass.verdicted} verdicted items came back solid — read as the ceiling of the true first-pass rate.`}>
                          <span className="v">{pct1(L.firstPass.solid / L.firstPass.verdicted)}</span>
                          <span className="l">solid · {L.firstPass.verdicted}</span>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* the spacer that settles the daemon dot at the bottom of the
                    rail's length (#306) — flattened away when the rail stacks */}
                <div className="mini-fill" />
                <div className="mini-daemon" title={data.terminal?.connected ? 'stack-term connected' : 'host daemon offline'}>
                  <span className={`ddot ${data.terminal?.connected ? 'on' : ''}`} />
                  <span>{data.terminal?.connected ? 'live' : 'off'}</span>
                </div>
                </div>
              </div>
              )}
            </div>

            {/* #228 — the session planner: a scheduled session opened into its own thing */}
            {planner && (
              <SessionPlanModal projects={data.projects.map((p) => ({ slug: p.slug, name: p.name }))}
                initial={planner.row} onClose={() => setPlanner(null)} onSaved={plannerSaved} />
            )}
          </>
        )}
    </div>
  );
}
