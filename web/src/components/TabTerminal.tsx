import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import {
  getTabTermPrefs, setTabTermPrefs, getDetachedSessions, killDetachedSession, type TabAgentKey,
} from '../store';
import { go } from '../lib/route';
import { consoleSessionName } from '../lib/agentConsole';

// The xterm lives in its own module and is fetched on the press that opens a
// console — see TabTerminalPane.tsx. Every project screen renders this strip;
// almost none of them open it, and xterm is a quarter of a megabyte.
const ConsolePane = lazy(() => import('./TabTerminalPane'));

// THE TAB AGENT'S CONSOLE (#379, #380) — a real Claude session, running AS the
// agent, on the tab that agent is bound to, in the same position on every one.
//
// The ✧ buttons are the agent asked a question: one prompt, one JSON answer,
// over in forty seconds. That covers the shapes somebody anticipated. It does
// not cover "this board is wrong in a way no template names", which is most of
// what actually happens on these four tabs — and the answer to that has always
// been to go to the Terminal screen, remember which project you were in, open a
// session and re-explain the context you were just looking at. This is that
// session, opened where the work is.
//
// It is the SAME machinery as the Terminal screen: `openTerminal` over the
// relay to the host daemon, `cmd: 'claude'` inside tmux. Nothing here is a
// second implementation of a terminal — it is a second PLACE for one.
//
// #380 gave it the two things that made it a terminal rather than an agent:
//
//  • IT OPENS PRIMED. The briefing is composed server-side (`routes/console.js`)
//    and the daemon spawns claude with it appended to the system prompt, so the
//    session is the Auditor from turn zero instead of a blank prompt in a
//    checkout. Nothing is typed and nothing runs — see console-prime.js for why
//    a system prompt rather than a pasted brief.
//  • IT CAN BE ENDED FROM HERE. Closing the strip only DETACHES (that is the
//    point of tmux), which left ⏻ on the Terminal screen as the only way to
//    stop a session this strip had started. The two-step below is the same one
//    the Terminal screen's ⏻ uses, and for the same reason: the daemon refuses
//    to kill a name a client still holds, so the console detaches first and
//    kills once the host advertises the session as detached.
//
// The session name and its parse live in `lib/agentConsole.ts` — the Terminal
// screen reads it back to title these sessions, so composing it here would have
// put half the rule in a component that screen cannot import.
export type ConsoleStatus = 'shut' | 'connecting' | 'live' | 'closed' | 'error';

const STATUS_NOTE: Record<ConsoleStatus, string> = {
  shut: 'not open',
  connecting: 'connecting…',
  live: '',
  closed: 'session ended',
  error: '',
};

