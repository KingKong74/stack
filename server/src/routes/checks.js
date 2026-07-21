import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { checkShape, checkRunShape } from '../shape.js';
import { askGemini, geminiEnabled } from '../gemini.js';
import { buildPrompt } from '../prompts.js';

// Mounted at /api/projects/:slug/checks — the Bugs tab’s Audit area (#143, named by #145).
// A check exercises the project's live application over HTTP: a plain probe
// (GET, expected status) or a function test (method + request body against an
// API endpoint) with optional assertions — a body keyword, a JSON-path value
// and a Gemini-judged plain-language expectation. Runs are on-demand (the Run
// button), bounded, and store their result on the row. This is a single-user
// self-hosted app behind bearer auth, so probing user-supplied URLs from the
// server is by design.
export const checks = Router({ mergeParams: true });

const RUN_TIMEOUT_MS = 8000;
const BODY_CAP = 262144; // read at most 256KB when checking the response body
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

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

// Shared field parsing for POST (create) and PATCH (edit). Returns the
// normalised column values for whichever keys are present on the payload.
function parseFields(body) {
  const out = {};
  if ('name' in body) out.name = String(body.name || '').trim().slice(0, 120);
  if ('url' in body) out.url = String(body.url || '').trim().slice(0, 500);
  if ('method' in body) {
    const m = String(body.method || 'GET').trim().toUpperCase();
    out.method = METHODS.includes(m) ? m : null; // null = invalid, caller rejects
  }
  if ('expect_status' in body) {
    out.expect_status = Number.isFinite(Number(body.expect_status)) ? Math.trunc(Number(body.expect_status)) : 200;
  }
  if ('req_body' in body) out.req_body = String(body.req_body || '').trim().slice(0, 4000) || null;
  if ('contains' in body) out.contains = String(body.contains || '').trim().slice(0, 200) || null;
  if ('json_path' in body) out.json_path = String(body.json_path || '').trim().slice(0, 200) || null;
  if ('json_expect' in body) out.json_expect = String(body.json_expect || '').trim().slice(0, 300) || null;
  if ('semantic' in body) out.semantic = String(body.semantic || '').trim().slice(0, 300) || null;
  return out;
}

