import { Router } from 'express';
import { q } from '../db.js';
import { termAgentConnected, termSessions, termTails, termDetached, termDetachedTails, setDetachedLabel, killDetachedTmux } from '../term.js';
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

// GET /api/terminal/agent — is the host daemon's uplink live right now? The
// watchdog cron (#221) polls this: an unambiguous connected flag, unlike
// /detached whose empty list also just means "no orphans".
terminal.get('/agent', (_req, res) => {
  res.json({ connected: termAgentConnected() });
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

// POST /api/terminal/assist {prompt, cwd} — ✧ command help for the terminal
// rail: the user says what they want to do, Gemini suggests ONE shell command
// (plus a short label so it can be saved as a quick command). Suggestion only —
// the client types it into the terminal for the human to run, never executes.
// 503 without a key (silent degrade upstream).
terminal.post('/assist', async (req, res) => {
  if (!geminiEnabled()) return res.status(503).json({ error: 'Gemini is not configured on the server.' });
  const ask = String(req.body?.prompt || '').trim().slice(0, 500);
  if (!ask) return res.status(400).json({ error: 'Say what you want to do.' });
  const cwd = String(req.body?.cwd || '').replace(/[^\w\s./~-]/g, '').slice(0, 200);
  try {
    const out = await askGemini(
      `A solo developer is at a bash terminal on their own Linux host (Debian, git, docker compose,
node/npm installed), working in ${cwd ? `~/${cwd}` : 'their home directory'}. They asked:

"${ask}"

Suggest the single best shell command for that. Prefer plain, widely-known commands; no sudo unless
the task truly needs it; never suggest anything destructive without an explicit flag the user would
recognise (and say so in the explanation).

Respond with ONLY this JSON:
{ "command": "<the one-line command>", "label": "<2-4 word label for saving it as a quick command>",
  "explanation": "<one short sentence on what it does / any caveat>" }`,
      { generation: { temperature: 0.2 } }
    );
    const command = typeof out?.command === 'string' ? out.command.trim() : '';
    if (!command) return res.status(502).json({ error: 'No suggestion came back — try rewording.' });
    res.json({
      command: command.slice(0, 300),
      label: (typeof out?.label === 'string' ? out.label.trim() : '').slice(0, 40) || command.slice(0, 24),
      explanation: (typeof out?.explanation === 'string' ? out.explanation.trim() : '').slice(0, 200),
    });
  } catch (e) {
    res.status(e.httpStatus || 502).json({ error: e.message || 'Assist failed.' });
  }
});

// One Gemini pass over EVERY session with content — the browser-attached ones
// (relay output tail) and the detached tmux survivors (the daemon captures a
// pane tail with each advertisement). Detached labels stick to the relay's
// name-keyed cache so they ride every later GET too.
terminal.post('/label', async (_req, res) => {
  if (!geminiEnabled()) return res.status(503).json({ error: 'Gemini is not configured on the server.' });
  const tails = termTails().filter(({ meta }) => (meta.tail || '').trim().length > 0);
  const orphans = termDetachedTails().filter((d) => (d.tail || '').trim().length > 0);
  if (tails.length || orphans.length) {
    const blocks = [
      ...tails.map(({ sid, meta }) =>
        `Session ${sid} (${meta.cmd} in ${meta.cwd}) — recent output:\n${meta.tail.trim().slice(-1200)}`),
      ...orphans.map((d) =>
        `Session ${d.name} (claude in ${d.cwd || '~'}, ${d.attached ? 'attached on another device' : 'running detached — no one watching'}) — recent output:\n${d.tail.trim().slice(-1200)}`),
    ].join('\n\n---\n\n');
    try {
      const out = await askGemini(
        `These are terminal sessions on a solo developer's machine. From each session's recent
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
      for (const d of orphans) {
        const label = out?.labels?.[d.name];
        if (typeof label === 'string' && label.trim()) setDetachedLabel(d.name, label.trim().slice(0, 60));
      }
    } catch (e) {
      return res.status(e.httpStatus || 502).json({ error: e.message || 'Labelling failed.' });
    }
  }
  res.json({ sessions: termSessions(), detached: termDetached() });
});
