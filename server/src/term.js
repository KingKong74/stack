import { WebSocketServer } from 'ws';
import { tokenValid } from './auth.js';

// The web-terminal relay. Containers on this host can't dial INTO the host
// (firewalled), so the PTY daemon (terminal/stack-term.mjs) dials OUT to us
// and we bridge it to browsers:
//
//   /term        the browser (xterm.js). First frame must be a valid
//                {t:'start', token, cwd, cmd, cols, rows} — same credential
//                classes as the API (API token or PIN device token).
//   /term-agent  the daemon's one persistent outbound connection, bearer in
//                the upgrade headers. Latest connection wins.
//   /term-status the global presence channel (#121): any Stack tab may watch.
//                First frame {t:'watch', token} (same credential classes),
//                then the relay pushes {t:'status', active, count} immediately
//                and again on every session start/end — so every open tab
//                shows whether a terminal is live anywhere, with no polling.
//
// Sessions are multiplexed over the agent socket by sid; the relay never
// looks inside the data frames (base64 both ways). No agent = the browser
// gets a plain "daemon offline" error, nothing else changes.
// Mission Control asks whether the host daemon is on the line — module-level
// so routes/control.js can read it without holding the relay.
let agentConnected = false;
export const termAgentConnected = () => agentConnected;

// Live-session metadata for Mission Control (#120): what each open terminal
// is (cwd, shell/claude, age) plus a rolling ANSI-stripped output tail that
// the Gemini labeller reads. In-memory only — gone with the session.
const termMeta = new Map(); // sid -> { cwd, cmd, startedAt, tail, label, tmux }
const TAIL_CAP = 2000;
const stripAnsi = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC (titles etc.)
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')       // CSI
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');       // stray control bytes
export const termSessions = () =>
  [...termMeta.entries()].map(([sid, m]) => ({
    sid: String(sid),
    cwd: m.cwd,
    cmd: m.cmd,
    startedAt: m.startedAt,
    label: m.label || '',
    tmux: m.tmux || '', // the host tmux session behind a claude tab — Mission
                        // Control's ▶ jump-in attaches by this name
  }));
export const termTails = () =>
  [...termMeta.entries()].map(([sid, m]) => ({ sid: String(sid), meta: m }));

// Detached tmux sessions on the host (#188 follow-up): claude sessions that
// survived a browser disconnect but have no client attached. The daemon pushes
// the list (on connect, on session start/end, on a slow tick); the relay just
// caches it for GET /api/terminal/detached. Cleared when the daemon drops —
// nothing is attachable without it anyway, and a reconnect re-seeds the cache.
let detachedSessions = []; // [{ name, cwd, created, attached, keep, tail }]
// Gemini labels survive the 60s list re-push (the daemon only sends
// name/cwd/created/attached/keep/tail); pruned when a name leaves the list.
const detachedLabels = new Map(); // name -> label
export const termDetached = () =>
  detachedSessions.map(({ name, cwd, created, attached, keep, blocked }) => ({
    name, cwd, created, attached, keep, label: detachedLabels.get(name) || '',
    // …plus HOW LONG it has been waiting. The host reports what the prompt is,
    // not when it appeared — a pane read has no memory. The relay supplies the
    // clock by stamping the first push that carried this fingerprint, which is
    // the number the row actually needs: a prompt up for two minutes and one up
    // since last night are the same sentence and very different problems.
    blocked: blocked ? { ...blocked, since: blockedSince.get(name)?.at || Date.now() } : null,
  }));

// name -> { fingerprint, at }. Reset when the question changes, dropped when
// the session goes. Deliberately not persisted: a relay restart honestly does
// not know how long a prompt has been up, and re-stamping now says "at least
// this long" rather than inventing a history.
const blockedSince = new Map();
function stampBlocked(sessions) {
  for (const s of sessions) {
    const fp = s.blocked?.fingerprint;
    if (!fp) { blockedSince.delete(s.name); continue; }
    const prev = blockedSince.get(s.name);
    if (!prev || prev.fingerprint !== fp) blockedSince.set(s.name, { fingerprint: fp, at: Date.now() });
  }
  const alive = new Set(sessions.map((s) => s.name));
  for (const name of blockedSince.keys()) if (!alive.has(name)) blockedSince.delete(name);
}

