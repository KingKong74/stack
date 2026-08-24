import { readFileSync } from 'node:fs';
import express from 'express';
import cors from 'cors';
import { migrate, pool } from './db.js';
import { requireToken } from './auth.js';
import { ingest } from './routes/ingest.js';
import { overview } from './routes/overview.js';
import { search } from './routes/search.js';
import { settings } from './routes/settings.js';
import { projects } from './routes/projects.js';
import { bugs } from './routes/bugs.js';
import { roadmap } from './routes/roadmap.js';
import { board } from './routes/board.js';
import { notes } from './routes/notes.js';
import { workbench } from './routes/workbench.js';
import { presence } from './routes/presence.js';
import { checks } from './routes/checks.js';
import { publicShowcase } from './routes/public.js';
import { timeline } from './routes/timeline.js';
import { auth } from './routes/auth.js';
import { devices } from './routes/devices.js';
import { autopilot, autopilotGlobal } from './routes/autopilot.js';
import { branches } from './routes/branches.js';
import { previews, previewsGlobal } from './routes/previews.js';
import { consoles } from './routes/console.js';
import { terminal } from './routes/terminal.js';
import { triage } from './routes/triage.js';
import { tips } from './routes/tips.js';
import { skills } from './routes/skills.js';
import { agents } from './routes/agents.js';
import { worktrees } from './routes/worktrees.js';
import { agentProfiles } from './routes/agent-profiles.js';
import { attachTerm } from './term.js';

// Read once at module load: the health endpoint reports the deployed version.
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Open: liveness probe for Docker / Dokploy. Version + uptime make it a cheap
// deploy sanity signal ("is the new build actually serving?").
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, version, uptime: Math.round(process.uptime()) });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// Open: the tokenless read-only showcase (guarded by its own per-project token).
app.use('/api/public', publicShowcase);

// Open: PIN sign-in (rate-limited; 403 until an access PIN is set in Settings).
app.use('/api/auth', auth);
// Authenticated: device manager (list + revoke PIN devices).
app.use('/api/auth/devices', requireToken, devices);

// Everything else needs the token. Per-project collection routers are mounted
// at the more specific paths; the projects router handles the rest.
app.use('/api/ingest', requireToken, ingest);
app.use('/api/overview', requireToken, overview);
app.use('/api/search', requireToken, search);
app.use('/api/timeline', requireToken, timeline);
app.use('/api/settings', requireToken, settings);
app.use('/api/presence', requireToken, presence);
app.use('/api/projects/:slug/bugs', requireToken, bugs);
app.use('/api/projects/:slug/roadmap', requireToken, roadmap);
// The Roadmap tab's furniture: per-project areas (the timeline's lanes) and
// the Plan view's lists. Separate from /roadmap because it is the BOARD's
// shape rather than its contents.
app.use('/api/projects/:slug/board', requireToken, board);
app.use('/api/projects/:slug/notes', requireToken, notes);
app.use('/api/projects/:slug/workbench', requireToken, workbench);
app.use('/api/projects/:slug/checks', requireToken, checks);
app.use('/api/projects/:slug/autopilot', requireToken, autopilot);
app.use('/api/projects/:slug/branches', requireToken, branches);
app.use('/api/projects/:slug/previews', requireToken, previews);
// #380 — the briefing a tab agent's live session is SPAWNED with, so the
// console on the Quality tab opens as the Auditor rather than as a bare claude
// in a checkout. Per-project because the snapshot is this project's state.
app.use('/api/projects/:slug/console', requireToken, consoles);
app.use('/api/autopilot', requireToken, autopilotGlobal);
app.use('/api/previews', requireToken, previewsGlobal);
app.use('/api/terminal', requireToken, terminal);
app.use('/api/triage', requireToken, triage);
app.use('/api/tips', requireToken, tips);
app.use('/api/skills', requireToken, skills);
// #361 — the tab agents (Auditor · Curator · Drafter). The REGISTRY of who may
// act on which surface. App-wide, no slug.
app.use('/api/agents', requireToken, agents);
// #334 — a different thing that arrived under the same name: the catalogue of
// SPAWN PROFILES the autopilot hands to `claude --agents`. Nothing to do with
// the surface registry above — it customises the subagents a RUN spawns — so
// it keeps its own module (agent-profiles.js) and its own mount rather than
// colliding on /api/agents and server/src/agents.js, which is what the two
// branches did to each other.
app.use('/api/agent-profiles', requireToken, agentProfiles);
app.use('/api/worktrees', requireToken, worktrees);
app.use('/api/projects', requireToken, projects);

const port = process.env.PORT || 4000;

async function start() {
  // Retry the first connection so we survive Postgres still booting in compose.
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate();
      break;
    } catch (err) {
      if (attempt >= 30) {
        console.error('Could not reach Postgres, giving up:', err.message);
        process.exit(1);
      }
      console.log(`Waiting for Postgres (attempt ${attempt})...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const httpServer = app.listen(port, () => console.log(`Stack API listening on :${port}`));
  attachTerm(httpServer); // the web-terminal relay (/term + /term-agent websockets)
}

// ONE BAD REQUEST MUST NOT TAKE THE WHOLE API DOWN.
//
// Express 4 does not catch a rejected promise from an `async (req, res) =>`
// handler, and this app has well over a hundred of them. Node has terminated
// the process on an unhandled rejection since v15, so any handler that throws
// — a malformed param reaching Postgres, a transient query error, a null deref
// — killed Stack for every project until the container restarted.
//
// That is not theoretical: `DELETE /api/projects/:slug/roadmap/undefined` did
// exactly this, found while testing #174 by a script that interpolated an
// `undefined` id into a path. `src/params.js` now refuses non-numeric ids at
// the routers, which fixes that whole family at the door; this is the backstop
// for the next one, wherever it is.
//
// It deliberately does NOT exit. A rejected handler leaves its own request
// hanging until the client times out, which is bad — but it is one request,
// and the alternative is every other request on the box dying with it. The
// stack goes to the log so the real bug is still findable, and the log line is
// worded so nobody reads it as routine.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION — a request failed and its caller will hang. '
    + 'This is a bug in the handler, not a normal condition:', reason);
});

// The uncaught kind is not survivable the same way: the process may be in an
// unknown state, so this logs and lets it die rather than pretending otherwise.
// Docker restarts it; a half-broken API that keeps answering is worse.
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION — exiting:', err);
  process.exit(1);
});

start();