export function TabTerminal({ agentKey, agentName, slug, off }: {
  agentKey: TabAgentKey;
  agentName: string;
  slug: string;
  // The sentence to show INSTEAD, when this agent's console may not open. Empty
  // means it may — the caller has already read the agent state, so this
  // component never re-derives a reason of its own.
  off: string;
}) {
  const [prefs, setPrefs] = useState(() => getTabTermPrefs(agentKey));
  const [status, setStatus] = useState<ConsoleStatus>('shut');
  const [note, setNote] = useState('');
  // Whether the tmux session was already running when this attached. It is the
  // difference between "you are looking at what you left here" and "this just
  // started", and only the daemon can answer it (see stack-term.mjs).
  const [reattached, setReattached] = useState<boolean | null>(null);
  const [flash, setFlash] = useState('');
  // ⟳ remounts the pane rather than reaching into it for a reconnect(): the
  // socket, the xterm and the batching buffer are all torn down and rebuilt by
  // the same code path a first open uses, so there is one way a session starts.
  const [nonce, setNonce] = useState(0);
  // '' = it opened as the agent. Anything else is what it could NOT see, and it
  // is shown rather than kept, because a session primed and a session not
  // primed look identical until the agent answers something it should have
  // known (#380).
  const [primeWarn, setPrimeWarn] = useState('');
  // The two-step ⏻. A stray click in a strip of small glyph buttons must not
  // kill a Claude session mid-thought, and a modal for it would be heavier than
  // the act deserves — so the button asks, in place, and forgets in a few
  // seconds if it is ignored.
  const [endAsk, setEndAsk] = useState(false);
  const [ending, setEnding] = useState(false);
  const endTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const name = consoleSessionName(agentKey, slug);
  const write = (p: { open: boolean; tall: boolean }) => { setPrefs(p); setTabTermPrefs(agentKey, p); };

  // END IT FOR REAL, in the two steps the daemon's own rule forces: closing the
  // console detaches the tmux client, and only THEN does the host advertise the
  // session as detached — the kill route refuses a name a client still holds,
  // which is what stops one browser killing another's session. So this shuts
  // the strip, waits for the name to appear in the detached list, and kills it.
  //
  // A name the host never advertises inside the window is NOT killed: it stays
  // detached and is killable by hand from the Terminal screen. A kill that
  // quietly did not land must never read as one that did, so the strip says
  // what happened rather than assuming.
  const endSession = async () => {
    setEndAsk(false);
    setEnding(true);
    write({ ...prefs, open: false });
    try {
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const list = await getDetachedSessions().catch(() => []);
        if (!list.some((d) => d.name === name)) continue;
        await killDetachedSession(name);
        setFlash('session ended');
        return;
      }
      setFlash('still running — end it from the Terminal screen');
    } catch (e) {
      setFlash(e instanceof Error ? e.message : 'could not end it');
    } finally {
      setEnding(false);
    }
  };
  useEffect(() => {
    if (!endAsk) return;
    endTimer.current = setTimeout(() => setEndAsk(false), 4000);
    return () => clearTimeout(endTimer.current);
  }, [endAsk]);

  // A console that is switched off but was left open on this device must not
  // sit there as a dead black box. The state is the DEVICE's; whether it may
  // run is the server's, and the server wins.
  const open = prefs.open && !off;

  useEffect(() => { if (!open) { setStatus('shut'); setReattached(null); setPrimeWarn(''); } }, [open]);
  useEffect(() => {
    if (!flash) return;
    // Long enough to read a sentence, since one of these is now "it did not
    // die, go and end it over there" rather than a copy receipt.
    const t = setTimeout(() => setFlash(''), flash.length > 16 ? 4000 : 1600);
    return () => clearTimeout(t);
  }, [flash]);

  if (off) {
    return (
      <div className="tabterm off">
        <span className="tabterm-dot off" />
        <span className="tabterm-name">{agentName}</span>
        <span className="tabterm-why">{off} Its live session is hidden until then.</span>
      </div>
    );
  }

  return (
    <div className={`tabterm${open ? ' open' : ''}${prefs.tall ? ' tall' : ''}`}>
      <div className="tabterm-head">
        <button className="tabterm-chev" onClick={() => write({ ...prefs, open: !prefs.open })}
          title={open ? `Close the ${agentName}'s session` : `Open the ${agentName}'s session`}>
          {open ? '▾' : '▸'}
        </button>
        <span className={`tabterm-dot ${status}`} />
        <button className="tabterm-name" onClick={() => write({ ...prefs, open: !prefs.open })}>
          {agentName}
        </button>
        <span className="tabterm-tag">live session</span>
        <span className="tabterm-sess" title="The tmux session on the host — the same one from any device">{name}</span>
        <span className="tabterm-status">
          {flash || (ending ? 'ending…' : '') || STATUS_NOTE[status] || note
            || (reattached === true ? 're-attached' : reattached === false ? `spawned as ${agentName}` : '')}
        </span>
        {/* What the agent could NOT see, hard against the name it is running
            under. A briefing that half-landed is the one state where the strip
            is claiming more than it can back up, so it is drawn as a warning
            rather than folded into the status line's rotation. */}
        {open && primeWarn && <span className="tabterm-warn" title={primeWarn}>⚠ {primeWarn}</span>}
        <div className="tabterm-acts">
          {open && (
            <>
              <button className="tabterm-act" onClick={() => setNonce((n) => n + 1)}
                title="Re-attach — or start a new session if this one ended">⟳</button>
              {/* Words, not glyphs. The header is set in the mono face, where
                  half the obvious icons for "make this taller" are either tofu
                  or indistinguishable from a minimise. */}
              <button className="tabterm-act" onClick={() => write({ ...prefs, tall: !prefs.tall })}
                title={prefs.tall ? 'Back to the short console' : 'Give it more room'}>
                {prefs.tall ? 'short' : 'tall'}
              </button>
              <button className="tabterm-act" onClick={() => go.terminal(slug, name)}
                title="Open this session on the Terminal screen">⤢</button>
              {/* ⏻ ENDS IT — the ⌄ chevron beside it only detaches, which is
                  the whole point of tmux and also why this button has to exist:
                  without it, a session started here could only be stopped from
                  another screen. Named the same as the Terminal screen's, so
                  the two endings are told apart in one vocabulary. */}
              {endAsk ? (
                <button className="tabterm-act warn" onClick={() => void endSession()}
                  title={`Kill ${name} on the host — the ${agentName} loses this conversation`}>
                  end it?
                </button>
              ) : (
                <button className="tabterm-act" disabled={ending} onClick={() => setEndAsk(true)}
                  title={`End this session — kills ${name} on the host, rather than just detaching`}>
                  ⏻
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {open && (
        <Suspense fallback={<div className="tabterm-holder gitbash" />}>
          <ConsolePane key={nonce} agentKey={agentKey} name={name} slug={slug}
            onStatus={(s, n) => { setStatus(s); setNote(n); }}
            onReattached={setReattached}
            onPrimed={setPrimeWarn}
            onCopied={() => setFlash('copied')} />
        </Suspense>
      )}

      {!open && (
        <div className="tabterm-shut">
          A Claude session in <span className="mono">~/{slug}</span>, in tmux on the host — it keeps
          running when you close this. It opens <strong>as {agentName}</strong>, briefed with this
          tab&rsquo;s remit and what it shows right now; the ✧ buttons ask it one question, this is the
          conversation.
        </div>
      )}
    </div>
  );
}
