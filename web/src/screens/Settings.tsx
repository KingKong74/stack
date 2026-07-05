import { useEffect, useState } from 'react';
import type { Settings as SettingsData, CheckpointDetail } from '../types';
import {
  getSettings, patchSettings, getToken, clearToken, verifyToken, AuthError,
  getThemePref, setThemePref, type ThemePref,
} from '../store';
import { go } from '../lib/route';
import { PRODUCT_NAME } from '../lib/ui';
import { DIRECTIVES } from '../lib/brief';

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

export function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [test, setTest] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [theme, setTheme] = useState<ThemePref>(() => getThemePref());

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

  return (
    <div>
      <div className="topbar">
        <div className="crumb">
          <span className="chev" onClick={go.dashboard}>‹</span>
          <span className="back" onClick={go.dashboard}>Projects</span>
          <span className="sep">/</span>
          <span className="here">Settings</span>
        </div>
        <div className="right">
          <div className="brandmark"><span className="sq" /><span className="word">{PRODUCT_NAME}</span></div>
        </div>
      </div>

      <div className="page detail" style={{ maxWidth: 760 }}>
        <div className="dash-head" style={{ marginBottom: 28 }}>
          <div>
            <div className="dash-title">Settings</div>
            <div className="dash-count">How {PRODUCT_NAME} records your work, and the access it uses.</div>
          </div>
        </div>

        {error && <div className="action-error">{error}</div>}

        {loading || !settings ? (
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
        )}
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
