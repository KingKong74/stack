import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  openTerminal, getTermSessionPrefs, getTermTmuxName, setTermTmuxName, clearTermTmuxName,
} from '../store';

// PolarisTerm (#209) — the Polaris tab's claude session. A real terminal over
// the host daemon (same transport as the Mission Control terminal, no external
// API): cwd = the project slug, tmux-backed so a closed tab detaches rather
// than dies, re-attached via a device-local mapping keyed separately from the
// Terminal screen's cwd map. On a FRESH session the kickoff prompt is
// auto-typed once claude's TUI settles — Polaris the planning copilot,
// grounded by the SessionStart hook's injected Stack context, turning agreed
// work into roadmap items via the API (manual source = automode-eligible).
// Default export so the Futures tab can React.lazy this module and keep
// xterm.js out of the main bundle (it shares the Terminal screen's chunk).

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

// mintty's default palette — matches the Terminal screen's git-bash look.
const THEME = {
  background: '#000000',
  foreground: '#bfbfbf',
  cursor: '#bfbfbf',
  selectionBackground: '#264f78',
  black: '#000000', red: '#bf0000', green: '#00bf00', yellow: '#bfbf00',
  blue: '#4040bf', magenta: '#bf00bf', cyan: '#00bfbf', white: '#bfbfbf',
  brightBlack: '#404040', brightRed: '#ff4040', brightGreen: '#40ff40',
  brightYellow: '#ffff40', brightBlue: '#6060ff', brightMagenta: '#ff40ff',
  brightCyan: '#40ffff', brightWhite: '#ffffff',
};

// One line (Enter submits once in claude's TUI). Planning-only by contract;
// the write path is the ordinary Stack API the human confirms in-conversation.
const kickoff = (slug: string) =>
  `You are Polaris, this project's planning and design copilot — planning only, no code changes this session. ` +
  `Ground yourself in the Stack context injected above (north star, roadmap, idea funnel, to-verify queue, blockers). ` +
  `Help me shape direction, pressure-test ideas and design concrete work: when I say "brainstorm" (or the funnel looks thin), ` +
  `propose two or three candidate futures grounded in the north star and recent activity; play devil's advocate before any idea is agreed, ` +
  `and for anything large author a short design doc first — approach, interfaces, data changes, risks — so executors build against ` +
  `an agreed design, not a title. When we agree something should be built, create it via the Stack API (STACK_API + STACK_TOKEN in ` +
  `~/.stack/env): POST $STACK_API/api/projects/${slug}/roadmap with {title, note, bucket: must|should|could, area, plan: [{text, done:false}, ...]} ` +
  `— put the design's steps in plan (the autopilot works them top-down) and manual items are immediately eligible for the overnight ` +
  `autopilot — and send looser directional ideas to POST .../futures with {title, note} instead. You can also dispatch executors from ` +
  `this chair: POST $STACK_API/api/autopilot/start with {slug: "${slug}", itemId} queues an executor session for an agreed item now, and ` +
  `POST $STACK_API/api/autopilot/schedule with {slug, atTime: "HH:MM", runDate: "YYYY-MM-DD" or days: [0-6], itemId} books one on the calendar. ` +
  `Always show me what you intend to create or dispatch and wait for my yes before POSTing. Start now with a short read of where the project stands and two or three directions worth discussing.`;

// Separate namespace from the Terminal screen's cwd map so a Polaris session
// and a plain ⌨ terminal in the same project never steal each other's tmux.
const tmuxKey = (slug: string) => `polaris:${slug}`;

type Status = 'connecting' | 'live' | 'closed' | 'error';

