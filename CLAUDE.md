# CLAUDE.md — working notes for Stack

**What this file is for:** the rules and invariants you cannot read off the code — why something is
the way it is, and what breaks if you change it. NOT a feature list or an API reference: the code is
the reference, and a doc restating it drifts. A shipped feature's rationale lives in its commit
message and its `built_note`, which the Review room shows. Add here only when a session would get
something WRONG without it, and keep under the 40 KB budget
(`node scripts/context-budget.test.mjs`). **Where a rule governs one file it lives in that file's
header, and this file keeps only the pointer and the cross-cutting half** — `ingest.js`,
`prompts.js`, `checks.js`, `workbench.js`, `futures.js`, `worktrees.js`, `instructions.js`,
`lib/feature.ts`, `lib/branch.ts` and `ControlReview.tsx` all carry theirs.

## What Stack is

A self-hosted side-project command centre. The point is **frictionless resume**: open a project and
the "pick up where you left off" card tells you where you were. Colours, type, spacing, copy and
interactions are meant to match the Atlas design handoff.

North star: an autonomous software house run from the director's chair — SessionStart states it in full.

## Layout

```
web/       Vite + React 18 + TS (strict), hash-routed. Persistence is the API, reached ONLY through
           src/store.ts (every function async, bearer-token auth).
server/    Express + Postgres. Idempotent schema migrate on boot, retries the first DB connect. Bearer
           auth on every route except GET /api/health; fails closed if API_TOKEN is unset.
hook/      Zero-dependency Node ESM hooks + the /checkpoint poster.
terminal/  The web terminal's host-side daemon (dials OUT; the firewall drops container→host).
scripts/   Host-side CLI + automation. templates/ the portable agent manual.
```

### web/src

- **`store.ts` is the only module that touches the network or device storage.** Components never
  `fetch` and never touch localStorage. `request()` attaches the bearer and throws `AuthError` on 401,
  clearing the token and returning to the gate.
- `lib/route.ts` — hash router. `go.detail(slug, tab, highlight)` deep-links and **the TAB decides
  what `hl` means** (commit → activity, bug key → quality, row id → roadmap, NOTE id → workbench);
  legacy tabs still resolve (`bugs`/`audit` → quality, `tips` → the corner dock, `notes` → workbench).
  **Mission Control's room is part of the URL** (#316) and `Control.tsx` writes it back with
  `history.replaceState`, never a push, so Back leaves Mission Control rather than walking the rooms
  you looked at. `#/control` is the one canonical spelling of the default room; an unknown room lands
  there rather than 404ing, which is what keeps a link to a removed room working.
- `screens/` — `ls` is the index. What it doesn't say: Mission Control is a shell (`Control.tsx`) plus
  one file per room, and `detail/Tips.tsx` is NOT a tab — the recipe library is app-wide, opened from
  `components/TipsDock`.
- `lib/brief.ts` — the resume brief + the `DIRECTIVES` catalogue (keys mirror `SESSION_DEFAULTS`).
- `lib/termClipboard.ts` — copy/paste for both xterms; its header says why ⌃C, ⌃V and OSC 52 each
  behave unlike a native terminal. Don't "simplify" any of the three.
- `styles.css` — **the palette is the named CSS variables at the top of `:root`** (Atlas): neutrals,
  the terracotta accent ramp and the semantic tones (`--live --building --sage --critical --paused`).
  Add or adjust tones THERE, never as inline hexes. Dark mode is one `[data-theme='dark']` block on
  the same tokens.

### server/src

- `schema.sql` — idempotent (ADD COLUMN IF NOT EXISTS + convergent data migrations). Read it for the
  column list; the non-obvious semantics are under **Data rules**.
- `util.js` — helpers, `computeProgress` and the **three single-knob constants**: `STALE_DAYS` (14),
  `PRESENCE_TTL_MINUTES` (240 — the crashed-session backstop), `CHECK_HISTORY_KEEP` (60 per check).
- `shape.js` — the run ledger's SHARED shapes (`runCore`, `agentReads`): four routes serve
  `autopilot_runs` rows and each had grown its own drifting copy. **BIGINT and NUMERIC come back from
  pg as STRINGS**, so `tokens`/`cost_usd` need `Number()` while INT columns only need their null
  preserved — that coercion is what the copies got wrong.
