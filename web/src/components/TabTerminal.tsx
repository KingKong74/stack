import { Suspense, lazy, useEffect, useState } from 'react';
import { getTabTermPrefs, setTabTermPrefs, type TabAgentKey } from '../store';
import { go } from '../lib/route';

// The xterm lives in its own module and is fetched on the press that opens a
// console — see TabTerminalPane.tsx. Every project screen renders this strip;
// almost none of them open it, and xterm is a quarter of a megabyte.
const ConsolePane = lazy(() => import('./TabTerminalPane'));

// THE TAB AGENT'S CONSOLE (#376) — a real Claude session, on the tab the agent
// is bound to, in the same position on every one of them.
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
// ---- the session name, and everything that follows from it -----------------
//
// `stack-term-<agent key>-<project slug>`, and this function is the only place
// it is composed. Two consequences, both wanted:
//
//  • DETERMINISTIC, so it is one session. The Terminal screen generates a random
//    name per tab because its tabs are ad-hoc; a tab agent's console is not — the
//    Quality console of the "stack" project is a single thing, and reloading the
//    page, opening a second browser or coming back on the phone must re-attach to
//    it rather than leave three Claudes running against one checkout. `tmux
//    new-session -A` does the attach-or-create in one command.
//  • THE `stack-term-` PREFIX IS LOAD-BEARING. It is what puts a session on the
//    running-sessions strip, what the browser's mirror and kill paths will list,
//    and what the idle reaper keys off (`termIdleHours`). All three are correct
//    for a console: it is an attended Claude session like any other, and one left
//    open on a tab for six hours with no output is exactly what the reaper is
//    for. When it is reaped the daemon's exit frame arrives here and the console
//    says the session ended, rather than going quietly dead.
//
// A slug is `[a-z0-9-]` in practice, but it arrives from the URL, so it is
// sanitised and capped rather than trusted: the daemon's `validName` refuses
// anything outside `stack-[A-Za-z0-9_-]{1,64}` and would fail the start frame
// with no useful sentence for the owner.
export const consoleSessionName = (agentKey: TabAgentKey, slug: string) =>
  `stack-term-${agentKey}-${slug.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40)}`;

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

  const name = consoleSessionName(agentKey, slug);
  const write = (p: { open: boolean; tall: boolean }) => { setPrefs(p); setTabTermPrefs(agentKey, p); };

  // A console that is switched off but was left open on this device must not
  // sit there as a dead black box. The state is the DEVICE's; whether it may
  // run is the server's, and the server wins.
  const open = prefs.open && !off;

  useEffect(() => { if (!open) { setStatus('shut'); setReattached(null); } }, [open]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(''), 1600);
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
          {flash || STATUS_NOTE[status] || note
            || (reattached === true ? 're-attached' : reattached === false ? 'new session' : '')}
        </span>
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
            </>
          )}
        </div>
      </div>

      {open && (
        <Suspense fallback={<div className="tabterm-holder gitbash" />}>
          <ConsolePane key={nonce} name={name} slug={slug}
            onStatus={(s, n) => { setStatus(s); setNote(n); }}
            onReattached={setReattached}
            onCopied={() => setFlash('copied')} />
        </Suspense>
      )}

      {!open && (
        <div className="tabterm-shut">
          A Claude session in <span className="mono">~/{slug}</span>, in tmux on the host — it keeps
          running when you close this. {agentName} is this tab&rsquo;s agent; the ✧ buttons ask it one
          question, this is the conversation.
        </div>
      )}
    </div>
  );
}
