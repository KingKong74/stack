import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  openTerminal, getTermCmds, setTermCmds, type TermCmd,
  getTermUsagePrefs, setTermUsagePrefs, type TermUsagePrefs,
  getTermViewPrefs, setTermViewPrefs, type TermViewPrefs, TERM_PANE_CHOICES, type TermPaneCount,
  createAutopilotSchedule,
  getAutopilotJobs, resumeAutopilotJob, hangupAutopilotJob, type AutopilotJob,
  getTerminalUsage, type TerminalUsageData,
  getDetachedSessions, killDetachedSession, keepSession, type DetachedSession,
  labelTerminalSessions,
  getTermTmuxName, setTermTmuxName, clearTermTmuxName,
  getTermOpenTabs, setTermOpenTabs,
  getTermSessionPrefs, termAssist, type TermAssistSuggestion,
  getTermWorkingItem, setTermWorkingItem,
  getProjectDetail, type ProjectDetailData,
  patchRoadmapItem,
  getOverview,
} from '../store';
import { go, hrefTo } from '../lib/route';
import { useAutoRefresh } from '../lib/autoRefresh';
import { wireTermClipboard } from '../lib/termClipboard';
// The wire codec and the palette are shared with the tab agents' consoles
// (#379) — see lib/termWire.ts for why those three and nothing else.
import { b64encode, b64decode, GIT_BASH_THEME } from '../lib/termWire';
// #380 — a tab agent's console is an ordinary session on this screen in every
// way except its name, which is the only evidence here of what it is: this
// screen has no project payload and no agent state to read. Titling one
// `claude · stack` hides the one fact that distinguishes it from the four
// beside it, so the name is parsed back.
import { ConfirmModal } from '../components/ConfirmModal';
import { tierRank, TIERS, type RoadmapItem, type Tier } from '../types';
import { TopBar } from '../components/TopBar';

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
// #299 — the rail's sentinel for "no area tag". The leading space can never
// collide with a real area (areas are trimmed + lowercased), the same trick
// the board's Uncategorised tab uses.
const RAIL_UNTAGGED = ' untagged';
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
// `sid` is the RELAY's id for this session. The browser learns it from the
// daemon's frames (they are multiplexed by sid and the relay forwards them
// whole), and it is the only id that exists for EVERY session — a shell has no
// tmux name, so keying names by tmux is why shells used to go unnamed.
type Sess = { id: number; cwd: string; cmd: 'shell' | 'claude'; status: Status; note: string; tmux?: string; sid?: string };
type Handle = { sendText: (s: string) => void; reconnect: () => void; focus: () => void };

