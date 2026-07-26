import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getControl, patchProject, patchSettings, startAutopilot,
  patchAutopilotSchedule, deleteAutopilotSchedule,
  resumeAutopilotJob, hangupAutopilotJob, dismissAutopilotJob,
  labelTerminalSessions, queueMerge, AuthError,
  type ControlData, type ControlProject, type AutopilotJob, type AutopilotSchedule,
} from '../store';
import { SessionPlanModal } from '../components/SessionPlanModal';
import { NightsRoom, PlanRoom, BuildRoom } from './ControlRooms';
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

// Mission Control — every project's automation from one point: the autopilot
// console (arm, session cap, token budget incl. unlimited, nightly time,
// items/night), manual Run-now per project, the scheduled-sessions calendar,
// and one row per project (automode, presence, claims, reviews, blockers).
// Rendered as a tab of the Settings screen (#/control deep-links to it).
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
  // #177 — the usage card's per-session agent breakdown, collapsed by default.
  const [agentBreakdown, setAgentBreakdown] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  // 14a — the shell: Now / Nights / Plan / Build are rooms behind one pinned
  // live strip and a persistent rail; the autopilot config folds away.
  const [room, setRoom] = useState<'now' | 'nights' | 'plan' | 'build'>('now');
  const [cfgOpen, setCfgOpen] = useState(false);
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
  useEffect(() => {
    if (!pickSlug && data?.projects.length) setPickSlug(data.projects[0].slug);
  }, [data, pickSlug]);
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
  // #268 — the fleet: the busy slots the payload reports, padded out with idle
  // ones up to capacity. Idle slots are RENDERED, never omitted — the strip's
  // width is how you read the fleet's real size at a glance.
  const fleetCapacity = data?.fleet?.capacity ?? 1;
  const fleetSlots = data?.fleet?.slots ?? [];
  const fleetIdle = Math.max(0, fleetCapacity - fleetSlots.length);
  // #270 — the honest reason the fleet is or is not running. Absent only on a
  // server that pre-dates the resolver, where the line simply doesn't render.
  const fleetStatus = data?.fleet?.status;
  const shownProjects = (data?.projects ?? []).filter((p) =>
    projFilter === 'auto' ? p.automode : projFilter === 'live' ? !!p.live : true);
  // Per-project run history for the row bars — oldest → newest, this week.
  const historyFor = (slug: string) =>
    (data?.usage?.recentRuns ?? []).filter((r) => r.slug === slug).slice(0, 6).reverse();
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
              {([['now', 'Now', liveCount], ['nights', 'Nights', data.schedules.filter((s) => s.enabled).length], ['plan', 'Plan', data.projects.find((p) => p.slug === pickSlug)?.reviewCount ?? 0], ['build', 'Build', 0]] as const).map(([key, label, n]) => (
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

            <div className="mc14-cols">
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

            {/* #268 — the fleet strip: one tile per worker slot, busy or idle.
                Once there are N workers you need to see N workers: what each
                holds, how long it has been at it and what it has burned. */}
            <div className="mc-fleet" aria-label="Fleet worker slots">
              <div className="mc-fleet-head">
                <span className="cap">FLEET</span>
                <span className="hair" />
                <span className="sum">
                  {fleetSlots.length} of {fleetCapacity} slot{fleetCapacity === 1 ? '' : 's'} working
                </span>
              </div>
              <div className="mc-fleet-slots">
                {fleetSlots.map((s) => (
                  <div key={s.jobId} className={`mc-slot ${s.status}`}>
                    <div className="row">
                      <span className="tintdot" style={{ background: s.tint || 'var(--sand)' }} />
                      <button className="nm" onClick={() => go.detail(s.slug)}>{s.name}</button>
                      <span className={`mc-kind ${s.sessionKind}`}>{s.sessionKind}</span>
                      <span className="state">{s.status === 'claimed' ? 'starting' : 'running'}</span>
                      <div style={{ flex: 1 }} />
                      <span className="age" title={s.startedAt ? `started ${new Date(s.startedAt).toLocaleString()}` : undefined}>
                        {s.since}
                      </span>
                    </div>
                    <div className="row holds">
                      {s.itemId ? (
                        <button className="item" title={s.itemTitle}
                          onClick={() => go.detail(s.slug, 'roadmap', s.itemId)}>
                          #{s.itemId} {s.itemTitle || 'item'}
                        </button>
                      ) : (
                        <span className="item quiet">
                          {s.kind === 'nightly' ? 'general night — picks as it goes' : `${s.kind} job`}
                        </span>
                      )}
                      {s.branch && (
                        <span className="branch" title={`The lane claim this worker holds: ${s.branch}`}>
                          {s.branch}
                        </span>
                      )}
                    </div>
                    <div className="row burn">
                      <span className="tok" title="Tokens banked by items this session has already finished — the item in flight is not counted until it lands">
                        {s.tokens > 0 ? fmtTok(s.tokens) : 'nothing banked yet'}
                        {s.costUsd > 0.005 && <b> ${s.costUsd.toFixed(2)}</b>}
                      </span>
                      <div style={{ flex: 1 }} />
                      {s.tmux && (
                        <code className="tmux" title={`Watch it on the host: tmux attach -t ${s.tmux}\n(Autopilot sessions are not attachable from the browser — the terminal daemon carries stack-term-* only.)`}>
                          {s.tmux}
                        </code>
                      )}
                    </div>
                  </div>
                ))}
                {Array.from({ length: fleetIdle }, (_, i) => (
                  <div className="mc-slot idle" key={`idle${i}`}>
                    <div className="row">
                      <span className="tintdot idle" />
                      <span className="nm quiet">Slot {fleetSlots.length + i + 1}</span>
                      <div style={{ flex: 1 }} />
                      <span className="state quiet">IDLE</span>
                    </div>
                    <div className="row holds">
                      <span className="item quiet">nothing in flight</span>
                    </div>
                  </div>
                ))}
              </div>
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
                  <div className="mc14-mini"><span className="n">{data.totals.claims}</span><span className="l">claimed lanes</span></div>
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
              {/* Running sessions — the web-attached ones and the detached tmux
                  survivors. Every chip is a ▶ jump-in: it opens #/terminal
                  attached to that session (by tmux name when there is one —
                  same-tab jumps just switch to the tab that holds it; a shell
                  or pre-tmux session falls back to a cwd match). Labels are
                  Gemini's, applied automatically as unlabelled sessions appear. */}
              {((data.terminal?.sessions?.length ?? 0) > 0 || (data.terminal?.detached?.length ?? 0) > 0) && (
                <div className="mc-terms" aria-label="Running terminal sessions">
                  {(data.terminal?.sessions ?? []).map((s) => s.polaris ? (
                    // A Polaris planning session (#213): labelled as planning and
                    // jumping to the studio, where the same tmux session re-attaches.
                    <a key={s.sid} className="mc-termchip claude polaris"
                      title={`A Polaris planning session — open the studio${s.label ? ` — ${s.label}` : ''}`}
                      href={hrefTo.polaris(s.cwd.split('/')[0] || s.cwd)}>
                      ✦ planning · {s.cwd.replace(/^\/home\/[^/]+/, '~')} · {sessionAge(s.startedAt)}
                      {s.label && <em> — {s.label}</em>}
                    </a>
                  ) : (
                    <a key={s.sid} className={`mc-termchip ${s.cmd}`}
                      title={`Jump into this session${s.label ? ` — ${s.label}` : ''}`}
                      href={hrefTo.terminal(s.cwd === '~' ? undefined : s.cwd, s.tmux || undefined)}>
                      ▶ {s.cmd} · {s.cwd.replace(/^\/home\/[^/]+/, '~')} · {sessionAge(s.startedAt)}
                      {s.label && <em> — {s.label}</em>}
                    </a>
                  ))}
                  {(data.terminal?.detached ?? [])
                    // A web session's own tmux name would double up with its
                    // live chip above — skip those; keep true orphans and
                    // sessions attached elsewhere (laptop ssh, another browser).
                    .filter((d) => !(data.terminal?.sessions ?? []).some((s) => s.tmux === d.name))
                    .map((d) => {
                    // The name shape marks a planning session even after the
                    // browser that started it is gone (#213).
                    const polaris = d.name.startsWith('stack-term-pol-');
                    return (
                    <a key={d.name} className={`mc-termchip ${d.attached ? 'away' : 'detached'}${polaris ? ' polaris' : ''}`}
                      title={d.attached
                        ? `Attached on another device (tmux ${d.name}) — open it here too; both screens mirror the same session${d.label ? ` — ${d.label}` : ''}`
                        : `Running unattended on the host (tmux ${d.name}) — jump back in${d.label ? ` — ${d.label}` : ''}`}
                      href={hrefTo.terminal(d.cwd || undefined, d.name)}>
                      {polaris ? '✦ planning' : '▶ claude'} · {d.cwd ? `~/${d.cwd}` : '~'} · {d.attached ? 'another device' : 'detached'}
                      {d.label && <em> — {d.label}</em>}
                    </a>
                    );
                  })}
                  <button className="btn-repo sm" onClick={() => labelSessions()} disabled={labelBusy}
                    title="Ask Gemini again what each running session is doing">
                    {labelBusy ? 'Labelling…' : '✧ Re-label'}
                  </button>
                </div>
              )}
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
                    <a className="mc-term" href={hrefTo.polaris(p.slug)}
                      aria-label={`Open Polaris for ${p.name}`}
                      title={`Polaris planning studio for ${p.name}`}>✦</a>
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
                        onClick={() => go.detail(p.slug, 'roadmap', c.id)}>⚑ {c.lane}</button>
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
                      {p.branches.map((b) => {
                        const mergeJob = data?.jobs.find(
                          (j) => j.slug === p.slug && j.kind === 'merge' && j.detail.includes(b.branch),
                        );
                        const chipTitle = [
                          b.itemTitle ? `#${b.itemId} ${b.itemTitle}` : b.branch,
                          b.subject ? `Last commit: ${b.subject}${b.when ? ` (${b.when})` : ''}` : '',
                        ].filter(Boolean).join('\n');
                        return (
                          <span key={b.branch} className={`mc-branch ${mergeJob ? mergeJob.status : ''}`}
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
                  <NightsRoom data={data} onOpenPlanner={(row) => setPlanner({ row })} onRunNow={runNowSlug}
                    onToggleSchedule={toggleSchedule} onRemoveSchedule={removeSchedule} />
                )}
                {room === 'plan' && pickSlug && (
                  <PlanRoom data={data} pickSlug={pickSlug} onPick={setPickSlug}
                    onSetMaxItems={(n) => void setAutopilot({ autopilotMaxItems: n })}
                    onSetModel={(p) => void setAutopilot(p)} />
                )}
                {room === 'build' && pickSlug && (
                  <BuildRoom data={data} pickSlug={pickSlug} onPick={setPickSlug} onGoNow={() => setRoom('now')} />
                )}
              </div>

              {/* ---- the rail: plan windows, usage, next up — stays put across rooms ---- */}
              <div className="mc14-rail">
                {data.planUsage && Date.now() - data.planUsage.at < 10 * 60_000 && (() => {
                  const p = data.planUsage.plan;
                  const fmtReset = (msAt: number | null | undefined, withDay = false): string => {
                    if (!msAt) return '';
                    const d = new Date(msAt);
                    const h = d.getHours() % 12 || 12;
                    const t = `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() >= 12 ? 'pm' : 'am'}`;
                    return withDay ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${t}` : t;
                  };
                  const meters = [
                    p.session && { name: 'Session window', pct: p.session.pct, reset: p.session.resetAt ? `resets ${fmtReset(p.session.resetAt)}` : '' },
                    p.week && { name: 'Week', pct: p.week.pct, reset: p.week.resetAt ? `resets ${fmtReset(p.week.resetAt, true)}` : '' },
                    p.weekModel && { name: `Week · ${(p.weekModel.model || 'model').toLowerCase()}`, pct: p.weekModel.pct, reset: '' },
                  ].filter(Boolean) as { name: string; pct: number; reset: string }[];
                  if (!meters.length) return null;
                  return (
                    <div className="mc14-rail-sec">
                      <div className="cap-row"><span className="cap">CLAUDE PLAN</span><span className="sub">right now</span></div>
                      {meters.map((m) => (
                        <div key={m.name} className="mc14-meter">
                          <div className="row"><span className="nm">{m.name}</span><span className={`pct ${m.pct >= 85 ? 'warn' : ''}`}>{m.pct}%</span></div>
                          <div className="bar"><span className={m.pct >= 85 ? 'warn' : ''} style={{ width: `${Math.min(100, m.pct)}%` }} /></div>
                          {m.reset && <span className="reset">{m.reset}</span>}
                        </div>
                      ))}
                    </div>
                  );
                })()}

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
