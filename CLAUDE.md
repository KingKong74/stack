# CLAUDE.md — working notes for Stack

**What this file is for:** the rules and invariants you cannot read off the code — why something is
the way it is, and what breaks if you change it. NOT a feature list or an API reference: the code is
the reference, and a doc restating it drifts. A shipped feature's rationale lives in its commit
message and its `built_note`. Add here only when a session would get something WRONG without it, and
keep under the 40 KB budget (`node scripts/context-budget.test.mjs`).

**WHERE A RULE GOVERNS ONE FILE IT LIVES IN THAT FILE'S HEADER**, and this file keeps only the
pointer and the cross-cutting half. That is not tidiness: a rule beside the code it governs is read
by whoever is changing it, and a rule here is read by everyone else once. Headers that carry their
own: `routes/ingest.js`, `prompts.js`, `routes/checks.js`, `routes/worktrees.js`,
`routes/terminal.js`, `routes/autopilot.js`, `routes/sprints.js`, `agent-profiles.js`, `agents.js`, `pulse.js`,
`lanes.js`, `terminal/agent-run.mjs`, `terminal/model-switch.mjs`, `terminal/cli-registry.mjs`, `scripts/lib/autoverdict.mjs`, `scripts/lib/refine.mjs`,
`scripts/stack-autopilot-dispatch.mjs`, `lib/branch.ts`, `lib/plan.ts`, `styles.css`,
`components/Brandmark.tsx`, `detail/Board.tsx`, `detail/Roadmap.tsx`, `detail/Plans.tsx` and `components/RoadmapModal.tsx`. **Adding a rule here
that belongs in one of those is how this file got to 40 KB.**