// A session stopped on a permission prompt, narrowed to the fields a row and
// its Approve button need. The BODY the host fingerprinted is deliberately not
// among them: it can be a whole diff, it would ride in every control payload,
// and nothing client-side reads it — the fingerprint is the handle.
const blockedShape = (b) => (b && typeof b.question === 'string' && typeof b.fingerprint === 'string'
  ? {
    question: String(b.question).slice(0, 300),
    title: String(b.title || '').slice(0, 120),
    detail: String(b.detail || '').slice(0, 300),
    options: (Array.isArray(b.options) ? b.options : []).slice(0, 12)
      .map((o) => ({ n: Number(o?.n) || 0, label: String(o?.label || '').slice(0, 200) })),
    yes: Number(b.yes) || 0,
    fingerprint: b.fingerprint,
  }
  : null);

// Live per-session file edits (the same-file collision signal). Like the
// detached list this is a relay cache with no table behind it: it describes
// what the host is doing THIS MINUTE, and a server restart re-learns it on the
// daemon's next push. `liveEditsAt` is what lets a reader tell "nobody is
// editing anything" from "nobody has told us anything" — Mission Control shows
// no collisions at all rather than a false all-clear when the daemon is away.
let liveEdits = [];
let liveEditsAt = 0;
export const termEdits = () => ({ sessions: liveEdits, at: liveEditsAt });
// Autopilot pane report (#366): what each stack-auto-* tmux session is DOING,
// not just that a job claims it is running. Same cache-with-a-clock shape as
// liveEdits above, and the same invariant: `autoSessionsAt === 0` must mean
// "no daemon has told us anything", not "the fleet is idle" — the client can
// then say "Stack cannot see the host" instead of rendering silence as calm.
let autoSessions = [];
let autoSessionsAt = 0;
export const termAutoSessions = () => ({ sessions: autoSessions, at: autoSessionsAt });
export const termDetachedTails = () => detachedSessions;
export const setDetachedLabel = (name, label) => { detachedLabels.set(name, label); };
// Plan usage snapshot (#220): the account-level Plan windows (#195) the daemon
// already folds into usage frames, cached relay-side so Mission Control's
// console can show session/week % over plain HTTP. Fed by every usage frame
// (15s while a session is live) and by the daemon's dedicated 'plan' push on
// the 60s tick (so the numbers survive quiet spells with no sessions open).
let planSnapshot = null; // { plan, tokens, at }
export const termPlanUsage = () => planSnapshot;

// Set inside attachTerm so the kill route can reach the live agent socket.
let agentSend = null;
export function killDetachedTmux(name) {
  if (!agentSend) return false;
  agentSend({ t: 'killDetached', name });
  return true;
}
// #292 — pin/unpin a session against the idle reaper. Like the kill above, the
// server only RELAYS: the host owns the state (a tmux user option on the
// session itself) and the daemon re-advertises the truth on its next push, so
// nothing here has to be kept in step with anything.
export function keepTmuxSession(name, keep) {
  if (!agentSend) return false;
  agentSend({ t: 'keepSession', name, keep: keep === true });
  return true;
}

