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
// `routes/console.js`'s cap() and `routes/workbench.js` both restate it at
// their own call sites; this is the statement they point at.

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
- "priority": "must" | "should" | "could" | "wont" — be honest, most things are not must.
- "tier": "S" | "A" | "B" | "C" — how much the OWNER is likely to want this NEXT, which is a
  different question from priority. Priority is how necessary the work is; tier is appetite, and
  it leads the run queue. Read the appetite the note is written with, not just what it asks for:
    S — they say they want it now, or it is blocking them today.
    A — real appetite: an irritation they name, something they say matters or keeps costing them.
    B — worth doing, written plainly, no urgency expressed. This is the honest default for a
        note that describes work without saying how much they want it.
    C — explicitly deferred: "eventually", "sometime", "no rush", "nice to have".
  Answer "" only when the note is a bare fragment with nothing to read appetite from at all.
  Do NOT abstain merely because the note is not explicit about wanting it — a considered B is
  more use than a blank, and you are not at risk of overriding anybody: the tier you give is
  applied only into a field the owner has left empty and untouched, and they re-rank freely.
  S is the one exception, because it decides what the machine builds tonight: answer S when the
  note really reads that way, but it is shown to the owner to accept rather than applied, so do
  not reach for it to signal mere enthusiasm.
- "risk": "low" | "normal" | "high" — how much care the change needs, read from what the note
  describes touching. "low" is a small, contained, easily-reversed change (copy, one component,
  a setting) — it is the tier that lets a green overnight run merge itself, so only say it when
  you would be comfortable with that. "high" is auth, data migrations, deletion, money, anything
  the note calls risky or says to be careful with. "normal" is everything else, and "" when the
  note gives you nothing to read it from.

THE NOTE:
{{NOTE}}

Use en-AU spelling. Respond with ONLY this JSON:
{ "title": "…", "note": "…", "area": "…", "branch": "…", "priority": "must|should|could|wont",
  "tier": "S|A|B|C|", "risk": "low|normal|high|" }`;

DEFAULTS.cleanup = `You are tidying a side project's roadmap board. Below are its OPEN items
(id | bucket | area | title | note). Known areas: {{AREAS}}
{{NORTH_STAR_LINE}}

Suggest fixes ONLY where something is actually off — an empty list is a fine answer:
- Missing area (area is "-"): suggest one, lowercase, one or two words; prefer known areas.
- Sloppy title: typos, vague one-worders, or missing the surface it targets — suggest a cleaned
  short imperative that keeps the author's intent.
- Clearly mis-bucketed: suggest the honest bucket ("must|should|could|wont").
Never invent new work, never merge or drop items, and only include a field you are changing.

THE ITEMS:
{{ITEMS}}

Use en-AU spelling. Respond with ONLY this JSON:
{ "items": [ { "id": 123, "area": "…", "title": "…", "bucket": "…",
               "why": "one plain sentence, under 15 words" } ] }`;

DEFAULTS.arrange = `You are sequencing a side project's timeline. Below are its scheduled and
unscheduled items (id | area | bucket | weeks | start | title | note). "start" is a WEEK INDEX from
the project's own week zero, or "-" when the item is not scheduled. Week {{NOW_WEEK}} is now.
{{NORTH_STAR_LINE}}

Arithmetic already handles the packing — closing gaps, stacking a lane, fitting a budget. Your job
is the ONE thing arithmetic cannot do: read what these items actually are and say what must come
BEFORE what. A pipeline before the dashboard that reads it. A data model before the feature built
on it. A migration before the code that assumes it.

Propose a start week for an item ONLY when its ORDER is wrong — an item scheduled before something
it depends on, or a dependency left unscheduled while its dependant is booked. Say nothing about
items whose order is already fine. AN EMPTY LIST IS THE RIGHT ANSWER for a board that is already
correctly ordered, and is much better than shuffling things to look busy.

