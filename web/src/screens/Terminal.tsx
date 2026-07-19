import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  openTerminal, getTermCmds, setTermCmds, type TermCmd,
  getTermUsagePrefs, setTermUsagePrefs, type TermUsagePrefs,
  createAutopilotSchedule,
} from '../store';
import { go } from '../lib/route';
import { PRODUCT_NAME } from '../lib/ui';

// The web terminal (#/terminal[?cwd=…]) — xterm.js over websocket to the host
// PTY daemon (via the server relay at /term). Parallel sessions live in tabs
// (every tab is its own socket; the relay multiplexes them over the one agent
// connection), a left rail of quick commands types into the active tab, and
// the theme is a mintty/git-bash homage: black, grey foreground, the classic
// ANSI palette.
type Status = 'connecting' | 'live' | 'closed' | 'error';

// The daemon's `usage` frame — today's real token count from the host's Claude
// transcripts, plus the limit-reset details while a usage limit is in force.
// `tokens` is the FRESH count (input + output + cache write — the number the
// budget bar measures, #130); `totalTokens` adds cache reads (~97% of raw
// volume), shown as a secondary figure. `sched` is a ready-to-book one-off
// calendar slot in HOST-local time.
type TermUsage = {
  tokens: number;
  totalTokens?: number;
  resetAt?: number;
  resetLabel?: string;
  sched?: { runDate: string; atTime: string };
};