// Answer a permission prompt in a host session — the one relay call that gets
// a REPLY, because it is the one where "we asked" is not the same as "it
// happened". The host re-reads the pane before it types anything and can
// legitimately refuse (the prompt was answered at the keyboard, the session
// moved on, tmux said no); the human needs that sentence, not a silent 200.
//
// Correlation is a counter and a Map of resolvers. A daemon that never answers
// times out here rather than leaving an HTTP request open forever.
let answerSeq = 0;
const pendingAnswers = new Map(); // id -> resolve
export function answerTmuxPrompt(name, fingerprint, choice, timeoutMs = 8_000) {
  if (!agentSend) return Promise.resolve({ ok: false, error: 'the host daemon is not connected' });
  const id = `a${++answerSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAnswers.delete(id);
      resolve({ ok: false, error: 'the host did not answer in time' });
    }, timeoutMs);
    pendingAnswers.set(id, (m) => {
      clearTimeout(timer);
      resolve({ ok: m.ok === true, error: String(m.error || ''), state: String(m.state || '') });
    });
    agentSend({ t: 'answerPrompt', id, name, fingerprint, choice });
  });
}

// #364 — run a tab agent's prompt through Claude on the HOST.
//
// Same correlated request/reply as answerTmuxPrompt above, and for the same
// reason it exists at all: the server cannot execute anything on the host. It
// runs in a container and the firewall drops container→host, so every host
// capability Stack has is the daemon dialling OUT and being asked over the
// socket it holds open. This is that, for the CLI.
//
// The timeout is generous where the prompt one is tight (8s there, minutes
// here): answering a permission prompt is a keystroke, and a model reading a
// project's whole quality page is not. It is still bounded — an unbounded wait
// would hold the ✧ button's HTTP request open until the browser gave up, with
// nothing on screen saying why.
//
// FAIL SILENT, not fail open: with no daemon on the line this REFUSES and says
// so. There is no second backend to fall through to, and pretending an agent
// ran while the host was unreachable would put an empty answer where a real
// one belongs — the same rule as a NULL review verdict.
let claudeSeq = 0;
const pendingClaude = new Map(); // id -> resolve
export function askClaudeOnHost(prompt, { timeoutMs = 180_000, model = '', diffs = null } = {}) {
  if (!agentSend) {
    return Promise.resolve({ ok: false, error: 'the host daemon is not connected, so no agent can run' });
  }
  const id = `c${++claudeSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingClaude.delete(id);
      resolve({ ok: false, error: 'the host did not answer in time' });
    }, timeoutMs + 5_000); // the host kills at timeoutMs; this only catches a dead socket
    pendingClaude.set(id, (m) => {
      clearTimeout(timer);
      resolve({
        ok: m.ok === true,
        text: String(m.text || ''),
        error: String(m.error || ''),
        costUsd: Number(m.costUsd) || 0,
        model: String(m.model || ''),
      });
    });
    // `diffs` asks the host to read real git diffs for these branches and put
    // them in front of the prompt. Only the host can: the server has the
    // ~10-minute branch report, not the code.
    agentSend({ t: 'claudeAsk', id, prompt, timeoutMs, model, ...(diffs ? { diffs } : {}) });
  });
}