Rules: never move an item earlier than week {{NOW_WEEK}}; never change how long something takes;
keep every item in its own area; and never propose more than eight moves.

THE ITEMS:
{{ITEMS}}

Use en-AU spelling. Respond with ONLY this JSON:
{ "moves": [ { "id": 123, "start": 12,
               "why": "one plain sentence naming what it depends on, under 20 words" } ] }`;

DEFAULTS.allocate = `You are filing a side project's untagged roadmap items into its AREAS. An area
is the part of the product a piece of work belongs to — it is what the timeline draws as a lane and
what every board filters by, so an item carrying none is in no lane and behind no chip.
{{NORTH_STAR_LINE}}

The areas this project already uses, with how many open items each one holds:
{{AREAS}}

{{CAP_LINE}}THE UNTAGGED ITEMS (id | bucket | title | note):
{{ITEMS}}

Give each item the area it belongs to. Rules:
- PREFER AN EXISTING AREA. Reach for one of the areas above whenever the work plausibly sits in it;
  the point of this is to fill the lanes the project already has, not to redraw them.
- Coin a new area only when a real group of items has no home above — lowercase, one or two words,
  and never one that is a near-synonym of an existing area.
- LEAVE AN ITEM OUT when you genuinely cannot tell what it is about. A short honest list beats a
  complete one full of guesses: an item left out stays exactly as it is now, and the owner files it
  by hand. AN EMPTY LIST IS A VALID ANSWER.
- Never rename, re-bucket, re-word, merge or drop anything. The only thing you decide is the area.

Use en-AU spelling. Respond with ONLY this JSON:
{ "picks": [ { "id": 123, "area": "…",
               "why": "one plain sentence naming what the item touches, under 15 words" } ] }`;

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
// Note what it is NOT given: the diff. The server cannot read the repository
// (same limit the Workbench ops document), so the material is the RECORD — the
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

// ---- the Workbench ops (the canvas that replaced the notes wall) ----
//
// Every op shares one frame: the card you ran it ON, the cards wired to it, and
// what Stack knows about the project. The frame is spliced into each template
// as {{CONTEXT}} so an override only has to restate its own instruction and
// JSON shape. Output is a CARD — a suggestion sitting on the canvas that the
// owner keeps, edits or cuts. No op writes tracker state; promoting a plan to
// the roadmap is a separate thing the human clicks.
DEFAULTS.wbcontext = `You are the thinking partner on a side project's planning canvas.

PROJECT: {{PROJECT}}
{{NORTH_STAR_LINE}}

THE CARD THIS WAS RUN ON ({{SELECTED_KIND}}):
{{SELECTED}}

WIRED TO IT ON THE CANVAS (what the owner has already connected — may be empty):
{{NEIGHBOURS}}

EVERYTHING ELSE ON THE CANVAS ({{CANVAS_SHOWN}} of {{CANVAS_TOTAL}} cards):
{{CANVAS}}

WHAT STACK KNOWS ABOUT THIS PROJECT:
{{RECORD}}

You can see ONLY what is above — you have no access to the source code. Never
claim to have read a file. Use en-AU spelling. Be concrete and short; this is a
card on a canvas, not an essay.`;

DEFAULTS.wbexpand = `{{CONTEXT}}

TASK — EXPAND. Turn this rough idea into 3 distinct readings of what it could
mean in practice. They must genuinely differ in shape or cost, not be three
wordings of one thing. Then add ONE closing observation naming the cheapest of
the three or a collision with something else on the canvas.

Respond with ONLY this JSON:
{ "title": "Expand — pick a reading of …", "choices": 3,
  "lines": [ { "mk": "A", "t": "…" }, { "mk": "B", "t": "…" }, { "mk": "C", "t": "…" },
             { "mk": "·", "t": "the closing observation" } ] }
Each "t" is one sentence under 22 words.`;

DEFAULTS.wbcluster = `{{CONTEXT}}

