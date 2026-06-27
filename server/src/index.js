import express from 'express';
import cors from 'cors';
import { migrate, pool } from './db.js';
import { requireToken } from './auth.js';
import { ingest } from './routes/ingest.js';
import { overview } from './routes/overview.js';
import { projects } from './routes/projects.js';
import { bugs } from './routes/bugs.js';
import { roadmap } from './routes/roadmap.js';
import { notes } from './routes/notes.js';

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Open: liveness probe for Docker / Dokploy.
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// Everything else needs the token. Per-project collection routers are mounted
// at the more specific paths; the projects router handles the rest.
app.use('/api/ingest', requireToken, ingest);
app.use('/api/overview', requireToken, overview);
app.use('/api/projects/:slug/bugs', requireToken, bugs);
app.use('/api/projects/:slug/roadmap', requireToken, roadmap);
app.use('/api/projects/:slug/notes', requireToken, notes);
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
