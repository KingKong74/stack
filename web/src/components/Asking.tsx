import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { hrefTo, useRoute } from '../lib/route';
import { pickAsking, waitedFor, askingName, diffStops, badgeTitle, notifyText, stopKey, type AskingSession } from '../lib/asking';
import { getDetachedFeed, getAskNotify, setAskNotify, onAskNotifyChange, getAutoRefreshSeconds } from '../store';
import { useAutoRefresh } from '../lib/autoRefresh';
import { NavIcons } from '../detail/ConsoleNav';

// A SESSION THAT HAS STOPPED TO ASK YOU SOMETHING, SAID AWAY FROM THE TERMINAL.
//
// The Terminal screen has always shown this on its own rail — an "N asking"
// badge per tool, a pulsing mark on the row. The problem was everywhere else:
// a claude session stopping mid-run is the most time-sensitive thing Stack
// knows (every second it waits is a second nothing happens), and the only
// surface that said so was the one screen you go to when you already suspect
// it. So it is said in two more places, and lib/asking.ts is the one reader
// behind all of them.
//
// TWO SURFACES, AND THEY DO NOT OVERLAP:
//
//   · `TerminalNavFoot` — the project rail's foot. It has ROOM, so it names
//     each session and how long it has waited, one row each.
//   · `AskingChip` — the topbar, on every screen WITHOUT one of those rails.
//     A count and a popover; the chip decides that for itself off the route
//     rather than taking a prop, because a prop is something six call sites
//     have to keep right and a seventh screen would silently get wrong.
//
// NEITHER ONE ANSWERS THE QUESTION, and that is not an omission. Approving from
// a list is the hazard `POST /api/terminal/answer` exists to be careful about:
// the row was drawn from a pane read up to twenty seconds ago, and in that time
// the session can have been answered at the keyboard and be sitting on a text
// input where the menu was — so "1" becomes a stray digit in somebody's
// message. The Terminal screen's Approve button is above the pane, where you
// can SEE what you are answering. These take you there; they do not type.
//
// AND THEY SAY NOTHING WHEN THERE IS NOTHING TO SAY — no chip, no rows, no "all
// clear". With the host daemon offline the list is empty for a completely
// different reason, and a reader that drew that as good news would be the
// NULL-verdict lie in a new place. lib/asking.ts's header has the rule.

// ---------------------------------------------------------------------------
// The shared poll
// ---------------------------------------------------------------------------
//
// ONE READ FEEDING N SURFACES. Both of the above are mounted together on every
// project screen, so a hook that fetched per caller would double the traffic
// for a fact that is identical in both. Module state, a subscriber set, and a
// publish only when the answer actually CHANGES — a poll over a steady host
// must not re-render the topbar of every screen on every tick.
//
// IT IS A SECOND READER, NOT THE FIRST. The Terminal screen keeps its own copy
// of the same endpoint and must: it mutates it optimistically (pin, kill,
// attach) and needs the sessions that are NOT asking. Both read one route, so
// they cannot disagree about WHO is waiting — only about how recently they
// looked.
//
// AND IT FAILS SILENT (CLAUDE.md's third direction). With no host daemon on the
// line the list is empty, and everything here renders nothing when it is. That
// is the point: absence must never be drawn as good news. Saying "nothing is
// waiting on you" would need GET /api/terminal/agent first, and nothing here
// asks — so nothing here claims it.

const EMPTY: AskingSession[] = [];
let cache: AskingSession[] = EMPTY;
// Not '' — the FIRST read must always publish, even an empty one, because the
// notifier (#519) seeds on it: a first read that happened to match the initial
// key would leave it unseeded, and the next stop would be swallowed as "already
// on screen when the tab opened".
let cacheKey = '\u0000unread';
// Whether any read has landed yet, and whether the host was on the line for
// the last one. `connected` false means an empty list is Stack being BLIND,
// not the host being quiet — the fail-silent rule.
let loaded = false;
let connected: boolean | undefined;
let inflight: Promise<void> | null = null;
let lastAt = 0;
const subs = new Set<(l: AskingSession[]) => void>();

// Two surfaces arm their own interval at their own mount time, so their ticks
// land in the same BEAT rather than at the same instant. The in-flight promise
// catches the instant; this catches the beat.
const MIN_GAP_MS = 3_000;

