import { Router } from 'express';
import { projectBySlug } from '../resolve.js';
import { askGemini, geminiEnabled } from '../gemini.js';

// POST /api/projects/:slug/intake — the idea dump sorter. Takes a pile of raw
// lines, has Gemini judge each against the north star and propose a
// destination: a MoSCoW bucket (concrete, startable work) or the Futures
// funnel with an alignment (directional what-ifs). Returns SUGGESTIONS only —
// the client shows them for review/override and creates the accepted items
// through the normal CRUD routes. Gemini proposes, the human disposes.
export const intake = Router({ mergeParams: true });

intake.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

const DESTS = ['must', 'should', 'could', 'wont', 'future'];
const ALIGNMENTS = ['on-course', 'tangent', 'off-course'];

intake.post('/', async (req, res) => {
  if (!geminiEnabled()) {
    return res.status(503).json({ error: 'Gemini is not configured on this server (set GEMINI_API_KEY).' });
  }
  const text = String(req.body?.text || '').trim().slice(0, 8000);
  if (!text) return res.status(400).json({ error: 'Nothing to sort.' });
  const northStar = String(req.project.north_star || '').trim();

  const prompt = `You are sorting a raw brain-dump of ideas for a side project into its planning system.
${northStar ? `The project's north star (what it is becoming):\n"${northStar}"\n` : 'The project has no north star written yet — judge by the dump itself.\n'}
The planning system has two homes:
- The MoSCoW roadmap, for concrete work someone could start tomorrow. Buckets: "must"
  (essential this round), "should" (important, not critical), "could" (nice to have),
  "wont" (explicitly parked this round). Be honest — most things are NOT must.
- The Futures funnel ("future"), for directional what-ifs and shapeless ideas worth keeping
  but not startable as written. Each future gets an alignment verdict against the north star:
  "on-course", "tangent" or "off-course" (null if there is no north star).

Sort EVERY distinct idea in the dump below (lines may wrap; split or merge sensibly, keep the
author's intent). Clean each title into a short imperative (≤ 15 words, en-AU spelling); put any
leftover detail in the note.

Respond with ONLY this JSON:
{ "items": [ { "title": "…", "note": "…", "dest": "must|should|could|wont|future",
               "alignment": "on-course|tangent|off-course" | null,
               "why": "one plain sentence, under 20 words" } ] }

THE DUMP:
${text}`;

  try {
    const answer = await askGemini(prompt, { timeoutMs: 45_000 });
    const items = (Array.isArray(answer?.items) ? answer.items : [])
      .slice(0, 20)
      .map((it) => ({
        title: String(it?.title || '').trim().slice(0, 300),
        note: String(it?.note || '').trim().slice(0, 1000),
        dest: DESTS.includes(it?.dest) ? it.dest : 'should',
        alignment: it?.dest === 'future' && ALIGNMENTS.includes(it?.alignment) ? it.alignment : null,
        why: String(it?.why || '').trim().slice(0, 300),
      }))
      .filter((it) => it.title);
    if (!items.length) return res.status(502).json({ error: 'Gemini found nothing sortable — try rewording.' });
    res.json({ items });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Gemini call failed.' });
  }
});