export default function PolarisTerm({ slug }: { slug: string }) {
  const holderRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const tmuxRef = useRef<string | null>(getTermTmuxName(tmuxKey(slug)));
  const [status, setStatus] = useState<Status>('connecting');
  const [note, setNote] = useState('');
  // Bumped by the reconnect button — re-runs the connect effect from scratch.
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13.5,
      fontFamily: "Consolas, 'Courier New', ui-monospace, Menlo, monospace",
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (holderRef.current) { term.open(holderRef.current); fit.fit(); }
    termRef.current = term;
    fitRef.current = fit;

    setStatus('connecting');
    setNote('');
    // Kickoff only on a session WE spawned fresh: re-attaching (a stored tmux
    // name went out with the start frame) means the conversation already exists.
    const freshSpawn = !tmuxRef.current;
    let kickoffTimer: number | undefined;
    let lastOutputAt = 0;
    let sawOutput = false;
    let kickoffSent = !freshSpawn;

    const sendText = (s: string) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', data: b64encode(s) }));
    };

    const ws = openTerminal({
      cwd: slug, cmd: 'claude', cols: term.cols, rows: term.rows,
      tmuxSession: tmuxRef.current || undefined,
      skipPerms: getTermSessionPrefs().skipPermissions ? true : undefined,
    });
    wsRef.current = ws;

    ws.addEventListener('message', (ev) => {
      let m: { t: string; data?: string; msg?: string; code?: number; tmuxSession?: string };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.t === 'out' && m.data) {
        term.write(b64decode(m.data));
        lastOutputAt = Date.now();
        sawOutput = true;
      } else if (m.t === 'ready') {
        if (m.tmuxSession) {
          tmuxRef.current = m.tmuxSession;
          setTermTmuxName(tmuxKey(slug), m.tmuxSession);
        }
        setStatus('live');
        term.focus();
        if (!kickoffSent) {
          // Type the kickoff once claude's TUI has painted and gone quiet —
          // too early and the input is lost to the boot screen. 15s cap so a
          // chatty boot can't starve it forever.
          const started = Date.now();
          kickoffTimer = window.setInterval(() => {
            const settled = sawOutput && Date.now() - lastOutputAt > 1500;
            if (!settled && Date.now() - started < 15_000) return;
            window.clearInterval(kickoffTimer);
            if (kickoffSent) return;
            kickoffSent = true;
            sendText(kickoff(slug));
            window.setTimeout(() => sendText('\r'), 150);
          }, 300);
        }
      } else if (m.t === 'exit') {
        // A real end (detaches never send exit) — forget the tmux mapping so
        // the next open starts a fresh Polaris session with a fresh kickoff.
        if (tmuxRef.current) clearTermTmuxName(tmuxKey(slug), tmuxRef.current);
        tmuxRef.current = null;
        setStatus('closed');
        setNote(`exited (${m.code})`);
        term.write('\r\n\x1b[90m[polaris session ended — reconnect to start a new one]\x1b[0m\r\n');
      } else if (m.t === 'err') {
        setStatus('error');
        setNote(m.msg || 'terminal error');
        term.write(`\r\n\x1b[91m${m.msg || 'terminal error'}\x1b[0m\r\n`);
      }
    });
    ws.addEventListener('error', () => { setStatus('error'); setNote('Could not reach the terminal relay.'); });

    const data = term.onData((d) => sendText(d));
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      fit.fit();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const w = wsRef.current;
        if (w?.readyState === WebSocket.OPEN) w.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
      }, 80);
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.clearInterval(kickoffTimer);
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      data.dispose();
      wsRef.current?.close();
      term.dispose();
    };
  }, [slug, epoch]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="polaris-term">
      <div className="polaris-tbar">
        <span className={`pt-dot ${status}`} />
        <span className="pt-label">POLARIS SESSION</span>
        <span className="pt-hint">
          claude · {status === 'live' ? (tmuxRef.current ? 'tmux-backed' : 'live') : status}{note ? ` — ${note}` : ''}
        </span>
        {(status === 'closed' || status === 'error') && (
          <button className="pt-reconnect" onClick={() => setEpoch((e) => e + 1)}>↻ reconnect</button>
        )}
      </div>
      <div className="polaris-holder" ref={holderRef} onClick={() => termRef.current?.focus()} />
    </div>
  );
}
