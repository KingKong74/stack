import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  openTerminal,
  getTermUsagePrefs, setTermUsagePrefs, type TermUsagePrefs,
  getTermViewPrefs, setTermViewPrefs, type TermViewPrefs, type TermView, type TermDest,
  getTermSwarmHidden, setTermSwarmHidden, getProjects,
  createAutopilotSchedule,
  getAutopilotJobs, resumeAutopilotJob, hangupAutopilotJob, type AutopilotJob,
  getTerminalUsage, type TerminalUsageData,
  getDetachedSessions, getDetachedFeed, killDetachedSession, keepSession, type DetachedSession,
  type SessionModel,
  labelTerminalSessions,
  setTermTmuxName, clearTermTmuxName,
  getTermOpenTabs, setTermOpenTabs,
  getTermNames, setTermName,
  getTerminalAgent, getTermSessionPrefs, setTermSessionPrefs, type TermSessionPrefs,
  getProjectDetail, type ProjectDetailData,
  getOverview,
  peekTermLaunch, clearTermLaunch,
} from '../store';
import { hrefTo } from '../lib/route';
import { newTermName } from '../lib/termLaunch';
import { FLICK_HINT } from '../lib/flick';
import { askOf } from '../lib/asking';

import { useAutoRefresh } from '../lib/autoRefresh';
import { wireTermClipboard } from '../lib/termClipboard';
import { newCapture, feedTyped, labelAskKeys } from '../lib/termName';
import { DROP_MAX_BYTES, dropSizeLabel, fileToBase64, filesFrom, isFileDrag, pathAsInput } from '../lib/termDrop';
// The wire codec and the palette are shared with the tab agents' consoles
// (#379) — see lib/termWire.ts for why those three and nothing else.
import { b64encode, b64decode, TERM_OPTIONS } from '../lib/termWire';
// How the box is painted (WebGL, with the DOM renderer as the fallback the
// browser can force on us at any moment) — lib/termRenderer says why.
import { attachRenderer } from '../lib/termRenderer';
import { createTermWrites, createTermSizeSender } from '../lib/termStream';
// #380 — a tab agent's console is an ordinary session on this screen in every
// way except its name, which is the only evidence here of what it is: this
// screen has no project payload and no agent state to read. Titling one
// `claude · stack` hides the one fact that distinguishes it from the four
// beside it, so the name is parsed back.
import { ConfirmModal } from '../components/ConfirmModal';
import { TerminalDirectoryPicker } from '../components/TerminalDirectoryPicker';

import {
  zoneRect, zoneAt, tileRects, clampRect, tileStatus, agoLabel, orderTiles, moveKey, compactLines, compactRich, paletteColour,
  STATUS_ORDER, GRID_OPTS, WORKING_MS, HOST_WORKING_MS, type Rect, type Zone, type TileStatus, type PeekSeg,
} from '../lib/termSwarm';
import { TopBar } from '../components/TopBar';
import { crumbName } from '../lib/ui';

// The web terminal (#/terminal[?cwd=…]) — xterm.js over websocket to the host
// PTY daemon (via the server relay at /term). Parallel sessions are panes in a
// grid (each is its own socket; the relay multiplexes them over the one agent
// connection), and the theme is a mintty/git-bash homage: black, grey
// foreground, the classic ANSI palette.
//
// THE SCREEN IS THE TERMINAL PROTOTYPE v2 DESIGN (claude.ai/design, "Terminal
// Prototype v2"). The sessions rail is gone; what replaced it:
//
//  • TABS ACROSS THE TOP, grouped by project, pinned first. A tab is a session
//    this browser holds. In Focus, closing dismisses the pane but keeps its tab.
//    Other views detach it (it stays in Swarm); End is the only thing that kills.
//  • THREE VIEWS: Focus (one session), Main + 3 (one big, three small beside
//    it) and Swarm (every session on the host as a tile, plus floating windows
//    that snap to edges and corners). A tile is a READING (status, name, the
//    pane's last lines); clicking one opens it as a window, which is a live
//    terminal. Live terminals in all 48 tiles would be 48 sockets and renderers.
//  • THE LIMITS sit in the bar, one meter per account, and open a breakdown.
//    Absent telemetry is drawn as absent, never as 0%.
//  • START says what it will do (tool, directory) and its ▼ holds the defaults
//    for new sessions: location, where the work goes, and each tool's model.
//
// EVERY TERMINAL STAYS MOUNTED whatever the view (#137): the panes are one
// keyed list in one parent, and a view only changes each pane's PLACEMENT
// (main / mini / window / off). Moving a session between views must never
// drop its socket or its scrollback.
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
  codex?: { models: { id: string; label: string }[]; limits: { key: string; name: string; pct: number; resetAt: number | null }[] | null } | null;
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
  codexModel?: string;
  // What a NEW session was asked to start on. Ignored by the host on a
  // re-attach, so a restored tab never carries them.
  claudeModel?: string;
  dest?: TermDest;
  // The session's own branch, when the host started it in a worktree, and the
  // project that branch was cut from (its cwd is ~/.stack/worktrees/…, which
  // says nothing about the project).
  branch?: string;
  project?: string;
  id: number; cwd: string; cmd: 'shell' | 'claude' | 'codex'; status: Status; note: string; tmux?: string; sid?: string;
  // #503 — what this session is talking to, as the HOST reported it. undefined
  // = not answered yet (the ready frame has not landed); null = answered, and
  // the answer is UNRECORDED. The two are different and the row draws them
  // differently: nothing, versus a chip that says so.
  model?: SessionModel | null;
  // #505 — what actually answered, filled in from the host's 60s push rather
  // than at spawn: at spawn there is no transcript yet, because the session has
  // not said anything.
  resolvedModel?: string;
};

// The project a session belongs to: the first segment of its cwd, which is
// what `~/slug` opens, unless the host said otherwise (a branch session).
const firstSeg = (cwd?: string) => (cwd || '').replace(/^[/\\~]+/, '').split('/')[0] || '';
// Projects in a stable order, home ('') last.
function byProject<T>(list: T[], projectOf: (x: T) => string): { project: string; rows: T[] }[] {
  const out = new Map<string, T[]>();
  for (const x of list) {
    const p = projectOf(x);
    out.set(p, [...(out.get(p) || []), x]);
  }
  return [...out.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([project, rows]) => ({ project, rows }));
}

// The tool glyph on a tab and in the Start menu.
const TOOL: Record<Sess['cmd'], { name: string; glyph: string }> = {
  claude: { name: 'Claude', glyph: '✳' },
  codex: { name: 'Codex', glyph: '◎' },
  shell: { name: 'Shell', glyph: '$' },
};
// Claude's models are CLI aliases: they resolve to the account's current model
// of each family, so the list never goes stale on a release.
const CLAUDE_MODELS = [
  { id: '', name: 'Default', note: 'CLI default' },
  { id: 'opus', name: 'Opus', note: 'Deepest reasoning' },
  { id: 'sonnet', name: 'Sonnet', note: 'Balanced' },
  { id: 'haiku', name: 'Haiku', note: 'Fastest' },
];
const STATUS_LABEL: Record<TileStatus, string> = { asking: 'asking', working: 'working', idle: 'idle', error: 'exit' };
// A project's letter chip. Two tints, alternating by name, so neighbours read
// apart; the colour carries no meaning beyond "this project, not that one".
const projTint = (p: string) => ([...p].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 2 ? 'b' : 'l');
const projLetter = (p: string) => (p ? p[0].toUpperCase() : '~');

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
function ModelChip({ model, resolved, show }: {
  model?: SessionModel | null; resolved?: string; show: boolean;
}) {
  if (!show || (model === undefined && !resolved)) return null;
  // #505 — WHAT ANSWERED BEATS WHAT WAS ASKED FOR, and it is worth having even
  // when the route is unknown: a session with no tag but a readable transcript
  // can still say what replied, which is the question actually being asked.
  if (resolved) {
    const asked = model?.key === 'anthropic' ? 'your subscription' : model?.id;
    return (
      <span className={`mdl ${model?.key === 'anthropic' ? 'own' : 'alt'}`}
        title={`${resolved} — what actually answered${asked ? `, on ${asked}` : ''}${
          asked && asked !== resolved ? '. The configured route may differ from the model that answered.' : ''}`}>
        {resolved}
      </span>
    );
  }
  if (!model) {
    return (
      <span className="mdl none"
        title="Stack cannot say what this session is running on — it carries no model tag. Sessions started by hand (ssh + stack term), or before the host recorded this, have none.">
        model ?
      </span>
    );
  }
  // THE MODEL IS THE LABEL, not the provider. A column of rows all reading
  // The model is more useful than the provider name when known.
  // hiding the one that matters. The provider moves to the title, where it is
  // one hover away and never competes with the thing you are looking for.
  return (
    <span className={`mdl ${model.key === 'anthropic' ? 'own' : 'alt'}`}
      title={`${model.id || model.label} — ${model.key === 'codex' ? 'native Codex configuration; use /model in this session to check or change its model' : model.key === 'anthropic' ? 'your own Anthropic subscription' : model.label}`}>
      {model.key === 'anthropic' ? 'Claude' : model.key === 'codex' ? (model.id === 'native' ? 'Codex · model unknown' : model.id) : (model.id || model.label)}
    </span>
  );
}

// `reload` (#518) re-attaches: a fresh renderer, a cleared screen and a new
// socket onto the SAME tmux session, which redraws it whole. Never a kill.
// `tail` reads the session's own scrollback for its Swarm tile: what is on
// screen now, not a 60-second-old host capture.
// `peek` is the same tail with each cell's colour, so a hover reads like the session.
type Handle = { sendText: (s: string) => void; reconnect: () => void; reload: () => void; focus: () => void; tail: (n: number) => string[]; peek: (n: number) => PeekSeg[][] };

