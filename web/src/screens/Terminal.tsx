import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  openTerminal, getTermCmds, setTermCmds, type TermCmd,
  getTermUsagePrefs, setTermUsagePrefs, type TermUsagePrefs,
  getTermViewPrefs, setTermViewPrefs,
  createAutopilotSchedule,
  getAutopilotJobs, resumeAutopilotJob, hangupAutopilotJob, type AutopilotJob,
  getTerminalUsage, type TerminalUsageData,
  getDetachedSessions, killDetachedSession, type DetachedSession,
  getTermTmuxName, setTermTmuxName, clearTermTmuxName,
  getTermSessionPrefs, termAssist, type TermAssistSuggestion,
} from '../store';
import { go } from '../lib/route';
import { PRODUCT_NAME } from '../lib/ui';
import { ConfirmModal } from '../components/ConfirmModal';

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

// The essentials only. Claude is NOT a quick command any more — typing claude
// into a shell tab bypasses tmux persistence entirely (the daemon only wraps
// sessions opened in Claude mode), which is exactly the trap #188 closed.
// Claude tabs are the seg control / the auto-opened session.
const DEFAULT_CMDS: TermCmd[] = [
  { label: 'git status', cmd: 'git status' },
  { label: 'git log', cmd: 'git log --oneline -15' },
  { label: 'git diff', cmd: 'git diff --stat' },
  { label: 'git pull', cmd: 'git pull' },
  { label: 'compose up', cmd: 'docker compose up -d --build' },
  { label: 'compose logs', cmd: 'docker compose logs -f --tail=50' },
  { label: 'autopilot log', cmd: 'tail -40 ~/.stack/autopilot.log' },
];

// tmux is the host-side tmux session a claude tab runs inside (#188): seeded
// from a detached-session chip or the device-local cwd map, confirmed by the
// daemon's ready frame. Shell tabs never have one.
type Sess = { id: number; cwd: string; cmd: 'shell' | 'claude'; status: Status; note: string; tmux?: string };
type Handle = { sendText: (s: string) => void; reconnect: () => void; focus: () => void };

