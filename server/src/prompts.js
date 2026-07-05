// The Gemini prompt templates, in one place instead of hardcoded per route.
// Each template can be replaced wholesale via a server env var (multiline is
// fine — set it in the deploy env): GEMINI_JUDGE_PROMPT / GEMINI_INTAKE_PROMPT.
// {{TOKENS}} are substituted at call time; unknown tokens render empty. Keep
// the JSON shape instructions intact in any override — the routes validate
// against them.

const DEFAULTS = {
  judge: `You are helping curate a side project's idea funnel. The project's north star
(the one-paragraph statement of what it is becoming) is:

"{{NORTH_STAR}}"

Judge this idea against that north star:
Title: {{TITLE}}
{{NOTE_LINE}}

Verdicts: "on-course" (pulls directly toward the north star), "tangent" (worthwhile-ish but
sideways — doesn't serve the core direction), "off-course" (pulls away from or against it).
Use en-AU spelling. Respond with ONLY this JSON:
{ "alignment": "on-course|tangent|off-course", "why": "one plain sentence, under 25 words" }`,

  intake: `You are sorting a raw brain-dump of ideas for a side project into its planning system.
{{NORTH_STAR_BLOCK}}
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
{{DUMP}}`,
};

const ENV_KEYS = { judge: 'GEMINI_JUDGE_PROMPT', intake: 'GEMINI_INTAKE_PROMPT' };

export function buildPrompt(name, vars) {
  const template = process.env[ENV_KEYS[name]] || DEFAULTS[name];
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''));
}