// Mounted once by App and never unmounted (#137): sessions, sockets and
// scrollback survive navigation. `visible` = the #/terminal route is showing;
// away from it the component renders NOTHING.
export function Terminal({ initialCwd = '', initialAttach, initialBrief, visible = true, boardHref = '', onProject }: {
  initialCwd?: string; initialAttach?: string; initialBrief?: boolean; visible?: boolean;
  /** Where ⌃` goes from here (lib/flick.ts), drawn as the topbar's Board button. */
  boardHref?: string;
  /** Reports the focused pane's TRACKED project ('' for a plain directory). */
  onProject?: (slug: string) => void;
}) {
  const [cwd, setCwd] = useState(initialCwd);
  // The seg control starts on the device's preferred session kind (Settings →
  // Terminal; default claude — that's what this screen is for).
  // DEFAULTS FOR NEW SESSIONS — the tool, each tool's model, and where the work
  // goes. Device-local (Settings → Terminal edits the same row), and read only
  // when a session is CREATED: a restored tab re-attaches whatever it was.
  const [defs, setDefs] = useState<TermSessionPrefs>(() => getTermSessionPrefs());
  const saveDefs = (patch: Partial<TermSessionPrefs>) => {
    const next = { ...getTermSessionPrefs(), ...patch };
    setDefs(next); setTermSessionPrefs(next);
  };
  const mode = defs.autoStart;
  const setMode = (m: Sess['cmd']) => saveDefs({ autoStart: m });
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
  // THE PANE'S RECEIPT LINE. xterm draws to a canvas, so a gesture leaves
  // nothing on the page to look at — without a mark, a copy that worked and one
  // that silently failed look exactly alike, which is how "I can't copy from
  // the terminal" survives a fix. #513 widened it from copies to any gesture
  // the pane answers for, drops included, since they have the same problem.
  const [notice, setNotice] = useState<{ id: number; label: string } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The label is composed by the layer that knows — the clipboard code is the
  // only thing that can tell a copy from a refusal, the drop code the only
  // thing that knows whether the host took the file — and it arrives with its
  // own glyph. A receipt that says "copied" for a refusal is worse than none.
  //
  // `ms` because the two gestures are not the same length: a copy is over
  // before the chip is read, while a drop is a round trip to the host and back
  // and its answer is a PATH somebody may want to read.
  const noteNotice = (id: number, label: string, ms = 1600) => {
    setNotice({ id, label });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), ms);
  };
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // Token usage strip (#111) — fed by every session's usage frames (they all
  // report the same host-wide numbers; latest wins). The daily limit is a
  // device-local estimate; the auto/manual toggle decides whether a limit hit
  // books the next automated session itself or offers a button.
  const [usage, setUsage] = useState<TermUsage | null>(null);
  const [serverUsage, setServerUsage] = useState<TerminalUsageData | null>(null);
  const [usagePrefs, setPrefsState] = useState<TermUsagePrefs>(() => getTermUsagePrefs());
  const [schedNote, setSchedNote] = useState('');
  const scheduling = useRef(false);
  const savePrefs = (p: TermUsagePrefs) => { setPrefsState(p); setTermUsagePrefs(p); };
  // #136 — view prefs, device-local: which view, and Swarm's grid.
  const [viewPrefs, setViewPrefsState] = useState(() => getTermViewPrefs());
  const saveViewPrefs = (p: Partial<TermViewPrefs>) => {
    const next = { ...viewPrefs, ...p };
    setViewPrefsState(next); setTermViewPrefs(next);
  };
  // #276 — "Jump back in" opens the terminal already briefed, and the brief is
  // pasted into a terminal you can see: Swarm shows none, so it lands in Focus.
  useEffect(() => {
    if (initialBrief && viewPrefs.view === 'swarm') saveViewPrefs({ view: 'focus' });
  }, [initialBrief]); // eslint-disable-line react-hooks/exhaustive-deps

  // #138 — bare-slug cwd resolution: a slug with no path separators (e.g.
  // "stack") is sent straight to the daemon, which resolves it relative to
  // STACK_TERM_ROOT ($HOME). So "stack" → "$HOME/stack" — where projects live.
  // The jail still applies: symlinks that escape $HOME are refused by the
  // daemon's resolveCwd() regardless of what the browser sends.
  // Mission Control's per-row ⌨ button and the ProjectDetail ⌨ button both
  // call go.terminal(slug), so project-context opens already land here.
  const openSession = (dir?: string, kind?: 'shell' | 'claude' | 'codex', tmux?: string) => {
    const id = nextId.current++;
    const cwdKey = (dir ?? cwd).trim();
    const cmd = kind ?? mode;
    setSessions((s) => {
      // Explicit new sessions never adopt a remembered session by directory:
      // Claude and Codex can share a cwd. Reload restoration uses the host list.
      const name = tmux ?? (cmd !== 'shell' ? newTermName() : undefined);
      const fresh = !tmux;
      return [...s, {
        id, cwd: cwdKey, cmd, status: 'connecting', note: '', tmux: name,
        codexModel: cmd === 'codex' && fresh ? defs.codexModel || undefined : undefined,
        claudeModel: cmd === 'claude' && fresh ? defs.claudeModel || undefined : undefined,
        dest: cmd !== 'shell' && fresh ? defs.dest : undefined,
      }];
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
  const restoreComplete = useRef(false);
  useEffect(() => {
    const saved = getTermOpenTabs();
    // Shells now; claude tabs wait for the host list. `ids` keeps a slot per
    // saved tab (null = deferred) so the route matching below still indexes
    // against `saved` the way it always has.
    const ids: (number | null)[] = saved.map((t) =>
      (t.cmd === 'shell' ? openSession(t.cwd, t.cmd, t.tmux) : null));
    const deferred = saved
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.cmd !== 'shell');

    let gone = false;

    // The adoption pass. One round trip, then every deferred tab is matched to
    // a host session that actually exists — exact name first (so a tab lands
    // back on ITS OWN session, not merely a session), then any unheld one in
    // the same directory for the tabs whose names were lost to a mid-connect
    // persist. `held` grows as we go, so two tabs in one directory can never
    // claim the same host session and mirror each other.
    const adopt = async () => {
      if (!deferred.length) return [] as number[];
      // A disconnected host has not reported an empty fleet. Keep the saved
      // identities until a connected daemon can answer, including on restart.
      let feed;
      while (!gone) {
        feed = await getDetachedFeed().catch(() => null);
        if (feed?.connected === true) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (gone) return [] as number[];
      const host = feed!.sessions;
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
          ?? byPreference.find((h) => h.cwd === t.cwd && h.cmd === t.cmd && !held.has(h.name))?.name;
        if (!name) continue;   // nothing on the host for it — the tab is not reopened
        held.add(name);
        const id = openSession(t.cwd, t.cmd, name);
        ids[i] = id;
        opened.push(id);
      }
      return opened;
    };

    void adopt().then((opened) => {
      if (gone) return;
      restoreComplete.current = true;
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
    if (!restoreComplete.current) return;
    setTermOpenTabs(sessions
      .filter((s) => s.status === 'live' || s.status === 'connecting' || !!s.tmux)
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
  }, [visible, full, viewPrefs.view]);

  // #491 — CLOSING A PANE NO LONGER ADJUSTS THE SHAPE HERE. It used to
  // decrement the stored pane count, which was this screen's second opinion
  // about how many terminals are on it; the auto-fit below reads the sessions
  // themselves, so the close needs only to close.
  // `park` (a close): the session keeps running, so it goes straight into the
  // parked list rather than blinking out of the bar until the daemon's next
  // advertisement. An End never parks, and its name is kept out of the bar
  // for good (`endingNames`), so a kill in flight never reappears as parked.
  const endingNames = useRef(new Set<string>());
  const detachSession = (id: number, park = true) => {
    const was = sessions.find((x) => x.id === id);
    if (was?.tmux && was.cmd !== 'shell') {
      const name = was.tmux;
      if (!park) endingNames.current.add(name);
      else setDetached((l) => (l.some((d) => d.name === name) ? l : [...l, {
        name, cwd: was.cwd, created: Math.floor(Date.now() / 1000), cmd: was.cmd as 'claude' | 'codex',
        label: labelOf(was) || undefined, keep: pinnedOf(name), branch: was.branch, project: was.project,
      }]));
    }
    handles.current.delete(id);
    setWins((w) => w.filter((x) => x.id !== id));
    setSessions((s) => {
      const rest = s.filter((x) => x.id !== id);
      if (id === active && rest.length) setActive(rest[rest.length - 1].id);
      return rest;
    });
  };

  // Focus closes only the pane. Keep its socket, scrollback and top-bar tab
  // so selecting the session again restores it without a detach/re-attach.
  const closeSession = (id: number) => {
    if (viewPrefs.view === 'focus') {
      if (active === id) setActive(0);
      return;
    }
    detachSession(id);
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
    detachSession(sess.id, false);
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
  // #519 — …or has FINISHED and is waiting at its own input. The rail marks
  // either stop (a bypass-permissions session only ever makes the second);
  // the Approve strip above the canvas stays on `blockedOf` alone, because a
  // finished turn has no menu to approve.
  const askFor = (x: Sess) => {
    const d = x.tmux ? detached.find((dd) => dd.name === x.tmux) : undefined;
    return d ? askOf(d) : null;
  };

  const attachDetached = (d: DetachedSession) => {
    setDetached((l) => l.filter((x) => x.name !== d.name));
    return openSession(d.cwd, d.cmd || 'claude', d.name);
  };

  // Killing host sessions. The route only ever kills DETACHED sessions — the
  // daemon refuses a name a client still holds — so a tile's End on a session
  // nobody here is attached to comes through here, and a tab's End goes
  // through `endSession`, which detaches first.
  const killIdle = async (list: DetachedSession[]) => {
    if (!list.length) return;
    const names = new Set(list.map((d) => d.name));
    for (const n of names) endingNames.current.add(n);
    setDetached((l) => l.filter((x) => !names.has(x.name)));
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
  // #505 — a LIVE row's resolved model comes from the host's session list, not
  // from its socket: the transcript is written by the claude process, so the
  // only reader is the host, and it reports on its own 60s tick. Keyed by tmux
  // name, the one id both sides agree on.
  const resolvedByTmux = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of detached) if (d.name && d.resolvedModel) m.set(d.name, d.resolvedModel);
    return m;
  }, [detached]);

  const detachedShown = detached.filter(
    (d) => !endingNames.current.has(d.name) && !sessions.some((s) => s.tmux === d.name && (s.status === 'live' || s.status === 'connecting')));

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
  // yet and one that is about to get one. Since #512 that gap is the unusual
  // case — most sessions are named by their own first line, before this has
  // anything to say about them.
  const [labelBusy, setLabelBusy] = useState(false);
  const labelBusyRef = useRef(false);
  // (#501) Every session this mount has already ASKED about, answered or not —
  // `labelAskKeys` (lib/termName) says why a failed ask must not be retried.
  const labelAskedRef = useRef<Set<string>>(new Set());
  const refreshLabels = async (keys: string[]) => {
    // Guard on a REF, not the state: two triggers in the same tick would both
    // read the stale `false` and fire two Gemini calls for one set of tabs.
    if (labelBusyRef.current) return;
    labelBusyRef.current = true;
    for (const k of keys) labelAskedRef.current.add(k);
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
  // (#490) NAMED ONCE, THEN NEVER AGAIN — and (#512) THE LABELLER IS NOW THE
  // FALLBACK, NOT THE NAMER.
  //
  // This used to re-ask as a session talked: a title that says what you are
  // working on ought to follow the work, and the work shows up as output. The
  // trouble is that a title which keeps changing underneath you is not a name,
  // it is a status line — you learn where a pane is by its position rather than
  // by reading it, and the one moment the label matters (finding a session you
  // walked away from) is the moment it has just been rewritten to describe
  // whatever happened last. So #490 cut it to one ask.
  //
  // #512 moved the naming off output entirely: a session is called the first
  // thing the human sent it (see `labelOf` and lib/termName). WHAT IS LEFT FOR
  // THIS TO DO is the one case that has no such line to read — a DETACHED
  // session that survived from another device or an earlier run, where the
  // typing happened somewhere this browser was not. Leaving those permanently
  // "not named yet" would be the honest answer to the wrong question: the rail
  // lists them precisely so you can find the one worth re-attaching, and a
  // column of six identical placeholders is what that list is for avoiding.
  //
  // It still fires for a browser-attached session nobody has typed into after
  // a screenful of output — an auto-started tab, or one watching a build — for
  // the same reason. It never overrides a typed name: `labelOf` reads the two
  // human sources first, and the gate below skips anything `labelOf` answers.
  //
  // The re-ask machinery — the per-session dirty-byte counters, the minimum
  // interval, the "has it moved on" test — is gone rather than merely
  // disabled, because a threshold left in the file is an invitation to tune it
  // back up.
  // The ONE ask is gated on there being something to read. Naming once and
  // naming EARLY are different things, and doing both gives every session the
  // permanent title "starting claude session" — read off the splash screen,
  // before the session has done anything, and now never revised. So a live
  // session must have emitted a screenful before it is named. The counter only
  // ever gates the FIRST name; nothing decrements it and nothing re-asks.
  const seenRef = useRef<Record<number, number>>({});
  const NAME_AFTER_BYTES = 2000;
  // …and what Swarm reads as WORKING: a session that put out a real amount in
  // the last few seconds. A trickle (a cursor, a status redraw) is not work, so
  // bytes are pooled over a short window and only a pool past the bar counts.
  const lastBusy = useRef<Record<number, number>>({});
  const busyPool = useRef<Record<number, { t: number; n: number }>>({});
  const noteOutput = (id: number, bytes: number) => {
    seenRef.current[id] = (seenRef.current[id] || 0) + bytes;
    const t = Date.now();
    const pool = busyPool.current[id];
    const cur = pool && t - pool.t < 4000 ? { t: pool.t, n: pool.n + bytes } : { t, n: bytes };
    busyPool.current[id] = cur;
    if (cur.n > 800) lastBusy.current[id] = t;
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
      // (#501) …and a detached row the SERVER already named, or any session
      // this mount has asked about once, is not asked about again.
      const unnamed = labelAskKeys(
        live.map((x) => ({ id: x.id, named: !!labelOf(x), bytes: seenRef.current[x.id] || 0 })),
        detachedShown, labels, labelAskedRef.current, NAME_AFTER_BYTES);
      if (!unnamed.length) return;
      void refreshLabels(unnamed);
    };
    tick();
    const t = setInterval(tick, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessions, detached, labels]);
  // Named by sid first (every session has one), falling back to the tmux name
  // so a tab that re-attached a detached session inherits the name it wore as
  // a chip instead of reading as unnamed until the next ask.
  // #512 — A SESSION IS NAMED BY WHAT YOU TYPED INTO IT: the first line it is
  // sent becomes its title (lib/termName does the reading), so the common case
  // needs no gesture at all.
  //
  // AND A NAME YOU TYPE STILL WINS (owner's call, after #512 took the editor
  // away). #512's reasoning — the words you would put in a rename box are the
  // words you already sent the session — holds for a session opened with a
  // question and fails for every other kind: one opened with `ls`, a pasted
  // screenshot path, or a question that stopped describing it an hour in. So
  // double-click the name, on the rail row or the pane title, and what you
  // type replaces it. There is no ✎ on the rows for the reason the pin is only
  // drawn when lit: a control on every row marks nothing.
  //
  // `names` holds both kinds, keyed by tmux name (store.ts says why never the
  // tab id), and the persist effect below never writes over an entry, so a
  // rename is never overwritten by a first line. Clearing one (an empty
  // rename) hands the row back to the first line and then the labeller.
  const [names, setNames] = useState<Record<string, string>>(() => getTermNames());
  // This mount's captures, keyed by tab id, for the window between "you pressed
  // Enter" and "the daemon told us the tmux name" — a session named in its
  // first second has nothing durable to key on yet, and waiting would mean
  // watching the name you just typed not appear.
  const [typed, setTyped] = useState<Record<number, string>>({});
  const noteTyped = (id: number, text: string) => {
    setTyped((cur) => (cur[id] ? cur : { ...cur, [id]: text }));
  };
  // WHICH SESSION IS BEING RENAMED, AND ON WHICH SURFACE. The `where` is not
  // bookkeeping: the rail row and the pane title both draw an editor for the
  // same session, and an id alone opens BOTH. Two inputs carrying `autoFocus`
  // then fight over the focus on mount, the loser's onBlur commits an empty
  // draft, and the rename closes itself the instant it opens. One editor at a
  // time, and the surface you double-clicked is the one that gets it.
  const [renaming, setRenaming] = useState<{ id: number; where: 'tab' | 'pane' } | null>(null);
  const [draft, setDraft] = useState('');
  // This mount's renames, keyed by tab id, for the same reason `typed` is: a
  // SHELL tab never gets a tmux name (its process dies with the socket), and a
  // claude tab has none for its first second. Refusing those a rename is what
  // made "I can't rename my session" true of every shell. Held here for the
  // tab's life, and copied into `names` once there is a tmux name to key on.
  // '' is a rename to nothing — it clears, and must shadow nothing.
  const [renamed, setRenamed] = useState<Record<number, string>>({});
  // THE ORDER IS THE ORDER OF AUTHORITY, and the two human sources sit above
  // the machine one: the name stored against this tmux session, then this
  // mount's capture, then — only for a session nobody here typed into — the
  // labeller's reading. A restored tab re-attaches a tmux session that already
  // carries the first thing ever asked of it, which is why the stored name
  // wins over a line typed into it this afternoon.
  const labelOf = (s: Sess) =>
    renamed[s.id] || (s.tmux && names[s.tmux]) || typed[s.id]
    || (s.sid && labels[s.sid]) || (s.tmux && labels[s.tmux]) || '';
  // PERSIST ONCE THE SESSION HAS SOMETHING TO KEY ON, and never over a name
  // that is already there — the stored one is older, and older is the whole
  // point of naming from the first line.
  useEffect(() => {
    let wrote = false;
    for (const x of sessions) {
      if (!x.tmux) continue;
      // A rename made before the tmux name arrived IS written over an entry:
      // it is newer than anything stored and it was a decision.
      const r = renamed[x.id];
      if (r && names[x.tmux] !== r) { setTermName(x.tmux, r); wrote = true; continue; }
      const t = typed[x.id];
      if (!t || r !== undefined || names[x.tmux]) continue;
      setTermName(x.tmux, t); wrote = true;
    }
    if (wrote) setNames(getTermNames());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed, renamed, sessions]);
  const startRename = (x: Sess, where: 'tab' | 'pane') => {
    setRenaming({ id: x.id, where }); setDraft(labelOf(x));
  };
  // BLUR COMMITS rather than discarding — losing a name you just typed by
  // clicking away is the worst of the three outcomes, which is the same call
  // the board's inline rename makes. An unchanged draft writes nothing, so
  // opening the editor on a labeller's name and leaving does not promote a
  // machine's guess into a name you chose.
  const commitRename = (x: Sess) => {
    const next = draft.trim().slice(0, 60);
    if (next !== labelOf(x)) {
      setRenamed((cur) => ({ ...cur, [x.id]: next }));
      if (x.tmux) { setTermName(x.tmux, next); setNames(getTermNames()); }
    }
    setRenaming(null); setDraft('');
  };
  const renameKeys = (x: Sess) => (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitRename(x);
    if (e.key === 'Escape') { setRenaming(null); setDraft(''); }
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
  const projectSlug = activeSess?.project || firstSeg(activeSess?.cwd ?? cwd.trim());
  const schedKey = usage?.sched ? `${projectSlug} ${usage.sched.runDate} ${usage.sched.atTime}` : '';
  const booked = !!schedKey && usagePrefs.lastAutoKey === schedKey;
  // Today's fresh tokens off this host's Claude transcripts (the daemon's
  // frames), with the server's 24h figure as the fallback before one lands.
  const usedTokens = usage?.tokens ?? serverUsage?.tokensToday ?? 0;
  // The focused session's tracked project, for the crumb and ⌃` (onProject).
  // A cwd that is not a project leaves both absent rather than guessing.
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
  const boardProject = board ? board.project.id : '';
  useEffect(() => { onProject?.(boardProject); }, [boardProject, onProject]);
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

  const [hostConnected, setHostConnected] = useState<boolean | null>(null);
  const loadHost = () => {
    getTerminalAgent().then((r) => setHostConnected(r.connected)).catch(() => setHostConnected(null));
  };
  useEffect(() => { if (visible) loadHost(); }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  useAutoRefresh(loadHost, visible);


  // ---- the v2 screen: views, tabs, Swarm and its windows -------------------

  const view: TermView = viewPrefs.view;
  const setView = (v: TermView) => { saveViewPrefs({ view: v }); setTilePeek(null); };
  const grid = viewPrefs.grid;

  // Device clock for the tiles' "working" and "4m". Re-read every few seconds
  // while the screen shows, so a session that stops reads idle without input.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => setNow(Date.now()), 4000);
    return () => clearInterval(t);
  }, [visible]);

  const projectOf = (s: Sess) => s.project || firstSeg(s.cwd);
  const projectOfDet = (d: DetachedSession) => d.project || firstSeg(d.cwd);
  const isPinned = (s: Sess) => !!s.tmux && pinnedOf(s.tmux);
  const detOf = (s: Sess) => (s.tmux ? detached.find((d) => d.name === s.tmux) : undefined);
  // A live tab's status off its OWN evidence: real output recently, read off
  // the socket; the host's 60s push would make "working" a minute late.
  const statusOf = (s: Sess): TileStatus => tileStatus({
    asking: !!askFor(s), failed: s.status === 'error' || s.status === 'closed',
    activeAt: lastBusy.current[s.id] || 0, now, windowMs: WORKING_MS,
  });
  const statusOfDet = (d: DetachedSession): TileStatus => tileStatus({
    asking: !!askOf(d), failed: false, activeAt: d.activityAt || 0, now, windowMs: HOST_WORKING_MS,
  });
  const nameOf = (s: Sess) => labelOf(s) || (s.status === 'live'
    ? (labelBusy ? 'naming this session…' : 'New session') : s.note || s.status);
  const nameOfDet = (d: DetachedSession) => labels[d.name] || d.label || 'Not named yet';
  // Where the work goes, as the header and a window's title say it.
  const destLabel = (s: Sess) => (s.cmd === 'shell' ? ''
    : s.branch ? `⎇ ${s.branch}` : s.dest === 'branch' ? '⎇ new branch…' : '⎇ main');

  // TABS — the sessions this browser holds, grouped by project, pinned first.
  const tabGroups = byProject(sessions, projectOf)
    .map((g) => ({ ...g, rows: [...g.rows].sort((a, b) => Number(isPinned(b)) - Number(isPinned(a))) }));
  const tabOrder = tabGroups.flatMap((g) => g.rows);
  // THE BAR holds every session on the host, not just the ones this browser
  // has open: closing a tab only parks it (still running, still here, drawn
  // dim), and only End takes it off. A parked tab keeps its place, because its
  // position is remembered by its tmux name, the key that survives a close.
  type BarEntry = { key: string; sess?: Sess; det?: DetachedSession; project: string; pinned: boolean };
  const barSeen = useRef(new Map<string, number>());
  const barEntries: BarEntry[] = [
    ...sessions.map((x) => ({ key: x.tmux || `tab:${x.id}`, sess: x, project: projectOf(x), pinned: isPinned(x) })),
    ...detachedShown.map((d) => ({ key: d.name, det: d, project: projectOfDet(d), pinned: !!d.keep })),
  ];
  for (const e of barEntries) if (!barSeen.current.has(e.key)) barSeen.current.set(e.key, barSeen.current.size);
  // A session that is ASKING jumps to the front of the bar, ahead of every
  // project, and wears a badge, so a question is never past the edge.
  const askingEntry = (e: BarEntry) => (e.sess ? statusOf(e.sess) : e.det ? statusOfDet(e.det) : '') === 'asking';
  const barSort = (rows: BarEntry[]) => [...rows].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (barSeen.current.get(a.key)! - barSeen.current.get(b.key)!));
  const barAsking = barEntries.filter(askingEntry);
  const barGroups = [
    ...(barAsking.length ? [{ project: '!asking', rows: barSort(barAsking) }] : []),
    ...byProject(barEntries.filter((e) => !askingEntry(e)), (e) => e.project).map((g) => ({ ...g, rows: barSort(g.rows) })),
  ];
  const cur = sessions.find((s) => s.id === active) ?? null;
  // Main + 3's small panes: the next three tabs, pinned first.
  const minis = view === 'split'
    ? [...tabOrder.filter((s) => isPinned(s)), ...tabOrder.filter((s) => !isPinned(s))]
      .filter((s) => s.id !== cur?.id).slice(0, 3)
    : [];

  // ---- Swarm: floating windows -------------------------------------------
  type Win = Rect & { id: number; z: number; snapped: boolean; prev?: { w: number; h: number } };
  const [wins, setWins] = useState<Win[]>([]);
  const zTop = useRef(0);
  const [drag, setDrag] = useState<number | null>(null);
  const [snapPreview, setSnapPreview] = useState<Rect | null>(null);
  const [openIn, setOpenIn] = useState<number | null>(null);
  const swarmBodyRef = useRef<HTMLDivElement | null>(null);
  // The area windows live in: below Swarm's own head row, the full window
  // width. Read live, because the bar above can wrap.
  const area = (): Rect => {
    const top = swarmBodyRef.current?.getBoundingClientRect().top ?? 120;
    return { x: 0, y: top, w: window.innerWidth, h: window.innerHeight - top };
  };
  const focusWin = (id: number) => setWins((ws) => {
    const top = Math.max(0, ...ws.map((w) => w.z));
    const me = ws.find((w) => w.id === id);
    return me && me.z !== top ? ws.map((w) => (w.id === id ? { ...w, z: ++zTop.current } : w)) : ws;
  });
  const openWin = (id: number, geo?: Rect & { snapped?: boolean }) => {
    const a = area();
    setWins((ws) => {
      const w = Math.min(860, a.w * 0.62), h = Math.min(580, a.h * 0.75);
      if (ws.some((x) => x.id === id)) {
        return ws.map((x) => (x.id === id
          ? { ...x, ...(geo ? clampRect(geo, a) : {}), snapped: !!geo?.snapped, z: ++zTop.current } : x));
      }
      const off = (ws.length % 6) * 28;
      const base = geo ?? { x: a.x + (a.w - w) / 2 - 70 + off, y: a.y + (a.h - h) / 2 - 50 + off, w, h };
      return [...ws, { ...clampRect(base, a), id, z: ++zTop.current, snapped: !!geo?.snapped, prev: geo?.snapped ? { w, h } : undefined }];
    });
    setActive(id);
    setTilePeek(null);
  };
  const closeWin = (id: number) => { setWins((ws) => ws.filter((w) => w.id !== id)); setOpenIn(null); };
  const toggleMax = (id: number) => {
    const a = area();
    setWins((ws) => ws.map((w) => {
      if (w.id !== id) return w;
      if (w.snapped) {
        const p = w.prev || { w: 860, h: 580 };
        return { ...w, ...clampRect({ x: a.x + (a.w - p.w) / 2, y: a.y + 40, w: p.w, h: p.h }, a), snapped: false };
      }
      return { ...w, ...zoneRect('max', a), snapped: true, prev: { w: w.w, h: w.h } };
    }));
  };
  const tileAllWins = () => {
    const a = area();
    setWins((ws) => {
      const order = [...ws].sort((p, q) => p.z - q.z).map((w) => w.id);
      const rects = tileRects(ws.length, a);
      return ws.map((w) => ({ ...w, ...rects[order.indexOf(w.id)], snapped: true, prev: w.snapped ? w.prev : { w: w.w, h: w.h } }));
    });
  };
  // DRAG A TITLE BAR to move; to an edge or corner to snap. A snapped window
  // un-snaps to its old size under the pointer, as a desktop's does.
  const startWinDrag = (e: ReactMouseEvent, id: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button,input')) return;
    e.preventDefault();
    focusWin(id);
    const w0 = wins.find((w) => w.id === id);
    if (!w0) return;
    let base: Rect = { x: w0.x, y: w0.y, w: w0.w, h: w0.h };
    if (w0.snapped) {
      const r = w0.prev || { w: 860, h: 580 };
      base = { w: r.w, h: r.h, x: e.clientX - r.w * ((e.clientX - w0.x) / w0.w), y: w0.y };
    }
    const ox = e.clientX - base.x, oy = e.clientY - base.y;
    let zone: Zone | null = null;
    const move = (ev: MouseEvent) => {
      const a = area();
      zone = zoneAt(ev.clientX, ev.clientY, a);
      setSnapPreview(zone ? zoneRect(zone, a) : null);
      setWins((ws) => ws.map((w) => (w.id === id
        ? { ...w, w: base.w, h: base.h, x: ev.clientX - ox, y: Math.max(a.y, ev.clientY - oy), snapped: false } : w)));
    };
    const up = () => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      const a = area();
      setDrag(null); setSnapPreview(null);
      setWins((ws) => ws.map((w) => (w.id !== id ? w : zone
        ? { ...w, ...zoneRect(zone, a), snapped: true, prev: { w: base.w, h: base.h } }
        : { ...w, ...clampRect(w, a) })));
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    setDrag(id); setOpenIn(null);
  };
  const startWinResize = (e: ReactMouseEvent, id: number, dir: string) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    focusWin(id);
    const w0 = wins.find((w) => w.id === id);
    if (!w0) return;
    const sx = e.clientX, sy = e.clientY;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy, a = area();
      let { x, y, w, h } = w0;
      if (dir.includes('e')) w = Math.max(320, w0.w + dx);
      if (dir.includes('s')) h = Math.max(200, w0.h + dy);
      if (dir.includes('w')) { w = Math.max(320, w0.w - dx); x = w0.x + w0.w - w; }
      if (dir.includes('n')) { h = Math.max(200, w0.h - dy); y = Math.max(a.y, w0.y + w0.h - h); h = w0.y + w0.h - y; }
      setWins((ws) => ws.map((v) => (v.id === id ? { ...v, x, y, w, h, snapped: false } : v)));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); setDrag(null); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    setDrag(id); setOpenIn(null);
  };

  // ---- Swarm: tiles ----------------------------------------------------------
  // One tile per session on the host: the tabs here, then everything else the
  // daemon advertises. A tile is a reading; opening one makes it a window.
  type Tile = {
    key: string; sess?: Sess; det?: DetachedSession; name: string; project: string; cmd: Sess['cmd'];
    st: TileStatus; ago: string; pinned: boolean; dest: string;
  };
  const allTiles: Tile[] = [
    ...sessions.map((s): Tile => {
      const d = detOf(s);
      return {
        key: s.tmux || `tab:${s.id}`, sess: s, det: d, name: nameOf(s), project: projectOf(s), cmd: s.cmd,
        st: statusOf(s), ago: agoLabel(lastBusy.current[s.id] || d?.activityAt || 0, now), pinned: isPinned(s), dest: destLabel(s),
      };
    }),
    ...detachedShown.map((d): Tile => ({
      key: d.name, det: d, name: nameOfDet(d), project: projectOfDet(d), cmd: d.cmd || 'claude',
      st: statusOfDet(d), ago: agoLabel(d.activityAt || 0, now), pinned: !!d.keep,
      dest: d.branch ? `⎇ ${d.branch}` : '⎇ main',
    })),
  ];
  const [hidden, setHiddenState] = useState<string[]>(() => getTermSwarmHidden());
  const setHidden = (next: string[]) => { setHiddenState(next); setTermSwarmHidden(next); };
  const [tileOrder, setTileOrder] = useState<string[]>([]);
  const cap = grid.c * grid.r;
  const compact = cap >= 35;
  const shownTiles = orderTiles(allTiles.filter((t) => !hidden.includes(t.key)), tileOrder);
  const tiles = shownTiles.slice(0, cap);
  const hiddenCount = allTiles.filter((t) => hidden.includes(t.key)).length;
  const [tilePeek, setTilePeek] = useState<string | null>(null);
  const [dragTile, setDragTile] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [dragTab, setDragTab] = useState<number | null>(null);
  const [dropWin, setDropWin] = useState<number | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const askingCount = allTiles.filter((t) => t.st === 'asking').length;
  const workingCount = allTiles.filter((t) => t.st === 'working').length;
  const linesOf = (t: Tile): string[] => {
    const live = t.sess ? handles.current.get(t.sess.id)?.tail(40) : undefined;
    return live?.length ? live : t.det?.preview || [];
  };
  // The hover peek: a live tab in its own colours; a host capture is plain text.
  const peekOf = (t: Tile): PeekSeg[][] => {
    const live = t.sess ? handles.current.get(t.sess.id)?.peek(40) : undefined;
    return live?.length ? live : (t.det?.preview || []).map((l) => (l ? [{ t: l }] : []));
  };
  // A tile opens as a window. A session nobody here holds is attached first,
  // which makes it a tab like any other.
  const openTile = (t: Tile, geo?: Rect & { snapped?: boolean }) => {
    const id = t.sess ? t.sess.id : t.det ? attachDetached(t.det) : null;
    if (id != null) openWin(id, geo);
  };
  // A REPLY from a tile types the text and presses Enter, the same as typing it
  // at the pane. A session not attached here is attached first, and the reply
  // waits for it to be live.
  const pendingReply = useRef(new Map<number, string>());
  const [replies, setReplies] = useState<Record<string, string>>({});
  const sendReply = (t: Tile) => {
    const text = (replies[t.key] || '').trim();
    if (!text) return;
    setReplies((r) => ({ ...r, [t.key]: '' }));
    if (t.sess && t.sess.status === 'live') { handles.current.get(t.sess.id)?.sendText(`${text}\r`); return; }
    const id = t.sess ? t.sess.id : t.det ? attachDetached(t.det) : null;
    if (id != null) pendingReply.current.set(id, text);
  };
  useEffect(() => {
    for (const [id, text] of pendingReply.current) {
      const s = sessions.find((x) => x.id === id);
      if (!s) { pendingReply.current.delete(id); continue; }
      if (s.status !== 'live') continue;
      pendingReply.current.delete(id);
      // A beat for claude's input box to draw before the keystrokes land.
      setTimeout(() => handles.current.get(id)?.sendText(`${text}\r`), 600);
    }
  }, [sessions]);
  const hideTile = (key: string, id?: number) => {
    setHidden([...new Set([...hidden, key])]);
    if (id != null) closeWin(id);
    setTilePeek(null);
  };
  const sortByStatus = () => setTileOrder(STATUS_ORDER.flatMap((k) => shownTiles.filter((t) => t.st === k)).map((t) => t.key));
  const [fillAsk, setFillAsk] = useState(0);
  const fillEmpty = (n: number) => {
    for (let i = 0; i < n; i++) openSession(undefined, mode);
    setFillAsk(0);
  };
  // A tab clicked in Swarm lights its tile rather than leaving the view.
  const spotlight = (key: string, id: number) => {
    setActive(id);
    const at = shownTiles.findIndex((t) => t.key === key);
    if (at >= cap) setTileOrder([...shownTiles.slice(0, cap - 1).map((t) => t.key), key, ...shownTiles.slice(cap - 1).map((t) => t.key).filter((k) => k !== key)]);
    setFlash(key);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1600);
  };

  // Swarm takes a TAB dragged onto it as a window, snapped where it lands.
  const isTabDrag = (e: ReactDragEvent) => dragTab != null && e.dataTransfer.types.includes('text/x-stack-tab');
  const onSwarmDragOver = (e: ReactDragEvent) => {
    if (!isTabDrag(e)) return;
    e.preventDefault();
    const a = area(), z = zoneAt(e.clientX, e.clientY, a);
    const pv = z ? zoneRect(z, a) : { x: e.clientX - 200, y: Math.max(a.y, e.clientY - 20), w: 400, h: 260 };
    if (!snapPreview || Math.abs(snapPreview.x - pv.x) > 4 || Math.abs(snapPreview.y - pv.y) > 4 || snapPreview.w !== pv.w || dropWin != null) {
      setSnapPreview(pv); setDropWin(null);
    }
  };
  const onSwarmDrop = (e: ReactDragEvent) => {
    if (!isTabDrag(e) || dragTab == null) return;
    e.preventDefault();
    const a = area(), z = zoneAt(e.clientX, e.clientY, a);
    openWin(dragTab, z ? { ...zoneRect(z, a), snapped: true } : { x: e.clientX - 200, y: e.clientY - 20, w: 400, h: 260 });
    const s = sessions.find((x) => x.id === dragTab);
    if (s?.tmux) setHidden(hidden.filter((k) => k !== s.tmux));
    setDragTab(null); setSnapPreview(null); setDropWin(null);
  };
  // …and a tab dropped on a window puts that session in the window instead.
  const swapWin = (winId: number, id: number) => {
    setWins((ws) => (ws.some((w) => w.id === id) ? ws : ws.map((w) => (w.id === winId ? { ...w, id, z: ++zTop.current } : w))));
    setActive(id);
    setDragTab(null); setDropWin(null); setSnapPreview(null);
  };

  // ---- the bar ----------------------------------------------------------------
  const [menu, setMenu] = useState<{ id: number; det?: string; x: number; y: number } | null>(null);
  const [switcher, setSwitcher] = useState(false);
  const [q, setQ] = useState('');
  const [newMenu, setNewMenu] = useState(false);
  const [gridMenu, setGridMenu] = useState(false);
  const [usageOpen, setUsageOpen] = useState<{ key: 'claude' | 'codex'; x: number } | null>(null);
  const tabRowRef = useRef<HTMLDivElement | null>(null);

  // Escape closes what is OPEN ON TOP of the terminals, and only that. It is
  // never taken while nothing is open: Esc is a key claude itself uses.
  const anyPopover = !!(menu || switcher || newMenu || gridMenu || usageOpen || openIn != null);
  useEffect(() => {
    if (!anyPopover) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenu(null); setSwitcher(false); setNewMenu(false); setGridMenu(false); setUsageOpen(null); setOpenIn(null);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [anyPopover]);
  // The active tab scrolls itself into view.
  useEffect(() => {
    const row = tabRowRef.current;
    const el = row?.querySelector(`[data-tab="${active}"]`) as HTMLElement | null;
    if (!row || !el) return;
    const r = el.getBoundingClientRect(), rr = row.getBoundingClientRect();
    if (r.left < rr.left) row.scrollLeft -= rr.left - r.left + 8;
    else if (r.right > rr.right) row.scrollLeft += r.right - rr.right + 8;
  }, [active, sessions.length]);

  const selectTab = (s: Sess) => {
    if (view === 'swarm') spotlight(s.tmux || `tab:${s.id}`, s.id);
    else setActive(s.id);
  };
  const openParked = (d: DetachedSession) => {
    const id = attachDetached(d);
    if (view === 'swarm') spotlight(d.name, id);
  };
  const togglePinSess = (s: Sess) => { if (s.tmux) void togglePin(s.tmux, !isPinned(s)); };
  const closeUnpinned = () => { for (const s of sessions) if (!isPinned(s)) closeSession(s.id); setMenu(null); };
  // End is immediate (owner's call, 2026-11-08): no confirm. Close is the
  // gentle verb; End means it.
  const askEnd = (sess?: Sess, det?: DetachedSession) => {
    setMenu(null); setTilePeek(null);
    if (sess) { closeWin(sess.id); void endSession(sess); } else if (det) void killIdle([det]);
  };

  // END ALL: every tab here and every session idling on the host, from any
  // view. Pinned ones are kept — a pin is the owner saying "not this one", and
  // a bulk action should not overrule it. Tabs detach first and are killed as
  // the daemon advertises them, the same two steps as one End (`endSession`).
  // The active tab is always in sight: picking one from the switcher, Swarm or
  // a new Start scrolls the row to it rather than leaving it past the edge.
  useEffect(() => {
    if (!visible || active == null) return;
    tabRowRef.current?.querySelector(`[data-tab="${active}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const [endAllAsk, setEndAllAsk] = useState(false);
  const endAllTabs = sessions.filter((x) => !isPinned(x));
  const endAllIdle = detached.filter((d) => !d.keep && !sessions.some((x) => x.tmux === d.name));
  const endAllCount = endAllTabs.length + endAllIdle.length;
  const endAllKept = sessions.length + detached.filter((d) => !sessions.some((x) => x.tmux === d.name)).length - endAllCount;
  const doEndAll = async () => {
    setEndAllAsk(false);
    const tabs = endAllTabs, idle = endAllIdle;
    setWins([]);
    const names = new Set(tabs.map((x) => x.tmux).filter((n): n is string => !!n));
    for (const x of tabs) detachSession(x.id, false);
    void killIdle(idle);
    for (let i = 0; i < 12 && names.size; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const list = await getDetachedSessions().catch(() => []);
      for (const d of list) {
        if (!names.has(d.name)) continue;
        names.delete(d.name);
        await killDetachedSession(d.name).catch(() => { /* the refresh below tells the truth */ });
      }
    }
    void refreshDetached();
  };

  // THE LIMITS, one meter per account. Only what the daemon measured: a window
  // it did not report is ABSENT, because an unmeasured limit drawn at 0% reads
  // as "plenty left", the most expensive way to be wrong here.
  type LimWin = { pct: number; resetAt: number | null };
  const meters: { key: 'claude' | 'codex'; name: string; session: LimWin | null; week: LimWin | null; extra: { key: string; name: string; w: LimWin }[]; tokens: string }[] = [
    {
      key: 'claude', name: 'Claude',
      session: usage?.plan?.session ?? null, week: usage?.plan?.week ?? null,
      extra: usage?.plan?.weekModel ? [{ key: 'weekModel', name: `Week · ${usage.plan.weekModel.model || 'strong model'}`, w: usage.plan.weekModel }] : [],
      tokens: usedTokens > 0 ? fmtTok(usedTokens) : '',
    },
    {
      key: 'codex', name: 'Codex',
      session: usage?.codex?.limits?.find((l) => l.key.endsWith(':primary')) ?? null,
      week: usage?.codex?.limits?.find((l) => l.key.endsWith(':secondary')) ?? null,
      extra: (usage?.codex?.limits || []).filter((l) => !/:(primary|secondary)$/.test(l.key)).map((l) => ({ key: l.key, name: l.name, w: l })),
      tokens: '',
    },
  ];
  const tone = (pct: number) => (pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : 'ok');
  const fmtIn = (ms: number | null) => {
    if (!ms) return '';
    const m = Math.max(0, Math.round((ms - now) / 60000));
    return m >= 1440 ? `in ${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `in ${Math.floor(m / 60)}h ${m % 60}m` : `in ${m}m`;
  };
  const meterOf = (k: 'claude' | 'codex') => meters.find((m) => m.key === k)!;

  // Locations for Start's defaults: tracked projects, from the one list read.
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!visible || projects.length) return;
    getProjects().then((ps) => setProjects(ps.map(({ id, name }) => ({ id, name })))).catch(() => { /* the input still takes any path */ });
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const codexModels = [{ id: '', label: 'Default' }, ...(usage?.codex?.models || [])];
  const modelName = (tool: Sess['cmd']) => (tool === 'claude'
    ? CLAUDE_MODELS.find((m) => m.id === defs.claudeModel)?.name || defs.claudeModel
    : tool === 'codex' ? codexModels.find((m) => m.id === defs.codexModel)?.label || defs.codexModel : 'login shell');
  const startLabel = `${TOOL[mode].name} in ~/${cwd.trim()}`;

  const swGroups = (() => {
    const t = q.trim().toLowerCase();
    const match = (name: string, project: string, key: string) => !t || `${name} ${project} ${key}`.toLowerCase().includes(t);
    return [
      ...tabGroups.map((g) => ({
        title: `Open · ${g.project || '~ home'}`,
        rows: g.rows.filter((s) => match(nameOf(s), g.project, s.tmux || '')).map((s) => ({
          key: `s${s.id}`, name: nameOf(s), project: g.project, st: statusOf(s), pinned: isPinned(s), on: s.id === active,
          pick: () => { setActive(s.id); if (view === 'swarm') setView('focus'); setSwitcher(false); setQ(''); },
        })),
      })),
      {
        title: 'Not open',
        rows: detachedShown.filter((d) => match(nameOfDet(d), projectOfDet(d), d.name)).map((d) => ({
          key: d.name, name: nameOfDet(d), project: projectOfDet(d), st: statusOfDet(d), pinned: !!d.keep, on: false,
          pick: () => { attachDetached(d); if (view === 'swarm') setView('focus'); setSwitcher(false); setQ(''); },
        })),
      },
    ].filter((g) => g.rows.length);
  })();

  // Plain functions, NOT components: a component defined inside this render is
  // a new type every render, which remounts it — and the rename input with it,
  // dropping the caret on every keystroke.
  // The red pin (owner's call, 2026-11-08): 📌 pinned, 📍 not. An emoji, not
  // a tone, so it reads the same on every ground and needs no palette entry.
  const pinIcon = (size = 11, on = true) => (
    <span className="tv-pinemo" style={{ fontSize: size + 1 }} aria-hidden="true">{on ? '📌' : '📍'}</span>
  );
  const projChip = (p: string, size = 16) => (
    <span className={`tv-proj ${projTint(p)}`} style={{ width: size, height: size }} aria-hidden="true">{projLetter(p)}</span>
  );
  // A session's name, renamed by a double-click on whichever surface drew it.
  const nameEdit = (s: Sess, where: 'tab' | 'pane', className: string) => (
    renaming?.id === s.id && renaming.where === where ? (
      <input className="tv-rename" autoFocus value={draft} aria-label="Session name"
        onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)} onBlur={() => commitRename(s)} onKeyDown={renameKeys(s)} />
    ) : (
      <span className={className} title={`${labelOf(s) || 'Not named yet'} — double-click to rename`}
        onDoubleClick={(e) => { e.stopPropagation(); startRename(s, where); }}>{nameOf(s)}</span>
    )
  );

  const handlesFor = (id: number) => ([
    ['n', 'tv-h-n'], ['s', 'tv-h-s'], ['e', 'tv-h-e'], ['w', 'tv-h-w'],
    ['ne', 'tv-h-ne'], ['nw', 'tv-h-nw'], ['se', 'tv-h-se'], ['sw', 'tv-h-sw'],
  ] as const).map(([d, c]) => <div key={d} className={`tv-h ${c}`} onMouseDown={(e) => startWinResize(e, id, d)} />);
  const topZ = Math.max(0, ...wins.map((w) => w.z));
  // Stacking by RANK, not the raw counter: z climbs on every focus, and a
  // window must never rise over the popovers (56) or a confirm dialog (50).
  const winRank = new Map([...wins].sort((p, q) => p.z - q.z).map((w, i) => [w.id, i]));
  const skipPerms = getTermSessionPrefs().skipPermissions;

  return (
    <>
    <div className={`term-screen tv${visible ? (full ? ' term-fullscreen' : '') : ' term-hidden'}`}>
      {/* THE CRUMB NAMES THE PROJECT WHEN THERE IS ONE — only when the cwd
          resolves to a tracked project; a slug Stack has never heard of is not
          a project and must not be drawn as one. */}
      <TopBar crumb={[
        { label: 'Projects', href: hrefTo.dashboard },
        ...(board ? [{ label: crumbName(board.project.name), href: hrefTo.detail(board.project.id) }] : []),
        { label: 'Terminal', href: hrefTo.terminal(cwd) },
      ]}
        actions={<>
          {boardHref && (
            <a className="btn-repo" href={boardHref}
              title={`${board ? `${crumbName(board.project.name)}'s board` : 'Back'} (${FLICK_HINT} flicks back here)`}>
              {board ? 'Board' : 'Back'} <span className="kbd-hint">{FLICK_HINT}</span>
            </a>
          )}
          <a className="btn-repo" href={hrefTo.control} title="Mission Control">Mission Control</a>
        </>} />

      <div className="page term-page tv-page">
        {/* ---- THE BAR: tabs · switcher · limits · start · views ---- */}
        <div className="tv-bar">
          <div className="tv-tabs" ref={tabRowRef}
            onWheel={(e) => { const r = tabRowRef.current; if (r && Math.abs(e.deltaY) > Math.abs(e.deltaX)) r.scrollLeft += e.deltaY; }}>
            {barGroups.map((g) => (
              <div className={`tv-tabgroup${g.project === '!asking' ? ' asking' : ''}`} key={g.project}>
                {g.rows.map((e) => {
                  const d = e.det;
                  if (!e.sess && d) {
                    const dst = statusOfDet(d);
                    const dcmd = d.cmd || 'claude';
                    return (
                      <div key={e.key} className={`tv-tab parked${dst === 'asking' ? ' asking' : ''}${view === 'swarm' && flash === d.name ? ' on' : ''} p-${projTint(e.project)}`}
                        onClick={() => openParked(d)}
                        onContextMenu={(ev) => { ev.preventDefault(); setMenu({ id: -1, det: d.name, x: ev.clientX, y: ev.clientY }); }}
                        title={`${nameOfDet(d)} · ${TOOL[dcmd].name} · ~/${d.cwd || ''} — running, not open here. Click to open; right-click to end.`}>
                        <span className={`tv-glyph ${dcmd}`} aria-hidden="true">{TOOL[dcmd].glyph}</span>
                        <span className="tv-tab-body">
                          <span className="tv-tab-name">{nameOfDet(d)}</span>
                          <span className="tv-tab-sub">
                            <span className={`tv-dot ${dst}`} />
                            <span className={`tv-tool ${dcmd}`}>{TOOL[dcmd].name}</span>
                            <span>·</span>
                            <span className={`tv-pname ${projTint(e.project)}`}>{e.project || '~'}</span>
                            <span>·</span>
                            <span className="tv-ell">{d.attached ? 'open elsewhere' : 'closed'}</span>
                            {d.keep && <span className="tv-pinmark">{pinIcon(10)}</span>}
                          </span>
                        </span>
                      </div>
                    );
                  }
                  const s = e.sess!;
                  const st = statusOf(s);
                  const on = s.id === active && (view !== 'swarm' || flash === (s.tmux || `tab:${s.id}`));
                  // Main + 3: which tabs are on the stage, and where (main green, the small three blue).
                  const slot = view !== 'split' ? '' : s.id === cur?.id ? ' in-main' : minis.some((m) => m.id === s.id) ? ' in-mini' : '';
                  return (
                    <div key={s.id} data-tab={s.id} className={`tv-tab${on ? ' on' : ''}${slot}${st === 'asking' ? ' asking' : ''} p-${projTint(e.project)}`}
                      draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/x-stack-tab', String(s.id)); setDragTab(s.id); }}
                      onDragEnd={() => { setDragTab(null); setSnapPreview(null); }}
                      onClick={() => selectTab(s)}
                      onContextMenu={(e) => { e.preventDefault(); setMenu({ id: s.id, x: e.clientX, y: e.clientY }); }}
                      title={`${nameOf(s)} · ${TOOL[s.cmd].name} · ${s.cwd || '~'} (right-click for options)`}>
                      <span className={`tv-glyph ${s.cmd}`} aria-hidden="true">{TOOL[s.cmd].glyph}</span>
                      <span className="tv-tab-body">
                        {nameEdit(s, 'tab', 'tv-tab-name')}
                        <span className="tv-tab-sub">
                          <span className={`tv-dot ${st}`} />
                          <span className={`tv-tool ${s.cmd}`}>{TOOL[s.cmd].name}</span>
                          <span>·</span>
                          <span className={`tv-pname ${projTint(e.project)}`}>{e.project || '~'}</span>
                          <span>·</span>
                          <span className="tv-ell">{s.status === 'live' ? STATUS_LABEL[st] : s.status}</span>
                          {isPinned(s) && <span className="tv-pinmark">{pinIcon(10)}</span>}
                        </span>
                      </span>
                      <button className="tv-x" aria-label="Close tab"
                        title={view === 'focus' ? 'Close the pane — the session stays in the top bar' : s.tmux ? 'Close — the session keeps running and stays in the bar' : 'Close the tab — a shell ends with it'}
                        onClick={(e) => { e.stopPropagation(); closeSession(s.id); }}>×</button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <button className={`tv-btn tv-switch${switcher ? ' on' : ''}`} title="All sessions"
            onClick={() => { setSwitcher((v) => !v); setQ(''); }}>
            <span className="mono">{barEntries.length}</span><span className="caret">▼</span>
          </button>
          <div className="tv-meters">
            {meters.map((m) => {
              const s = m.session;
              return (
                <button key={m.key} className={`tv-meter k-${m.key}${usageOpen?.key === m.key ? ' on' : ''}`}
                  title={s ? `${m.name}: ${Math.round(s.pct)}% of the session window used${s.resetAt ? `, resets ${fmtReset(s.resetAt)}` : ''}${m.week ? `. Weekly ${Math.round(m.week.pct)}%.` : '.'} Click for the breakdown.`
                    : `Stack cannot see ${m.name}'s limits right now. Click for what it can see.`}
                  onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); const k = m.key; setUsageOpen((u) => (u?.key === k ? null : { key: k, x: Math.max(8, Math.min(r.left, window.innerWidth - 348)) })); }}>
                  <span className="tv-meter-row">
                    <span className="nm">{m.name}</span>
                    <span className="tv-meter-bar"><span className={`v ${s ? tone(s.pct) : ''}`} style={{ width: `${s ? Math.min(100, s.pct) : 0}%` }} /></span>
                    <span className={`pct ${s ? tone(s.pct) : ''}`}>{s ? `${Math.round(s.pct)}%` : '—'}</span>
                  </span>
                  <span className="tv-meter-sub">
                    {s ? `↻ ${s.resetAt ? fmtReset(s.resetAt) : 'no reset reported'}${m.tokens ? ` · ${m.tokens} tokens` : ''}` : 'not measured'}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="tv-start">
            <TerminalDirectoryPicker value={cwd} projects={projects} onChange={setCwd} onSubmit={() => openSession()} />
            <select className="tv-select" aria-label="Session type" value={mode}
              onChange={(e) => setMode(e.target.value as Sess['cmd'])}>
              <option value="claude">Claude</option><option value="codex">Codex</option><option value="shell">Shell</option>
            </select>
            <span className="tv-split-btn">
              <button className="tv-go" onClick={() => openSession()} title={`Open ${startLabel}`}>
                <span className="plus">+</span>Start
              </button>
              <button className="tv-go caret" aria-label="Session defaults" title="Model and where work goes"
                onClick={() => setNewMenu((v) => !v)}>▼</button>
            </span>
            {newMenu && (
              <>
                <div className="tv-scrim" onClick={() => setNewMenu(false)} />
                <div className="tv-pop tv-newmenu" role="dialog" aria-label="New session">
                  {(['claude', 'codex', 'shell'] as const).map((k) => {
                    const lim = k === 'shell' ? null : meterOf(k).session;
                    return (
                      <button key={k} className="tv-kind" onClick={() => { setMode(k); setNewMenu(false); openSession(undefined, k); }}>
                        <span className={`tv-glyph ${k}`}>{TOOL[k].glyph}</span>
                        <span className="b">
                          <span className="n">{TOOL[k].name} session</span>
                          <span className="s">{modelName(k)} · ~/{cwd.trim()}{lim ? ` · ${Math.round(lim.pct)}% used` : ''}</span>
                        </span>
                      </button>
                    );
                  })}
                  <div className="tv-rule" />
                  <div className="tv-defs">
                    <span className="eyebrow">Defaults for new sessions</span>
                    <div className="grp">
                      <span className="cap">Location</span>
                      <TerminalDirectoryPicker value={cwd} projects={projects} onChange={setCwd} />
                    </div>
                    <div className="grp">
                      <span className="cap">Work goes to</span>
                      <div className="opts col">
                        {([
                          { v: 'main', name: 'Commit to main', note: 'Runs in the checkout itself, as every session always has' },
                          { v: 'branch', name: 'New branch', note: 'Its own worktree on term/<id>, cut from origin/main; review it before merging' },
                        ] as const).map((o) => (
                          <button key={o.v} className={`tv-dest${defs.dest === o.v ? ' on' : ''}`} onClick={() => saveDefs({ dest: o.v as TermDest })} title={o.note}>
                            <span className="n">{o.name}</span><span className="s">{o.note}</span>
                          </button>
                        ))}
                        <button className="tv-dest" disabled title="Not wired yet">
                          <span className="n">Mirror host</span><span className="s">Work on a copy of the host, promote to main once it checks out. Not wired yet.</span>
                        </button>
                      </div>
                    </div>
                    <div className="grp">
                      <span className="cap">Claude</span>
                      <div className="opts">
                        {CLAUDE_MODELS.map((m) => (
                          <button key={m.id || 'default'} className={`tv-opt${defs.claudeModel === m.id ? ' on' : ''}`} title={`${m.note}${m.id ? ` · --model ${m.id}` : ''}`}
                            onClick={() => saveDefs({ claudeModel: m.id })}>{m.name}</button>
                        ))}
                      </div>
                    </div>
                    <div className="grp">
                      <span className="cap">Codex</span>
                      <div className="opts">
                        {codexModels.map((m) => (
                          <button key={m.id || 'default'} className={`tv-opt${defs.codexModel === m.id ? ' on' : ''}`} title={m.id || 'the CLI default'}
                            onClick={() => saveDefs({ codexModel: m.id })}>{m.label}</button>
                        ))}
                        {!usage?.codex?.models?.length && <span className="tv-dim">catalogue unavailable</span>}
                      </div>
                    </div>
                    <span className="tv-dim">A session already running keeps its model; use /model inside it.</span>
                  </div>
                </div>
              </>
            )}
          </div>
          {brief && (
            <button className="tv-btn" onClick={pasteBrief}
              title="Types the roadmap brief into the active session — review it, then press Enter yourself">▶ Paste brief</button>
          )}
          <div className="tv-views" role="tablist" aria-label="Terminal view">
            {([['focus', 'Focus'], ['split', 'Main + 3'], ['swarm', 'Swarm']] as const).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={view === k} className={`tv-view${view === k ? ' on' : ''}`}
                title={label} aria-label={label} onClick={() => setView(k)}>
                {k === 'focus' && <svg width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1" y="1" width="14" height="12" rx="2" /></svg>}
                {k === 'split' && <svg width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1" y="1" width="14" height="7" rx="1.5" /><rect x="1" y="10" width="3.6" height="3" rx="0.8" /><rect x="6.2" y="10" width="3.6" height="3" rx="0.8" /><rect x="11.4" y="10" width="3.6" height="3" rx="0.8" /></svg>}
                {k === 'swarm' && <svg width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1" y="1" width="3.6" height="5" rx="0.8" /><rect x="6.2" y="1" width="3.6" height="5" rx="0.8" /><rect x="11.4" y="1" width="3.6" height="5" rx="0.8" /><rect x="1" y="8" width="3.6" height="5" rx="0.8" /><rect x="6.2" y="8" width="3.6" height="5" rx="0.8" /><rect x="11.4" y="8" width="3.6" height="5" rx="0.8" /></svg>}
                {k === 'swarm' && askingCount > 0 && <span className="tv-badge">{askingCount}</span>}
              </button>
            ))}
          </div>
          <button className="tv-btn tv-endall danger" disabled={endAllCount === 0} onClick={() => setEndAllAsk(true)}
            title={endAllCount ? `End all ${endAllCount} session${endAllCount === 1 ? '' : 's'} on the host${endAllKept ? ` (${endAllKept} pinned kept)` : ''}` : 'Nothing to end'}>
            End all
          </button>
          <button className={`tv-btn tv-icon${full ? ' on' : ''}`} onClick={toggleFull} aria-pressed={full}
            title={full ? 'Leave full screen (esc also works)' : 'Full screen — the terminals take the whole window'}>
            {full ? '⤡' : '⤢'}
          </button>
        </div>

        {/* FAIL SILENT, AND SAY SO: with no daemon on the line every list here
            is empty because Stack cannot see, not because nothing runs. */}
        {hostConnected === false && (
          <div className="tv-blind">Stack cannot see the host: the terminal daemon is not connected. Sessions and Swarm show nothing until it is back.</div>
        )}

        {/* THE DAY'S EVENTS — drawn only when something has HAPPENED: a limit
            reset landing, a session paused, a booking offered or taken. */}
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
                    title="Resume the paused session now — the host picks it up within a minute">▶ Resume now</button>
                )}
                {resumeJob.status === 'queued' && resumeJob.notBefore && (
                  <button className="btn-cancel sm" onClick={() => void actOnResume(hangupAutopilotJob)}
                    title="Hang up — hold the session so it only resumes when you say">Hang up</button>
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

        {/* ---- THE STAGE. Every pane is a child of this one element, keyed,
            in the same position, whatever the view — see the file header. ---- */}
        <div className={`tv-stage v-${view}`}>
          {sessions.map((s) => {
            const winOf = wins.find((w) => w.id === s.id);
            const miniAt = minis.findIndex((m) => m.id === s.id);
            const place = view === 'swarm' ? (winOf ? 'win' : 'off')
              : s.id === cur?.id ? 'main' : miniAt >= 0 ? 'mini' : 'off';
            const st = statusOf(s);
            const pinned = isPinned(s);
            const p = projectOf(s);
            const style = place === 'mini' ? { gridColumn: miniAt + 1, gridRow: 2 }
              : place === 'win' && winOf ? {
                left: Math.round(winOf.x), top: Math.round(winOf.y), width: Math.round(winOf.w), height: Math.round(winOf.h),
                zIndex: 30 + Math.min(18, winRank.get(s.id) ?? 0), transition: drag === s.id ? 'none' : undefined,
              } : undefined;
            return (
              <div key={s.id} data-win={place === 'win' ? s.id : undefined}
                className={`tv-pane ${place}${place === 'win' && winOf?.z === topZ ? ' front' : ''}${dropWin === s.id ? ' drop' : ''}`}
                style={style}
                onMouseDown={place === 'win' ? () => focusWin(s.id) : undefined}
                onDragOver={place === 'win' ? (e) => { if (!isTabDrag(e)) return; e.preventDefault(); e.stopPropagation(); if (dropWin !== s.id) { setDropWin(s.id); setSnapPreview(null); } } : undefined}
                onDrop={place === 'win' ? (e) => { if (!isTabDrag(e) || dragTab == null) return; e.preventDefault(); e.stopPropagation(); swapWin(s.id, dragTab); } : undefined}>
                {place === 'main' ? (
                  <div className="tv-head">
                    {projChip(p, 20)}
                    {nameEdit(s, 'pane', 'tv-head-name')}
                    <span className="tv-head-meta">{TOOL[s.cmd].name} · ~/{p || ''} · {s.tmux || 'shell'}</span>
                    <span className={`tv-pill ${s.status === 'live' ? st : s.status === 'connecting' ? 'idle' : 'error'}`}>
                      {s.status === 'live' ? STATUS_LABEL[st] : s.status}
                    </span>
                    {destLabel(s) && <span className={`tv-destchip ${s.branch || s.dest === 'branch' ? 'branch' : 'main'}`} title="Where this session's work goes">{destLabel(s)}</span>}
                    {notice?.id === s.id && <span className="pane-notice">{notice.label}</span>}
                    <span className="tv-head-acts">
                      {(s.status === 'closed' || s.status === 'error') && (
                        <button className="tv-btn sm" onClick={() => handles.current.get(s.id)?.reconnect()}>↻ Reconnect</button>
                      )}
                      <button className="tv-btn sm" aria-label="Reload this pane"
                        title={s.tmux ? `Reload — re-attach ${s.tmux} on a fresh screen. The session itself is untouched.` : 'Repaint this pane'}
                        onClick={() => handles.current.get(s.id)?.reload()}>↻</button>
                      {s.tmux && (
                        <button className={`tv-btn sm${pinned ? ' pinned' : ''}`} aria-pressed={pinned} onClick={() => togglePinSess(s)}
                          title={pinned ? `Pinned — first in its group, and the idle reaper will not take ${s.tmux}` : 'Pin — first in its group, and safe from the idle reaper'}>
                          {pinIcon(11, pinned)}{pinned ? 'Pinned' : 'Pin'}
                        </button>
                      )}
                      <button className="tv-btn sm" onClick={() => closeSession(s.id)}
                        title={view === 'focus' ? 'Close the pane — the session stays in the top bar' : s.tmux ? 'Close — the session keeps running and stays in the bar' : 'Close the tab — a shell ends with it'}>Close tab</button>
                      <button className="tv-btn sm danger" disabled={ending === s.id} onClick={() => askEnd(s)}>{ending === s.id ? 'Ending…' : 'End'}</button>
                    </span>
                  </div>
                ) : null}
                {place === 'mini' ? (
                  <div className="tv-mini-head">
                    <span className={`tv-dot ${st}`} />
                    {projChip(p, 18)}
                    {nameEdit(s, 'pane', 'tv-mini-name')}
                    {s.tmux && (
                      <button className={`tv-ico${pinned ? ' pinned' : ''}`} title={pinned ? 'Unpin' : 'Pin'} onClick={() => togglePinSess(s)}>{pinIcon(11, pinned)}</button>
                    )}
                    <button className="tv-ico" title="Move to main" onClick={() => setActive(s.id)}>⤢</button>
                    <button className="tv-ico" title="Close — the session keeps running and stays in the bar" onClick={() => closeSession(s.id)}>×</button>
                    <button className="tv-btn xs danger" disabled={ending === s.id} title="End this session" onClick={() => askEnd(s)}>{ending === s.id ? 'Ending…' : 'End'}</button>
                  </div>
                ) : null}
                {place === 'win' && winOf ? (
                  <>
                    {handlesFor(s.id)}
                    <div className={`tv-win-head${drag === s.id ? ' dragging' : ''}`} onMouseDown={(e) => startWinDrag(e, s.id)}
                      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button')) toggleMax(s.id); }}
                      title="Drag to move · drag to an edge or corner to snap · double-click to maximise">
                      <span className={`tv-dot ${st}`} />
                      {projChip(p, 18)}
                      {nameEdit(s, 'pane', 'tv-win-name')}
                      <span className="tv-win-meta">{TOOL[s.cmd].name}{destLabel(s) ? ` · ${destLabel(s)}` : ''}</span>
                      <span className="tv-head-acts">
                        {s.tmux && (
                          <button className={`tv-ico${pinned ? ' pinned' : ''}`} title={pinned ? 'Unpin' : 'Pin'} onClick={() => togglePinSess(s)}>{pinIcon(11, pinned)}</button>
                        )}
                        <span className="tv-rel">
                          <button className={`tv-btn sm${openIn === s.id ? ' on' : ''}`} onClick={() => setOpenIn(openIn === s.id ? null : s.id)}>
                            Open in<span className="caret">▼</span>
                          </button>
                          {openIn === s.id && (
                            <span className="tv-pop tv-openin">
                              <button onClick={() => { closeWin(s.id); setActive(s.id); setView('focus'); }}>
                                <span className="n">Open in Focus</span><span className="s">Full screen, one session</span>
                              </button>
                              <button onClick={() => { closeWin(s.id); setActive(s.id); setView('split'); }}>
                                <span className="n">Open in Main + 3</span><span className="s">Large terminal, others beside it</span>
                              </button>
                            </span>
                          )}
                        </span>
                        <button className="tv-btn sm danger" onClick={() => askEnd(s)}>End</button>
                        <button className="tv-ico" aria-label="Close window" title="Close the window — the tab stays open" onClick={() => closeWin(s.id)}>×</button>
                      </span>
                    </div>
                  </>
                ) : null}
                <TermSession key="term" sess={s} visible={place !== 'off'}
                  focused={place === 'main' ? s.id === active : place === 'win' ? winOf?.z === topZ : false}
                  /* The small panes get a smaller face so a useful number of rows and
                     columns fit; the big one keeps the full size. */
                  fontSize={place === 'mini' ? 10 : place === 'win' ? 12 : undefined}
                  onStatus={(stt, note) => setStatus(s.id, stt, note)}
                  onUsage={setUsage}
                  onTmux={(name) => noteTmux(s.id, s.cwd, name)}
                  onBranch={(branch, project) => setSessions((c) => c.map((x) => (x.id === s.id ? { ...x, branch, project: project || x.project } : x)))}
                  onModel={(mdl) => setSessions((c) => c.map((x) => (x.id === s.id ? { ...x, model: mdl, cmd: mdl?.key === 'codex' ? 'codex' : mdl?.key === 'anthropic' || mdl?.key === 'omniroute' ? 'claude' : x.cmd } : x)))}
                  onSid={(sid) => setSessions((c) => c.map((x) => (x.id === s.id ? { ...x, sid } : x)))}
                  onExit={(name) => noteTmuxEnded(s.cwd, name)}
                  onOutput={(bytes) => noteOutput(s.id, bytes)}
                  onTyped={(text) => noteTyped(s.id, text)}
                  onNotice={(label, ms) => noteNotice(s.id, label, ms)}
                  register={(h) => { if (h) handles.current.set(s.id, h); else handles.current.delete(s.id); }} />
                {place === 'main' ? (
                  <div className="tv-foot">
                    {s.cmd === 'claude' && skipPerms && <span className="danger">›› bypass permissions on</span>}
                    {s.cmd === 'codex' && <span className="danger">›› approvals and sandbox off</span>}
                    <span className="note" title={s.note}>{s.status === 'live' ? '' : s.note}</span>
                    <span className="right">
                      <ModelChip model={s.cmd === 'codex' && (!s.model || s.model.id === 'native')
                        ? { key: 'codex', id: s.codexModel || 'native', label: 'Codex' } : s.model}
                        resolved={s.resolvedModel || (s.tmux ? resolvedByTmux.get(s.tmux) : '')}
                        show={s.cmd !== 'shell'} />
                      {s.cmd === 'claude' && usedTokens > 0 && <span title="Fresh tokens today across this host's Claude sessions — the daemon has no per-session count">{fmtTok(usedTokens)} today</span>}
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })}

          {view !== 'swarm' && !cur && (
            <div className="tv-none">
              <span className="h">{sessions.length ? 'No session selected' : 'No tabs open'}</span>
              <span className="d">{sessions.length ? 'Select a session from the top bar to reopen it.' : 'Open a session from Swarm, or start a new one.'}</span>
              <span className="row">
                <button className="tv-btn" onClick={() => setView('swarm')}>Open Swarm</button>
                <button className="tv-go solo" onClick={() => openSession()} title={`Open ${startLabel}`}>New session</button>
              </span>
            </div>
          )}
          {view === 'split' && cur && Array.from({ length: Math.max(0, 3 - minis.length) }, (_, i) => (
            <button key={`new-${i}`} className="tv-newcell" style={{ gridColumn: minis.length + i + 1, gridRow: 2 }}
              onClick={() => openSession()} title={`Open ${startLabel}`}>
              <span className="plus">+</span><span className="l">New session</span><span className="d">{startLabel}</span>
            </button>
          ))}

          {view === 'swarm' && (
            <div className="tv-swarm" onDragOver={onSwarmDragOver} onDrop={onSwarmDrop}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setSnapPreview(null); }}>
              <div className="tv-swarm-head">
                <span className="tv-counts">
                  {allTiles.length} sessions · <span className="asking">{askingCount} asking</span> · <span className="working">{workingCount} working</span>
                </span>
                <span className="tv-hint">{wins.length ? 'Drag a window to an edge to split, a corner to quarter' : 'Hover to read · click to open · drag to reorder · drag a tab here to open it as a window'}</span>
                <span className="tv-rel">
                  <button className={`tv-btn tv-icon${gridMenu ? ' on' : ''}`} title="Grid size" aria-label="Grid size" onClick={() => setGridMenu((v) => !v)}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="2.3" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></svg>
                  </button>
                  {gridMenu && (
                    <>
                      <div className="tv-scrim" onClick={() => setGridMenu(false)} />
                      <div className="tv-pop tv-gridmenu">
                        <span className="eyebrow">Swarm grid</span>
                        {GRID_OPTS.map((g) => (
                          <button key={`${g.c}x${g.r}`} className={`tv-gridopt${grid.c === g.c && grid.r === g.r ? ' on' : ''}`}
                            onClick={() => { saveViewPrefs({ grid: { c: g.c, r: g.r } }); setGridMenu(false); }}>
                            <span className="l">{g.c}×{g.r}</span><span className="n">{g.note}</span><span className="t">{g.c * g.r} tiles</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </span>
                {cap - tiles.length > 0 && (
                  <button className="tv-go solo sm" title="Start a new session in every empty slot, using your defaults"
                    onClick={() => setFillAsk(cap - tiles.length)}>Fill {cap - tiles.length} empty</button>
                )}
                {tiles.length > 0 && (
                  <button className="tv-btn sm" title="Hide every tile from Swarm (sessions keep running)"
                    onClick={() => { setHidden([...new Set([...hidden, ...allTiles.map((t) => t.key)])]); setWins([]); setTilePeek(null); }}>Hide all</button>
                )}
                {hiddenCount > 0 && (
                  <button className="tv-btn sm" title="Bring hidden sessions back into Swarm" onClick={() => setHidden([])}>Show {hiddenCount} hidden</button>
                )}
                {tiles.length > 1 && <button className="tv-btn sm" title="Asking first, then failed, working, idle" onClick={sortByStatus}>Sort by status</button>}
                {wins.length > 0 && (
                  <>
                    <button className="tv-btn sm" onClick={tileAllWins}>Tile {wins.length} window{wins.length === 1 ? '' : 's'}</button>
                    <button className="tv-btn sm" onClick={() => { setWins([]); setOpenIn(null); }}>Close all</button>
                  </>
                )}
              </div>
              <div className="tv-grid" ref={swarmBodyRef}
                style={{ gridTemplateColumns: `repeat(${grid.c}, minmax(0,1fr))`, gridTemplateRows: `repeat(${grid.r}, minmax(0,1fr))` }}>
                {tiles.map((t) => {
                  const hov = tilePeek === t.key;
                  const lines = hov ? peekOf(t) : [];
                  const last = hov ? '' : (t.sess ? linesOf(t) : t.det?.preview || []).filter((l) => l.trim()).slice(-1)[0] || '';
                  const openId = t.sess?.id;
                  return (
                    <div key={t.key}
                      className={`tv-tile${hov ? ' hov' : ''}${compact ? ' compact' : ''}${flash === t.key ? ' flash' : ''}${dropOn === t.key && dragTile !== t.key ? ' drop' : ''}${dragTile === t.key ? ' dragging' : ''} p-${projTint(t.project)}`}
                      draggable
                      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-stack-tile', t.key); setDragTile(t.key); setTilePeek(null); }}
                      onDragEnd={() => { setDragTile(null); setDropOn(null); }}
                      onDragOver={(e) => { if (!dragTile) return; e.preventDefault(); if (dropOn !== t.key) setDropOn(t.key); }}
                      onDrop={(e) => { if (!dragTile) return; e.preventDefault(); e.stopPropagation(); setTileOrder(moveKey(shownTiles.map((x) => x.key), dragTile, t.key)); setDragTile(null); setDropOn(null); }}
                      onClick={() => openTile(t)}
                      onMouseEnter={() => setTilePeek(t.key)}
                      onMouseLeave={() => setTilePeek((k) => (k === t.key ? null : k))}
                      title={`${t.name} — click to open it as a window`}>
                      <div className="tv-tile-top" />
                      {!hov ? (
                        <div className="tv-tile-face">
                          <div className="tv-tile-row">
                            {compact && projChip(t.project, 14)}
                            <span className={`tv-dot ${t.st}`} />
                            <span className={`tv-st ${t.st}`}>{STATUS_LABEL[t.st]}</span>
                            <span className="ago">{t.ago}</span>
                            {t.pinned && <span className="tv-pinmark">{pinIcon()}</span>}
                          </div>
                          <span className="tv-tile-name">{t.name}</span>
                          {!compact && (
                            <span className="tv-tile-proj">{projChip(t.project)}{t.project || '~'} · {TOOL[t.cmd].name}{t.sess ? '' : ' · not open'}</span>
                          )}
                          {!compact && last && <span className="tv-tile-last">{last}</span>}
                        </div>
                      ) : (
                        <div className="tv-tile-peek" onClick={(e) => e.stopPropagation()}>
                          <div className="tv-tile-row">
                            <span className={`tv-dot ${t.st}`} />
                            {projChip(t.project)}
                            <span className="tv-tile-pname">{t.name}</span>
                            {(t.sess?.tmux || t.det) && (
                              <button className={`tv-ico${t.pinned ? ' pinned' : ''}`} title={t.pinned ? 'Unpin' : 'Pin'}
                                onClick={() => (t.sess ? togglePinSess(t.sess) : t.det && void togglePin(t.det.name, !t.det.keep))}>{pinIcon(11, t.pinned)}</button>
                            )}
                            <button className="tv-btn xs" title="Hide from Swarm (keeps running)" onClick={() => hideTile(t.key, openId)}>Hide</button>
                            <button className="tv-btn xs danger" disabled={!!t.det?.attached && !t.sess}
                              title={t.det?.attached && !t.sess ? 'Attached on another device — end it there, or open it here first' : 'End this session'}
                              onClick={() => askEnd(t.sess, t.sess ? undefined : t.det)}>End</button>
                          </div>
                          <div className="tv-tile-lines" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}
                            onClick={() => openTile(t)}>
                            {lines.length ? lines.map((l, i) => (
                              <div key={i}>{l.length ? l.map((g, j) => (
                                <span key={j} className={g.b ? 'b' : g.d ? 'd' : undefined} style={g.c ? { color: g.c } : undefined}>{g.t}</span>
                              )) : ' '}</div>
                            ))
                              : <div className="dim">Nothing captured yet. Click to open it.</div>}
                          </div>
                          {t.st === 'asking' && !compact && (
                            <div className="tv-reply">
                              <input value={replies[t.key] || ''} placeholder="Reply…" aria-label={`Reply to ${t.name}`}
                                onChange={(e) => { const v = e.target.value; setReplies((r) => ({ ...r, [t.key]: v })); }}
                                onKeyDown={(e) => { if (e.key === 'Enter') sendReply(t); }} />
                              <button className="tv-go solo xs" onClick={() => sendReply(t)}>Send</button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {Array.from({ length: Math.max(0, cap - tiles.length) }, (_, i) => (
                  <button key={`e${i}`} className={`tv-newcell${dropOn === 'end' ? ' drop' : ''}`}
                    onClick={() => openSession()} title={`Open ${startLabel}`}
                    onDragOver={(e) => { if (!dragTile) return; e.preventDefault(); if (dropOn !== 'end') setDropOn('end'); }}
                    onDrop={(e) => { if (!dragTile) return; e.preventDefault(); e.stopPropagation(); setTileOrder(moveKey(shownTiles.map((x) => x.key), dragTile, null)); setDragTile(null); setDropOn(null); }}>
                    <span className="plus">+</span><span className="l">New session</span>
                  </button>
                ))}
              </div>
              {shownTiles.length > cap && (
                <div className="tv-more">{shownTiles.length - cap} more not shown at {grid.c}×{grid.r} — a bigger grid, Hide, or the {sessions.length} ▼ switcher reaches them.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>

    {view === 'swarm' && snapPreview && visible && (
      <div className="tv-snap" style={{ left: snapPreview.x, top: snapPreview.y, width: snapPreview.w, height: snapPreview.h }} />
    )}

    {visible && menu && (() => {
      const pd = menu.det ? detached.find((x) => x.name === menu.det) : undefined;
      if (pd) {
        return (
          <div className="tv-scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
            <div className="tv-pop tv-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
              <button onClick={() => { openParked(pd); setMenu(null); }}>Open</button>
              <button onClick={() => { void togglePin(pd.name, !pd.keep); setMenu(null); }}>{pd.keep ? 'Unpin' : 'Pin'}</button>
              <div className="tv-rule" />
              <button className="danger" disabled={!!pd.attached}
                title={pd.attached ? 'Open on another device — end it there, or open it here first' : undefined}
                onClick={() => askEnd(undefined, pd)}>End session</button>
            </div>
          </div>
        );
      }
      const s = sessions.find((x) => x.id === menu.id);
      if (!s) return null;
      const key = s.tmux || `tab:${s.id}`;
      const isHidden = hidden.includes(key);
      return (
        <div className="tv-scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
          <div className="tv-pop tv-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
            {s.tmux && <button onClick={() => { togglePinSess(s); setMenu(null); }}>{isPinned(s) ? 'Unpin' : 'Pin tab'}</button>}
            <button onClick={() => { closeSession(s.id); setMenu(null); }}>Close tab</button>
            <button onClick={() => { setHidden(isHidden ? hidden.filter((k) => k !== key) : [...hidden, key]); if (!isHidden) closeWin(s.id); setMenu(null); }}>
              {isHidden ? 'Show in Swarm' : 'Hide from Swarm'}
            </button>
            <button onClick={closeUnpinned}>Close unpinned tabs</button>
            <button onClick={() => { startRename(s, 'tab'); setMenu(null); }}>Rename…</button>
            <div className="tv-rule" />
            <button className="danger" onClick={() => askEnd(s)}>End session</button>
          </div>
        </div>
      );
    })()}

    {visible && usageOpen && (() => {
      const m = meterOf(usageOpen.key);
      const win = (label: string, w: LimWin | null) => (w ? (
        <div className="tv-uwin" key={label}>
          <span className="t"><span className="l">{label}</span><span className={`p ${tone(w.pct)}`}>{Math.round(w.pct)}%</span></span>
          <span className="bar"><span className={`v ${tone(w.pct)}`} style={{ width: `${Math.min(100, w.pct)}%` }} /></span>
          <span className="s">{w.resetAt ? `resets ${fmtReset(w.resetAt, true)} · ${fmtIn(w.resetAt)}` : 'no reset reported'}</span>
        </div>
      ) : (
        <div className="tv-uwin" key={label}><span className="t"><span className="l">{label}</span><span className="p">—</span></span><span className="s">not measured</span></div>
      ));
      const mine = sessions.filter((s) => s.cmd === m.key);
      return (
        <div className="tv-scrim" onClick={() => setUsageOpen(null)}>
          <div className={`tv-pop tv-usage k-${m.key}`} style={{ left: usageOpen.x }} onClick={(e) => e.stopPropagation()}>
            <span className="h"><span className="n">{m.name} usage</span><span className="dim">{mine.length} open here</span></span>
            {win(m.key === 'claude' ? 'Session · 5-hour window' : 'Session window', m.session)}
            {win('Weekly', m.week)}
            {m.extra.map((x) => win(x.name, x.w))}
            {m.key === 'claude' ? (
              <div className="tv-ustats">
                <span><span className="k">Fresh today</span><span className="v">{usedTokens > 0 ? fmtTok(usedTokens) : '—'}</span></span>
                <span><span className="k">Incl. cache reads</span><span className="v">{usage?.totalTokens ? fmtTok(usage.totalTokens) : '—'}</span></span>
                <span><span className="k">Run budget</span><span className="v">{serverUsage && serverUsage.tokenBudget > 0 ? fmtTok(serverUsage.tokenBudget) : 'none'}</span></span>
              </div>
            ) : (
              <span className="tv-dim">Codex reports its limit windows only; Stack has no token count for it.</span>
            )}
            <span className="tv-dim">Per-model and per-session splits are not measured on this host, so they are not drawn.</span>
          </div>
        </div>
      );
    })()}

    {visible && switcher && (
      <div className="tv-scrim" onClick={() => { setSwitcher(false); setQ(''); }}>
        <div className="tv-pop tv-switcher" onClick={(e) => e.stopPropagation()}>
          <div className="find"><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a session…" aria-label="Find a session" /></div>
          <div className="list">
            {swGroups.map((g) => (
              <div key={g.title}>
                <div className="gh"><span className="eyebrow">{g.title}</span><span className="n">{g.rows.length}</span></div>
                {g.rows.map((r) => (
                  <button key={r.key} className={`row${r.on ? ' on' : ''}`} onClick={r.pick}>
                    <span className={`tv-dot ${r.st}`} />
                    {projChip(r.project)}
                    <span className="nm">{r.name}</span>
                    {r.pinned && <span className="tv-pinmark">{pinIcon()}</span>}
                    <span className={`tv-st ${r.st}`}>{STATUS_LABEL[r.st]}</span>
                  </button>
                ))}
              </div>
            ))}
            {!swGroups.length && <span className="empty">{hostConnected === false ? 'Stack cannot see the host right now.' : 'No sessions match.'}</span>}
          </div>
        </div>
      </div>
    )}

    {endAllAsk && (
      <ConfirmModal
        title={`End all ${endAllCount} session${endAllCount === 1 ? '' : 's'}?`}
        body={<>Every tab here and every session idling on the host is killed, whatever it is doing.
          {endAllKept > 0 && <> {endAllKept} pinned session{endAllKept === 1 ? ' is' : 's are'} kept; unpin {endAllKept === 1 ? 'it' : 'them'} to end {endAllKept === 1 ? 'it' : 'them'} too.</>}
          {' '}Unattended runs (stack-auto) are never touched from here.</>}
        confirmLabel={`End ${endAllCount}`}
        danger
        onConfirm={() => void doEndAll()}
        onCancel={() => setEndAllAsk(false)}
      />
    )}
    {fillAsk > 0 && (
      <ConfirmModal
        title={`Start ${fillAsk} new ${TOOL[mode].name} session${fillAsk === 1 ? '' : 's'}?`}
        body={<>One for every empty slot, each in <b>~/{cwd.trim()}</b>{mode !== 'shell' ? <> on {modelName(mode)}, with work going to <b>{defs.dest === 'branch' ? 'its own branch' : 'main'}</b></> : null}. Every one is a real process on the host.</>}
        confirmLabel={`Start ${fillAsk}`}
        onConfirm={() => fillEmpty(fillAsk)}
        onCancel={() => setFillAsk(0)}
      />
    )}
    </>
  );
}

// One tab: an xterm instance + its websocket, kept mounted (hidden when
// inactive) so the scrollback survives tab switches.
function TermSession({ sess, visible, focused, fontSize, onStatus, onUsage, onTmux, onBranch, onModel, onSid, onExit, onOutput, onTyped, onNotice, register }: {
  sess: { codexModel?: string; claudeModel?: string; dest?: TermDest; id: number; cwd: string; cmd: 'shell' | 'claude' | 'codex'; tmux?: string };
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
  // The session's own branch, when the host started it in a worktree.
  onBranch: (branch: string, project: string) => void;
  // #503 — what the host says this session is running on. Arrives on the ready
  // frame, and again on a 'model' frame if a usage-limit switch-over moves it.
  onModel: (m: SessionModel | null) => void;
  onSid: (sid: string) => void;
  onExit: (tmuxName: string | null) => void;
  // Bytes this session has emitted. Read for ONE purpose: holding the fallback
  // naming back until there is something worth naming — see NAME_AFTER_BYTES.
  // Nothing re-asks off the back of it; the counter only ever opens the gate.
  onOutput: (bytes: number) => void;
  // #512 — THE FIRST THING THE HUMAN SENT THIS SESSION, which is its name.
  // Fires at most once per session (lib/termName latches), so the parent may
  // treat it as an assignment rather than a stream.
  onTyped: (text: string) => void;
  // A finished gesture, already worded and already glyphed — "⧉ copied 12
  // lines", "📎 shot.png → path typed". With a canvas and no browser selection
  // to look at, "did that work?" is otherwise unanswerable, so the pane says
  // so. `ms` is how long it is worth reading for.
  onNotice: (label: string, ms?: number) => void;
  register: (h: Handle | null) => void;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const beforeFitRef = useRef<((apply: () => void) => void) | null>(null);
  const fitQueuedRef = useRef(false);
  // Tmux session name for claude tabs (shell never uses tmux): seeded from the
  // parent (a detached-session chip or the device-local cwd map, #188), then
  // confirmed/assigned by the daemon's first ready frame. Passed in the start
  // frame so the daemon re-attaches to the surviving session instead of
  // spawning a new one.
  const tmuxRef = useRef<string | null>(sess.tmux ?? null);
  // #512 — the pending first line, and the latch that makes it the only one.
  // A REF, not state: it changes on every keystroke and nothing renders it, so
  // making it state would re-render a terminal grid on every character typed.
  const typedRef = useRef(newCapture());
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
    if (el.clientWidth < 2 || el.clientHeight < 2 || fitQueuedRef.current) return;
    fitQueuedRef.current = true;
    const apply = () => {
      fitQueuedRef.current = false;
      if (fitRef.current !== fit || holderRef.current !== el || el.clientWidth < 2 || el.clientHeight < 2) return;
      try { fit.fit(); } catch { /* mid-teardown; the next observation refits */ }
    };
    if (beforeFitRef.current) beforeFitRef.current(apply);
    else apply();
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
    const unwireClipboard = wireTermClipboard(term, (label) => onNotice(`⧉ ${label}`));

    // #513 — DRAG A FILE ONTO THIS PANE AND ITS PATH IS TYPED INTO THE SESSION,
    // which is what dropping a screenshot on a native terminal does and the
    // only way to hand a claude tab an image. The bytes go to the host on this
    // session's own socket, the host writes them and answers with a path
    // (terminal/drop-file.mjs), and the reply handler above types it.
    //
    // Three things about the gesture rather than the transfer:
    //
    //  • The listeners sit on the HOLDER, not the document: with six panes on
    //    screen the drop has to mean "this session", and the pane under the
    //    cursor is the only thing that can say which.
    //  • dragenter/dragleave are COUNTED. They fire for every child element
    //    the cursor crosses — and xterm's element is a stack of them — so a
    //    single drag over one pane raises and lowers the highlight a dozen
    //    times unless the depth is tracked.
    //  • A drag carrying no files is left entirely alone: no preventDefault,
    //    no highlight. Text dragged out of the page, and every draggable row
    //    Stack has, would otherwise be swallowed by whichever pane was open.
    const pendingDrops = new Map<number, string>();
    let dropSeq = 0;
    let dragDepth = 0;
    const setDropping = (on: boolean) => holderRef.current?.classList.toggle('dropping', on);
    const sendDrops = async (files: File[]) => {
      for (const file of files) {
        if (file.size > DROP_MAX_BYTES) {
          onNotice(`📎 ${file.name} is over the ${dropSizeLabel()} drop limit`, 5000);
          continue;
        }
        // Read, then re-check the socket: reading a 10 MB file is not
        // instant, and a pane closed in between must not send into a dead one.
        onNotice(`📎 sending ${file.name}…`, 60_000);
        let data: string;
        try {
          data = await fileToBase64(file);
        } catch {
          onNotice(`📎 could not read ${file.name}`, 5000);
          continue;
        }
        const live = wsRef.current;
        if (live?.readyState !== WebSocket.OPEN) {
          onNotice('📎 this session is not connected', 5000);
          return;
        }
        const id = ++dropSeq;
        pendingDrops.set(id, file.name);
        live.send(JSON.stringify({ t: 'drop', id, name: file.name, mime: file.type || '', data }));
      }
    };
    const onDragEnter = (ev: DragEvent) => {
      if (!isFileDrag(ev.dataTransfer)) return;
      ev.preventDefault();
      dragDepth++;
      setDropping(true);
    };
    const onDragOver = (ev: DragEvent) => {
      if (!isFileDrag(ev.dataTransfer)) return;
      // Without this the browser refuses the drop and navigates to the file.
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (ev: DragEvent) => {
      if (!isFileDrag(ev.dataTransfer)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) setDropping(false);
    };
    const onDropFiles = (ev: DragEvent) => {
      if (!isFileDrag(ev.dataTransfer)) return;
      ev.preventDefault();
      dragDepth = 0;
      setDropping(false);
      const files = filesFrom(ev.dataTransfer);
      if (files.length) void sendDrops(files);
    };
    const holderEl = holderRef.current;
    holderEl?.addEventListener('dragenter', onDragEnter);
    holderEl?.addEventListener('dragover', onDragOver);
    holderEl?.addEventListener('dragleave', onDragLeave);
    holderEl?.addEventListener('drop', onDropFiles);

    // #518 — A PANE THAT FROZE WAS A SOCKET THAT DIED WITHOUT SAYING SO. This
    // listened for 'error' and never for 'close', so when the relay went away
    // (the server redeploys on every push to main) or a restarted daemon left
    // the relay holding sockets nothing would write to again, the pane stayed
    // "live" and simply stopped moving — with no Reconnect button either,
    // because that only shows on closed/error. Now a close nobody asked for is
    // noticed, and a claude pane RE-ATTACHES its tmux session on its own: the
    // session lives on the host and survives all of the above, so re-attaching
    // is always safe and never a restart. A shell has no tmux behind it — its
    // PTY died with the socket — so it says so and waits for ↻ Reconnect,
    // because reconnecting a shell is starting a new one.
    let disposed = false;
    let ended = false;          // the process really exited — never re-attach
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const reattachable = () => sess.cmd !== 'shell' && !!tmuxRef.current;
    let writes: ReturnType<typeof createTermWrites> | undefined;
    // Parse bytes drawn for the old grid before changing it. xterm.write is
    // asynchronous, so flushing our frame queue alone is not a parser barrier.
    beforeFitRef.current = (apply) => {
      writes?.flush();
      term.write('', () => { if (!disposed) apply(); });
    };
    const sizes = createTermSizeSender((cols, rows) => {
      const ws = wsRef.current;
      if (disposed || ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify({ t: 'resize', cols, rows }));
      return true;
    });
    // Fit and host resize happen in the same turn. A TUI's cursor movements
    // cannot be interpreted reliably against two different grids for 80ms.
    const gridResize = term.onResize(({ cols, rows }) => sizes.update(cols, rows));

    const connect = () => {
      clearTimeout(retryTimer);
      ended = false;
      writes?.dispose();
      wsRef.current?.close();
      wsRef.current = null;
      // Queue the reset behind any writes xterm already accepted, and ahead
      // of the new tmux redraw. A synchronous reset can be overtaken by its
      // asynchronous parser; leaving old modes alive corrupts a fresh attach.
      if (reattachable()) term.write('\x1bc');
      sidRef.current = null;
      onStatus('connecting', retries ? `connection lost — re-attaching (${retries})` : '');
      safeFit();
      const ws = openTerminal({
        codexModel: sess.codexModel, claudeModel: sess.claudeModel, dest: sess.dest,
        cwd: sess.cwd, cmd: sess.cmd, cols: term.cols, rows: term.rows,
        tmuxSession: sess.cmd !== 'shell' && tmuxRef.current ? tmuxRef.current : undefined,
        // Device pref (Settings → Terminal): claude without permission prompts.
        // A boolean only — the daemon maps it to its one allow-listed flag.
        skipPerms: sess.cmd === 'claude' && getTermSessionPrefs().skipPermissions ? true : undefined,
        // #525 — a board card's first prompt, when one was queued for this name.
        brief: sess.cmd !== 'shell' && tmuxRef.current ? peekTermLaunch(tmuxRef.current) : undefined,
      });
      wsRef.current = ws;
      sizes.seed(term.cols, term.rows); // the start frame carries these
      ws.addEventListener('open', () => {
        if (!disposed && ws === wsRef.current) sizes.update(term.cols, term.rows);
      });
      const output = createTermWrites((data) => term.write(data), () => !disposed && ws === wsRef.current);
      writes = output;

      ws.addEventListener('message', (ev) => {
        if (disposed || ws !== wsRef.current) return;
        let m: {
          t: string; data?: string; msg?: string; code?: number; cwd?: string;
          // The relay multiplexes by sid and forwards the daemon's frames
          // whole, so every frame carries it — that is how a tab learns the
          // one id the labeller keys on.
          sid?: string;
          tmuxSession?: string; branch?: string; project?: string;
          model?: SessionModel | null;
          tokens?: number; resetAt?: number; resetLabel?: string; sched?: { runDate: string; atTime: string };
          totalTokens?: number; plan?: TermUsage['plan']; codex?: TermUsage['codex'];
          // #513 — the answer to one 'drop': the host's path for the file, or
          // why it has none. `id` is this pane's own counter, echoed back.
          id?: number; ok?: boolean; path?: string; name?: string; error?: string;
        };
        try { m = JSON.parse(ev.data); } catch { return; }
        // Every frame carries the relay's sid, so the first one names this tab
        // for the labeller — including shells, which have no tmux name.
        if (typeof m.sid === 'string' && m.sid && !sidRef.current) { sidRef.current = m.sid; onSid(m.sid); }
        if (m.t === 'out' && m.data) {
          output.push(b64decode(m.data));
          onOutput(m.data.length);
        }
        else if (m.t === 'usage' && typeof m.tokens === 'number') {
          onUsage({ tokens: m.tokens, totalTokens: m.totalTokens, resetAt: m.resetAt, resetLabel: m.resetLabel, sched: m.sched, plan: m.plan, codex: m.codex });
        }
        else if (m.t === 'ready') {
          retries = 0;
          if (m.tmuxSession) { tmuxRef.current = m.tmuxSession; onTmux(m.tmuxSession); clearTermLaunch(m.tmuxSession); }
          if (typeof m.branch === 'string' && m.branch) onBranch(m.branch, typeof m.project === 'string' ? m.project : '');
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
          output.flush();
          ended = true;
          onExit(tmuxRef.current);
          tmuxRef.current = null;
          onStatus('closed', `exited (${m.code})`);
          term.write('\r\n\x1b[90m[session ended — reconnect from the tab bar]\x1b[0m\r\n');
        }
        // #513 — the host has written (or refused) a dropped file. On a good
        // answer the PATH is typed here, down the same 'in' frame a keystroke
        // takes: that is the whole gesture, and doing it on the reply rather
        // than optimistically means the pane never shows a path that does not
        // exist. It deliberately does not go through term.onData, so a dropped
        // path can never become the session's name (#512) — a name is what the
        // human wrote, and this is a filename the host chose.
        else if (m.t === 'dropped') {
          const asked = (typeof m.id === 'number' ? pendingDrops.get(m.id) : '') || m.name || 'that file';
          if (typeof m.id === 'number') pendingDrops.delete(m.id);
          if (m.ok && m.path) {
            const live = wsRef.current;
            if (live?.readyState === WebSocket.OPEN) {
              live.send(JSON.stringify({ t: 'in', data: b64encode(pathAsInput(m.path)) }));
            }
            onNotice(`📎 ${m.name || asked} → path typed`, 3200);
            if (focused) term.focus();
          } else {
            onNotice(`📎 ${asked}: ${m.error || 'the host refused that drop'}`, 5000);
          }
        }
        else if (m.t === 'err') { output.flush(); onStatus('error', m.msg || 'terminal error'); term.write(`\r\n\x1b[91m${m.msg || 'terminal error'}\x1b[0m\r\n`); }
      });
      ws.addEventListener('error', () => {
        if (!disposed && ws === wsRef.current) onStatus('error', 'Could not reach the terminal relay.');
      });
      ws.addEventListener('close', () => {
        // Ours (a reconnect replaced it, or the pane is going) or a real end.
        if (disposed || ended || ws !== wsRef.current) return;
        output.flush();
        if (!reattachable()) {
          onStatus('closed', 'connection lost');
          term.write('\r\n\x1b[90m[connection lost — this shell ended with it; ↻ Reconnect starts a new one]\x1b[0m\r\n');
          return;
        }
        // Backed off, and bounded: six tries is about half a minute, which
        // covers a redeploy. Past that something is genuinely down and the
        // pane says so, with ↻ Reconnect, rather than hammering the relay.
        if (retries >= 6) { onStatus('closed', 'connection lost — ↻ Reconnect to try again'); return; }
        retries++;
        onStatus('connecting', `connection lost — re-attaching (${retries})`);
        retryTimer = setTimeout(connect, Math.min(15_000, 500 * 2 ** (retries - 1)));
      });
    };
    connect();

    // #518 — THE RELOAD. A pane can also freeze with its socket perfectly
    // alive: a GL context the browser took away mid-frame, a renderer wedged
    // after sleep. So the reload rebuilds the PAINTING as well as the pipe —
    // renderer detached and re-attached, screen cleared, grid refitted — and
    // then re-attaches, and tmux redraws the whole session into the clean
    // screen. Only when it can re-attach: clearing a SHELL's screen loses what
    // is on it (nothing redraws a shell), and reconnecting one kills it, so a
    // live shell gets the repaint alone and a dead one a fresh start.
    const repaint = () => {
      detachRenderer();
      detachRenderer = attachRenderer(term, (why) => console.info(`[term ${sess.id}] ${why}`));
      safeFit();
      term.refresh(0, term.rows - 1);
    };
    const reload = () => {
      retries = 0;
      const open = wsRef.current?.readyState === WebSocket.OPEN;
      if (reattachable()) {
        repaint();
        connect();
      } else if (open) {
        repaint();
      } else {
        connect();
      }
      if (focused) term.focus();
    };

    // #518 — COMING BACK TO THE TAB. A socket that died while the tab slept
    // is re-attached the moment it is looked at, not on the next backoff tick;
    // and after a long absence (a laptop lid, a night) a claude pane
    // re-attaches even if its socket CLAIMS to be open, because a half-open
    // TCP connection after sleep looks exactly like that and nothing short of
    // a new one can tell. Short tab flicks do nothing.
    let hiddenAt = document.hidden ? Date.now() : 0;
    const onVisibility = () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      if (ended || !reattachable()) return;
      const state = wsRef.current?.readyState;
      if (state !== WebSocket.OPEN && state !== WebSocket.CONNECTING) { retries = 0; connect(); }
      else if (away >= 5 * 60_000) { retries = 0; connect(); }
    };
    const onOnline = () => {
      if (ended || !reattachable()) return;
      if (wsRef.current?.readyState !== WebSocket.OPEN) { retries = 0; connect(); }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);

    // #512 — the name is taken HERE, off the keystrokes on their way to the
    // socket, because this is the only place the human's own words exist in
    // this app at all. Everything else on this screen reads OUTPUT.
    //
    // It rides the send rather than replacing it: the capture is pure, cannot
    // throw on anything a keyboard produces, and sees a copy of a string the
    // handler already holds — so a session cannot fail to type because its
    // name failed to parse. `noteTyped` latches after the first submit, so
    // this is a dead call for the whole life of a session past its first line.
    const noteTyped = (d: string) => {
      const name = feedTyped(typedRef.current, d);
      if (name) onTyped(name);
    };
    // Input goes out immediately — no batching on the keypress path. #135
    const data = term.onData((d) => {
      noteTyped(d);
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', data: b64encode(d) }));
    });
    // Debounce the FIT itself, so xterm and the host keep the same grid
    // throughout a drag. Defer out of ResizeObserver before mutating layout.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let fitFrame: number | undefined;
    const onResize = () => {
      clearTimeout(resizeTimer);
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
      resizeTimer = setTimeout(() => {
        fitFrame = requestAnimationFrame(() => {
          fitFrame = undefined;
          if (!disposed) safeFit();
        });
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
      // ▶ Paste brief comes through here rather than through onData, and it
      // counts: the human picked that item and pressed that button, so the
      // brief's first line is as much "what they wrote" as typing it would
      // have been. It ends with no newline (nothing runs until the human
      // presses Enter), so the name lands on THEIR Enter, through onData.
      sendText: (s) => {
        noteTyped(s);
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', data: b64encode(s) }));
      },
      reconnect: () => { retries = 0; connect(); },
      reload,
      focus: () => term.focus(),
      tail: (n) => {
        const b = term.buffer.active;
        const end = b.baseY + b.cursorY;
        const out: string[] = [];
        for (let i = Math.max(0, end - n * 2); i <= end; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
        return compactLines(out, n);
      },
      peek: (n) => {
        const b = term.buffer.active;
        const end = b.baseY + b.cursorY;
        const theme = term.options.theme || {};
        const cell = b.getNullCell();
        const colourOf = (rgb: boolean, pal: boolean, v: number) =>
          rgb ? `#${v.toString(16).padStart(6, '0')}` : pal ? paletteColour(v, theme) : undefined;
        const rows: PeekSeg[][] = [];
        for (let i = Math.max(0, end - n * 2); i <= end; i++) {
          const line = b.getLine(i);
          const segs: PeekSeg[] = [];
          if (line) {
            for (let x = 0; x < line.length; x++) {
              if (!line.getCell(x, cell) || cell.getWidth() === 0) continue;
              const inv = !!cell.isInverse();
              const c = inv ? colourOf(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor()) || theme.background
                : colourOf(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor());
              const bo = !!cell.isBold(), d = !!cell.isDim();
              const ch = cell.getChars() || ' ';
              const last = segs[segs.length - 1];
              if (last && last.c === c && !!last.b === bo && !!last.d === d) last.t += ch;
              else segs.push({ t: ch, ...(c ? { c } : {}), ...(bo ? { b: true } : {}), ...(d ? { d: true } : {}) });
            }
          }
          rows.push(segs);
        }
        return compactRich(rows, n);
      },
    });

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      register(null);
      clearTimeout(resizeTimer);
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
      writes?.dispose();
      beforeFitRef.current = null;
      fitQueuedRef.current = false;
      fitRef.current = null;
      termRef.current = null;
      gridResize.dispose();
      window.removeEventListener('resize', onResize);
      holderEl?.removeEventListener('dragenter', onDragEnter);
      holderEl?.removeEventListener('dragover', onDragOver);
      holderEl?.removeEventListener('dragleave', onDragLeave);
      holderEl?.removeEventListener('drop', onDropFiles);
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
  }, [fontSize]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refit when this pane becomes visible (it may have been hidden at 0×0).
  useEffect(() => {
    if (!visible) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    safeFit();
    if (focused) term.focus();
  }, [visible, focused]);

  return <div className="term-holder gitbash" ref={holderRef} style={visible ? undefined : { display: 'none' }} />;
}