/** Re-read now, unless a read is already in flight or has just finished. */
function refreshAsking(): Promise<void> {
  if (inflight) return inflight;
  if (Date.now() - lastAt < MIN_GAP_MS) return Promise.resolve();
  inflight = (async () => {
    try {
      const feed = await getDetachedFeed();
      connected = feed.connected;
      const next = pickAsking(feed.sessions);
      const key = next.map((a) => `${a.name}:${a.ask.fingerprint}:${a.ask.since}`).join('|');
      loaded = true;
      if (key !== cacheKey) {
        cacheKey = key;
        cache = next;
        for (const fn of subs) fn(next);
      }
    } catch { /* offline, or a 401 that has already sent us to the gate */ }
    finally { lastAt = Date.now(); inflight = null; }
  })();
  return inflight;
}

/**
 * The sessions waiting on an answer right now. `enabled` is the caller's own
 * gate (this surface is showing at all), the same shape useAutoRefresh takes,
 * and the cadence is Settings → Auto refresh like every other host watcher
 * (#312). With auto refresh OFF this reads once on mount and holds, which is
 * what "off" means everywhere else in the app.
 */
function useAsking(enabled = true, opts: { whileHidden?: boolean } = {}): AskingSession[] {
  const [list, setList] = useState(cache);
  useEffect(() => {
    if (!enabled) return;
    const push = (l: AskingSession[]) => setList(l);
    subs.add(push);
    setList(cache);          // whatever the other surface last read
    void refreshAsking();
    return () => { subs.delete(push); };
  }, [enabled]);
  useAutoRefresh(() => void refreshAsking(), enabled, opts);
  return enabled ? list : EMPTY;
}

/** The pulsing dot every one of these surfaces marks a waiting session with. */
function AskDot() {
  return <span className="ask-dot" aria-hidden="true" />;
}

/**
 * One session, as a row: what it is, and how long it has been stopped.
 *
 * `compact` is the RAIL's shape and it drops the question — not to save space
 * for its own sake, but because 236px of rail truncates a permission question
 * to about four words, and four words of a question you are about to approve
 * is worse than none: it invites the answer without the grounds for it. The
 * rail says WHICH session and HOW LONG, which is all it is for; the popover
 * has the width to carry the question itself, and the pane has all of it.
 */