- `settings.js` — `readSettings()` **defaults to "on" when the row is missing**, and the hooks default
  to "on" when the API is unreachable, so a flaky API degrades to recording rather than silent-off.
- `routes/` — one file per surface. `ingest.js` carries the most invariants; read it first.

## The ingest package (what /checkpoint and the hook send)

`{ project, session, extract }` — full field list in `hook/stack-post.mjs` and
`.claude/commands/checkpoint.md`. What you'd guess wrong: `session.authored` (true = rich
`/checkpoint`, false = the hook's metadata backstop) and the usage fields (`tokens_used`,
`model_usage`, `agent_calls`, `agent_types`) being **hook-only**, since it alone reads the transcript.

Ingest, in one transaction: upsert the project by slug (first push creates it, assigns a tint, fills
`repo_url` once via COALESCE so a hand-set URL is never overwritten); record the session; refresh the
live resume fields; land extraction with `link_ref` = the commit. **Four invariants:**

1. **Idempotent on session_id, THEN commit_hash — never the other way round.** Matching the commit
   first collapsed parallel sessions: several in one checkout end at the same HEAD, so three pushes
   became one row. The fallback still lets the SessionEnd backstop claim the authored `/checkpoint` row
   (which posts no session_id), but only while that row is **unclaimed**.
2. **`authored` is what makes the metadata backstop safe.** The session-row update is COALESCE-safe: a
   metadata post never overwrites an authored summary/current_phase, and the jsonb lists only
   overwrite when non-empty. `authored` is sticky (`authored OR $incoming`).
3. **The resume refresh runs only for `authored:true` posts** (and only while `keep_resume_card` is
   on). The metadata hook records the activity row and bumps `last_session_at`, nothing more.
4. **Auto-extraction dedups on fingerprint and honours the `dismissed_items` tombstone table.** An
   existing auto item is re-pointed at the new commit, never duplicated; a dismissed fingerprint is
   skipped; manual items are never touched. `reviewed_at` survives a re-point, so approving is sticky.

## Progress model (`util.computeProgress`)

The single definition of "how done is a project". Only Must/Should items count; a done Must weighs
double a done Should; capped at 90% while any critical/high bug is open; 0% with no Must/Should items.
On every project payload, and the Dashboard's "Progress by app" panel is this and says so —
deliberately NOT called a health score.

## Data rules (the non-obvious column semantics)

The ones a session gets wrong by guessing. Everything else, read off `schema.sql`.

- **`bucket` vs `tier`** — bucket (must/should/could/wont) is how NECESSARY; `tier` (#227, S/A/B/C,
  NULL = unranked) is how much the owner wants it NEXT, and is the **primary sort of the run queue**
  (bucket then `position` tiebreak, unranked last). Set only from the Tiers view — **agents must never
  change it.**
