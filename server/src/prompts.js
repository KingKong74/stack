// The Gemini prompt templates, in one place instead of hardcoded per route.
// Each template can be replaced wholesale via a server env var (multiline is
// fine — set it in the deploy env): GEMINI_JUDGE_PROMPT / GEMINI_AUDIT_PROMPT.
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
};

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

DEFAULTS.cluster = `You are clustering a side project's idea funnel into themes. Below are the
project's loose ideas (id | current theme | title | note). Known themes on the project: {{AREAS}}
{{NORTH_STAR_LINE}}

Give EVERY unthemed idea a theme: lowercase, one or two words. Aim for 3–7 coherent themes across
the whole funnel — prefer the known themes where they fit, and coin a new one only when a real
cluster has no name yet. Ideas already carrying a sensible theme keep it (omit them from the
answer); answer only for ideas whose theme is missing ("-") or clearly wrong. Never invent, merge
or drop ideas.

THE IDEAS:
{{ITEMS}}

Use en-AU spelling. Respond with ONLY this JSON:
{ "items": [ { "id": 123, "area": "…" } ] }`;

DEFAULTS.converge = `You are converging a side project's judged ideas into concrete roadmap tickets.
{{NORTH_STAR_LINE}}

{{MODE_LINE}}

Ground every ticket in the ideas below — never invent unrelated work. Titles are short
imperatives naming the surface they touch; notes say what "done" looks like in one or two
sentences; "plan" is 2-6 short build steps (omit it when the ticket is trivial). Buckets:
"must" only when the north star clearly demands it now, otherwise "should" (or "could" for
nice-to-haves). Keep each idea's theme as its "area" unless it is plainly wrong. "sources"
lists the id(s) of the idea(s) each ticket came from. Ideas are listed with their orbit — a
"star" idea and its "orbits <id>" planets/moons are grouped together on purpose: when merging
into one epic, treat a star and its own orbit as one thread of work, not unrelated ideas.

THE IDEAS (id | theme | verdict | orbit | title | note):
{{ITEMS}}

Use en-AU spelling. Respond with ONLY this JSON:
{ "items": [ { "title": "…", "note": "…", "bucket": "must|should|could", "area": "…",
               "plan": ["step", "…"], "sources": [123] } ] }`;

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
DEFAULTS.refinedraft = `You are helping the owner of a side project send a built change back to
the board with a REFINEMENT — a short instruction saying only what to change on top of what
already landed. The item keeps its id and its record; your sentence is the whole brief the next
session gets.
{{NORTH_STAR_LINE}}
{{STAGE_LINE}}

The item:
#{{ID}} ({{BUCKET}}) {{TITLE}}
{{NOTE_LINE}}
What the builder says landed: {{BUILT_NOTE}}
{{RUN_BLOCK}}
{{REVIEW_BLOCK}}
{{ARCHITECT_BLOCK}}
{{FILES_BLOCK}}
{{OWNER_BLOCK}}

You have NOT been shown the diff — you cannot read the repository. Everything above is the
project's record of the work.

Write ONE instruction, 1-3 plain sentences, in the owner's voice, addressed to whoever picks the
item up next:
- Say what to CHANGE, not what was built. No preamble, no restating the item.
- Prefer the specific over the general: name the behaviour, the file or the case, when the record
  names it.
- Only raise what the record actually EVIDENCES: a finding the reviewer wrote, an observation the
  architect made, a specific claim in the item that the built note does not answer.

**An empty draft is a correct answer, and often the right one.** If the record does not evidence
something to change, return "draft": "" — the owner is then told plainly that nothing in the
record calls for a refinement, which is far more useful than a manufactured one. Do not reach.
In particular, these are NOT deltas and must never be the draft:
- "verify it works", "test it in real use", "make sure it behaves correctly" — the owner is the
  one testing it; that is why they are in this dialog.
- "review the code", "run a review", "get a second pass" — a missing review is a missing review,
  not a change to make.
- restating the item's own goal back as an instruction.

Two things you must not misread:
- Failing CHECKS listed above are project-wide and may long predate this item. Only mention one
  if this item's own subject plausibly caused it; otherwise ignore it.
- "No review ran" and "no run recorded" are ABSENCES OF EVIDENCE. They are never themselves a
  fault to fix, and never a reason to write a draft.

Use en-AU spelling. Respond with ONLY this JSON:
{ "draft": "…", "basis": "…" }
where "basis" is a 2-5 word phrase naming what you leaned on ("the reviewer's finding", "the
architect's note", "a gap in the built note"), or "" when the draft is empty.`;

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