TASK — CLUSTER. Group the canvas into the 2–4 themes actually present. Name each
theme in the owner's own words where they used them, and say how many cards it
holds. Then flag any near-duplicate pair worth merging (use "!" as its marker);
if there is none, say so plainly rather than inventing one.

Respond with ONLY this JSON:
{ "title": "Cluster — pick a thread to work",
  "lines": [ { "mk": "1", "t": "\\"theme\\" — which cards, (n)" }, { "mk": "!", "t": "…" } ] }
Each "t" is one sentence under 22 words.`;

DEFAULTS.wbplan = `{{CONTEXT}}

TASK — DRAFT PLAN. Sequence this into 3–5 phases that each ship something on
their own. Phase 0 must be the cheapest thing that proves the idea works.
Every phase needs a GATE: the observable condition that must hold before the
next phase starts. A gate must be checkable from something the project already
records — if you want a metric nobody collects yet, make instrumenting it part
of an earlier phase instead.

"bucket" is how necessary the phase is: must | should | could | wont.
Later, riskier or clearly-deferred phases belong lower.

Respond with ONLY this JSON:
{ "title": "Phased plan — …",
  "phases": [ { "n": "P0", "t": "short phase name", "d": "one or two sentences on what ships",
                "gate": "the observable condition", "bucket": "must|should|could|wont" } ] }`;

DEFAULTS.wbblast = `{{CONTEXT}}

TASK — BLAST RADIUS. Say how far this reaches and what it destabilises. Cover
the read path, the write path, and schema/data changes — one line each, and say
"none" where there is none rather than padding. Grade the whole thing low,
medium or high in the title. Reason only from the record above; where you are
guessing, say the word.

Respond with ONLY this JSON:
{ "title": "Blast radius — low|medium|high",
  "lines": [ { "mk": "·", "t": "…" } ] }
3–5 lines, each one sentence under 24 words.`;

DEFAULTS.wbtouches = `{{CONTEXT}}

TASK — TOUCHES. From the files recent sessions actually touched and the open
bugs listed above, name what this work would most likely collide with: at most
6 chips, each a real file path or bug id copied EXACTLY from the record. Invent
nothing — if the record does not support a chip, leave it out. Then one line
saying what the list is based on and how confident that makes it.

Respond with ONLY this JSON:
{ "title": "Touches N files, M open bugs",
  "chips": [ "path/from/the/record.ts", "BUG-12" ],
  "lines": [ { "mk": "·", "t": "…" } ] }`;

DEFAULTS.wbcritique = `{{CONTEXT}}

TASK — CRITIQUE. Argue AGAINST this. Give the 3 strongest reasons not to build
it, or to build something else: evidence the canvas does not actually support
it, a cost being waved away, a surface it damages, an assumption about the
owner's behaviour that the record contradicts. No hedging, no balancing
positives. If the idea is genuinely sound, say which single part is weakest and
why — do not manufacture objections.

Respond with ONLY this JSON:
{ "title": "Counter-case", "lines": [ { "mk": "×", "t": "…" } ] }
Each "t" is one sentence under 26 words.`;

DEFAULTS.wbask = `{{CONTEXT}}

THE OWNER ASKS: {{QUESTION}}

TASK — ANSWER, strictly from the record above. You cannot read the source code,
so if the answer is not in the record, say exactly that and name what would
answer it (a file to open, a tab to check). A short honest "not in the record"
beats a plausible guess.

Respond with ONLY this JSON:
{ "title": "the question, restated in under 9 words",
  "lines": [ { "mk": "→", "t": "…" } ] }
