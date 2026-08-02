import { Router } from 'express';
import { agentClient } from '../agents.js';

// #364 — the MERGE AGENT's read, the one op that needs the code itself.
//
// The Merge room plans in the browser and the plan is arithmetic: order the
// mergeable branches, then fill each wave with branches whose AREAS do not
// collide. That is a good ordering and it is also a shallow one — the area is
// the commonest directory prefix in a branch's file list, so two branches can
// sit in different areas and still be about to fight over the same function.
// The probe cannot see it either: each branch merges cleanly against main, and
// nothing has ever asked whether they merge cleanly against EACH OTHER.
//
// So this route hands the plan to a model that reads the actual diffs. It is
// the Merge agent's only op, it is advisory, and it writes nothing: the answer
// is annotations on a plan the human still presses.
//
// The diffs are gathered on the HOST, not here. The server holds a ~10-minute
// branch report, never the code — the repos live on the host behind the
// firewall — so `diffs` rides down the daemon's uplink and the host reads
// `git diff origin/main...<branch>` itself, caps it, and says what it capped.
export const merge = Router();

const merger = agentClient('merger');

// Truncation that admits it. A silently sliced sentence is indistinguishable
// from a model that trailed off mid-thought.
const clip = (v, max) => {
  const t = String(v || '');
  return t.length > max ? `${t.slice(0, max).trimEnd()}… (truncated)` : t;
};

// A branch the client proposes, as part of a wave. Cleaned hard because every
// field here ends up in an argv or a git ref on the host.
const cleanBranch = (b) => {
  const slug = String(b?.slug || '').trim().slice(0, 80);
  const branch = String(b?.branch || '').trim().slice(0, 120);
  if (!slug || !branch || !/^[\w./-]+$/.test(branch) || !/^[\w.-]+$/.test(slug)) return null;
  return { slug, branch, area: String(b?.area || '').slice(0, 80) };
};

// POST /api/merge/review  { waves: [[{slug, branch, area}, …], …] }
//   -> { verdict, summary, notes: [{ branches, severity, text }], read: [...] }
merge.post('/review', async (req, res) => {
  const waves = (Array.isArray(req.body?.waves) ? req.body.waves : [])
    .slice(0, 8)
    .map((w) => (Array.isArray(w) ? w.map(cleanBranch).filter(Boolean).slice(0, 12) : []))
    .filter((w) => w.length);
  const flat = waves.flat();
  if (!flat.length) return res.status(400).json({ error: 'No branches in the plan to read.' });

  const planText = waves
    .map((w, i) => `Wave ${i + 1}:\n${w.map((b) => `  - ${b.slug}/${b.branch}${b.area ? ` (area: ${b.area})` : ''}`).join('\n')}`)
    .join('\n\n');

  // The escape hatch is explicit and comes first, because a model asked for
  // findings produces findings. An ordering that is simply fine is the COMMON
  // case and has to be sayable, or every plan comes back with a manufactured
  // concern dressed as a finding — the same lesson the ✎ Refine draft learned.
  const prompt = `You are reviewing a plan to merge several git branches into main, one after another,
in the order below. Each branch has already been probed and merges cleanly INTO MAIN on its own.
That is not the question. The question is whether merging them in this order, back to back, is
likely to break something — because nothing has tested any pair of them TOGETHER.

The branches are grouped into "waves". The planner put two branches in different waves when their
file paths suggested they touch different areas. You can see the actual diffs, which the planner
could not.

Look for, in order of what actually matters:
  1. Two branches that change the same function, type, schema or contract in ways that compile
     separately and are wrong together.
  2. A branch that depends on something another branch removes or renames.
  3. Two branches that both edit the same file in overlapping ways git will merge silently.

THE PLAN:
${planText}

IMPORTANT: "this ordering is fine" is a complete and expected answer. Most plans are fine. Do NOT
invent a concern to have something to say, and do not report that two branches "both touch the
frontend" or "should be tested" — that is true of everything and helps nobody. Only report a
pairing you can point at a specific shared thing in the diffs for. If a diff was truncated, say so
rather than guessing about the part you could not see.

Respond with ONLY this JSON:
{"verdict":"ok"|"concerns","summary":"one sentence","notes":[{"branches":["slug/branch","slug/branch"],"severity":"warn"|"info","text":"what they share and what breaks"}]}`;

  try {
    const answer = await merger.ask('mergeplan', prompt, {
      diffs: flat.map((b) => ({ slug: b.slug, branch: b.branch })),
      // Reading up to forty diffs is not a sentence-long job; the host kills at
      // this and the relay reports the kill rather than hanging the button.
      timeoutMs: 240_000,
    });
    const notes = (Array.isArray(answer?.notes) ? answer.notes : []).slice(0, 12).map((n) => ({
      branches: (Array.isArray(n?.branches) ? n.branches : []).map((x) => String(x).slice(0, 200)).slice(0, 6),
      severity: n?.severity === 'warn' ? 'warn' : 'info',
      // Roomy, and it SAYS when it cut. A finding of this kind is a chain of
      // reasoning about two diffs — the first cut at 600 sliced one off
      // mid-clause ("If 275's unshown portion edit"), which reads as a bug in
      // the agent rather than a cap in the route.
      text: clip(n?.text, 1400),
    })).filter((n) => n.text);
    res.json({
      // An empty `notes` with verdict 'ok' is the answer, not a failure — the
      // client renders "read it and found nothing", which is different from
      // "no read has run" and has to stay different.
      verdict: answer?.verdict === 'concerns' ? 'concerns' : 'ok',
      summary: clip(answer?.summary, 500),
      notes,
      // What was actually put in front of the model, so the panel can print the
      // list rather than a fixed caption claiming more than was read.
      read: flat.map((b) => `${b.slug}/${b.branch}`),
    });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || 'The Merge agent could not read the plan.' });
  }
});
