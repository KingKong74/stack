import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  openTerminal,
  getTermUsagePrefs, setTermUsagePrefs, type TermUsagePrefs,
  getTermViewPrefs, setTermViewPrefs, type TermViewPrefs, type TermPaneCount,
  type TermLayout, LAYOUT_PANES, LAYOUT_META,
  createAutopilotSchedule,
  getAutopilotJobs, resumeAutopilotJob, hangupAutopilotJob, type AutopilotJob,
  getTerminalUsage, type TerminalUsageData,
  getDetachedSessions, killDetachedSession, keepSession, type DetachedSession,
  type SessionModel,
  labelTerminalSessions,
  getTermTmuxName, setTermTmuxName, clearTermTmuxName,
  getTermOpenTabs, setTermOpenTabs,
  getTermNames, setTermName,
  getTermSessionPrefs, setTermSessionPrefs,
  getTerminalGateway, type GatewayState,
  getProjectDetail, type ProjectDetailData,
  getOverview,
} from '../store';
import { hrefTo } from '../lib/route';

import { useAutoRefresh } from '../lib/autoRefresh';
import { wireTermClipboard } from '../lib/termClipboard';
// The wire codec and the palette are shared with the tab agents' consoles
// (#379) — see lib/termWire.ts for why those three and nothing else.
import { b64encode, b64decode, TERM_OPTIONS } from '../lib/termWire';
// How the box is painted (WebGL, with the DOM renderer as the fallback the
// browser can force on us at any moment) — lib/termRenderer says why.
import { attachRenderer } from '../lib/termRenderer';
// #380 — a tab agent's console is an ordinary session on this screen in every
// way except its name, which is the only evidence here of what it is: this
// screen has no project payload and no agent state to read. Titling one
// `claude · stack` hides the one fact that distinguishes it from the four
// beside it, so the name is parsed back.
import { ConfirmModal } from '../components/ConfirmModal';

import { flatRoadmap } from '../lib/plan';
import { TopBar } from '../components/TopBar';
import { crumbName } from '../lib/ui';

// The web terminal (#/terminal[?cwd=…]) — xterm.js over websocket to the host
// PTY daemon (via the server relay at /term). Parallel sessions are panes in a
// grid (each is its own socket; the relay multiplexes them over the one agent
// connection), and the theme is a mintty/git-bash homage: black, grey
// foreground, the classic ANSI palette.
//
// #489 — THE SCREEN IS THE MISSION CONTROL DESIGN, and the compromises #487
// made while porting it are gone. Three shapes, and each is the owner's call:
//
//  1. FULL BLEED. The page's 1080px column and its 32px gutters came off, so
//     the terminals have the window. `.page.term-page` is what beats the
//     `.page.detail` padding that was insetting the whole screen, and the row
//     under the topbar owns the height — nothing below it guesses at chrome
//     any more, which is the arithmetic full screen has always used.
//  2. ONE RAIL, FLUSH LEFT, FULL HEIGHT: the sessions list, grouped by tool,
//     each row a way into the first pane. It was three segments (Sessions ·
//     Work · Runbook); the other two are gone, and the block above
//     `claimedItems` says exactly what went with them.
//  3. NO SESSION TABS. A session was drawn three times — the rail, its pane,
//     and a tab strip in the head bar — and the strip was the one that wrapped
//     the bar onto a second row. It went; nothing moved to replace it.
//
// The terminal's own colours are untouched: black canvas, the mintty palette.
// The chrome around it is Stack's palette; the box is git-bash.
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

// #489 — THE RUNBOOK CATALOGUE IS GONE with the rail segment that drew it,
// and so are the custom commands stored beside it. `getTermCmds`/`setTermCmds`
// and the `stack.term.cmds` key are UNTOUCHED in store.ts: whatever anybody
// saved is still on their device, so restoring the segment restores their list
// rather than starting them empty. Nothing reads it today.
// #489 — `nextUpItems`, `BUCKET_RANK`, `RAIL_UNTAGGED` and `itemsBrief` went
// with the Work rail. They were the client's fourth spelling of the runner's
// pick (`queueOrder` in lib/plan.ts is the surviving one, and it is the one
// CLAUDE.md names), plus the text a send typed at the prompt. Nothing on this
// screen orders the queue any more, which is the point: the terminal draws
// sessions, and what runs next is decided on the board.

// tmux is the host-side tmux session a claude tab runs inside (#188): seeded
// from a detached-session chip or the device-local cwd map, confirmed by the
// daemon's ready frame. Shell tabs never have one.
// `sid` is the RELAY's id for this session. The browser learns it from the
// daemon's frames (they are multiplexed by sid and the relay forwards them
// whole), and it is the only id that exists for EVERY session — a shell has no
// tmux name, so keying names by tmux is why shells used to go unnamed.
type Sess = {
  id: number; cwd: string; cmd: 'shell' | 'claude'; status: Status; note: string; tmux?: string; sid?: string;
  // #503 — what this session is talking to, as the HOST reported it. undefined
  // = not answered yet (the ready frame has not landed); null = answered, and
  // the answer is UNRECORDED. The two are different and the row draws them
  // differently: nothing, versus a chip that says so.
  model?: SessionModel | null;
};

// #487 — the rail groups sessions by TOOL, as the Mission Control design does.
//
// A TABLE RATHER THAN A TERNARY, and that is the whole reason it is here. Stack
// runs two kinds of session today, so a `cmd === 'claude' ? … : …` would be
// shorter and would also be the thing somebody has to unpick the moment a third
// arrives — and one is arriving: `stack term --cli` (#481) launches codex,
// gemini, qwen and aider through the OmniRoute gateway. When a session records
// which runtime it is, it becomes a row here and nothing else on this screen
// changes. Until then this honestly lists the two that exist.
//
// The order is the order the rail draws: claude first because it is what the
// screen is mostly for, shells last because they are furniture.
const TOOL_GROUPS: { key: Sess['cmd']; name: string; mark: string }[] = [
  { key: 'claude', name: 'Claude Code', mark: 'C' },
  { key: 'shell', name: 'Shell', mark: '$' },
];
// #503 — WHAT A SESSION IS TALKING TO, as a chip on its row.
//
// THREE STATES, and collapsing any two of them is the whole trap:
//   a model      — the host read a tag off the session and this is it
//   UNRECORDED   — the host looked and there is no tag (a session started by
//                  hand, or by a daemon predating the option). Drawn as `model ?`
//                  and never as Claude: defaulting it to the subscription would
//                  state a fact nobody established, the NULL-verdict lie.
//   not asked yet— `undefined`, before the ready frame lands. Draws NOTHING,
//                  because a chip that says `model ?` for half a second and then
//                  changes its mind is worse than a chip that waits.
//
// Shells never get one: a shell is not on a model, and an empty chip on every
// shell row would make the column mean nothing.
function ModelChip({ model, show }: { model?: SessionModel | null; show: boolean }) {
  if (!show || model === undefined) return null;
  if (!model) {
    return (
      <span className="mdl none"
        title="Stack cannot say what this session is running on — it carries no model tag. Sessions started by hand (ssh + stack term), or before the host recorded this, have none.">
        model ?
      </span>
    );
  }
  return (
    <span className={`mdl ${model.key === 'anthropic' ? 'own' : 'alt'}`}
      title={`${model.label}${model.id ? ` · ${model.id}` : ''}${
        model.key === 'omniroute' ? ' — routed through the local OmniRoute gateway' : ''}`}>
      {model.label}
    </span>
  );
}

type Handle = { sendText: (s: string) => void; reconnect: () => void; focus: () => void };