// #366 — an on-demand FRESH read of one stack-auto-* pane: what this session
// is doing right now, not the ~stale cached report termAutoSessions() serves.
// Same correlated request/reply shape as answerTmuxPrompt, and its own seq
// counter and pending Map (never shared with answerTmuxPrompt's) for the same
// reason that one has its own: two callers must not steal each other's replies.
//
// This path is READ-ONLY. It sends no keystrokes and must never grow a write.
// POST /api/terminal/answer stays the only path by which anything but a human
// types into a running session, and autopilot sessions are excluded from it by
// construction — they run with --dangerously-skip-permissions, so they cannot
// be blocked on a prompt this way in the first place.
let autoViewSeq = 0;
const pendingAutoView = new Map(); // id -> resolve
export function viewAutoPane(name, { lines = 160, timeoutMs = 8_000 } = {}) {
  if (!agentSend) return Promise.resolve({ ok: false, error: 'the host daemon is not connected' });
  const id = `v${++autoViewSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAutoView.delete(id);
      resolve({ ok: false, error: 'the host did not answer in time' });
    }, timeoutMs);
    pendingAutoView.set(id, (m) => {
      clearTimeout(timer);
      resolve({
        ok: m.ok === true,
        error: String(m.error || ''),
        tail: String(m.tail || ''),
        doing: String(m.doing || ''),
        idleMs: Number(m.idleMs) || 0,
        activityAt: Number(m.activityAt) || 0,
        alive: m.alive === true,
      });
    });
    agentSend({ t: 'autoView', id, name, lines });
  });
}

export function attachTerm(httpServer) {
  const wss = new WebSocketServer({ noServer: true });
  let agent = null;
  const sessions = new Map(); // sid -> browser ws
  const watchers = new Set(); // /term-status subscribers (#121)
  let nextSid = 1;

  const send = (ws, obj) => { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  // The pill's frame: what kind of activity, not just whether. claude counts
  // browser-attached claude tabs; unattended counts claude running on the host
  // with no client anywhere (a reload orphan or a deliberate walk-away) — that
  // still deserves the pill even with every browser tab closed.
  const statusFrame = () => {
    let claude = 0;
    for (const m of termMeta.values()) if (m.cmd === 'claude') claude++;
    const unattended = detachedSessions.filter((s) => !s.attached).length;
    return {
      t: 'status',
      active: termMeta.size > 0 || unattended > 0,
      count: termMeta.size,
      claude,
      unattended,
    };
  };
  const broadcastStatus = () => {
    for (const ws of watchers) send(ws, statusFrame());
  };

  httpServer.on('upgrade', async (req, socket, head) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/term-agent') {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!(await tokenValid(token))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => acceptAgent(ws));
    } else if (path === '/term') {
      wss.handleUpgrade(req, socket, head, (ws) => acceptBrowser(ws));
    } else if (path === '/term-status') {
      wss.handleUpgrade(req, socket, head, (ws) => acceptWatcher(ws));
    } else {
      socket.destroy();
    }
  });

  // Keepalive pings so idle sessions survive proxies/tunnels between hops.
  setInterval(() => {
    if (agent) agent.ping();
    for (const ws of sessions.values()) ws.ping();
    for (const ws of watchers) ws.ping();
  }, 30_000).unref();

  function acceptAgent(ws) {
    if (agent) { send(agent, { t: 'err', msg: 'Replaced by a newer daemon connection.' }); agent.close(); }
    agent = ws;
    agentConnected = true;
    agentSend = (obj) => send(agent, obj);
    console.log('[term] daemon connected');
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }

      // hello — the daemon re-announces sessions that survived an uplink gap.
      // Each sid in the list is a PTY that kept running while we were
      // disconnected; the relay must not treat them as errors.  Any sessions
      // the relay no longer has a browser for (the browser closed while the
      // daemon was away) are killed with a 'kill' frame sent back, so the PTY
      // can exit cleanly.  Sessions whose browsers are still waiting are simply
      // left connected — the buffered output that follows the hello flushes
      // through the normal 'out' handler below.
      // detached — the daemon's current list of stack-term-* tmux sessions
      // (detached survivors AND ones attached elsewhere — another browser, a
      // laptop over ssh). Cache it whole; the API route serves it read-only.
      if (m.t === 'detached' && Array.isArray(m.sessions)) {
        detachedSessions = m.sessions
          .filter((s) => s && typeof s.name === 'string')
          .map((s) => ({
            name: s.name,
            cwd: typeof s.cwd === 'string' ? s.cwd : '',
            created: Number(s.created) || 0,
            attached: s.attached === true,
            // #292 — the keep pin, as the host reports it. An older daemon
            // sends no such field, which reads as unpinned: the truthful answer
            // for a host whose reaper does not know about pins either.
            keep: s.keep === true,
            tail: typeof s.tail === 'string' ? s.tail.slice(-TAIL_CAP) : '',
            // Stopped on a permission prompt, as the host read it a moment ago.
            // An older daemon sends nothing, which reads as "not blocked" — the
            // truthful answer for a host that cannot see a block at all.
            blocked: blockedShape(s.blocked),
          }));
        stampBlocked(detachedSessions);
        const alive = new Set(detachedSessions.map((s) => s.name));
        for (const name of detachedLabels.keys()) if (!alive.has(name)) detachedLabels.delete(name);
        broadcastStatus(); // unattended claude count may have changed
        return;
      }

      // edits — who is mid-edit in which file, read off the live transcripts.
      // Cache-only, like 'plan': nothing to forward to a browser.
      if (m.t === 'edits' && Array.isArray(m.sessions)) {
        liveEdits = m.sessions
          .filter((s) => s && typeof s.sessionId === 'string')
          .slice(0, 64)
          .map((s) => ({
            sessionId: s.sessionId,
            cwd: typeof s.cwd === 'string' ? s.cwd : '',
            branch: typeof s.branch === 'string' ? s.branch : '',
            lastAt: Number(s.lastAt) || 0,
            dropped: Number(s.dropped) || 0,
            files: (Array.isArray(s.files) ? s.files : []).slice(0, 60)
              .filter((f) => f && typeof f.path === 'string')
              .map((f) => ({ path: f.path, at: Number(f.at) || 0 })),
          }));
        liveEditsAt = Date.now();
        return;
      }

      // auto — the host's report of stack-auto-* tmux panes (#366): what each
      // running autopilot session is DOING, read off the pane itself. Cache-only,
      // like 'edits' above — Mission Control reads it through termAutoSessions().
      if (m.t === 'auto' && Array.isArray(m.sessions)) {
        autoSessions = m.sessions
          .filter((s) => s && typeof s.name === 'string'
            && /^stack-auto-[A-Za-z0-9_-]{1,64}$/.test(s.name))
          .slice(0, 16)
          .map((s) => ({
            name: s.name,
            jobId: Number.isFinite(Number(s.jobId)) ? Number(s.jobId) : null,
            slug: typeof s.slug === 'string' ? s.slug : '',
            created: Number(s.created) || 0,
            attached: s.attached === true,
            activityAt: Number(s.activityAt) || 0,
            idleMs: Number(s.idleMs) || 0,
            tail: typeof s.tail === 'string' ? s.tail.slice(-TAIL_CAP) : '',
            doing: typeof s.doing === 'string' ? s.doing.slice(0, 200) : '',
          }));
        autoSessionsAt = Date.now();
        return;
      }

      // answered — the host's verdict on an answerPrompt it was asked to send.
      if (m.t === 'answered' && m.id) {
        const waiting = pendingAnswers.get(m.id);
        if (waiting) { pendingAnswers.delete(m.id); waiting(m); }
        return;
      }

      // claudeAnswer — the host's reply to an agent prompt it ran through the
      // CLI (#364). Correlated exactly like `answered`.
      if (m.t === 'claudeAnswer' && m.id) {
        const waiting = pendingClaude.get(m.id);
        if (waiting) { pendingClaude.delete(m.id); waiting(m); }
        return;
      }

      // autoViewed — the host's fresh read of a stack-auto-* pane it was asked
      // to look at (#366). Correlated exactly like `answered`/`claudeAnswer`.
      if (m.t === 'autoViewed' && m.id) {
        const waiting = pendingAutoView.get(m.id);
        if (waiting) { pendingAutoView.delete(m.id); waiting(m); }
        return;
      }

      // Plan windows (#220): cache account-level usage whenever it rides past —
      // the sid-less 'plan' tick and every per-session usage frame both count.
      if (m.plan) planSnapshot = { plan: m.plan, tokens: Number(m.tokens) || 0, at: Date.now() };
      if (m.t === 'plan') return; // cache-only frame — nothing to forward

      if (m.t === 'hello' && Array.isArray(m.sids)) {
        console.log(`[term] daemon re-announced ${m.sids.length} surviving session(s): ${m.sids.join(', ')}`);
        for (const sid of m.sids) {
          if (!sessions.has(sid)) {
            // No browser waiting — tell the daemon to close this orphan PTY.
            send(ws, { t: 'kill', sid });
          }
          // else: browser is still connected — let buffered output through below.
        }
        return;
      }

      const browser = sessions.get(m.sid);
      if (!browser) return;
      if (m.t === 'out' && m.data) {
        const meta = termMeta.get(m.sid);
        if (meta) {
          try {
            meta.tail = (meta.tail + stripAnsi(Buffer.from(m.data, 'base64').toString('utf8'))).slice(-TAIL_CAP);
          } catch { /* bad frame — the tail just misses it */ }
        }
      }
      if (m.t === 'ready' && typeof m.tmuxSession === 'string') {
        // The daemon confirmed (or assigned) the tab's tmux session — keep the
        // name on the meta row so Mission Control can offer a jump-in attach.
        const meta = termMeta.get(m.sid);
        if (meta) meta.tmux = m.tmuxSession;
      }
      if (m.t === 'out' || m.t === 'ready' || m.t === 'err' || m.t === 'usage') send(browser, m);
      if (m.t === 'exit') { send(browser, m); browser.close(); sessions.delete(m.sid); termMeta.delete(m.sid); broadcastStatus(); }
    });
    ws.on('close', () => {
      if (agent === ws) {
        agent = null; agentConnected = false; agentSend = null; detachedSessions = [];
        // No daemon, no claim. Stale edits would keep a collision warning on
        // screen for a host nobody can see any more — worse than silence,
        // because it reads as current.
        liveEdits = []; liveEditsAt = 0;
        // Same rule for the autopilot pane report: `autoSessionsAt === 0` must
        // read as "the host has not told us anything", never as "nothing is
        // running" — a dead daemon reporting silence is not an all-clear.
        autoSessions = []; autoSessionsAt = 0;
      }
      console.log('[term] daemon disconnected');
      // Do NOT kill browser connections here — the daemon may reconnect and
      // re-announce surviving PTYs (#123).  Browsers will see silence until the
      // daemon comes back; they can reconnect themselves if needed.
      broadcastStatus();
    });
  }

  function acceptBrowser(ws) {
    const gate = setTimeout(() => ws.close(), 10_000);
    ws.once('message', async (raw) => {
      clearTimeout(gate);
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { ws.close(); return; }
      if (msg.t !== 'start' || !(await tokenValid(msg.token))) {
        send(ws, { t: 'err', msg: 'Not authorised.' });
        ws.close();
        return;
      }
      if (!agent) {
        send(ws, { t: 'err', msg: 'The terminal daemon is not connected — is stack-term running on the host?' });
        ws.close();
        return;
      }
      const sid = nextSid++;
      sessions.set(sid, ws);
      termMeta.set(sid, {
        cwd: String(msg.cwd || '~'),
        cmd: msg.cmd === 'claude' ? 'claude' : 'shell',
        startedAt: Date.now(),
        tail: '',
        label: '',
        tmux: '',
      });
      delete msg.token; // the daemon never sees credentials
      send(agent, { ...msg, sid });
      broadcastStatus();
      ws.on('message', (raw2) => {
        let m;
        try { m = JSON.parse(raw2.toString()); } catch { return; }
        if (m.t === 'in' || m.t === 'resize') send(agent, { ...m, sid });
      });
      ws.on('close', () => {
        if (sessions.delete(sid)) send(agent, { t: 'kill', sid });
        termMeta.delete(sid);
        broadcastStatus();
      });
    });
  }

  // A /term-status watcher: any signed-in Stack tab. Gets the current state
  // straight after the token check, then every change until it disconnects.
  function acceptWatcher(ws) {
    const gate = setTimeout(() => ws.close(), 10_000);
    ws.once('message', async (raw) => {
      clearTimeout(gate);
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { ws.close(); return; }
      if (msg.t !== 'watch' || !(await tokenValid(msg.token))) {
        send(ws, { t: 'err', msg: 'Not authorised.' });
        ws.close();
        return;
      }
      watchers.add(ws);
      send(ws, statusFrame());
      ws.on('close', () => watchers.delete(ws));
    });
  }
}
