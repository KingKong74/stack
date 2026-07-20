import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { askGemini, geminiEnabled } from '../gemini.js';
import { buildPrompt } from '../prompts.js';

// POST /api/projects/:slug/polaris — the Futures tab's Gemini terminal. Free
// chat, grounded in the project's live state (north star, open roadmap, the
// idea funnel, bug count). Returns a REPLY only — Polaris reads state, never
// writes it; anything worth tracking goes through the normal CRUD routes via
// the terminal's /sort flow. Gemini proposes, the human disposes.
export const polaris = Router({ mergeParams: true });

polaris.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

const cap = (s, n) => String(s || '').trim().slice(0, n);

polaris.post('/', async (req, res) => {
  if (!geminiEnabled()) {
    return res.status(503).json({ error: 'Gemini is not configured on this server (set GEMINI_API_KEY).' });
  }
  const message = cap(req.body?.message, 4000);
  if (!message) return res.status(400).json({ error: 'Nothing to say.' });

  // Last few turns, bounded — the terminal is a scratchpad, not an archive.
  const history = (Array.isArray(req.body?.history) ? req.body.history : [])
    .slice(-12)
    .map((t) => `${t?.role === 'polaris' ? 'polaris' : 'you'}: ${cap(t?.text, 500)}`)
    .join('\n');

  const p = req.project;
  const [roadR, futR, bugR] = await Promise.all([
    q(`SELECT bucket, title FROM roadmap_items
        WHERE project_id = $1 AND NOT done AND bucket IN ('must','should')
        ORDER BY bucket, position LIMIT 20`, [p.id]),
    q(`SELECT title, alignment FROM futures WHERE project_id = $1
        ORDER BY created_at DESC LIMIT 12`, [p.id]),
    q(`SELECT count(*)::int AS n FROM bugs WHERE project_id = $1 AND status <> 'fixed'`, [p.id]),
  ]);

  const prompt = buildPrompt('polaris', {
    NAME: p.name,
    NORTH_STAR_LINE: p.north_star
      ? `North star: ${cap(p.north_star, 500)}`
      : 'North star: (not written yet — nudge them to set one when direction comes up)',
    PHASE: cap(p.current_phase, 200) || '—',
    ROADMAP: roadR.rows.map((r) => `${r.bucket} — ${r.title}`).join('; ') || 'nothing open',
    FUTURES: futR.rows.map((f) => f.title + (f.alignment ? ` (${f.alignment})` : '')).join('; ') || 'empty',
    BUGS: String(bugR.rows[0].n),
    HISTORY: history || '(fresh session)',
    MESSAGE: message,
  });

  try {
    const answer = await askGemini(prompt, { timeoutMs: 45_000, generation: { temperature: 0.6 } });
    const reply = cap(answer?.reply, 4000);
    if (!reply) return res.status(502).json({ error: 'Gemini returned an empty reply.' });
    res.json({ reply });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || 'Gemini call failed.' });
  }
});
