// The prompt templates, in one place instead of hardcoded per route. Each can
// be replaced wholesale via a server env var (multiline is fine — set it in the
// deploy env); ENV_KEYS at the bottom is the map, and the GEMINI_ prefix on the
// older keys is a misnomer #364 chose not to break. {{TOKENS}} are substituted
// at call time; unknown tokens render empty. Keep the JSON shape instructions
// intact in any override — the routes validate against them.
//
// A CAPPED LIST INSIDE A PROMPT MUST SAY IT IS CAPPED, AND ON THE RIGHT AXIS
// (#239). The rule was written for the bug audit's KNOWN_BUGS list and outlived
// it, because every template here carries lists a route had to cut somewhere.
// Two halves, and the second is the one that gets forgotten:
//   • SAY SO. A model reads "what is already tracked" as complete and reasons
//     from ABSENCE, so a silent slice does not merely omit — it asserts that
//     nothing is known about whatever fell off the end. State the true total
//     beside the shown count ("the 6 worst of 23 open bugs").
//   • CUT ON THE AXIS THE READER CARES ABOUT. A LIMIT on created_at DESC keeps
//     twenty recent trivia and drops the long-standing criticals, which are
//     exactly the rows the prompt existed to carry. Order by what makes a row
//     worth knowing (severity, queue order), and let recency break ties.
// This is the statement every capped prompt in the codebase points at.

const DEFAULTS = {};

DEFAULTS.semantic = `You are a smoke-test judge. A web page was fetched and its visible text is below
(tags stripped, truncated). Judge this plain-language expectation about the page:

EXPECTATION: {{ASSERTION}}

Be strict but fair: judge only what the text can evidence. Respond with ONLY this JSON:
{ "pass": true|false, "reason": "one plain sentence, under 20 words" }

PAGE TEXT:
{{PAGE}}`;

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

DEFAULTS.titler = `You are naming a roadmap item for a side project. The author wrote what they
want done (the note below); distil it into the item's title: a short imperative,
12 words or fewer, concrete, no trailing punctuation. Use en-AU spelling.
{{NORTH_STAR_LINE}}

THE NOTE:
{{NOTE}}

Respond with ONLY this JSON:
{ "title": "the title" }`;

DEFAULTS.assist = `You are filling in a roadmap item's fields for a side project's planning board.
The author wrote what they want done (the note below); everything comes from it.
{{NORTH_STAR_LINE}}
{{GUIDANCE_LINE}}
Known areas on this project: {{AREAS}}
Open branches (parallel work streams that claim items): {{BRANCHES}}

Produce:
- "title": a short imperative, 12 words or fewer, no trailing punctuation. When the work clearly
  targets one surface of the app, LEAD with it (e.g. "Roadmap modal: …", "Dashboard: …").
- "note": the author's note tidied — same intent, every concrete requirement kept, but structured
  and concise (short lines or dot points, typos fixed, filler dropped). Written for the agent
  that will build it; brevity saves tokens.
- "area": the product area, lowercase, one or two words. Prefer a known area when one fits;
  otherwise coin a sensible new one.
- "branch": one of the open branches ONLY if the note clearly belongs to that stream, else "".
- "priority": "highest" | "high" | "medium" | "low" | "lowest" — how necessary the work is.
  Be honest and use the whole scale: "highest" is for work that blocks or breaks something, and
  most things are not that. "high" is the sensible default for real work somebody asked for.
- "risk": "low" | "normal" | "high" — how much care the change needs, read from what the note
  describes touching. "low" is a small, contained, easily-reversed change (copy, one component,
  a setting) — it is the level that lets a green overnight run merge itself, so only say it when
  you would be comfortable with that. "high" is auth, data migrations, deletion, money, anything
  the note calls risky or says to be careful with. "normal" is everything else, and "" when the
  note gives you nothing to read it from.

DO NOT ANSWER WITH A SPRINT, a rank, or any opinion about what should be built next. What runs
next is the order of the sprint the owner drags the item into, and that is theirs alone.

THE NOTE:
{{NOTE}}

Use en-AU spelling. Respond with ONLY this JSON:
{ "title": "…", "note": "…", "area": "…", "branch": "…", "priority": "highest|high|medium|low|lowest",
  "risk": "low|normal|high|" }`;