// Mounted once by App and never unmounted (#137): sessions, sockets and
// scrollback survive navigation. `visible` = the #/terminal route is showing;
// away from it the component renders NOTHING (#492 dropped the floating dock
// and its corner chip — a terminal pane docked over whatever screen you had
// navigated to, and the running-sessions pill already says a session is live).
export function Terminal({ initialCwd = '', initialAttach, initialBrief, visible = true }: {
  initialCwd?: string; initialAttach?: string; initialBrief?: boolean; visible?: boolean;
}) {
  const [cwd, setCwd] = useState(initialCwd);
  // The seg control starts on the device's preferred session kind (Settings →
  // Terminal; default claude — that's what this screen is for).
  const [mode, setMode] = useState<'shell' | 'claude'>(() => getTermSessionPrefs().autoStart);
  const [sessions, setSessions] = useState<Sess[]>([]);
  // A mirror of `sessions` for the async restore (#486) to read. The adoption
  // pass resolves after its own round trip, by which time the `sessions` it
  // closed over at mount is empty — and deciding "is this already open" from a
  // stale empty list is exactly how a duplicate gets opened.
  const sessionsRef = useRef<Sess[]>([]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  const [active, setActive] = useState(0);
  const nextId = useRef(1);
  const handles = useRef(new Map<number, Handle>());
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
  // The copy receipt. xterm draws to a canvas, so a copy leaves nothing on the
  // page to look at — without a mark, a working copy and a failed one look
  // identical, which is how "I can't copy from the terminal" survives a fix.
  const [copied, setCopied] = useState<{ id: number; label: string } | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The label is composed by the clipboard layer, not here: it is the only
  // thing that knows whether a gesture copied, pasted, or was refused by the
  // browser, and a receipt that says "copied" for a refusal is worse than none.
  const noteCopied = (id: number, label: string) => {
    setCopied({ id, label });
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
  // #136 — view prefs, device-local: whether the rail is open, and which pane
  // layout the grid is in. #489 took `railSeg`/`railStyle` off the type with
  // the two rail segments they belonged to (store.ts says why the stored row
  // keeps them).
  const [viewPrefs, setViewPrefsState] = useState(() => getTermViewPrefs());
  const saveViewPrefs = (p: Partial<TermViewPrefs>) => {
    const next = { ...viewPrefs, ...p };
    setViewPrefsState(next); setTermViewPrefs(next);
  };
  // #276 — "Jump back in" opens the terminal already briefed. It used to land
  // on the rail's Runbook segment, because that is where the ▶ Paste roadmap
  // brief button lived; #489 removed that segment and moved the button to the
  // head bar, where it is visible whatever the rail is doing. So all this flag
  // still owes the link is an OPEN rail — the sessions list is what somebody
  // arriving from "Jump back in" wants to see first, and landing collapsed
  // hides the session they came to pick up.
  useEffect(() => {
    if (initialBrief) saveViewPrefs({ railOpen: true });
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
    // …and it goes into the shape that is already on screen. See
    // `showWhenOpened` below: the row does not exist yet, so this is a note to
    // the next render rather than a placement.
    showWhenOpened.current = id;
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
  // A RESTORED CLAUDE TAB NEVER SPAWNS. That is the whole of #486, and it is
  // the difference between reloading a screen and breeding host sessions.
  //
  // What went wrong: `openSession` resolves a missing tmux name through
  // `getTermTmuxName(cwd)`, which stores ONE name PER DIRECTORY. Three tabs in
  // ~/stack therefore had one name between them, so on every reload the first
  // re-attached and the other two fell through to `name = undefined` — which
  // the daemon reads as "start a new session". Refresh three times with three
  // tabs open and the host is running nine claude sessions, six of them
  // orphaned, each holding a model's context and each burning the idle
  // reaper's clock. `tmux` also lands undefined on any tab persisted while it
  // was still connecting, so a fast double-refresh reproduced it with one tab.
  //
  // The fix is to stop guessing from device storage and ASK THE HOST. Device
  // storage says what this BROWSER had open; only the daemon knows what still
  // EXISTS. So a saved claude tab is restored by attaching to a real host
  // session — its own name first, then any unheld session in the same
  // directory — and if there is nothing to attach to, the tab is not opened at
  // all. That is the honest outcome: the tab was a window onto a process, and
  // the process is gone.
  //
  // Shell tabs still open eagerly. A shell is stateless and cheap, there is
  // nothing on the host to adopt, and a fresh one in the same directory is
  // exactly what it was.
  //
  // With nothing remembered, one session still opens itself, as it always
  // did — the screen is never empty. The kind comes from the device pref
  // (default claude, skip-permissions via the start frame). A bare open (no
  // cwd, no attach, nothing stored) lands in the most recently touched project
  // rather than $HOME — claude in the home directory helps nobody; overview's
  // resume slug is the "current" project. Falls back to home on any miss.
  useEffect(() => {
    const saved = getTermOpenTabs();
    // Shells now; claude tabs wait for the host list. `ids` keeps a slot per
    // saved tab (null = deferred) so the route matching below still indexes
    // against `saved` the way it always has.
    const ids: (number | null)[] = saved.map((t) =>
      (t.cmd === 'shell' ? openSession(t.cwd, t.cmd, t.tmux) : null));
    const deferred = saved
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.cmd === 'claude');

    let gone = false;

    // The adoption pass. One round trip, then every deferred tab is matched to
    // a host session that actually exists — exact name first (so a tab lands
    // back on ITS OWN session, not merely a session), then any unheld one in
    // the same directory for the tabs whose names were lost to a mid-connect
    // persist. `held` grows as we go, so two tabs in one directory can never
    // claim the same host session and mirror each other.
    const adopt = async () => {
      if (!deferred.length) return [] as number[];
      const host = await getDetachedSessions().catch(() => [] as DetachedSession[]);
      if (gone) return [] as number[];
      const held = new Set<string>();
      const opened: number[] = [];
      // Exact matches first, across ALL deferred tabs, before anything is
      // allowed to take a session by directory alone — otherwise the first tab
      // in a directory can adopt the session that belonged to the third.
      const exact = new Map<number, string>();
      for (const { t, i } of deferred) {
        if (t.tmux && host.some((h) => h.name === t.tmux) && !held.has(t.tmux)) {
          held.add(t.tmux); exact.set(i, t.tmux);
        }
      }
      // Same preference `choosePanes` uses when it fills panes: an UNATTACHED
      // survivor first, newest before oldest. Attaching to a session some other
      // client already holds only mirrors it — two windows typing into one
      // terminal — so it is the last resort rather than the first match.
      const byPreference = [...host].sort(
        (a, b) => (a.attached ? 1 : 0) - (b.attached ? 1 : 0) || b.created - a.created);
      for (const { t, i } of deferred) {
        const name = exact.get(i)
          ?? byPreference.find((h) => h.cwd === t.cwd && !held.has(h.name))?.name;
        if (!name) continue;   // nothing on the host for it — the tab is not reopened
        held.add(name);
        const id = openSession(t.cwd, 'claude', name);
        ids[i] = id;
        opened.push(id);
      }
      return opened;
    };

    void adopt().then((opened) => {
      if (gone) return;
      const anyRestored = ids.some((x) => x !== null);

      if (initialAttach) {
        const i = saved.findIndex((t) => t.tmux === initialAttach);
        const held = sessionsRef.current.find(
          (s) => s.tmux === initialAttach && (s.status === 'live' || s.status === 'connecting'));
        if (i >= 0 && ids[i] !== null) setActive(ids[i] as number);
        else if (held) setActive(held.id);
        else openSession(initialCwd, 'claude', initialAttach);
        return;
      }
      if (initialCwd) {
        const i = saved.findIndex((t) => t.cwd === initialCwd);
        if (i >= 0 && ids[i] !== null) setActive(ids[i] as number);
        // The device's autoStart is what a plain ⌨ press should respect, but a
        // button labelled "Jump back in" that lands you in a bare shell has not
        // done what it said — it always opens claude.
        else openSession(initialCwd, initialBrief ? 'claude' : getTermSessionPrefs().autoStart);
        return;
      }
      if (anyRestored) {
        const first = ids.find((x) => x !== null);
        if (first != null) setActive(first);
        return;
      }
      if (opened.length) return;
      // NOTHING came back — no saved tabs, or none of them still exists on the
      // host. Only now does a session get spawned, which is the one case where
      // spawning is what the screen is for.
      getOverview()
        .then((o) => o.resume?.slug ?? '')
        .catch(() => '')
        .then((slug) => {
          if (gone) return;
          if (slug) setCwd(slug);
          openSession(slug, getTermSessionPrefs().autoStart);
        });
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

  const liveCount = sessions.filter((s) => s.status === 'live' || s.status === 'connecting').length;

  // Any full/hidden transition changes the holder's size out from under
  // xterm — the sessions' own resize listeners refit on this. Also fires on
  // wide-mode toggle (#136) and on collapsing the cockpit rail, which changes
  // the canvas width by the rail's whole width.
  //
  // Each session also watches its own holder with a ResizeObserver, which is
  // the real guarantee — this stays because it is free, and because a listed
  // dependency says out loud which layout changes are expected to reflow.
  useEffect(() => {
    window.dispatchEvent(new Event('resize'));
  }, [visible, full, viewPrefs.layout, viewPrefs.railOpen]);

  // #491 — CLOSING A PANE NO LONGER ADJUSTS THE SHAPE HERE. It used to
  // decrement the stored pane count, which was this screen's second opinion
  // about how many terminals are on it; the auto-fit below reads the sessions
  // themselves, so the close needs only to close.
  const closeSession = (id: number) => {
    handles.current.delete(id);
    setSessions((s) => {
      const rest = s.filter((x) => x.id !== id);
      if (id === active && rest.length) setActive(rest[rest.length - 1].id);
      return rest;
    });
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
    closeSession(sess.id);
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
  // #487 — is this session sitting on a permission prompt. Read off the
  // daemon's own scan (`blocked`), which is the same source the Approve button
  // above the canvas answers from, so the rail's "N asking" and the row you
  // press can never disagree about who is waiting.
  //
  // It leans toward NULL exactly as `terminal/prompt-scan.mjs` does: a false
  // positive here puts an "asking" badge on a session nobody asked anything,
  // which is worse than noticing a real one a tick late.
  const blockedOf = (x: Sess) =>
    (x.tmux ? detached.find((d) => d.name === x.tmux)?.blocked : null) ?? null;

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
  // The REF is the guard (two triggers in one tick would both read a stale
  // `false` and fire two calls); the STATE is what a session row renders as
  // "naming this session…" while the one ask is in flight. The ✧ Re-label
  // button that also read it is gone (#490), but this placeholder is the more
  // useful of the two: it is the difference between a session that has no name
  // yet and one that is about to get one.
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
    } catch { /* keyless (503) or offline — sessions just stay unnamed */ }
    finally { labelBusyRef.current = false; setLabelBusy(false); }
  };
  // (#490) NAMED ONCE, THEN NEVER AGAIN.
  //
  // This used to re-ask as a session talked: a title that says what you are
  // working on ought to follow the work, and the work shows up as output. The
  // trouble is that a title which keeps changing underneath you is not a name,
  // it is a status line — you learn where a pane is by its position rather than
  // by reading it, and the one moment the label matters (finding a session you
  // walked away from) is the moment it has just been rewritten to describe
  // whatever happened last.
  //
  // So the labeller now answers exactly one question, once per session: what
  // is this? After that the name is the OWNER'S, and `names` already wins over
  // the labeller's for anything renamed by hand. The re-ask machinery — the
  // per-session dirty-byte counters, the minimum interval, the "has it moved
  // on" test — is gone rather than merely disabled, because a threshold left
  // in the file is an invitation to tune it back up.
  // The ONE ask is gated on there being something to read. Naming once and
  // naming EARLY are different things, and doing both gives every session the
  // permanent title "starting claude session" — read off the splash screen,
  // before the session has done anything, and now never revised. So a live
  // session must have emitted a screenful before it is named. The counter only
  // ever gates the FIRST name; nothing decrements it and nothing re-asks.
  const seenRef = useRef<Record<number, number>>({});
  const NAME_AFTER_BYTES = 2000;
  const noteOutput = (id: number, bytes: number) => {
    seenRef.current[id] = (seenRef.current[id] || 0) + bytes;
  };
  useEffect(() => {
    if (!visible) return;
    const tick = () => {
      const live = sessions.filter((x) => x.status === 'live' || x.status === 'connecting');
      if (!live.length && !detachedShown.length) return;
      // ONLY the never-named, and for a live pane only once it has said enough
      // to be worth reading. A detached session is exempt: its output happened
      // before this browser was watching, so there is no counter for it and the
      // daemon reads its pane directly.
      const unnamed = [
        ...live.filter((x) => !labelOf(x) && (seenRef.current[x.id] || 0) >= NAME_AFTER_BYTES).map((x) => x.id),
        ...detachedShown.filter((d) => !labels[d.name]).map((d) => d.name),
      ];
      if (!unnamed.length) return;
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
  // #487 — the OWNER'S OWN NAME wins over the labeller's. A name you typed is
  // a decision; the labeller's is a reading of what the session is doing this
  // minute, and it keeps changing underneath by design.
  const [names, setNames] = useState<Record<string, string>>(() => getTermNames());
  // WHICH SESSION IS BEING RENAMED, AND ON WHICH SURFACE. The `where` is not
  // bookkeeping: the rail row and the pane title both draw an editor for the
  // same session, and an id alone opens BOTH. Two inputs carrying `autoFocus`
  // then fight over the focus on mount, the loser's onBlur runs commitRename
  // with an empty draft, and the rename closes itself the instant it opens —
  // which is exactly what it did until this field existed. One editor at a
  // time, and the surface you double-clicked is the one that gets it.
  const [renaming, setRenaming] = useState<{ id: number; where: 'rail' | 'pane' } | null>(null);
  const [draft, setDraft] = useState('');
  const [setsOpen, setSetsOpen] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [limitIdx, setLimitIdx] = useState(0);
  const labelOf = (s: Sess) =>
    (s.tmux && names[s.tmux]) || (s.sid && labels[s.sid]) || (s.tmux && labels[s.tmux]) || '';
  const startRename = (x: Sess, where: 'rail' | 'pane') => {
    if (!x.tmux) return;   // nothing stable to key the name on yet
    setRenaming({ id: x.id, where }); setDraft(labelOf(x));
  };
  // BLUR COMMITS rather than discarding — losing a name you just typed by
  // clicking away is the worst of the three outcomes, which is the same call
  // the board's inline rename makes.
  const commitRename = (x: Sess) => {
    if (x.tmux) { setTermName(x.tmux, draft); setNames(getTermNames()); }
    setRenaming(null); setDraft('');
  };
  // WHICH SESSIONS ARE ON SCREEN, and WHERE (#487).
  //
  // It was a sliding WINDOW over the session list — start at the active tab,
  // take N — so a pane was a position in a list and "put this session in that
  // pane" had no meaning. Panes are SLOTS instead: `slots[i]` names the session
  // in pane i, which is what lets a pane stay put while sessions come and go
  // around it. #491 took the DRAGGING that used to rearrange them (see the ⤢
  // button below, which is what moved a session after it); the slots stayed,
  // because they are what keeps a pane still, not what moved one.
  //
  // SLOTS ARE NOT PERSISTED. A session id is a per-mount counter, so a stored
  // arrangement would point at whatever happened to take those numbers next
  // time — a layout restored onto the wrong terminals is worse than one that
  // simply starts tidy. The LAYOUT is device-local; the arrangement inside it
  // lasts as long as the screen is open.
  const layout = viewPrefs.layout;

  // THE LAYOUT IS THE OWNER'S, AND NOTHING ELSE MOVES IT (owner's call).
  //
  // #491 had the shape follow the session count — a third session stepped you
  // from Side by side into 3-up on its own. It is gone, and the reason is what
  // the fit could not know: which of the shapes that seat N sessions you meant
  // to be in. Four sessions fit the 2×2 and they fit Focus, and a ladder that
  // walks you into the 2×2 every time a session opens takes Focus away from
  // you repeatedly and silently — you press it, open a terminal, and you are
  // somewhere else. The count is a fact about sessions; the shape is a
  // judgement about which one you are working in, and only a person has it.
  //
  // WHAT REPLACES IT is the block below: a new session goes into the view you
  // are already in, taking a free pane or the first one. So opening a terminal
  // still puts it in front of you — it just does not rearrange the screen to
  // do it.

  const [slots, setSlots] = useState<(number | null)[]>([]);

  // #491 — DRAG-AND-DROP IS GONE FROM THIS SCREEN (owner's call), and with it
  // the hold-then-drag gate #490 had to build for it: a pane title and a rail
  // row are both things you CLICK — focus a session, rename it, select text in
  // the terminal under it — and making them drag handles meant every slightly
  // imprecise click risked tearing a pane out of the grid. The gate made that
  // rarer; removing the drag removes it.
  //
  // WHAT MOVES A SESSION NOW: the pane's ⤢ button and a click on a rail row,
  // both of which put it in the first pane (`focusInSlot`). That is one
  // arrangement gesture rather than N, and it is the one that was already
  // there for a session the grid was not showing at all.

  /**
   * The slot assignment for a layout: every entry still alive is KEPT where it
   * is, and holes are filled from the sessions nobody has placed. Keeping
   * beats re-deriving because a pane must not move under the cursor when an
   * unrelated session opens or dies somewhere else on screen.
   *
   * Pure, and given everything it reads, so it can be called during render
   * without becoming a second source of truth beside `slots`.
   */
  const slotsFor = (lay: TermLayout, all: Sess[], cur: (number | null)[]): (number | null)[] => {
    const want = Math.max(1, Math.min(LAYOUT_PANES[lay], Math.max(1, all.length)));
    const alive = new Set(all.map((x) => x.id));
    const used = new Set<number>();
    const out: (number | null)[] = [];
    for (let i = 0; i < want; i++) {
      const id = cur[i];
      if (id != null && alive.has(id) && !used.has(id)) { out[i] = id; used.add(id); }
      else out[i] = null;
    }
    // The ACTIVE session is placed first when it has no slot, so clicking a
    // rail row always puts it on screen rather than behind a full grid.
    const queue = [
      ...all.filter((x) => x.id === active && !used.has(x.id)),
      ...all.filter((x) => x.id !== active && !used.has(x.id)),
    ];
    let q = 0;
    for (let i = 0; i < want; i++) {
      if (out[i] != null) continue;
      const next = queue[q++];
      if (next) { out[i] = next.id; used.add(next.id); }
    }
    return out;
  };

  const slotIds = slotsFor(layout, sessions, slots);
  const paneCount = slotIds.length;
  const shownIds = slotIds.filter((x): x is number => x != null);

  // ---- #487 · what the design's chrome reads ------------------------------
  //
  // THE LIMITS BLOCK's rows. The design lists three PROVIDERS; these are the
  // three real windows the daemon reads off the Claude account, which is the
  // same shape over numbers that are actually measured. A window the daemon
  // did not report is simply absent — an unmeasured limit drawn at 0% reads as
  // "plenty left", which is the most expensive possible way to be wrong here.
  const planLimits = useMemo(() => {
    const p = usage?.plan;
    if (!p) return [] as { key: string; name: string; pct: number; resets: string }[];
    const rows: { key: string; name: string; pct: number; resets: string }[] = [];
    if (p.session) {
      rows.push({ key: 'session', name: 'Session', pct: Math.round(p.session.pct),
        resets: p.session.resetAt ? `resets ${fmtReset(p.session.resetAt)}` : 'no reset reported' });
    }
    if (p.week) {
      rows.push({ key: 'week', name: 'Week', pct: Math.round(p.week.pct),
        resets: p.week.resetAt ? `resets ${fmtReset(p.week.resetAt, true)}` : 'no reset reported' });
    }
    if (p.weekModel) {
      rows.push({ key: 'weekModel', name: `Week · ${p.weekModel.model || 'strong model'}`,
        pct: Math.round(p.weekModel.pct),
        resets: p.weekModel.resetAt ? `resets ${fmtReset(p.weekModel.resetAt, true)}` : 'no reset reported' });
    }
    return rows;
  }, [usage]);

  // THE ATTENTION PILL — sessions stopped on a permission prompt. The design's
  // wording exactly, because it is the right wording: one of them names the
  // session, several do not, and the difference is whether naming it saves you
  // a look.
  const waiting = sessions.filter((x) => (x.status === 'live') && !!blockedOf(x));
  const attentionLabel = waiting.length === 1
    ? `1 session waiting on you — ${labelOf(waiting[0]) || waiting[0].cwd || 'unnamed'}`
    : `${waiting.length} sessions waiting on you`;

  /** Put a session in the FIRST pane, swapping out whatever is there, and make
   *  it the one taking keystrokes. The layout is untouched: a rail click and
   *  the attention pill are both "show me this one", not "reshape the screen".
   */
  const showInLead = (id: number) => {
    const next = slotsFor(layout, sessions, slots).slice();
    const from = next.indexOf(id);
    if (from === 0) { setActive(id); return; }
    if (from !== -1) next[from] = next[0];
    next[0] = id;
    setSlots(next);
    setActive(id);
  };

  /** The pane's ⤢ — BRING THIS ONE TO THE FOCUS VIEW.
   *
   *  It used to move the session into slot 0 and leave the layout alone, on
   *  the reasoning that a shape somebody picked is not a thing a focus press
   *  should undo. That was wrong in the one way that mattered: in the 2×2 and
   *  the 6-up, EVERY PANE IS THE SAME SIZE, so slot 0 is not a focus position
   *  and the button did its work invisibly. Pressing it looked like pressing a
   *  dead control — which is exactly what it was reported as.
   *
   *  So it now does what its name says: switches to Focus and puts this
   *  session in the big pane. That gives it one meaning from every shape
   *  rather than a real effect in two of them and none in the rest. Sessions
   *  that Focus cannot seat are not closed or detached — every session stays
   *  mounted whatever is on screen — so 6-up brings them all back.
   */
  const focusPane = (id: number) => {
    const next = slotsFor('focus', sessions, slots).slice();
    const from = next.indexOf(id);
    if (from > 0) next[from] = next[0];
    next[0] = id;
    setSlots(next);
    setActive(id);
    if (layout !== 'focus') {
      saveViewPrefs({ layout: 'focus', panes: Math.min(4, LAYOUT_PANES.focus) as TermPaneCount });
    }
  };

  // A NEW SESSION LANDS IN THE VIEW YOU ARE ALREADY IN (owner's call).
  //
  // `slotsFor` already fills a FREE pane with whoever is unplaced, so most of
  // the time this does nothing. It is here for the case that has no free pane:
  // opening a fourth terminal in Side by side used to leave it running on the
  // host, live, focused, and drawn nowhere — the screen's own answer being to
  // grow itself, which is the behaviour that just went. It takes the first
  // pane instead, which is where you were about to look anyway.
  //
  // Keyed off the id rather than the count so it fires once, for the session
  // that was actually opened, and never re-runs on an unrelated change. It has
  // to wait for a render because `openSession` adds to `sessions` through a
  // functional update — the row does not exist yet when the ref is set.
  const showWhenOpened = useRef<number | null>(null);
  useEffect(() => {
    const id = showWhenOpened.current;
    if (id == null) return;
    if (!sessions.some((x) => x.id === id)) return; // not landed yet
    showWhenOpened.current = null;
    if (slotsFor(layout, sessions, slots).includes(id)) return; // a free pane took it
    showInLead(id);
  }, [sessions]); // eslint-disable-line react-hooks/exhaustive-deps

  // A LAYOUT BUTTON CHANGES THE SHAPE AND NOTHING ELSE (owner's call).
  //
  // It used to FILL what it opened: pressing Focus with one session running
  // attached to whatever detached sessions the host had, newest first, and
  // then started fresh ones for any pane still empty — on the reasoning that
  // asking for N terminals is asking for N terminals. It is gone, and the
  // reason is what it did rather than what it meant. Pressing a shape is a
  // question about the screen; it was answered by reaching onto the HOST and
  // attaching to work somebody else — or you, yesterday, in another window —
  // had left running. Nothing said which sessions it had taken, and the panes
  // it filled looked exactly like panes you had opened. A control that starts
  // and joins real processes has to be a control you pressed for that.
  //
  // An empty pane is now just an empty pane, and + New session is the only
  // thing on this screen that starts one. Resuming a detached session is still
  // one click, on its own row in the rail, where it says what it is resuming.
  const chooseLayout = (lay: TermLayout) => {
    // The pane COUNT rides along so a device that later loads an older build
    // lands on the nearest shape rather than on the default.
    saveViewPrefs({ layout: lay, panes: Math.min(4, LAYOUT_PANES[lay]) as TermPaneCount });
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
  const activeSess = sessions.find((s) => s.id === active);

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

  // #489 — THE WORK COCKPIT IS GONE, and this is the whole of what went with
  // it, said once so nobody has to reconstruct it from the diff:
  //
  //  • THE TERMINAL NO LONGER READS THE PLAN. It fetched the cwd's project
  //    (`getProjectDetail`), derived the runner's own next-up order and drew it
  //    two ways — one lane per sprint, or one item promoted with the rest
  //    behind a typed filter. Both are gone; nothing on this screen now knows
  //    what the night would take next.
  //  • A TAB CAN NO LONGER CLAIM. `term:<name>` claims were written from here
  //    (`patchRoadmapItem` with `claimed_by`) and released from here. The
  //    CLAIM ITSELF IS UNCHANGED — `claimed_by` is still the don't-re-pick
  //    marker, SessionStart still injects it, the lane rules still read it —
  //    but a browser can no longer make or drop one from this screen, so a
  //    session worked in a tab now claims the way every other session does:
  //    by hand, or not at all. That is a real gap, not a tidy-up.
  //  • SENDING WORK TO THE PROMPT went with it: the rail typed an item's brief
  //    at the active session, bracketed, and Stack still never pressed Enter.
  //    The board's ⌨ To terminal handoff survives — it arrives through
  //    sessionStorage and is pasted by the head bar's ▶ Paste brief.
  //  • THE PINNED "WORKING ON" ITEM (`stack.term.working`) has no reader.
  //    `getTermWorkingItem`/`setTermWorkingItem` stay in store.ts with whatever
  //    each device pinned, for the same reason the runbook's commands do.
  //
  // What is NOT affected: the usage strip, the resume-job chip, the gateway
  // pills and the layout switcher all sat above the canvas, never in the rail.
  //
  // ONE READ OF THE PLAN SURVIVES, and it is the head bar's, not the rail's:
  // "N branches claimed" is a fact about the whole project that belongs beside
  // the spawn controls — it is what says somebody else is already on this
  // checkout before you open a sixth session in it. It costs one fetch and
  // nothing writes back, which is the whole difference between it and the
  // cockpit that went.
  const [detail, setDetail] = useState<ProjectDetailData | null>(null);
  const [detailSlug, setDetailSlug] = useState('');
  useEffect(() => {
    if (!visible || !projectSlug) return;
    let gone = false;
    getProjectDetail(projectSlug)
      .then((d) => { if (!gone) { setDetail(d); setDetailSlug(projectSlug); } })
      // Quiet: a cwd that isn't a tracked project is normal, and the chip's
      // absence is the honest answer — never a "0 claimed" that would read as
      // "nobody is on this".
      .catch(() => { if (!gone) { setDetail(null); setDetailSlug(projectSlug); } });
    return () => { gone = true; };
  }, [visible, projectSlug]);
  const board = detailSlug === projectSlug ? detail : null;
  const claimedItems = useMemo(
    () => (board ? flatRoadmap(board.roadmap).filter((it) => !it.done && it.claimedBy) : []),
    [board]);

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

  // (#490) AUTO-BOOK IS GONE, and the EFFECT went with the switch rather than
  // being left behind it. A stored `autoSchedule: true` from before this change
  // would otherwise keep booking sessions with nothing on screen able to say so
  // or turn it off — a setting with no surface is worse than no setting.
  // Booking is a button now, pressed on purpose. lastAutoKey stays: it is what
  // stops a manual double-book across a reload.

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

  // #486 — the OmniRoute gateway, as the HOST sees it. null = not asked yet,
  // which renders as nothing rather than as a claim; the three states the
  // answer can carry are handled where it is drawn.
  const [gateway, setGateway] = useState<GatewayState | null>(null);
  const [gwPref, setGwPref] = useState<boolean>(() => getTermSessionPrefs().onGateway);
  const loadGateway = () => {
    getTerminalGateway()
      .then(setGateway)
      // A failed FETCH is not a down gateway either — it is one more way of not
      // being able to see, so it lands in the same state as an absent daemon.
      .catch(() => setGateway({ connected: false }));
  };
  useEffect(() => { if (visible) loadGateway(); }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  useAutoRefresh(loadGateway, visible);

  // THE PROVIDER PILLS. The design shows three (Anthropic 67%, OpenAI 22%,
  // DeepSeek 4%). Stack has a real percentage for exactly ONE of those — the
  // Claude plan window the daemon reads off the account — and knows of the
  // others only whether a key is configured. So the pills are drawn as the
  // design draws them and say what is TRUE for each: a percentage where there
  // is one, and the provider's state where there is not. A fabricated "4%"
  // would look identical to a measured one, which is the whole objection.
  // (#490) THE STATUS PILLS MOVED TO THE RAIL, and the Anthropic one did not
  // survive the move. The rail's limits block already draws that session
  // percentage and its reset time — the pill was the same number a second time
  // on the same screen, which is the rule this repo keeps breaking and then
  // fixing. What is left is the two facts nothing else on the rail says: which
  // session this pane is holding, and whether the gateway can take a new one.
  const railStatus = useMemo(() => {
    const out: { key: string; name: string; detail: string; tone: 'ok' | 'warn' | 'off' }[] = [];
    if (gateway) {
      out.push({
        key: 'gateway', name: 'OmniRoute',
        // Still three sentences, still never collapsing "cannot see" into
        // "down" — see routes/terminal.js's header on the three states.
        detail: gateway.connected ? (gateway.reachable ? 'reachable' : 'no gateway') : 'host offline',
        tone: gateway.connected && gateway.reachable ? 'ok' : 'off',
      });
    }
    return out;
  }, [gateway]);


  return (
    <>
    <div className={`term-screen${visible ? (full ? ' term-fullscreen' : '') : ' term-hidden'}`}>
      {/* #316 — the review quick link is the rail's `review ↗`, not a second
          button up here: one entrance per screen. */}
      {/* THE CRUMB NAMES THE PROJECT WHEN THERE IS ONE. A terminal is opened
          from a project (⌨ passes its slug as the cwd) far more often than
          from nowhere, and `Projects / Terminal` said nothing about WHICH
          checkout the session in front of you is running in. The step is drawn
          only when the cwd resolves to a tracked project — `board` is null for
          a plain directory — because a slug Stack has never heard of is not a
          project and must not be drawn as one. */}
      <TopBar crumb={[
        { label: 'Projects', href: hrefTo.dashboard },
        ...(board ? [{ label: crumbName(board.project.name), href: hrefTo.detail(board.project.id) }] : []),
        // The cwd only: a crumb href that re-attached would MIRROR the session the
        // new tab lands beside, and a duplicate of this screen wants the same
        // directory, not the same pane.
        { label: 'Terminal', href: hrefTo.terminal(cwd) },
      ]}
        actions={<a className="btn-repo" href={hrefTo.control} title="Mission Control">Mission Control</a>} />

      {/* #489 — THE COCKPIT IS FULL-BLEED, and the page's own frame is gone
          with the width cap that came with it. Every other screen in Stack is
          a document in a 1080px column; this one is an instrument panel, and
          the terminal is the instrument. There is no `term-wide` any more
          either — it widened the page when panes > 1, which was the same
          answer to the same question asked from the other side. */}
      <div className="page term-page">
        <div className="term-layout">
        <div className="term-col">
        <div className="term-bar">
          {/* #490 — THE BAR READS RIGHT-TO-LEFT. Everything you PRESS is on the
              right, under the hand that is already there for the layout
              switcher; the left holds only what you READ. The branch count is
              the one passive thing on this bar, so it is the only thing here. */}
          {/* Real claim state (#277 — a claim is a BRANCH, and is called one),
              not a count of browser tabs: open roadmap items a branch holds. */}
          {claimedItems.length > 0 && (
            <span className="term-lanes"
              title={claimedItems.map((it) => `⚑ ${it.claimedBy} — #${it.id} ${it.title}`).join('\n')}>
              {claimedItems.length} branch{claimedItems.length === 1 ? '' : 'es'} claimed
            </span>
          )}
          <div className="term-bar-gap" />
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
          {/* #487 — the design's spawn button SAYS WHAT IT WILL DO: the tool
              and the directory, not "+ New session". Both are already chosen
              in the two controls beside it, so a button that repeats them back
              is the last chance to notice you are about to open claude in the
              wrong project — which is the mistake this label prevents and a
              generic one cannot. */}
          <button className="btn-submit sm term-spawn" onClick={() => openSession()}
            title={`Open a ${mode === 'claude' ? 'Claude' : 'shell'} session in ~/${cwd.trim() || ''}`}>
            + {mode === 'claude' ? 'Claude' : 'Shell'} in ~/{cwd.trim()}
          </button>
          {/* #489 — the roadmap brief's paste button, moved out of the rail's
              Runbook segment when that segment went. It is drawn ONLY when a
              brief actually arrived (the board's ⌨ To terminal, or the
              dashboard's Jump back in), which is what keeps a one-shot action
              out of the bar the rest of the time. Nothing runs until the human
              presses Enter — the same rule it followed on the rail. */}
          {brief && (
            <button className="btn-repo sm" onClick={pasteBrief}
              title="Types the roadmap brief into the active session — review it, then press Enter yourself">
              ▶ Paste brief
            </button>
          )}
          {/* #489 — THE SESSION TABS ARE GONE FROM THIS BAR. They were the
              third place one session was drawn: the rail lists it, a pane
              holds it, and this strip named it again — and being the widest
              of the three, it is what pushed the rest of the bar onto a
              second row. Everything it did is on the rail's session row:
              press to focus, × to close, ⏻ to end. Nothing about a session
              MOVED to make room; a duplicate went. */}
          {/* Called END, not close, on purpose — the pane and rail controls
              already name the two endings apart (× closes a pane and the host
              session keeps running, ⏻ is the one that stops it), so a control
              that kills must not be spelled "close". */}
          {(sessions.length > 0 || endingAll) && (
            <button className="btn-cancel sm" disabled={endingAll} onClick={() => setEndAllAsk(true)}
              title={`End every session — closes all ${sessions.length} tab${sessions.length === 1 ? '' : 's'} and kills the ones still running on the host`}>
              {endingAll ? `⏻ Ending ${endingAllCount}…` : `⏻ End all ${sessions.length}`}
            </button>
          )}
          {/* ✧ RE-LABEL IS GONE (#490), with the re-asking it belonged to. A
              session is named once and then the name is yours — a button whose
              only job is to overwrite the name you are reading is not a
              convenience, it is the churn this screen just stopped doing.
              Renaming by hand is still on the rail's own row. */}
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
          {activeSess && (activeSess.status === 'closed' || activeSess.status === 'error') && (
            <button className="btn-cancel sm" onClick={() => handles.current.get(active)?.reconnect()}>
              ↻ Reconnect
            </button>
          )}
          {/* How many terminals are on screen at once — this replaced the
              wide-mode toggle. Panes are filled from the active tab onwards,
              so picking a tab puts it top-left and its neighbours beside it. */}
          {/* THE LAYOUT SWITCHER — seven shapes (#487, #491). The screen
              already picks a symmetric one per session count as sessions come
              and go, so this is HERE for the other question: the auto-fit
              answers "how many are open", and pressing a shape says "this is
              how I want to look at them" — including the two asymmetric ones
              the ladder will never choose for you. It holds until the set of
              sessions changes. Picking one still FILLS it — empty panes take
              the sessions already running on the host before any new one is
              spawned, so a bigger shape does not strand claude sessions
              nobody is watching. */}
          <span className="seg-control sm term-panes" role="tablist" aria-label="Terminal layout">
            {LAYOUT_META.map((l) => (
              <button key={l.key} role="tab" aria-selected={layout === l.key}
                className={`seg-opt ${layout === l.key ? 'on' : ''}`}
                title={`${l.name} — ${l.hint}. Empty panes fill from the sessions still running on the host, then with new ones; the shape follows the session count on its own until you press one.`}
                onClick={() => void chooseLayout(l.key)}>
                {l.icon}
              </button>
            ))}
          </span>
        </div>

        {/* #487 — THE ATTENTION STRIP, the design's second toolbar row. It is
            drawn only when it has something to say: a permanent "0 waiting"
            trains the eye to skip the row that will one day say 3.
            The "N of M sessions shown" sentence that used to sit beside the
            pill is GONE — it was true on every screen the app has ever drawn,
            so it took a row of the canvas permanently to restate the two
            things already in front of you (the rail lists the sessions, the
            grid shows which are up), and its tail was a tip, not a state. A
            row that is always there is a row nobody reads, which is exactly
            what the pill beside it cannot afford. */}
        {waiting.length > 0 && (
          <div className="term-attn">
            <button className="ta-pill" title="Jump to the first session waiting on an answer"
              onClick={() => { const w = waiting[0]; if (w) showInLead(w.id); }}>
              <span className="d" />{attentionLabel}
            </button>
          </div>
        )}

        {/* WHAT IS LEFT ABOVE THE CANVAS IS THE DAY'S EVENTS, not its readings.
            THE TOKEN COUNT MOVED TO THE RAIL (owner's call), where it sits with
            the three plan windows — it is the fourth of the same question and
            the one figure they do not carry, and a reading that never changes
            state does not earn a permanent row across the top of the screen.
            (#487 had already moved the plan windows off this strip for the same
            reason: three copies of one percentage on one screen.)
            So this strip is drawn only when something has HAPPENED — a limit
            reset landing, a session paused, a booking offered or taken — and is
            absent, rather than empty, the rest of the time. Everything in it is
            an event or the button that answers one. */}
        {(usage?.resetLabel || resumeJob || usage?.sched || schedNote) && (
          <div className="term-usage">
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
            {schedNote && <span className="tu-note">{schedNote}</span>}
          </div>
        )}

        {/* #487 — THE GATEWAY ROW IS GONE FROM HERE. Its three states are the
            OmniRoute pill in the header now (reachable / no gateway / host
            offline — still three sentences, still never collapsing "cannot
            see" into "down"), and its model and its switch moved into the
            rail's Settings popover, which is where the design puts a setting.
            One status, one place; it was being drawn twice. */}

        {/* #490 — "PICK UP WHERE IT STOPPED" IS GONE FROM ABOVE THE CANVAS.
            It was a horizontal strip of long chips that grew a row every time
            the host kept a session, pushing the terminals down the page — on a
            busy host it was taking three rows before a single pane was drawn.
            The same sessions are in the rail now, which is already the list of
            what is running and has a column shape that suits one. */}

          {/* #487 — the grid is driven by the LAYOUT, and each pane knows its
              SLOT: the layout class is what styles.css turns into the
              asymmetric shapes, and `order` is what puts a pane in its cell. */}
          <div className={`term-main term-grid lay-${layout} p${paneCount}`}>
            {sessions.map((s) => {
              const slot = slotIds.indexOf(s.id);
              const shown = slot !== -1;
              // Every session stays MOUNTED whether or not it is on screen —
              // unmounting one would drop its socket and its scrollback, which
              // is the whole reason this component never unmounts either. Off
              // -screen panes are hidden, not destroyed.
              // `lead` marks the FIRST pane on screen, which Main + stack
              // gives the tall left column to and Focus the full-width top
              // row. It has to be a class rather than :first-child, because
              // off-screen panes stay in the DOM (they keep their sockets) and
              // would win that selector while invisible.
              //
              // A CLICK ON A PANE DOES NOT MOVE THE FOCUS (owner's call). It
              // used to: mousedown anywhere on a pane made that session the
              // active one, so a drag to select output, a scroll, or a stray
              // click on the way to a button quietly moved what ⤢, the pane
              // ring and the head bar were all pointing at. ⤢ is the control
              // that says it now, and it is the only one. Typing still goes
              // where you clicked — xterm's own textarea takes the keyboard on
              // a click, which is the browser's job and not this state's.
              return (
              <div key={s.id}
                className={`term-pane${shown ? '' : ' off'}${s.id === active ? ' focused' : ''}${shown && slot === 0 ? ' lead' : ''}`}
                style={shown ? { order: slot } : undefined}
                data-slot={shown ? slot : undefined}>
                {/* The title: what this session is working on, in its own
                    words via the labeller. It sits ON the pane rather than on
                    the tab because with four terminals up, the tab strip is no
                    longer where you are looking. */}
                {/* The title bar. It was the pane's drag handle until #491
                    took dragging off the screen; nothing replaced it, because
                    a bar that is only a label cannot swallow a gesture meant
                    for the terminal under it. */}
                <div className="term-pane-title"
                  title={'Copy: drag to select in the terminal — releasing copies it (⌃⇧C, or ⌃C with a selection).\n'
                    + 'Paste: ⌃V. Shift-drag selects in the browser instead of tmux.'}>
                  <span className={`dot ${s.status}`} />
                  {/* The tool mark, from the design: which runtime this pane
                      is. Two today (claude / shell); it is a lookup rather
                      than a ternary so a CLI runtime (#481) drops in beside
                      them without touching the pane. */}
                  <span className={`term-mark ${s.cmd}`} aria-hidden="true">
                    {s.cmd === 'claude' ? 'C' : '$'}
                  </span>
                  {/* THE NAME IS EDITABLE HERE TOO, on a double-click, the
                      same gesture the rail row carries. Both are needed: the
                      rail is where you rename a session you are looking FOR,
                      and the pane is where you rename the one you are looking
                      AT — with four terminals up, the rail row for the pane
                      under your cursor is the one place you are not reading.
                      ONE `renaming` state serves both AND NAMES THE SURFACE,
                      so only the editor you opened is drawn — see the state's
                      own comment for what two of them do to each other.
                      A session with no tmux name yet has nothing stable to key
                      a name on, so the tooltip says so rather than promising a
                      gesture that silently does nothing (`startRename` already
                      refuses; a tooltip that lies is worse than none). */}
                  {renaming?.id === s.id && renaming.where === 'pane' ? (
                    <input className="tcg-edit pane-edit" autoFocus value={draft}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(s)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(s);
                        if (e.key === 'Escape') { setRenaming(null); setDraft(''); }
                      }} />
                  ) : (
                    <span className="what"
                      title={s.tmux
                        ? 'Double-click to rename this session'
                        : 'No host session name yet — this one cannot be renamed until the daemon reports it'}
                      onDoubleClick={(e) => { e.stopPropagation(); startRename(s, 'pane'); }}>
                      {labelOf(s) || (s.status === 'live'
                        ? (labelBusy ? 'naming this session…' : 'not named yet')
                        : s.note || s.status)}
                    </span>
                  )}
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
                  {/* ⤢ — bring this pane to the front of the arrangement.
                      The design calls it Focus; here it moves the session into
                      slot 0 rather than changing the layout, because the layout
                      is a choice somebody made and a focus press is not a
                      request to undo it. */}
                  {paneCount > 1 && (
                    <button className="pane-btn"
                      title="Focus this session — the Focus shape, with this one in the big pane"
                      onClick={(e) => { e.stopPropagation(); focusPane(s.id); }}
                      aria-label="Bring this session to the focus view">⤢</button>
                  )}
                  <button className="pane-btn"
                    title={s.tmux
                      ? 'Close this pane — the session keeps running on the host, re-attach it any time'
                      : 'Close this pane — the session ends with it'}
                    onClick={(e) => { e.stopPropagation(); closeSession(s.id); }}
                    aria-label="Close pane">×</button>
                </div>
                <TermSession sess={s} visible={shown} focused={shown && s.id === active}
                  /* FOCUS'S SMALL PANES GET A SMALLER FACE. They are a third of
                     the width and a fraction of the height, so at the shared
                     14px they hold a dozen wrapped lines and are genuinely
                     hard to read — the complaint that prompted this. The size
                     is not decoration: it is what puts a useful number of ROWS
                     and COLUMNS in a short pane, which is the only thing that
                     makes one worth glancing at, and 11px was still wrapping
                     ordinary claude output. The big pane keeps the full size,
                     since that is the one you are working in. */
                  fontSize={layout === 'focus' && slot !== 0 ? 10 : undefined}
                  onStatus={(st, note) => setStatus(s.id, st, note)}
                  onUsage={setUsage}
                  onTmux={(name) => noteTmux(s.id, s.cwd, name)}
                  onModel={(mdl) => setSessions((cur) => cur.map((x) => (x.id === s.id ? { ...x, model: mdl } : x)))}
                  onSid={(sid) => setSessions((cur) => cur.map((x) => (x.id === s.id ? { ...x, sid } : x)))}
                  onExit={(name) => noteTmuxEnded(s.cwd, name)}
                  onOutput={(bytes) => noteOutput(s.id, bytes)}
                  onCopied={(label) => noteCopied(s.id, label)}
                  register={(h) => { if (h) handles.current.set(s.id, h); else handles.current.delete(s.id); }} />
              </div>
              );
            })}
            {sessions.length === 0 && (
              <div className="term-holder gitbash term-empty">
                <span>No session open.</span>
                <span className="dim">Resume one from the rail, or start a new one with + New session.</span>
              </div>
            )}
            {/* THE SHAPE'S EMPTY PANES, drawn as empty rather than left as a
                hole in the grid. A shape with more panes than sessions is now
                an ordinary state — nothing fills it for you — so the screen has
                to say that is what you are looking at, or a 2×2 holding one
                terminal reads as three panes that failed to load. */}
            {sessions.length > 0 && Array.from(
              { length: Math.max(0, LAYOUT_PANES[layout] - shownIds.length) },
              (_, i) => (
                <div key={`empty-${i}`} className="term-pane empty"
                  style={{ order: shownIds.length + i }}>
                  <div className="term-holder gitbash term-empty">
                    <span className="dim">Empty pane</span>
                  </div>
                </div>
              ),
            )}
          </div>
        </div>{/* /term-col */}

          {/* ---- #489: THE RAIL IS THE SESSIONS LIST AND NOTHING ELSE, which
              is what the Mission Control design has always drawn. #487 kept
              Work and Runbook beside it as a compromise; the owner has called
              it, and a rail with one job does not need a segment picker, a
              layout switcher for one of its segments, or a head row to hold
              either. It is flush to the left edge and the full height of the
              page now — a fixture of the screen rather than a panel inside it
              — so collapsing it is what gives the terminals the last 250px,
              and that choice stays device-local. ---- */}
          <div className={`term-cockpit${viewPrefs.railOpen ? '' : ' collapsed'}`}>
            <div className="tc-top">
              <button
                className="term-rail-toggle"
                title={viewPrefs.railOpen ? 'Collapse the sessions rail' : 'Expand the sessions rail'}
                onClick={() => saveViewPrefs({ railOpen: !viewPrefs.railOpen })}>
                <span className="term-rail-toggle-icon">{viewPrefs.railOpen ? '‹' : '›'}</span>
              </button>
            </div>
            {/* #487 — the design's rail head: what this rail is, and the two
                counts that say whether it is worth opening. Only while open;
                collapsed, the marks below carry the same information in the
                space there is. */}
            {viewPrefs.railOpen && (
              <div className="tc-toolshead">
                <span className="lbl">Tools</span>
                <span className="n">
                  {sessions.filter((x) => !!x.tmux && pinnedOf(x.tmux)).length} pinned
                  {' · '}
                  {sessions.filter((x) => x.status === 'live').length} live
                </span>
              </div>
            )}
            {/* COLLAPSED — one mark per tool, with the asking badge riding it.
                The design's collapsed rail, and it earns its 52px: the badge is
                the one thing you must not have to expand a rail to discover. */}
            {!viewPrefs.railOpen && sessions.length > 0 && (
              <div className="tc-marks">
                {TOOL_GROUPS.map((g) => {
                  const mine = sessions.filter((x) => x.cmd === g.key);
                  if (!mine.length) return null;
                  const asks = mine.filter((x) => !!blockedOf(x)).length;
                  return (
                    <button key={g.key} className={`tc-markbtn ${g.key}`}
                      title={`${mine.length} ${g.name}${asks ? ` · ${asks} waiting on you` : ''} — open the rail`}
                      onClick={() => saveViewPrefs({ railOpen: true })}>
                      {g.mark}
                      {asks > 0 && <span className="b">{asks}</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {viewPrefs.railOpen && (
              <>
                {/* NO HEAD ROW. It existed to hold the segment picker and
                    whichever control the Work segment wanted beside it; with
                    one segment left there is nothing for it to carry, and an
                    empty bar is 30px of the rail's height spent on nothing. */}
                {(
                  /* ---- #487 · SESSIONS — the design's rail, on real data.
                     What is running, grouped by TOOL, and a click on a row
                     brings that session into the first pane (#491 took the
                     drag). The count beside a tool is its sessions;
                     the pill beside that is how many are BLOCKED on a
                     permission prompt, which is the one fact on this rail that
                     changes what you do next.
                     ---- */
                  <>
                  <div className="tc-sessions">
                    {sessions.length === 0 ? (
                      <div className="tc-empty pad">
                        No session open. Start one with + New session.
                      </div>
                    ) : TOOL_GROUPS.map((g) => {
                      const mine = sessions.filter((x) => x.cmd === g.key);
                      if (!mine.length) return null;
                      const asking = mine.filter((x) => !!blockedOf(x)).length;
                      return (
                        <div className="tcg" key={g.key}>
                          <div className="tcg-head">
                            <span className={`term-mark ${g.key}`} aria-hidden="true">{g.mark}</span>
                            <span className="nm">{g.name}</span>
                            {asking > 0 && (
                              <span className="asking" title={`${asking} waiting on a permission answer`}>
                                <span className="d" />{asking} asking
                              </span>
                            )}
                            <span className="n">{mine.length}</span>
                          </div>
                          {mine.map((x) => {
                            const onScreen = slotIds.includes(x.id);
                            const pinned = !!x.tmux && pinnedOf(x.tmux);
                            // The one thing on this row that is not a reading
                            // but a REQUEST: this session has stopped and is
                            // waiting for an answer.
                            const ask = blockedOf(x);
                            return (
                              <div key={x.id}
                                className={`tcg-row${x.id === active ? ' on' : ''}${onScreen ? '' : ' off'}${ask ? ' asking' : ''}`}
                                title={ask
                                  ? 'Stopped on a question — click to bring it into the first pane and answer it'
                                  : onScreen
                                    ? 'Click to bring this session into the first pane'
                                    : 'Not on screen — click to bring it into the first pane'}
                                onClick={() => { if (renaming?.id !== x.id) showInLead(x.id); }}>
                                <span className={`dot ${x.status}`} />
                                {renaming?.id === x.id && renaming.where === 'rail' ? (
                                  <input className="tcg-edit" autoFocus value={draft}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => setDraft(e.target.value)}
                                    onBlur={() => commitRename(x)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') commitRename(x);
                                      if (e.key === 'Escape') { setRenaming(null); setDraft(''); }
                                    }} />
                                ) : (
                                  <span className="t" title="Double-click to rename"
                                    onDoubleClick={(e) => { e.stopPropagation(); startRename(x, 'rail'); }}>
                                    {labelOf(x) || (x.status === 'live'
                                      ? (labelBusy ? 'naming…' : 'not named yet')
                                      : x.note || x.status)}
                                  </span>
                                )}
                                {/* THE ASK MARK — a session that has STOPPED to
                                    ask you something. The group head already
                                    counts them ("2 asking") and the strip above
                                    the canvas names one, but neither says WHICH
                                    row: with six sessions under one tool the
                                    count sends you reading every line. So the
                                    mark goes where the eye already is — on the
                                    name — and the row's left edge goes with it,
                                    because a 7px dot is not findable down a
                                    column of eight.
                                    It pulses for the same reason the head's
                                    badge does: a permission prompt is a session
                                    that has stopped dead, and a still dot reads
                                    as decoration. It is NOT a button — the
                                    whole row already does the one useful thing
                                    (bring it into the first pane, where the
                                    question is), and a target inside a target
                                    is how you mis-click a rail.
                                    It leans towards NULL with `blockedOf`: a
                                    false mark puts an orange dot on a session
                                    nobody asked anything, which is worse than
                                    catching a real one a tick late. */}
                                {ask && (
                                  <span className="tcg-ask" aria-label="Waiting on your answer"
                                    title={`Waiting on you — ${ask.title || ask.question}`}>
                                    <span className="d" />
                                  </span>
                                )}
                                {/* THE PIN IS DRAWN ONLY WHEN IT IS ON
                                    (owner's call). Every row carried an unlit
                                    📍 as well, so the column said nothing: a
                                    mark on every row marks nothing, and an
                                    idle-looking pin beside a live session
                                    reads as a STATE the session is in rather
                                    than as a control. Lit, it is the one fact
                                    worth seeing down this list — which session
                                    the reaper will not take. PINNING happens
                                    on the PANE, where 📍 sits beside the
                                    session you are actually looking at. */}
                                {x.tmux && pinned && (
                                  <button className="tcg-btn on" aria-pressed="true"
                                    title={`Pinned — the idle reaper will not take ${x.tmux}. Click to unpin.`}
                                    onClick={(e) => { e.stopPropagation(); void togglePin(x.tmux!, false); }}>
                                    📌
                                  </button>
                                )}
                                {/* ✎, as the design draws it. A session with no
                                    tmux name yet has nothing stable to key a
                                    name on, so it gets no pencil rather than
                                    one that silently does nothing. */}
                                {x.tmux && renaming?.id !== x.id && (
                                  <button className="tcg-btn" title="Rename this session"
                                    onClick={(e) => { e.stopPropagation(); startRename(x, 'rail'); }}>✎</button>
                                )}
                                {/* The design's last column is the session's
                                    token count. There is no PER-SESSION token
                                    figure on this screen — the daemon reports
                                    one host-wide number — and printing it on
                                    every row would have six sessions each
                                    claiming the same 54k. The directory is
                                    what is true per row, and it is the thing
                                    you actually need when two sessions wear
                                    similar names. */}
                                <ModelChip model={x.model} show={x.cmd === 'claude'} />
                                <span className="cw">{x.cwd || '~'}</span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                    {/* #490 — IDLE ON THE HOST, moved off the canvas. These are
                        sessions the daemon is holding that no pane here shows:
                        a page reload's orphans, and ones attached on another
                        device. They were a strip of wide chips above the
                        terminals; a rail is a column, so each is a row that
                        leads with the directory and carries its name beneath.
                        Re-attach is the whole row — the biggest target, and the
                        thing you almost always want. The pin, the kill tick and
                        × stay small and to the side, because two of those three
                        destroy a running session. */}
                    {detachedShown.length > 0 && (
                      <div className="tc-idle">
                        <div className="tci-head">
                          <span className="lbl">Idle on the host</span>
                          <span className="n">{detachedShown.length}</span>
                        </div>
                        {detachedShown.map((d) => {
                          const nm = labels[d.name] || d.label || '';
                          const picked = killPick.includes(d.name);
                          return (
                            <div key={d.name}
                              className={`tci-row${d.attached ? ' away' : ''}${picked ? ' picked' : ''}${d.keep ? ' pinned' : ''}${d.blocked ? ' asking' : ''}`}>
                              <button className="tci-main"
                                title={d.attached
                                  ? `Attached on another device (tmux ${d.name}) — open it here too: both screens mirror the same session`
                                  : `Re-attach to this running claude session (tmux ${d.name}${d.created ? `, since ${new Date(d.created).toLocaleString()}` : ''})`}
                                onClick={() => attachDetached(d)}>
                                <span className="w">
                                  ↺ {d.cwd ? `~/${d.cwd}` : '~'}
                                  <span className="st">{d.attached ? 'another device' : 'detached'}</span>
                                  {/* An idle row is the one place an unanswered
                                      question can sit unseen for hours: no pane
                                      draws it, so the attention strip above the
                                      canvas — which reads the SESSIONS list —
                                      cannot name it either. The mark is the
                                      same one the rail's live rows wear because
                                      it means the same thing; here re-attaching
                                      is what you do about it, and re-attaching
                                      is what the whole row already does.
                                      It goes on the DIRECTORY line rather than
                                      under the name, because the name line is
                                      conditional — a session the labeller has
                                      not answered for yet would drop the mark
                                      with it. */}
                                  {d.blocked && (
                                    <span className="tcg-ask" aria-label="Waiting on your answer"
                                      title={`Waiting on you — ${d.blocked.title || d.blocked.question}`}>
                                      <span className="d" />
                                    </span>
                                  )}
                                  {/* Every idle row is a claude session by
                                      construction (the host lists stack-term-*
                                      only), so the chip always applies here. */}
                                  <ModelChip model={d.model ?? null} show />
                                </span>
                                {nm && <span className="t">{nm}</span>}
                              </button>
                              <span className="tci-acts">
                                {/* #292 — the keep pin, on EVERY row: the reaper
                                    measures output rather than attachment, so a
                                    session mirrored elsewhere is exactly as
                                    reapable and exactly as worth protecting. */}
                                <button className={`td-pin${d.keep ? ' on' : ''}`} aria-pressed={!!d.keep}
                                  aria-label={d.keep ? `Unpin ${d.name}` : `Pin ${d.name}`}
                                  title={d.keep
                                    ? 'Pinned — the idle reaper will not take this session. Click to unpin.'
                                    : 'Pin this session so the idle reaper never takes it, however quiet it goes'}
                                  onClick={() => void togglePin(d.name, !d.keep)}>
                                  {d.keep ? '📌' : '📍'}
                                </button>
                                {/* Kill controls only on killable rows: the
                                    daemon refuses a name a client still holds,
                                    so offering them on an attached row would be
                                    a button that cannot work. */}
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
                            </div>
                          );
                        })}
                        {killable.length > 1 && (
                          <div className="tci-bulk">
                            <button className="btn-repo sm"
                              onClick={() => setKillPick(killPick.length === killable.length ? [] : killable.map((d) => d.name))}>
                              {killPick.length === killable.length ? 'none' : `all ${killable.length}`}
                            </button>
                            <button className="btn-cancel sm" disabled={killPick.length === 0}
                              title="Kill the selected sessions on the host"
                              onClick={() => setKillTargets(killable.filter((d) => killPick.includes(d.name)))}>
                              × Kill {killPick.length || ''}
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                  </div>

                    {/* #490 — THE STATUS PILLS, moved off the header. Two facts
                        and no third: what the focused pane is holding, and
                        whether the gateway could take a new session. Pinned
                        with the footers rather than sitting in the scroller,
                        because a status you have to scroll to is not a status. */}
                    <div className="tc-status">
                      {activeSess && (
                        <span className={`tcs-row ${activeSess.status}`}>
                          <span className="d" />
                          <span className="n">
                            {activeSess.status === 'live' ? 'live'
                              : activeSess.status === 'connecting' ? 'connecting'
                              : activeSess.status === 'closed' ? 'closed' : 'error'}
                          </span>
                          <span className="v" title={activeSess.note}>
                            {activeSess.status === 'live' || activeSess.status === 'connecting'
                              ? activeSess.note : (activeSess.note || '')}
                          </span>
                        </span>
                      )}
                      {railStatus.map((r) => (
                        <span key={r.key} className={`tcs-row ${r.tone}`} title={`${r.name} — ${r.detail}`}>
                          <span className="d" />
                          <span className="n">{r.name}</span>
                          <span className="v">{r.detail}</span>
                        </span>
                      ))}
                    </div>

                    {/* The two footers sit OUTSIDE the scroller (#490): the
                        list above is `flex: 1`, so a sibling after it is pinned
                        to the bottom of the rail. Inside it they were merely
                        the last thing in a scrolling column — which on a rail
                        with two sessions put Settings and the limits halfway up
                        the screen with empty rail beneath them.

                        ---- #487 · the design's two rail footers ----
                        SETTINGS, with the integrations popover: what is wired
                        into these sessions, and whether each is actually on.
                        The design lists four fixtures; these are the real ones
                        this screen can answer for, and each says its own state
                        rather than a decorative "Enabled". */}
                    <div className="tc-foot">
                      <button className="tc-footbtn" aria-expanded={setsOpen}
                        onClick={() => setSetsOpen((v) => !v)}>
                        <span className="ico">⚙</span>
                        <span className="lbl">Settings</span>
                        <span className={`chip ${gateway?.reachable ? 'ok' : 'off'}`}>
                          <span className="d" />OmniRoute
                        </span>
                      </button>
                      {setsOpen && (
                        <div className="tc-pop" role="dialog" aria-label="Active integrations">
                          <span className="cap">Active integrations</span>
                          {[
                            { n: 'Terminal daemon', d: 'host-side tmux + the uplink',
                              on: !!gateway?.connected, s: gateway?.connected ? 'Connected' : 'Offline' },
                            { n: 'OmniRoute', d: gateway?.reachable
                                ? `${gateway.model || 'auto'}${gateway.paidOptIn ? ' · paid route' : ' · free combo'}`
                                : (gateway?.baseUrl || 'the local gateway'),
                              on: !!gateway?.reachable,
                              s: !gateway?.connected ? 'Cannot see'
                                : gateway?.reachable ? 'Reachable' : 'Unreachable' },
                            { n: 'Session labeller', d: 'names sessions from what they are doing',
                              on: Object.keys(labels).length > 0, s: Object.keys(labels).length ? 'In use' : 'Idle' },
                            { n: 'Idle reaper', d: 'pinned sessions are exempt',
                              on: true, s: `${sessions.filter((x) => !!x.tmux && pinnedOf(x.tmux)).length} pinned` },
                          ].map((i) => (
                            <div className="row" key={i.n}>
                              <span className="b">
                                <span className="n">{i.n}</span>
                                <span className="d">{i.d}</span>
                              </span>
                              <span className={`st ${i.on ? 'on' : 'off'}`}>{i.s}</span>
                            </div>
                          ))}
                          {/* The gateway's own switch, moved here with it.
                              Offered only when a session started NOW would
                              actually reach the gateway — a switch that
                              silently starts a session against a refused
                              connection is worse than no switch. */}
                          <div className="row">
                            <span className="b">
                              <span className="n">New claude tabs on the gateway</span>
                              <span className="d">
                                {gateway?.connected && gateway?.reachable
                                  ? 'a running session’s provider is fixed at spawn'
                                  : 'nothing to route to while it is unreachable'}
                              </span>
                            </span>
                            <button type="button"
                              className={`switch sm ${gwPref ? 'on' : ''}`}
                              disabled={!(gateway?.connected && gateway?.reachable)}
                              aria-pressed={gwPref} aria-label="New claude tabs on the gateway"
                              onClick={() => {
                                const next = !gwPref;
                                setGwPref(next);
                                setTermSessionPrefs({ ...getTermSessionPrefs(), onGateway: next });
                              }}>
                              <span className="switch-knob" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* TODAY'S TOKENS — off the top of the screen and onto the
                        rail, directly above the windows it belongs with. The
                        limits below are PERCENTAGES the daemon reads off the
                        Claude account; this is the COUNT read off the host's
                        transcripts, which is the one figure they do not carry.
                        With no plan data it also keeps the budget bar and the
                        editable estimate, because then it is the only thing on
                        the screen measuring the day — the same fallback the
                        strip had, in a column instead of a row. */}
                    {(usage || serverUsage) && (
                      <div className="tc-tokens">
                        <span className="tt-head">
                          <span className="nm">Tokens today</span>
                          <span className="v" title="Fresh tokens today (input + output + cache writes) from this host's transcripts">
                            {fmtTok(usedTokens)}
                          </span>
                        </span>
                        {!usage?.plan?.session && (
                          <>
                            <span className="tl-bar">
                              <span className="v" style={{
                                width: `${Math.min(100, usagePct)}%`,
                                background: usagePct >= 100 ? 'var(--critical)'
                                  : usagePct >= 85 ? 'var(--building)' : 'var(--accent-text)',
                              }} />
                            </span>
                            <span className="tt-sub">
                              of{' '}
                              {serverUsage && serverUsage.tokenBudget > 0
                                ? <span title="The nightly token budget, set in Stack settings">{fmtTok(serverUsage.tokenBudget)} budget</span>
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
                                      {fmtTok(usagePrefs.dailyLimit)} estimate
                                    </button>
                                  )
                              }
                            </span>
                          </>
                        )}
                        {usage?.totalTokens != null && usage.totalTokens > (usage?.tokens ?? 0) && (
                          <span className="tt-sub" title="Raw volume including prompt-cache reads — the fresh count above is what tracks real work">
                            {fmtTok(usage.totalTokens)} incl. cache reads
                          </span>
                        )}
                      </div>
                    )}

                    {/* THE LIMITS, the design's bottom block. Its three are
                        three PROVIDERS; these are the three real windows the
                        daemon reads off the Claude account — session, week,
                        and the weekly cap on the strong model — which is the
                        same shape (name, plan, percentage, bar, reset) over
                        numbers that are actually measured. Nothing here is an
                        estimate; when the daemon has no plan data the block is
                        absent rather than guessing. */}
                    {planLimits.length > 0 && (
                      <div className="tc-limits">
                        <button className="tl-head" aria-expanded={limitsOpen}
                          onClick={() => setLimitsOpen((v) => !v)}>
                          <span className="c">{limitsOpen ? '▾' : '▸'}</span>
                          <span className="nm">{planLimits[limitIdx % planLimits.length].name}</span>
                          <span className="pct">{planLimits[limitIdx % planLimits.length].pct}%</span>
                        </button>
                        <span className="tl-bar">
                          <span className="v" style={{
                            width: `${Math.min(100, planLimits[limitIdx % planLimits.length].pct)}%`,
                            background: planLimits[limitIdx % planLimits.length].pct >= 90
                              ? 'var(--critical)' : 'var(--accent-text)',
                          }} />
                        </span>
                        {!limitsOpen && (
                          <span className="tl-reset">{planLimits[limitIdx % planLimits.length].resets}</span>
                        )}
                        {limitsOpen && planLimits.map((l, i) => (
                          <button key={l.key} className={`tl-row${i === limitIdx ? ' on' : ''}`}
                            onClick={() => setLimitIdx(i)}>
                            <span className="t"><span className="nm">{l.name}</span><span className="pct">{l.pct}%</span></span>
                            <span className="tl-bar sm">
                              <span className="v" style={{
                                width: `${Math.min(100, l.pct)}%`,
                                background: l.pct >= 90 ? 'var(--critical)' : 'var(--accent-text)',
                              }} />
                            </span>
                            <span className="tl-reset">{l.resets}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
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
    </>
  );
}

// One tab: an xterm instance + its websocket, kept mounted (hidden when
// inactive) so the scrollback survives tab switches.
function TermSession({ sess, visible, focused, fontSize, onStatus, onUsage, onTmux, onModel, onSid, onExit, onOutput, onCopied, register }: {
  sess: { id: number; cwd: string; cmd: 'shell' | 'claude'; tmux?: string };
  // Rendered on screen at all (it may be one of several panes)...
  visible: boolean;
  // ...and the one that takes keystrokes. With a grid these stopped being the
  // same thing: stealing focus for every visible pane would make the last one
  // mounted swallow your typing.
  focused: boolean;
  // Override the shared face size for this pane — Focus's small panes only.
  // Undefined means the size every other terminal uses.
  fontSize?: number;
  onStatus: (s: Status, note: string) => void;
  onUsage: (u: TermUsage) => void;
  onTmux: (name: string) => void;
  // #503 — what the host says this session is running on. Arrives on the ready
  // frame, and again on a 'model' frame if a usage-limit switch-over moves it.
  onModel: (m: SessionModel | null) => void;
  onSid: (sid: string) => void;
  onExit: (tmuxName: string | null) => void;
  // Bytes this session has emitted. Read for ONE purpose: holding the first
  // naming back until there is something worth naming — see NAME_AFTER_BYTES.
  // Nothing re-asks off the back of it; the counter only ever opens the gate.
  onOutput: (bytes: number) => void;
  // A finished clipboard gesture, already worded — "copied 12 lines",
  // "paste needs ⌃V here". With a canvas and no browser selection to look at,
  // "did that work?" is otherwise unanswerable, so the pane says so.
  onCopied: (label: string) => void;
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

  // Refit, and only when refitting can mean anything.
  //
  // FitAddon divides the holder's box by the size of one cell. A pane that is
  // hidden (`display: none` — how every inactive pane is kept alive) measures
  // 0x0, so the division yields a degenerate grid, and the addon happily
  // applies it: the session gets resized to something like 2x2 cells, the
  // program inside reflows to fit, and when the pane comes back the screen is
  // a column of wrapped fragments. That is the "it came back scrambled" bug,
  // and this guard is the whole fix — a terminal nobody can see does not need
  // a size, and the visibility effect refits it the moment it can.
  //
  // The try/catch is the second half: fit() reads live layout and throws if
  // the element is mid-teardown, and an exception on the resize path takes the
  // React tree down with it.
  const safeFit = () => {
    const el = holderRef.current;
    const fit = fitRef.current;
    if (!el || !fit) return;
    if (el.clientWidth < 2 || el.clientHeight < 2) return;
    try { fit.fit(); } catch { /* mid-teardown; the next observation refits */ }
  };

  useEffect(() => {
    const term = new XTerm({ ...TERM_OPTIONS, fontSize: fontSize ?? TERM_OPTIONS.fontSize });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    // The renderer attaches AFTER open(): it needs the element to get a GL
    // context from, and loading it before there is one is the documented way
    // to end up silently on the DOM renderer.
    let detachRenderer = () => {};
    termRef.current = term;
    fitRef.current = fit;
    if (holderRef.current) {
      term.open(holderRef.current);
      detachRenderer = attachRenderer(term, (why) => console.info(`[term ${sess.id}] ${why}`));
      safeFit();
    }
    // Copy/paste (see lib/termClipboard): a released selection copies itself,
    // ⌃⇧C copies explicitly, ⌃V pastes through the browser's own handler, and
    // OSC 52 carries a tmux copy-mode selection — the plain mouse drag inside
    // a claude session — out to the clipboard.
    const unwireClipboard = wireTermClipboard(term, onCopied);

    const connect = () => {
      wsRef.current?.close();
      onStatus('connecting', '');
      safeFit();
      const ws = openTerminal({
        cwd: sess.cwd, cmd: sess.cmd, cols: term.cols, rows: term.rows,
        tmuxSession: sess.cmd === 'claude' && tmuxRef.current ? tmuxRef.current : undefined,
        // Device pref (Settings → Terminal): claude without permission prompts.
        // A boolean only — the daemon maps it to its one allow-listed flag.
        skipPerms: sess.cmd === 'claude' && getTermSessionPrefs().skipPermissions ? true : undefined,
        // #486 — route this session through the local gateway. Read at CONNECT
        // time, not render time, so the pref governs the session it starts and
        // never retro-fits one already running: the daemon fixes a provider at
        // spawn and nothing here can move it afterwards.
        provider: sess.cmd === 'claude' && getTermSessionPrefs().onGateway ? 'omniroute' as const : undefined,
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
          model?: SessionModel | null;
          tokens?: number; resetAt?: number; resetLabel?: string; sched?: { runDate: string; atTime: string };
          totalTokens?: number; plan?: TermUsage['plan'];
        };
        try { m = JSON.parse(ev.data); } catch { return; }
        // Every frame carries the relay's sid, so the first one names this tab
        // for the labeller — including shells, which have no tmux name.
        if (typeof m.sid === 'string' && m.sid && !sidRef.current) { sidRef.current = m.sid; onSid(m.sid); }
        if (m.t === 'out' && m.data) {
          scheduleWrite(b64decode(m.data));
          onOutput(m.data.length);
        }
        else if (m.t === 'usage' && typeof m.tokens === 'number') {
          onUsage({ tokens: m.tokens, totalTokens: m.totalTokens, resetAt: m.resetAt, resetLabel: m.resetLabel, sched: m.sched, plan: m.plan });
        }
        else if (m.t === 'ready') {
          if (m.tmuxSession) { tmuxRef.current = m.tmuxSession; onTmux(m.tmuxSession); }
          // Always reported, including when it is null: "the host does not know
          // what this is on" is an answer the rail must be able to draw, and a
          // daemon too old to send the field at all leaves it undefined, which
          // is the third state — not yet answered.
          if (m.model !== undefined) onModel(m.model);
          onStatus('live', m.cwd || '');
          if (focused) term.focus();
        }
        // #503 — the session's provider moved under it (a usage-limit
        // switch-over is the only thing that does this). The rail would
        // otherwise keep showing what it started on until the next host push.
        else if (m.t === 'model') onModel(m.model ?? null);
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
    // The fit is deferred to the next animation frame rather than run inside
    // the observer callback. Fitting mutates the very element being observed,
    // and a synchronous mutation there is what produces the browser's
    // "ResizeObserver loop completed with undelivered notifications" — which
    // is not cosmetic: the loop is dropped notifications, i.e. a resize that
    // silently never happened. One frame of delay costs nothing and the
    // observer sees a settled box.
    let fitPending = false;
    const onResize = () => {
      if (!fitPending) {
        fitPending = true;
        requestAnimationFrame(() => { fitPending = false; safeFit(); });
      }
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const ws = wsRef.current;
        // A hidden pane measures nothing and fits to nothing — telling the pty
        // about that grid is how a backgrounded session reflows to 2 columns.
        if (term.cols < 2 || term.rows < 2) return;
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
      // The renderer holds a GL context and must go FIRST — see termRenderer.
      detachRenderer();
      term.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A PANE CHANGES SIZE WITHOUT BEING REMOUNTED. Pressing ⤢ moves a session
  // from a small Focus pane into the big one and back, and the session must
  // survive that with its socket and its scrollback — so the face size cannot
  // live only in the constructor. Setting it reflows the grid, which changes
  // how many ROWS fit, so the pty has to be told the new size in the same
  // breath or the program inside keeps drawing to the old one.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const want = fontSize ?? TERM_OPTIONS.fontSize;
    if (term.options.fontSize === want) return;
    term.options.fontSize = want;
    safeFit();
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN && term.cols >= 2 && term.rows >= 2) {
      ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
    }
  }, [fontSize]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refit when this pane becomes visible (it may have been hidden at 0×0).
  useEffect(() => {
    if (!visible) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    safeFit();
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN && term.cols >= 2 && term.rows >= 2) {
      ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
    }
    if (focused) term.focus();
  }, [visible, focused]);

  return <div className="term-holder gitbash" ref={holderRef} style={visible ? undefined : { display: 'none' }} />;
}