// Mounted once by App and never unmounted (#137): sessions, sockets and
// scrollback survive navigation. `visible` = the #/terminal route is showing;
// away from it the component renders as the floating dock (#139) — minimised
// to a bottom-right chip by default, expandable to a small floating panel.
export function Terminal({ initialCwd = '', visible = true, onAlive }: {
  initialCwd?: string; visible?: boolean; onAlive?: (liveCount: number) => void;
}) {
  const [cwd, setCwd] = useState(initialCwd);
  // The seg control starts on the device's preferred session kind (Settings →
  // Terminal; default claude — that's what this screen is for).
  const [mode, setMode] = useState<'shell' | 'claude'>(() => getTermSessionPrefs().autoStart);
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
  const [serverUsage, setServerUsage] = useState<TerminalUsageData | null>(null);
  const [usagePrefs, setPrefsState] = useState<TermUsagePrefs>(() => getTermUsagePrefs());
  const [editLimit, setEditLimit] = useState(false);
  const [limitDraft, setLimitDraft] = useState('');
  const [schedNote, setSchedNote] = useState('');
  const scheduling = useRef(false);
  const savePrefs = (p: TermUsagePrefs) => { setPrefsState(p); setTermUsagePrefs(p); };
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newCmd, setNewCmd] = useState('');

  // #136 — view prefs: collapsible quick-commands rail + wide mode.
  const [viewPrefs, setViewPrefsState] = useState(() => getTermViewPrefs());
  const saveViewPrefs = (p: { railOpen: boolean; wide: boolean }) => {
    setViewPrefsState(p); setTermViewPrefs(p);
  };

  // #138 — bare-slug cwd resolution: a slug with no path separators (e.g.
  // "stack") is sent straight to the daemon, which resolves it relative to
  // STACK_TERM_ROOT ($HOME). So "stack" → "$HOME/stack" — where projects live.
  // The jail still applies: symlinks that escape $HOME are refused by the
  // daemon's resolveCwd() regardless of what the browser sends.
  // Mission Control's per-row ⌨ button and the ProjectDetail ⌨ button both
  // call go.terminal(slug), so project-context opens already land here.
  const openSession = (dir?: string, kind?: 'shell' | 'claude', tmux?: string) => {
    const id = nextId.current++;
    const cwdKey = (dir ?? cwd).trim();
    const cmd = kind ?? mode;
    setSessions((s) => {
      // #188 — resume-through-reload: a claude session with no explicit tmux
      // name reuses this device's remembered session for the cwd, unless a
      // live tab already holds it (attaching twice would mirror the terminal).
      let name = tmux;
      if (!name && cmd === 'claude') {
        const stored = getTermTmuxName(cwdKey);
        if (stored && !s.some((x) => x.tmux === stored && (x.status === 'live' || x.status === 'connecting'))) {
          name = stored;
        }
      }
      return [...s, { id, cwd: cwdKey, cmd, status: 'connecting', note: '', tmux: name }];
    });
    setActive(id);
  };
  // One session opens itself on arrival — the screen is never empty. The kind
  // comes from the device pref (default claude, in skip-permissions mode via
  // the start frame; a surviving tmux session for the cwd re-attaches).
  useEffect(() => { openSession(initialCwd, getTermSessionPrefs().autoStart); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    else openSession(initialCwd, getTermSessionPrefs().autoStart);
  }, [initialCwd]); // eslint-disable-line react-hooks/exhaustive-deps

  // Liveness, reported up to App: quiets the global presence pill while the
  // dock owns the corner, and decides whether the dock shows at all.
  const liveCount = sessions.filter((s) => s.status === 'live' || s.status === 'connecting').length;
  useEffect(() => { onAlive?.(liveCount); }, [liveCount, onAlive]);

  // Any full/float/hidden transition changes the holder's size out from under
  // xterm — the sessions' own resize listeners refit on this. Also fires on
  // wide-mode toggle (#136).
  useEffect(() => { window.dispatchEvent(new Event('resize')); }, [visible, dock, viewPrefs.wide]);

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

  // #188 — detached claude sessions still running on the host (what a page
  // reload orphans). Fetched when the screen shows and whenever the live
  // count changes (a close just detached one; an attach consumed one), with a
  // short follow-up fetch so the daemon's push has time to land in the cache.
  const [detached, setDetached] = useState<DetachedSession[]>([]);
  const refreshDetached = async () => {
    try { setDetached(await getDetachedSessions()); } catch { /* daemon offline — strip stays as-is */ }
  };
  useEffect(() => {
    if (!visible) return;
    void refreshDetached();
    const t = setTimeout(() => void refreshDetached(), 1500);
    return () => clearTimeout(t);
  }, [visible, liveCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const attachDetached = (d: DetachedSession) => {
    setDetached((l) => l.filter((x) => x.name !== d.name));
    openSession(d.cwd, 'claude', d.name);
  };
  const [killTarget, setKillTarget] = useState<DetachedSession | null>(null);
  const confirmKill = async () => {
    const d = killTarget;
    setKillTarget(null);
    if (!d) return;
    setDetached((l) => l.filter((x) => x.name !== d.name));
    clearTermTmuxName(d.cwd, d.name);
    try { await killDetachedSession(d.name); } catch { void refreshDetached(); }
  };

  // The daemon confirmed (or assigned) a tab's tmux session — remember it on
  // the tab and in the device-local cwd map so a reload can resume it.
  const noteTmux = (id: number, cwdKey: string, name: string) => {
    setSessions((s) => s.map((x) => (x.id === id ? { ...x, tmux: name } : x)));
    setTermTmuxName(cwdKey, name);
  };
  // An exit frame while attached means the underlying process really ended
  // (a detach never sends one) — forget the mapping so the next open is fresh.
  const noteTmuxEnded = (cwdKey: string, name: string | null) => {
    if (name) clearTermTmuxName(cwdKey, name);
  };

  // Chips for sessions a live tab already holds would be re-attach traps —
  // hide them (the daemon's next push drops them anyway).
  const detachedShown = detached.filter(
    (d) => !sessions.some((s) => s.tmux === d.name && (s.status === 'live' || s.status === 'connecting')));

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

  // ✧ Gemini command help (the rail's side assist): describe the goal, get one
  // command back. Suggestion only — ⌨ types it into the active session without
  // Enter, + Save keeps it as a quick command. Silent 503 when keyless.
  const [askText, setAskText] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [askErr, setAskErr] = useState('');
  const [suggestion, setSuggestion] = useState<TermAssistSuggestion | null>(null);
  const runAssist = async () => {
    const q = askText.trim();
    if (!q || askBusy) return;
    setAskBusy(true); setAskErr(''); setSuggestion(null);
    try { setSuggestion(await termAssist(q, (activeSess?.cwd || cwd).trim())); }
    catch (e) { setAskErr(e instanceof Error ? e.message : 'Assist failed.'); }
    finally { setAskBusy(false); }
  };
  const typeSuggestion = () => {
    if (!suggestion) return;
    const h = handles.current.get(active);
    if (!h) return;
    h.sendText(suggestion.command); // no Enter — the human runs it
    h.focus();
  };
  const saveSuggestion = () => {
    if (!suggestion) return;
    const next = [...customCmds, { label: suggestion.label, cmd: suggestion.command }];
    setCustomCmds(next);
    setTermCmds(next);
    setSuggestion(null);
    setAskText('');
  };

  // The project a booked session runs against — the dispatcher resolves repos
  // as $STACK_AUTOPILOT_ROOT/<slug>, so the cwd's first segment IS the slug.
  const projectSlug = (activeSess?.cwd || cwd).trim().replace(/^[/\\]+/, '').split('/')[0] || '';
  const schedKey = usage?.sched ? `${projectSlug} ${usage.sched.runDate} ${usage.sched.atTime}` : '';
  const booked = !!schedKey && usagePrefs.lastAutoKey === schedKey;
  // Daemon frames are the real-time numerator; server 24h total is the fallback
  // before the first frame arrives (no active PTY session). Denominator: the
  // nightly autopilot budget when set (server-side); user's device-local
  // estimate when the budget is 0 (unlimited) or the server is unreachable.
  const usedTokens = usage?.tokens ?? serverUsage?.tokensToday ?? 0;
  const effectiveLimit = serverUsage && serverUsage.tokenBudget > 0
    ? serverUsage.tokenBudget
    : usagePrefs.dailyLimit;
  const usagePct = usedTokens > 0 ? Math.round((usedTokens / effectiveLimit) * 100) : 0;

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

  // #142 — this project's paused session, if any: a limit-hit autopilot run
  // sits in the queue as a kind='resume' job. Polled while the screen is
  // showing (the component never unmounts), and re-checked when a limit frame
  // lands. Resume clears the hold; hang-up parks it for later.
  const [resumeJob, setResumeJob] = useState<AutopilotJob | null>(null);
  useEffect(() => {
    if (!visible || !projectSlug) { setResumeJob(null); return; }
    let gone = false;
    const check = () => {
      getAutopilotJobs(projectSlug, 8)
        .then((jobs) => {
          if (gone) return;
          setResumeJob(jobs.find((j) => j.kind === 'resume' && (j.status === 'queued' || j.status === 'paused')) ?? null);
        })
        .catch(() => { /* quiet — the chip just stays away */ });
    };
    check();
    const t = window.setInterval(check, 60_000);
    return () => { gone = true; window.clearInterval(t); };
  }, [visible, projectSlug, usage?.resetAt]);
  const resumeAt = resumeJob?.notBefore
    ? new Date(resumeJob.notBefore).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';
  const actOnResume = async (act: (id: string) => Promise<AutopilotJob>) => {
    if (!resumeJob) return;
    try { setResumeJob(await act(resumeJob.id)); } catch { /* next poll corrects */ }
  };

  // Poll /api/terminal/usage for the nightly token budget and 24h autopilot totals.
  // Gated on visible; silent on error (strip just falls back to daemon data alone).
  useEffect(() => {
    if (!visible) return;
    let gone = false;
    const fetch = () => {
      getTerminalUsage()
        .then((u) => { if (!gone) setServerUsage(u); })
        .catch(() => { /* silent — strip shows daemon data when server is unreachable */ });
    };
    fetch();
    const t = window.setInterval(fetch, 30_000);
    return () => { gone = true; window.clearInterval(t); };
  }, [visible]);

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

      <div className={`page detail term-page${viewPrefs.wide ? ' term-wide' : ''}`}>
        <div className="term-bar">
          {/* #138 — bare slug (no /) resolves to $HOME/<slug> on the daemon;
              a full path like "stack/src" also works within that root.
              The "~/" label makes the relative-to-home semantics visible. */}
          <span className="term-lbl">~/</span>
          <input className="field-input term-cwd" value={cwd} placeholder="project slug or sub-path (blank = home)"
            title="A project slug (e.g. stack) opens ~/slug. A sub-path (e.g. stack/src) opens ~/stack/src. Leave blank for home."
            onChange={(e) => setCwd(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') openSession(); }} />
          {/* #136 — mode toggle replaces the Shell/Claude seg-control tab bar.
              The choice is now made at connect-time, not as a standing widget. */}
          <button
            className={`btn-repo sm term-mode-btn${mode === 'claude' ? ' on' : ''}`}
            title={mode === 'shell'
              ? 'Currently opening shell sessions — click to switch to Claude'
              : 'Currently opening Claude sessions — click to switch to shell'}
            onClick={() => setMode((m) => m === 'shell' ? 'claude' : 'shell')}>
            {mode === 'claude' ? 'Claude' : 'Shell'}
          </button>
          <button className="btn-submit sm" onClick={() => openSession()}>+ New session</button>
          {/* #136 — wide mode toggle: the terminal panel expands to the full viewport width */}
          <button
            className={`btn-repo sm term-wide-btn${viewPrefs.wide ? ' on' : ''}`}
            title={viewPrefs.wide ? 'Exit wide mode' : 'Wide mode — expand terminal to the full viewport width'}
            onClick={() => saveViewPrefs({ ...viewPrefs, wide: !viewPrefs.wide })}>
            {viewPrefs.wide ? '⊠' : '⊞'}
          </button>
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

        {/* the usage strip — visible once the daemon sends a frame OR the server
            endpoint responds, whichever comes first. Shows Tokens: used / limit
            where the limit is the nightly autopilot budget from settings (server-
            sourced) or the user's device-local estimate when the budget is 0
            (unlimited). Daemon frames update the used count every 15s. */}
        {(usage || serverUsage) && (
          <div className="term-usage">
            <span className="tu-lbl">Tokens</span>
            <div className={`tu-bar${usagePct >= 100 ? ' over' : usagePct >= 85 ? ' warn' : ''}`}>
              <div className="tu-fill" style={{ width: `${Math.min(100, usagePct)}%` }} />
            </div>
            <span className="tu-num"
              title={`${fmtTok(usedTokens)} / ${serverUsage && serverUsage.tokenBudget > 0 ? fmtTok(serverUsage.tokenBudget) + ' nightly budget' : fmtTok(usagePrefs.dailyLimit) + ' estimate'} (24h)`}>
              {fmtTok(usedTokens)} /{' '}
              {serverUsage && serverUsage.tokenBudget > 0
                ? <span>{fmtTok(serverUsage.tokenBudget)}</span>
                : editLimit
                  ? (
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
                    <button className="tu-limit" title="Daily token estimate (this device only) — click to change"
                      onClick={() => { setLimitDraft(fmtTok(usagePrefs.dailyLimit)); setEditLimit(true); }}>
                      {fmtTok(usagePrefs.dailyLimit)}
                    </button>
                  )
              }
            </span>
            {usage?.totalTokens != null && usage.totalTokens > (usage?.tokens ?? 0) && (
              <span className="tu-total" title="Raw volume including prompt-cache reads — the fresh count on the bar is what tracks real work">
                {fmtTok(usage.totalTokens)} incl. cache reads
              </span>
            )}
            {usage?.resetLabel && <span className="tu-reset">⏳ limit resets {usage.resetLabel}</span>}
            {resumeJob && (
              <span className={`tu-resume ${resumeJob.status}`}
                title={resumeJob.itemTitle ? `#${resumeJob.itemId} ${resumeJob.itemTitle}` : undefined}>
                ⏸ {resumeJob.status === 'paused'
                  ? `${resumeJob.slug} hung up — resumes when you say`
                  : resumeJob.notBefore ? `${resumeJob.slug} paused · resumes ${resumeAt}`
                  : `${resumeJob.slug} resuming…`}
                {(resumeJob.status === 'paused' || resumeJob.notBefore) && (
                  <button className="btn-submit sm" onClick={() => void actOnResume(resumeAutopilotJob)}
                    title="Resume the paused session now — the host picks it up within a minute">
                    ▶ Resume now
                  </button>
                )}
                {resumeJob.status === 'queued' && resumeJob.notBefore && (
                  <button className="btn-cancel sm" onClick={() => void actOnResume(hangupAutopilotJob)}
                    title="Hang up — hold the session so it only resumes when you say">
                    Hang up
                  </button>
                )}
              </span>
            )}
            {usage?.sched && (booked ? (
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

        {/* #188 — detached sessions strip: claude sessions still running on the
            host with no browser attached. ▶ re-attaches in a new tab; × kills
            the host-side process (confirmed first). */}
        {detachedShown.length > 0 && (
          <div className="term-detached">
            <span className="td-lbl">Detached on the host</span>
            {detachedShown.map((d) => (
              <span key={d.name} className="td-chip">
                <button className="td-attach"
                  title={`Re-attach to this running claude session (tmux ${d.name}${d.created ? `, since ${new Date(d.created).toLocaleString()}` : ''})`}
                  onClick={() => attachDetached(d)}>
                  ▶ claude · {d.cwd ? `~/${d.cwd}` : '~'}
                </button>
                <button className="td-x" aria-label="Kill this detached session"
                  title="Kill this session on the host" onClick={() => setKillTarget(d)}>×</button>
              </span>
            ))}
          </div>
        )}

        <div className="term-layout">
          {/* #136 — quick commands rail, now collapsible. A small ‹/› toggle
              sits at the top; collapsed the rail shrinks to that button only,
              reclaiming horizontal space for the terminal canvas. */}
          <div className={`term-rail${viewPrefs.railOpen ? '' : ' term-rail-collapsed'}`}>
            <button
              className="term-rail-toggle"
              title={viewPrefs.railOpen ? 'Collapse quick commands' : 'Expand quick commands'}
              onClick={() => saveViewPrefs({ ...viewPrefs, railOpen: !viewPrefs.railOpen })}>
              <span className="term-rail-toggle-icon">{viewPrefs.railOpen ? '‹' : '›'}</span>
            </button>
            {viewPrefs.railOpen && (
              <>
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

                {/* ✧ side gemini — command help. Suggestion only; nothing runs
                    until the human presses Enter in the terminal. */}
                <div className="term-rail-head" style={{ marginTop: 10 }}>✧ Command help</div>
                <div className="term-assist">
                  <input className="field-input sm" value={askText} placeholder="what do you want to do?"
                    onChange={(e) => setAskText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void runAssist(); }} />
                  {askBusy && <div className="ta-note">thinking…</div>}
                  {askErr && <div className="ta-note err">{askErr}</div>}
                  {suggestion && (
                    <div className="ta-card">
                      <code className="ta-cmd">{suggestion.command}</code>
                      {suggestion.explanation && <div className="ta-why">{suggestion.explanation}</div>}
                      <div className="ta-actions">
                        <button className="btn-submit sm" onClick={typeSuggestion}
                          title="Types the command into the active session — press Enter yourself to run it">
                          ⌨ Type it
                        </button>
                        <button className="btn-cancel sm" onClick={saveSuggestion} title="Save as a quick command">
                          + Save
                        </button>
                        <button className="term-cmd-x" onClick={() => setSuggestion(null)} aria-label="Dismiss suggestion">×</button>
                      </div>
                    </div>
                  )}
                </div>
              </>
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
                onTmux={(name) => noteTmux(s.id, s.cwd, name)}
                onExit={(name) => noteTmuxEnded(s.cwd, name)}
                register={(h) => { if (h) handles.current.set(s.id, h); else handles.current.delete(s.id); }} />
            ))}
            {sessions.length === 0 && (
              <div className="term-holder gitbash term-empty">No sessions — open one above.</div>
            )}
          </div>
        </div>
      </div>
    </div>
    {killTarget && (
      <ConfirmModal
        title="Kill detached session?"
        body={<>The claude session in <b>{killTarget.cwd ? `~/${killTarget.cwd}` : '~'}</b> is still running
          on the host. Killing it ends the process — anything unfinished in that conversation is lost.</>}
        confirmLabel="Kill session"
        danger
        onConfirm={() => void confirmKill()}
        onCancel={() => setKillTarget(null)}
      />
    )}
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
function TermSession({ sess, visible, onStatus, onUsage, onTmux, onExit, register }: {
  sess: { id: number; cwd: string; cmd: 'shell' | 'claude'; tmux?: string };
  visible: boolean;
  onStatus: (s: Status, note: string) => void;
  onUsage: (u: TermUsage) => void;
  onTmux: (name: string) => void;
  onExit: (tmuxName: string | null) => void;
  register: (h: Handle | null) => void;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Tmux session name for claude tabs (shell never uses tmux): seeded from the
  // parent (a detached-session chip or the device-local cwd map, #188), then
  // confirmed/assigned by the daemon's first ready frame. Passed in the start
  // frame so the daemon re-attaches to the surviving session instead of
  // spawning a new one.
  const tmuxRef = useRef<string | null>(sess.tmux ?? null);

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
      const ws = openTerminal({
        cwd: sess.cwd, cmd: sess.cmd, cols: term.cols, rows: term.rows,
        tmuxSession: sess.cmd === 'claude' && tmuxRef.current ? tmuxRef.current : undefined,
        // Device pref (Settings → Terminal): claude without permission prompts.
        // A boolean only — the daemon maps it to its one allow-listed flag.
        skipPerms: sess.cmd === 'claude' && getTermSessionPrefs().skipPermissions ? true : undefined,
      });
      wsRef.current = ws;
      // #135 — write-batching: coalesce rapid incoming frames into one
      // requestAnimationFrame flush instead of calling term.write() per frame.
      // High-throughput output (builds, log tails) can arrive in dozens of tiny
      // frames per ms; merging them into one Uint8Array per rAF cuts xterm's
      // internal dispatch overhead and eliminates intermediate layout thrashing.
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
      const scheduleWrite = (data: Uint8Array) => {
        writeBuf.push(data);
        if (!rafPending) { rafPending = true; requestAnimationFrame(flushWrites); }
      };

      ws.addEventListener('message', (ev) => {
        let m: {
          t: string; data?: string; msg?: string; code?: number; cwd?: string;
          tmuxSession?: string;
          tokens?: number; resetAt?: number; resetLabel?: string; sched?: { runDate: string; atTime: string };
        };
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'out' && m.data) scheduleWrite(b64decode(m.data));
        else if (m.t === 'usage' && typeof m.tokens === 'number') {
          onUsage({ tokens: m.tokens, resetAt: m.resetAt, resetLabel: m.resetLabel, sched: m.sched });
        }
        else if (m.t === 'ready') {
          if (m.tmuxSession) { tmuxRef.current = m.tmuxSession; onTmux(m.tmuxSession); }
          onStatus('live', m.cwd || '');
          if (visible) term.focus();
        }
        else if (m.t === 'exit') {
          // An exit while attached = the underlying process really ended (a
          // detach kills only the shim and no frame reaches us) — let the
          // parent forget the tmux mapping so the next open starts fresh.
          onExit(tmuxRef.current);
          tmuxRef.current = null;
          onStatus('closed', `exited (${m.code})`);
          term.write('\r\n\x1b[90m[session ended — reconnect from the tab bar]\x1b[0m\r\n');
        }
        else if (m.t === 'err') { onStatus('error', m.msg || 'terminal error'); term.write(`\r\n\x1b[91m${m.msg || 'terminal error'}\x1b[0m\r\n`); }
      });
      ws.addEventListener('error', () => onStatus('error', 'Could not reach the terminal relay.'));
    };
    connect();

    // Input goes out immediately — no batching on the keypress path. #135
    const data = term.onData((d) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', data: b64encode(d) }));
    });
    // #135 — debounced resize: the window.resize event fires on every animation
    // frame while the user drags; debouncing 80 ms sends only the settled size.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      fit.fit();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
      }, 80);
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
      clearTimeout(resizeTimer);
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
