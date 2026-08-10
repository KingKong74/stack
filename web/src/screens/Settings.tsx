import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { Settings as SettingsData, CheckpointDetail, AuthDevice, Project } from '../types';
import {
  getSettings, patchSettings, getToken, clearToken, verifyToken, AuthError,
  getThemePref, setThemePref, type ThemePref,
  getDeletedProjects, restoreProject, purgeProject, type DeletedProject,
  getProjects, deleteProject,
  getAuthDevices, revokeAuthDevice,
  getTermSessionPrefs, setTermSessionPrefs, type TermSessionPrefs,
  getAutoRefreshSeconds, setAutoRefreshSeconds, AUTO_REFRESH_CHOICES, type AutoRefreshSeconds,
} from '../store';
import { go, type ControlRoom } from '../lib/route';
import { PRODUCT_NAME } from '../lib/ui';
import { DIRECTIVES } from '../lib/brief';
import { ControlPanel } from './Control';

// The three house-wide surfaces this screen holds. `instructions` arrived last
// and is lazy — see below.
type ScreenTab = 'settings' | 'control' | 'instructions';
const TAB_TITLE: Record<ScreenTab, string> = {
  settings: 'Settings',
  control: 'Mission Control',
  instructions: 'Instructions',
};
const InstructionsPanel = lazy(() =>
  import('./Instructions').then((m) => ({ default: m.InstructionsPanel })));

const THEMES: { key: ThemePref; label: string }[] = [
  { key: 'system', label: 'System' }, { key: 'light', label: 'Light' }, { key: 'dark', label: 'Dark' },
];

const DETAILS: { key: CheckpointDetail; label: string; blurb: string }[] = [
  { key: 'brief', label: 'Brief', blurb: 'A line or two — just enough to re-orient.' },
  { key: 'standard', label: 'Standard', blurb: 'A balanced summary with the next moves.' },
  { key: 'detailed', label: 'Detailed', blurb: 'A fuller account of what changed and why.' },
];

// Mask the token: never show the full value. Just enough to recognise it's set.
function maskToken(t: string | null): string {
  if (!t) return 'No token set';
  if (t.length <= 6) return '••••••';
  return `${'•'.repeat(Math.min(t.length - 4, 16))}${t.slice(-4)}`;
}

