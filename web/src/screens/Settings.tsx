import { useEffect, useState } from 'react';
import type { Settings as SettingsData, CheckpointDetail, AuthDevice } from '../types';
import {
  getSettings, patchSettings, getToken, clearToken, verifyToken, AuthError,
  getThemePref, setThemePref, type ThemePref,
  getDeletedProjects, restoreProject, purgeProject, type DeletedProject,
  getAuthDevices, revokeAuthDevice,
  getTermSessionPrefs, setTermSessionPrefs, type TermSessionPrefs,
} from '../store';
import { go } from '../lib/route';
import { PRODUCT_NAME } from '../lib/ui';
import { DIRECTIVES } from '../lib/brief';
import { ControlPanel } from './Control';

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

export function Settings({ initialTab = 'settings' }: { initialTab?: 'settings' | 'control' }) {
  // One screen, two tabs: the app's settings, and Mission Control (#/control
  // deep-links straight onto the control tab).
  const [screenTab, setScreenTab] = useState<'settings' | 'control'>(initialTab);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [test, setTest] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [theme, setTheme] = useState<ThemePref>(() => getThemePref());
  // Terminal behaviour — device-local, like the theme.
  const [termPrefs, setTermPrefsState] = useState<TermSessionPrefs>(() => getTermSessionPrefs());
  const saveTermPrefs = (p: TermSessionPrefs) => { setTermPrefsState(p); setTermSessionPrefs(p); };
  const [deleted, setDeleted] = useState<DeletedProject[]>([]);
  const [purgeArmed, setPurgeArmed] = useState<string | null>(null);
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
    <div>
      <div className="topbar">
        <div className="crumb">
          <span className="chev" onClick={go.dashboard}>‹</span>
          <span className="back" onClick={go.dashboard}>Projects</span>
          <span className="sep">/</span>
          <span className="here">{screenTab === 'control' ? 'Mission Control' : 'Settings'}</span>
        </div>
        <div className="right">
          <div className="brandmark"><span className="sq" /><span className="word">{PRODUCT_NAME}</span></div>
        </div>
      </div>

      <div className="page detail" style={{ maxWidth: screenTab === 'control' ? 1080 : 760 }}>
        <div className="dash-head" style={{ marginBottom: 16 }}>
          <div>
            <div className="dash-title">{screenTab === 'control' ? 'Mission Control' : 'Settings'}</div>
            <div className="dash-count">
              {screenTab === 'control'
                ? 'Every project and its automation, from one point.'
                : `How ${PRODUCT_NAME} records your work, and the access it uses.`}
            </div>
          </div>
        </div>

        <div className="tabs">
          <button className={`tab ${screenTab === 'settings' ? 'on' : ''}`} onClick={() => setScreenTab('settings')}>Settings</button>
          <button className={`tab ${screenTab === 'control' ? 'on' : ''}`} onClick={() => setScreenTab('control')}>Mission Control</button>
          {/* Not a tab — the jump to the host terminal, up here beside them.
              Opens in the most recently touched project (the Terminal screen
              resolves the cwd itself when none is given). */}
          <button className="tab tab-term" onClick={() => go.terminal()}
            title="A real shell (or Claude) on the host, from any device — opens in your current project">
            ⌨ Terminal
          </button>
        </div>

        {screenTab === 'control' && <ControlPanel />}

        {screenTab === 'settings' && (error ? <div className="action-error">{error}</div> : null)}

        {screenTab === 'settings' && (loading || !settings ? (
          <div className="empty-state"><div className="big">Loading…</div></div>
        ) : (
          <>
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
                <button className="btn-accent" onClick={() => go.control()}>Open Mission Control →</button>
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
                { key: 'lane', label: 'Suggest a lane', hint: 'Only ever an already-open lane, and only when the note clearly belongs to it.' },
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
                <div className="set-card-sub">How the web terminal opens sessions on this device.</div>
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
          </>
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
