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
//
// Sessions are multiplexed over the agent socket by sid; the relay never
// looks inside the data frames (base64 both ways). No agent = the browser
// gets a plain "daemon offline" error, nothing else changes.
// Mission Control asks whether the host daemon is on the line — module-level
// so routes/control.js can read it without holding the relay.
let agentConnected = false;
export const termAgentConnected = () => agentConnected;

export function attachTerm(httpServer) {
  const wss = new WebSocketServer({ noServer: true });
  let agent = null;
  const sessions = new Map(); // sid -> browser ws
  let nextSid = 1;

  const send = (ws, obj) => { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

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
    } else {
      socket.destroy();
    }
  });

  // Keepalive pings so idle sessions survive proxies/tunnels between hops.
  setInterval(() => {
    if (agent) agent.ping();
    for (const ws of sessions.values()) ws.ping();
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
      if (m.t === 'out' || m.t === 'ready' || m.t === 'err' || m.t === 'usage') send(browser, m);
      if (m.t === 'exit') { send(browser, m); browser.close(); sessions.delete(m.sid); }
    });
    ws.on('close', () => {
      if (agent === ws) { agent = null; agentConnected = false; }
      console.log('[term] daemon disconnected');
      for (const [sid, browser] of sessions) {
        send(browser, { t: 'err', msg: 'The terminal daemon disconnected.' });
        browser.close();
        sessions.delete(sid);
      }
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
      delete msg.token; // the daemon never sees credentials
      send(agent, { ...msg, sid });
      ws.on('message', (raw2) => {
        let m;
        try { m = JSON.parse(raw2.toString()); } catch { return; }
        if (m.t === 'in' || m.t === 'resize') send(agent, { ...m, sid });
      });
      ws.on('close', () => {
        if (sessions.delete(sid)) send(agent, { t: 'kill', sid });
      });
    });
  }
}