export function Settings({ initialTab = 'settings', initialRoom, initialSlug, initialHighlight }: {
  initialTab?: ScreenTab; initialRoom?: ControlRoom; initialSlug?: string;
  /** `?hl=` — one row for the room to open on. Passed straight through. */
  initialHighlight?: string;
}) {
  // One screen, three tabs: the app's settings, Mission Control (#/control
  // deep-links straight onto the control tab, and #/control/<room> onto a room
  // — #316), and the instructions tree (#/instructions[/<slug>]).
  //
  // The three belong together because they are the house-wide surfaces: what
  // the fleet is doing, how sessions are recorded, and what every session is
  // told before it starts. Instructions is not a project tab for the same
  // reason — the personal file and the repo files are ONE tree, and "which of
  // these wins" cannot be asked from inside one project.
  const [screenTab, setScreenTab] = useState<ScreenTab>(initialTab);
  // App renders this same component for both routes, so React keeps the
  // instance and the tab would otherwise be whatever it was left on: a
  // `#/control/review` link pressed while the Settings tab is showing changed
  // the URL and nothing else. The route is the authority.
  useEffect(() => { setScreenTab(initialTab); }, [initialTab]);
  // #329 — full screen belongs to Mission Control, not the screen: Settings
  // owns the chrome (topbar, tab strip) that full screen hides, so it has to
  // be the one holding the flag. Same shape as Futures' galaxy full screen —
  // a CSS mode first, the Fullscreen API second, so a refused or unavailable
  // request still gives you the whole viewport.
  const [full, setFull] = useState(false);
  const toggleFull = () => {
    const next = !full;
    setFull(next);
    if (next) void document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
  };
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setFull(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.fullscreenElement) setFull(false); };
    document.addEventListener('fullscreenchange', onChange);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  // Leaving the Mission Control tab drops full screen — it's a Mission
  // Control mode, not a Settings-screen one.
  useEffect(() => { if (screenTab !== 'control') setFull(false); }, [screenTab]);
  // Navigating away from #/control unmounts this component entirely, and the
  // browser would otherwise stay fullscreen with nothing left to show for it.
  // The ref (rather than closing over `full`) is what stops this cleanup
  // cancelling a fullscreen some OTHER screen — the persistent terminal dock
  // — asked for in the meantime.
  const fullRef = useRef(full);
  useEffect(() => { fullRef.current = full; }, [full]);
  useEffect(() => () => {
    if (fullRef.current && document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
  }, []);
  // The corner docks (TipsDock, ToTop, the terminal presence pill) are
  // siblings of this screen, rendered by App.tsx — a dataset flag on <body>
  // is how they fold away without this component reaching outside its tree.
  useEffect(() => {
    if (full) document.body.dataset.mcFull = '1';
    return () => { delete document.body.dataset.mcFull; };
  }, [full]);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [test, setTest] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [theme, setTheme] = useState<ThemePref>(() => getThemePref());
  // Terminal behaviour — device-local, like the theme.
  const [termPrefs, setTermPrefsState] = useState<TermSessionPrefs>(() => getTermSessionPrefs());
  const saveTermPrefs = (p: TermSessionPrefs) => { setTermPrefsState(p); setTermSessionPrefs(p); };
  // #312 — how often the moving screens re-read. Device-local like the theme:
  // the browser is what does the polling.
  const [refreshSecs, setRefreshSecs] = useState<AutoRefreshSeconds>(() => getAutoRefreshSeconds());
  const saveRefresh = (s: AutoRefreshSeconds) => { setRefreshSecs(s); setAutoRefreshSeconds(s); };
  const [deleted, setDeleted] = useState<DeletedProject[]>([]);
  const [purgeArmed, setPurgeArmed] = useState<string | null>(null);
  // Deleting a project moved OFF the project page and to here. A destructive,
  // once-a-year action does not belong at the foot of a screen you scroll past
  // every day — it was one mis-click under the thing you read most.
  const [live, setLive] = useState<Project[]>([]);
  const [deleteArmed, setDeleteArmed] = useState<string | null>(null);
  const loadProjects = () => {
    getProjects()
      .then(setLive)
      .catch((e) => { if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not read the projects.'); });
  };
  useEffect(loadProjects, []);
  const remove = (slug: string) => {
    setDeleteArmed(null);
    deleteProject(slug)
      .then(() => { loadProjects(); return getDeletedProjects().then(setDeleted); })
      .catch((e) => { if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not delete.'); });
  };
  const [pin, setPin] = useState('');
  const [pinMsg, setPinMsg] = useState('');
  const [devices, setDevices] = useState<AuthDevice[]>([]);
  const [revokeConfirm, setRevokeConfirm] = useState<number | null>(null);

  useEffect(() => {
    getDeletedProjects().then(setDeleted).catch(() => { /* section just stays empty */ });
  }, []);

  const restore = (slug: string) => {
    restoreProject(slug)
      .then(() => setDeleted((d) => d.filter((p) => p.slug !== slug)))
      .catch((e) => { if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not restore.'); });
  };
  const purge = (slug: string) => {
    setPurgeArmed(null);
    purgeProject(slug)
      .then(() => setDeleted((d) => d.filter((p) => p.slug !== slug)))
      .catch((e) => { if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not delete.'); });
  };

  useEffect(() => {
    let live = true;
    setLoading(true);
    getSettings()
      .then((s) => {
        if (!live) return;
        setSettings(s);
        setError('');
        // Load the device list only when PIN sign-in is enabled.
        if (s.accessPinSet) {
          getAuthDevices().then((d) => { if (live) setDevices(d); }).catch(() => { /* non-fatal */ });
        }
      })
      .catch((e) => { if (live && !(e instanceof AuthError)) setError(e?.message || 'Failed to load settings.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  // Optimistic patch with rollback on failure.
  const update = async (patch: Partial<SettingsData>) => {
    if (!settings) return;
    const prev = settings;
    setSettings({ ...settings, ...patch });
    setError('');
    try {
      const next = await patchSettings(patch);
      setSettings(next);
    } catch (e) {
      if (e instanceof AuthError) return; // global handler routes to the gate
      setSettings(prev); // rollback
      setError((e as Error)?.message || 'Could not save that change.');
    }
  };

  const runTest = async () => {
    const token = getToken();
    if (!token) { setTest('fail'); return; }
    setTest('testing');
    try {
      const ok = await verifyToken(token);
      setTest(ok ? 'ok' : 'fail');
    } catch {
      setTest('fail');
    }
  };

  const signOut = () => { clearToken(); }; // App drops to the token gate

  // Set / rotate / disable the access PIN (write-only — the server keeps a hash).
  const savePin = async (value: string) => {
    setPinMsg('');
    setError('');
    try {
      const next = await patchSettings({ accessPin: value });
      setSettings(next);
      setPin('');
      // PIN change signs out all devices — clear the list; if PIN was set to a
      // new value the owner can sign back in, but we can't list fresh tokens yet.
      setDevices([]);
      setPinMsg(value ? 'PIN saved. All PIN-connected devices were signed out — sign back in with the new PIN.' : 'PIN sign-in disabled; PIN-connected devices were signed out.');
    } catch (e) {
      if (e instanceof AuthError) return;
      setError((e as Error)?.message || 'Could not save the PIN.');
    }
  };

  // Revoke a single device token. If it's this session's own token, sign out.
  const revokeDevice = async (device: AuthDevice) => {
    setRevokeConfirm(null);
    try {
      await revokeAuthDevice(device.id);
      if (device.current) {
        clearToken(); // 401 on the next request would do the same, but be proactive
        return;
      }
      setDevices((prev) => prev.filter((d) => d.id !== device.id));
    } catch (e) {
      if (e instanceof AuthError) return;
      setError((e as Error)?.message || 'Could not revoke the device.');
    }
  };

  return (
    <div className={full ? 'mc-fullscreen' : undefined}>
      <div className="topbar">
        <div className="crumb">
          <span className="chev" onClick={go.dashboard}>‹</span>
          <span className="back" onClick={go.dashboard}>Projects</span>
          <span className="sep">/</span>
          <span className="here">{TAB_TITLE[screenTab]}</span>
        </div>
        <div className="right">
          <div className="brandmark"><span className="sq" /><span className="word">{PRODUCT_NAME}</span></div>
        </div>
      </div>

      <div className="page detail">
        <div className="dash-head" style={{ marginBottom: 16 }}>
          <div>
            <div className="dash-title">{TAB_TITLE[screenTab]}</div>
            <div className="dash-count">
              {screenTab === 'control'
                ? 'Every project and its automation, from one point.'
                : screenTab === 'instructions'
                  ? 'What Claude reads before it touches a repo. Rules cascade down the tree — the closest file wins.'
                  : `How ${PRODUCT_NAME} records your work, and the access it uses.`}
            </div>
          </div>
        </div>

        <div className="tabs">
          {/* Anchors with real hrefs so middle/ctrl-click opens a new tab; the
              onClick still flips the local tab state (the component stays
              mounted, so a same-page hash change alone wouldn't switch). */}
          <a className={`tab ${screenTab === 'settings' ? 'on' : ''}`} href="#/settings"
            onClick={() => setScreenTab('settings')}>Settings</a>
          <a className={`tab ${screenTab === 'control' ? 'on' : ''}`} href="#/control"
            onClick={() => setScreenTab('control')}>Mission Control</a>
          <a className={`tab ${screenTab === 'instructions' ? 'on' : ''}`} href="#/instructions"
            onClick={() => setScreenTab('instructions')}>Instructions</a>
          {/* Not a tab — the jump to the host terminal, up here beside them.
              Opens in the most recently touched project (the Terminal screen
              resolves the cwd itself when none is given). */}
          <a className="tab tab-term" href="#/terminal"
            title="A real shell (or Claude) on the host, from any device — opens in your current project">
            ⌨ Terminal
          </a>
        </div>

        {screenTab === 'control' && (
          <ControlPanel initialRoom={initialRoom} initialHighlight={initialHighlight}
            full={full} onToggleFull={toggleFull} />
        )}

        {/* Lazy, and for the same reason the Terminal and the skill tree are:
            the tab carries its own parser and map, and most visits to this
            screen are not to it. */}
        {screenTab === 'instructions' && (
          <Suspense fallback={<div className="empty-state"><div className="big">Loading…</div></div>}>
            <InstructionsPanel initialSlug={initialSlug} />
          </Suspense>
        )}

        {screenTab === 'settings' && (error ? <div className="action-error">{error}</div> : null)}

        {screenTab === 'settings' && (loading || !settings ? (
          <div className="empty-state"><div className="big">Loading…</div></div>
        ) : (
          <div className="set-cols">
            {/* ---- Push summaries (the cream signature card) ---- */}
            <section className="set-card signature">
              <div className="set-card-head">
                <div className="set-card-title">Push summaries</div>
                <div className="set-card-sub">
                  Rich summaries are authored by Claude via <span className="mono">/checkpoint</span> — free, no external
                  API. The SessionEnd hook records metadata automatically so the activity feed never has gaps.
                </div>
              </div>

              <Switch
                label="Automatic recording"
                hint="The SessionEnd hook posts a metadata checkpoint when a session ends."
                checked={settings.autoRecord}
                onChange={(v) => update({ autoRecord: v })}
              />
              <Switch
                label="Keep the resume card"
                hint="Let a push refresh each project’s “where you left off” card and the command deck hero."
                checked={settings.keepResumeCard}
                onChange={(v) => update({ keepResumeCard: v })}
              />
              <Switch
                label="Include chores"
                hint="Record chore-only sessions (formatting, deps, config) too."
                checked={settings.includeChores}
                onChange={(v) => update({ includeChores: v })}
              />

              <div className="set-row col">
                <div className="set-row-text">
                  <div className="set-row-label">Checkpoint detail</div>
                  <div className="set-row-hint">How much an authored <span className="mono">/checkpoint</span> summary explains.</div>
                </div>
                <div className="seg-control" role="tablist" aria-label="Checkpoint detail">
                  {DETAILS.map((d) => (
                    <button
                      key={d.key}
                      role="tab"
                      aria-selected={settings.checkpointDetail === d.key}
                      className={`seg-opt ${settings.checkpointDetail === d.key ? 'on' : ''}`}
                      onClick={() => update({ checkpointDetail: d.key })}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
                <div className="set-detail-blurb">
                  {DETAILS.find((d) => d.key === settings.checkpointDetail)?.blurb}
                </div>
              </div>
            </section>

            {/* ---- Session defaults (standing preferences, injected every session) ---- */}
            <section className="set-card">
              <div className="set-card-head">
                <div className="set-card-title">Session defaults</div>
                <div className="set-card-sub">
                  Standing preferences injected at the start of every Claude Code session, on every
                  project — grant it once here instead of re-stating it each chat. Project-specific
                  steer still lives on each project's Directives card.
                </div>
              </div>
              {DIRECTIVES.map((d) => (
                <Switch
                  key={d.key}
                  label={d.label}
                  hint={d.hint}
                  checked={settings.sessionDefaults.includes(d.key)}
                  onChange={(v) => update({
                    sessionDefaults: v
                      ? [...settings.sessionDefaults, d.key]
                      : settings.sessionDefaults.filter((k) => k !== d.key),
                  })}
                />
              ))}
            </section>

            {/* ---- Skills (#228) — the other thing that shapes every session.
                    A pointer, not a section: the switches above are five fixed
                    lines, whereas a skill is a document, and the tree has to
                    hold what the HOST reports beside what the library says. */}
            <section className="set-card set-mc-pointer">
              <div className="set-mc-pointer-body">
                <div className="set-mc-pointer-text">
                  <div className="set-card-title">Skills</div>
                  <div className="set-card-sub">
                    The skills Claude loads when their description matches what you are doing —
                    global or per project, written to the host from here instead of by hand over ssh.
                  </div>
                </div>
                <a className="btn-accent" href="#/skills">Open the skill tree →</a>
              </div>
            </section>

            {/* ---- Instructions — the other half of "what shapes a session".
                    The switches above are five fixed lines Stack injects; this
                    is the CLAUDE.md tree in the repos themselves, which Claude
                    reads whether or not Stack knows about it. A pointer, not a
                    section: the tab has a map and an editor in it. */}
            <section className="set-card set-mc-pointer">
              <div className="set-mc-pointer-body">
                <div className="set-mc-pointer-text">
                  <div className="set-card-title">Instructions</div>
                  <div className="set-card-sub">
                    Every <span className="mono">CLAUDE.md</span> in the tree — your personal one and each
                    project's — with what the merged context actually says, what it costs, and which
                    file wins where they disagree.
                  </div>
                </div>
                <a className="btn-accent" href="#/instructions"
                  onClick={() => setScreenTab('instructions')}>Open the instructions tree →</a>
              </div>
            </section>

            {/* ---- Autopilot — single source of truth in Mission Control ---- */}
            <section className="set-card set-mc-pointer">
              <div className="set-mc-pointer-body">
                <div className="set-mc-pointer-text">
                  <div className="set-card-title">Autopilot</div>
                  <div className="set-card-sub">
                    The arm switch, session cap, token budget, nightly time, items per night, executor and
                    advisor models — everything in one place.
                  </div>
                </div>
                <a className="btn-accent" href="#/control" onClick={() => setScreenTab('control')}>Open Mission Control →</a>
              </div>
            </section>

            {/* ---- Roadmap (#247) — the parked-item stale threshold ---- */}
            <section className="set-card">
              <div className="set-card-head">
                <div className="set-card-title">Roadmap</div>
                <div className="set-card-sub">
                  How the board treats work you've set aside.
                </div>
              </div>
              <div className="set-row col">
                <div className="set-row-text">
                  <div className="set-row-label">Parked items go stale after</div>
                  <div className="set-row-hint">
                    The Roadmap tab's Parked view counts the days since each item was parked and flags
                    anything past this line as stale. Surfacing only — nothing is auto-changed, unparked
                    or deleted.
                  </div>
                </div>
                <div className="seg-control" role="tablist" aria-label="Stale threshold in days">
                  {[7, 14, 21, 30, 60].map((d) => (
                    <button key={d} role="tab" aria-selected={settings.staleItemDays === d}
                      className={`seg-opt ${settings.staleItemDays === d ? 'on' : ''}`}
                      onClick={() => update({ staleItemDays: d })}>
                      {d}d
                    </button>
                  ))}
                </div>
              </div>
            </section>

            {/* ---- ✧ Fill from note (#131) — the roadmap modal's Gemini assist ---- */}
            <section className="set-card">
              <div className="set-card-head">
                <div className="set-card-title">✧ Fill from note</div>
                <div className="set-card-sub">
                  The roadmap modal's Gemini assist reads your note and prefills the item. Steer it
                  with a standing guidance line, and choose which fields it may touch — the title is
                  always its job.
                </div>
              </div>
              <div className="set-row col">
                <div className="set-row-text">
                  <div className="set-row-label">Standing guidance</div>
                  <div className="set-row-hint">
                    Folded into every fill — e.g. "titles lead with the surface; keep notes under
                    five lines; never suggest must". Saved when you click away.
                  </div>
                </div>
                <textarea
                  className="field-area"
                  rows={2}
                  defaultValue={settings.assistGuidance}
                  placeholder="No standing guidance — the assist runs on its defaults."
                  onBlur={(e) => {
                    const v = e.target.value.trim().slice(0, 500);
                    if (v !== settings.assistGuidance) update({ assistGuidance: v });
                  }}
                />
              </div>
              {([
                { key: 'note', label: 'Tidy the note', hint: 'Restructure your note for the agent that builds it — intent kept, filler dropped.' },
                { key: 'area', label: 'Suggest the area', hint: 'Tag the item with a product area, preferring ones the board already uses.' },
                { key: 'branch', label: 'Suggest a branch', hint: 'Only ever an already-open branch claim, and only when the note clearly belongs to it.' },
                { key: 'tier', label: 'Suggest a tier', hint: 'The desire rank that leads the run queue. Only ever fills an EMPTY tier — one you set by hand always stands, and S is offered for you to accept rather than applied.' },
                { key: 'risk', label: 'Suggest the risk', hint: 'How much care the change needs, read from the note. Only ever fills a Normal you have not touched — and low risk is what lets a green overnight run merge itself, so it is read conservatively.' },
                { key: 'priority', label: 'Suggest the bucket', hint: 'An honest MoSCoW call — most things are not must.' },
              ] as { key: string; label: string; hint: string }[]).map((f) => (
                <Switch
                  key={f.key}
                  label={f.label}
                  hint={f.hint}
                  checked={settings.assistFields.includes(f.key)}
                  onChange={(v) => update({
                    assistFields: v
                      ? [...settings.assistFields, f.key]
                      : settings.assistFields.filter((k) => k !== f.key),
                  })}
                />
              ))}
            </section>

            {/* ---- Terminal (device-local, like Appearance) ---- */}
            <section className="set-card">
              <div className="set-card-head">
                <div className="set-card-title">Terminal</div>
                <div className="set-card-sub">How the web terminal opens sessions on this device — and, at the bottom, one app-wide rule the host enforces.</div>
              </div>
              <div className="set-row col">
                <div className="set-row-text">
                  <div className="set-row-label">Opens with</div>
                  <div className="set-row-hint">
                    What the Terminal screen (and a project’s ⌨ button) starts. Claude sessions run
                    inside tmux on the host, so they survive reloads and disconnects — shells don’t.
                  </div>
                </div>
                <div className="seg-control" role="tablist" aria-label="Terminal opens with">
                  {(['claude', 'shell'] as const).map((k) => (
                    <button key={k} role="tab" aria-selected={termPrefs.autoStart === k}
                      className={`seg-opt ${termPrefs.autoStart === k ? 'on' : ''}`}
                      onClick={() => saveTermPrefs({ ...termPrefs, autoStart: k })}>
                      {k === 'claude' ? 'Claude' : 'Shell'}
                    </button>
                  ))}
                </div>
              </div>
              <Switch
                label="Skip permission prompts"
                hint="Claude sessions run with --dangerously-skip-permissions — no per-action approval. Your call on your own host."
                checked={termPrefs.skipPermissions}
                onChange={(v) => saveTermPrefs({ ...termPrefs, skipPermissions: v })}
              />
              {/* #287 — app-wide, not device-local: the HOST does the
                  terminating, so this belongs to the system rather than to the
                  browser that happens to be reading it. */}
              <div className="set-row col">
                <div className="set-row-text">
                  <div className="set-row-label">Terminate idle sessions</div>
                  <div className="set-row-hint">
                    A terminal session that produces no output for this long is ended on the host and its
                    tmux session closed. Idleness is measured by real output, so a tab left open overnight
                    counts as idle. The overnight autopilot’s own sessions are never touched — they go quiet
                    for long stretches while a model thinks. <b>Never</b> keeps today’s behaviour: sessions
                    detach after a few idle hours but run until you end them.
                  </div>
                </div>
                <div className="seg-control" role="tablist" aria-label="Terminate idle terminal sessions after">
                  {[0, 3, 6, 12, 24].map((h) => (
                    <button key={h} role="tab" aria-selected={settings.termIdleHours === h}
                      className={`seg-opt ${settings.termIdleHours === h ? 'on' : ''}`}
                      onClick={() => update({ termIdleHours: h })}>
                      {h === 0 ? 'Never' : `${h}h`}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            {/* ---- Auto refresh (#312 — device-local, like Appearance) ---- */}
            <section className="set-card">
              <div className="set-card-head">
                <div className="set-card-title">Auto refresh</div>
                <div className="set-card-sub">
                  How often the screens that watch the host re-read themselves on this device.
                </div>
              </div>
              <div className="set-row col">
                <div className="set-row-text">
                  <div className="set-row-label">Refresh every</div>
                  <div className="set-row-hint">
                    The terminal’s running sessions, branch previews, Mission Control’s queue and the
                    skill tree all move on the <b>host’s</b> clock — a preview comes up, a session is
                    reaped, a night’s job finishes. This is how often they re-read, so finding out
                    doesn’t mean reloading the page. A tab you aren’t looking at never polls, and
                    refreshes the moment you come back to it. <b>Off</b> leaves every screen reading
                    on arrival and after anything you do, which is what they did before.
                  </div>
                </div>
                <div className="seg-control" role="tablist" aria-label="Auto refresh interval">
                  {AUTO_REFRESH_CHOICES.map((s) => (
                    <button key={s} role="tab" aria-selected={refreshSecs === s}
                      className={`seg-opt ${refreshSecs === s ? 'on' : ''}`}
                      onClick={() => saveRefresh(s)}>
                      {s === 0 ? 'Off' : `${s}s`}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            {/* ---- Appearance (device-local) ---- */}
            <section className="set-card">
              <div className="set-card-head">
                <div className="set-card-title">Appearance</div>
                <div className="set-card-sub">How {PRODUCT_NAME} looks on this device.</div>
              </div>
              <div className="set-row col">
                <div className="set-row-text">
                  <div className="set-row-label">Theme</div>
                  <div className="set-row-hint">System follows your OS setting.</div>
                </div>
                <div className="seg-control" role="tablist" aria-label="Theme">
                  {THEMES.map((t) => (
                    <button key={t.key} role="tab" aria-selected={theme === t.key}
                      className={`seg-opt ${theme === t.key ? 'on' : ''}`}
                      onClick={() => { setTheme(t.key); setThemePref(t.key); }}>
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            {/* ---- Projects: the only place a project can be deleted ---- */}
            {live.length > 0 && (
              <section className="set-card">
                <div className="set-card-head">
                  <div className="set-card-title">Projects</div>
                  <div className="set-card-sub">
                    Deleting is SOFT — everything is kept and the project moves to the bin below,
                    where it can be restored or removed for good.
                  </div>
                </div>
                {live.map((p) => (
                  <div className="set-row" key={p.id}>
                    <div className="set-row-text">
                      <div className="set-row-label">{p.name}</div>
                      <div className="set-row-hint">{p.metaLine}</div>
                    </div>
                    <div className="set-row-actions">
                      {deleteArmed === p.id ? (
                        <>
                          <button className="btn-cancel" onClick={() => setDeleteArmed(null)}>Cancel</button>
                          <button className="btn-danger" onClick={() => remove(p.id)}>Really delete?</button>
                        </>
                      ) : (
                        <button className="btn-cancel" onClick={() => setDeleteArmed(p.id)}>Delete</button>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            )}

            {/* ---- Deleted projects (the soft-delete bin) ---- */}
            {deleted.length > 0 && (
              <section className="set-card">
                <div className="set-card-head">
                  <div className="set-card-title">Deleted projects</div>
                  <div className="set-card-sub">
                    Deleting a project keeps everything — activity, bugs, roadmap, notes — until you
                    delete it forever here.
                  </div>
                </div>
                {deleted.map((p) => (
                  <div className="set-row" key={p.slug}>
                    <div className="set-row-text">
                      <div className="set-row-label">{p.name}</div>
                      <div className="set-row-hint">deleted {p.when}</div>
                    </div>
                    <div className="set-row-actions">
                      <button className="btn-repo" onClick={() => restore(p.slug)}>Restore</button>
                      {purgeArmed === p.slug ? (
                        <button className="btn-danger" onClick={() => purge(p.slug)}>Really delete forever?</button>
                      ) : (
                        <button className="btn-cancel" onClick={() => setPurgeArmed(p.slug)}>Delete forever</button>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            )}

            {/* ---- Access ---- */}
            <section className="set-card">
              <div className="set-card-head">
                <div className="set-card-title">Access</div>
                <div className="set-card-sub">The shared bearer token this browser sends with every request.</div>
              </div>

              <div className="set-row">
                <div className="set-row-text">
                  <div className="set-row-label">API token</div>
                  <div className="set-row-hint mono">{maskToken(getToken())}</div>
                </div>
                <div className="set-row-actions">
                  <button className="btn-repo" onClick={runTest} disabled={test === 'testing'}>
                    {test === 'testing' ? 'Testing…' : 'Test connection'}
                  </button>
                </div>
              </div>
              {test !== 'idle' && test !== 'testing' && (
                <div className={`set-test ${test}`}>
                  {test === 'ok' ? '✓ Connected — the token is valid.' : '✕ The token was rejected or the API is unreachable.'}
                </div>
              )}

              <div className="set-row col">
                <div className="set-row-text">
                  <div className="set-row-label">Access PIN</div>
                  <div className="set-row-hint">
                    {settings.accessPinSet
                      ? 'Set — any browser can sign in with the PIN from the gate; each gets its own revocable token.'
                      : 'Not set — set one to sign in from any device without pasting the API token.'}
                  </div>
                </div>
                <div className="set-pin-row">
                  <input
                    className="field-input"
                    type="password"
                    placeholder={settings.accessPinSet ? 'New PIN (4–64 characters)' : 'Choose a PIN (4–64 characters)'}
                    value={pin}
                    onChange={(e) => { setPin(e.target.value); setPinMsg(''); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && pin.trim().length >= 4) savePin(pin.trim()); }}
                  />
                  <button className="btn-repo" disabled={pin.trim().length < 4} onClick={() => savePin(pin.trim())}>
                    {settings.accessPinSet ? 'Change PIN' : 'Set PIN'}
                  </button>
                  {settings.accessPinSet && (
                    <button className="btn-cancel" onClick={() => savePin('')}>Disable</button>
                  )}
                </div>
                {pinMsg && <div className="set-test ok">✓ {pinMsg}</div>}
                <div className="set-detail-blurb">
                  Changing or disabling the PIN signs out every PIN-connected device. The API token
                  keeps working regardless.
                </div>
              </div>

              {/* ---- PIN devices (only when PIN is set and devices exist) ---- */}
              {settings.accessPinSet && devices.length > 0 && (
                <div className="set-devices">
                  <div className="set-devices-head">PIN-connected devices</div>
                  {devices.map((d) => (
                    <div key={d.id} className="set-device-row">
                      <div className="set-device-info">
                        <span className="set-device-label">{d.label || 'Unknown device'}</span>
                        {d.current && <span className="set-device-badge">this device</span>}
                        <span className="set-device-meta">
                          {d.lastUsed ? `last used ${d.lastUsed}` : d.createdAt ? `signed in ${new Date(d.createdAt).toLocaleDateString()}` : 'never used'}
                        </span>
                      </div>
                      <div className="set-row-actions">
                        {revokeConfirm === d.id ? (
                          <>
                            <button className="btn-danger" onClick={() => revokeDevice(d)}>
                              {d.current ? 'Sign out this device?' : 'Really revoke?'}
                            </button>
                            <button className="btn-cancel" onClick={() => setRevokeConfirm(null)}>Cancel</button>
                          </>
                        ) : (
                          <button className="btn-cancel" onClick={() => setRevokeConfirm(d.id)}>
                            {d.current ? 'Sign out' : 'Revoke'}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="set-row">
                <div className="set-row-text">
                  <div className="set-row-label">Sign out</div>
                  <div className="set-row-hint">Clears the token from this browser and returns to the gate.</div>
                </div>
                <div className="set-row-actions">
                  <button className="btn-cancel" onClick={signOut}>Sign out</button>
                </div>
              </div>

              <div className="set-note">
                Rotating the real token is a server env change (<span className="mono">API_TOKEN</span>), not done here.
              </div>
            </section>
          </div>
        ))}
      </div>
    </div>
  );
}

function Switch({
  label, hint, checked, onChange,
}: {
  label: string; hint: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-row-label">{label}</div>
        <div className="set-row-hint">{hint}</div>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`switch ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-knob" />
      </button>
    </div>
  );
}
