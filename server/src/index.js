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
import { futures } from './routes/futures.js';
import { presence } from './routes/presence.js';
import { checks } from './routes/checks.js';
import { publicShowcase } from './routes/public.js';
import { timeline } from './routes/timeline.js';
import { auth } from './routes/auth.js';
import { devices } from './routes/devices.js';
import { control } from './routes/control.js';
import { review } from './routes/review.js';
import { autopilot, autopilotGlobal } from './routes/autopilot.js';
import { branches } from './routes/branches.js';
import { previews, previewsGlobal } from './routes/previews.js';
import { consoles } from './routes/console.js';
import { terminal } from './routes/terminal.js';
import { triage } from './routes/triage.js';
import { tips } from './routes/tips.js';
import { skills } from './routes/skills.js';
import { instructions } from './routes/instructions.js';
import { agents } from './routes/agents.js';
import { merge } from './routes/merge.js';
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
app.use('/api/control', requireToken, control);
// #282 — the Review room's cross-project payload (queue, archive, nights).
app.use('/api/review', requireToken, review);
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
app.use('/api/projects/:slug/futures', requireToken, futures);
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
// The instructions tree — the managed CLAUDE.md library. App-wide, no slug:
// the personal file and every project's files are one tree, and the whole point
// is seeing which of them wins.
app.use('/api/instructions', requireToken, instructions);
// #361 — the tab agents (Auditor · Curator · Polaris · Foreman · Merge). The
// REGISTRY of who may act on which surface. App-wide, no slug.
app.use('/api/agents', requireToken, agents);
// #334 — a different thing that arrived under the same name: the catalogue of
// SPAWN PROFILES the autopilot hands to `claude --agents`. Nothing to do with
// the surface registry above — it customises the subagents a RUN spawns — so
// it keeps its own module (agent-profiles.js) and its own mount rather than
// colliding on /api/agents and server/src/agents.js, which is what the two
// branches did to each other.
app.use('/api/agent-profiles', requireToken, agentProfiles);
// #364 — the Merge agent's read of a proposed merge plan (Mission Control).
app.use('/api/merge', requireToken, merge);
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

start();
