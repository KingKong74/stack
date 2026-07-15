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
import { notes } from './routes/notes.js';
import { futures } from './routes/futures.js';
import { presence } from './routes/presence.js';
import { checks } from './routes/checks.js';
import { publicShowcase } from './routes/public.js';
import { timeline } from './routes/timeline.js';
import { intake } from './routes/intake.js';
import { auth } from './routes/auth.js';

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
app.use('/api/projects/:slug/notes', requireToken, notes);
app.use('/api/projects/:slug/futures', requireToken, futures);
app.use('/api/projects/:slug/checks', requireToken, checks);
app.use('/api/projects/:slug/intake', requireToken, intake);
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
  app.listen(port, () => console.log(`Stack API listening on :${port}`));
}

start();
