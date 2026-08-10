import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { openTerminal, getTermSessionPrefs } from '../store';
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
export default function ConsolePane({ name, slug, onStatus, onReattached, onCopied }: {
  name: string; slug: string;
  onStatus: (s: ConsoleStatus, note: string) => void;
  onReattached: (r: boolean | null) => void;
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

    const connect = () => {
      wsRef.current?.close();
      onStatus('connecting', '');
      fit.fit();
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
      });
      wsRef.current = ws;

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
          writeBuf.push(b64decode(m.data));
          if (!rafPending) { rafPending = true; requestAnimationFrame(flushWrites); }
        } else if (m.t === 'ready') {
          // `reattached` is only sent when tmux is actually in use. On a host
          // without tmux there is no persistent session to have re-attached to,
          // and null says that rather than claiming a fresh one.
          onReattached(typeof m.reattached === 'boolean' ? m.reattached : null);
          onStatus('live', '');
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
    connect();

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
