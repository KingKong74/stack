import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { openTerminal, getTermSessionPrefs, getAgentConsolePrime, type TabAgentKey } from '../store';
import { wireTermClipboard } from '../lib/termClipboard';
import { b64encode, b64decode, GIT_BASH_THEME } from '../lib/termWire';
import type { ConsoleStatus } from './TabTerminal';

// The xterm half of a tab agent's console (#379), split into its own module for
// ONE reason: xterm and its fit addon are a quarter of a megabyte, and every
// project screen renders the console strip while almost none of them open it.
// TabTerminal lazy-imports this, so the cost is paid by the press that asks for
// a session and by nothing else. The Terminal screen is code-split the same way
// and for the same reason.
//
// Mounted only while the console is open, which is what makes "open" mean
// "spawn or attach" and "close" mean "detach": the tmux session is untouched by
// either, so the work outlives the tab, the screen and the browser.

// How long the session's output must be quiet before a submitted command is
// sent, how long to wait for that quiet before sending anyway, and the beat
// between the paste and its Enter. See submitAtPrompt for why each exists.
const SETTLE_MS = 1200;
const SETTLE_MAX = 25_000;
const ENTER_DELAY = 150;

export default function ConsolePane({
  agentKey, name, slug, onStatus, onReattached, onPrimed, onOpeners, onCopied,
}: {
  agentKey: TabAgentKey; name: string; slug: string;
  onStatus: (s: ConsoleStatus, note: string) => void;
  onReattached: (r: boolean | null) => void;
  // #380 — what the session was spawned KNOWING: '' when it opened primed,
  // otherwise the reason it did not. Reported rather than swallowed, because an
  // owner typing at an agent that cannot see the tab has no other way to find
  // out (the session looks identical).
  onPrimed: (why: string) => void;
  // The tab's openers, plus the one way to type at this session's prompt. Both
  // come out of the SAME briefing fetch, so the buttons the strip draws are
  // exactly the list the session was primed with — and they arrive together,
  // because a menu with nothing to type into is a row of dead buttons.
  // The channel to the session's prompt, handed up once the socket is live.
  // TWO functions, because Stack does two different things at that prompt and
  // must never confuse them: `type` puts text there and leaves it (the #380
  // openers, and every other Stack surface — the Enter is the owner's), while
  // `submit` types AND presses Enter. `submit` exists for the Arrange panel's
  // quick commands alone, on the owner's explicit call; see TabTerminal.
  onOpeners: (
    list: { label: string; ask: string }[],
    type: (s: string) => void,
    submit: (s: string) => void,
  ) => void;
  onCopied: () => void;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Consolas, 'Courier New', ui-monospace, Menlo, monospace",
      theme: GIT_BASH_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (holderRef.current) { term.open(holderRef.current); fit.fit(); }
    const unwireClipboard = wireTermClipboard(term, onCopied);

    // Set by the cleanup, so a briefing that lands after the console was closed
    // never opens a socket nobody is watching.
    let disposed = false;

    const connect = async () => {
      wsRef.current?.close();
      onStatus('connecting', '');
      fit.fit();
      // #380 — the briefing, fetched on EVERY open rather than cached: it
      // carries a snapshot of the tab, and a cached one would be the stale
      // state its own header warns the agent about. The daemon ignores it when
      // it re-attaches, so this costs one read against a session that is
      // already running and changes nothing about it.
      //
      // FAIL OPEN. A failed fetch opens the console unprimed and SAYS so; it
      // never withholds the session. The prime is what makes it the agent, but
      // a terminal in the right checkout is most of the value, and an owner
      // staring at a strip that refused to open a terminal because a briefing
      // query 500'd has been given the worst of both.
      let prime = '';
      let model = '';
      let openers: { label: string; ask: string }[] = [];
      try {
        const p = await getAgentConsolePrime(slug, agentKey);
        prime = p.prime;
        model = p.model;
        openers = p.openers || [];
        onPrimed(p.partial ? `primed, but Stack could not read the tab: ${p.partial}` : '');
      } catch (e) {
        onPrimed(`opened unprimed — ${e instanceof Error ? e.message : 'the briefing could not be fetched'}`);
      }
      if (disposed) return;
      const ws = openTerminal({
        // The project's checkout, jail-relative — the same cwd every other
        // "open a session on this project" path uses.
        cwd: slug,
        cmd: 'claude',
        cols: term.cols, rows: term.rows,
        tmuxSession: name,
        // The same device pref the Terminal screen honours (Settings →
        // Terminal). A console is not a different kind of session and must not
        // quietly run under a different permission posture to the tabs.
        skipPerms: getTermSessionPrefs().skipPermissions ? true : undefined,
        prime, model,
      });
      wsRef.current = ws;

      // TYPE, never run. An opener lands at the agent's prompt bracketed (so a
      // multi-line ask arrives as one paste rather than as three submitted
      // lines) and WITHOUT an Enter — the same rule the Terminal screen's brief
      // paste and the ✧ assist follow, and the reason a console is safe to put
      // one press away: nothing Stack composes is ever submitted for the owner.
      const paste = (text: string) => {
        const live = wsRef.current;
        if (live?.readyState !== WebSocket.OPEN || !text) return false;
        live.send(JSON.stringify({ t: 'in', data: b64encode(`\x1b[200~${text}\x1b[201~`) }));
        term.focus();
        return true;
      };
      const typeAtPrompt = (text: string) => { paste(text); };

      // TYPE **AND** SUBMIT — the one path in Stack that presses Enter for you,
      // and it waits for the prompt to be there before it does.
      //
      // A freshly spawned `claude` is not ready the instant the socket says
      // ready: the TUI is still painting, and text sent into that window is
      // swallowed or lands half-composed. There is no "ready" signal to wait
      // for — the daemon relays bytes, not application state — so the proxy is
      // OUTPUT GOING QUIET: the session is still writing while it boots, and it
      // stops when it is waiting for you. Quiet for SETTLE_MS, or give up
      // waiting after SETTLE_MAX and send anyway rather than silently dropping
      // the command the owner pressed for.
      //
      // The Enter is a SEPARATE frame a beat later, not \r on the end of the
      // paste: inside a bracketed paste a newline is a literal newline, so a
      // multi-line brief with the Enter glued on submits nothing and leaves the
      // prompt full of text.
      const submitAtPrompt = (text: string) => {
        if (!text) return;
        const started = Date.now();
        const tick = () => {
          if (disposed) return;
          const quiet = Date.now() - lastOut;
          if (quiet < SETTLE_MS && Date.now() - started < SETTLE_MAX) {
            setTimeout(tick, 150);
            return;
          }
          if (!paste(text)) return;
          setTimeout(() => {
            const live = wsRef.current;
            if (disposed || live?.readyState !== WebSocket.OPEN) return;
            live.send(JSON.stringify({ t: 'in', data: b64encode('\r') }));
          }, ENTER_DELAY);
        };
        tick();
      };

      // When output last arrived, which is how submitAtPrompt knows the TUI has
      // finished painting. Seeded at connect so a session that says nothing at
      // all still becomes "quiet" rather than waiting out SETTLE_MAX.
      let lastOut = Date.now();

      // Same write-batching as the Terminal screen: high-throughput output
      // arrives as dozens of tiny frames, and one rAF flush per batch keeps
      // xterm's dispatch off the critical path.
      let rafPending = false;
      const writeBuf: Uint8Array[] = [];
      const flushWrites = () => {
        rafPending = false;
        if (!writeBuf.length) return;
        let total = 0;
        for (const b of writeBuf) total += b.length;
        const merged = new Uint8Array(total);
        let off = 0;
        for (const b of writeBuf) { merged.set(b, off); off += b.length; }
        writeBuf.length = 0;
        term.write(merged);
      };

      ws.addEventListener('message', (ev) => {
        let m: { t: string; data?: string; msg?: string; code?: number; tmuxSession?: string; reattached?: boolean };
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'out' && m.data) {
          lastOut = Date.now();
          writeBuf.push(b64decode(m.data));
          if (!rafPending) { rafPending = true; requestAnimationFrame(flushWrites); }
        } else if (m.t === 'ready') {
          // `reattached` is only sent when tmux is actually in use. On a host
          // without tmux there is no persistent session to have re-attached to,
          // and null says that rather than claiming a fresh one.
          onReattached(typeof m.reattached === 'boolean' ? m.reattached : null);
          onStatus('live', '');
          // The openers go up only once there is a session to type into — a
          // menu drawn beside a socket that never opened would be four buttons
          // that silently do nothing.
          onOpeners(openers, typeAtPrompt, submitAtPrompt);
          term.focus();
        } else if (m.t === 'exit') {
          onStatus('closed', `exited (${m.code})`);
          term.write('\r\n\x1b[90m[session ended — ⟳ to start a new one]\x1b[0m\r\n');
        } else if (m.t === 'err') {
          onStatus('error', m.msg || 'terminal error');
          term.write(`\r\n\x1b[91m${m.msg || 'terminal error'}\x1b[0m\r\n`);
        }
      });
      ws.addEventListener('error', () => onStatus('error', 'Could not reach the terminal relay.'));
    };
    void connect();

    const data = term.onData((d) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', data: b64encode(d) }));
    });

    // The holder is what resizes here, not the window: collapsing the console,
    // the tall toggle and the tab's own reflow all move it while the window
    // stands still. Watching the element covers all of them, and the debounce
    // means the daemon is only ever told the settled size.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let sentCols = 0;
    let sentRows = 0;
    const onResize = () => {
      fit.fit();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const ws = wsRef.current;
        if (term.cols === sentCols && term.rows === sentRows) return;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
          sentCols = term.cols;
          sentRows = term.rows;
        }
      }, 80);
    };
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(() => onResize());
    if (holderRef.current) ro.observe(holderRef.current);

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      data.dispose();
      unwireClipboard();
      // Closing the socket detaches the tmux client. The session — and the
      // Claude inside it — keeps running on the host; that is the whole point.
      wsRef.current?.close();
      term.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="tabterm-holder gitbash" ref={holderRef} />;
}
