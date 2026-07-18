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
const termMeta = new Map(); // sid -> { cwd, cmd, startedAt, tail, label }
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
  }));
export const termTails = () =>
  [...termMeta.entries()].map(([sid, m]) => ({ sid: String(sid), meta: m }));

export function attachTerm(httpServer) {
  const wss = new WebSocketServer({ noServer: true });
  let agent = null;
  const sessions = new Map(); // sid -> browser ws
  const watchers = new Set(); // /term-status subscribers (#121)
  let nextSid = 1;

  const send = (ws, obj) => { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  const statusFrame = () => ({ t: 'status', active: termMeta.size > 0, count: termMeta.size });
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
    console.log('[term] daemon connected');
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
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
      if (m.t === 'out' || m.t === 'ready' || m.t === 'err' || m.t === 'usage') send(browser, m);
      if (m.t === 'exit') { send(browser, m); browser.close(); sessions.delete(m.sid); termMeta.delete(m.sid); broadcastStatus(); }
    });
    ws.on('close', () => {
      if (agent === ws) { agent = null; agentConnected = false; }
      console.log('[term] daemon disconnected');
      for (const [sid, browser] of sessions) {
        send(browser, { t: 'err', msg: 'The terminal daemon disconnected.' });
        browser.close();
        sessions.delete(sid);
        termMeta.delete(sid);
      }
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
