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

DEFAULTS.semantic = `You are a smoke-test judge. A web page was fetched and its visible text is below
(tags stripped, truncated). Judge this plain-language expectation about the page:

EXPECTATION: {{ASSERTION}}

Be strict but fair: judge only what the text can evidence. Respond with ONLY this JSON:
{ "pass": true|false, "reason": "one plain sentence, under 20 words" }

PAGE TEXT:
{{PAGE}}`;

DEFAULTS.replan = `You are helping someone re-enter a side project they haven't touched in a while.
Project: {{NAME}} (last push {{LAST_PUSH}})
{{NORTH_STAR_LINE}}
Current phase: {{PHASE}}
Last summary: {{SUMMARY}}
In progress when they left: {{IN_PROGRESS}}
Suggested next (from back then): {{NEXT_UP}}
Blockers: {{BLOCKERS}}
Open bugs: {{BUGS}}
Open roadmap (bucket — title): {{ROADMAP}}

Write a short, calm re-entry plan for their FIRST session back: two or three sentences of
"where you actually left off", then 3-5 numbered steps ordered to rebuild momentum (start
small and verifiable, then the highest-value open work). Reference real items from above —
no invented work. Use en-AU spelling. Respond with ONLY this JSON:
{ "plan": "the plan as plain text — short paragraph, then numbered lines separated by \\n" }`;

DEFAULTS.pushnote = `You are the second model keeping a quiet eye on a solo builder's side project.
A session just pushed. Give ONE useful outside take on it: the sharpest next move, a risk the
summary hints at, or a question worth asking before the next session. Ground it in the text
below — never invent work that isn't implied.
Project: {{NAME}}
{{NORTH_STAR_LINE}}
Phase: {{PHASE}}
Push summary: {{SUMMARY}}
Next steps noted: {{NEXT_STEPS}}

Use en-AU spelling. Respond with ONLY this JSON:
{ "note": "one or two plain sentences, under 40 words" }`;

const ENV_KEYS = {
  judge: 'GEMINI_JUDGE_PROMPT',
  intake: 'GEMINI_INTAKE_PROMPT',
  semantic: 'GEMINI_SEMANTIC_PROMPT',
  replan: 'GEMINI_REPLAN_PROMPT',
  pushnote: 'GEMINI_PUSHNOTE_PROMPT',
};

export function buildPrompt(name, vars) {
  const template = process.env[ENV_KEYS[name]] || DEFAULTS[name];
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''));
}