DEFAULTS.audit = `You are auditing a side project's live application for bugs. Work ONLY from the
evidence below — the owner's brief, the check results and the fetched page text. Never invent a
bug the evidence cannot support; an empty list is the normal answer for a healthy app.

Project: {{NAME}}
{{NORTH_STAR_LINE}}
Phase: {{PHASE}}
Tech stack: {{TECH}}

THE OWNER'S AUDIT BRIEF (what to look for — weigh this heavily):
{{BRIEF}}

Check results (name | expectation | last result):
{{CHECKS}}

Bugs already tracked (do NOT report these again, or close variants of them):
{{KNOWN_BUGS}}

Recent pushes (what changed lately — regressions hide here):
{{ACTIVITY}}

Live page text from {{SITE_URL}} (tags stripped, truncated; "unavailable" = the fetch failed,
which is itself worth reporting if the site should be up):
{{PAGE}}

Report at most {{MAX}} distinct suspected bugs, most serious first. Each needs:
- "title": short and specific, ≤ 15 words — what is broken, where (en-AU spelling).
- "severity": "critical|high|medium|low" — critical = down/data loss, high = a core flow broken.
- "evidence": one sentence pointing at the exact evidence above that supports it.

Respond with ONLY this JSON:
{ "findings": [ { "title": "…", "severity": "critical|high|medium|low", "evidence": "…" } ] }`;

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
DEFAULTS.readchange = `You are the Foreman on a side project command centre. A change is sitting in
front of the owner, who is about to give it a verdict: approve it, send it back with a refinement,
or shelve it. Read it with them.
{{NORTH_STAR_LINE}}
{{STAGE_LINE}}

The item it was built against:
#{{ID}} ({{BUCKET}}) {{TITLE}}
{{NOTE_LINE}}
What the builder says landed: {{BUILT_NOTE}}
{{RUN_BLOCK}}
{{REVIEW_BLOCK}}
{{ARCHITECT_BLOCK}}
{{CHECKS_BLOCK}}
{{FILES_BLOCK}}
{{MERGE_BLOCK}}
{{MIRROR_BLOCK}}

You have NOT been shown the diff and you cannot read the repository. Everything above is the
project's RECORD of the work — mostly the builder's own account of it. Weigh it as such: a built
note is a claim, not evidence.

Produce:
- "call": "approve" | "look" | "send-back".
  · "approve" ONLY when the record positively evidences that what the item asked for is what
    landed, and nothing (reviewer, architect, checks, merge state) contradicts it.
  · "look" when the record is consistent but thin — the honest answer whenever the only thing
    saying it works is the session that wrote it. THIS IS THE COMMON ANSWER. Expect to give it.
  · "send-back" only when the record itself evidences a gap: a reviewer finding, an architect
    concern, red checks plausibly caused by this change, or a claim in the item the built note
    does not answer.
- "why": 1-2 plain sentences for the call. Name the specific thing that decided it. Never
  "it looks fine" or "more testing is needed".
- "test": 2-5 concrete things to do to check it, most telling first — real clicks, screens,
  commands or URLs. Order matters: the first one should be the thing most likely to expose it if
  the change is wrong.
- "where": up to 4 places in the RUNNING APP where this change shows, as {"path","what"}. "path"
  is from the site root and includes the hash route where the app has one (e.g.
  "/#/control/review", "/#/p/stack/roadmap"); "what" is under 12 words on what to look at there.
  Base it on the files touched and what the built note says, never on a guess about the app's
  shape. **An empty list is correct and expected** when the record does not say which screen
  changed, or when the change is not user-visible at all (a route, a migration, a test).
- "blind": 1-3 plain statements of what you could NOT see that a verdict depends on. Be specific
  ("no reviewer read this branch", "the built note claims the totals are fixed but nothing here
  evidences it"), never the generic "I cannot see the code" — the owner knows that.

Do not manufacture a concern to have something to say, and do not restate the item back. If the
record is genuinely thin, say that in "why" and let "blind" carry the weight.

Use en-AU spelling. Respond with ONLY this JSON:
{ "call": "approve|look|send-back", "why": "…", "test": ["…"],
  "where": [ { "path": "/#/…", "what": "…" } ], "blind": ["…"] }`;

