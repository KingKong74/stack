import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { openTerminal } from '../store';
import { go } from '../lib/route';
import { PRODUCT_NAME } from '../lib/ui';

// The web terminal (#/terminal[?cwd=…]) — xterm.js over websocket to the host
// PTY daemon (terminal/stack-term.mjs via nginx /term). Behind the token gate
// like everything else; the daemon re-validates the token before spawning.
// Pick a directory (relative to the daemon's root, usually $HOME), pick shell
// or claude, connect.
type Status = 'idle' | 'connecting' | 'live' | 'closed' | 'error';

const b64encode = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64decode = (s: string) => {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

export function Terminal({ initialCwd = '' }: { initialCwd?: string }) {
  const [cwd, setCwd] = useState(initialCwd);
  const [cmd, setCmd] = useState<'shell' | 'claude'>('shell');
  const [status, setStatus] = useState<Status>('idle');
  const [note, setNote] = useState('');
  const holderRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // One xterm instance for the screen's lifetime; sessions attach to it.
  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      theme: { background: '#211d19', foreground: '#f3ede4', cursor: '#d98e63' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (holderRef.current) { term.open(holderRef.current); fit.fit(); }
    termRef.current = term;
    fitRef.current = fit;

    const onResize = () => {
      fit.fit();
      wsRef.current?.readyState === WebSocket.OPEN
        && wsRef.current.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
    };
    window.addEventListener('resize', onResize);
    const data = term.onData((d) => {
      wsRef.current?.readyState === WebSocket.OPEN
        && wsRef.current.send(JSON.stringify({ t: 'in', data: b64encode(d) }));
    });
    return () => {
      window.removeEventListener('resize', onResize);
      data.dispose();
      wsRef.current?.close();
      term.dispose();
    };
  }, []);

  const disconnect = () => { wsRef.current?.close(); wsRef.current = null; };

  const connect = () => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    disconnect();
    fit.fit();
    term.reset();
    setStatus('connecting');
    setNote('');
    const ws = openTerminal({ cwd: cwd.trim(), cmd, cols: term.cols, rows: term.rows });
    wsRef.current = ws;
    ws.addEventListener('message', (ev) => {
      let m: { t: string; data?: string; msg?: string; code?: number; cwd?: string };
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'out' && m.data) term.write(b64decode(m.data));
      else if (m.t === 'ready') { setStatus('live'); setNote(m.cwd || ''); term.focus(); }
      else if (m.t === 'exit') { setStatus('closed'); setNote(`exited (${m.code})`); }
      else if (m.t === 'err') { setStatus('error'); setNote(m.msg || 'terminal error'); }
    });
    ws.addEventListener('close', () => {
      setStatus((s) => (s === 'live' || s === 'connecting' ? 'closed' : s));
    });
    ws.addEventListener('error', () => {
      setStatus('error');
      setNote('Could not reach the terminal daemon — is stack-term running on the host?');
    });
  };

  return (
    <div className="term-screen">
      <div className="topbar">
        <div className="crumb">
          <span className="chev" onClick={go.dashboard}>‹</span>
          <span className="back" onClick={go.dashboard}>Projects</span>
          <span className="sep">/</span>
          <span className="here">Terminal</span>
        </div>
        <div className="right">
          <button className="btn-repo" onClick={go.control} title="Mission Control">Mission Control</button>
          <div className="brandmark"><span className="sq" /><span className="word">{PRODUCT_NAME}</span></div>
        </div>
      </div>

      <div className="page detail term-page">
        <div className="term-bar">
          <span className="term-lbl">~/</span>
          <input className="field-input term-cwd" value={cwd} placeholder="project directory (blank = home)"
            onChange={(e) => setCwd(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') connect(); }} />
          <div className="seg-control sm" role="tablist" aria-label="Session command">
            <button role="tab" aria-selected={cmd === 'shell'}
              className={`seg-opt ${cmd === 'shell' ? 'on' : ''}`} onClick={() => setCmd('shell')}>Shell</button>
            <button role="tab" aria-selected={cmd === 'claude'}
              className={`seg-opt ${cmd === 'claude' ? 'on' : ''}`} onClick={() => setCmd('claude')}>Claude</button>
          </div>
          {status === 'live'
            ? <button className="btn-cancel sm" onClick={disconnect}>Disconnect</button>
            : <button className="btn-submit sm" onClick={connect} disabled={status === 'connecting'}>
                {status === 'connecting' ? 'Connecting…' : 'Connect'}
              </button>}
          <span className={`term-status ${status}`}>
            {status === 'live' ? `● live ${note}` : status === 'closed' ? '○ closed' : status === 'error' ? `✗ ${note}` : ''}
          </span>
        </div>
        <div className="term-holder" ref={holderRef} />
      </div>
    </div>
  );
}