**GONE, so you don't go looking** (owner's calls, and what went with each): **Mission Control**'s
seven rooms (`/api/control`, `/api/review`, `/api/merge`) · **Polaris** (Futures tab, galaxy,
`futures`) · the **instructions tree** (managed CLAUDE.md library + host sync) · the **Workbench**
(canvas tab, `/api/…/workbench`, `workbench_*`, the Drafter, and `notes` — its only reader, with
its table, route and ⌘K scope) · the **three corner docks** (#492 — the ＋, the terminal's
chip/float, the sessions pill; `/term-status` unwatched) · the Roadmap **Timeline** (#428) and
**strip** (Scope/Tiers/Parked/Arrange, `lib/curatorTasks.ts`) · the **TAB AGENTS' CONSOLES**
(#379/#380, `console_off` kept in the DB) and the **Auditor**. THEN THE SCREENS:
every project tab became a kit mockup (#443–#451), Mission Control too (#470), the board's kanban is
wired back (#453) and the item modal lost Priority/Tier/Risk/Branch (#469).

Two things that leaves: the **CURATOR is the only agent**, and only its `assist` op has a caller
(`arrange`, `allocate`, `cleanup`, `titler` are registered and unsurfaced). Rules that outlived
their surface are kept below and SAY SO.

## What Stack is

A self-hosted side-project command centre. The point is **frictionless resume**: open a project and
the "pick up where you left off" card tells you where you were. A push auto-extracts bugs and
next-steps into the trackers, and dashboard progress is computed, not hand-set.

North star: an autonomous software house run from the director's chair — SessionStart states it in full.

## Layout

```
web/       Vite + React 18 + TS (strict), hash-routed. Persistence is the API, via src/store.ts.
server/    Express + Postgres. Idempotent schema migrate on boot; fails closed if API_TOKEN is unset.
hook/      Zero-dependency Node ESM hooks + the /checkpoint poster.
terminal/  The web terminal's host-side daemon (dials OUT; the firewall drops container→host).
scripts/   Host-side CLI + automation. templates/ the portable agent manual.
```

### web/src

- **`store.ts` is the only module that touches the network or device storage.** Components never
  `fetch` and never touch localStorage. `request()` attaches the bearer and throws `AuthError` on 401,
  clearing the token and returning to the gate.
- **FOR YOU IS THREE ROUTE KEYS ON ONE SCREEN** (#436) — `overview`, `activity`, `auto`, switched by
  a strip that WRITES the key; never collapse them into state.
- `lib/route.ts` — hash router, and **the TAB decides what `hl` means**. The board and Roadmap honour
  one (#453/#472); every other tab is a mockup and ignores its own rather than 404ing, as do the
  legacy spellings (`futures`, `notes` → Overview).
- `styles.css` — **the palette is the `:root` variables, in TWO LAYERS** (#432, kit tokens then
  Stack's aliases). Its header owns the rest, including the two traps the split sprang; read it
  before reaching for a token. **Never an inline hex.**
- `components/Brandmark.tsx` — THE LOGO, and the only place the mark is drawn; its header owns the
  form rules. The cross-cutting half: THE GEOMETRY IS COPIED THREE TIMES and no copy can import
  another — the component, `scripts/render-icons.mjs` (favicon + PWA icons; it refuses to write if a
  tone drifted from `styles.css`) and `scripts/lib/brandmark.cjs` (the CLI banner, CJS because
  `stack` is). Move a plate, move all three and re-run the renderer.
- `lib/termClipboard.ts` — its header says why ⌃C, ⌃V and OSC 52 each behave unlike a native
  terminal. Don't "simplify" any of the three.
- `lib/brief.ts` — the resume brief + the `DIRECTIVES` catalogue (keys mirror `SESSION_DEFAULTS`).
- The recipe library (`/api/tips`) has a route, a table and no screen at all.

### server/src

- `schema.sql` — idempotent (ADD COLUMN IF NOT EXISTS + convergent data migrations). Read it for the
  column list; the non-obvious semantics are under **Data rules**.
- `util.js` — helpers, `computeProgress`, and the **three single-knob constants** every surface reads:
  `STALE_DAYS`, `PRESENCE_TTL_MINUTES` (the crashed-session backstop) and `CHECK_HISTORY_KEEP`.
- `shape.js` — the run ledger's SHARED shapes, because four routes had each grown a drifting copy.
  **BIGINT and NUMERIC come back from pg as STRINGS**, which is what those copies got wrong.
- `settings.js` — `readSettings()` **defaults to "on" when the row is missing**, and the hooks default
  to "on" when the API is unreachable, so a flaky API degrades to recording rather than silent-off.
- `routes/` — one file per surface. `ingest.js` carries the most invariants; read its header first.

## The ingest package (what /checkpoint and the hook send)

`{ project, session, extract }`, and **`routes/ingest.js`'s header carries the four invariants** —
idempotency order, what makes the metadata backstop safe, when the resume card refreshes, and the
fingerprint/tombstone contract. Read it before changing anything there; it had none until #472's pass
and this file was standing in for it.

The cross-cutting halves: an extracted row is `source='hook'`, which means **HELD** — out of the
overnight runner until a human signs it off (#359) and drawn on Roadmap rather than the board (#472).
And the usage fields (`tokens_used`, `model_usage`, `agent_calls`, `agent_types`) are **hook-only**,
since the hook alone reads the transcript.

## Progress model (`util.computeProgress`)

The single definition of "how done is a project" — read the weighting off the function, whose header
carries why #469 did NOT change it. What you would not guess: it is **capped at 90% while any
critical/high bug is open**, and 0% with no Highest/High items at all. The Dashboard's "Progress by
app" panel is this one — deliberately NOT a health score.

## Data rules (the non-obvious column semantics)

The ones a session gets wrong by guessing, and the predicates MIRRORED across
packages that cannot import one another — those are this file's real job, because
a mirror has no compiler holding it in step. Everything else: read `schema.sql`,
or the header of the file named in the pointer.

### The roadmap row

- **`bucket` IS THE PRIORITY: five values since #469** — highest/high/medium/low/lowest (it held
  MoSCoW; the column keeps its name, `util.js`'s BUCKETS is the vocabulary, `schema.sql` the
  convergent migration must→highest, should→high, could→LOW, wont→lowest). **`medium` is the level
  MoSCoW never had**: nothing migrated in, and it moves no progress bar. **It no longer gates the
  runner** — #477 dropped the highest/high filter, because being in the sprint in progress is the
  stronger commitment and a gate that silently refused a `medium` somebody dragged into the box
  would make the box a lie. Bucket ORDERS candidates below the sprint rank; it excludes none.
- **THE DESIRE TIER (#227) IS GONE** (#477 dropped the column). What ranks work is **the SPRINT** —
  see its own section below. Roadmap's Ready/Thinking columns are `bucket` now (highest+high vs the
  rest), which is triage and no longer a claim about what runs next.
- **`risk`** (low/normal/high, #212) is how much DAMAGE a wrong build does — not difficulty, not
  desire. Prose across the repo calls it a "risk tier"; it is not the tier that went. **A `low` item whose run lands green auto-queues its own merge**, which is
  the whole reason the column exists and why writing it casually is expensive. `risk_source` is who
  decided (#262): `human` = a hand-set write, `auto` = the plan-time pre-pass, NULL = the `normal`
  nobody chose, **and NULL is the only state an auto write may replace**. The guard is CASE
  expressions inside `PATCH /roadmap/:id`'s own UPDATE — **never write `risk` from a path bypassing
  that PATCH**. #469 removed the modal's Risk control, so risk is auto-only in a browser.
- **`built_note`** — what actually landed, PATCHed by the completing session; a verdict is given
  against it. ALWAYS write one.
- **"Built" is BUILT-or-ticked, not ticked** (#374): `done` **OR** (`built_note` non-empty **AND**
  `claimed_by` non-empty). Nothing in Stack ticks an item, so `done` alone drew an empty queue over a
  full night's work. **Both halves are load-bearing** — un-ticking clears `claimed_by` and keeps
  `built_note`, so either alone re-queues the wrong set. `isBuilt` (`lib/plan.ts`) is the client's
  only copy. **Anything acting on a built change shares the predicate**; a path opening
  `if (!item.done) 400` refuses the whole night's work.
- **Un-ticking clears `review_tag` and `claimed_by`** (unless the same PATCH sets them), so a
  sent-back item re-enters play fresh. Ticking clears `review_tags`, `refine_note` and
  `review_shelved`: each verify round starts unannotated.
- **Deleting a `source='hook'` bug or roadmap item tombstones its fingerprint**, so the next push
  cannot re-create it. That is what Dismiss means and why it has no undo.
- **The schedule is MINUTES from week zero, not a week index** (#401) — `sched_start_min`/
  `sched_len_min`, with `plan_start_min`/`plan_len_min` the write-once BASELINE a drag must never
  move. **Four packages must agree and none can import another**: `routes/roadmap.js`, `shape.js`
  (BIGINT arrives as a STRING), `lib/plan.ts`, `lib/spine.ts` — which no component imports;
  `scripts/spine.test.mjs` is its only reader. **`estimate` stays in WEEKS**, so `defaultLen` in
  `lib/plan.ts` is the ONE place the two units may meet. NOTHING EDITS one since #428 and #451 took
  its two editors; Plans' Timeline and Calendar READ one again (#482).

### Which screen a row is on

- **The BOARD draws committed work; ROADMAP draws ideas** (#472), and **`isIdea` in `lib/plan.ts` is
  the ONE line between them** — a row on both is acted on twice, a row on neither has silently
  vanished. Not committed = a **HELD** row (`hook`/`fly` nobody signed off) or a **CHILD** row
  (`parent_id`, an idea under a feature) — **NEITHER once somebody has WORKED it**: a claim, a
  `built_note` or a tick (`isWorked`) makes a row board work whatever its sign-off says, so a
  session's own card stops landing in the idea pile, and a held row's hold is then a RUNNER gate
  only — said (`held` chip) and answered (card menu) on the board, since Promote cannot see it.
  **Promoting is one write with one meaning**:
  `reviewed: true` + `parentId: null`. There is deliberately **no free-floating capture on Roadmap** —
  a manual row is never held, so it is committed work by definition and the board's composer is where
  it goes; ＋ on a board item is how an idea gets filed.
- **The SPRINT order IS the run queue** (#477). `queueOrder` (`lib/plan.ts`) is the client twin of
  the runner's sort: **the active sprint's rows by `sprint_rank`, then bucket, then PAYLOAD ORDER** —
  a stable sort over arrays the server already ordered. It is **curried on the active sprint's id**
  because a rank means nothing outside that box: `sprint_rank` is 0 on every backlog row, so an
  unguarded compare floats the whole backlog above committed work. `position` is a different number —
  scoped to the BUCKET, still PATCHable, **written by nothing in the client** — and the kanban has no
  within-column drag because its columns cut across buckets.
- **THE REST ARE MOCKUPS AND SAY SO ON THEIR OWN FACE** (#443–#482): `ForYouMock` (3 panes),
  `QualityMock`, `ControlMock` (7 tabs), `DevelopmentView` at the foot of `Board.tsx`, and FOUR OF
  `Plans.tsx`'s SIX sub-views (#482 wired Timeline and Calendar). Each wears a **Mock chip** —
  on the rail row, or, where a tab is part wired, **on the sub-tab itself**, which is the finest
  grain the rule has: these screens look exactly like the real thing, and a chip covering a wired
  default view warns about the wrong one. **A number and the screen behind it must agree**: a wired
  row's badge is its real count, a mockup's counts the MOCKUP. Still UNREACHABLE from a browser,
  with `./stack` and the API the way in: a **verdict**, **labels**, the **⎇ claim**, **risk**,
  **checks and bugs** (#450), and **WRITING the stored schedule** (#451) — Plans reads it (#482).
- **A verdict is `verdict_source` / `verdict_at` / `verdict_evidence` (#263, owner-sanctioned)** — the
  one place a machine may verdict instead of the human. **The sanction has three conditions and
  `scripts/lib/autoverdict.mjs`'s header carries them**, including that the VISIBLE leg is unmet and
  is a debt. Two exclusions are not negotiable: a refine round and a limit-hit run.
- **A refine round is never machine-closed** (#274): no auto-merge, no auto-verdict — closing it on a
  green run discards the judgement the send-back asked for. It continues the item's OWN branch
  (`scripts/lib/refine.mjs`), and `refine_note` surviving to the tick is what makes "is this an
  unclosed round" answerable.

### Who may run, and where

- **THE AUTOMATION ONLY TOUCHES THE SPRINT IN PROGRESS** (#477), and that is the outermost gate —
  ahead of approval, the fleet cap and the area lane. A sprint is a named, ordered box of board items
  (`sprints`, status `planned | active | done`); **at most one per project is `active` and the
  DATABASE enforces it** (a partial unique index), because THREE packages independently decide what
  may run and each says "the sprint in progress". Two rows would have them building from different
  boxes with nothing saying so. **`roadmap_items.sprint_rank` is the order inside one box, 0 = top =
  what the night takes first** — dense, rewritten whole on every drop (`PUT /sprints/:id/order`),
  scoped to the SPRINT and **not** `position`, which is scoped to the bucket. `sprint_id` NULL is the
  BACKLOG and is the majority. Three spellings, none able to import another: the fan-out's `JOIN
  sprints … status = 'active'` in `routes/autopilot.js`, the runner's own pick, and `queueOrder`.
  **NO ACTIVE SPRINT MEANS THE NIGHT DOES NOTHING** — a real state, reported out loud on the backlog
  and in the runner's log, never a fallback to the whole board.
  Two carve-outs: **Run now and a calendar row are NOT gated**, because each names one item a human
  picked, which is the same commitment dragging it in would have been; and **a POST never sets a
  sprint** — a new row is born in the backlog, or the extractor could commission tonight's work by
  writing a title. Deleting a sprint **releases its items** (ON DELETE SET NULL); finishing one
  **leaves its unfinished rows in it**, because a done sprint is the record of what was committed to.
  `starts_on`/`ends_on` are the owner's PLANNED window and **gate nothing** — a second pair beside
  `started_at`/`ended_at`, which is when it actually ran, because "when did we mean to" and "when did
  we" are different questions. **Agents must never write `sprint_id` or `sprint_rank`.**
- **"Approved for the auto runner" is `source NOT IN ('hook','fly') OR reviewed_at IS NOT NULL`**
  (#359, widened by #381), with no column of its own — an `approved` flag would be a second, drifting
  truth. TWO origins need a human's sign-off: `hook` (read off a push) and `fly` (a live session's own
  work). **A manual item is NEVER held**, because blocking hand-written work is the failure mode this
  must not have. Written THREE times (`server/src/`, `scripts/lib/`, `web/src/lib/approval.*`) since
  no package can import another. An unattended enqueue **drops a held item silently**; Run now /
  `POST /start` **refuses out loud and names it**. Roadmap's Promote is the only browser surface that
  un-holds one. Not the verdict queue: this gates what may RUN, that queues what was BUILT.
- **An area lane is `(project, area)`, and untagged is never a lane** (#267): an area with an OPEN
  claimed item admits no second worker, because two branches in one area collide at merge time. The
  pure rule is `server/src/lanes.js`, MIRRORED in two runtimes that cannot import it —
  `routes/autopilot.js`'s claim and the runner's pick — so change one, change the other. Two
  carve-outs are load-bearing: an untagged (`''`) area never occupies or is blocked by a lane (else
  every untagged item collapses into one giant lane and the night silently does nothing), and the key
  includes the project. A worker never blocks itself. **A skipped job always logs why**: a lane delay
  must never be a silence.
- **Three gates decide who runs, and merging any two is where they get confused** (#267 + #335) —
  the **fleet cap** (tunable), the **per-project serialisation** and the **area lane**, all three in
  `CLAIM_NEXT_SQL`'s one WHERE, which is where they are explained. The cross-cutting halves:
  **per-project cannot become a knob** (every job runs against the one checkout at
  `$STACK_AUTOPILOT_ROOT/<slug>`, where two runners fight over git's ref locks), so widening
  concurrency widens the fleet cap and never the other two; the host lockfile's sanitiser is spelled
  in BOTH the runner and the dispatcher's kill path and `stack-autopilot-dispatch.mjs` says what
  diverging costs; and `heldByArea` reports only LANE holds, so a job waiting on the cap is not held
  by an area.
- **`claimed_by` is the branch claim** (#277 — a "lane" until the rename; the `lane/` git ref prefix
  is unchanged, naming branches already on origin). Claim before starting; a terminal tab's claim is
  `term:<name>`. It is the don't-re-pick marker, injected by SessionStart as "Branch claims —
  respect these", and stays until a human merges and ticks.
- **Branch names are `<kind>/<id>-<summary>`** (#363; feat · fix · ui · refactor · perf · test · docs ·
  chore). `scripts/lib/lane.mjs` is the canonical namer AND parser; `web/src/lib/branch.ts` is its
  client twin, kept in step by discipline, not a shared test. **The old flat `auto/item-N-<slug>`
  spelling must keep parsing forever** — those branches are on origin and in live `claimed_by`
  strings, so a reader knowing only the new form reports a working fleet as empty. A legacy lane's
  kind is `''`, **never `feat`**.
- **A branch's four-valued merge state (#363) is derived, never stored** (`web/src/lib/branch.ts`,
  whose header carries the guesses that cost the first cut its correctness). The one to hold in mind:
  **`unprobed` is not `clean`** — the same NO PASS RAN rule as a NULL `review_verdict`.
- **`projects.merge_autonomy` is not `automode`** (#363 — auto | plan | off, default plan). `automode`
  says whether a project is BUILT unattended; this says how much of its MERGING one press of ▶ Run
  covers. None of the three relaxes the conflict probe, the #212 risk gate or the merge confirm.

### Spend, agents and the ledger

- **Model spend is TWO populations and they must never be mixed.** `autopilot_runs` answers to the
  executor/advisor policy; `sessions.model_usage` (the human's interactive work) does not, so a model
  picked by hand is **not drift**. Any merged share must be **token-based**, because a transcript
  carries no cost. A manual session's `model_usage` (main loop) and `agent_usage` (subagents) ARE its
  director/executor split. (Both readers are culled: `pulse.js` and its route are served, tested,
  fetched by nothing.)
- **A subagent's usage is NOT in the parent transcript — it has its own**, and
  `hook/stack-session-end.mjs` says where and why. The rule that reaches past it: subagent spend is
  routinely the LARGER half, a lost transcript reads as unpriced rather than free, and neither source
  counts every delegation, so **`agent_calls` is the MAX of the two**.
- **A plan night is the advisor working, not idle.** `planned` commits nothing by design, so it can
  never be `landed`: its own bucket in `pulse.js`, sitting out the land rate while keeping its spend
  and role attribution. Folding it back in scores the advisor as having failed to land runs nobody
  asked it to land.
- **A night's outcomes partition across FOUR buckets** — `landed` / `failed` (failed + limit) /
  `planned` / `noCommits` — from five outcome values, always summing to the run count. `pulse.js`
  spells it out and says why.
- **An empty second-model read means NO PASS RAN, not "nothing found".** A NULL `review_verdict` /
  `architect_verdict` renders as NO REVIEW, never green — anywhere an agent's opinion is stored.
- **`autopilot_jobs.branch` is a real column; a merge job's branch still round-trips through free-text
  `detail`** (#243) — three places re-parse it, so merge's contract was left alone. The `advise` lane
  matches on the column; its `advice` NULL means NO PASS RAN, never "no conflicts".
- **`agent_profiles` holds only OVERRIDES** and `server/src/agent-profiles.js` says how the built-ins
  survive a DELETE. The invariant with teeth: **a spawn always gets at least one building agent** (no
  profiles, all disabled, an unknown key — all fall back to the executor), or the expensive director
  model silently does the building.
- **AN AGENT'S BINDING IS CODE, NOT DATA (#361, #375)** — `src/agents.js` is the registry and its
  header carries the shape. What reaches past it: **one surface, one switch**, both ways, so an op
  MOVES with its surface and an unregistered op cannot run at all; **a missing config row means ON**,
  as with `readSettings()`; and an op's `backend` may be `'gemini'`, so a surface with two backends
  still has ONE switch and only the refusal differs — it must NAME the missing backend.
- **THE TAB AGENTS RUN CLAUDE ON THE HOST (#364), not Gemini** — through the terminal daemon's uplink
  to `claude -p` on the owner's own subscription, so the no-paid-external-AI rule holds. **The sandbox
  that makes that safe is `terminal/agent-run.mjs`, and its header is the thing to read before
  changing anything about it** — an agent prompt is assembled from tracker rows, which is text
  somebody else wrote. Two consequences that reach past it: **readiness is the DAEMON, not a key** (a
  switched-off agent is reported before an offline host), and **`ask()` returns PARSED JSON**
  (`parseAgentJson`, fence-tolerant). **Gemini is not gone**: the per-push review note, check
  assertions, labelling and triage are still Gemini, still key-gated.
- **AN AGENT ANNOTATES A VERDICT; IT NEVER GIVES ONE (#375).** Whatever reads a change next answers
  with a CALL (approve / look / send-back) drawn in the accent and never in a verdict tone, carries
  **`blind[]`** (what it could not see) rendered hardest under an `approve`, and **`read[]`** (what
  the server assembled). An agent field that becomes a link the owner clicks must be reduced to a
  same-origin PATH before it is rendered — the sanitiser went with the last surface that rendered
  one, so the next writes it again rather than trusting the string.

### Elsewhere

- **`DELETE /api/projects/:slug` is SOFT** — stamps `deleted_at`, clears the share link, keeps every
  row; deleted projects vanish from live queries and their collections 404. `/purge` is the real
  cascade, valid only on binned projects.
- **`checks.auth`, `checks.external` and what an edit clears are in `routes/checks.js`'s header.**
  The cross-cutting half: `/report` writes `check_results` but NOT a `check_runs` row, because
  `check_runs` is the SUITE's ledger #212 auto-merge and #263 auto-verdict spend against — one
  reported result there would read as a suite of 1/1 passed, a green light manufacturable from
  outside Stack.
- **The `worktrees` table is a REGISTER, not a manager** (#229; `routes/worktrees.js` says why). Two
  things reach past that file: `session_name` keeps the `stack-term-` prefix, which is what puts a
  session on the running-sessions strip and what the host reapers key off; and trees live at
  `~/.stack/worktrees/<key>`, inside the $HOME cwd jail the terminal daemon enforces — move the root
  outside $HOME and browser access breaks silently.
- **An autopilot `stack-auto-*` session is READABLE from the browser and still not mirrorable,
  killable or typeable-into** (#366; the rest is in `routes/terminal.js`'s header). Widening
  `listStackSessions` to cover both lists is the obvious tidy-up, and it hands the browser a kill
  button for a session running with `--dangerously-skip-permissions`.
- **A repo's CLAUDE.md is the repo's.** Stack used to write each from its own copy every five minutes,
  authoritatively — so a stale DB copy silently reverted THIS file for several sessions running, each
  filed as a mystery blocker. Nothing writes a CLAUDE.md now; if something starts to, it needs an off
  switch before a schedule. `ControlMock`'s Context tab draws that surface again, inert.

## Fail-safe direction (get this right or you delete work)

Every host-side automation must decide what an unreachable API means. **The direction is not
uniform, and it is not a bug that it isn't:**

- **Fail SAFE = do nothing** where the action destroys or spends: the idle reaper (#287), the skills
  sync (it deletes files), the dispatcher, the arm switch, `stack worktrees --prune`. An unknown
  threshold reaps NOTHING.
- **Fail OPEN = keep recording** where the action only records: `readSettings()` and both hooks default
  to "on", so a flaky API degrades to recording rather than to silent-off.
- **Fail SILENT = report nothing** where the reader would mistake absence for good news. `attention[]`
  and `conflicts[]` are empty with no host daemon on the line, so a reader must check
  `terminal.connected` and say "Stack cannot see whether a session is stopped", never "nothing is
  waiting on you". Same rule as a NULL `review_verdict`.
- **Fail LOUD = exit 1 with a reason** where the reader would mistake "could not look" for "looked and
  found nothing". `scripts/playwright/smoke.mjs` (#291) exits 0 only on a clean pass — an unreachable
  app reporting zero findings is the NULL-verdict lie again.

Just as absolute: **Stack only ever writes or removes skills IT PLANTED** — each managed directory
carries a `.stack-managed` marker, a skill without one is REPORTED and never touched, and removal is
driven by the server's KEEP list, never a diff against the last report. **A preview never writes to
the real database.** `scripts/lib/worktree.mjs` (#229) fails safe both ways and its header says why.

## Answering a permission prompt from the browser

`POST /api/terminal/answer` is the ONLY path by which anything but a human at the keyboard types into
a running session, and every rule on it exists because of one hazard: **the row the human clicked was
drawn from a pane read up to twenty seconds ago**, in which time the session can have been answered at
the keyboard and be sitting on a text input where the menu was — so "1" becomes a stray digit in
someone's message. The rest (who decides, what the fingerprint covers, why Approve never sends "and
don't ask again", why the refusal is shown verbatim) is at the route in `routes/terminal.js`.

`terminal/prompt-scan.mjs` is pure and leans hard towards null: a false block puts an Approve button in
front of a question nobody asked, far worse than a real block noticed late.
`terminal/edit-watch.mjs` reads who is editing what off the **transcripts, not git** — two sessions in
one checkout share a dirty tree, so git cannot say who wrote what and a transcript can.

## Hooks and the host

- **Both hooks must always exit 0** and log only to stderr — never block Claude Code start or stop.
  (`stack-checkpoint.mjs` is a poster, not a hook, so it may exit non-zero; it never prints the token.)
- **The SessionStart hook is registered WITHOUT `async`** (SessionEnd stays `async`): its
  `additionalContext` must be captured synchronously to land in the session. It guards the API call
  with a short timeout and emits nothing on any miss.
- **`~/.stack/` holds COPIES, not symlinks.** Editing `hook/*.mjs` changes nothing until they are
  copied over. `diff hook/<f> ~/.stack/<f>` when a hook fix seems inert.
- **The SessionEnd hook posts the commit THIS session made**, read from its own `git commit` results in
  the transcript, falling back to `git rev-parse HEAD` only when it committed nothing. HEAD is wrong
  whenever sessions run in parallel in one checkout.
- The host dials OUT for everything (terminal daemon, dispatcher, branch report, skills sync, merge
  advisor): the server is in a container and the host firewall drops container→host traffic. Anything
  needing host state is a poll-and-report, never a push from the server.
- **An alternative-provider key resolves `process.env` → `~/.stack/env` → `~/.ccm_config`** (the ccm
  tool's file, key=value OR JSON) via `terminal/model-switch.mjs` — every reader goes through it, not
  `process.env` directly, since a standalone script has not loaded `~/.stack/env`. No surface prints
  any part of a key; `./stack models` reports the SOURCE and a character count.

## The /checkpoint command + poster

Rich resume content is **Claude-authored, free, no external API** — the session composes it
(`.claude/commands/checkpoint.md` has the steps and the settings it must honour) and pipes it to
`~/.stack/stack-checkpoint.mjs`, which sets `authored:true`, fills commit/branch from git and POSTs to
`/api/ingest` with the token from `~/.stack/env` (never printed). The SessionEnd hook is the silent
metadata backstop so the feed never has gaps. **Don't replace /checkpoint with an API summariser.**

## Settings that change behaviour

A single row in client camelCase; PATCH takes any subset, full list in `routes/settings.js` (which
also documents the self-describing ones). The ones whose meaning isn't obvious from the name:

| key | meaning |
| --- | --- |
| `keepResumeCard` | off → ingest skips the resume refresh and the deck drops the card (#444 took the Overview's) |
| `sessionDefaults` | catalogue keys (lean/ship/checkpoint/confirm/verify/**fly**) rendered server-side and injected by SessionStart into EVERY project. `ship` = commits pre-authorised, granted once; `fly` is what makes a session open its own card at all (#381) |
| `autopilotEnabled` | the ARM SWITCH. Nightly + scheduled jobs only enqueue while on; ▶ Run now stays manual-only |
| `autopilotWorkers` | the FLEET-WIDE cap on concurrent jobs (0 = unlimited, default 3, clamped 1–8); per-project serialisation is separate and NOT tunable |
| `autopilotExecutorModel` / `autopilotAdvisorModel` | #153, **inverted by #285**: the ADVISOR runs the session (main loop, plans, delegates, verifies, commits) and the EXECUTOR is exposed to it as a subagent with the write tools. Advisor unset = single-model on the executor |
| `assistFields` / `assistGuidance` | what ✧ Fill-from-note may fill, and the owner's standing steer. Assist never overrides a value the human set. **branch/risk are dead toggles** — #469 took them off the modal, so the route still answers them and nothing can land them. `tier` went with its column (#477); `priority` went with the corner ＋ (#492) |
| `termIdleHours` | the idle reaper's threshold (0 = never); the host kills, fails SAFE, and **it switches BOTH reapers** — this and the daemon's 1-min unused sweep |
| `accessPinSet` | PIN sign-in available; PATCH takes write-only `accessPin` ('' disables). Any change signs out every PIN-connected device |

## Routes

One file per surface in `server/src/routes/` — `ls` is the index. All behind bearer auth except
`GET /api/health`, `POST /api/auth/login`, `GET /api/public/:slug/:token`. What filenames don't say:

- **Read layers** (`overview`, `search`, `timeline`, `public`) are computed in a handful of aggregate
  queries — **never one query per project**.
- Per-project collections mount under `/api/projects/:slug/…` with `mergeParams`;
  `GET /api/projects/:slug` is the combined detail payload the SessionStart hook reads back.

## Conventions

- **en-AU spelling** everywhere. Frontend is **strict TS** with `noUnusedLocals`/`noUnusedParameters`
  on, and all persistence and network stays behind `store.ts`.
- **No secrets in the repo.** `.env` (server) and `~/.stack/env` (hooks) are gitignored and load at
  runtime. The hooks never read tokens from the shell profile or settings.json, and never print them.
- **No PAID external AI APIs.** (Owner's decision 2026-07-16.) Gemini on the free tier is sanctioned
  everywhere — routes, ingest, hooks, cron, the autopilot. Three principles survive the loosening:
  • **Gemini annotates, the human disposes.** Its output lands as suggestions; it never mutates tracker
    state — no auto-closing bugs, ticking items or merging branches. (#263 carves out one sanctioned
    exception, machine verdicts on low-risk all-green runs; #274 carves out an exception to THAT.)
  • **Absent key = silent degrade.** Every Gemini surface no-ops or 503s cleanly without
    `GEMINI_API_KEY`, and the client renders it ABSENT rather than disabled, keyed off `geminiReady`.
  • **An empty answer is a valid answer, and the prompt has to invite one.** The ✎ Refine draft returns
    `draft: ""` when the record doesn't evidence a change — a model told to produce a delta will
    otherwise produce one, and what comes back is "verify it works" dressed as a finding. Any prompt
    asked for a judgement needs the same escape hatch, or it manufactures one.
- **The OMNIROUTE GATEWAY is local, and Stack's use of it is FREE BY DEFAULT** (#481). No paid API is
  called unless `OMNIROUTE_MODEL` names a paid model — one deliberate line in `~/.stack/env`. It is
  loopback-only by DOCKER's `-p 127.0.0.1:`, because it binds 0.0.0.0 whatever its own host vars say.
  **Host-side only**: the server is in a container and cannot reach `localhost:20128`, so routing
  `gemini.js` through it needs a compose service — a decision, not a tidy-up.
- **A LAUNCH-ONLY RUNTIME IS NOT A STACK SESSION** (#481). The half that reaches past
  `cli-registry.mjs`'s header: **branch claims are NOT injected into a non-Claude session**, so the
  lane discipline every other surface enforces is, in that one runtime, on the human. Say it out loud.
- **Checks are Stack's only automated regression net.** When a route's payload contract changes,
  change its check in the same commit — a green suite is what #212 and #263 spend.
- `templates/stack-agent-context.md` is the single source of truth for the portable agent manual — if the
  API or hook contract changes, update it (`scripts/stack-context.mjs` exports it verbatim).
- **A strict build is necessary and no longer sufficient for UI work.** Run `scripts/run-ui-smoke.sh` (or
  `./stack ui-smoke`) before calling a UI change done — two real layout bugs reached the owner because a
  session had no way to see its own rendering (#291).
- **The smoke is BLIND TO COLOUR; `scripts/run-palette-audit.sh` is not (#432).** Run it after
  anything touching tone — it measures the ground actually painted behind each piece of text and
  reports sub-AA contrast plus any tone off the `:root` ramp. **A screenshot is not a substitute and
  already failed once**: a pale bar downscaled over a dark page reads as dark, and the light-topbar
  bug survived being looked at directly. Text it CANNOT measure is its own bucket, never a pass.
- **A recurring re-fetch goes through `lib/autoRefresh.ts` (#312), never a bare `setInterval`.** One
  device-local setting (Settings → Auto refresh; 0 = off) governs every screen watching the host, and it
  is also what stops a hidden tab polling. Device-local because the BROWSER polls; contrast
  `termIdleHours`, app-wide because the HOST does that killing.

## Gotchas

- `server` retries its first Postgres connection — don't "fix" it; it survives compose order.
- **A CAPPED PROMPT MUST STATE ITS OWN CAP, on the right axis** (#239, #364) — the rule is in
  `prompts.js`'s header and covers any list, and host-side material trimmed before it reaches a
  model: one that silently saw a tenth of a diff answers confidently about the other nine.
- Status vocabulary: `live | building | paused | archived`; the old `active` migrates to `live`.
- The web Dockerfile is multi-stage (Vite build → nginx): SPA fallback, `/api` proxied to
  `server:4000`, `/term*` with upgrade headers; in local dev Vite proxies `/api`. **Host-side agent
  ops run far longer than a web request** — nginx's `/api` read timeout and each op's own timeout
  must both clear `claude -p` (a 60s cut made a 240s agent read unreachable, silently, for weeks),
  and Cloudflare cuts at ~100s regardless.
- Both closure counts in `totals` lean on `updated_at`, the only stamp either table carries — so
  read them as MOVEMENT, not a ledger.
- **`autopilot.js`'s `JOB_SELECT` names its columns on purpose** (#243) — a `SELECT j.*` ships the
  kilobyte `advice` text on every job poll AND leaves `adviceReady` false forever.
- `stack-autopilot.mjs` still inlines its own `git worktree add/remove` rather than calling
  `scripts/lib/worktree.mjs` (#229) — deliberately NOT refactored. The nightly is how this repo builds
  itself, so pointing it at the module is a real behaviour change, not a no-op tidy-up.
- `scripts/spine.test.mjs` runs `web/src` TypeScript directly under Node's type-stripping loader;
  follow that pattern for client-side coverage.

## Tests and quick commands

`ls server/test/ scripts/*.test.mjs` is the test index — each name says what it pins, each
header how to run it. Most are **pure** (`node <file>`); ones needing a live API + `DATABASE_URL` say
so at the top — stand up a throwaway `postgres:16-alpine` rather than treating "no database here" as
a blocker. `scripts/context-budget.test.mjs` guards THIS file; `scripts/roadmap-refs.mjs` checks
every `#id` cited in the repo against the real board.

```bash
node hook/stack-session-{end,start}.mjs --demo   # fire the backstop / print the resume block
node hook/stack-checkpoint.mjs --settings  # print current settings (what /checkpoint reads)
cp hook/*.mjs ~/.stack/                    # install the hooks — ~/.stack holds COPIES
./stack                                    # the host CLI — bare prints its sub-commands, --help each;
                                           # the writing ones are DRY until --run
node scripts/stack-autopilot.mjs --project stack --repo /home/bailey/stack --dry  # tonight's pick?
node scripts/stack-autopilot-dispatch.mjs  # one dispatcher poll by hand (normally the cron line)
node scripts/stack-preview.mjs --start <id> # a preview (#208) — no UI left; the route and sweep live
node hook/stack-gemini-review.mjs --dry    # second-model review of the last commit (--architect too)
node terminal/stack-term.mjs               # the web-terminal daemon (normally the @reboot cron line)
crontab -l                                 # the dispatcher line — remove it to disable all runs
tail -f ~/.stack/{term,autopilot,preview}.log
```

<!-- stack-managed -->
