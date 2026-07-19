import { useEffect, useState } from 'react';
import type { Settings as SettingsData, CheckpointDetail } from '../types';
import {
  getSettings, patchSettings, getToken, clearToken, verifyToken, AuthError,
  getThemePref, setThemePref, type ThemePref,
  getDeletedProjects, restoreProject, purgeProject, type DeletedProject,
} from '../store';
import { go } from '../lib/route';
import { PRODUCT_NAME } from '../lib/ui';
import { DIRECTIVES } from '../lib/brief';
import { ControlPanel } from './Control';

const THEMES: { key: ThemePref; label: string }[] = [
  { key: 'system', label: 'System' }, { key: 'light', label: 'Light' }, { key: 'dark', label: 'Dark' },
];

// Mirrors Mission Control's knob values — the two surfaces PATCH the same settings.
const CAPS: { minutes: number; label: string }[] = [
  { minutes: 60, label: '1 hour' }, { minutes: 120, label: '2 hours' },
  { minutes: 180, label: '3 hours' }, { minutes: 360, label: '6 hours' },
];
const BUDGETS: { tokens: number; label: string }[] = [
  { tokens: 500_000, label: '500k' }, { tokens: 1_500_000, label: '1.5M' },
  { tokens: 5_000_000, label: '5M' }, { tokens: 0, label: '∞ Unlimited' },
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
  const [deleted, setDeleted] = useState<DeletedProject[]>([]);
  const [purgeArmed, setPurgeArmed] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pinMsg, setPinMsg] = useState('');

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
      .then((s) => { if (live) { setSettings(s); setError(''); } })
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
      setPinMsg(value ? 'PIN saved. All PIN-connected devices were signed out — sign back in with the new PIN.' : 'PIN sign-in disabled; PIN-connected devices were signed out.');
    } catch (e) {
      if (e instanceof AuthError) return;
      setError((e as Error)?.message || 'Could not save the PIN.');
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

            {/* ---- Autopilot (mirrors Mission Control's console — same settings) ---- */}
            <section className="set-card">
              <div className="set-card-head">
                <div className="set-card-title">Autopilot</div>
                <div className="set-card-sub">
                  The overnight runner builds approved roadmap items unattended (up to the items-per-night
                  cap), each on a reviewable <span className="mono">auto/</span> branch — never main, never
                  marked done. You steer it with the tools you already have: approve items into the board,
                  park human-only ones as skipped, and set direction via the north star and each
                  project's Directives card (injected into every unattended session).
                </div>
              </div>

              <Switch
                label="Armed"
                hint="Nightly runs and scheduled sessions only act while this is on. Run now stays manual-only."
                checked={settings.autopilotEnabled}
                onChange={(v) => update({ autopilotEnabled: v })}
              />

              <div className="set-row col">
                <div className="set-row-text">
                  <div className="set-row-label">Session cap</div>
                  <div className="set-row-hint">Wall-clock limit per unattended session — it's stopped at the cap.</div>
                </div>
                <div className="seg-control" role="tablist" aria-label="Autopilot session cap">
                  {CAPS.map((c) => (
                    <button key={c.minutes} role="tab" aria-selected={settings.autopilotMinutes === c.minutes}
                      className={`seg-opt ${settings.autopilotMinutes === c.minutes ? 'on' : ''}`}
                      onClick={() => update({ autopilotMinutes: c.minutes })}>
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="set-row col">
                <div className="set-row-text">
                  <div className="set-row-label">Token budget</div>
                  <div className="set-row-hint">
                    Per run, from each session's real usage. Unlimited = the session cap alone governs.
                  </div>
                </div>
                <div className="seg-control" role="tablist" aria-label="Autopilot token budget">
                  {BUDGETS.map((b) => (
                    <button key={b.tokens} role="tab" aria-selected={settings.autopilotTokens === b.tokens}
                      className={`seg-opt ${settings.autopilotTokens === b.tokens ? 'on' : ''}`}
                      onClick={() => update({ autopilotTokens: b.tokens })}>
                      {b.label}
                    </button>
                  ))}
                </div>
                <div className="set-detail-blurb">
                  The nightly time, items per night, per-project Run now and the session calendar live in
                  the <button className="linklike" onClick={() => go.control()}>Mission Control</button> tab.
                  In the morning: the review inbox holds Gemini's findings, the activity feed the
                  checkpoint, and the pushed branch waits for your merge-or-discard.
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
