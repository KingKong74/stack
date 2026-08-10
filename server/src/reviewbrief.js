// The reviewer's brief (#134, #273): what actually shipped, hands-on test
// steps, likely risks — composed from the item, its built_note, the autopilot
// run that built it and the project's checks. Shared logic because two
// callers want it: the explicit ✧ Brief re-ask (routes/roadmap.js) and the
// automatic write at run end (routes/autopilot.js).

import { q } from './db.js';
import { askGemini, geminiEnabled } from './gemini.js';
import { buildPrompt } from './prompts.js';

// #239's rule — a capped thing inside a prompt must SAY it is capped. A silent
// slice here was the last of BUG-12 and the worst-placed one: the column is
// already stored capped-out-loud at NOTE_MAX, and this cut at the same 2000
// took capNote's own marker off the end, so a note that had been truncated
// reached Gemini looking whole. Cutting at all is right — a prompt has a budget
// — but it has to leave the sentence that says so.
const clip = (v, max) => {
  const t = String(v ?? '').trim();
  return t.length > max
    ? `${t.slice(0, max).trimEnd()}\n[truncated for this brief — ${t.length} characters in full]`
    : t;
};

// Compose the brief for a completed roadmap item. Returns { brief, runId }:
// `brief` is { summary, test, risks } or null when Gemini returned nothing
// usable; `runId` is the id of the newest landed run for the item (or null
// when none was recorded). Callers decide what a null brief means for their
// own response — this only ever composes, never decides HTTP status.
// askGemini's errors propagate — callers catch as they see fit.
export async function composeReviewBrief(project, item) {
  const [{ rows: runRows }, { rows: checkRows }] = await Promise.all([
    q(
      `SELECT id, branch, commits, summary FROM autopilot_runs
        WHERE project_id = $1 AND item_id = $2 AND outcome = 'landed'
        ORDER BY finished_at DESC LIMIT 1`,
      [project.id, item.id]
    ),
    q('SELECT name, last_status FROM checks WHERE project_id = $1 ORDER BY id LIMIT 12', [project.id]),
  ]);
  const run = runRows[0];
  const prompt = buildPrompt('reviewbrief', {
    ID: String(item.id),
    BUCKET: item.bucket,
    TITLE: item.title,
    NOTE_LINE: item.note ? `The item's note: ${clip(item.note, 1000)}` : '',
    BUILT_NOTE: clip(item.built_note || '(none recorded)', 2400),
    RUN_BLOCK: run
      ? `Built by an unattended session on branch ${run.branch} (${run.commits} commit${run.commits === 1 ? '' : 's'}). The session's own account:\n${clip(run.summary, 3000)}`
      : 'No autopilot run recorded for it — likely built by hand or an interactive session.',
    CHECKS_BLOCK: checkRows.length
      ? `The project's HTTP checks (runnable from the Bugs tab): ${checkRows.map((c) => `${c.name} (${c.last_status || 'never run'})`).join(', ')}`
      : '',
    NORTH_STAR_LINE: project.north_star
      ? `For context, the project's north star: "${String(project.north_star).slice(0, 400)}"`
      : '',
  });
  const answer = await askGemini(prompt, { timeoutMs: 25_000 });
  const summary = String(answer?.summary || '').trim().slice(0, 1200);
  if (!summary) return { brief: null, runId: run?.id ?? null };
  const list = (v, cap) => (Array.isArray(v) ? v : [])
    .map((s) => String(s).trim().slice(0, 300)).filter(Boolean).slice(0, cap);
  return {
    brief: { summary, test: list(answer?.test, 6), risks: list(answer?.risks, 3) },
    runId: run?.id ?? null,
  };
}

// Persist a composed brief onto the run it describes. No-op when there is no
// run to attach it to or no brief to store — a caller can pass either through
// unchecked.
export async function storeReviewBrief(projectId, runId, brief) {
  if (!runId || !brief) return;
  await q(
    `UPDATE autopilot_runs SET review_brief = $1::jsonb, review_brief_at = now()
      WHERE project_id = $2 AND id = $3`,
    [JSON.stringify(brief), projectId, runId]
  );
}

// The run-end path (#273): fire-and-forget from POST /runs when a run lands,
// so the Review room's queue already carries a brief by the time a human
// opens it. Deliberately silent end to end — a Gemini call is normal to fail
// (keyless, rate limit, timeout) and a missing brief is never a failed run.
// Does NOT require item.done: at run end the human has not necessarily ticked
// anything yet, and the landed run itself is the evidence the brief describes.
export async function autoReviewBrief(project, itemId, runId) {
  try {
    if (!geminiEnabled()) return;
    const { rows } = await q(
      'SELECT * FROM roadmap_items WHERE project_id = $1 AND id = $2',
      [project.id, itemId]
    );
    const item = rows[0];
    if (!item) return;
    // Store against the run id THIS call was given (the run that just
    // landed), not whatever composeReviewBrief's own "newest landed run"
    // lookup finds — the two are the same run in the ordinary case, but the
    // caller's id is the one the record is actually about.
    const { brief } = await composeReviewBrief(project, item);
    await storeReviewBrief(project.id, runId, brief);
  } catch (err) {
    console.error('autoReviewBrief failed:', err?.message || err);
  }
}