- **`risk`** (low/normal/high, #212) is how much DAMAGE a wrong build does — not difficulty, not the
  desire `tier` expresses; a `low` item whose run lands green auto-queues its own merge.
  **`risk_source` is who decided** (#262): `human` = the modal, `auto` = the plan-time pre-pass, NULL =
  the `normal` nobody chose — and NULL is the only state an auto write may replace. The guard is CASE
  expressions inside `PATCH /roadmap/:id`'s own UPDATE (right-hand sides see the OLD row, so two nights
  can't race it); **never write `risk` from any path bypassing that PATCH.** Absent `risk_source` =
  human, unrecognised = auto — the fallback leans to the branch a row can still refuse. The modal sends
  `risk` only when the human touched the control, or every save silently reclaims the tier.
- **The board order IS the run queue.** `position` is PATCHable and drag-reorderable; the Plan room's
  Save-order write is the same PATCH the drag makes.
- **`claimed_by` is the branch claim** (#277 — called a "lane" until the rename; the `lane/` git ref
  prefix is unchanged, naming branches already on origin). Claim before starting; a terminal tab's
  claim is `term:<name>`. It is the don't-re-pick marker, injected by SessionStart as "Branch claims —
  respect these", and stays until a human merges and ticks.
- **Three gates decide who runs, and merging any two is where they get confused** (#267 + #335).
  `CLAIM_NEXT_SQL` in `routes/autopilot.js` carries all three in one WHERE: the **fleet cap** (`$1`,
  `autopilotWorkers`, tunable), the **per-project serialisation** (fixed) and the **area lane** (`$2`,
  fixed). Per-project cannot become a knob — every job runs against the one checkout at
  `$STACK_AUTOPILOT_ROOT/<slug>`, where two runners moving refs fight over git's ref locks — so
  widening concurrency widens the fleet cap and never the other two. The host lockfile is per-project
  (`~/.stack/autopilot-<slug>.lock`), named by the same sanitiser in the runner and the dispatcher's
  kill path; diverge the spellings and the kill path clears the wrong file, leaving a live lock
  blocking that project for hours. `heldByArea` reports only LANE holds — a job waiting on the cap is
  not held by an area, and saying so blames the wrong thing.
- **An area lane is `(project, area)`, and untagged is never a lane** (#267): an area with an OPEN
  claimed item admits no second worker, because two branches in one area collide at merge time. The rule
  lives in `server/src/lanes.js` (pure) and is MIRRORED in four runtimes that cannot import each other —
  `routes/autopilot.js`'s claim, `pickFor()` in `control.js`, the runner's pick and
  `schedulable()`/`heldWhy()` in `ControlRooms.tsx`; change one, change all four. Two carve-outs are
  load-bearing: an untagged (`''`) area never occupies or is blocked by a lane (else every untagged item
  collapses into one giant lane and the night silently does nothing), and the key includes the project.
  A worker never blocks itself. A skipped job always logs why: a lane delay must never be a silence.
- **"Approved for the auto runner" is `source <> 'hook' OR reviewed_at IS NOT NULL`** (#359), with no
  column of its own — an `approved` flag would be a second, drifting truth. Hook-extracted items need a
  human's sign-off in the Plan room inbox; **a manual item is NEVER held**, because blocking
  hand-written work is the failure mode this must not have. Written out THREE times (`server/src/`,
  `scripts/lib/`, `web/src/lib/approval.*`) since none of the packages can import another. An
  unattended enqueue **drops a held item silently**; Run now / `POST /start` **refuses out loud and
  names it**, since a silent drop under a button looks like the press did nothing. Not the **verdict**
  queue below: this gates what may RUN, that queues what was BUILT.
- **Branch names are `<kind>/<id>-<summary>`** (#363; feat · fix · ui · refactor · perf · test · docs ·
  chore). `scripts/lib/lane.mjs` is the canonical namer AND parser; `web/src/lib/branch.ts` is its
  client twin, kept in step by discipline, not a shared test. **The old flat `auto/item-N-<slug>`
  spelling must keep parsing forever** — those branches are on origin and in live `claimed_by` strings,
  so a reader knowing only the new form reports a working fleet as empty. A legacy lane's kind is `''`,
  **never `feat`**. SQL that tested `branch LIKE 'auto/%'` goes through `laneSql()` in `control.js` — a
  predicate knowing only `auto/` blanks the last-auto chip and the reviewer's notes. A worktree's
  `itemId` (#365) uses the same `parseBranch`, so the server never grows a third copy.
- **`built_note`** — what actually landed, PATCHed by the completing session; the Review room verdicts
  against it. Always write one.
- **The Review queue is BUILT-or-ticked, not ticked** (#374). Nothing in Stack ticks an item, so a
  `done = true` queue showed an empty room over a full night. `routes/review.js` queues `done` **OR**
  (`built_note` non-empty **AND** `claimed_by` non-empty), each row carrying `stage`. **Both halves are
  load-bearing**: un-ticking clears `claimed_by` and keeps `built_note`, so `built_note` alone re-queues
  rejected changes and `claimed_by` alone queues items at claim time. So `settled` tests the verdict and
  **nothing about `done`**, and approving does NOT tick (the merge job does, with a human verdict
  stored). **Anything acting on a change in that room shares the predicate** — the Foreman's ops opened
  `if (!item.done) 400` until #375.
- **`verdict_source` / `verdict_at` / `verdict_evidence` (#263, owner-sanctioned)** — the one place a
  machine may verdict instead of the human, and only while it is **positive evidence**, **reversible**
  and **visible**; drop one and it is not sanctioned. The gate is one pure function,
  `scripts/lib/autoverdict.mjs`, whose header carries the reasoning — never a second spelling. Two
  exclusions are not negotiable: a refine round and a limit-hit run. Clearing `review_tag` resets
  `verdict_source` to 'human' and wipes the other two in the same statement, so ⎌ undo needs no second
  route; `verdict_evidence` is the receipt, shown in the AUTO-VERDICTED strip and the night log.
- **Un-ticking clears `review_tag` and `claimed_by`** (unless the same PATCH sets them), so a sent-back
  item re-enters play fresh. Ticking clears `review_tags`, `refine_note` and `review_shelved` — each
  verify round starts unannotated.
- **A refine round is never machine-closed** (#274): no auto-merge (#212), no auto-verdict (#263),
  because closing it on a green run discards the very judgement the send-back asked for. It continues
  the item's OWN branch (`scripts/lib/refine.mjs`, which says why), and `refine_note` surviving until
  the tick is what makes "is this an unclosed round" answerable at all.
- **`agent_profiles` holds only OVERRIDES.** The built-ins (`executor`, `reviewer`) live in
  `server/src/agent-profiles.js` and are never seeded, so a fresh database spawns identically to a
  customised one — DELETE on a builtin RESETS it rather than removing it, because the spawn path needs
  `executor`. `roadmap_items.agent_profile` ('' = default) is the Polaris hook: a free string,
  validated client-side, deliberately absent from the tick/un-tick clearing lists. The invariant with
  teeth: **a spawn always gets at least one building agent** (no profiles, all disabled or an unknown
  key all fall back to the executor), or the expensive director model silently does all the building.
- **A future's SHAPE in the Polaris galaxy (#312) is derived, never stored** — star → planet → moon →
  shells → drift belt, from `is_star`/parent/`alignment`, with no `kind` column and there must not be
  one. `PATCH /futures/:id` owns the depth and demotion rules and is the only guard; its header spells
  them out. `magnitude` is nullable on purpose — an unsized idea says "not sized yet".
- **A Workbench card is a PLACEMENT, not content** — `workbench_cards` holds where something sits and a
  `note`/`polaris` card's words are read THROUGH from `notes`/`futures`; copying the text onto the card
  is what leaves ⌘K searching a stale one. The canvas's other invariants are in
  `routes/workbench.js`'s header — read it before touching the canvas. Every ✧ op only PROPOSES a card; `Promote N phases → Roadmap` is the dispose
  half, an ordinary roadmap POST.
- **The Roles room reads two populations and must never mix their judgement.** `autopilot_runs` answers
  to the executor/advisor policy; `sessions.model_usage` (the human's interactive work) does not, so a
  model picked by hand is **not drift**. They merge only in the `everyModel` receipt and `manual`, and
  merged shares are **token-based**, because a transcript carries no cost. A manual session's
  `model_usage` (main loop) and `agent_usage` (subagents) ARE its director/executor split.
- **A subagent's usage is NOT in the parent transcript — it has its own**, at
  `<transcript-dir>/<session-id>/subagents/agent-*.jsonl` with a `.meta.json` naming the `agentType`.
  The parent records only the Agent call and never sets `isSidechain`, so globbing top-level `*.jsonl`
  concludes — wrongly — that subagent spend is unrecoverable; it is routinely the LARGER half.
  `agents_recorded` is what `agent_usage` prices, so a lost transcript reads as unpriced, not free, and
  since neither source counts every delegation, `agent_calls` is the MAX of the two.
- **A plan night is the advisor working, not idle.** `planned` commits nothing by design, so it can
  never be `landed`: counted apart (`planRuns`/`advisedPlanRuns`) and sitting out the land rate while
  keeping its spend and role attribution. Folding it back in scores the advisor as having failed to
  land runs nobody asked it to land.
- **An empty second-model read means NO PASS RAN, not "nothing found".** `review_verdict` /
  `architect_verdict` NULL renders as NO REVIEW, deliberately not as green. Same rule anywhere an
  agent's opinion is stored.
- **`autopilot_jobs.branch` is a real column; a merge job's branch still round-trips through free-text
  `detail`** (#243) — three places re-parse that string, so merge's contract was left alone. The
  `advise` lane matches on the column; its `advice` NULL means NO PASS RAN, never "no conflicts".
- **A night's debrief arithmetic has one definition, `server/src/debrief.js`** (pure, DB-free), and
  `GET /api/review/debrief` composes one night from the same rows the `nights` index is built from, so
  the two can't drift. The five outcomes partition across four buckets — `landed` / `failed` (failed +
  limit) / `planned` / `noCommits` — which always sum to `stats.runs`.
- **Deleting a `source='hook'` bug, roadmap item or future tombstones its fingerprint** so the next
  push won't re-create it. That is what Dismiss means, and why it has no undo.
- **`DELETE /api/projects/:slug` is SOFT** — stamps `deleted_at`, clears the share link, keeps every
  row; deleted projects vanish from live queries and their collection routes 404. The real cascade is
  `/purge`, valid only on binned projects.
- **`checks.auth`, `checks.external` and what an edit clears are in `routes/checks.js`'s header** —
  read it before changing a check's columns. The cross-cutting half: `/report` writes `check_results`
  but NOT a `check_runs` row, because `check_runs` is the SUITE's ledger that #212 auto-merge and #263
  auto-verdict spend against — one reported result there would read as a suite of 1/1 passed, a green
  light manufacturable from outside Stack.
- **The `worktrees` table is a REGISTER, not a manager** (#229, and `routes/worktrees.js`'s header says
  why): the host alone runs git, identity is the PATH, release is a stamp. Two things that reach past
  that file: `session_name` keeps the `stack-term-` prefix, which is what puts a session on the
  running-sessions strip and what the host reapers key off; and trees live at
  `~/.stack/worktrees/<key>`, inside the $HOME cwd jail the daemon enforces — move the root outside
  $HOME and browser access breaks silently.
- **`0 = unlimited`** for `autopilotTokens`/`autopilotMaxItems` (#260); `termIdleHours` 0 = never.
- **A managed CLAUDE.md is written by the HOST from Stack's copy**, so editing one in a repo by hand is
  a change the next sync overwrites — go through `PATCH /api/instructions/:id`. `body` IS the file:
  rules, scopes, off switches, precedence and the merge preview are derived in `lib/instructions.ts`,
  never stored, since a rules table is wrong the moment somebody edits the file on disk. The
  `<!-- stack-managed -->` marker and the ONE-TIME Adopt licence are in `routes/instructions.js`.
- **A worktree report's NULL is not `[]`** (#365) — same rule as a NULL `review_verdict`: defaulting it
  to `[]` reports uncommitted work as absent. The client type is `Worktree[] | null` and `getControl`
  must never default it.
- **A feature's STAGE (#365) and a branch's four-valued merge state (#363) are derived, never stored**,
  in `web/src/lib/feature.ts` and `web/src/lib/branch.ts` — both headers carry the guesses that cost
  the first cut its correctness. The one to hold in mind everywhere: **`unprobed` is not `clean`**, the
  same NO PASS RAN rule as a NULL `review_verdict`.
- **`projects.merge_autonomy` is not `automode`** (#363 — auto | plan | off, default plan). `automode`
  says whether a project is BUILT unattended; this says how much of its MERGING one press of ▶ Run
  covers. `plan` still names its branches in the plan (an ordering that hid them would not be honest)
  but the press leaves them alone. None of the three relaxes the conflict probe, the #212 risk gate or
  the merge confirm.
- **The MERGE AGENT is arithmetic plus a read, and the two must not be confused** (#364). The waves are
  computed in the browser from file paths and are deterministic; `POST /api/merge/review` is the
  optional second half, where Claude reads the REAL diffs on the host and annotates that plan — never
  reordering, never queueing. `verdict: 'ok'` with no notes is a REAL answer and must not render like
  "no read has run". The host caps the diffs and **states what it cut inside the prompt**: a model that
  silently saw a tenth of a diff answers confidently about the other nine.
- **THE TAB AGENTS RUN CLAUDE ON THE HOST (#364), not Gemini** — `agentClient().ask()` goes through the
  terminal daemon's uplink to `claude -p --output-format json`, the owner's own subscription, so the
  no-paid-external-AI rule holds. Three consequences: **the readiness signal is the DAEMON, not a key**
  (a switched-off agent is reported before an offline host); **every tool is disabled and they run in a
  scratch directory**, because an agent prompt is assembled from tracker rows — text somebody else
  wrote — and NOT the autopilot's `--dangerously-skip-permissions` posture, safe only because it runs
  its own code in a throwaway worktree; and **`ask()` returns PARSED JSON**
  (`parseAgentJson`, fence-tolerant), which every ✧ call site depends on. **Gemini is not gone**:
  the per-push review note, check assertions, session labelling, triage and the Workbench ops are
  still Gemini and still key-gated.
- **A TAB AGENT'S CONSOLE IS SPAWNED AS THE AGENT (#379, #380)** — `routes/console.js` composes the
  briefing, the daemon appends it with `--append-system-prompt` (`terminal/console-launch.mjs`), and
  both headers carry the rest. **A system prompt, never a pasted brief**: nothing is typed in, and the
  identity outlives a conversation a paste falls out of. The snapshot SAYS it is one. **Fail OPEN** —
  an unreachable briefing opens the console unprimed and says so. `lib/agentConsole.ts` names it; the
  Terminal screen parses that name to title one.
- **AN AGENT'S BINDING IS CODE, NOT DATA (#361, #375).** `src/agents.js` is the registry and its header
  lists the agents and their surfaces. The rules that bite: each agent's `ops` list is CLOSED, and
  `agent_configs` holds only what the owner tunes (enabled, model, guidance, `ops_off`) — never which
  surface or which ops, because those are the restriction itself. A route binds once
  (`agentClient('auditor')`) and that client THROWS on another agent's op; that throw, not a comment,
  stops one tab's route running another's, and an unregistered op cannot run at all. An op
  MOVES with its surface (#375 moved `reviewbrief`/`refinedraft` off the Curator): **one surface, one
  switch**. **A missing config row means ON**, as with `readSettings()`; off means off
  everywhere. An op's `backend` may be `'gemini'`, so a surface with two backends still has ONE switch;
  only readiness and the refusal differ, and the refusal must NAME the missing backend. **`ops` may be
  EMPTY** (the Auditor's is — its live session replaced it), and a retired op resolves to NO agent.
- **THE FOREMAN ANNOTATES A VERDICT; IT NEVER GIVES ONE (#375).** `readchange` returns a CALL (approve /
  look / send-back) drawn in the accent, never a verdict tone — the three verdict buttons are the only
  green in that room. Every answer carries **`blind[]`** (what it could not see) and
  **`read[]`** (what the server assembled), the blind list rendered hardest under an `approve`.
  `where[]` is the one agent field that becomes **a link the owner clicks**, so `cleanPath()` drops
  anything that is not a same-origin path. `triagequeue` returns an ORDER and no judgements; a change
  it fails to place is appended, never dropped.
- **A MIRROR SITE ON THE CHANGE UNDER REVIEW IS THE POINT OF THE ROOM (#375).** Previews (#208) are
  reachable from the room's built changes and `where[]` links into them. They arrive as PROPS from
  `Control.tsx`, which already polls them — a second poller would show two answers for one row. Built
  changes only: a ticked one is on main.
- **The Review rail's clusters are derived and its batch overlay has one home** — see
  `ControlReview.tsx`'s header. The rule that generalises: a cluster's evidence summary counts unrun
  checks and absent verdicts APART from green and clean, or a select-all becomes a blind mass-approve.
- **An autopilot `stack-auto-*` session is READABLE from the browser and still not mirrorable, killable
  or typeable-into** (#366). `listAutoSessions()` is a SIBLING of `listStackSessions()`, and the
  terminal's mirror/kill/reap paths read the `stack-term-*` list only — widening `listStackSessions` to
  cover both is the obvious tidy-up, and it hands the browser a kill button for a session running with
  `--dangerously-skip-permissions`. The rest is in `routes/terminal.js`'s header.

## Fail-safe direction (get this right or you delete work)

Every host-side automation must decide what an unreachable API means. **The direction is not uniform,
and it is not a bug that it isn't:**

- **Fail SAFE = do nothing** where the action destroys or spends: the idle reaper (#287), the skills
  sync (#228 — it deletes files), the dispatcher, the arm switch, `stack worktrees --prune` (#229). An
  unknown threshold reaps NOTHING.
- **Fail OPEN = keep recording** where the action only records: `readSettings()` and both hooks default
  to "on", so a flaky API degrades to recording rather than to silent-off.
- **Fail SILENT = report nothing** where the reader would mistake absence for good news. `attention[]`
  and `conflicts[]` are empty with no host daemon on the line, so the Now room reads
  `terminal.connected` and says "Stack cannot see whether a session is stopped" rather than "nothing is
  waiting on you". Same rule as a NULL `review_verdict`.
- **Fail LOUD = exit 1 with a reason** where the reader would mistake "could not look" for "looked and
  found nothing". `scripts/playwright/smoke.mjs` (#291) exits 0 only on a clean pass — an unreachable
  app reporting zero findings is the NULL-verdict lie again.

Related and just as absolute: **Stack only ever writes or removes skills IT PLANTED** — each managed
directory carries a `.stack-managed` marker, a skill without one is REPORTED and never touched, and
removal is driven by the server's KEEP list, never a diff against the last report. **A preview never
writes to the real database.** And `scripts/lib/worktree.mjs` (#229) fails safe both ways — it deletes
only what git vouches for, never over a dirty tree or an existing path, and `orphanWorktrees` only
reports; its header says why each of those is not negotiable.

## Answering a permission prompt from the browser

`POST /api/terminal/answer` is the ONLY path by which anything but a human at the keyboard types into a
running session, and every rule on it exists because of one hazard: **the row the human clicked was
drawn from a pane read up to twenty seconds ago**, in which time the session can have been answered at
the keyboard and be sitting on a text input where the menu was — so "1" becomes a stray digit in
someone's message. The rules that follow from it (who decides, what the fingerprint covers, why
Approve never sends "and don't ask again", why the refusal is shown verbatim) are in
`routes/terminal.js`, at the route.

`terminal/prompt-scan.mjs` is pure and leans hard towards null: a false block puts an Approve button in
front of a question nobody asked, far worse than a real block noticed a minute late.
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
- Host logs live in `~/.stack/`; the dispatcher is a crontab line and removing it disables all runs.
- **An alternative-provider key resolves `process.env` → `~/.stack/env` → `~/.ccm_config`** (the ccm
  tool's file, key=value OR JSON), via `terminal/model-switch.mjs` — every reader goes through it
  rather than `process.env` directly, since a standalone script has not loaded `~/.stack/env`. No
  surface ever prints any part of a key; `./stack models` reports the SOURCE and a character count.

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
| `keepResumeCard` | off → ingest skips the resume refresh and the deck/Overview drop the card |
| `sessionDefaults` | catalogue keys (lean/ship/checkpoint/confirm/verify) rendered server-side and injected by SessionStart into EVERY project. `ship` = commits pre-authorised, granted once |
| `autopilotEnabled` | the ARM SWITCH. Nightly + scheduled jobs only enqueue while on; ▶ Run now stays manual-only |
| `autopilotWorkers` | the FLEET-WIDE cap on concurrent jobs (0 = unlimited, default 3, clamped 1–8); per-project serialisation is separate and NOT tunable |
| `autopilotExecutorModel` / `autopilotAdvisorModel` | #153, **inverted by #285**: the ADVISOR runs the session (main loop, plans, delegates, verifies, commits) and the EXECUTOR is exposed to it as a subagent with the write tools. Advisor unset = single-model on the executor |
| `assistFields` / `assistGuidance` | what ✧ Fill-from-note may fill, and the owner's standing steer. Assist never overrides a value the human set, and **tier S is offered, never assigned** |
| `termIdleHours` | the idle-session reaper's threshold (0 = never); the host does the killing and fails SAFE |
| `accessPinSet` | PIN sign-in available; PATCH takes write-only `accessPin` ('' disables). Any change signs out every PIN-connected device |

## Routes

One file per surface in `server/src/routes/` — `ls` is the index. All behind bearer auth except
`GET /api/health`, `POST /api/auth/login`, `GET /api/public/:slug/:token`. What filenames don't say:

- **Read layers** (`overview`, `control`, `review`, `search`, `timeline`, `public`) are computed in a
  handful of aggregate queries — **never one query per project**; keep it that way. `control.js` also
  exports the pure `computeFleetRoles()`; `review.js` serves the room, `/debrief` and the Foreman's four ops.
- `merge.js` (#364) — the Merge agent's read; the only agent op needing the CODE, so diffs are gathered
  host-side. `routes/agents.js` is the agents' CONFIG; the REGISTRY is `src/agents.js`. Per-project collections mount under `/api/projects/:slug/…` with `mergeParams`, and
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
- **Checks are Stack's only automated regression net.** When a route's payload contract changes, change
  its check in the same commit — a green suite is the evidence #212 and #263 spend.
- `templates/stack-agent-context.md` is the single source of truth for the portable agent manual — if the
  API or hook contract changes, update it (`scripts/stack-context.mjs` exports it verbatim).
- **A strict build is necessary and no longer sufficient for UI work.** Run `scripts/run-ui-smoke.sh` (or
  `./stack ui-smoke`) before calling a UI change done — two real layout bugs reached the owner because a
  session had no way to see its own rendering (#291).
- **A recurring re-fetch goes through `lib/autoRefresh.ts` (#312), never a bare `setInterval`.** One
  device-local setting (Settings → Auto refresh; 0 = off) governs every screen watching the host, and it
  is also what stops a hidden tab polling. Device-local because the BROWSER polls; contrast
  `termIdleHours`, app-wide because the HOST does that killing.

## Gotchas

- `server` retries the first Postgres connection — don't "fix" that; it's what survives compose order.
- **A capped list inside a prompt must say it is capped, and on the right axis** (#239) — the rule is in
  `prompts.js`'s header. It applies to any list in any prompt.
- Status vocabulary is `live | building | paused | archived`. The old `active` migrates to `live`.
- The web Dockerfile is multi-stage (Vite build → nginx), which does SPA fallback **and** proxies
  `/api` to `server:4000` plus `/term*` with upgrade headers; in local dev Vite proxies `/api`.
  **Host-side agent ops run far longer than a web request** — nginx's `/api` read timeout and each op's
  own timeout must both clear `claude -p` (a 60s cut made the Merge agent's 240s read unreachable,
  silently, for weeks), and Cloudflare cuts at ~100s regardless.
- Both closure counts in `totals` lean on `updated_at`, the only stamp either table carries — read them
  as MOVEMENT, not an exact ledger.
- **`autopilot.js`'s `JOB_SELECT` is shared with `control.js` and must stay that way** (#243) — a private
  `SELECT j.*` ships the kilobyte `advice` text on every Mission Control poll AND leaves `adviceReady`
  false forever, silently disabling the feature.
- `stack-autopilot.mjs` still inlines its own `git worktree add/remove` rather than calling
  `scripts/lib/worktree.mjs` (#229) — deliberately NOT refactored: the nightly is how this repo builds
  itself, so pointing it at the module is a behaviour change, not a tidy-up.
- **`grep` goes blind on `routes/control.js`** — it holds literal NUL bytes, so plain grep silently
  returns nothing. Use `LC_ALL=C grep -an`.
- `scripts/feature.test.mjs` (#365) runs `web/src` TypeScript directly under Node's type-stripping
  loader with a `module.registerHooks` shim; follow that pattern for client-side coverage.

## Tests and quick commands

`ls server/test/ scripts/*.test.mjs web/test/` is the test index — each name says what it pins, each
header says how to run it. Most are **pure** (`node <file>`); ones needing a live API + `DATABASE_URL`
say so at the top — stand up a throwaway `postgres:16-alpine` rather than treating "no database here"
as a blocker. `scripts/context-budget.test.mjs` guards THIS file; `scripts/roadmap-refs.mjs` checks
every `#id` cited in the repo against the real board.

```bash
node hook/stack-session-{end,start}.mjs --demo   # fire the backstop / print the resume block
node hook/stack-checkpoint.mjs --settings  # print current settings (what /checkpoint reads)
cp hook/*.mjs ~/.stack/                    # install the hooks — ~/.stack holds COPIES
./stack                                    # the host CLI — bare prints its sub-commands, --help each;
                                           # the writing ones are DRY until --run
node scripts/stack-autopilot.mjs --project stack --repo /home/bailey/stack --dry  # tonight's pick?
node scripts/stack-autopilot-dispatch.mjs  # one dispatcher poll by hand (normally the cron line)
node scripts/stack-preview.mjs --start <id>  # bring a branch up as a preview (normally spawned)
node hook/stack-gemini-review.mjs --dry    # second-model review of the last commit (--architect #284)
node terminal/stack-term.mjs               # the web-terminal daemon (normally the @reboot cron line)
crontab -l                                 # the dispatcher line — remove it to disable all runs
tail -f ~/.stack/{term,autopilot,preview}.log
```

<!-- stack-managed -->