function AskRow({ a, className, compact, onGo }: {
  a: AskingSession; className: string; compact?: boolean; onGo?: () => void;
}) {
  // `detail` AND NOT `title`: the title is the box's heading ("Edit file",
  // "Bash command"), which you could have guessed from the session, and the
  // detail is the file, the command or the URL — the line that turns "stack is
  // asking permission" into a row worth acting on. The question itself is the
  // fallback, because "Do you want to proceed?" is what every bash prompt in
  // history asks and says nothing on its own.
  const about = a.ask.detail || a.ask.question;
  const waited = waitedFor(a.ask.since);
  return (
    <a className={className} href={hrefTo.terminal(a.cwd, a.name)} onClick={onGo}
      title={`Waiting ${waited}${a.ask.title ? ` — ${a.ask.title}` : ''}\n${a.ask.question}\n${a.ask.detail}\n\nOpens the session; answer it at the pane`}>
      <AskDot />
      <span className="ask-rowtext">
        <span className="ask-rowname">{askingName(a)}</span>
        {!compact && <span className="ask-rowq">{about}</span>}
      </span>
      <span className="ask-age">{waited}</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// The project rail's foot
// ---------------------------------------------------------------------------

/**
 * The rail's Terminal row, plus a row for every session waiting on an answer.
 *
 * NOT SCOPED TO THIS PROJECT. A session asking from another checkout still
 * needs you, and this rail is the only one of the two surfaces showing on a
 * project screen — scoping it would make the app's most urgent fact the one
 * thing you had to be on the right page to see. A row for somewhere else says
 * where it is; a row for here does not, because here is where you are.
 */
export function TerminalNavFoot({ slug }: { slug: string }) {
  const asking = useAsking();
  return (
    <>
      <a className="con-navitem" href={hrefTo.terminal(slug)}>
        <span className="con-navico">{NavIcons.terminal}</span>
        <span className="con-navlabel">Terminal</span>
        {asking.length > 0 && (
          <span className="ask-count" title={`${asking.length} session${asking.length > 1 ? 's' : ''} waiting on an answer`}>
            <AskDot />{asking.length}
          </span>
        )}
      </a>
      {asking.map((a) => (
        <AskRow key={a.name} a={a} className="con-navitem ask-navrow" compact />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// The topbar chip
// ---------------------------------------------------------------------------

const POP_W = 300;

/**
 * The count, everywhere the rails are not. Rendered by TopBar itself so no
 * screen has to remember to ask for it.
 */
export function AskingChip() {
  const route = useRoute();
  // WHERE A RAIL ALREADY SAYS IT, THIS DOES NOT. A project screen has
  // TerminalNavFoot down its left side and the Terminal screen has its own
  // sessions rail (which keeps its badge even collapsed), so on those two the
  // chip would be the same fact twice in one viewport — and two counts of one
  // thing is how they come to disagree.
  const railed = route.name === 'detail' || route.name === 'terminal';
  const asking = useAsking(!railed);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);

  // Measured before paint (MoreMenu's rule, for MoreMenu's reason): a popover
  // that shows up in the wrong corner for a frame is a popover that flickers.
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    setAt({
      top: r.bottom + 8,
      left: Math.max(8, Math.min(r.right - POP_W, window.innerWidth - POP_W - 8)),
    });
  }, [open, asking.length]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    const shut = () => setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', shut, true);
    window.addEventListener('resize', shut);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', shut, true);
      window.removeEventListener('resize', shut);
    };
  }, [open]);

  // The popover has to shut itself when the last question is answered, or it
  // sits there empty over a topbar with no chip under it.
  useEffect(() => { if (!asking.length) setOpen(false); }, [asking.length]);

  if (railed || asking.length === 0) return null;

  const n = asking.length;
  return (
    <>
      <button ref={btn} type="button" className={`ask-chip${open ? ' on' : ''}`}
        aria-haspopup="dialog" aria-expanded={open}
        title={`${n} session${n > 1 ? 's' : ''} stopped, waiting on your answer`}
        onClick={() => setOpen(!open)}>
        <AskDot />
        <span className="ask-chipn">{n}</span>
        <span className="ask-chiplbl">asking</span>
      </button>
      {open && (
        <div ref={pop} className="ask-pop" role="dialog" aria-label="Sessions waiting on an answer"
          style={at ? { top: at.top, left: at.left } : { visibility: 'hidden' }}>
          {/* The head states the count and NOTHING about the ones that are
              fine — this list only ever knows about sessions that are asking,
              so any sentence about the rest would be invented. */}
          <div className="ask-pophead">
            {n} session{n > 1 ? 's' : ''} waiting on you
          </div>
          {asking.map((a) => (
            <AskRow key={a.name} a={a} className="ask-poprow" onGo={() => setOpen(false)} />
          ))}
          <div className="ask-popfoot">Opens the session — answer it at the pane.</div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// #519 — the notifier: telling the owner when he is NOT looking
// ---------------------------------------------------------------------------
//
// WHY THE SURFACES ABOVE WERE NOT ENOUGH. Every one of them is something you
// see only while you are looking at Stack, and they only ever knew about
// PERMISSION prompts — which a bypass-permissions session never raises. So a
// session that finished and asked the owner a question in prose sat there
// unseen, with nothing anywhere saying so. The host now reports that stop too
// (terminal/input-wait.mjs), and this is what makes it reach him:
//
//   · THE TAB TITLE carries the count — "(2) Stack" — on every screen, always.
//     It needs no permission, and it is the one thing visible from another tab.
//   · A SYSTEM NOTIFICATION per new stop, when he has turned them on (Settings
//     → Notifications; the browser only grants the permission from a click)
//     AND this tab is hidden or unfocused. While he is looking, the in-app
//     marks say it and a notification would be noise.
//
// ONE STOP, ONE NOTIFICATION: deduped on session + fingerprint, tagged so two
// open tabs collapse into one, closed again the moment the stop is no longer
// current. The first read after the page opens SEEDS rather than notifies —
// what was already waiting is on the screen he just opened.
//
// IT POLLS WHILE HIDDEN, and only then when notifications are on: that is the
// moment the job exists for (autoRefresh.ts's `whileHidden` carries why it is
// the one exception to #312). With Auto refresh Off nothing polls — off is off.
//
// FAIL SILENT: with no daemon on the line the list is empty, so nothing is
// badged and nothing fires. The Settings row says "Stack cannot see the host"
// in that state rather than letting quiet read as all-clear.

const notifySupported = () =>
  typeof window !== 'undefined' && 'Notification' in window && window.isSecureContext;

export function AskNotifier() {
  const [on, setOn] = useState(getAskNotify);
  useEffect(() => onAskNotifyChange(() => setOn(getAskNotify())), []);
  const granted = on && notifySupported() && Notification.permission === 'granted';
  const asking = useAsking(true, { whileHidden: granted });
  const seen = useRef<Set<string> | null>(null);
  const shown = useRef(new Map<string, Notification>());

  // The title. Read-modify-write rather than a stored base, so a screen that
  // ever sets its own title keeps it under the badge.
  useEffect(() => {
    if (!loaded) return;
    document.title = badgeTitle(document.title, asking.length);
  }, [asking]);
  useEffect(() => () => { document.title = badgeTitle(document.title, 0); }, []);

  useEffect(() => {
    if (!loaded) return;
    const { fresh, gone, seen: next } = diffStops(seen.current, asking);
    seen.current = next;
    for (const k of gone) { shown.current.get(k)?.close(); shown.current.delete(k); }
    if (!granted || !fresh.length) return;
    if (!document.hidden && document.hasFocus()) return; // he is looking
    for (const a of fresh) {
      const { title, body } = notifyText(a);
      try {
        const n = new Notification(title, { body, tag: `stack-ask-${stopKey(a)}`, icon: '/icons/icon-192.png' });
        n.onclick = () => {
          window.focus();
          window.location.hash = hrefTo.terminal(a.cwd, a.name).replace(/^#/, '');
          n.close();
        };
        shown.current.set(stopKey(a), n);
      } catch { /* a browser that has Notification but will not construct one (Android Chrome) */ }
    }
  }, [asking, granted]);

  // Closing the tab should not leave stale notifications behind.
  useEffect(() => () => { for (const n of shown.current.values()) n.close(); }, []);
  return null;
}

/** Settings → Notifications: the switch, and the click the browser needs. */
export function AskNotifySetting() {
  const [on, setOn] = useState(getAskNotify);
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(
    () => (notifySupported() ? Notification.permission : 'unsupported'));
  const [host, setHost] = useState<boolean | undefined>(connected);
  const [busy, setBusy] = useState(false);
  useEffect(() => onAskNotifyChange(() => setOn(getAskNotify())), []);
  useEffect(() => {
    let live = true;
    getDetachedFeed().then((f) => { if (live) setHost(f.connected); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const turnOn = async () => {
    if (!notifySupported()) return;
    setBusy(true);
    try {
      // Asked HERE, on the click — browsers refuse a permission request that
      // is not inside a user gesture, and most never show one twice.
      const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      setPerm(p);
      if (p === 'granted') setAskNotify(true);
    } finally { setBusy(false); }
  };
  const test = () => {
    try {
      new Notification('Stack notifications are on', {
        body: 'This is what a session waiting on you will look like.', tag: 'stack-ask-test', icon: '/icons/icon-192.png',
      });
    } catch { /* see AskNotifier */ }
  };
  const live = on && perm === 'granted';
  const secs = getAutoRefreshSeconds();

  return (
    <div className="set-row col">
      <div className="set-row-text">
        <div className="set-row-label">When a session stops for you</div>
        <div className="set-row-hint">
          A desktop notification the moment a claude session finishes and waits on your reply, stops on a
          question, or asks permission — sent only while this tab is in the background, once per stop. The
          tab title always carries the count, notifications or not.{' '}
          {perm === 'unsupported' && <b>This browser cannot show notifications here (they need HTTPS).</b>}
          {perm === 'denied' && <b>Notifications are blocked for this site in the browser — allow them in its site settings, then turn this on.</b>}
          {live && (secs > 0
            ? <>Checked every <b>{secs}s</b>, background tab included.</>
            : <b>Auto refresh is Off, so nothing checks — turn it on below for these to arrive.</b>)}
          {host === false && <> <b>Stack cannot see the host right now</b> — the terminal daemon is not connected, so nothing can notify until it is.</>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <div className="seg-control" role="tablist" aria-label="Session notifications">
        <button role="tab" aria-selected={!live} className={`seg-opt ${!live ? 'on' : ''}`}
          onClick={() => setAskNotify(false)}>Off</button>
        <button role="tab" aria-selected={live} className={`seg-opt ${live ? 'on' : ''}`}
          disabled={busy || perm === 'unsupported' || perm === 'denied'}
          onClick={() => void turnOn()}>On</button>
      </div>
      {live && <button type="button" className="btn-cancel sm" onClick={test}>Send a test</button>}
      </div>
    </div>
  );
}
