import { Router } from 'express';
import { q } from '../db.js';
import { termSessions, termTails, termDetached, killDetachedTmux } from '../term.js';
import { askGemini, geminiEnabled } from '../gemini.js';
import { readSettings } from '../settings.js';

// Mounted at /api/terminal — Mission Control's view of the live web-terminal
// sessions (#120). The relay already tracks per-sid metadata + a rolling
// output tail; this route is the ✧ labeller: one Gemini call names what each
// session appears to be doing. Annotation only — labels sit on the in-memory
// session rows and die with them. 503 without a key (silent degrade upstream).
export const terminal = Router();

// GET /api/terminal/usage — token consumption and budget for the terminal header.
// tokensToday: sum of autopilot_runs.tokens over the last 24 hours (BIGINT → Number).
// tokenBudget: settings.autopilot_tokens (0 = unlimited).
// COALESCE guards against an empty autopilot_runs table (fresh install).
terminal.get('/usage', async (_req, res) => {
  const [runRow, appSettings] = await Promise.all([
    q(`SELECT COALESCE(SUM(tokens), 0) AS tokens_today
         FROM autopilot_runs
        WHERE finished_at >= now() - interval '24 hours'`),
    readSettings(),
  ]);
  res.json({
    tokensToday: Number(runRow.rows[0]?.tokens_today ?? 0),
    tokenBudget: Number(appSettings.autopilot_tokens ?? 0),
  });
});

// GET /api/terminal/detached — surviving tmux sessions with no client attached
// (#188 follow-up): what a page reload orphans. Served from the relay's cache
// (the daemon pushes updates); empty while the daemon is offline.
terminal.get('/detached', (_req, res) => {
  res.json({ sessions: termDetached() });
});

// POST /api/terminal/detached/kill {name} — kill an orphaned tmux session on
// the host. The daemon double-checks the name is actually detached before
// killing, so a live session can never be killed through this route.
terminal.post('/detached/kill', (req, res) => {
  const name = String(req.body?.name || '');
  if (!/^stack-term-[A-Za-z0-9_-]{1,64}$/.test(name)) return res.status(400).json({ error: 'Bad session name.' });
  if (!killDetachedTmux(name)) return res.status(503).json({ error: 'The terminal daemon is not connected.' });
  res.json({ ok: true });
});

terminal.post('/label', async (_req, res) => {
  if (!geminiEnabled()) return res.status(503).json({ error: 'Gemini is not configured on the server.' });
  const tails = termTails().filter(({ meta }) => (meta.tail || '').trim().length > 0);
  if (tails.length) {
    const blocks = tails.map(({ sid, meta }) =>
      `Session ${sid} (${meta.cmd} in ${meta.cwd}) — recent output:\n${meta.tail.trim().slice(-1200)}`).join('\n\n---\n\n');
    try {
      const out = await askGemini(
        `These are live terminal sessions on a solo developer's machine. From each session's recent
output, write one SHORT label (max 8 words, plain, no punctuation flourishes) saying what the
session appears to be doing right now — e.g. "editing the deploy config", "claude building the
roadmap board", "idle shell".

${blocks}

Respond with ONLY this JSON: { "labels": { "<session id>": "<label>", ... } }`,
        { generation: { temperature: 0.2 } }
      );
      for (const { sid, meta } of tails) {
        const label = out?.labels?.[sid];
        if (typeof label === 'string' && label.trim()) meta.label = label.trim().slice(0, 60);
      }
    } catch (e) {
      return res.status(e.httpStatus || 502).json({ error: e.message || 'Labelling failed.' });
    }
  }
  res.json({ sessions: termSessions() });
});