DEFAULTS.reviewbrief = `You are the reviewer's assistant on a side project command centre. A change is
awaiting a human verdict (solid / rethink). Write it up so the reviewer can judge quickly without
re-reading everything.
{{NORTH_STAR_LINE}}
{{STAGE_LINE}}

The item:
#{{ID}} ({{BUCKET}}) {{TITLE}}
{{NOTE_LINE}}
What the builder says landed: {{BUILT_NOTE}}
{{RUN_BLOCK}}
{{CHECKS_BLOCK}}

Produce:
- "summary": 2-3 plain sentences on what actually shipped, in the reviewer's terms — cut through
  the builder's own framing, note anything claimed but not evidenced.
- "test": 3-6 concrete hands-on steps to verify it works, most telling first (real clicks,
  commands or URLs — not "check it works").
- "risks": up to 3 specific things most likely to be broken or missed, judged from what was
  described. Omit generic advice; an empty list is fine.

Use en-AU spelling. Respond with ONLY this JSON:
{ "summary": "…", "test": ["…"], "risks": ["…"] }`;

// Turn 3 — the ✦ draft behind the Refine dialog. The reviewer has looked at a
// completed item and wants it sent back with a DELTA: only what to change on
// top of what landed. This writes a first pass at that sentence.
//
// Note what it is NOT given: the diff. The server cannot read the repository,
// so the material is the RECORD — the
// session's own account, the second model's read of the diff, the architect's
// structural read, the files the work touched. The reviewer's note is a read of
// the diff and is the closest thing here to one; the prompt says so plainly so
// the model does not write as though it had seen the code.
DEFAULTS.triage = `You are a triage assistant for a side project command centre's review inbox.
The inbox holds auto-extracted bugs, roadmap items and ideas that no human has approved yet.
Your job is purely advisory — the human keeps or dismisses each item themselves.

INBOX ITEMS (id | kind | project | title | meta):
{{ITEMS}}

Produce three kinds of annotation:

1. "clusters": groups of items that look like the SAME underlying thing (same root cause, same
   feature, or clearly duplicated title). Only cluster items across different projects when it is
   unmistakeable. Omit clusters of one. Each cluster lists the item refs.
   A ref is "<kind>:<slug>:<id>" — use EXACTLY the format from the input.

2. "severityFlags": items where the recorded severity looks wrong (bugs only). For each flag:
   the ref, the recorded severity, your suggested severity and one reason sentence.
   Only flag clear mis-calls — minor differences are not worth flagging.

3. "suggestions": one keep/dismiss lean per item, with a one-line reason (≤ 20 words).
   "keep" = the item looks actionable and genuinely distinct.
   "dismiss" = likely noise, a duplicate of something tracked elsewhere, or too vague to act on.
   Include EVERY item in this list.

Use en-AU spelling. Respond with ONLY this JSON:
{
  "clusters":      [ { "label": "short description of the shared theme",
                       "refs": ["bug:slug:BUG-1", "roadmap:slug:42"] } ],
  "severityFlags": [ { "ref": "bug:slug:BUG-2", "current": "low", "suggested": "high",
                       "reason": "one sentence" } ],
  "suggestions":   [ { "ref": "bug:slug:BUG-3", "action": "keep|dismiss",
                       "reason": "one sentence, under 20 words" } ]
}`;

const ENV_KEYS = {
  judge: 'GEMINI_JUDGE_PROMPT',
  futureorbits: 'GEMINI_FUTUREORBITS_PROMPT',
  futurerestate: 'GEMINI_FUTURERESTATE_PROMPT',
  semantic: 'GEMINI_SEMANTIC_PROMPT',
  pushnote: 'GEMINI_PUSHNOTE_PROMPT',
  titler: 'GEMINI_TITLER_PROMPT',
  assist: 'GEMINI_ASSIST_PROMPT',
  reviewbrief: 'GEMINI_REVIEWBRIEF_PROMPT',
  triage: 'GEMINI_TRIAGE_PROMPT',
  // GONE with the agent registry (#520): `cleanup` (GEMINI_CLEANUP_PROMPT) and
  // the Curator's two board reads, `arrange` and `allocate` (STACK_ARRANGE_PROMPT,
  // STACK_ALLOCATE_PROMPT). All three had lost their surfaces years of commits
  // before they lost their routes. An override still set against one of those
  // env vars on a live deploy now does nothing — that is the whole cost of
  // removing a key, and it is why the two that SURVIVE keep their misnamed
  // GEMINI_ prefix rather than being tidied into something accurate.
};

export function buildPrompt(name, vars) {
  const template = process.env[ENV_KEYS[name]] || DEFAULTS[name];
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''));
}