// #375 — the Foreman's read of the WHOLE queue. One question: what do I open
// first? The room can already sort by age and flag red checks; what it cannot
// do is weigh a blocked reviewer verdict on a small change against an unread
// one that touches the schema. Ordering is the entire answer — this op never
// gives verdicts, and it must not, or the queue would arrive pre-decided.
DEFAULTS.triagequeue = `You are the Foreman on a side project command centre. Below is every change
waiting on the owner's verdict this morning, across all their projects. They have limited time and
want to know what to open FIRST.

Each row is: key | project | stage | age | reviewer verdict | checks | merge state | title
(stage "built" = still on a branch, not on main yet; "ticked" = already closed out by hand.
An empty reviewer verdict means NO REVIEW RAN — that is an absence of evidence, not a clean bill.)

THE QUEUE ({{COUNT}} change{{PLURAL}}):
{{QUEUE}}

Order them for the owner. Put first what is most likely to need a decision that only they can
make, or where waiting costs the most: evidence of something wrong (a blocked verdict, red
checks), a branch that conflicts with main and is rotting, a large change nobody has read. Put
last what can be cleared in a glance.

Rules:
- Order EVERY change you were given, exactly once, using its key verbatim. Invent nothing.
- "why" is under 15 words and names the reason THIS one is where it is. Never "review this
  change" or "it is waiting".
- Do NOT give verdicts, and do not say whether something looks good — you have not read any of it.
  This is an order of reading, nothing more.
- "note" is one sentence on the shape of the morning ("four of these are one night's work on the
  same area"), or "" when there is nothing worth saying.

Use en-AU spelling. Respond with ONLY this JSON:
{ "order": [ { "key": "slug#id", "why": "…" } ], "note": "…" }`;
DEFAULTS.futureorbits = `You are curating a side project's Polaris galaxy — its idea funnel shaped
into orbits. A star holds planets in its orbit; star → planet → moon is the whole depth.
{{NORTH_STAR_LINE}}

THE STARS (id | title | note) — the only legal orbits to propose:
{{STARS}}

THE LOOSE IDEAS (id | title | note | area) — currently in no orbit at all:
{{LOOSE}}

For each loose idea, decide whether it is PLAINLY a piece of one star's own work — not merely
related in theme, but work that star's own definition would cover. Only propose an orbit when it
is obviously true; never force a match, and never propose more than a handful. Return
{"items":[]} if none of them clearly belong — that is the expected, normal answer for a healthy
funnel, not a failure to try harder.

Use en-AU spelling. Respond with ONLY this JSON:
{ "items": [ { "id": 123, "parentId": 456, "why": "one short sentence" } ] }`;

DEFAULTS.futurerestate = `You are helping the owner of a side project sharpen how one idea in their
Polaris galaxy is worded.
{{NORTH_STAR_LINE}}

THE IDEA{{STAR_LINE}}:
Title: {{TITLE}}
Note: {{NOTE_LINE}}
Area: {{AREA_LINE}}
{{MAGNITUDE_LINE}}
{{ALIGNMENT_LINE}}
{{CHILDREN_BLOCK}}

A star's title is a short name for a whole body of work; its note is one or two sentences of what
it covers. Judge whether the CURRENT wording already says that plainly.

Leaving a field as an empty string means "the existing wording is already right", and that is the
expected answer whenever the record does not evidence a better statement — you must not paraphrase
for the sake of producing output. Only propose a field when you can genuinely say it more clearly
or more accurately than what is there, grounded in the idea itself and (if any) its children.

Use en-AU spelling. Respond with ONLY this JSON:
{ "title": "", "note": "", "area": "", "why": "" }
where "why" is one short sentence on what you changed (or "" when all three are blank).`;

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
  cluster: 'GEMINI_CLUSTER_PROMPT',
  converge: 'GEMINI_CONVERGE_PROMPT',
  reviewbrief: 'GEMINI_REVIEWBRIEF_PROMPT',
  refinedraft: 'GEMINI_REFINEDRAFT_PROMPT',
  // #375 — the two new ones wear STACK_, not GEMINI_. Every template above
  // predates #364 and its env name is now a misnomer (the tab agents run Claude
  // on the host); renaming those would break whatever overrides are set in a
  // live deploy for no gain, but a name coined TODAY should not lie about which
  // model reads it.
  readchange: 'STACK_READCHANGE_PROMPT',
  triagequeue: 'STACK_TRIAGEQUEUE_PROMPT',
  // Same reasoning: the Curator is a TAB AGENT, so this runs `claude -p` on the
  // host through the daemon (#364). GEMINI_ would be a lie about which model
  // reads it, whatever the older keys above are called.
  arrange: 'STACK_ARRANGE_PROMPT',
  audit: 'GEMINI_AUDIT_PROMPT',
  triage: 'GEMINI_TRIAGE_PROMPT',
};

export function buildPrompt(name, vars) {
  const template = process.env[ENV_KEYS[name]] || DEFAULTS[name];
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''));
}
