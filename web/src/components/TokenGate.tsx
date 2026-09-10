import { useRef, useState } from 'react';
import { setToken, verifyToken, loginWithPin } from '../store';
import { PRODUCT_NAME } from '../lib/ui';
import { Brandmark, StackMark } from './Brandmark';
import { HowToGuide } from './HowToGuide';

// FIRST LOAD — the landing page, and the gate at the bottom of it.
//
// Claude Design project "Stack Project Logo Design" (ac7ecb0c), artboard
// "Stack Landing v2". The screen it replaced was a card centred in an empty
// viewport with a paragraph over it: it told you the lock existed and nothing
// about what was behind it. This one walks the four nouns — project → task →
// run → pipeline — shows one project with three agents working it, and only
// then asks for the token. The gate did not change; what surrounds it did.
//
// TWO THINGS THE DESIGN DECIDES THAT LOOK LIKE DETAILS AND ARE NOT:
//
// · THE MOCK IS LABELLED "Illustrative — not live data" IN THE SECTION HEAD,
//   because it is a signed-OUT screen — there is no session, so nothing on it
//   could be live, and a console screenshot with plausible numbers on it is a
//   claim about your data unless something says otherwise. Keep the label with
//   the mock if either moves.
// · "Have a token?" SCROLLS, it does not link. The app is hash-routed
//   (lib/route.ts), so an `href="#gate"` would be parsed as a route — it falls
//   through to the dashboard today, which is harmless right up until someone
//   adds a `/gate` route and this quietly starts navigating.
//
// The gate itself is unchanged in behaviour: paste the shared API token, or —
// once an access PIN is set in Settings — sign in with the PIN from any device
// (the server mints this browser its own revocable token). Either way the
// token is kept in localStorage and sent on every request; any 401 clears it
// and brings this screen back.

/** The four nouns, in the order the product goes through them. */
const NOUNS = [
  { n: '01', title: 'Projects', body: 'One per thing you are building, holding its state, its history and where it got to last.' },
  { n: '02', title: 'Tasks', body: 'Written by you or pulled out of a push. Scoped small enough that handing one over is a decision, not a gamble.' },
  { n: '03', title: 'Runs', body: 'A task handed to an agent. Full logs, a diff, and a verdict waiting for you at the end.' },
  { n: '04', title: 'Pipelines', body: 'Runs chained into a route — build, check, review, land — so the next step starts without you.', accent: true },
];

const ONE_LINERS = [
  { title: 'Agents in their own lanes', body: 'Several runs at once, each held to one area of the project so parallel branches do not collide.' },
  { title: 'Computed progress', body: 'Worked out from what has actually landed, not from a slider you dragged.' },
  { title: 'An overnight queue', body: 'Leave a list at the end of the day. Stack works through it and has the verdicts ready by morning.' },
  { title: 'Logs and a terminal', body: 'The full output of every run, plus a web terminal onto the host when you would rather just type.' },
];