// Mounted once by App and never unmounted (#137): sessions, sockets and
// scrollback survive navigation. `visible` = the #/terminal route is showing;
// away from it the component renders as the floating dock (#139) — minimised
// to a bottom-right chip by default, expandable to a small floating panel.
export function Terminal({ initialCwd = '', initialAttach, initialBrief, visible = true, onAlive }: {
  initialCwd?: string; initialAttach?: string; initialBrief?: boolean; visible?: boolean;
  onAlive?: (liveCount: number) => void;
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
  // #305 — full screen. The pane grid is sized by a magic `calc(100vh - 210px)`
  // that has to guess at the chrome above it; in full screen it stops guessing
  // and simply takes what is left of a viewport with nothing else in it. The
  // browser's own Fullscreen API is asked for on top, because it buys the
  // browser chrome too — but the CSS mode is what the layout keys on, so a
  // refused or unsupported request still gives the terminals the window.
  // Deliberately NOT persisted: this is a moment, not a preference, and no
  // amount of remembering can re-enter the browser's fullscreen without a
  // fresh gesture — a stored `true` would just come back as a lie.
  const [full, setFull] = useState(false);
  const toggleFull = () => {
    const next = !full;
    setFull(next);
    // The DOCUMENT goes fullscreen, not the terminal element. In real
    // fullscreen only the fullscreen element's subtree renders, and this
    // screen's modals (the detached-session kill confirm) are SIBLINGS of it —
    // fullscreening the screen itself would make a confirm dialog invisible
    // while it still held the interaction.
    if (next) void document.documentElement.requestFullscreen?.().catch(() => { /* CSS mode carries it */ });
    else if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
  };
  // Leaving the browser's fullscreen (esc, or the window chrome) has to bring
  // the CSS mode back with it, or the page would sit locked over the app with
  // its only way out being a button the user just tried to press.
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setFull(false); };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  // A session opened away from #/terminal must never strand the screen
  // full-screen over the rest of the app.
  useEffect(() => { if (!visible && full) setFull(false); }, [visible, full]);
  const prevVisible = useRef(visible);
  useEffect(() => {
    if (prevVisible.current && !visible) setDock('min');
    prevVisible.current = visible;
  }, [visible]);

  const [customCmds, setCustomCmds] = useState<TermCmd[]>(() => getTermCmds());

  // The copy receipt. xterm draws to a canvas, so a copy leaves nothing on the
  // page to look at — without a mark, a working copy and a failed one look
  // identical, which is how "I can't copy from the terminal" survives a fix.
  const [copied, setCopied] = useState<{ id: number; label: string } | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noteCopied = (id: number, text: string) => {
    const lines = text.split('\n').length;
    setCopied({ id, label: lines > 1 ? `copied ${lines} lines` : `copied ${text.length} chars` });
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 1600);
  };
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

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
  // #276 — "Jump back in" opens the terminal already briefed: reuse the same
  // rail state a manual toggle would set (no second "briefed" flag), so the
  // rail opens on the ↩ Debrief segment rather than landing collapsed or on
  // whichever segment was last open.
  useEffect(() => {
    if (initialBrief) saveViewPrefs({ railOpen: true, railSeg: 'runbook' });
  }, [initialBrief]); // eslint-disable-line react-hooks/exhaustive-deps

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
        if (stored
          && !s.some((x) => x.tmux === stored && (x.status === 'live' || x.status === 'connecting'))) {
          name = stored;
        }
      }
      return [...s, { id, cwd: cwdKey, cmd, status: 'connecting', note: '', tmux: name }];
    });
    setActive(id);
    return id;
  };
  // The screen comes BACK the way it was left. Every tab this device had open
  // is restored first — claude tabs by re-attaching their tmux session (the
  // process survived the reload; that is the point of #171), shell tabs as
  // fresh shells in the same directory — so four terminals reload as four
  // terminals rather than one. Only then does the route get its say: an
  // ?attach= / ?cwd= that a restored tab already covers just focuses that tab
  // instead of opening a duplicate.
  //
  // With nothing remembered, one session still opens itself, as it always
  // did — the screen is never empty. The kind comes from the device pref
  // (default claude, skip-permissions via the start frame). A bare open (no
  // cwd, no attach, nothing stored) lands in the most recently touched project
  // rather than $HOME — claude in the home directory helps nobody; overview's
  // resume slug is the "current" project. Falls back to home on any miss.
  useEffect(() => {
    const saved = getTermOpenTabs();
    const ids = saved.map((t) => openSession(t.cwd, t.cmd, t.tmux));
    if (initialAttach) {
      const i = saved.findIndex((t) => t.tmux === initialAttach);
      if (i >= 0) setActive(ids[i]);
      else openSession(initialCwd, 'claude', initialAttach);
      return;
    }
    if (initialCwd) {
      const i = saved.findIndex((t) => t.cwd === initialCwd);
      if (i >= 0) setActive(ids[i]);
      // The device's autoStart is what a plain ⌨ press should respect, but a
      // button labelled "Jump back in" that lands you in a bare shell has not
      // done what it said — it always opens claude.
      else openSession(initialCwd, initialBrief ? 'claude' : getTermSessionPrefs().autoStart);
      return;
    }
    if (ids.length) { setActive(ids[0]); return; }
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

  // …and is remembered as it changes. Written from the live tabs only: a
  // closed pane is not something to bring back, and the tmux name rides along
  // so the restore re-attaches the same host session rather than spawning a
  // new one. The FIRST run is skipped: it fires alongside the mount effect
  // above, whose sessions have not landed in state yet, and would write the
  // empty list straight back over what the restore just read.
  const persistReady = useRef(false);
  useEffect(() => {
    if (!persistReady.current) { persistReady.current = true; return; }
    setTermOpenTabs(sessions
      .filter((s) => s.status === 'live' || s.status === 'connecting')
      .map((s) => ({ cwd: s.cwd, cmd: s.cmd, tmux: s.tmux })));
  }, [sessions]);

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
    else openSession(initialCwd, initialBrief ? 'claude' : getTermSessionPrefs().autoStart);
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
  }, [visible, dock, full, viewPrefs.panes, viewPrefs.railOpen]);

  const closeSession = (id: number, opts?: { shrink?: boolean }) => {
    handles.current.delete(id);
    setSessions((s) => {
      const rest = s.filter((x) => x.id !== id);
      if (id === active && rest.length) setActive(rest[rest.length - 1].id);
      return rest;
    });
    // Closing a pane from the grid LESSENS the grid. The count would clamp to
    // the sessions that are left anyway, but leaving the stored number high
    // means the next session you open silently re-splits the screen — so the
    // close is taken as the intent it looks like.
    if (opts?.shrink && viewPrefs.panes > 1) saveViewPrefs({ panes: (viewPrefs.panes - 1) as TermPaneCount });
  };

  // End a session for REAL: close the tab, then kill the tmux session it was
  // attached to. Two steps because the daemon only accepts a kill for a name
  // in its DETACHED list — a name a client still holds never matches, which is
  // what stops one browser killing another's session. So we detach first and
  // wait for the daemon to advertise it, which it does as soon as the shim
  // exits rather than on its slow tick.
  //
  // Without a tmux session there is nothing to kill: closing the tab already
  // ends the process, so the close IS the end.
  const [ending, setEnding] = useState<number | null>(null);
  const endSession = async (sess: Sess) => {
    const name = sess.tmux;
    closeSession(sess.id, { shrink: true });
    if (!name) return;
    setEnding(sess.id);
    try {
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const list = await getDetachedSessions().catch(() => []);
        if (list.some((d) => d.name === name)) {
          await killDetachedSession(name).catch(() => { /* reported by the refresh below */ });
          break;
        }
      }
    } finally {
      setEnding(null);
      void refreshDetached();
    }
  };

  // The per-tab ⏻ done to every tab at once. Same two steps as `endSession` —
  // close the tab (which detaches its tmux session), then kill the name once
  // the daemon advertises it — but the closes are ONE state write so the tab
  // strip and the panes cannot disagree about what is open, and the poll is
  // SHARED so N sessions cost one wait rather than N. A tab with no tmux
  // session needs no kill: closing it already ends the process. As in
  // `confirmKill`, `clearTermTmuxName` is called per killed name so a reload
  // does not try to resume a name that is now dead. A name the daemon never
  // advertises inside the poll window is NOT killed — it stays detached and
  // reappears in the detached strip (`refreshDetached` re-reads on the way
  // out), where it can be killed by hand. A kill that quietly did not land
  // must not read as one that did.
  const [endingAll, setEndingAll] = useState(false);
  // `sessions` empties synchronously below, so the button's own label has
  // nothing to count off while the kills are still landing — this is the
  // count it reads instead for exactly that window.
  const [endingAllCount, setEndingAllCount] = useState(0);
  const [endAllAsk, setEndAllAsk] = useState(false);
  const endAllSessions = async () => {
    const list = sessions;
    setEndingAllCount(list.length);
    const cwdOf = new Map(list.filter((s) => s.tmux).map((s) => [s.tmux!, s.cwd]));
    handles.current.clear();
    setSessions([]);
    setActive(0);
    if (viewPrefs.panes > 1) saveViewPrefs({ panes: 1 });
    const left = new Set(cwdOf.keys());
    if (!left.size) return;
    setEndingAll(true);
    try {
      for (let i = 0; i < 12 && left.size; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const adv = await getDetachedSessions().catch(() => []);
        for (const d of adv) {
          if (!left.has(d.name)) continue;
          left.delete(d.name);
          clearTermTmuxName(cwdOf.get(d.name) ?? d.cwd, d.name);
          await killDetachedSession(d.name).catch(() => { /* the refresh below tells the truth */ });
        }
      }
    } finally {
      setEndingAll(false);
      void refreshDetached();
    }
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
  // #312 — and then it KEEPS UP. The two triggers above are both things this
  // browser did; everything that happens to a session happens somewhere else —
  // the host's idle reaper takes one (#287), `stack term` on the laptop opens
  // one, a night's session ends. None of those reach here, so the strip used to
  // be as old as the last thing you clicked and the only fix was a reload.
  useAutoRefresh(() => void refreshDetached(), visible);

  // #292 — pin a session against the host's idle reaper (#287). The pin lives
  // on the tmux session itself, so this only ASKS: the row is flipped
  // optimistically for the press to feel like one, and the daemon's next
  // advertisement is the value that stands. A failed pin therefore corrects
  // itself within a beat rather than leaving the chip claiming a protection
  // the host does not have.
  const togglePin = async (name: string, keep: boolean) => {
    setDetached((l) => l.map((d) => (d.name === name ? { ...d, keep } : d)));
    try { await keepSession(name, keep); } catch { /* the refresh below tells the truth */ }
    setTimeout(() => void refreshDetached(), 400);
  };
  // What the host says about a tab's own tmux session — the pin state a pane
  // renders. A tab whose session the daemon has not advertised yet has no
  // answer, which reads as unpinned, the same as the reaper would read it.
  const pinnedOf = (tmux?: string) => !!tmux && detached.some((d) => d.name === tmux && d.keep);

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
  //
  // BUG-13 is GONE with the tab consoles. The guard here refused to write an
  // agent console's deterministic name (`stack-term-auditor-<slug>`) into the
  // cwd's resume map, because that map answers "which ad-hoc session was I
  // last running here" and a console was not ad-hoc — so remembering one made
  // every new claude tab in that directory re-attach the agent's session. No
  // session is spawned under an agent's name any more, so every name reaching
  // this screen is an ordinary one and is remembered as such. A console left
  // running from before still attaches; it is simply a claude session now,
  // which is all it ever was underneath.
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
  const labelBusyRef = useRef(false);
  const refreshLabels = async () => {
    // Guard on a REF, not the state: two triggers in the same tick would both
    // read the stale `false` and fire two Gemini calls for one set of tabs.
    if (labelBusyRef.current) return;
    labelBusyRef.current = true;
    setLabelBusy(true);
    try {
      const r = await labelTerminalSessions();
      setLabels((prev) => {
        const next = { ...prev };
        // Key by SID — every session has one, so shells get named too. The
        // tmux name is kept as a second key so a detached chip and the tab
        // that later re-attaches it read the same.
        for (const s of r.sessions) {
          if (!s.label) continue;
          next[s.sid] = s.label;
          if (s.tmux) next[s.tmux] = s.label;
        }
        for (const d of r.detached) if (d.label) next[d.name] = d.label;
        return next;
      });
      // Everything on screen has just been named, so nothing is owed a re-ask.
      dirtyRef.current = {};
      lastLabelAt.current = Date.now();
    } catch { /* keyless (503) or offline — sessions just stay unnamed */ }
    finally { labelBusyRef.current = false; setLabelBusy(false); }
  };
  // Bytes each session has emitted since it was last named, and when we last
  // asked. A title that says what you are working on has to follow the work,
  // and the work shows up as OUTPUT — so the re-ask is driven by the session
  // talking, not by a clock. An idle screen makes no calls at all; a busy one
  // re-titles about a minute after the conversation moves on.
  const dirtyRef = useRef<Record<number, number>>({});
  const lastLabelAt = useRef(0);
  const noteOutput = (id: number, bytes: number) => {
    dirtyRef.current[id] = (dirtyRef.current[id] || 0) + bytes;
  };
  const RELABEL_BYTES = 1500;      // roughly a screenful of new conversation
  const RELABEL_MIN_MS = 60_000;   // never more than once a minute, whatever happens
  // Names arrive by themselves, and then KEEP UP. Two triggers, one call:
  //   • something on screen is unnamed — a new tab, a fresh detached chip;
  //   • something named has since said enough to have moved on.
  // Both are checked on a slow tick rather than in a render effect, so a
  // re-render can never re-ask and the cost is bounded to one call a minute
  // even when every pane is busy.
  useEffect(() => {
    if (!visible) return;
    const tick = () => {
      const live = sessions.filter((x) => x.status === 'live' || x.status === 'connecting');
      if (!live.length && !detachedShown.length) return;
      const unnamed = [
        ...live.filter((x) => !labelOf(x)).map((x) => x.id),
        ...detachedShown.filter((d) => !labels[d.name]).map((d) => d.name),
      ];
      const moved = live.some((x) => (dirtyRef.current[x.id] || 0) >= RELABEL_BYTES);
      if (!unnamed.length && !moved) return;
      // An unnamed session is worth asking for straight away; a re-ask for one
      // that has merely moved on waits out the floor.
      if (!unnamed.length && Date.now() - lastLabelAt.current < RELABEL_MIN_MS) return;
      void refreshLabels();
    };
    tick();
    const t = setInterval(tick, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessions, detached, labels]);
  // Named by sid first (every session has one), falling back to the tmux name
  // so a tab that re-attached a detached session inherits the name it wore as
  // a chip instead of reading as unnamed until the next ask.
  const labelOf = (s: Sess) => (s.sid && labels[s.sid]) || (s.tmux && labels[s.tmux]) || '';
  const claudeLive = sessions.some((s) => s.cmd === 'claude' && (s.status === 'live' || s.status === 'connecting'));
  // Which sessions are on screen. The window STARTS at the active tab, so
  // clicking a tab always puts it top-left with its neighbours filling in
  // beside it — predictable enough to navigate without thinking, and it never
  // reorders the tab strip under you. Near the end of the list the window
  // backs up so the panes stay full rather than leaving holes.
  const paneCount = Math.max(1, Math.min(viewPrefs.panes, Math.max(1, sessions.length)));
  const activeIdx = Math.max(0, sessions.findIndex((s) => s.id === active));
  const paneStart = Math.max(0, Math.min(activeIdx, sessions.length - paneCount));
  const shownIds = sessions.slice(paneStart, paneStart + paneCount).map((s) => s.id);

  // Asking for N terminals is asking for N terminals. The pane control used to
  // set a number and stop, so choosing 4 with one session open left one pane
  // and three holes — the grid clamps to what exists — even while claude was
  // still running on the host in sessions nobody was attached to. So the
  // choice FILLS the screen: jump into those first (that is where the work
  // already is, and re-attaching costs nothing), newest survivors before ones
  // a client holds elsewhere (attaching to those only mirrors them), then open
  // fresh sessions in the active tab's directory for whatever is still short.
  const [filling, setFilling] = useState(false);
  const choosePanes = async (n: TermPaneCount) => {
    saveViewPrefs({ panes: n });
    const liveNow = sessions.filter((s) => s.status === 'live' || s.status === 'connecting');
    let need = n - liveNow.length;
    if (need <= 0 || filling) return;
    setFilling(true);
    try {
      const held = new Set(liveNow.map((s) => s.tmux).filter((t): t is string => !!t));
      // Fetched fresh rather than read off the strip: the cached list is as old
      // as the last push, and this is the moment it matters.
      const pool = (await getDetachedSessions().catch(() => detached))
        .filter((d) => !held.has(d.name))
        .sort((a, b) => (a.attached ? 1 : 0) - (b.attached ? 1 : 0) || b.created - a.created);
      const take = pool.slice(0, need);
      for (const d of take) { held.add(d.name); openSession(d.cwd, 'claude', d.name); }
      need -= take.length;
      if (take.length) setDetached((l) => l.filter((x) => !held.has(x.name)));
      const dir = (sessions.find((s) => s.id === active)?.cwd ?? cwd).trim();
      for (let i = 0; i < need; i++) openSession(dir, getTermSessionPrefs().autoStart);
    } finally {
      setFilling(false);
      void refreshDetached();
    }
  };


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
  // Everything the rail could hand over, in the runner's own order.
  const nextAll = useMemo(() => (board ? nextUpItems(board.roadmap) : []), [board]);
  // #299, reshaped this turn — the rail offers the same list two ways, and
  // NEITHER of them reorders it, so what the rail hands over is still what the
  // night would take. The old version stacked three rows of filter chips and a
  // fifteen-option tab select above two rows of list; both layouts below spend
  // that chrome on the list instead:
  //   tiers  (1a) the TIER is the layout — one lane per tier, each showing its
  //          first two rows — and the tab narrows to one scope behind a single
  //          control. Nothing to read to know the shape of the queue.
  //   upnext (1b) ONE item is promoted, ready to send in a press; everything
  //          else is reached by typing (`tier:a`, `tab:polaris`, free text) and
  //          the tier groups fold away.
  // Which one is on screen is device-local (viewPrefs.railStyle).
  const railStyle = viewPrefs.railStyle;
  const [railArea, setRailArea] = useState('');          // '' = every tab
  const [railRisk, setRailRisk] = useState<'' | 'low' | 'high'>('');
  const [scopeOpen, setScopeOpen] = useState(false);     // 1a — the scope popover
  const [laneOpen, setLaneOpen] = useState<string[]>([]); // 1a — lanes past their first two
  const [railQuery, setRailQuery] = useState('');        // 1b — the typed filter
  const [bulk, setBulk] = useState(false);               // 1b — tick-several mode
  const [tierShut, setTierShut] = useState<string[]>([]); // 1b — folded tier groups
  // 1b — which item is promoted, and the ones you have waved past. Both are
  // ways of LOOKING at the queue: skipping changes nothing on the board (the
  // runner's order is unmoved), it just asks the rail for the next one down.
  const [promoted, setPromoted] = useState<number | null>(null);
  const [passed, setPassed] = useState<number[]>([]);
  // What is ticked for the next send. ONE list across both layouts: flipping the
  // rail is a change of view, and a view change that dropped your ticks would
  // make the switch cost something.
  const [picked, setPicked] = useState<number[]>([]);
  const togglePick = (id: number) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  useEffect(() => {
    setRailArea(''); setRailRisk(''); setRailQuery(''); setPicked([]);
    setLaneOpen([]); setPromoted(null); setPassed([]);
  }, [projectSlug]);
  // The tabs the rail can offer, counted over what is actually handable.
  const railAreas = useMemo(() => {
    const seen = new Map<string, number>();
    for (const it of nextAll) {
      const k = it.area || RAIL_UNTAGGED;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    return [...seen.entries()].sort((a, b) =>
      (a[0] === RAIL_UNTAGGED ? 1 : 0) - (b[0] === RAIL_UNTAGGED ? 1 : 0) || a[0].localeCompare(b[0]));
  }, [nextAll]);
  const railTierCount = (t: Tier) => nextAll.filter((it) => it.tier === t).length;
  const railRiskCount = (r: 'low' | 'high') => nextAll.filter((it) => it.risk === r).length;
  // Lanes and groups run S → A → B → C → unranked, the run queue's own order
  // (tierRank sorts '' last), so reading the rail top to bottom reads the queue.
  const LANES: Tier[] = [...TIERS, ''];
  const laneKey = (t: Tier) => t || 'none';
  const laneName = (t: Tier) => (t ? `tier ${t}` : 'unranked');

  // ---- 1a: the tier stack ----
  // The scope: a tab, a risk class, or both. Tier is deliberately NOT one of
  // them here — it is the shape of the list, so scoping by it would be asking
  // the same question twice.
  const scoped = useMemo(() => nextAll.filter((it) =>
    (!railArea || (railArea === RAIL_UNTAGGED ? !it.area : it.area === railArea))
    && (!railRisk || it.risk === railRisk)), [nextAll, railArea, railRisk]);
  const scopeLabel = [
    railArea ? (railArea === RAIL_UNTAGGED ? 'untagged' : railArea) : 'all tabs',
    railRisk === 'low' ? '⇣ low' : railRisk === 'high' ? '⇡ high' : '',
  ].filter(Boolean).join(' · ');
  const LANE_CAP = 2; // rows per lane before "+N more" — the lane, not the rail, is the unit
  const lanes = useMemo(() => LANES.map((t) => {
    const all = scoped.filter((it) => it.tier === t);
    const open = laneOpen.includes(laneKey(t));
    const shown = open ? all : all.slice(0, LANE_CAP);
    const hidden = all.length - shown.length;
    return {
      tier: t, all, shown,
      // The fold is only offered where it does something: a lane that fits in
      // LANE_CAP has nothing to open and nothing to close.
      more: hidden > 0 ? `+${hidden} more` : open && all.length > LANE_CAP ? 'fewer' : '',
      note: t === 'S' && all.length > 0 ? 'send first' : t === '' ? 'needs a tier' : '',
    };
    // An unranked lane with nothing in it is not news; an empty TIER is — a
    // board with nothing at S says so, and that is why the lane is drawn.
  }).filter((ln) => ln.tier !== '' || ln.all.length > 0), [scoped, laneOpen]);
  const laneShape = LANES
    .map((t) => `${t || 'unranked'} ${scoped.filter((it) => it.tier === t).length}`).join(' · ');
  // Ticks are resolved against the SCOPE, so "select all" and the count on the
  // send button mean the list you are looking at.
  const scopedPicked = picked.filter((id) => scoped.some((it) => it.id === id));
  const allScopedPicked = scoped.length > 0 && scopedPicked.length === scoped.length;

  // ---- 1b: up next ----
  // Typed filter. `tier:`, `tab:`, `risk:` and `plan:none` are exact questions;
  // anything else is free text over the title, the tab and the #id. Every term
  // must match, so two tokens narrow rather than widen.
  const matched = useMemo(() => {
    const terms = railQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return nextAll;
    return nextAll.filter((it) => terms.every((t) => {
      if (t.startsWith('tier:')) return it.tier.toLowerCase() === t.slice(5);
      if (t.startsWith('tab:')) return (it.area || 'untagged').toLowerCase().includes(t.slice(4));
      if (t.startsWith('risk:')) return it.risk === t.slice(5);
      if (t === 'plan:none') return it.plan.length === 0;
      return `${it.title} ${it.area} #${it.id}`.toLowerCase().includes(t);
    }));
  }, [nextAll, railQuery]);
  // The promoted item: the one you picked if it survives the filter, else the
  // top of the queue you haven't waved past. Skipping the last one leaves NO
  // promotion rather than quietly re-offering something you just passed on —
  // the card says so, and every skipped item is still in the list below.
  const topItem = matched.find((it) => it.id === promoted)
    ?? matched.find((it) => !passed.includes(it.id))
    ?? null;
  const groups = useMemo(() => LANES.map((t) => ({
    tier: t,
    items: matched.filter((it) => it.tier === t && it.id !== topItem?.id),
    open: !tierShut.includes(laneKey(t)),
  })).filter((g) => g.items.length > 0), [matched, topItem, tierShut]);
  // Filter tokens are offered only where they'd land on something — a chip for
  // a tier nothing sits at is a dead press.
  const railTokens = useMemo(() => {
    const out: string[] = [];
    for (const t of TIERS) if (railTierCount(t) > 0) out.push(`tier:${t.toLowerCase()}`);
    for (const r of ['low', 'high'] as const) if (railRiskCount(r) > 0) out.push(`risk:${r}`);
    for (const [a] of railAreas) if (a !== RAIL_UNTAGGED) out.push(`tab:${a}`);
    if (nextAll.some((it) => it.plan.length === 0)) out.push('plan:none');
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextAll, railAreas]);
  const matchedPicked = picked.filter((id) => matched.some((it) => it.id === id));
  const allMatchedPicked = matched.length > 0 && matchedPicked.length === matched.length;

  // One list row, shared by both layouts: the title, then the machine facts on a
  // mono line. Borderless by default — the ring only appears on a ticked row, so
  // a list of twelve is twelve lines rather than twelve boxes. The tick square
  // is drawn only where a tick is what a click MEANS (1a always, 1b in select
  // mode); in 1b a bare click promotes instead, and a checkbox would lie about
  // that.
  const railRow = (it: RoadmapItem, opts: { tick: boolean; toggle: boolean; onClick: () => void }) => {
    const on = picked.includes(it.id);
    return (
      <button key={it.id} className={`tcs-row${on ? ' on' : ''}`} onClick={opts.onClick}
        aria-pressed={opts.toggle ? on : undefined}
        title={it.note ? it.note.trim().slice(0, 300) : undefined}>
        {opts.tick && <span className={`box${on ? ' on' : ''}`}>{on ? '✓' : ''}</span>}
        <span className="b">
          <span className="t">{it.title}</span>
          <span className="m">
            #{it.id}<span className="sep">·</span>{it.bucket}
            <span className="sep">·</span><span className="tab">{it.area || 'untagged'}</span>
            {it.risk !== 'normal' && <><span className="sep">·</span>{it.risk === 'low' ? '⇣' : '⇡'}</>}
            {it.plan.length === 0 && <><span className="sep">·</span>no plan</>}
          </span>
        </span>
      </button>
    );
  };

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

  // Handing an item over CLAIMS it. The pin above is device-local by design,
  // but "I am working this now" is not a browser fact — the overnight runner
  // would otherwise pick up an item you are half-way through in a tab. So the
  // send writes a real claim (#277), which drops the item out of DO NEXT
  // everywhere, wears the ⚑ chip on the board and makes the runner skip it.
  // The claim names the SESSION rather than a branch, honestly: a terminal tab
  // has no branch to name, and a claim that lied about one would be worse than
  // one that says where it came from.
  const claimLabel = activeSess?.tmux ? `term:${activeSess.tmux}` : `term:${projectSlug || 'session'}`;
  const isTermClaim = (c: string) => c.startsWith('term:');
  const [claimNote, setClaimNote] = useState('');
  // Fold a claim change into the loaded board so DO NEXT settles immediately —
  // the detail fetch only re-runs on a cwd change or a re-show.
  const applyClaim = (ids: number[], claim: string) => setDetail((d) => {
    if (!d) return d;
    const bucket = (list: RoadmapItem[]) =>
      list.map((it) => (ids.includes(it.id) ? { ...it, claimedBy: claim } : it));
    return {
      ...d,
      roadmap: {
        must: bucket(d.roadmap.must), should: bucket(d.roadmap.should),
        could: bucket(d.roadmap.could), wont: bucket(d.roadmap.wont),
      },
    };
  });

  // Send = type the brief at the prompt (bracketed, so a multi-line block
  // lands as one paste), remember the first item as what this session is on
  // and claim the lot. Nothing runs: the human presses Enter. The typing is
  // unconditional — it has already happened by the time the claims are
  // written, so a failed claim reports itself rather than pretending.
  //
  // Both layouts come through here: 1a sends the ticked set, 1b sends the one
  // promoted item (and the ticked set when it is in select mode).
  const sendItems = async (send: number[]) => {
    const h = handles.current.get(active);
    if (!h || send.length === 0) return;
    // Resolved against the WHOLE eligible list, not the filtered slice, so a
    // pick survives switching scope — one send can carry two areas (#299) — and
    // always goes over in the runner's order rather than the order you ticked.
    const items = nextAll.filter((it) => send.includes(it.id));
    if (!items.length) return;
    h.sendText(`\x1b[200~${itemsBrief(items)}\x1b[201~`);
    h.focus();
    pinWorking(items[0].id);
    const ids = items.map((it) => it.id);
    setPicked((p) => p.filter((x) => !ids.includes(x)));
    // Sending consumes the promotion: the claim drops the item out of the queue,
    // so the next one down is what 1b should be offering.
    setPromoted(null);
    applyClaim(ids, claimLabel);
    setClaimNote('');
    try {
      for (const id of ids) await patchRoadmapItem(projectSlug, id, { claimed_by: claimLabel });
    } catch {
      applyClaim(ids, '');
      setClaimNote('Sent to the prompt, but the claim did not save — the board still reads it as free.');
    }
  };

  // Release = give the item back to the board (and to the runner). Only ever
  // offered for a claim this screen made; a branch claim from a real lane is
  // not this tab's to drop.
  const releaseWorking = async () => {
    if (!workingItem) return;
    const id = workingItem.id;
    applyClaim([id], '');
    setClaimNote('');
    try { await patchRoadmapItem(projectSlug, id, { claimed_by: '' }); }
    catch {
      applyClaim([id], claimLabel);
      setClaimNote('Could not release the claim just now.');
    }
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
  // sits in the queue as a kind='resume' job. Read while the screen is showing
  // (the component never unmounts), re-checked when a limit frame lands, and
  // kept up by the device's auto refresh (#312). Resume clears the hold;
  // hang-up parks it for later.
  const [resumeJob, setResumeJob] = useState<AutopilotJob | null>(null);
  // Sequenced rather than flag-guarded: a poll and a cwd change can be in
  // flight together, and only the LAST ask may answer — otherwise a slow reply
  // for the directory you just left paints its resume chip over the new one.
  const resumeAsk = useRef(0);
  const checkResume = () => {
    if (!visible || !projectSlug) return;
    const seq = ++resumeAsk.current;
    getAutopilotJobs(projectSlug, 8)
      .then((jobs) => {
        if (seq !== resumeAsk.current) return;
        setResumeJob(jobs.find((j) => j.kind === 'resume' && (j.status === 'queued' || j.status === 'paused')) ?? null);
      })
      .catch(() => { /* quiet — the chip just stays away */ });
  };
  useEffect(() => {
    if (!visible || !projectSlug) { setResumeJob(null); return; }
    checkResume();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, projectSlug, usage?.resetAt]);
  useAutoRefresh(checkResume, visible && !!projectSlug);
  const resumeAt = resumeJob?.notBefore
    ? new Date(resumeJob.notBefore).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';
  const actOnResume = async (act: (id: string) => Promise<AutopilotJob>) => {
    if (!resumeJob) return;
    try { setResumeJob(await act(resumeJob.id)); } catch { /* next poll corrects */ }
  };

  // Read /api/terminal/usage for the nightly token budget and 24h autopilot
  // totals. Gated on visible; silent on error (the strip falls back to daemon
  // data alone), and kept current by the device's auto refresh (#312).
  const loadServerUsage = () => {
    getTerminalUsage()
      .then(setServerUsage)
      .catch(() => { /* silent — strip shows daemon data when server is unreachable */ });
  };
  useEffect(() => { if (visible) loadServerUsage(); }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  useAutoRefresh(loadServerUsage, visible);

  const dockLabel = activeSess
    ? `${activeSess.cmd === 'claude' ? 'claude' : 'shell'}${activeSess.cwd ? ` · ${activeSess.cwd}` : ''}`
    : 'terminal';
  const floatOpen = !visible && dock === 'float' && liveCount > 0;

  return (
    <>
    <div className={`term-screen${visible ? (full ? ' term-fullscreen' : '') : floatOpen ? ' term-float' : ' term-hidden'}`}>
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
      {/* #316 — the review quick link is the rail's `review ↗`, not a second
          button up here: one entrance per screen. */}
      <TopBar crumb={[{ label: 'Projects', onClick: go.dashboard }, { label: 'Terminal' }]}
        actions={<a className="btn-repo" href={hrefTo.control} title="Mission Control">Mission Control</a>} />

      {/* Panes > 1 takes the full viewport width by itself. That is what the
          old wide-mode button did, now tied to the reason people pressed it:
          you widen the screen because you want more than one session on it. */}
      <div className={`page detail term-page${viewPrefs.panes > 1 ? ' term-wide' : ''}`}>
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
                    title={[label, s.tmux ? `tmux ${s.tmux}` : ''].filter(Boolean).join(' — ') || undefined}>
                    <span className={`dot ${s.status}`} />
                    {`${s.cmd === 'claude' ? 'claude' : 'shell'}${s.cwd ? ` · ${s.cwd}` : ''}`}
                    {/* #120 — what this session is doing, in its own words via
                        Gemini. Absent until one comes back: a tab with no name
                        reads as unnamed, never as idle. */}
                    {label && <span className="tab-label">{label}</span>}
                  </button>
                  {/* Closing a session that is ON SCREEN lessens the grid,
                      whichever control you close it from — the tab and the
                      pane are two handles on the same session, so they should
                      not leave the screen in different states. */}
                  <button className="term-tab-x"
                    onClick={() => closeSession(s.id, { shrink: shownIds.includes(s.id) })}
                    aria-label="Close session" title="Close">×</button>
                </span>
              );
            })}
          </div>
          {/* Called END, not close, on purpose — the tab and pane controls
              already name the two endings apart (× closes a tab and the host
              session keeps running, ⏻ is the one that stops it), so a control
              that kills must not be spelled "close". It sits at the end of
              the tab strip because that is the thing it acts on. */}
          {(sessions.length > 0 || endingAll) && (
            <button className="btn-cancel sm" disabled={endingAll} onClick={() => setEndAllAsk(true)}
              title={`End every session — closes all ${sessions.length} tab${sessions.length === 1 ? '' : 's'} and kills the ones still running on the host`}>
              {endingAll ? `⏻ Ending ${endingAllCount}…` : `⏻ End all ${sessions.length}`}
            </button>
          )}
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
          {/* How many terminals are on screen at once — this replaced the
              wide-mode toggle. Panes are filled from the active tab onwards,
              so picking a tab puts it top-left and its neighbours beside it. */}
          <span className="seg-control sm term-panes" role="tablist" aria-label="Terminals on screen">
            {TERM_PANE_CHOICES.map((n) => (
              <button key={n} role="tab" aria-selected={viewPrefs.panes === n}
                className={`seg-opt ${viewPrefs.panes === n ? 'on' : ''}`}
                title={n === 1
                  ? 'One terminal, normal page width'
                  : `${n} terminals side by side — the screen goes full width.`
                    + ' Empty panes fill from the sessions still running on the host,'
                    + ' then with new ones.'}
                onClick={() => void choosePanes(n)}>
                {n === 1 ? '▢' : `▢${n}`}
              </button>
            ))}
          </span>
          {/* #305 — the grid takes the whole window. Sits beside the pane
              count because they are the same question asked twice: how much
              screen do these terminals get. The head bar itself survives, so
              the way out is where the way in was. */}
          <button className={`btn-repo sm term-full-btn${full ? ' on' : ''}`} onClick={toggleFull}
            aria-pressed={full}
            title={full
              ? 'Leave full screen (esc also works)'
              : 'Full screen — the terminals take the whole window and the page chrome goes away'}>
            {full ? '⤡' : '⤢'}
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
                <span key={d.name} className={`td-chip${d.attached ? ' away' : ''}${picked ? ' picked' : ''}${d.keep ? ' pinned' : ''}`}>
                  {/* #292 — the keep pin. Offered on EVERY chip, attached or
                      not: the reaper measures output, not attachment, so a
                      session mirrored on another device is exactly as
                      reapable as an orphan and exactly as worth protecting. */}
                  <button className={`td-pin${d.keep ? ' on' : ''}`} aria-pressed={!!d.keep}
                    aria-label={d.keep ? `Unpin ${d.name}` : `Pin ${d.name}`}
                    title={d.keep
                      ? 'Pinned — the idle reaper will not take this session. Click to unpin.'
                      : 'Pin this session so the idle reaper never takes it, however quiet it goes'}
                    onClick={() => void togglePin(d.name, !d.keep)}>
                    {d.keep ? '📌' : '📍'}
                  </button>
                  <button className="td-attach"
                    title={[
                      d.attached
                        ? `Attached on another device (tmux ${d.name}) — open it here too: both screens mirror the same session`
                        : `Re-attach to this running claude session (tmux ${d.name}${d.created ? `, since ${new Date(d.created).toLocaleString()}` : ''})`,
                    ].filter(Boolean).join(' ')}
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
          <div className={`term-main term-grid p${paneCount}`}>
            {sessions.map((s) => {
              const shown = shownIds.includes(s.id);
              // Every session stays MOUNTED whether or not it is on screen —
              // unmounting one would drop its socket and its scrollback, which
              // is the whole reason this component never unmounts either. Off
              // -screen panes are hidden, not destroyed.
              // `lead` marks the FIRST pane on screen, which the 3-up layout
              // gives the tall left column to. It has to be a class rather than
              // :first-child, because off-screen panes stay in the DOM (they
              // keep their sockets) and would win that selector while invisible.
              return (
              <div key={s.id} className={`term-pane${shown ? '' : ' off'}${s.id === active ? ' focused' : ''}${shown && s.id === shownIds[0] ? ' lead' : ''}`}
                onMouseDown={() => { if (s.id !== active) setActive(s.id); }}>
                {/* The title: what this session is working on, in its own
                    words via the labeller. It sits ON the pane rather than on
                    the tab because with four terminals up, the tab strip is no
                    longer where you are looking. */}
                <div className="term-pane-title"
                  title={'Copy: drag to select — releasing copies it (⌃⇧C, or ⌃C with a selection).\n'
                    + 'Paste: ⌃V. Shift-drag selects in the browser instead of tmux.'}>
                  <span className={`dot ${s.status}`} />
                  <span className="what">
                    {labelOf(s) || (s.status === 'live'
                      ? (labelBusy ? 'naming this session…' : 'not named yet')
                      : s.note || s.status)}
                  </span>
                  <span className="where">
                    {`${s.cmd === 'claude' ? 'claude' : 'shell'} · ${s.cwd || '~'}`}
                  </span>
                  {copied?.id === s.id && <span className="pane-copied">⧉ {copied.label}</span>}
                  {/* #292 — pin this session against the idle reaper. On the
                      PANE because that is where you are when you realise the
                      thing you are half-way through should outlive the
                      threshold: a session parked mid-investigation, or one
                      waiting out a usage-limit reset, is indistinguishable
                      from an abandoned tab to the reaper's own measure. */}
                  {s.tmux && (() => {
                    const pinned = pinnedOf(s.tmux);
                    return (
                      <button className={`pane-btn pin${pinned ? ' on' : ''}`} aria-pressed={pinned}
                        title={pinned
                          ? `Pinned — the idle reaper will not take ${s.tmux}. Click to unpin.`
                          : `Pin ${s.tmux} so the idle reaper never takes it, however quiet it goes`}
                        onClick={(e) => { e.stopPropagation(); void togglePin(s.tmux!, !pinned); }}>
                        {pinned ? '📌' : '📍'}
                      </button>
                    );
                  })()}
                  {/* Two different endings, named as such. Closing a claude
                      tab DETACHES it — the host session keeps running, which
                      is the whole point of #171 — so a control called × must
                      not imply the work stopped. ⏻ is the one that stops it. */}
                  {s.tmux && (
                    <button className="pane-btn end" disabled={ending === s.id}
                      title={`End this session — closes the tab AND kills ${s.tmux} on the host`}
                      onClick={(e) => { e.stopPropagation(); void endSession(s); }}>
                      {ending === s.id ? '…' : '⏻'}
                    </button>
                  )}
                  <button className="pane-btn"
                    title={s.tmux
                      ? 'Close this pane — the session keeps running on the host, re-attach it any time'
                      : 'Close this pane — the session ends with it'}
                    onClick={(e) => { e.stopPropagation(); closeSession(s.id, { shrink: true }); }}
                    aria-label="Close pane">×</button>
                </div>
                <TermSession sess={s} visible={shown} focused={shown && s.id === active}
                  onStatus={(st, note) => setStatus(s.id, st, note)}
                  onUsage={setUsage}
                  onTmux={(name) => noteTmux(s.id, s.cwd, name)}
                  onSid={(sid) => setSessions((cur) => cur.map((x) => (x.id === s.id ? { ...x, sid } : x)))}
                  onOutput={(bytes) => noteOutput(s.id, bytes)}
                  onExit={(name) => noteTmuxEnded(s.cwd, name)}
                  onCopied={(text) => noteCopied(s.id, text)}
                  register={(h) => { if (h) handles.current.set(s.id, h); else handles.current.delete(s.id); }} />
              </div>
              );
            })}
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
            <div className="tc-top">
              {/* The two Session layouts, switchable in a press so they can be
                  compared against real work rather than against a mock. Named
                  by what you are going TO, since that is the choice. */}
              {viewPrefs.railOpen && viewPrefs.railSeg === 'session' && (
                <button className="tc-style" onClick={() => {
                  saveViewPrefs({ railStyle: railStyle === 'tiers' ? 'upnext' : 'tiers' });
                  setScopeOpen(false);
                }}
                  title={railStyle === 'tiers'
                    ? 'Switch the rail to Up next — one item promoted to send, the rest reached by typing'
                    : 'Switch the rail to Tier stack — one lane per tier, the tab as a single scope'}>
                  ⇄ {railStyle === 'tiers' ? 'up next' : 'tiers'}
                </button>
              )}
              <button
                className="term-rail-toggle"
                title={viewPrefs.railOpen ? 'Collapse the cockpit rail' : 'Expand the cockpit rail'}
                onClick={() => saveViewPrefs({ railOpen: !viewPrefs.railOpen })}>
                <span className="term-rail-toggle-icon">{viewPrefs.railOpen ? '›' : '‹'}</span>
              </button>
            </div>
            {viewPrefs.railOpen && (
              <>
                {/* One head row: the segment picker, and the control that
                    narrows the list — a scope in 1a, tick-mode in 1b. */}
                <div className="tc-head">
                  <div className="tc-segs seg-control sm" role="tablist" aria-label="Cockpit rail">
                    {([['session', 'Session'], ['runbook', 'Runbook']] as const).map(([k, label]) => (
                      <button key={k} role="tab" aria-selected={viewPrefs.railSeg === k}
                        className={`seg-opt ${viewPrefs.railSeg === k ? 'on' : ''}`}
                        onClick={() => saveViewPrefs({ railSeg: k })}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {board && viewPrefs.railSeg === 'session' && (railStyle === 'tiers' ? (
                    // 1a — the scope. ONE control for "which tab", where there
                    // used to be a select carrying every area on the board plus
                    // two rows of chips. Risk rides along in the same popover:
                    // it is the same question (which slice of the queue), and it
                    // has only ever had two answers.
                    // A popover that only closed by pressing its own button again
                    // would sit over the list you opened it to narrow. Closing on
                    // focus LEAVING the group covers both the option press (which
                    // closes it itself) and a click anywhere else on the screen.
                    <div className="tcs-scope"
                      onBlur={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setScopeOpen(false);
                      }}>
                      <button className={`tcs-scope-btn${scopeOpen ? ' on' : ''}`}
                        aria-expanded={scopeOpen}
                        title="Scope the queue to one tab, or to a risk class"
                        onClick={() => setScopeOpen((o) => !o)}>
                        <span className="dot" />
                        <span className="l">{scopeLabel}</span>
                        <span className="c">▾</span>
                      </button>
                      {scopeOpen && (
                        <div className="tcs-pop">
                          <div className="tcs-pop-cap">scope to a tab</div>
                          {[['', 'all tabs', nextAll.length] as const,
                            ...railAreas.map(([a, n]) =>
                              [a, a === RAIL_UNTAGGED ? 'untagged' : a, n] as const)]
                            .map(([k, label, n]) => (
                              <button key={k || 'all'} className={`tcs-pop-opt${railArea === k ? ' on' : ''}`}
                                onClick={() => { setRailArea(k); setScopeOpen(false); }}>
                                <span className="l">{label}</span>
                                <span className="n">{n}</span>
                              </button>
                            ))}
                          {(railRiskCount('low') > 0 || railRiskCount('high') > 0) && (
                            <>
                              <div className="tcs-pop-cap">and a risk class</div>
                              {([['', 'any risk'], ['low', '⇣ low — merges itself'],
                                ['high', '⇡ high — wants watching']] as const)
                                .filter(([r]) => !r || railRiskCount(r) > 0)
                                .map(([r, label]) => (
                                  <button key={r || 'any'} className={`tcs-pop-opt${railRisk === r ? ' on' : ''}`}
                                    onClick={() => { setRailRisk(r); setScopeOpen(false); }}>
                                    <span className="l">{label}</span>
                                    <span className="n">{r ? railRiskCount(r) : nextAll.length}</span>
                                  </button>
                                ))}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    // 1b — one item sends in a press, so ticking several is the
                    // deliberate mode rather than the standing one.
                    <button className={`tcs-bulk-btn${bulk ? ' on' : ''}`} aria-pressed={bulk}
                      title="Tick several items and send them as one prompt"
                      onClick={() => { setBulk((b) => !b); setPicked([]); }}>
                      select
                    </button>
                  ))}
                </div>

                {viewPrefs.railSeg === 'session' ? (
                  // The Session rail, both layouts on one skeleton: a head that
                  // never scrolls (what you are on, what to send next), the list,
                  // and a footer that acts. One panel ground with hairlines only
                  // where the parts genuinely separate — no card inside a block
                  // inside the rail's own border, which is what made the old rail
                  // read as three nested boxes.
                  <div className="tc-session">
                    {!board ? (
                      <div className="tcs-lede">
                        <div className="tc-cap">{railStyle === 'tiers' ? 'WORKING ON' : 'UP NEXT'}</div>
                        <div className="tcs-none">
                          {!projectSlug ? 'Open a session in a project directory to tie it to the plan.'
                            : detailErr ? `Could not read ~/${projectSlug} just now — the plan is there, this rail isn't.`
                            : `~/${projectSlug} isn't a tracked project — there is no plan to tie this session to.`}
                        </div>
                      </div>
                    ) : railStyle === 'tiers' ? (
                      /* ---- 1a · tier stack: the tier IS the layout ---- */
                      <>
                        {/* WORKING ON — what you handed this session. Device-local:
                            Stack has no server-side "the item this TAB is on", and
                            inventing one from branch claims would be a guess. */}
                        <div className="tcs-lede">
                          <div className="tc-cap">WORKING ON</div>
                          {workingItem ? (
                            <div className="tc-work">
                              <span className={`tcs-grade t${workingItem.tier || 'none'}`}>{workingItem.tier || '·'}</span>
                              <div className="b">
                                <div className="t">{workingItem.title}</div>
                                <div className="m">
                                  #{workingItem.id} · {workingItem.bucket}
                                  {workingItem.area ? ` · ${workingItem.area}` : ''}
                                  {workingItem.plan.length
                                    ? ` · ☰ ${workingItem.plan.filter((s) => s.done).length}/${workingItem.plan.length}`
                                    : ''}
                                  {' · in the prompt'}
                                </div>
                                {/* The claim is what makes this more than a note to
                                    yourself: while it stands, the runner leaves the
                                    item alone. A claim from a real branch is shown
                                    but never dropped from here. */}
                                <div className={`tc-claim${workingItem.claimedBy ? '' : ' off'}`}>
                                  {workingItem.claimedBy
                                    ? `⚑ in progress · ${workingItem.claimedBy}`
                                    : '○ not claimed — the runner may still pick this up'}
                                </div>
                                <div className="tc-work-acts">
                                  <button className="tc-link"
                                    onClick={() => go.detail(projectSlug, 'roadmap', String(workingItem.id))}>
                                    Open on the board ↗
                                  </button>
                                  {workingItem.claimedBy && isTermClaim(workingItem.claimedBy) && (
                                    <button className="tc-link" onClick={() => void releaseWorking()}
                                      title="Give the item back to the board — it becomes pickable again">release</button>
                                  )}
                                  <button className="tc-link dim" onClick={() => pinWorking(null)}
                                    title="Forget what this session is on (the claim, if any, stays)">clear</button>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="tcs-none">Nothing handed over yet. Select below and send.</div>
                          )}
                        </div>

                        {/* DO NEXT — the runner's own order, so what the rail offers
                            is what the night would take. The shape line is the
                            queue's whole census in one line, which is what makes a
                            lane with nothing in it worth drawing below. */}
                        <div className="tcs-strip">
                          <div className="tc-cap row">
                            <span>DO NEXT · {scoped.length}</span>
                            <button className="tc-link" onClick={() => go.detail(projectSlug, 'roadmap')}>roadmap ↗</button>
                          </div>
                          <div className="tcs-shape">{scoped.length ? laneShape : 'Queue clear in this scope.'}</div>
                          <div className="tcs-hint">click to select, click again to drop it</div>
                        </div>

                        <div className="tcs-list">
                          {nextAll.length === 0 ? (
                            <div className="tc-empty pad">Every open item is claimed or parked — nothing free to hand over.</div>
                          ) : scoped.length === 0 ? (
                            <div className="tc-empty pad">
                              Nothing free in this scope.{' '}
                              <button className="tc-link" onClick={() => { setRailArea(''); setRailRisk(''); }}>clear it</button>
                            </div>
                          ) : lanes.map((ln) => (
                            <div className="tcs-lane" key={laneKey(ln.tier)}>
                              <div className="tcs-lane-head">
                                <span className={`bar t${ln.tier || 'none'}`} />
                                <span className={`k t${ln.tier || 'none'}`}>{laneName(ln.tier)}</span>
                                <span className="n">{ln.all.length}</span>
                                <span className="rule" />
                                {ln.note && <span className="w">{ln.note}</span>}
                              </div>
                              {ln.all.length === 0 ? (
                                <div className="tcs-lane-none">nothing at {ln.tier}</div>
                              ) : (
                                <>
                                  {ln.shown.map((it) => railRow(it, {
                                    // No checkbox in this layout: the row IS the
                                    // tick, and the accent ring is the state.
                                    tick: false, toggle: true,
                                    onClick: () => togglePick(it.id),
                                  }))}
                                  {ln.more && (
                                    <button className="tcs-more"
                                      onClick={() => setLaneOpen((l) => {
                                        const k = laneKey(ln.tier);
                                        return l.includes(k) ? l.filter((x) => x !== k) : [...l, k];
                                      })}>
                                      {ln.more}
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          ))}
                        </div>

                        <div className="tcs-foot">
                          {claimNote && <div className="tc-warn">{claimNote}</div>}
                          <div className="r">
                            {/* Select-all works on the SCOPE, so the count on the
                                button always means the list you are looking at —
                                and clearing only drops what this scope shows, so a
                                pick made in another tab's scope survives. */}
                            <button className="tc-link dim" disabled={scoped.length === 0}
                              onClick={() => setPicked((p) => (allScopedPicked
                                ? p.filter((id) => !scoped.some((it) => it.id === id))
                                : [...new Set([...p, ...scoped.map((it) => it.id)])]))}>
                              {allScopedPicked ? 'clear' : `select all ${scoped.length}`}
                            </button>
                            <span className="s">
                              {scopedPicked.length ? `${scopedPicked.length} selected` : 'nothing selected'}
                            </span>
                            <button className="btn-submit sm" disabled={scopedPicked.length === 0 || !activeSess}
                              onClick={() => void sendItems(scopedPicked)}
                              title="Types the selected items at the prompt as one block and claims them — read it, then press Enter yourself">
                              send →
                            </button>
                          </div>
                        </div>
                      </>
                    ) : (
                      /* ---- 1b · up next: one item to send, type to filter ---- */
                      <>
                        {/* Already sent? Say so in a line. This layout's card is
                            about what to send NEXT, but the claim made a minute ago
                            is still the thing keeping the runner off it — and the
                            release has to live wherever the claim is shown. */}
                        {workingItem && (
                          <div className="tcs-on">
                            <span className="k">{workingItem.claimedBy ? '⚑' : '○'}</span>
                            <span className="t" title={workingItem.claimedBy
                              ? `In progress · ${workingItem.claimedBy}`
                              : 'Not claimed — the runner may still pick this up'}>
                              #{workingItem.id} {workingItem.title}
                            </span>
                            <button className="tc-link"
                              onClick={() => go.detail(projectSlug, 'roadmap', String(workingItem.id))}>board ↗</button>
                            {workingItem.claimedBy && isTermClaim(workingItem.claimedBy) && (
                              <button className="tc-link" onClick={() => void releaseWorking()}
                                title="Give the item back to the board — it becomes pickable again">release</button>
                            )}
                            <button className="tc-link dim" onClick={() => pinWorking(null)}
                              title="Forget what this session is on (the claim, if any, stays)">clear</button>
                          </div>
                        )}

                        <div className="tcs-lede">
                          <div className="tc-cap">UP NEXT</div>
                          {topItem ? (
                            <div className="tcs-top">
                              <div className="h">
                                <span className={`tcs-grade t${topItem.tier || 'none'}`}>{topItem.tier || '·'}</span>
                                <span className="t">{topItem.title}</span>
                              </div>
                              <div className="m">
                                <span className="ref">#{topItem.id}</span>
                                <span className="tag">{topItem.area || 'untagged'}</span>
                                <span className="tag">{topItem.bucket}</span>
                                <span className="tag">
                                  {topItem.plan.length
                                    ? `☰ ${topItem.plan.filter((s) => s.done).length}/${topItem.plan.length}`
                                    : 'no plan'}
                                </span>
                              </div>
                              <div className="a">
                                <button className="btn-submit sm" disabled={!activeSess}
                                  onClick={() => void sendItems([topItem.id])}
                                  title="Types this item at the prompt and claims it — read it, then press Enter yourself">
                                  send to the prompt
                                </button>
                                <button className="tc-link dim"
                                  onClick={() => { setPassed((p) => [...p, topItem.id]); setPromoted(null); }}
                                  title="Offer the next one down instead — nothing on the board changes, this is only what the rail shows">
                                  skip
                                </button>
                              </div>
                              <div className="w">typed, not run · sending claims the item</div>
                            </div>
                          ) : (
                            <div className="tcs-none">
                              {nextAll.length === 0
                                ? 'Every open item is claimed or parked — nothing free to hand over.'
                                : matched.length === 0 ? 'No match for that filter.'
                                : 'Skipped past everything here — pick one below, or offer them again.'}
                            </div>
                          )}
                          {passed.length > 0 && (
                            <button className="tc-link dim tcs-unpass" onClick={() => setPassed([])}>
                              {passed.length} skipped past · offer them again
                            </button>
                          )}
                        </div>

                        {/* Typing is the filter: `tier:a`, `tab:polaris`, `risk:low`,
                            `plan:none`, or any words from the title. Terms narrow
                            each other, and the chips are only the ones with work
                            behind them — a token that matches nothing is a dead
                            press. */}
                        <div className="tcs-filter">
                          <div className={`tcs-field${railQuery ? ' on' : ''}`}>
                            <span className="s">/</span>
                            <input value={railQuery} onChange={(e) => setRailQuery(e.target.value)}
                              aria-label="Filter the queue"
                              placeholder="filter — tier:a, tab:polaris, branching" />
                            {railQuery && (
                              <button className="tc-link dim" onClick={() => setRailQuery('')}>clear</button>
                            )}
                          </div>
                          <div className="tcs-tokens">
                            {railTokens.map((t) => (
                              <button key={t} className={`tcs-token${railQuery === t ? ' on' : ''}`}
                                onClick={() => setRailQuery(railQuery === t ? '' : t)}>{t}</button>
                            ))}
                          </div>
                        </div>

                        <div className="tcs-list">
                          {groups.length === 0 ? (
                            <div className="tc-empty pad">
                              {nextAll.length === 0 ? 'Every open item is claimed or parked — nothing free to hand over.'
                                : matched.length > 0 ? 'That is the whole queue — nothing below the promoted item.'
                                : 'No match for that filter.'}
                            </div>
                          ) : groups.map((g) => (
                            <div className="tcs-group" key={laneKey(g.tier)}>
                              <button className="tcs-group-head" aria-expanded={g.open}
                                onClick={() => setTierShut((l) => {
                                  const k = laneKey(g.tier);
                                  return l.includes(k) ? l.filter((x) => x !== k) : [...l, k];
                                })}>
                                <span className="c">{g.open ? '▾' : '▸'}</span>
                                <span className={`k t${g.tier || 'none'}`}>{laneName(g.tier)}</span>
                                <span className="n">{g.items.length}</span>
                                <span className="rule" />
                              </button>
                              {g.open && g.items.map((it) => railRow(it, {
                                tick: bulk, toggle: bulk,
                                onClick: () => {
                                  if (bulk) { togglePick(it.id); return; }
                                  // Not a tick: promote it. One press moves the
                                  // send target, which is the whole argument of
                                  // this layout.
                                  setPromoted(it.id);
                                  setPassed((p) => p.filter((x) => x !== it.id));
                                },
                              }))}
                            </div>
                          ))}
                        </div>

                        {bulk && (
                          <div className="tcs-bulk">
                            <span className="s">
                              {matchedPicked.length
                                ? `${matchedPicked.length} ticked · sends as one prompt`
                                : 'tick items to batch them'}
                            </span>
                            <button className="tc-link dim" disabled={matched.length === 0}
                              onClick={() => setPicked((p) => (allMatchedPicked
                                ? p.filter((id) => !matched.some((it) => it.id === id))
                                : [...new Set([...p, ...matched.map((it) => it.id)])]))}>
                              {allMatchedPicked ? 'clear' : 'tick all'}
                            </button>
                            <button className="btn-submit sm" disabled={matchedPicked.length === 0 || !activeSess}
                              onClick={() => void sendItems(matchedPicked)}
                              title="Types the ticked items at the prompt as one block and claims them">
                              send →
                            </button>
                          </div>
                        )}
                        {claimNote && <div className="tcs-foot"><div className="tc-warn">{claimNote}</div></div>}

                        {/* ROSTER as a line, not a block. Stack keeps per-model
                            usage for autopilot runs, never for a terminal session
                            (#283), so the honest read is who is at the keyboard and
                            the host's whole day; anything more would be invented. */}
                        <div className="tcs-roster">
                          <span className={`dot ${claudeLive ? 'live' : 'closed'}`} />
                          <span className="l">you and claude, in this tab</span>
                          <span className="s"
                            title="No per-model record for a terminal session — that figure is this host's whole day.">
                            {fmtTok(usedTokens)} tok today
                          </span>
                        </div>
                      </>
                    )}
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
    {endAllAsk && sessions.length > 0 && (
      <ConfirmModal
        title={`End all ${sessions.length} sessions?`}
        body={
          <>Every tab closes, and each session still running on the host is killed — anything
            unfinished in those conversations is lost.
            <ul className="td-killlist">
              {sessions.map((s) => (
                <li key={s.id}>
                  <b>{s.cmd === 'claude' ? 'claude' : 'shell'}</b> in <b>{s.cwd ? `~/${s.cwd}` : '~'}</b>
                  {s.tmux ? ` — tmux ${s.tmux}` : ' — the tab is the whole session, so closing it ends it'}
                </li>
              ))}
            </ul>
          </>
        }
        confirmLabel={`End all ${sessions.length}`}
        danger
        onConfirm={() => { setEndAllAsk(false); void endAllSessions(); }}
        onCancel={() => setEndAllAsk(false)}
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
function TermSession({ sess, visible, focused, onStatus, onUsage, onTmux, onSid, onOutput, onExit, onCopied, register }: {
  sess: { id: number; cwd: string; cmd: 'shell' | 'claude'; tmux?: string };
  // Rendered on screen at all (it may be one of several panes)...
  visible: boolean;
  // ...and the one that takes keystrokes. With a grid these stopped being the
  // same thing: stealing focus for every visible pane would make the last one
  // mounted swallow your typing.
  focused: boolean;
  onStatus: (s: Status, note: string) => void;
  onUsage: (u: TermUsage) => void;
  onTmux: (name: string) => void;
  onSid: (sid: string) => void;
  onOutput: (bytes: number) => void;
  onExit: (tmuxName: string | null) => void;
  // Something reached the clipboard. With a canvas and no browser selection to
  // look at, "did that copy?" is otherwise unanswerable — so the pane says so.
  onCopied: (text: string) => void;
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
  // The relay's id for this session, learned from its first frame.
  const sidRef = useRef<string | null>(null);

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
    // Copy/paste (see lib/termClipboard): a released selection copies itself,
    // ⌃⇧C copies explicitly, ⌃V pastes through the browser's own handler, and
    // OSC 52 carries a tmux copy-mode selection — the plain mouse drag inside
    // a claude session — out to the clipboard.
    const unwireClipboard = wireTermClipboard(term, onCopied);

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
          // The relay multiplexes by sid and forwards the daemon's frames
          // whole, so every frame carries it — that is how a tab learns the
          // one id the labeller keys on.
          sid?: string;
          tmuxSession?: string;
          tokens?: number; resetAt?: number; resetLabel?: string; sched?: { runDate: string; atTime: string };
          totalTokens?: number; plan?: TermUsage['plan'];
        };
        try { m = JSON.parse(ev.data); } catch { return; }
        // Every frame carries the relay's sid, so the first one names this tab
        // for the labeller — including shells, which have no tmux name.
        if (typeof m.sid === 'string' && m.sid && !sidRef.current) { sidRef.current = m.sid; onSid(m.sid); }
        if (m.t === 'out' && m.data) {
          scheduleWrite(b64decode(m.data));
          // How much this session has said since it was last named. The title
          // is re-asked on OUTPUT rather than on a timer, so an active
          // conversation re-titles quickly and an idle one costs nothing.
          onOutput(m.data.length);
        }
        else if (m.t === 'usage' && typeof m.tokens === 'number') {
          onUsage({ tokens: m.tokens, totalTokens: m.totalTokens, resetAt: m.resetAt, resetLabel: m.resetLabel, sched: m.sched, plan: m.plan });
        }
        else if (m.t === 'ready') {
          if (m.tmuxSession) { tmuxRef.current = m.tmuxSession; onTmux(m.tmuxSession); }
          onStatus('live', m.cwd || '');
          if (focused) term.focus();
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
      unwireClipboard();
      wsRef.current?.close();
      term.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Refit when this pane becomes visible (it may have been hidden at 0×0).
  useEffect(() => {
    if (!visible) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    fit.fit();
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
    if (focused) term.focus();
  }, [visible, focused]);

  return <div className="term-holder gitbash" ref={holderRef} style={visible ? undefined : { display: 'none' }} />;
}