1–4 lines, each one sentence under 26 words.`;

// #375 — the FOREMAN's read of one change, the Review room's headline op.
//
// It is the agent standing beside you at the moment you give the verdict, and
// what makes it worth anything is that it is honest about the gap between what
// it can see and what you are about to sign off. It has NOT seen the diff (the
// server has no checkout) — it has the record. So the answer carries "blind":
// what it could not see. A pre-verdict with no stated blind spots is a
// pre-verdict pretending to be a review.
//
// "look" is the expected answer and the prompt says so twice. A model asked for
// a call produces a confident one, and a confident "approve" off a built note
// nobody verified is the single most damaging thing this op could emit — it is
// one keypress from the human agreeing with it.
//
// "where" is the mirror-site half: the branch can be brought up as a running
// copy of the app from this room, and a URL you have to go hunting through is a
// URL nobody opens. Paths are from the site ROOT and include the hash route,
// because these apps are hash-routed. An empty list is correct whenever the
// record does not evidence which screen changed — inventing a plausible route
// sends the reviewer to a page that has nothing to do with the change.
DEFAULTS.sharpen = `A builder has just jotted a thought into their project's workbench. It is a scrap,
written fast, and it is about to be filed as a note they will read back weeks from now.

THE THOUGHT:
{{TEXT}}

{{PROJECT_LINE}}
{{NORTH_STAR_LINE}}

TASK — SHARPEN. Rewrite it so it still makes sense to them later: keep every specific they wrote
(names, numbers, files, the actual complaint), fix what is garbled, and finish the sentence they
were clearly in the middle of. Their words, tidied — not yours.

Two things you must NOT do:
  • Do not add information that is not in the thought. No invented reasons, no suggested solutions,
    no "this would also affect…". If the thought is a fragment, it stays a fragment that reads well.
  • Do not inflate it. A one-line thought comes back as one line. Never more than 3 short sentences.

Returning "text": "" means "this is already clear — leave their words alone", and that is the
EXPECTED answer whenever you cannot honestly say it better. Do not paraphrase for the sake of
answering.

Use en-AU spelling. Respond with ONLY this JSON:
{ "text": "", "why": "" }
where "why" is at most eight words on what you changed (or "" when text is blank).`;

const ENV_KEYS = {
  judge: 'GEMINI_JUDGE_PROMPT',
  futureorbits: 'GEMINI_FUTUREORBITS_PROMPT',
  futurerestate: 'GEMINI_FUTURERESTATE_PROMPT',
  wbcontext: 'GEMINI_WBCONTEXT_PROMPT',
  wbexpand: 'GEMINI_WBEXPAND_PROMPT',
  wbcluster: 'GEMINI_WBCLUSTER_PROMPT',
  wbplan: 'GEMINI_WBPLAN_PROMPT',
  wbblast: 'GEMINI_WBBLAST_PROMPT',
  wbtouches: 'GEMINI_WBTOUCHES_PROMPT',
  wbcritique: 'GEMINI_WBCRITIQUE_PROMPT',
  wbask: 'GEMINI_WBASK_PROMPT',
  semantic: 'GEMINI_SEMANTIC_PROMPT',
  pushnote: 'GEMINI_PUSHNOTE_PROMPT',
  titler: 'GEMINI_TITLER_PROMPT',
  assist: 'GEMINI_ASSIST_PROMPT',
  cleanup: 'GEMINI_CLEANUP_PROMPT',
  reviewbrief: 'GEMINI_REVIEWBRIEF_PROMPT',
  // The Curator's two board reads. They were coined STACK_ when they ran
  // `claude -p` on the host and they have since moved to the Gemini backend
  // (agents.js) — the keys stay put, because a live deploy may have an override
  // set against them and a rename would silently drop it. STACK_ has stopped
  // meaning "reads on Claude" and now means what it should have meant all
  // along: Stack's own op, whichever backend answers it.
  arrange: 'STACK_ARRANGE_PROMPT',
  allocate: 'STACK_ALLOCATE_PROMPT',
  // Coined today, so it wears STACK_ like the other new ones — it is Stack's
  // own op, whichever backend answers it (this one is Gemini's).
  sharpen: 'STACK_SHARPEN_PROMPT',
  triage: 'GEMINI_TRIAGE_PROMPT',
};

export function buildPrompt(name, vars) {
  const template = process.env[ENV_KEYS[name]] || DEFAULTS[name];
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''));
}
