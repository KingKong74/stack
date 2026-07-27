import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  openTerminal, getTermCmds, setTermCmds, type TermCmd,
  getTermUsagePrefs, setTermUsagePrefs, type TermUsagePrefs,
  getTermViewPrefs, setTermViewPrefs, type TermViewPrefs,
  createAutopilotSchedule,
  getAutopilotJobs, resumeAutopilotJob, hangupAutopilotJob, type AutopilotJob,
  getTerminalUsage, type TerminalUsageData,
  getDetachedSessions, killDetachedSession, type DetachedSession,
  labelTerminalSessions,
  getTermTmuxName, setTermTmuxName, clearTermTmuxName,
  getTermSessionPrefs, termAssist, type TermAssistSuggestion,
  getTermWorkingItem, setTermWorkingItem,
  getProjectDetail, type ProjectDetailData,
  getOverview,
} from '../store';
import { go } from '../lib/route';
import { PRODUCT_NAME } from '../lib/ui';
import { ConfirmModal } from '../components/ConfirmModal';
import { tierRank, type RoadmapItem } from '../types';

// The web terminal (#/terminal[?cwd=…]) — xterm.js over websocket to the host
// PTY daemon (via the server relay at /term). Parallel sessions live in tabs
// (every tab is its own socket; the relay multiplexes them over the one agent
// connection), and the theme is a mintty/git-bash homage: black, grey
// foreground, the classic ANSI palette.
//
// 25b — THE COCKPIT. The screen used to spend its chrome on itself: a quick-
// commands rail on the left, a usage strip and a tab strip stacked above the
// canvas. The terminal is the work surface, so it now keeps the width, and
// everything else folds into ONE right rail with two segments:
//   Session   what this session is on, what to hand it next, what it is
//             spending, and who is on it — the rail that ties the tab to the
//             plan, which is the whole argument of the design.
//   Runbook   the eight commands you type every day, grouped, each with the
//             reason you reach for it. Clicking one LOADS it at the prompt
//             (↵ on the row runs it) — the same "nothing runs until you press
//             Enter" rule the brief paste and the ✧ assist already follow.
// The terminal's own colours are untouched: black canvas, the mintty palette,
// the black active tab. The cockpit is Stack's palette around a git-bash box.
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
  // Real Plan windows (#195) — the same session/week percentages + reset times
  // Claude shows in-app, read by the daemon from the account's usage endpoint.
  plan?: {
    session?: { pct: number; resetAt: number | null } | null;
    week?: { pct: number; resetAt: number | null } | null;
    weekModel?: { pct: number; resetAt: number | null; model?: string } | null;
  };
};

// "1:50 pm" / "Mon 2 pm" for a plan-window reset in the viewer's own clock.
const fmtReset = (ms: number | null | undefined, withDay = false): string => {
  if (!ms) return '';
  const d = new Date(ms);
  const h = d.getHours() % 12 || 12;
  const t = `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() >= 12 ? 'pm' : 'am'}`;
  return withDay ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${t}` : t;
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
// 25b groups them and states WHY you reach for each — a runbook, not a
// palette. `label` stays the storage shape (custom commands are {label, cmd}),
// `why` is the right-hand note the design puts on every line.
const RUNBOOK: { name: string; items: (TermCmd & { why: string })[] }[] = [
  {
    name: 'GIT',
    items: [
      { label: 'git status', cmd: 'git status', why: 'what is dirty' },
      { label: 'git log', cmd: 'git log --oneline -15', why: 'what landed' },
      { label: 'git diff', cmd: 'git diff --stat', why: 'size of the change' },
      { label: 'git pull', cmd: 'git pull', why: 'take the night’s work' },
    ],
  },
  {
    name: 'COMPOSE',
    items: [
      { label: 'compose up', cmd: 'docker compose up -d --build', why: 'rebuild and run' },
      { label: 'compose logs', cmd: 'docker compose logs -f --tail=50', why: 'why it broke' },
    ],
  },
  {
    name: 'HOST',
    items: [
      { label: 'autopilot log', cmd: 'tail -40 ~/.stack/autopilot.log', why: 'last night' },
      { label: 'tmux sessions', cmd: 'tmux ls', why: 'what survived' },
    ],
  },
];
// The rail's DO NEXT list mirrors the runner's own pick: tier first (#227),
// then must before should, then board order — and never offers work that is
// parked or already claimed by a branch. Same rules as the Plan room, applied
// to one project, so what the rail hands you is what the night would take.
const BUCKET_RANK: Record<string, number> = { must: 0, should: 1, could: 2, wont: 3 };
function nextUpItems(roadmap: ProjectDetailData['roadmap']): RoadmapItem[] {
  const all = [...roadmap.must, ...roadmap.should, ...roadmap.could, ...roadmap.wont];
  return all
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => !it.done && !it.skipped && !it.claimedBy)
    .sort((a, b) =>
      tierRank(a.it.tier) - tierRank(b.it.tier)
      || (BUCKET_RANK[a.it.bucket] ?? 9) - (BUCKET_RANK[b.it.bucket] ?? 9)
      || a.i - b.i)
    .map(({ it }) => it);
}

// What gets typed at the prompt when you send items across. Plain text, no
// commands: the session reads it and asks you what it should do — which is
// why it is pasted without an Enter, like every other handoff on this screen.
function itemsBrief(items: RoadmapItem[]): string {
  const head = items.length === 1
    ? 'Work this roadmap item:'
    : `Work these ${items.length} roadmap items, in this order:`;
  const body = items.map((it) => {
    const meta = [it.bucket, it.tier ? `tier ${it.tier}` : '', it.area].filter(Boolean).join(' · ');
    const note = it.note ? `\n    ${it.note.trim().replace(/\s*\n\s*/g, ' ').slice(0, 400)}` : '';
    const plan = it.plan.length
      ? `\n    Plan:\n${it.plan.map((s, i) => `      ${s.done ? '[x]' : '[ ]'} ${i + 1}. ${s.text}`).join('\n')}`
      : '';
    return `  #${it.id} ${it.title}  (${meta})${note}${plan}`;
  }).join('\n');
  return `${head}\n${body}\n`;
}

