import { Router } from 'express';
import { termSessions, termTails } from '../term.js';
import { askGemini, geminiEnabled } from '../gemini.js';

// Mounted at /api/terminal — Mission Control's view of the live web-terminal
// sessions (#120). The relay already tracks per-sid metadata + a rolling
// output tail; this route is the ✧ labeller: one Gemini call names what each
// session appears to be doing. Annotation only — labels sit on the in-memory
// session rows and die with them. 503 without a key (silent degrade upstream).
export const terminal = Router();

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