// POST /  -> create { name, url, method?, expect_status?, req_body?,
//                     contains?, json_path?, json_expect?, semantic? }
checks.post('/', async (req, res) => {
  const f = parseFields(req.body || {});
  if (!f.name) return res.status(400).json({ error: 'Name is required.' });
  if (!/^https?:\/\//i.test(f.url || '')) return res.status(400).json({ error: 'URL must start with http(s)://' });
  if (f.method === null) return res.status(400).json({ error: `Method must be one of ${METHODS.join(', ')}.` });

  const { rows } = await q(
    `INSERT INTO checks (project_id, name, url, method, expect_status, req_body, contains, json_path, json_expect, semantic)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.project.id, f.name, f.url, f.method || 'GET', f.expect_status ?? 200,
     f.req_body ?? null, f.contains ?? null, f.json_path ?? null, f.json_expect ?? null, f.semantic ?? null]
  );
  res.status(201).json(checkShape(rows[0]));
});

// PATCH /:id  -> edit any subset of the POST fields. Changing what the check
// actually tests (anything but the name) clears the stored result — a pass
// against the old definition would be a lie against the new one.
checks.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [existing] } = await q(
    'SELECT * FROM checks WHERE project_id = $1 AND id = $2', [req.project.id, id]
  );
  if (!existing) return res.status(404).json({ error: 'No such check.' });

  const f = parseFields(req.body || {});
  if ('name' in f && !f.name) return res.status(400).json({ error: 'Name is required.' });
  if ('url' in f && !/^https?:\/\//i.test(f.url || '')) return res.status(400).json({ error: 'URL must start with http(s)://' });
  if (f.method === null) return res.status(400).json({ error: `Method must be one of ${METHODS.join(', ')}.` });
  if (!Object.keys(f).length) return res.json(checkShape(existing));

  const merged = { ...existing, ...f };
  const definitionChanged = ['url', 'method', 'expect_status', 'req_body', 'contains', 'json_path', 'json_expect', 'semantic']
    .some((k) => (merged[k] ?? null) !== (existing[k] ?? null));

  const { rows: [saved] } = await q(
    `UPDATE checks SET name = $2, url = $3, method = $4, expect_status = $5, req_body = $6,
                       contains = $7, json_path = $8, json_expect = $9, semantic = $10
                       ${definitionChanged ? ', last_status = NULL, last_code = NULL, last_ms = NULL, last_error = NULL, last_run_at = NULL' : ''}
      WHERE id = $1 RETURNING *`,
    [id, merged.name, merged.url, merged.method, merged.expect_status, merged.req_body,
     merged.contains, merged.json_path, merged.json_expect, merged.semantic]
  );
  res.json(checkShape(saved));
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

// Walk a dot path ("status", "data.items.0.name", optional leading "$.")
// through a parsed JSON value. Returns undefined when the path falls off.
function walkPath(value, path) {
  const parts = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
  let cur = value;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// One bounded probe. Never throws.
async function probe(row) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RUN_TIMEOUT_MS);
  try {
    const method = METHODS.includes(row.method) ? row.method : 'GET';
    const sendBody = row.req_body && method !== 'GET' && method !== 'HEAD';
    let contentType = 'text/plain';
    if (sendBody) {
      try { JSON.parse(row.req_body); contentType = 'application/json'; } catch { /* plain text */ }
    }
    const res = await fetch(row.url, {
      method,
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent': 'stack-checks/1.0',
        ...(sendBody ? { 'content-type': contentType } : {}),
      },
      ...(sendBody ? { body: row.req_body } : {}),
    });
    clearTimeout(timer);
    const ms = Date.now() - started;
    let pass = res.status === row.expect_status;
    let error = pass ? null : `expected ${row.expect_status}, got ${res.status}`;
    let body = null;
    if (pass && (row.contains || row.json_path || row.semantic)) {
      body = (await res.text()).slice(0, BODY_CAP);
    }
    if (pass && row.contains && !body.includes(row.contains)) {
      pass = false;
      error = `body missing "${row.contains}"`;
    }
    // The JSON assertion: parse the response, walk the dot path, compare
    // against the expected value as text (objects/arrays via JSON). An empty
    // expectation just requires the path to exist.
    if (pass && row.json_path) {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        pass = false;
        error = 'response is not JSON';
      }
      if (pass) {
        const value = walkPath(parsed, row.json_path);
        const got = value === undefined ? undefined
          : (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));
        if (value === undefined) {
          pass = false;
          error = `${row.json_path} missing from response`;
        } else if (row.json_expect != null && got !== row.json_expect) {
          pass = false;
          error = `${row.json_path}: expected "${row.json_expect}", got "${String(got).slice(0, 120)}"`;
        }
      }
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

// POST /run  -> run every check (or one, with body {id}); returns updated shapes.
// Every run also lands a summary row in check_runs — the Audit tab's history.
checks.post('/run', async (req, res) => {
  const one = Number(req.body?.id);
  const { rows } = await q(
    `SELECT * FROM checks WHERE project_id = $1 ${Number.isFinite(one) && one > 0 ? 'AND id = $2' : ''} ORDER BY created_at`,
    Number.isFinite(one) && one > 0 ? [req.project.id, one] : [req.project.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Nothing to run.' });

  const started = Date.now();
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

  // The history row never blocks the response — a hiccup here is a log line,
  // not a failed run (the checks themselves already saved their results).
  const passed = updated.filter((c) => c.lastStatus === 'pass').length;
  try {
    await q(
      `INSERT INTO check_runs (project_id, scope, total, passed, failed, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.project.id, Number.isFinite(one) && one > 0 ? 'one' : 'all',
       updated.length, passed, updated.length - passed, Date.now() - started]
    );
  } catch (e) {
    console.error('check_runs insert failed:', e.message);
  }
  res.json(updated);
});

// GET /runs  -> the run history, newest first (the Audit tab's trend strip)
checks.get('/runs', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 200);
  const { rows } = await q(
    'SELECT * FROM check_runs WHERE project_id = $1 ORDER BY run_at DESC LIMIT $2',
    [req.project.id, limit]
  );
  res.json(rows.map(checkRunShape));
});