// tmux is the host-side tmux session a claude tab runs inside (#188): seeded
// from a detached-session chip or the device-local cwd map, confirmed by the
// daemon's ready frame. Shell tabs never have one.
type Sess = { id: number; cwd: string; cmd: 'shell' | 'claude'; status: Status; note: string; tmux?: string };
type Handle = { sendText: (s: string) => void; reconnect: () => void; focus: () => void };

// Mounted once by App and never unmounted (#137): sessions, sockets and
// scrollback survive navigation. `visible` = the #/terminal route is showing;
// away from it the component renders as the floating dock (#139) — minimised
// to a bottom-right chip by default, expandable to a small floating panel.
export function Terminal({ initialCwd = '', initialAttach, visible = true, onAlive }: {
  initialCwd?: string; initialAttach?: string; visible?: boolean; onAlive?: (liveCount: number) => void;
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

  // #136 — view prefs: the collapsible rail + wide mode; 25b adds which
  // segment the rail opens on.
  const [viewPrefs, setViewPrefsState] = useState(() => getTermViewPrefs());
  const saveViewPrefs = (p: Partial<TermViewPrefs>) => {
    const next = { ...viewPrefs, ...p };
    setViewPrefsState(next); setTermViewPrefs(next);
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
  // the start frame; a surviving tmux session for the cwd re-attaches). An
  // ?attach=<tmux name> route (Mission Control's ▶ jump-in) overrides the
  // pref: attach straight to that running claude session instead. A bare open
  // (no cwd, no attach) lands in the most recently touched project rather
  // than $HOME — claude in the home directory helps nobody; overview's resume
  // slug is the "current" project. Falls back to home if the fetch misses.
  useEffect(() => {
    if (initialAttach) { openSession(initialCwd, 'claude', initialAttach); return; }
    if (initialCwd) { openSession(initialCwd, getTermSessionPrefs().autoStart); return; }
    let gone = false;
    getOverview()
      .then((o) => o.resume?.slug ?? '')
      .catch(() => '')
      .then((slug) => {
        if (gone) return;
        if (slug) setCwd(slug);
        openSession(slug, getTermSessionPrefs().autoStart);
      });
    return () => { gone = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A later ⌨ press with a project cwd, or a ▶ jump-in with an attach name
  // (the component stays mounted, so both arrive as prop changes — and a
  // REVISIT with the same cwd re-fires via `visible`, so coming back through
  // a project's ⌨ always focuses that project's session instead of leaving
  // whatever tab was last active on top).
  const navReady = useRef(false);
  const lastNavProp = useRef(`${initialCwd}|${initialAttach ?? ''}`);
  useEffect(() => {
    if (!visible) return;
    const key = `${initialCwd}|${initialAttach ?? ''}`;
    const changed = key !== lastNavProp.current;
    lastNavProp.current = key;
    if (!navReady.current) { navReady.current = true; return; } // mount effect owns the first open
    if (initialAttach) {
      const held = sessions.find((s) => s.tmux === initialAttach && (s.status === 'live' || s.status === 'connecting'));
      if (held) { setActive(held.id); return; }
      if (changed) {
        if (initialCwd) setCwd(initialCwd);
        openSession(initialCwd, 'claude', initialAttach);
      }
      return;
    }
    if (!initialCwd) return;
    setCwd(initialCwd);
    const existing = sessions.find((s) => s.cwd === initialCwd && (s.status === 'live' || s.status === 'connecting'));
    if (existing) setActive(existing.id);
    else openSession(initialCwd, getTermSessionPrefs().autoStart);
  }, [visible, initialCwd, initialAttach]); // eslint-disable-line react-hooks/exhaustive-deps

  // Liveness, reported up to App: quiets the global presence pill while the
  // dock owns the corner, and decides whether the dock shows at all.
  const liveCount = sessions.filter((s) => s.status === 'live' || s.status === 'connecting').length;
  useEffect(() => { onAlive?.(liveCount); }, [liveCount, onAlive]);

  // Any full/float/hidden transition changes the holder's size out from under
  // xterm — the sessions' own resize listeners refit on this. Also fires on
  // wide-mode toggle (#136) and on collapsing the cockpit rail, which changes
  // the canvas width by the rail's whole width.
  //
  // Each session also watches its own holder with a ResizeObserver, which is
  // the real guarantee — this stays because it is free, and because a listed
  // dependency says out loud which layout changes are expected to reflow.
  useEffect(() => {
    window.dispatchEvent(new Event('resize'));
  }, [visible, dock, viewPrefs.wide, viewPrefs.railOpen]);

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
    setKillPick((p) => p.filter((n) => n !== d.name));
    openSession(d.cwd, 'claude', d.name);
  };

  // Killing host sessions, one or many. The route only ever kills DETACHED
  // sessions — the daemon refuses a name a client still holds — so selection
  // is offered on those chips alone; to kill one you are attached to, close
  // the tab first (that detaches it) and it reappears here.
  const [killPick, setKillPick] = useState<string[]>([]);
  const [killTargets, setKillTargets] = useState<DetachedSession[] | null>(null);
  const toggleKillPick = (name: string) =>
    setKillPick((p) => (p.includes(name) ? p.filter((n) => n !== name) : [...p, name]));
  const confirmKill = async () => {
    const list = killTargets ?? [];
    setKillTargets(null);
    if (!list.length) return;
    const names = new Set(list.map((d) => d.name));
    setDetached((l) => l.filter((x) => !names.has(x.name)));
    setKillPick((p) => p.filter((n) => !names.has(n)));
    // Sequential, not Promise.all: the daemon takes these over one socket, and
    // a failure part-way should still leave the rest killed. One refresh at the
    // end re-syncs whatever actually died.
    let failed = false;
    for (const d of list) {
      clearTermTmuxName(d.cwd, d.name);
      try { await killDetachedSession(d.name); } catch { failed = true; }
    }
    if (failed) void refreshDetached();
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
  const killable = detachedShown.filter((d) => !d.attached);

  // ---- what each claude session is DOING (#120), on this screen ----
  // Gemini's one-line take, keyed by the host tmux session — the only id both
  // sides agree on (the browser never learns the relay's sid, and a claude tab
  // knows its tmux name from the ready frame). Shell tabs are not labelled:
  // the daemon only reads claude sessions' output for this.
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [labelBusy, setLabelBusy] = useState(false);
  const labelledOnce = useRef('');
  const refreshLabels = async () => {
    if (labelBusy) return;
    setLabelBusy(true);
    try {
      const r = await labelTerminalSessions();
      setLabels((prev) => {
        const next = { ...prev };
        for (const s of r.sessions) if (s.tmux && s.label) next[s.tmux] = s.label;
        for (const d of r.detached) if (d.label) next[d.name] = d.label;
        return next;
      });
    } catch { /* keyless (503) or offline — sessions just stay unnamed */ }
    finally { setLabelBusy(false); }
  };
  // Auto-label whenever an unnamed claude session appears, the way Mission
  // Control does — the names are the point, and asking for them by hand every
  // time would mean they are usually absent. Once per distinct set of names,
  // so a re-render or a poll can't re-ask.
  useEffect(() => {
    if (!visible) return;
    const unnamed = [
      ...sessions.filter((s) => s.cmd === 'claude' && s.tmux && (s.status === 'live' || s.status === 'connecting')).map((s) => s.tmux!),
      ...detachedShown.map((d) => d.name),
    ].filter((n) => !labels[n]);
    if (!unnamed.length) return;
    const key = unnamed.sort().join(',');
    if (labelledOnce.current === key) return;
    labelledOnce.current = key;
    void refreshLabels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessions, detached, labels]);
  const labelOf = (s: Sess) => (s.tmux ? labels[s.tmux] || '' : '');
  const claudeLive = sessions.some((s) => s.cmd === 'claude' && (s.status === 'live' || s.status === 'connecting'));

  // 25b — a runbook line LOADS at the prompt; the row's ↵ runs it. Typing it
  // is the default because the command is usually the start of the thought,
  // not the whole of it (`git log --oneline -15` wants a `| grep` half the
  // time), and it keeps this screen's one rule: Stack never presses Enter.
  const typeQuick = (cmd: string) => {
    const h = handles.current.get(active);
    if (!h) return;
    h.sendText(cmd);
    h.focus();
  };
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

  // ---- 25b: the cockpit rail's Session segment ----
  // The cwd's project, fetched once per slug (and refreshed when the screen
  // comes back), because that is what ties this tab to the plan. Silent on
  // failure: a cwd that isn't a Stack project is normal, and the rail says so
  // rather than erroring at you.
  const [detail, setDetail] = useState<ProjectDetailData | null>(null);
  const [detailSlug, setDetailSlug] = useState('');
  // Why the board is missing, so the rail can say which: a directory that
  // isn't a tracked project reads differently from an API that hiccuped.
  const [detailErr, setDetailErr] = useState(false);
  useEffect(() => {
    if (!visible || !projectSlug) return;
    let gone = false;
    getProjectDetail(projectSlug)
      .then((d) => { if (!gone) { setDetail(d); setDetailErr(false); setDetailSlug(projectSlug); } })
      .catch((e) => {
        if (gone) return;
        setDetail(null);
        setDetailErr(!/not found|404/i.test(e instanceof Error ? e.message : ''));
        setDetailSlug(projectSlug);
      });
    return () => { gone = true; };
  }, [visible, projectSlug]);
  const board = detailSlug === projectSlug ? detail : null;

  const openItems = useMemo(() => {
    const r = board?.roadmap;
    if (!r) return [] as RoadmapItem[];
    return [...r.must, ...r.should, ...r.could, ...r.wont].filter((it) => !it.done);
  }, [board]);
  const nextUp = useMemo(() => (board ? nextUpItems(board.roadmap).slice(0, 6) : []), [board]);
  // The head's claim count — open items a branch holds (#277). Real Stack
  // state, not a guess about how many terminal tabs you have open.
  const claimedItems = openItems.filter((it) => it.claimedBy);

  // WORKING ON: what you last sent this cwd's session. Device-local (see
  // store.setTermWorkingItem) and re-read whenever the cwd changes.
  const [workingId, setWorkingId] = useState<number | null>(null);
  useEffect(() => { setWorkingId(getTermWorkingItem(projectSlug)); }, [projectSlug]);
  const workingItem = openItems.find((it) => it.id === workingId) ?? null;
  const pinWorking = (id: number | null) => {
    setWorkingId(id);
    setTermWorkingItem(projectSlug, id);
  };

  const [picked, setPicked] = useState<number[]>([]);
  useEffect(() => { setPicked([]); }, [projectSlug]);
  const togglePick = (id: number) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  // Send = type the brief at the prompt (bracketed, so a multi-line block
  // lands as one paste) and remember the first item as what this session is
  // on. Nothing runs: the human presses Enter.
  const sendPicked = () => {
    const h = handles.current.get(active);
    if (!h || picked.length === 0) return;
    const items = picked
      .map((id) => nextUp.find((it) => it.id === id))
      .filter((it): it is RoadmapItem => !!it);
    if (!items.length) return;
    h.sendText(`\x1b[200~${itemsBrief(items)}\x1b[201~`);
    h.focus();
    pinWorking(items[0].id);
    setPicked([]);
  };

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
          {/* 25b — the tabs live in the head bar now. Each is still its own
              socket with its own warm buffer; only the row they sit on moved. */}
          <div className="term-tabs">
            {sessions.map((s) => {
              const label = labelOf(s);
              return (
                <span key={s.id} className={`term-tab ${s.id === active ? 'on' : ''}`}>
                  <button className="term-tab-name" onClick={() => setActive(s.id)}
                    title={label ? `${label}${s.tmux ? ` (tmux ${s.tmux})` : ''}` : s.tmux ? `tmux ${s.tmux}` : undefined}>
                    <span className={`dot ${s.status}`} />
                    {s.cmd === 'claude' ? 'claude' : 'shell'}{s.cwd ? ` · ${s.cwd}` : ''}
                    {/* #120 — what this session is doing, in its own words via
                        Gemini. Absent until one comes back: a tab with no name
                        reads as unnamed, never as idle. */}
                    {label && <span className="tab-label">{label}</span>}
                  </button>
                  <button className="term-tab-x" onClick={() => closeSession(s.id)} aria-label="Close session" title="Close">×</button>
                </span>
              );
            })}
          </div>
          <div className="term-bar-gap" />
          {/* ✧ re-ask for the session names. They arrive by themselves when an
              unnamed claude session appears; this is for when one has moved on
              to something else. Absent without claude sessions, and silent when
              the server has no Gemini key. */}
          {claudeLive && (
            <button className="btn-repo sm" onClick={() => void refreshLabels()} disabled={labelBusy}
              title="Re-read what each claude session is doing (✧ Gemini, annotation only)">
              {labelBusy ? '✧ …' : '✧ Re-label'}
            </button>
          )}
          {/* Real claim state (#277 — a claim is a BRANCH, and is called one),
              not a count of browser tabs: open roadmap items a branch holds. */}
          {claimedItems.length > 0 && (
            <span className="term-lanes"
              title={claimedItems.map((it) => `⚑ ${it.claimedBy} — #${it.id} ${it.title}`).join('\n')}>
              {claimedItems.length} branch{claimedItems.length === 1 ? '' : 'es'} claimed
            </span>
          )}
          {/* #136 — wide mode toggle: the terminal panel expands to the full viewport width */}
          <button
            className={`btn-repo sm term-wide-btn${viewPrefs.wide ? ' on' : ''}`}
            title={viewPrefs.wide ? 'Exit wide mode' : 'Wide mode — expand terminal to the full viewport width'}
            onClick={() => saveViewPrefs({ wide: !viewPrefs.wide })}>
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

        {/* The usage strip lives ABOVE the canvas, not in the cockpit rail: it
            is about the machine and the day, not about this session, and
            reading it should never cost a segment switch. Visible once the
            daemon sends a frame OR the server endpoint responds, whichever
            comes first. With plan data (#195) the bar IS the Plan session
            window — the same percentages + reset times Claude's in-app /usage
            shows — and the transcript token count drops to a secondary figure.
            Without it (no credentials on the host, or offline) the old
            tokens-vs-budget estimate carries the strip. */}
        {(usage || serverUsage) && (
          <div className="term-usage">
            {usage?.plan?.session ? (
              <>
                <span className="tu-lbl">Session</span>
                <div className={`tu-bar${usage.plan.session.pct >= 100 ? ' over' : usage.plan.session.pct >= 85 ? ' warn' : ''}`}>
                  <div className="tu-fill" style={{ width: `${Math.min(100, usage.plan.session.pct)}%` }} />
                </div>
                <span className="tu-num"
                  title="The Plan's 5-hour session window — the same number Claude's /usage shows in-app">
                  {usage.plan.session.pct}%
                  {usage.plan.session.resetAt ? ` · resets ${fmtReset(usage.plan.session.resetAt)}` : ''}
                </span>
                {usage.plan.week && (
                  <span className={`tu-total${usage.plan.week.pct >= 85 || (usage.plan.weekModel?.pct ?? 0) >= 85 ? ' warn' : ''}`}
                    title={`The Plan's weekly window — resets ${fmtReset(usage.plan.week.resetAt, true)}`}>
                    week {usage.plan.week.pct}%
                    {usage.plan.weekModel ? ` · ${(usage.plan.weekModel.model || 'model').toLowerCase()} ${usage.plan.weekModel.pct}%` : ''}
                  </span>
                )}
                <span className="tu-total" title="Fresh tokens today (input + output + cache writes) from this host's transcripts">
                  {fmtTok(usedTokens)} tok today
                </span>
              </>
            ) : (
              <>
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
              </>
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

        {/* #188 — sessions still running on the host that this tab doesn't
            hold, framed the way 25b frames them: things to pick up. Detached
            ones (a page reload's orphans) ↺ re-attach, × kills (confirmed
            first — and only detached ones are killable); ones attached
            elsewhere (another browser, the laptop over ssh via `stack term`)
            ↺ mirror — tmux fans one session out to every client, so this tab
            drives the same screen. */}
        {detachedShown.length > 0 && (
          <div className="term-detached">
            <span className="td-lbl">Pick up where it stopped</span>
            {detachedShown.map((d) => {
              const name = labels[d.name] || d.label || '';
              const picked = killPick.includes(d.name);
              return (
                <span key={d.name} className={`td-chip${d.attached ? ' away' : ''}${picked ? ' picked' : ''}`}>
                  <button className="td-attach"
                    title={d.attached
                      ? `Attached on another device (tmux ${d.name}) — open it here too: both screens mirror the same session`
                      : `Re-attach to this running claude session (tmux ${d.name}${d.created ? `, since ${new Date(d.created).toLocaleString()}` : ''})`}
                    onClick={() => attachDetached(d)}>
                    ↺ claude · {d.cwd ? `~/${d.cwd}` : '~'} · {d.attached ? 'another device' : 'detached'}{name ? ` — ${name}` : ''}
                  </button>
                  {/* Selection for a multi-kill sits on killable chips only:
                      the daemon refuses a name a client still holds, so
                      offering it on an attached one would be a button that
                      cannot work. */}
                  {!d.attached && (
                    <button className={`td-pick${picked ? ' on' : ''}`} onClick={() => toggleKillPick(d.name)}
                      aria-pressed={picked} aria-label={`Select ${d.name} to kill`}
                      title={picked ? 'Unselect' : 'Select for a bulk kill'}>{picked ? '☑' : '☐'}</button>
                  )}
                  {!d.attached && (
                    <button className="td-x" aria-label="Kill this detached session"
                      title="Kill this session on the host" onClick={() => setKillTargets([d])}>×</button>
                  )}
                </span>
              );
            })}
            {killable.length > 1 && (
              <span className="td-bulk">
                <button className="btn-repo sm"
                  onClick={() => setKillPick(killPick.length === killable.length ? [] : killable.map((d) => d.name))}>
                  {killPick.length === killable.length ? 'none' : `all ${killable.length}`}
                </button>
                <button className="btn-cancel sm" disabled={killPick.length === 0}
                  title="Kill the selected sessions on the host"
                  onClick={() => setKillTargets(killable.filter((d) => killPick.includes(d.name)))}>
                  × Kill {killPick.length || ''}
                </button>
              </span>
            )}
          </div>
        )}

        <div className="term-layout">
          <div className="term-main">
            {sessions.map((s) => (
              <TermSession key={s.id} sess={s} visible={s.id === active}
                onStatus={(st, note) => setStatus(s.id, st, note)}
                onUsage={setUsage}
                onTmux={(name) => noteTmux(s.id, s.cwd, name)}
                onExit={(name) => noteTmuxEnded(s.cwd, name)}
                register={(h) => { if (h) handles.current.set(s.id, h); else handles.current.delete(s.id); }} />
            ))}
            {sessions.length === 0 && (
              <div className="term-holder gitbash term-empty">
                <span>No session open.</span>
                <span className="dim">Resume one above, or start a new one with + New session.</span>
              </div>
            )}
          </div>

          {/* ---- 25b: the cockpit rail. Two segments, one job each — what
              this session is on (Session) and what you type at it (Runbook).
              Collapsing it gives the canvas the whole width; the choice and
              the open segment are device-local. ---- */}
          <div className={`term-cockpit${viewPrefs.railOpen ? '' : ' collapsed'}`}>
            <button
              className="term-rail-toggle"
              title={viewPrefs.railOpen ? 'Collapse the cockpit rail' : 'Expand the cockpit rail'}
              onClick={() => saveViewPrefs({ railOpen: !viewPrefs.railOpen })}>
              <span className="term-rail-toggle-icon">{viewPrefs.railOpen ? '›' : '‹'}</span>
            </button>
            {viewPrefs.railOpen && (
              <>
                <div className="tc-segs seg-control sm" role="tablist" aria-label="Cockpit rail">
                  {([['session', 'Session'], ['runbook', 'Runbook']] as const).map(([k, label]) => (
                    <button key={k} role="tab" aria-selected={viewPrefs.railSeg === k}
                      className={`seg-opt ${viewPrefs.railSeg === k ? 'on' : ''}`}
                      onClick={() => saveViewPrefs({ railSeg: k })}>
                      {label}
                    </button>
                  ))}
                </div>

                {viewPrefs.railSeg === 'session' ? (
                  <div className="tc-body">
                    {/* WORKING ON — what you handed this session. Device-local:
                        Stack has no server-side "the item this TAB is on", and
                        inventing one from lane claims would be a guess. */}
                    <div className="tc-block">
                      <div className="tc-cap">WORKING ON</div>
                      {workingItem ? (
                        <div className="tc-work">
                          <div className="t">{workingItem.title}</div>
                          <div className="m">
                            #{workingItem.id} · {workingItem.bucket}
                            {workingItem.tier ? ` · tier ${workingItem.tier}` : ''}
                            {workingItem.area ? ` · ${workingItem.area}` : ''}
                            {workingItem.plan.length
                              ? ` · ☰ ${workingItem.plan.filter((s) => s.done).length}/${workingItem.plan.length}`
                              : ''}
                          </div>
                          <div className="tc-work-acts">
                            <button className="tc-link"
                              onClick={() => go.detail(projectSlug, 'roadmap', String(workingItem.id))}>
                              Open on the board ↗
                            </button>
                            <button className="tc-link dim" onClick={() => pinWorking(null)}
                              title="Forget what this session is on (nothing on the board changes)">clear</button>
                          </div>
                        </div>
                      ) : (
                        <div className="tc-empty">
                          {board ? 'Nothing handed over yet — pick from DO NEXT and send it to the prompt.'
                            : !projectSlug ? 'Open a session in a project directory to tie it to the plan.'
                            : detailErr ? `Could not read ~/${projectSlug} just now — the plan is there, this rail isn't.`
                            : `~/${projectSlug} isn't a tracked project — there is no plan to tie this session to.`}
                        </div>
                      )}
                    </div>

                    {/* DO NEXT — the runner's own order, so what the rail
                        offers is what the night would take. */}
                    {board && (
                      <div className="tc-block">
                        <div className="tc-cap row">
                          <span>DO NEXT</span>
                          <button className="tc-link" onClick={() => go.detail(projectSlug, 'roadmap')}>Roadmap ↗</button>
                        </div>
                        {nextUp.length === 0 ? (
                          <div className="tc-empty">Every open item is claimed or parked — nothing free to hand over.</div>
                        ) : (
                          <>
                            <div className="tc-next">
                              {nextUp.map((it) => {
                                const on = picked.includes(it.id);
                                return (
                                  <button key={it.id} className={`tc-item${on ? ' on' : ''}`}
                                    onClick={() => togglePick(it.id)}
                                    title={it.note ? it.note.slice(0, 300) : undefined}>
                                    <span className="mark">{on ? '✓' : '○'}</span>
                                    <span className="body">
                                      <span className="t">{it.title}</span>
                                      <span className="m">
                                        #{it.id} · {it.bucket}
                                        {it.tier ? ` · ${it.tier}` : ''}
                                        {it.area ? ` · ${it.area}` : ''}
                                        {it.plan.length ? ` · ☰ ${it.plan.filter((s) => s.done).length}/${it.plan.length}` : ' · no plan'}
                                      </span>
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                            <div className="tc-send">
                              <button className="btn-submit sm" disabled={picked.length === 0 || !activeSess}
                                onClick={sendPicked}
                                title="Types the picked items at the prompt as one block — read it, then press Enter yourself">
                                Send{picked.length ? ` ${picked.length}` : ''} to the prompt
                              </button>
                              <span className="tc-note">typed, not run</span>
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    {/* ROSTER — deliberately thin. Stack keeps per-model usage
                        for autopilot runs, never for a terminal session (#283),
                        so the honest line is who is at the keyboard and the
                        host-wide day; anything more would be invented. */}
                    <div className="tc-block">
                      <div className="tc-cap">ROSTER</div>
                      <div className="tc-roster">
                        <span className="l">You and claude, in this tab</span>
                        <span className="s">{fmtTok(usedTokens)} tok today</span>
                      </div>
                      <div className="tc-note">
                        No per-model record for a terminal session — that figure is this host's whole day.
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="tc-body">
                    {brief && (
                      <div className="tc-block">
                        <div className="tc-cap">FROM THE ROADMAP</div>
                        <button className="tc-cmd brief" onClick={pasteBrief}
                          title="Types the roadmap brief into the active session — review it, then press Enter yourself">
                          ▶ Paste roadmap brief
                        </button>
                      </div>
                    )}
                    {RUNBOOK.map((g) => (
                      <div className="tc-block" key={g.name}>
                        <div className="tc-cap">{g.name}</div>
                        {g.items.map((c) => (
                          <div className="tc-cmd-row" key={c.cmd}>
                            <button className="tc-cmd" onClick={() => typeQuick(c.cmd)}
                              title={`Load "${c.cmd}" at the prompt`}>
                              <span className="c">{c.cmd}</span>
                              <span className="w">{c.why}</span>
                            </button>
                            <button className="tc-run" onClick={() => runQuick(c.cmd)}
                              aria-label={`Run ${c.cmd}`} title="Run it now">↵</button>
                          </div>
                        ))}
                      </div>
                    ))}
                    <div className="tc-block">
                      <div className="tc-cap">YOURS</div>
                      {customCmds.map((c, i) => (
                        <div className="tc-cmd-row" key={`${c.cmd}-${i}`}>
                          <button className="tc-cmd" onClick={() => typeQuick(c.cmd)}
                            title={`Load "${c.cmd}" at the prompt`}>
                            <span className="c">{c.label}</span>
                            <span className="w">{c.cmd === c.label ? '' : c.cmd}</span>
                          </button>
                          <button className="tc-run" onClick={() => runQuick(c.cmd)}
                            aria-label={`Run ${c.label}`} title="Run it now">↵</button>
                          <button className="term-cmd-x" onClick={() => dropCmd(i)}
                            aria-label={`Remove ${c.label}`} title="Remove">×</button>
                        </div>
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
                        <button className="tc-cmd add" onClick={() => setAdding(true)}>+ Add a command</button>
                      )}
                    </div>

                    {/* ✧ side gemini — command help. Suggestion only; nothing
                        runs until the human presses Enter in the terminal. */}
                    <div className="tc-block">
                      <div className="tc-cap">✧ COMMAND HELP</div>
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
                    </div>
                    <div className="tc-foot">
                      Ask in plain words at the prompt instead — the runbook is only for the ones you type every day.
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
    {killTargets && killTargets.length > 0 && (
      <ConfirmModal
        title={killTargets.length === 1 ? 'Kill detached session?' : `Kill ${killTargets.length} detached sessions?`}
        body={killTargets.length === 1 ? (
          <>The claude session in <b>{killTargets[0].cwd ? `~/${killTargets[0].cwd}` : '~'}</b> is still running
            on the host. Killing it ends the process — anything unfinished in that conversation is lost.</>
        ) : (
          <>These claude sessions are still running on the host. Killing them ends the processes —
            anything unfinished in those conversations is lost.
            <ul className="td-killlist">
              {killTargets.map((d) => (
                <li key={d.name}>
                  <b>{d.cwd ? `~/${d.cwd}` : '~'}</b>
                  {labels[d.name] || d.label ? ` — ${labels[d.name] || d.label}` : ''}
                </li>
              ))}
            </ul>
          </>
        )}
        confirmLabel={killTargets.length === 1 ? 'Kill session' : `Kill ${killTargets.length} sessions`}
        danger
        onConfirm={() => void confirmKill()}
        onCancel={() => setKillTargets(null)}
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
          totalTokens?: number; plan?: TermUsage['plan'];
        };
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'out' && m.data) scheduleWrite(b64decode(m.data));
        else if (m.t === 'usage' && typeof m.tokens === 'number') {
          onUsage({ tokens: m.tokens, totalTokens: m.totalTokens, resetAt: m.resetAt, resetLabel: m.resetLabel, sched: m.sched, plan: m.plan });
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
    // What the daemon was last told. The observer below fires on any pixel
    // change, but the pty only cares about CELLS — so a resize frame goes out
    // only when the grid actually changed, and a few stray pixels of layout
    // never chatter at the host.
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
    // The window is not the only thing that resizes this terminal. Collapsing
    // the cockpit rail, docking, wide mode — each changes the HOLDER's width
    // while the window stands still, and xterm only reflows when something
    // calls fit(). That was patched per-toggle by dispatching a synthetic
    // resize event, which meant every new layout control silently inherited
    // the bug until someone noticed the terminal had stopped reflowing.
    //
    // Watching the element instead fixes the whole class: whatever changes the
    // holder's size, for whatever reason, refits. The debounce above still
    // means the daemon is only told the settled size.
    const ro = new ResizeObserver(() => onResize());
    if (holderRef.current) ro.observe(holderRef.current);

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
      ro.disconnect();
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