export function TokenGate() {
  const [mode, setMode] = useState<'token' | 'pin'>('token');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);

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

  const toGate = () => {
    input.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input.current?.focus({ preventScroll: true });
  };

  return (
    <div className="land">
      <header className="land-nav">
        <Brandmark size={28} />
        <button className="land-navlink" onClick={toGate}>Have a token?</button>
      </header>

      <section className="land-hero">
        <div className="land-glow" aria-hidden="true" />
        <div className="land-glow lime" aria-hidden="true" />
        <div className="land-heromark">
          <StackMark size={80} title={PRODUCT_NAME} />
          <span className="land-eyebrow accent">Project management for one person and several agents</span>
        </div>
        <h1 className="land-h1">You plan the work. The agents build it.</h1>
        <p className="land-lede">
          {PRODUCT_NAME} turns a project into tasks, tasks into runs, and runs into pipelines you
          can walk away from. Hand one task to an agent, or hand out five and let them work in
          parallel.
        </p>
        <div className="land-hero-pills">
          <span className="land-pill info"><i /> 3 runs in flight</span>
          <span className="land-pill ok"><i /> 2 awaiting verdict</span>
          <span className="land-pill-plain">Self-hosted</span>
        </div>
      </section>

      <section className="land-band">
        <div className="land-band-head">
          <span className="land-eyebrow">The four nouns</span>
          <span className="land-band-note">project → task → run → pipeline</span>
        </div>
        <div className="land-nouns">
          {NOUNS.map((n) => (
            <div className="land-noun" key={n.n}>
              <span className={`land-noun-n${n.accent ? ' accent' : ''}`}>{n.n}</span>
              <h2>{n.title}</h2>
              <p>{n.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="land-band land-mockband">
        <div className="land-band-head">
          <span className="land-eyebrow">Three agents, one project</span>
          <span className="land-band-note">Illustrative — not live data</span>
        </div>
        <div className="land-mock" aria-hidden="true">
          <div className="land-mock-cols">

            <div className="land-mock-pane">
              <div className="land-mock-head">
                <span className="t">Tideline · Tasks</span>
                <span className="n">7 open</span>
              </div>
              <div className="land-mock-task">
                <span className="t">Split the ingest worker so retries stop blocking</span>
                <div className="m">
                  <span className="id">#118</span>
                  <span className="tag info">Run in flight</span>
                  <span className="area">ingest</span>
                </div>
              </div>
              <div className="land-mock-task">
                <span className="t">Timezone off-by-one in the digest email</span>
                <div className="m">
                  <span className="id">#119</span>
                  <span className="tag ok">Awaiting verdict</span>
                  <span className="area">notify</span>
                </div>
              </div>
              <div className="land-mock-task queued">
                <span className="t">Seed script for local fixtures</span>
                <div className="m">
                  <span className="id">#121</span>
                  <span className="tag neutral">Queued</span>
                </div>
              </div>
            </div>

            <div className="land-mock-runs">
              <div className="land-mock-head">
                <span className="t">Runs</span>
                <span className="n">3 in flight</span>
              </div>

              <div className="land-run">
                <div className="land-run-top"><span>agent-1 · ingest</span><span className="n">82%</span></div>
                <div className="land-run-track"><div className="land-run-fill" style={{ width: '82%', background: 'var(--blue-500)' }} /></div>
              </div>
              <div className="land-run">
                <div className="land-run-top"><span>agent-2 · notify</span><span className="n">54%</span></div>
                <div className="land-run-track"><div className="land-run-fill" style={{ width: '54%', background: 'var(--blue-400)' }} /></div>
              </div>
              <div className="land-run">
                <div className="land-run-top"><span>agent-3 · web</span><span className="done">done</span></div>
                <div className="land-run-track"><div className="land-run-fill" style={{ width: '100%', background: 'var(--lime-500)' }} /></div>
              </div>

              <div className="land-mock-log">
                <span className="dim">run 118 · agent-1</span>
                <span>moved backoff into its own module</span>
                <span className="dim">ran 41 checks · <span className="ok">all passed</span></span>
              </div>

              <div className="land-mock-foot">
                <span className="btn">Review diff</span>
                <span className="lnk">Open logs</span>
              </div>
            </div>

          </div>

          <div className="land-pipeline">
            <span className="dim">pipeline</span>
            <span className="step ok">build</span>
            <span className="dim">→</span>
            <span className="step ok">check</span>
            <span className="dim">→</span>
            <span className="step info">review</span>
            <span className="dim">→</span>
            <span className="step neutral">land</span>
          </div>
        </div>
      </section>

      <section className="land-band land-oneliners">
        {ONE_LINERS.map((o) => (
          <div key={o.title}>
            <h3>{o.title}</h3>
            <p>{o.body}</p>
          </div>
        ))}
      </section>

      <section className="land-gate">
        <div className="gate-card">
          <Brandmark size={26} />
          <div className="gate-title">{mode === 'pin' ? 'Sign in with your PIN' : 'Access token'}</div>
          <div className="gate-sub">
            {mode === 'pin'
              ? 'The access PIN set in Settings. This browser gets its own token — nothing to paste.'
              : "This instance is self-hosted and locked behind one shared token. Paste it to continue — it's kept in this browser only."}
          </div>
          <input
            ref={input}
            className="field-input"
            type="password"
            placeholder={mode === 'pin' ? 'Access PIN' : 'Paste your token'}
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
          {error && <div className="gate-error">{error}</div>}
          <button className="btn-accent gate-btn" onClick={submit} disabled={busy || !value.trim()}>
            {busy ? 'Checking…' : `Unlock ${PRODUCT_NAME}`}
          </button>
          <div className="gate-foot">
            {mode === 'pin'
              ? 'Self-hosted. This browser gets its own revocable token.'
              : 'Self-hosted, one shared token, no signup.'}
          </div>
          <button className="gate-help-toggle"
            onClick={() => { setMode((m) => (m === 'pin' ? 'token' : 'pin')); setValue(''); setError(''); }}>
            {mode === 'pin' ? 'Use the API token instead' : 'Sign in with a PIN instead'}
          </button>
          {mode === 'token' && (
            <button className="gate-help-toggle" onClick={() => setHelpOpen((o) => !o)}>
              {helpOpen ? 'Hide help' : 'Where do I find the token?'}
            </button>
          )}
          {helpOpen && mode === 'token' && (
            <div className="gate-help">
              It's the <span className="mono">API_TOKEN</span> this server was deployed with — the
              value set in the server's <span className="mono">.env</span> or compose environment,
              chosen by whoever set this instance up. If that's you, it's in your deploy config for{' '}
              <span className="mono">{window.location.host}</span>; if someone else runs it, ask
              them to share it. There's no signup — one token is the whole lock.
            </div>
          )}
          <button className="gate-link" onClick={() => setGuideOpen(true)}>
            New here? How {PRODUCT_NAME} works →
          </button>
        </div>
      </section>

      {guideOpen && <HowToGuide onClose={() => setGuideOpen(false)} />}
    </div>
  );
}
