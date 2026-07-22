import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getControl, patchProject, patchSettings, startAutopilot,
  createAutopilotSchedule, patchAutopilotSchedule, deleteAutopilotSchedule,
  resumeAutopilotJob, hangupAutopilotJob, dismissAutopilotJob,
  labelTerminalSessions, getRoadmap, queueMerge, AuthError,
  type ControlData, type ControlProject, type AutopilotJob, type ModelEntry,
} from '../store';
import { go, hrefTo } from '../lib/route';
import type { ProjectStatus, RoadmapItem } from '../types';

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
const NIGHT_ITEMS = [1, 2, 3, 5];
// Dual-model sessions (#153): the executor runs every turn, the advisor is the
// stronger model it consults as a subagent. '' = CLI default / no advisor.
// These are the FALLBACK lists used before the payload loads (#175 — the live
// catalogue comes from data.models, served by the backend as a single source of truth).
const FALLBACK_EXECUTORS: ModelEntry[] = [
  { model: '', label: 'Default' }, { model: 'haiku', label: 'Haiku' },
  { model: 'sonnet', label: 'Sonnet' }, { model: 'opus', label: 'Opus' },
];
const FALLBACK_ADVISORS: ModelEntry[] = [
  { model: '', label: 'Off' }, { model: 'sonnet', label: 'Sonnet' },
  { model: 'opus', label: 'Opus' }, { model: 'fable', label: 'Fable' },
];
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

