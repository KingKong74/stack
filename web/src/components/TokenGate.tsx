import { useState } from 'react';
import { setToken, verifyToken } from '../store';
import { PRODUCT_NAME } from '../lib/ui';
import { HowToGuide } from './HowToGuide';

// First-load landing: what Stack is, plus the token gate. The token is verified
// against the API, kept in localStorage, and sent on every request. Any 401
// clears it and brings this screen back. "Where do I find the token?" and the
// how-it-works guide are reachable from here so a fresh visitor isn't stuck
// staring at an unexplained password field.
export function TokenGate() {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  const submit = async () => {
    const t = value.trim();
    if (!t || busy) return;
    setBusy(true);
    setError('');
    try {
      const ok = await verifyToken(t);
      if (!ok) {
        setError('That token was rejected. Check it and try again.');
        setBusy(false);
        return;
      }
      setToken(t); // flips the app over to the dashboard
    } catch {
      setError('Could not reach the API. Is the server up?');
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <div className="gate-hero">
        <div className="brandmark" style={{ marginBottom: 14 }}>
          <span className="sq" /><span className="word">{PRODUCT_NAME}</span>
        </div>
        <div className="gate-tag">
          Your side-project command centre. Claude Code sessions checkpoint their work here —
          you pick up where you left off, review what happened while you were away, and steer
          what each project becomes.
        </div>

        <div className="gate-card">
          <div className="gate-title">Enter your API token</div>
          <div className="gate-sub">
            This instance is self-hosted and locked behind one shared token. Paste it to
            continue — it's kept in this browser only.
          </div>
          <input
            className="field-input"
            type="password"
            autoFocus
            placeholder="Bearer token"
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
          {error && <div className="gate-error">{error}</div>}
          <button className="btn-accent gate-btn" onClick={submit} disabled={busy || !value.trim()}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
          <button className="gate-help-toggle" onClick={() => setHelpOpen((o) => !o)}>
            {helpOpen ? 'Hide help' : 'Where do I find the token?'}
          </button>
          {helpOpen && (
            <div className="gate-help">
              It's the <span className="mono">API_TOKEN</span> this server was deployed with — the
              value set in the server's <span className="mono">.env</span> or compose environment,
              chosen by whoever set this instance up. If that's you, it's in your deploy config for{' '}
              <span className="mono">{window.location.host}</span>; if someone else runs it, ask
              them to share it. There's no signup — one token is the whole lock.
            </div>
          )}
        </div>

        <button className="gate-link" onClick={() => setGuideOpen(true)}>
          New here? How {PRODUCT_NAME} works →
        </button>
      </div>

      {guideOpen && <HowToGuide onClose={() => setGuideOpen(false)} />}
    </div>
  );
}
