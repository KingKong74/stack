// Diagnostic passes reuse the existing jobs/claim/dispatcher lane. No second
// scheduler, task state or human verdict. Immutable input spec is captured here.
import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { mergeProfiles } from '../agent-profiles.js';
import { resolveProfileSkills } from '../profile-skills.js';
import { readSettings } from '../settings.js';
export const specialists = Router({ mergeParams: true });
specialists.use(async (req, res, next) => { req.project = await projectBySlug(req.params.slug); if (!req.project) return res.status(404).json({ error: 'No such project.' }); next(); });
specialists.post('/runs', async (req, res) => {
  const b = req.body || {};
  if (!/^[a-f0-9-]{36}$/.test(b.requestId) || !/^[a-f0-9]{40}$/.test(b.head) || !/^[a-f0-9]{40}$/.test(b.base)) return res.status(400).json({ error: 'Provide requestId and exact base/head commit hashes.' });
  const paths = b.paths ?? [];
  if (!Array.isArray(paths) || paths.length > 8 || paths.some(p => typeof p !== 'string' || !/^[a-zA-Z0-9_.\/-]{1,200}$/.test(p) || p.startsWith('/') || p.split('/').some(x => !x || x === '.' || x === '..'))) return res.status(400).json({ error: 'Choose up to eight literal relative file paths.' });
  if (b.runtime && b.runtime !== 'claude') return res.status(400).json({ error: 'Diagnostic jobs currently support native Claude only.' });
  if (b.profileKey === 'stack-builder' || b.profileKey === 'executor') return res.status(400).json({ error: 'Use a terminal for implementation. Diagnostic jobs only annotate supplied evidence.' });
  const [stored, library, settings] = await Promise.all([q('SELECT * FROM agent_profiles'),
    q('SELECT s.*, p.slug FROM skills s LEFT JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL'), readSettings()]);
  const p = mergeProfiles(stored.rows.map(p => ({ ...p, skillIds: p.skill_ids || [] }))).find(p => p.key === b.profileKey && p.enabled);
  if (!p) return res.status(400).json({ error: 'Select an enabled diagnostic profile.' });
  let prepared; try { prepared = resolveProfileSkills(p, library.rows, { runtime: 'claude', slug: req.params.slug }); } catch (e) { return res.status(400).json({ error: e.message }); }
  const model = p.model || settings.autopilot_executor_model || '';
  if (model && !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(model)) return res.status(400).json({ error: 'This model identifier is not supported by the native diagnostic adapter.' });
  const spec = { profileKey: p.key, profileName: p.name, profileRevision: prepared.profileRevision, prompt: prepared.prompt,
    model, skills: prepared.skillRevisions,
    base: b.base, head: b.head, includeWorkingTree: b.includeWorkingTree === true,
    paths, mode: 'evidence-only', grantedTools: [], configuredProfileTools: p.tools,
    maxSeconds: Math.min(180, Math.max(10, Number(b.maxSeconds) || 90)), maxTurns: 1,
    note: String(b.note || '').slice(0, 2000), requestedAt: new Date().toISOString() };
  const { rows } = await q(`INSERT INTO autopilot_jobs (project_id, kind, status, specialist_spec, specialist_request_id, detail)
    VALUES ($1, 'specialist', 'queued', $2::jsonb, $3, 'Diagnostic pass queued; no tools or verdict authority')
    ON CONFLICT (project_id, specialist_request_id) WHERE specialist_request_id IS NOT NULL DO UPDATE SET specialist_request_id = EXCLUDED.specialist_request_id
    RETURNING id, status`, [req.project.id, JSON.stringify(spec), b.requestId]);
  res.status(201).json({ id: String(rows[0].id), status: rows[0].status, mode: spec.mode });
});
specialists.get('/runs/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid run ID.' });
  const { rows } = await q("SELECT id, status, detail, specialist_spec, advice, started_at, finished_at FROM autopilot_jobs WHERE id = $1 AND project_id = $2 AND kind = 'specialist'", [req.params.id, req.project.id]);
  if (!rows.length) return res.status(404).json({ error: 'No such specialist run.' });
  const r = rows[0]; let result = null; try { if (r.advice) result = JSON.parse(r.advice); } catch { /* missing structured evidence stays unknown */ }
  res.json({ id: String(r.id), status: r.status, detail: r.detail, spec: r.specialist_spec, result, startedAt: r.started_at, finishedAt: r.finished_at });
});

// Only the claimed worker can start, and a late completion cannot undo pause.
specialists.post('/runs/:id/start', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid run ID.' });
  const r = await q("UPDATE autopilot_jobs SET status = 'running', started_at = now() WHERE id = $1 AND project_id = $2 AND kind = 'specialist' AND status = 'claimed' RETURNING id", [req.params.id, req.project.id]);
  if (!r.rowCount) return res.status(409).json({ error: 'Run is no longer claimed.' });
  res.json({ ok: true });
});
specialists.post('/runs/:id/result', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid run ID.' });
  const { status, result, detail } = req.body || {};
  if (!['done', 'failed'].includes(status)) return res.status(400).json({ error: 'Result status must be done or failed.' });
  const strings = v => Array.isArray(v) && v.length <= 200 && v.every(x => typeof x === 'string' && x.length <= 2000);
  if (status === 'done' && (!result || !result.provenance || !/^[a-f0-9]{40}$/.test(result.provenance.head) || !/^[a-f0-9]{40}$/.test(result.provenance.base)
    || (result.skipped ? typeof result.reason !== 'string' : typeof result.summary !== 'string' || !Array.isArray(result.findings) || result.findings.length > 12 || !strings(result.read) || !strings(result.blind)
      || result.findings.some(f => !f || !['title', 'path', 'trigger'].every(k => typeof f[k] === 'string' && f[k].length > 0 && f[k].length <= 2000) || !strings(f.evidence) || !f.evidence.length))
    || JSON.stringify(result).length > 18000)) return res.status(400).json({ error: 'A complete bounded diagnostic result is required.' });
  const r = await q(`UPDATE autopilot_jobs SET status = $1, advice = $2, detail = $3, finished_at = now()
    WHERE id = $4 AND project_id = $5 AND kind = 'specialist' AND status IN ('claimed', 'running') AND ($6::text IS NULL OR specialist_spec->>'head' = $6) AND ($7::text IS NULL OR specialist_spec->>'base' = $7) RETURNING id`,
    [status, status === 'done' ? JSON.stringify(result) : null, String(detail || '').slice(0, 500), req.params.id, req.project.id, status === 'done' ? result.provenance.head : null, status === 'done' ? result.provenance.base : null]);
  if (!r.rowCount) return res.status(409).json({ error: 'Run is not active, or evidence does not match its requested revision.' });
  res.json({ ok: true });
});
