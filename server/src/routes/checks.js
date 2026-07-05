import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { checkShape } from '../shape.js';
import { askGemini, geminiEnabled } from '../gemini.js';
import { buildPrompt } from '../prompts.js';

// Mounted at /api/projects/:slug/checks — the Bugs tab's testing panel.
// A check is an HTTP probe against the project's live application: pass =
// the expected status (and, optionally, a body keyword). Runs are on-demand
// (the Run button), bounded, and store their result on the row. This is a
// single-user self-hosted app behind bearer auth, so probing user-supplied
// URLs from the server is by design.
export const checks = Router({ mergeParams: true });

const RUN_TIMEOUT_MS = 8000;
const BODY_CAP = 262144; // read at most 256KB when checking for a keyword

checks.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

// GET /  -> list, oldest first (stable dashboard order)
checks.get('/', async (req, res) => {
  const { rows } = await q(
    'SELECT * FROM checks WHERE project_id = $1 ORDER BY created_at',
    [req.project.id]
  );
  res.json(rows.map(checkShape));
});

// POST /  -> create { name, url, expect_status?, contains? }
checks.post('/', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120);
  const url = String(req.body?.url || '').trim().slice(0, 500);
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'URL must start with http(s)://' });
  const expect = Number.isFinite(Number(req.body?.expect_status)) ? Math.trunc(Number(req.body.expect_status)) : 200;
  const contains = String(req.body?.contains || '').trim().slice(0, 200) || null;
  const semantic = String(req.body?.semantic || '').trim().slice(0, 300) || null;

  const { rows } = await q(
    `INSERT INTO checks (project_id, name, url, expect_status, contains, semantic)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.project.id, name, url, expect, contains, semantic]
  );
  res.status(201).json(checkShape(rows[0]));
});

// DELETE /:id
checks.delete('/:id', async (req, res) => {
  const { rowCount } = await q(
    'DELETE FROM checks WHERE project_id = $1 AND id = $2',
    [req.project.id, Number(req.params.id)]
  );
  if (!rowCount) return res.status(404).json({ error: 'No such check.' });
  res.json({ ok: true });
});

// One bounded probe. Never throws.
async function probe(row) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RUN_TIMEOUT_MS);
  try {
    const res = await fetch(row.url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': 'stack-checks/1.0' },
    });
    clearTimeout(timer);
    const ms = Date.now() - started;
    let pass = res.status === row.expect_status;
    let error = pass ? null : `expected ${row.expect_status}, got ${res.status}`;
    let body = null;
    if (pass && (row.contains || row.semantic)) {
      body = (await res.text()).slice(0, BODY_CAP);
    }
    if (pass && row.contains && !body.includes(row.contains)) {
      pass = false;
      error = `body missing "${row.contains}"`;
    }
    // The semantic assertion: Gemini judges the page's visible text against a
    // plain-language expectation. Skipped silently when Gemini isn't
    // configured; a Gemini hiccup fails the check honestly rather than lying.
    if (pass && row.semantic && geminiEnabled()) {
      const page = body
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 6000);
      try {
        const verdict = await askGemini(
          buildPrompt('semantic', { ASSERTION: row.semantic, PAGE: page }),
          { timeoutMs: 15_000 }
        );
        if (verdict?.pass !== true) {
          pass = false;
          error = `✧ ${String(verdict?.reason || 'expectation not met').slice(0, 180)}`;
        }
      } catch (e) {
        pass = false;
        error = `✧ semantic judge unavailable: ${String(e.message || e).slice(0, 120)}`;
      }
    }
    return { pass, code: res.status, ms, error };
  } catch (e) {
    clearTimeout(timer);
    const ms = Date.now() - started;
    const error = e.name === 'AbortError' ? `timed out (${RUN_TIMEOUT_MS / 1000}s)` : String(e.message || e).slice(0, 200);
    return { pass: false, code: null, ms, error };
  }
}

// POST /run  -> run every check (or one, with body {id}); returns updated shapes
checks.post('/run', async (req, res) => {
  const one = Number(req.body?.id);
  const { rows } = await q(
    `SELECT * FROM checks WHERE project_id = $1 ${Number.isFinite(one) && one > 0 ? 'AND id = $2' : ''} ORDER BY created_at`,
    Number.isFinite(one) && one > 0 ? [req.project.id, one] : [req.project.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Nothing to run.' });

  const updated = await Promise.all(rows.map(async (row) => {
    const r = await probe(row);
    const { rows: [saved] } = await q(
      `UPDATE checks SET last_status = $2, last_code = $3, last_ms = $4,
                         last_error = $5, last_run_at = now()
        WHERE id = $1 RETURNING *`,
      [row.id, r.pass ? 'pass' : 'fail', r.code, r.ms, r.error]
    );
    return checkShape(saved);
  }));
  res.json(updated);
});