const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 9.95e6 ? 0 : 1)}M`
  : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

// "10M", "1.5m", "800k" or a plain count → tokens (0 = unparseable).
const parseTok = (s: string): number => {
  const m = /^\s*([\d.]+)\s*([mk]?)\s*$/i.exec(s);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * (m[2].toLowerCase() === 'm' ? 1e6 : m[2].toLowerCase() === 'k' ? 1e3 : 1));
};

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

// mintty's default palette — the git-bash look.
const GIT_BASH_THEME = {
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

const DEFAULT_CMDS: TermCmd[] = [
  { label: 'claude', cmd: 'claude' },
  { label: 'claude (skip permissions)', cmd: 'claude --dangerously-skip-permissions' },
  { label: 'claude (continue)', cmd: 'claude -c' },
  { label: 'git status', cmd: 'git status' },
  { label: 'git log', cmd: 'git log --oneline -10' },
  { label: 'compose up', cmd: 'docker compose up -d --build' },
  { label: 'autopilot log', cmd: 'tail -40 ~/.stack/autopilot.log' },
];

type Sess = { id: number; cwd: string; cmd: 'shell' | 'claude'; status: Status; note: string };
type Handle = { sendText: (s: string) => void; reconnect: () => void; focus: () => void };

// Mounted once by App and never unmounted (#137): sessions, sockets and
// scrollback survive navigation. `visible` = the #/terminal route is showing;
// away from it the component renders as the floating dock (#139) — minimised
// to a bottom-right chip by default, expandable to a small floating panel.
export function Terminal({ initialCwd = '', visible = true, onAlive }: {
  initialCwd?: string; visible?: boolean; onAlive?: (liveCount: number) => void;
}) {
  const [cwd, setCwd] = useState(initialCwd);
  const [mode, setMode] = useState<'shell' | 'claude'>('shell');
  const [sessions, setSessions] = useState<Sess[]>([]);
  const [active, setActive] = useState(0);
  const nextId = useRef(1);
  const handles = useRef(new Map<number, Handle>());
  // The dock state while away from #/terminal: chip (default on navigate) or
  // the expanded float. Re-minimises each time the user navigates away.
  const [dock, setDock] = useState<'min' | 'float'>('min');
  const prevVisible = useRef(visible);
  useEffect(() => {
    if (prevVisible.current && !visible) setDock('min');
    prevVisible.current = visible;
  }, [visible]);

  const [customCmds, setCustomCmds] = useState<TermCmd[]>(() => getTermCmds());

  // Token usage strip (#111) — fed by every session's usage frames (they all
  // report the same host-wide numbers; latest wins). The daily limit is a
  // device-local estimate; the auto/manual toggle decides whether a limit hit
  // books the next automated session itself or offers a button.
  const [usage, setUsage] = useState<TermUsage | null>(null);
  const [usagePrefs, setPrefsState] = useState<TermUsagePrefs>(() => getTermUsagePrefs());
  const [editLimit, setEditLimit] = useState(false);
  const [limitDraft, setLimitDraft] = useState('');
  const [schedNote, setSchedNote] = useState('');
  const scheduling = useRef(false);
  const savePrefs = (p: TermUsagePrefs) => { setPrefsState(p); setTermUsagePrefs(p); };
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newCmd, setNewCmd] = useState('');

  const openSession = (dir?: string, kind?: 'shell' | 'claude') => {
    const id = nextId.current++;
    setSessions((s) => [...s, { id, cwd: (dir ?? cwd).trim(), cmd: kind ?? mode, status: 'connecting', note: '' }]);
    setActive(id);
  };
  // One session opens itself on arrival — the screen is never an empty shell.
  useEffect(() => { openSession(initialCwd, 'shell'); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A later ⌨ press with a project cwd (the component stays mounted, so it
  // arrives as a prop change): jump to that project's session, or open one.
  const lastCwdProp = useRef(initialCwd);
  useEffect(() => {
    if (!initialCwd || initialCwd === lastCwdProp.current) {
      if (initialCwd) lastCwdProp.current = initialCwd;
      return;
    }
    lastCwdProp.current = initialCwd;
    setCwd(initialCwd);
    const existing = sessions.find((s) => s.cwd === initialCwd && (s.status === 'live' || s.status === 'connecting'));
    if (existing) setActive(existing.id);
    else openSession(initialCwd, 'shell');
  }, [initialCwd]); // eslint-disable-line react-hooks/exhaustive-deps

  // Liveness, reported up to App: quiets the global presence pill while the
  // dock owns the corner, and decides whether the dock shows at all.
  const liveCount = sessions.filter((s) => s.status === 'live' || s.status === 'connecting').length;
  useEffect(() => { onAlive?.(liveCount); }, [liveCount, onAlive]);

  // Any full/float/hidden transition changes the holder's size out from under
  // xterm — the sessions' own resize listeners refit on this.
  useEffect(() => { window.dispatchEvent(new Event('resize')); }, [visible, dock]);

  const closeSession = (id: number) => {
    handles.current.delete(id);
    setSessions((s) => {
      const rest = s.filter((x) => x.id !== id);
      if (id === active && rest.length) setActive(rest[rest.length - 1].id);
      return rest;
    });
  };
  const setStatus = (id: number, status: Status, note: string) =>
    setSessions((s) => s.map((x) => (x.id === id ? { ...x, status, note } : x)));

  const runQuick = (cmd: string) => {
    const h = handles.current.get(active);
    if (!h) return;
    h.sendText(cmd + '\r');
    h.focus();
  };

  // A roadmap brief handed over by the board's ⌨ To terminal (one-shot).
  // Pasted bracketed so multi-line briefs land in claude/bash as one block —
  // nothing runs until the human presses Enter.
  const [brief] = useState<string>(() => {
    try {
      const b = sessionStorage.getItem('stack.term.brief') || '';
      sessionStorage.removeItem('stack.term.brief');
      return b;
    } catch { return ''; }
  });
  const pasteBrief = () => {
    const h = handles.current.get(active);
    if (!h || !brief) return;
    h.sendText(`\x1b[200~${brief}\x1b[201~`);
    h.focus();
  };
  const addCmd = () => {
    const label = newLabel.trim() || newCmd.trim();
    const cmd = newCmd.trim();
    if (!cmd) return;
    const next = [...customCmds, { label, cmd }];
    setCustomCmds(next);
    setTermCmds(next);
    setNewLabel(''); setNewCmd(''); setAdding(false);
  };
  const dropCmd = (i: number) => {
    const next = customCmds.filter((_, j) => j !== i);
    setCustomCmds(next);
    setTermCmds(next);
  };

  const activeSess = sessions.find((s) => s.id === active);

  // The project a booked session runs against — the dispatcher resolves repos
  // as $STACK_AUTOPILOT_ROOT/<slug>, so the cwd's first segment IS the slug.
  const projectSlug = (activeSess?.cwd || cwd).trim().replace(/^[/\\]+/, '').split('/')[0] || '';
  const schedKey = usage?.sched ? `${projectSlug} ${usage.sched.runDate} ${usage.sched.atTime}` : '';
  const booked = !!schedKey && usagePrefs.lastAutoKey === schedKey;
  const usagePct = usage ? Math.round((usage.tokens / usagePrefs.dailyLimit) * 100) : 0;

  const bookReset = async () => {
    const sched = usage?.sched;
    if (!sched || scheduling.current || booked) return;
    if (!projectSlug) { setSchedNote('Set a project directory to book against.'); return; }
    scheduling.current = true;
    try {
      await createAutopilotSchedule({
        slug: projectSlug, atTime: sched.atTime, runDate: sched.runDate,
        note: 'Booked from the terminal — around the usage-limit reset',
      });
      savePrefs({ ...usagePrefs, lastAutoKey: schedKey });
      setSchedNote('');
    } catch {
      setSchedNote(`Could not book ${projectSlug} — is it a Stack project?`);
    } finally { scheduling.current = false; }
  };

  // Automatic mode: a limit frame with a bookable slot books itself, once per
  // slot (lastAutoKey survives reloads, so a refresh can't double-book).
  useEffect(() => {
    if (usagePrefs.autoSchedule && usage?.sched && !booked) void bookReset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usagePrefs.autoSchedule, usage?.sched?.runDate, usage?.sched?.atTime, projectSlug]);

  const dockLabel = activeSess
    ? `${activeSess.cmd === 'claude' ? 'claude' : 'shell'}${activeSess.cwd ? ` · ${activeSess.cwd}` : ''}`
    : 'terminal';
  const floatOpen = !visible && dock === 'float' && liveCount > 0;

  return (
    <>
    <div className={`term-screen${visible ? '' : floatOpen ? ' term-float' : ' term-hidden'}`}>
      {floatOpen && (
        <div className="term-float-head">
          <span className={`dot ${activeSess?.status || 'closed'}`} />
          <span className="tf-label">{dockLabel}{liveCount > 1 ? ` · ${liveCount} sessions` : ''}</span>
          <span className="tf-actions">
            <button onClick={() => setDock('min')} aria-label="Minimise" title="Minimise to the corner chip">–</button>
            <button onClick={() => go.terminal()} aria-label="Open full screen" title="Open the full Terminal screen">⤢</button>
          </span>
        </div>
      )}
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
            onKeyDown={(e) => { if (e.key === 'Enter') openSession(); }} />
          <div className="seg-control sm" role="tablist" aria-label="Session command">
            <button role="tab" aria-selected={mode === 'shell'}
              className={`seg-opt ${mode === 'shell' ? 'on' : ''}`} onClick={() => setMode('shell')}>Shell</button>
            <button role="tab" aria-selected={mode === 'claude'}
              className={`seg-opt ${mode === 'claude' ? 'on' : ''}`} onClick={() => setMode('claude')}>Claude</button>
          </div>
          <button className="btn-submit sm" onClick={() => openSession()}>+ New session</button>
          {activeSess && (
            <span className={`term-status ${activeSess.status}`}>
              {activeSess.status === 'live' ? `● live ${activeSess.note}`
                : activeSess.status === 'connecting' ? '… connecting'
                : activeSess.status === 'closed' ? '○ closed'
                : `✗ ${activeSess.note}`}
            </span>
          )}
          {activeSess && (activeSess.status === 'closed' || activeSess.status === 'error') && (
            <button className="btn-cancel sm" onClick={() => handles.current.get(active)?.reconnect()}>
              ↻ Reconnect
            </button>
          )}
        </div>

        {/* the usage strip — appears with the first usage frame from the daemon */}
        {usage && (
          <div className="term-usage">
            <span className="tu-lbl">tokens today</span>
            <div className={`tu-bar${usagePct >= 100 ? ' over' : usagePct >= 85 ? ' warn' : ''}`}>
              <div className="tu-fill" style={{ width: `${Math.min(100, usagePct)}%` }} />
            </div>
            <span className="tu-num">
              ~{fmtTok(usage.tokens)} /{' '}
              {editLimit ? (
                <input className="field-input tu-edit" autoFocus value={limitDraft}
                  onChange={(e) => setLimitDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const v = parseTok(limitDraft);
                      if (v) savePrefs({ ...usagePrefs, dailyLimit: v });
                      setEditLimit(false);
                    } else if (e.key === 'Escape') setEditLimit(false);
                  }}
                  onBlur={() => setEditLimit(false)} />
              ) : (
                <button className="tu-limit" title="Daily token budget (your estimate, this device only) — click to change"
                  onClick={() => { setLimitDraft(fmtTok(usagePrefs.dailyLimit)); setEditLimit(true); }}>
                  {fmtTok(usagePrefs.dailyLimit)}
                </button>
              )}
            </span>
            {usage.totalTokens != null && usage.totalTokens > usage.tokens && (
              <span className="tu-total" title="Raw volume including prompt-cache reads — the fresh count on the bar is what tracks real work">
                {fmtTok(usage.totalTokens)} incl. cache reads
              </span>
            )}
            {usage.resetLabel && <span className="tu-reset">⏳ limit resets {usage.resetLabel}</span>}
            {usage.sched && (booked ? (
              <span className="tu-booked">✓ session booked for {usage.sched.atTime}</span>
            ) : !usagePrefs.autoSchedule ? (
              <button className="btn-submit sm" onClick={() => void bookReset()}
                title={`Book a one-off automated session at ${usage.sched.atTime} (just past the reset) via the Mission Control calendar`}>
                ▶ Book session at {usage.sched.atTime}
              </button>
            ) : null)}
            <span className="tu-auto" title="When the usage limit hits, book the next automated session just past the reset without asking">
              auto-book at reset
              <button role="switch" aria-checked={usagePrefs.autoSchedule} aria-label="Auto-book a session at the limit reset"
                className={`switch sm ${usagePrefs.autoSchedule ? 'on' : ''}`}
                onClick={() => savePrefs({ ...usagePrefs, autoSchedule: !usagePrefs.autoSchedule })}>
                <span className="switch-knob" />
              </button>
            </span>
            {schedNote && <span className="tu-note">{schedNote}</span>}
          </div>
        )}

        <div className="term-layout">
          {/* quick commands — type into the active session */}
          <div className="term-rail">
            {brief && (
              <>
                <div className="term-rail-head">From the roadmap</div>
                <button className="term-cmd brief" onClick={pasteBrief}
                  title="Types the roadmap brief into the active session — review it, then press Enter yourself">
                  ▶ Paste roadmap brief
                </button>
              </>
            )}
            <div className="term-rail-head">Quick commands</div>
            {DEFAULT_CMDS.map((c) => (
              <button key={c.cmd} className="term-cmd" title={c.cmd} onClick={() => runQuick(c.cmd)}>
                {c.label}
              </button>
            ))}
            {customCmds.length > 0 && <div className="term-rail-head" style={{ marginTop: 10 }}>Yours</div>}
            {customCmds.map((c, i) => (
              <span className="term-cmd-row" key={`${c.cmd}-${i}`}>
                <button className="term-cmd" title={c.cmd} onClick={() => runQuick(c.cmd)}>{c.label}</button>
                <button className="term-cmd-x" onClick={() => dropCmd(i)} aria-label={`Remove ${c.label}`} title="Remove">×</button>
              </span>
            ))}
            {adding ? (
              <div className="term-cmd-add">
                <input className="field-input sm" value={newLabel} placeholder="label (optional)"
                  onChange={(e) => setNewLabel(e.target.value)} />
                <input className="field-input sm" value={newCmd} placeholder="command" autoFocus
                  onChange={(e) => setNewCmd(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addCmd(); else if (e.key === 'Escape') setAdding(false); }} />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn-cancel sm" onClick={() => setAdding(false)}>Cancel</button>
                  <button className="btn-submit sm" onClick={addCmd} disabled={!newCmd.trim()}>Add</button>
                </div>
              </div>
            ) : (
              <button className="term-cmd add" onClick={() => setAdding(true)}>+ Add a command</button>
            )}
          </div>

          <div className="term-main">
            {/* session tabs — each is its own socket, buffers stay warm off-screen */}
            <div className="term-tabs">
              {sessions.map((s) => (
                <span key={s.id} className={`term-tab ${s.id === active ? 'on' : ''}`}>
                  <button className="term-tab-name" onClick={() => setActive(s.id)}>
                    <span className={`dot ${s.status}`} />
                    {s.cmd === 'claude' ? 'claude' : 'shell'}{s.cwd ? ` · ${s.cwd}` : ''}
                  </button>
                  <button className="term-tab-x" onClick={() => closeSession(s.id)} aria-label="Close session" title="Close">×</button>
                </span>
              ))}
            </div>
            {sessions.map((s) => (
              <TermSession key={s.id} sess={s} visible={s.id === active}
                onStatus={(st, note) => setStatus(s.id, st, note)}
                onUsage={setUsage}
                register={(h) => { if (h) handles.current.set(s.id, h); else handles.current.delete(s.id); }} />
            ))}
            {sessions.length === 0 && (
              <div className="term-holder gitbash term-empty">No sessions — open one above.</div>
            )}
          </div>
        </div>
      </div>
    </div>
    {/* the minimised dock chip (#139) — the default whenever the user
        navigates away with sessions still running; click to expand */}
    {!visible && dock === 'min' && liveCount > 0 && (
      <button className="term-mini" onClick={() => setDock('float')}
        title="A terminal session is running — expand it here, or open the full screen from its header">
        <span className="dot" /> {liveCount > 1 ? `${liveCount} terminal sessions` : dockLabel} ▴
      </button>
    )}
    </>
  );
}

// One tab: an xterm instance + its websocket, kept mounted (hidden when
// inactive) so the scrollback survives tab switches.
function TermSession({ sess, visible, onStatus, onUsage, register }: {
  sess: { id: number; cwd: string; cmd: 'shell' | 'claude' };
  visible: boolean;
  onStatus: (s: Status, note: string) => void;
  onUsage: (u: TermUsage) => void;
  register: (h: Handle | null) => void;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "Consolas, 'Courier New', ui-monospace, Menlo, monospace",
      theme: GIT_BASH_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (holderRef.current) { term.open(holderRef.current); fit.fit(); }
    termRef.current = term;
    fitRef.current = fit;

    const connect = () => {
      wsRef.current?.close();
      onStatus('connecting', '');
      fit.fit();
      const ws = openTerminal({ cwd: sess.cwd, cmd: sess.cmd, cols: term.cols, rows: term.rows });
      wsRef.current = ws;
      ws.addEventListener('message', (ev) => {
        let m: {
          t: string; data?: string; msg?: string; code?: number; cwd?: string;
          tokens?: number; resetAt?: number; resetLabel?: string; sched?: { runDate: string; atTime: string };
        };
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'out' && m.data) term.write(b64decode(m.data));
        else if (m.t === 'usage' && typeof m.tokens === 'number') {
          onUsage({ tokens: m.tokens, resetAt: m.resetAt, resetLabel: m.resetLabel, sched: m.sched });
        }
        else if (m.t === 'ready') { onStatus('live', m.cwd || ''); if (visible) term.focus(); }
        else if (m.t === 'exit') { onStatus('closed', `exited (${m.code})`); term.write('\r\n\x1b[90m[session ended — reconnect from the tab bar]\x1b[0m\r\n'); }
        else if (m.t === 'err') { onStatus('error', m.msg || 'terminal error'); term.write(`\r\n\x1b[91m${m.msg || 'terminal error'}\x1b[0m\r\n`); }
      });
      ws.addEventListener('error', () => onStatus('error', 'Could not reach the terminal relay.'));
    };
    connect();

    const data = term.onData((d) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', data: b64encode(d) }));
    });
    const onResize = () => {
      fit.fit();
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
    };
    window.addEventListener('resize', onResize);

    register({
      sendText: (s) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', data: b64encode(s) }));
      },
      reconnect: connect,
      focus: () => term.focus(),
    });

    return () => {
      register(null);
      window.removeEventListener('resize', onResize);
      data.dispose();
      wsRef.current?.close();
      term.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Refit when this tab becomes visible (it may have been hidden at 0×0).
  useEffect(() => {
    if (!visible) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    fit.fit();
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
    term.focus();
  }, [visible]);

  return <div className="term-holder gitbash" ref={holderRef} style={visible ? undefined : { display: 'none' }} />;
}
