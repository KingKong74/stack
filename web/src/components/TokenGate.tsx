import { useRef, useState } from 'react';
import { setToken, verifyToken, loginWithPin } from '../store';
import { PRODUCT_NAME } from '../lib/ui';
import { StackMark } from './Brandmark';

// FIRST LOAD — the title card, and the gate on it.
//
// Claude Design project 7f40db62, "Stack Landing", artboard 2a "Title card"
// (turn 2: logo, title, sign-in only). It replaced a scrolling landing page
// that pitched the product to someone who already runs it: whoever reaches
// this screen deployed the instance or was handed its PIN. So it is the mark,
// the name, one line, and the lock.
//
// THE MARK PLAYS ONCE, on the first focus of the field, and again on a click.
// The plates slide apart and settle (`.tcard-mark.play` in styles.css). It is
// drawn by StackMark like every other logo; only the wrapper animates, and the
// wrapper's key is bumped to restart it.
//
// The gate behaves as before: sign in with the access PIN set in Settings
// (the server mints this browser its own revocable token), or paste the shared
// API token. Either way the token is kept in localStorage and sent on every
// request; any 401 clears it and brings this screen back.

export function TokenGate() {
  const [mode, setMode] = useState<'pin' | 'token'>('pin');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [spin, setSpin] = useState(0);
  const played = useRef(false);

  const play = () => setSpin((s) => s + 1);
  const pick = (m: 'pin' | 'token') => { setMode(m); setValue(''); setError(''); };

  const submit = async () => {
    const t = value.trim();
    if (!t || busy) return;
    setBusy(true);
    setError('');
    if (mode === 'pin') {
      try {
        await loginWithPin(t); // stores the minted device token → dashboard
      } catch (e) {
        setError((e as Error)?.message || 'Sign-in failed.');
        setBusy(false);
      }
      return;
    }
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
    <div className="tcard">
      <div className="tcard-col">
        <div className="tcard-head">
          <button
            key={spin}
            className={`tcard-mark${spin ? ' play' : ''}`}
            onClick={play}
            aria-label={PRODUCT_NAME}
          >
            <StackMark size={72} />
          </button>
          <h1 className="tcard-word">{PRODUCT_NAME}</h1>
          <p className="tcard-line">Projects, tasks and the agents working on them.</p>
        </div>

        <form className="tcard-card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="tcard-seg" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'pin'}
              className={mode === 'pin' ? 'on' : ''} onClick={() => pick('pin')}>Access PIN</button>
            <button type="button" role="tab" aria-selected={mode === 'token'}
              className={mode === 'token' ? 'on' : ''} onClick={() => pick('token')}>API token</button>
          </div>
          <input
            className="tcard-input"
            type="password"
            aria-label={mode === 'pin' ? 'Access PIN' : 'API token'}
            placeholder={mode === 'pin' ? 'Access PIN' : 'Paste your token'}
            value={value}
            disabled={busy}
            onFocus={() => { if (!played.current) { played.current = true; play(); } }}
            onChange={(e) => setValue(e.target.value)}
          />
          {error && <div className="tcard-error">{error}</div>}
          <button type="submit" className="tcard-btn" disabled={busy || !value.trim()}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </form>

        <span className="tcard-foot">self-hosted · kept in this browser</span>
      </div>
    </div>
  );
}