const scheduleWhen = (s: { days: number[]; runDate: string | null; atTime: string }) => {
  if (s.runDate) return `once · ${s.runDate} ${s.atTime}`;
  if (s.days.length === 7) return `daily · ${s.atTime}`;
  return `${s.days.map((d) => DAY_LABELS[d]).join(' ')} · ${s.atTime}`;
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

type SchedMode = 'once' | 'daily' | 'custom';
const emptyForm = () => ({
  slug: '', atTime: '21:00', mode: 'once' as SchedMode,
  runDate: fmtDate(new Date()), days: [] as number[], itemId: '', note: '',
});

// Mission Control — every project's automation from one point: the autopilot
// console (arm, session cap, token budget incl. unlimited, nightly time,
// items/night), manual Run-now per project, the scheduled-sessions calendar,
// and one row per project (automode, presence, claims, reviews, blockers).
// Rendered as a tab of the Settings screen (#/control deep-links to it).
export function ControlPanel() {
  const [data, setData] = useState<ControlData | null>(null);
  const [error, setError] = useState('');
  const [schedOpen, setSchedOpen] = useState(false);
  const [schedCollapsed, setSchedCollapsed] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [formBusy, setFormBusy] = useState(false);
  const [labelBusy, setLabelBusy] = useState(false);
  // #154 — merge confirm: the branch the user has clicked ⇥ Merge on, or null.
  // mergeClean rides along from the branch report (#207) so the modal can warn
  // about a probe-known conflict before the job is queued.
  const [mergePending, setMergePending] = useState<{ slug: string; branch: string; itemId: string; itemTitle: string; mergeClean?: boolean | null } | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  // #118 — the composer's item picker: open items for the chosen project,
  // fetched on selection (null = loading), cached per slug for the visit.
  const [pickItems, setPickItems] = useState<Record<string, RoadmapItem[] | null>>({});

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
      const job = await queueMerge(mergePending.slug, mergePending.branch, mergePending.itemId || undefined);
      setData((cur) => cur && { ...cur, jobs: [job, ...cur.jobs.filter((j) => j.id !== job.id)] });
      setMergePending(null);
    } catch (e) {
      if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not queue the merge.');
    } finally {
      setMergeBusy(false);
    }
  };

  const submitSchedule = async () => {
    if (!data || !form.slug || formBusy) return;
    const days = form.mode === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : form.mode === 'custom' ? form.days : [];
    if (form.mode === 'custom' && !days.length) { setError('Pick at least one day for a repeating session.'); return; }
    if (form.mode === 'once' && !form.runDate) { setError('Pick a date for a one-off session.'); return; }
    setFormBusy(true);
    setError('');
    try {
      const row = await createAutopilotSchedule({
        slug: form.slug, atTime: form.atTime, days,
        runDate: form.mode === 'once' ? form.runDate : null,
        itemId: form.itemId.trim() ? form.itemId.trim() : null,
        note: form.note.trim(),
      });
      setData((cur) => cur && { ...cur, schedules: [...cur.schedules, row] });
      setForm(emptyForm());
      setSchedOpen(false);
    } catch (e) {
      if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not add the schedule.');
    } finally {
      setFormBusy(false);
    }
  };

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

  const pickProject = (slug: string) => {
    setForm((f) => ({ ...f, slug, itemId: '' }));
    if (!slug || pickItems[slug] !== undefined) return;
    setPickItems((cur) => ({ ...cur, [slug]: null }));
    getRoadmap(slug)
      .then((r) => {
        const open = [...r.must, ...r.should, ...r.could, ...r.wont].filter((it) => !it.done);
        setPickItems((cur) => ({ ...cur, [slug]: open }));
      })
      .catch(() => setPickItems((cur) => ({ ...cur, [slug]: [] })));
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

  const week = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + i);
    return d;
  });

  // (#194) Budget bar fill — % of per-night budget consumed across active nights this week;
  // null hides the bar. Uses weekNights (not weekRuns) because autopilot_tokens is a
  // per-night cap shared across all items that night, not per item attempt.
  const usageBar = data?.usage && data.usage.budgetPerNight > 0 && data.usage.weekNights > 0
    ? Math.min(100, Math.round(data.usage.weekTokens / (data.usage.budgetPerNight * data.usage.weekNights) * 100))
    : null;

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
              <p className="mc-merge-warn">
                ⚠ The host's last probe found <strong>conflicts with main</strong> — this merge will fail
                and need resolving by hand (or rebase the branch first).
              </p>
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
            {/* ---- the autopilot console: arm switch + every night knob ---- */}
            <div className="mc-strip">
              <div className="mc-arm">
                <button role="switch" aria-checked={data.autopilot.enabled} aria-label="Autopilot armed"
                  className={`switch ${data.autopilot.enabled ? 'on' : ''}`}
                  onClick={() => setAutopilot({ autopilotEnabled: !data.autopilot.enabled })}>
                  <span className="switch-knob" />
                </button>
                <div className="mc-arm-text">
                  <div className="mc-arm-label">Autopilot {data.autopilot.enabled ? 'armed' : 'off'}</div>
                  <div className="mc-arm-hint">
                    {data.autopilot.enabled
                      ? `Nightly at ${data.autopilot.time} on every automode project; scheduled sessions run as set below.`
                      : 'Nightly runs and scheduled sessions are paused. Run now still works.'}
                  </div>
                </div>
              </div>
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
                            onClick={() => setAutopilot({ autopilotMaxItems: n })}>
                            {n}
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
                            {(data.models?.executors ?? FALLBACK_EXECUTORS).find((m) => m.model === data.autopilot.executorModel)?.label ?? 'Default'}
                          </span>
                        </div>
                        <div className="mc-hier-arrow" aria-hidden>
                          <span className="mc-hier-edge">consults</span>
                          <span className="mc-hier-line">→</span>
                        </div>
                        <div className="mc-hier-node advisor" title="Read-only counsel — plans, unblocking, sanity check">
                          <span className="mc-hier-role">Advisor</span>
                          <span className="mc-hier-model">
                            {(data.models?.advisors ?? FALLBACK_ADVISORS).find((m) => m.model === data.autopilot.advisorModel)?.label ?? data.autopilot.advisorModel}
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="mc-hier-node exec single" title="Single-model session — no advisor">
                        <span className="mc-hier-role">Executor</span>
                        <span className="mc-hier-model">
                          {(data.models?.executors ?? FALLBACK_EXECUTORS).find((m) => m.model === data.autopilot.executorModel)?.label ?? 'Default'}
                        </span>
                        <span className="mc-hier-sub">single-model</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="mc-totals">
                <span className={`mc-daemon ${data.terminal?.connected ? 'on' : ''}`}
                  title={data.terminal?.connected
                    ? 'stack-term is connected — terminal sessions available'
                    : 'The host daemon is offline — start stack-term on the host'}>
                  {data.terminal?.connected ? '● daemon online' : '○ daemon offline'}
                </span>
                <span><b>{data.totals.automode}</b> on automode</span>
                <span><b>{data.totals.liveSessions}</b> live session{data.totals.liveSessions === 1 ? '' : 's'}</span>
                <span><b>{data.totals.claims}</b> claimed lane{data.totals.claims === 1 ? '' : 's'}</span>
                <span><b>{data.totals.review}</b> awaiting review</span>
              </div>
              {/* Running sessions — the web-attached ones and the detached tmux
                  survivors. Every chip is a ▶ jump-in: it opens #/terminal
                  attached to that session (by tmux name when there is one —
                  same-tab jumps just switch to the tab that holds it; a shell
                  or pre-tmux session falls back to a cwd match). Labels are
                  Gemini's, applied automatically as unlabelled sessions appear. */}
              {((data.terminal?.sessions?.length ?? 0) > 0 || (data.terminal?.detached?.length ?? 0) > 0) && (
                <div className="mc-terms" aria-label="Running terminal sessions">
                  {(data.terminal?.sessions ?? []).map((s) => (
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
                    .map((d) => (
                    <a key={d.name} className={`mc-termchip ${d.attached ? 'away' : 'detached'}`}
                      title={d.attached
                        ? `Attached on another device (tmux ${d.name}) — open it here too; both screens mirror the same session${d.label ? ` — ${d.label}` : ''}`
                        : `Running unattended on the host (tmux ${d.name}) — jump back in${d.label ? ` — ${d.label}` : ''}`}
                      href={hrefTo.terminal(d.cwd || undefined, d.name)}>
                      ▶ claude · {d.cwd ? `~/${d.cwd}` : '~'} · {d.attached ? 'another device' : 'detached'}
                      {d.label && <em> — {d.label}</em>}
                    </a>
                  ))}
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
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* ---- (#194) usage summary: 7-day tokens + per-model breakdown ---- */}
            {data.usage && data.usage.weekRuns > 0 && (
              <div className="mc-usage">
                <div className="mc-usage-head">
                  <span className="mc-usage-label">Usage — last 7 days</span>
                  <span className="mc-usage-total">
                    {fmtTok(data.usage.weekTokens)}
                    {data.usage.weekCostUsd > 0.005 && ` · $${data.usage.weekCostUsd.toFixed(2)}`}
                    {' '}· {data.usage.weekRuns} run{data.usage.weekRuns === 1 ? '' : 's'}
                    {data.usage.budgetPerNight > 0 && (
                      <span className="mc-usage-budget"> · budget {fmtTok(data.usage.budgetPerNight)}/night</span>
                    )}
                    {data.usage.budgetPerNight === 0 && (
                      <span className="mc-usage-budget"> · ∞ Unlimited budget</span>
                    )}
                  </span>
                  {data.usage.todayTokens > 0 && (
                    <span className="mc-usage-today">
                      24h: {fmtTok(data.usage.todayTokens)}
                      {data.usage.todayCostUsd > 0.005 && ` · $${data.usage.todayCostUsd.toFixed(2)}`}
                    </span>
                  )}
                </div>
                {usageBar !== null && (
                  <div className="mc-usage-bar-wrap"
                    title={`${fmtTok(data.usage.weekTokens)} of ${fmtTok(data.usage.budgetPerNight * data.usage.weekNights)} budgeted this week (${data.usage.weekNights} night${data.usage.weekNights === 1 ? '' : 's'} × ${fmtTok(data.usage.budgetPerNight)}/night) — ${usageBar}%`}
                    aria-label={`${usageBar}% of weekly budget used`}>
                    <div className="mc-usage-bar" style={{ width: `${usageBar}%` }} />
                  </div>
                )}
                {data.usage.models.length > 0 && (
                  <div className="mc-usage-models">
                    {data.usage.models.map((m) => (
                      <span key={m.model || '__unattrib'} className="mc-usage-model">
                        <span className="mc-usage-model-name">{m.model || 'other / single-model'}</span>
                        <span className="mc-usage-model-tok">{fmtTok(m.tokens)}</span>
                        {m.costUsd > 0.005 && <span className="mc-usage-model-cost">${m.costUsd.toFixed(2)}</span>}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ---- scheduled sessions: the week ahead + the standing list ---- */}
            <div className="mc-sched">
              <div className="mc-sched-head">
                <button className="mc-sched-toggle" onClick={() => setSchedCollapsed((v) => !v)}
                  aria-expanded={!schedCollapsed}
                  title={schedCollapsed ? 'Show scheduled sessions' : 'Collapse scheduled sessions'}>
                  <span className="mc-sched-chev">{schedCollapsed ? '›' : '‹'}</span>
                  <div className="mc-sched-title">
                    Scheduled sessions
                    {data.schedules.length > 0 && (
                      <span className="mc-sched-count">{data.schedules.length}</span>
                    )}
                  </div>
                </button>
                {!schedCollapsed && (
                  <button className="btn-repo sm" onClick={() => setSchedOpen((v) => !v)}>
                    {schedOpen ? 'Close' : '+ Schedule a session'}
                  </button>
                )}
              </div>

              {!schedCollapsed && (
                <>
                  <div className="mc-week">
                    {week.map((d, i) => {
                      const date = fmtDate(d);
                      const todays = data.schedules.filter((s) => s.enabled
                        && (s.runDate ? s.runDate === date : s.days.includes(d.getDay())));
                      return (
                        <div className={`mc-day ${i === 0 ? 'today' : ''}`} key={date}>
                          <div className="mc-day-head">{i === 0 ? 'Today' : DAY_LABELS[d.getDay()]} <span>{d.getDate()}</span></div>
                          {data.autopilot.enabled && data.totals.automode > 0 && (
                            <div className="mc-day-chip nightly" title={`The nightly run: up to ${data.autopilot.maxItems} item(s) on each automode project`}>
                              {data.autopilot.time} nightly
                            </div>
                          )}
                          {todays.map((s) => (
                            <div className="mc-day-chip" key={s.id}
                              title={[s.itemTitle && `#${s.itemId} ${s.itemTitle}`, s.note].filter(Boolean).join(' — ') || undefined}>
                              {s.atTime} {s.name}{s.itemId ? ` #${s.itemId}` : ''}
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>

                  {schedOpen && (
                    <div className="mc-sched-form">
                      <select value={form.slug} onChange={(e) => pickProject(e.target.value)} aria-label="Project">
                        <option value="">Project…</option>
                        {data.projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
                      </select>
                      <input type="time" value={form.atTime} aria-label="Start time (host local)"
                        onChange={(e) => setForm({ ...form, atTime: e.target.value })} />
                      <span className="seg-control sm" role="tablist" aria-label="Repeat">
                        {(['once', 'daily', 'custom'] as SchedMode[]).map((m) => (
                          <button key={m} role="tab" aria-selected={form.mode === m}
                            className={`seg-opt ${form.mode === m ? 'on' : ''}`}
                            onClick={() => setForm({ ...form, mode: m })}>
                            {m === 'once' ? 'Once' : m === 'daily' ? 'Daily' : 'Days'}
                          </button>
                        ))}
                      </span>
                      {form.mode === 'once' && (
                        <input type="date" value={form.runDate} min={fmtDate(new Date())} aria-label="Date"
                          onChange={(e) => setForm({ ...form, runDate: e.target.value })} />
                      )}
                      {form.mode === 'custom' && (
                        <span className="mc-daypick" role="group" aria-label="Repeat days">
                          {DAY_LABELS.map((label, d) => (
                            <button key={label} className={`mc-daybtn ${form.days.includes(d) ? 'on' : ''}`}
                              aria-pressed={form.days.includes(d)}
                              onClick={() => setForm({
                                ...form,
                                days: form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d].sort(),
                              })}>
                              {label[0]}
                            </button>
                          ))}
                        </span>
                      )}
                      {form.slug && (
                        <select className="mc-item-pick" value={form.itemId} aria-label="Pin to roadmap item"
                          title="Pin the session to one roadmap item; otherwise it takes the night's normal pick"
                          disabled={pickItems[form.slug] === null}
                          onChange={(e) => setForm({ ...form, itemId: e.target.value })}>
                          <option value="">
                            {pickItems[form.slug] === null ? 'Loading items…' : "item: the night's pick"}
                          </option>
                          {(pickItems[form.slug] || []).map((it) => (
                            <option key={it.id} value={String(it.id)} disabled={Boolean(it.claimedBy)}>
                              #{it.id} [{it.bucket}] {it.title.slice(0, 60)}{it.claimedBy ? ' — claimed' : ''}
                            </option>
                          ))}
                        </select>
                      )}
                      <input className="mc-note-input" placeholder="Note (optional)" value={form.note}
                        aria-label="Note" onChange={(e) => setForm({ ...form, note: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); submitSchedule(); }
                          else if (e.key === 'Escape') { e.preventDefault(); setSchedOpen(false); setForm(emptyForm()); }
                        }} />
                      <button className="btn-accent sm" disabled={!form.slug || formBusy} onClick={submitSchedule}>
                        {formBusy ? 'Adding…' : 'Add'}
                      </button>
                    </div>
                  )}

                  {data.schedules.length > 0 ? (
                    <div className="mc-sched-list">
                      {data.schedules.map((s) => (
                        <div className={`mc-sched-row ${s.enabled ? '' : 'off'}`} key={s.id}>
                          <button role="switch" aria-checked={s.enabled} aria-label={`Schedule for ${s.name}`}
                            className={`switch sm ${s.enabled ? 'on' : ''}`}
                            onClick={() => toggleSchedule(s.id, !s.enabled)}>
                            <span className="switch-knob" />
                          </button>
                          <button className="mc-name sm" onClick={() => go.detail(s.slug)}>
                            <span className="tintdot" style={{ background: s.tint || 'var(--sand)' }} />
                            {s.name}
                          </button>
                          <span className="mc-sched-when">{scheduleWhen(s)}</span>
                          {s.itemId && (
                            <button className="mc-pick" title={s.itemTitle}
                              onClick={() => go.detail(s.slug, 'roadmap', s.itemId!)}>#{s.itemId} {s.itemTitle || 'roadmap item'}</button>
                          )}
                          {s.note && <span className="mc-sched-note" title={s.note}>{s.note}</span>}
                          <button className="mc-sched-del" aria-label="Remove schedule" onClick={() => removeSchedule(s.id)}>×</button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    !schedOpen && <div className="mc-sched-empty">Nothing scheduled — the nightly run covers automode projects{data.autopilot.enabled ? '' : ' (once armed)'}. Add a session to point a project (or one item) at a time of your choosing.</div>
                  )}
                </>
              )}
            </div>

            {/* one row per project — automode first */}
            <div className="mc-list">
              {data.projects.map((p) => {
                const job = openJobFor(p.slug);
                return (
                <div className={`mc-row ${p.automode ? 'auto' : ''}`} key={p.slug}>
                  <div className="mc-main">
                    <button className="mc-name" onClick={() => go.detail(p.slug)}>
                      <span className="tintdot" style={{ background: p.tint || 'var(--sand)' }} />
                      {p.name}
                    </button>
                    <span className={`statusbadge ${p.status}`}><span className="dot" />{STATUS_LABEL[p.status]}</span>
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
                      <button className="mc-bugs" onClick={() => go.detail(p.slug, 'bugs')}>
                        {p.bugs.serious} serious bug{p.bugs.serious === 1 ? '' : 's'}
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
          </>
        )}
    </div>
  );
}
