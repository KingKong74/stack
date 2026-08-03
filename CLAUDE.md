# CLAUDE.md — working notes for Stack

Context for any Claude (or human) picking this repo up in a terminal. Read this first.

**What this file is for:** the rules and invariants you cannot read off the code — why something is
the way it is, and what will break if you change it. It is deliberately NOT a feature list or an API
reference; the code is the reference, and a doc that restates it only drifts. Design rationale for a
shipped feature lives in its commit message and the roadmap item's `built_note`, which Stack itself
stores and shows on the Review room. Add to this file only when a session would get something WRONG
without it.

## What Stack is

A self-hosted side-project command centre. The point is **frictionless resume**: open a project and
the "pick up where you left off" card tells you exactly where you were. A push also auto-extracts
bugs and next-steps into the trackers, and the dashboard progress is computed, not hand-set. Built
from the Atlas design handoff (colours, type, spacing, copy and interactions are intended to match).

The north star: an autonomous software house run from the director's chair — Polaris plans, executor
fleets build overnight in parallel branches, advisors keep model spend lean, and the human steers and
gives verdicts.

## Layout

```
web/       Vite + React 18 + TS (strict). Hash-routed. Persistence is the Postgres API, reached ONLY
           through src/store.ts (every function async, bearer-token auth).
server/    Express + Postgres. Idempotent schema migrate on boot, retries first DB connect. Bearer
           auth on every route except GET /api/health; fails closed if API_TOKEN is unset.
hook/      Zero-dependency Node ESM Claude Code hooks + the /checkpoint poster.
terminal/  The web terminal's host-side daemon (dials OUT to the server; the host firewall drops
           container→host traffic).
scripts/   The host-side CLI + automation (autopilot, dispatcher, previews, skills, tree, checks,
           the Playwright UI smoke harness).
templates/ stack-agent-context.md — the canonical portable agent manual (single source of truth).
.claude/commands/checkpoint.md — the /checkpoint slash command (install to ~/.claude/commands/).
```

### web/src

- **`store.ts` is the only module that touches the network or device storage.** Components never
  `fetch` and never touch localStorage directly. `request()` attaches the bearer and throws
  `AuthError` on 401, which clears the token and returns to the gate.
- `lib/route.ts` — hash router. Routes: `#/`, `#/settings`, `#/control[/<room>]`, `#/terminal`,
  `#/skills`, `#/timeline`, `#/p/<slug>[/<tab>][?hl=<x>]`. `go.detail(slug, tab, highlight)`
  deep-links; the TAB decides what `hl` means (commit hash → activity, bug key → quality, row id →
  roadmap, NOTE id → workbench). Legacy `bugs`/`audit` tabs both resolve to `quality` (#278), `tips`
  to `overview` (the library moved to the corner dock) and `notes` to `workbench`, so old links keep
  working. **Mission Control's room is part of the URL** (#316 — `#/control/review` is the quick link
  to a verdict): the room comes in from the route and Control.tsx writes it back with
  `history.replaceState`, never a push, so Back leaves Mission Control rather than walking the rooms
  you looked at — and that write only ever re-spells a URL that is already `/control`. `#/control` is
  the one canonical spelling of the default room, and an unknown room lands there rather than 404ing.
- `screens/` — Dashboard (five anchored sections behind a sticky SubNav), ProjectDetail (owns tab +
  modal state), Settings, Control (Mission Control — one room per question, behind a live strip and a
  persistent right rail; `Control.tsx` is the shell and each room has its own file: `ControlNow` /
  `ControlRooms` (Nights, Plan) / `ControlReview` (#375 — the queue, its agent the Foreman, and a
  mirror site on the change under review) / `ControlRoles` / `ControlAgents` (#361 — all five
  agents) / `ControlMerge` (#363 — the house-wide branch ledger and the merge agent),
  with the merged session list in `ControlLanes`, whose autopilot lanes open a read-only Watch
  panel, `ControlWatch.tsx` (#366)). A former room, BUILD, was removed with its
  `ControlRooms` (Nights, Plan) / `ControlReview` / `ControlRoles` / `ControlAgents` (#361 — the
  three tab agents) / `ControlMerge` (#363 — the house-wide branch ledger and the merge agent) /
  `ControlTrees` (#365 — read-only: it takes `data` and wires no mutation handlers, because Merge
  stays where things are pressed; it groups by STAGE rather than by project because its question is
  "how far has this got", not "what can I land"), with the merged session list in `ControlLanes`).
  A former room, BUILD, was removed with its
  tab: its two gates belong to other rooms now — the verdict is Review's whole subject, the
  merge is the Now room's branch strip and, house-wide, the Merge room — and
  `#/control/build` falls back to the default room. Then Terminal, Skills.
  `detail/` holds the project tabs: Overview, Quality (#278 — Bugs and Audit merged into
  one page), Roadmap (Board / Tiers / Parked), Futures (the Polaris galaxy — Sky / Board / List,
  geometry in `detail/Galaxy.tsx`), Workbench (the planning canvas that replaced the notes wall —
  see **The Workbench** below), Activity. `detail/Tips.tsx` is NOT a tab: the recipe
  library is app-wide, so it opens from the bottom-left `components/TipsDock` on every screen and a
  legacy `/tips` link opens the dock rather than a tab.
- `lib/brief.ts` — the exportable resume brief + the `DIRECTIVES` catalogue (keys mirror the
  server's `SESSION_DEFAULTS`). Pure formatting; data arrives via store.ts callers.
- `lib/termClipboard.ts` — copy/paste for both xterms. A browser is not a terminal emulator: ⌃C
  copies only while a selection exists (so the next press is still SIGINT), ⌃V returns false WITHOUT
  preventDefault so the browser's own paste event reaches xterm's bracketed-paste handler (no
  clipboard-READ permission, which Firefox never grants), and an OSC 52 `?` payload — the host
  READING the clipboard — is never answered.
- `styles.css` — **the formal palette is the named CSS variables at the top of `:root`** (Atlas):
  neutrals (`--paper --surface --sand --keyline --muted --ink`), the terracotta accent ramp
  (`--accent-deep` hover · `--accent` · `--accent-soft` · `--accent-tint` · `--accent-tint-border`)
  and semantic tones (`--live --building --sage --critical --paused`). Add or adjust tones THERE,
  never as inline hexes; every terracotta button hovers to `--accent-deep`. Dark mode is one
  `[data-theme='dark']` override block on the same named tokens plus a short list of literal-
  background fixups.

### server/src

- `schema.sql` — idempotent (ADD COLUMN IF NOT EXISTS + convergent data migrations). Read it for the
  real column list; the non-obvious semantics are under **Data rules** below.
- `util.js` — `slugify`, `fingerprint` (title normalised), `relativeTime`, palettes, and the
  **three single-knob constants**: `STALE_DAYS` (14 — the deck's stale threshold),
  `PRESENCE_TTL_MINUTES` (240 — the crashed-session backstop) and `CHECK_HISTORY_KEEP` (60 — rows
  kept per check). Plus `computeProgress` (see below).
- `shape.js` — row → client-shape mappers, plus the run ledger's SHARED shapes: `runCore(row)` and
  `agentReads(row)`. Four routes serve `autopilot_runs` rows and each had grown its own drifting
  copy. **BIGINT and NUMERIC come back from pg as STRINGS**, so `tokens`/`cost_usd` need `Number()`
  while INT columns only need their null preserved — that coercion is what the copies got wrong.
  Pinned by `server/test/run-shape.test.mjs`.
- `settings.js` — the single-row settings. `readSettings()` **defaults to "on" when the row is
  missing**, and the hooks default to "on" when the API is unreachable, so a flaky API degrades to
  recording rather than silent-off. Keep that.
- `routes/` — one file per surface. `ingest.js` and `audit.js` carry the most invariants; both have
  long explanatory headers, read them before editing.

## The ingest package (what /checkpoint and the hook send)

```jsonc
{
  "project": { "slug": "stack", "name": "Stack", "repo": "owner/repo", "repo_url": "https://…" },
  "session": {
    "session_id": "…", "commit_hash": "6234a79", "branch": "main", "cwd": "…", "model": "…",
    "reason": "exit", "message_count": 12,
    "authored": true,                  // true = rich /checkpoint; false = the hook's metadata backstop
    "summary": "…", "current_phase": "…",
    "next_steps": ["…"], "blockers": ["…"],
    "in_progress": ["…"], "next_up": ["…"], "working_well": ["…"],
    "tags": ["…"], "files_touched": ["…"], "tools_used": ["…"],
    // hook-only (it alone reads the transcript); /checkpoint never sends these
    "tokens_used": 123456,
    "model_usage": { "claude-opus-5": { "inputTokens": 1, "outputTokens": 1,
                                        "cacheReadInputTokens": 1, "cacheCreationInputTokens": 1 } },
    "agent_calls": 3, "agent_types": { "Explore": 2, "general-purpose": 1 }
  },
  "extract": {
    "bugs":       [{ "title": "…", "severity": "critical|high|medium|low" }],
    "next_steps": [{ "title": "…", "priority": "must|should|could|wont" }],
    "futures":    [{ "title": "…", "note": "…" }]   // directional ideas → the Futures tab
  }
}
```

Ingest, in one transaction: upsert the project by slug (first push creates it, assigns a tint and
fills `repo_url` once via COALESCE so a hand-set URL is never overwritten); record the session;
refresh the live resume fields; then land extraction — bugs become open bugs with `link_ref` = the
commit, next-steps become roadmap items, futures become ideas.

**Four invariants. Preserve all four when extending:**

1. **Idempotent on session_id, THEN commit_hash — never the other way round.** A session's identity
   is its session id; the commit is only the fallback for a post that carries none. Matching the
   commit first silently collapsed parallel sessions: several sessions in one checkout all end at
   the same HEAD, so three real pushes became one row. The commit fallback still lets the SessionEnd
   backstop claim the authored `/checkpoint` row (which posts no session_id), but only while that
   row is **unclaimed**. Pinned by `server/test/ingest-identity.test.mjs`.
2. **`authored` is what makes the metadata backstop safe.** The session-row update is COALESCE-safe:
   a metadata post never overwrites an existing authored summary/current_phase, and the jsonb lists
   only overwrite when non-empty. `authored` is sticky (`authored OR $incoming`).
3. **The resume refresh runs only for `authored:true` posts** (and only while `keep_resume_card` is
   on). The metadata hook records the activity row and bumps `last_session_at`, nothing more.
4. **Auto-extraction dedups on fingerprint and honours the `dismissed_items` tombstone table.** An
   existing auto item is re-pointed at the new commit, never duplicated; a dismissed fingerprint is
   skipped; manual items are never touched. `reviewed_at` is never touched by a re-point, so
   approving is sticky across pushes.

## Progress model (`util.computeProgress`)

The single, tweakable definition of "how done is a project". Only Must/Should roadmap items count; a
done Must weighs double a done Should; `progress = doneWeight / totalWeight` as a 0–100 integer;
capped at 90% while any critical/high bug is open; 0% when there are no Must/Should items. Exposed as
`progress` on every project payload. The Dashboard's "Progress by app" panel is this and says so in a
footnote — it is deliberately NOT called a health score.

## Data rules (the non-obvious column semantics)

These are the ones a session gets wrong by guessing. Everything else, read off `schema.sql`.

- **`roadmap_items.bucket` vs `tier`** — bucket (must/should/could/wont) is how NECESSARY the work
  is; `tier` (#227 — S/A/B/C, NULL = unranked) is how much the owner wants it NEXT. Tier is the
  **primary sort of the run queue** (the Plan room and the runner both apply it; bucket and
  `position` tiebreak; unranked sorts last, so an unranked board queues exactly as before). Tier is
  set only from the Tiers view — **agents must never change it.**
- **`risk`** (low/normal/high, #212) is how much DAMAGE a wrong build does — not how hard the work
  is, and not the desire `tier` above. It is the graduated-trust lever: a `low` item whose overnight
  run lands green auto-queues its own merge. **`risk_source` is who decided** (#262): `human` = the
  modal, `auto` = the plan-time pre-pass, NULL = the `normal` nobody ever chose — and NULL is the
  only state an auto write may replace. The guard lives as CASE expressions inside the PATCH's own
  UPDATE rather than a read-then-check, because every right-hand side in a Postgres UPDATE sees the
  OLD row, so two nights writing one item can't race it. **Never write `risk` from SQL directly or
  from any path that bypasses `PATCH /roadmap/:id`; the guard has no other home.** An absent
  `risk_source` on a write means human (the modal sends none); a present-but-unrecognised one means
  auto — the fallback leans to the branch a row can still refuse, because nothing can unclaim a row
  once it reads as human-decided. The board edit modal only sends `risk` when the human actually
  touched the control, or every save would silently reclaim the tier and the pre-pass could never
  re-tier that item again. `scripts/stack-risk-backfill.mjs` tiers the existing board in one pass and
  must run AFTER the schema migration, never before — a pre-migration server has no `risk_source`
  column and would record its writes with no provenance at all.
- **The board order IS the run queue.** `position` is PATCHable and drag-reorderable, and the Plan
  room's Save-order write is the same PATCH the board's drag makes.
- **`claimed_by` is the branch claim** (#277 — called a "lane" until the rename; the `lane/` git ref
  prefix is deliberately unchanged, since it names branches that already exist on origin). It marks
  which parallel session owns an open item, shows as a ⚑ chip and is injected by the SessionStart
  hook as "Branch claims — respect these". Claim before starting; a terminal tab's claim is
  `term:<name>`. The claim is the don't-re-pick marker and stays until a human merges and ticks.
- **Two gates decide who runs, and they answer different questions** (#335). `autopilotWorkers`
  (0 = unlimited, default 3, clamped 1–8) is the FLEET-WIDE cap, checked inside the same claim
  UPDATE as a FIXED, non-tunable per-project serialisation (`NOT EXISTS` a claimed/running job for
  the same project) — a session widening concurrency widens the fleet cap and never the per-project
  one. Per-project cannot become a knob: every job for a project runs against the one checkout at
  `$STACK_AUTOPILOT_ROOT/<slug>`, and two runners fetching, adding worktrees and moving refs in the
  same repo fight over git's ref locks — the project, not the fleet, is the resource that takes one
  at a time. The host lockfile mirrors the split: per-project (`~/.stack/autopilot-<slug>.lock`, not
  the old single global one), named by the same sanitiser in both `scripts/stack-autopilot.mjs` and
  the dispatcher's hung-up (#150) kill path — let the two spellings diverge and the kill path clears
  the wrong file, leaving a live lock blocking that project for hours.
- **Branch names are `<kind>/<id>-<summary>`** (#363 — `feat/271-mission-control`,
  `fix/bug-12-terminal-hangs`, `test/audit-<date>`; kinds: feat · fix · ui · refactor · perf · test ·
  docs · chore). `scripts/lib/lane.mjs` is the canonical namer AND parser, `web/src/lib/branch.ts`
  its client twin, and `scripts/lane.test.mjs` pins both. **The old flat `auto/item-N-<slug>` spelling
  must keep parsing forever** — those branches are on origin and named in live `claimed_by` strings,
  so a reader that only knows the new form reports a working fleet as empty. Two consequences a
  session gets wrong: a legacy lane's kind is `''`, **never `feat`** (the name genuinely does not say,
  and the Merge room shows it unlabelled rather than inventing a label); and any SQL that used to test
  `branch LIKE 'auto/%'` now goes through `laneSql()` in `routes/control.js` — a predicate that still
  only knew `auto/` would blank the last-auto chip and the reviewer's notes, which reads as "nothing
  ran" on a fleet that ran all night.
- **`built_note`** — what actually landed, PATCHed by the completing session. The Review room
  verdicts against it. Always write one.
- **The Review queue is BUILT-or-ticked, not ticked (#374).** Nothing in Stack ticks an item: the
  runner pushes and logs "claim stays until you merge + tick it", the merge job ends with "tick #N
  when you've verified it", and sessions leave items unticked on purpose. So a queue of `done = true`
  showed an empty room every morning over a full night's work. `routes/review.js` queues
  `done = true` **OR** (`built_note` non-empty **AND** `claimed_by` non-empty), and each row carries
  `stage: 'built' | 'ticked'`. **Both halves of the built predicate are load-bearing**: un-ticking
  clears `claimed_by` and keeps `built_note`, so testing `built_note` alone re-queues every change
  the human already rejected, and testing `claimed_by` alone queues items the moment a session claims
  a branch. Consequently `settled` tests the verdict and **nothing about `done`** — approving a change
  before it merges must move it to the archive, not out of both lists. Approving does NOT tick:
  `done` is what `computeProgress` weighs, and the merge job does the tick, but only when a human
  verdict is already stored on the item. **Anything that acts on a change in that room shares the
  predicate** — the Foreman's ops opened with `if (!item.done) 400` until #375, which meant every ✧
  in the room refused on exactly the changes the room was showing. Pinned by
  `server/test/review-queue.test.mjs` and `server/test/foreman.test.mjs`.
- **Three gates decide who runs, and merging any two of them is where they get confused** (#267 +
  #335). `CLAIM_NEXT_SQL` in `routes/autopilot.js` carries all three in one WHERE: the fleet cap
  (`$1`, tunable), the per-project serialisation (fixed, git ref locks) and the area lane (`$2`,
  fixed, merge-time collisions). They answer three different questions and none substitutes for
  another. #267 was built against the PRE-#335 claim and carried its own fleet-wide
  `one job in flight` lock, so taking that branch's side of the merge would have restored the
  serialisation #335 exists to remove — silently, since nothing fails when a night runs serial.
  The lane predicate is `laneBlockSql(placeholder)`, a FUNCTION and not a constant, because the
  claim binds the occupied list at `$2` and the held-jobs query at `$1`. `heldByArea` deliberately
  reports only LANE holds — a job waiting on the cap or the per-project gate is not held by an area,
  and saying so blames the wrong thing. `area-lane-claim.test.mjs` is the only place the composed
  three-gate statement runs against a database; `area-lanes.test.mjs` is pure and knows no SQL.
- **An area lane is `(project, area)`, and untagged is never a lane** (#267). `roadmap_items.area` is
  a plain product tag, but an area with an OPEN claimed item admits no second worker — two branches
  in one area collide at merge time. The rule lives in `server/src/lanes.js` (pure, tested by
  `server/test/area-lanes.test.mjs`) and is MIRRORED in four runtimes that cannot import each other:
  the claim in `routes/autopilot.js` `GET /next`, `pickFor()` in `routes/control.js`, the host
  runner's pick in `scripts/stack-autopilot.mjs`, and `schedulable()`/`heldWhy()` in
  `web/src/screens/ControlRooms.tsx` — change the rule in one and change it in all four. Two
  carve-outs are load-bearing: an untagged (`''`) area never occupies a lane and can never be blocked
  by one (otherwise every untagged item collapses into one giant lane and the night silently does
  nothing), and a lane is keyed on the project too (the same tag in two repos stalls an unrelated
  project's whole night). A worker never blocks itself — the runner exempts claims it made this
  session, and the dispatcher's claim exempts a job pinned to an item already claimed by its own
  lane (that is a resume). A skipped job/item always logs why (`~/.stack/autopilot.log`, via
  `GET /next`'s `heldByArea`) and shows as `waiting on the <area> lane` under OUT OF THE SCHEDULE —
  a lane delay must never be a silence.
- **"Approved for the auto runner" is `source <> 'hook' OR reviewed_at IS NOT NULL`** (#359), and it
  has no column of its own — adding an `approved` flag would be a second, drifting truth for a fact
  `source` + `reviewed_at` already state. A hook-extracted item needs a human's sign-off in the Plan
  room inbox before any unattended path may run it; **a manual item is NEVER held**, because blocking
  hand-written work is the failure mode this must not have. The rule is written out THREE times —
  `server/src/approval.js`, `scripts/lib/approval.mjs`, `web/src/lib/approval.ts` — because none of
  the three packages can import another; change one, change all three. Every other gate reads one of
  them, and `server/test/approval.test.mjs` fails on a fourth hand-rolled copy appearing in an
  execution queue. Two directions to keep straight: an unattended enqueue (the schedule sweep,
  GET /next) **drops a held item silently**, while Run now / `POST /start` **refuses out loud and
  names it** — a silent drop under a button looks like the press did nothing. The runner's
  `--allow-unapproved` is the human-at-a-terminal escape hatch and nothing else may pass it. Do not
  confuse this population with the post-build **verdict** queue in `review.js`: same word, different
  rooms, and different predicates — this one gates what may RUN, that one queues what has already
  been BUILT (#374's `done = true` OR built-and-claimed, never `done = true` alone).
  docs · chore). `scripts/lib/lane.mjs` is the canonical namer AND parser; `web/src/lib/branch.ts` is
  its client twin, kept in step by discipline, not by a shared test — `scripts/lane.test.mjs` pins
  only the host-side `lane.mjs`, and `branch.ts` has no behavioural coverage of its own. **The old
  flat `auto/item-N-<slug>` spelling must keep parsing forever** — those branches are on origin and
  named in live `claimed_by` strings, so a reader that only knows the new form reports a working
  fleet as empty. Two consequences a session gets wrong: a legacy lane's kind is `''`, **never
  `feat`** (the name genuinely does not say, and the Merge room shows it unlabelled rather than
  inventing a label); and any SQL that used to test `branch LIKE 'auto/%'` now goes through
  `laneSql()` in `routes/control.js` — a predicate that still only knew `auto/` would blank the
  last-auto chip and the reviewer's notes, which reads as "nothing ran" on a fleet that ran all
  night. A worktree entry's `itemId` (#365) is parsed host-side by this same `parseBranch`, so the
  server never grows a third copy of the naming rule — and the legacy spelling therefore keeps
  working for trees exactly as it does for branches.
- **A future's SHAPE in the Polaris galaxy is derived, never stored.** There is no `kind`
- **`built_note`** — what actually landed, PATCHed by the completing session alongside `done:true`.
  The Review room verdicts against it. Always write one.
- **`verdict_source` / `verdict_at` / `verdict_evidence` on `roadmap_items` (#263, owner-sanctioned)**
  — the one place a machine may verdict instead of the human, and only on **positive evidence**,
  only while it stays **reversible**, and only while it is **visible**; drop any one of the three and
  it is not sanctioned. Positive evidence means every gate answered yes — low risk, checks actually
  RAN and none failed, a reviewer verdict that found no bugs, a diff confined to the files the item
  declared — and **an absent signal is never a green one**: no checks, no reviewer verdict or no
  declared files each mean the human still verdicts, same rule as a NULL `review_verdict`. The gate
  is one pure function, `scripts/lib/autoverdict.mjs`, tested by `server/test/auto-verdict.test.mjs`
  — never a second spelling of it. Two exclusions are not negotiable: a refine round (the human
  already sent this back once; a machine may not close that loop) and a limit-hit run (it stopped
  mid-thought, so what's on the branch isn't what it meant to build). Reversible because clearing
  `review_tag` resets `verdict_source` to 'human' and wipes `verdict_at`/`verdict_evidence` in the
  same statement — the roadmap PATCH owns that, so ⎌ undo is the ordinary verdict-clearing path and
  needs no second route. Visible because the verdict is never silent: `verdict_evidence` is the
  receipt, shown per row in the Review room's AUTO-VERDICTED strip and stated in the night log and
  the morning digest (`autopilot_runs.auto_verdict`) — a verdict nobody can see isn't reversible in
  practice.
- **A future's SHAPE in the Polaris galaxy (#312) is derived, never stored.** There is no `kind`
  column and there must not be one: `is_star` = ★ its own orbit; parent is a star = ● a planet;
  parent is a planet = ○ a moon; no parent + judged = ◦ one of the north star's three shells
  (`alignment` picks which, on-course innermost); no parent + unjudged = · the drift belt, which is
  also the judge queue. `PATCH /futures/:id` owns the invariants the client reads back —
  **star → planet → moon is the whole depth**, adopting an idea demotes a star (that IS what adopting
  one is), and un-starring returns its planets to the shells in the same statement, because nothing
  loose can hold planets. Never write these columns from SQL directly; the derivation has no other
  guard. `magnitude` (1–5, how much work) is **nullable on purpose** — an unsized idea draws at its
  smallest and the panel says "not sized yet" rather than the sky inventing an estimate nobody gave.
  `area` survives as a plain tag (the list groups by it, ✧ Cluster suggests it) but no longer decides
  where anything sits.
- **A Workbench card is a PLACEMENT, not content.** `workbench_cards` holds where something sits on
  the canvas; a `note` card carries `note_id` and a `polaris` card carries `future_id`, and their
  words are read THROUGH from `notes`/`futures` on the way out and written through on the way in.
  Never copy a note's text onto its card — a second copy is what leaves ⌘K searching a stale one.
  Only an `ai` card owns its `title`/`body`, because nothing else does. Three consequences a session
  gets wrong by guessing: **removing a `polaris` card must NOT delete the idea** (it returns to the
  picker as pickable again; removing a `note` card DOES delete the note, which has no other home);
  **cutting an edge drops the `ai` branch below it** and only ever `ai` cards, which is what makes an
  op undoable without an undo stack; and **a read backfills a card for any note that lacks one**,
  which is how pre-Workbench notes and notes filed elsewhere (the plain `POST .../notes` route,
  outside the canvas) reach the canvas at all. Positions come from the CLIENT — only it knows how
  tall a card rendered.
- **The Workbench's `polaris` payload is the WHOLE funnel, not what's left of it.** Every idea comes
  down carrying `onCanvas`, because the pull picker's All filter shows an idea already on the canvas
  too — greyed, unpickable — and that flag is the only thing stopping the same idea being pulled
  twice. Filtering the pulled ones out server-side is the obvious "tidy-up" that breaks it. Both
  pinned by `server/test/workbench.test.mjs`.
- **The Workbench's second pull source is the autopilot debrief** (`GET|POST
  /workbench/debrief`, extraction in `server/src/debrief.js`), not another Polaris. The structured
  halves — the session's own `next_steps`/`blockers`, the advisor's stored `review_note`/
  `architect_note`/`architect_obs` — are trustworthy and sort first; the parse of the run's free-
  prose `summary` is a salvage pass and lands last as kind `note`. **A pick travels as a fingerprint,
  never as text** — the server re-runs its own extraction and reads the words out of that, so the
  canvas cannot hold a copy that drifted from the record and `debrief` cannot become a source anyone
  can write arbitrary text under. An import lands as a real `note` (source `debrief`) or a real
  `future` (source `debrief`), both keyed on `fingerprint`, which is what makes re-import a no-op; a
  fingerprint in `dismissed_items` is never offered again. The whole list comes down including what
  is already imported — same rule as the `polaris` payload above — and `imported` greying a row is
  the only thing stopping the same insight landing twice. Every skip comes back with its reason and
  is shown; nothing here writes tracker state (no bug, no roadmap item, no tick). It is deliberately
  keyless: no Gemini anywhere in the path, because this reads only what Stack already recorded.
- **The Workbench's ops are the propose half, and nothing else.** Every ✧ op writes a card and stops
  there. `Promote N phases → Roadmap` is the dispose half and it goes through the ordinary roadmap
  POST. Two op hints are deliberately narrower than the design handoff's copy — Gemini cannot read
  the repository, so `Ask` and `Touches` answer from the project RECORD (roadmap, bugs, the files
  recent sessions touched) and say so. Don't "fix" that copy back. **Same correction on the ✎ Refine
  draft**: the design captions it "reads the run log + diff" and it reads neither directly — what it
  gets is the session's own account, the second model's STORED read of the diff, the architect's
  read and the files that branch touched. The dialog prints the list the server actually assembled
  (`read[]`) rather than a fixed caption, so an item with no run behind it says so.
- **The Roles room reads two populations and must never mix their judgement.** `autopilot_runs`
  answers to the executor/advisor policy; `sessions.model_usage` (the human's own interactive work,
  recorded by the SessionEnd hook from the transcript) does not — the policy governs the AUTOPILOT,
  so a model picked by hand in a terminal is **not drift**. They merge only in the `everyModel`
  receipt and `manual`; `models`, `assignments`, `worth` and `runs` stay autopilot-only, which is
  pinned by four "identical with or without sessions" assertions in `fleet-roles.test.mjs`. Two
  consequences: merged shares are **token-based**, because a transcript carries no cost and that is
  the only basis both halves have; and a manual session's spend has **two halves that must stay
  apart** — `model_usage` is the main loop, `agent_usage` is the subagents, and in an interactive
  session those two ARE the director/executor split.
- **A subagent's usage is NOT in the parent transcript — it has its own.** Claude Code writes each
  one to `<transcript-dir>/<session-id>/subagents/agent-*.jsonl` with a sibling `.meta.json` naming
  the `agentType`. The parent records only the Agent call and its result, and `isSidechain` is never
  set there, so a reader that globs `*.jsonl` at the top level concludes — wrongly — that subagent
  spend is unrecoverable. It is routinely the LARGER half: a director handing units to a cheap
  executor bills most of its work in those files. `agents_recorded` is the count that `agent_usage`
  actually prices, so a delegation whose transcript is gone reads as unpriced rather than as free.
  **Neither source is a complete count of delegations**: a `fork` subagent leaves no Agent tool_use
  block in the parent (so the tool_use tally misses it) and a cleaned-up transcript leaves no
  directory (so the directory misses that), which is why `agent_calls` is the MAX of the two.
- **A plan night is the advisor working, not the advisor idle.** Outcome `planned` commits nothing by
  design, so it can never be `landed`: it is counted apart (`planRuns`/`advisedPlanRuns`) and sits
  out the advised-versus-unadvised land rate, while keeping its spend and role attribution in full.
  Folding it back in scores the advisor as having failed to land runs nobody asked it to land.
- **An empty second-model read means NO PASS RAN, not "nothing found".** `review_verdict` /
  `architect_verdict` NULL renders as NO REVIEW, deliberately not as green. Same rule anywhere else
  an agent's opinion is stored.
- **`autopilot_jobs.branch` is a real column; a merge job's branch still round-trips through
  free-text `detail`** (#243) — three places already re-parse that string, and merge's contract was
  deliberately left alone rather than touched to match. The `advise` lane matches on the column
  instead. And its `advice` NULL means **NO PASS RAN**, never "no conflicts" — the same rule as the
  NULL `review_verdict` bullet above.
- **Un-ticking a roadmap item clears `review_tag` and `claimed_by`** (unless the same PATCH sets
  them), so a sent-back item re-enters play fresh. Ticking `done:true` clears `review_tags`,
  `refine_note` and `review_shelved` — each verify round starts unannotated.
- **A refine round is never machine-closed** (#274). A refine session (#274) continues the item's OWN
  branch rather than cutting a fresh one — see `scripts/lib/refine.mjs` — and that round stays open
  until a human ticks it: no auto-merge (#212), and no auto-verdict (#263) once that lands either. The
  human explicitly sent this item back to look at it again, so a machine closing it on a green run
  would discard the very judgement the send-back asked for. `refine_note` surviving until the item is
  ticked `done:true` is what makes "is this an unclosed round" answerable at all — the predicate
  (`isRefineRound`) lives in `scripts/lib/refine.mjs` and is deliberately independent of which kind of
  session built the round.
- **Deleting a `source='hook'` bug, roadmap item or future tombstones its fingerprint** so the next
  push won't re-create it. That is what Dismiss means, and why it has no undo.
- **`DELETE /api/projects/:slug` is SOFT** — it stamps `deleted_at`, clears the share link and keeps
  every row. Deleted projects vanish from all live queries and their collection routes 404. The real
  cascade is `/purge`, valid only on binned projects.
- **`checks.auth`** (#261) attaches the server's OWN `API_TOKEN`, and only when the check's origin is
  the project's `site_url` or a loopback/compose-internal host. The token is never stored on the row
  and never sent to the client; such requests use `redirect: 'manual'` so a redirect can't replay the
  Authorization header off-origin. A check pointed elsewhere fails with a stated reason rather than
  leaking the token or lying about a 401.
- **Editing what a check TESTS clears its stored result AND its `check_results` history** — past
  passes were against a different test. Renaming keeps both.
- **`checks.external`** (#291) is a row Stack never probes itself — its result comes from outside,
  posted by `POST /report`. `POST /run` must skip external rows and 400s a single-id run against one:
  probing one would overwrite the reported result with the status of a request that tested nothing.
  `/report` deliberately writes `check_results` but NOT a `check_runs` row — `check_runs` is the
  SUITE's ledger, what "checks green" is read from and what #212 auto-merge and #263 auto-verdict
  spend against, so one reported result landing there would read as a whole suite of 1/1 passed, a
  green light manufacturable from outside Stack.
- **The `worktrees` table is a REGISTER, not a manager** (#229) — the server is in a container and
  cannot see the host filesystem, so no route under `/api/worktrees` runs git or touches a file; the
  host alone creates, removes and reports. Identity is the PATH (UNIQUE): re-registering an existing
  path is an upsert that also clears `released_at`, because a path back in use is live again whatever
  it was before. Release is a stamp, never a delete, same as a soft-deleted project. `session_name`
  keeps the `stack-term-` prefix (`stack-term-wt-<key>`) because that prefix is what puts a session
  on Mission Control's running-sessions strip and what the host reapers key off — rename it and the
  session goes invisible to both. The trees themselves live at `~/.stack/worktrees/<key>`, deliberately
  inside the $HOME cwd jail the web terminal daemon enforces, so a tree the laptop cut stays reachable
  from the browser terminal; move the root outside $HOME and that breaks silently.
- **`0 = unlimited`** for `autopilotTokens` and `autopilotMaxItems` (#260); positive values are
  clamped. `termIdleHours` `0 = never`.
- **The MERGE AGENT is arithmetic plus a read, and the two must not be confused** (#364). The waves
  are computed in the browser from file paths and are deterministic; `POST /api/merge/review` is the
  optional second half, where Claude reads the REAL diffs on the host and annotates that plan. It
  never reorders and never queues — the human still presses. `verdict: 'ok'` with no notes is a REAL
  answer (it read them and found nothing) and the panel must not render it like "no read has run".
  The host caps the diffs per branch and overall and **states what it cut inside the prompt**, because
  a model that silently saw a tenth of a diff answers confidently about the other nine.
- **THE TAB AGENTS RUN CLAUDE ON THE HOST (#364), not Gemini.** `agentClient().ask()` goes through
  `askClaudeOnHost()` → the terminal daemon's uplink → `claude -p --output-format json`, which is the
  same CLI the autopilot uses and the same dial-out shape as the permission-prompt answer. It is the
  owner's own subscription, so the no-paid-external-AI rule holds. Three consequences a session gets
  wrong by guessing: **the readiness signal is the DAEMON, not a key** (`hostReady` / per-agent
  `ready`; a switched-off agent is reported before an offline host, so nobody is sent to investigate
  the wrong thing); **every tool is disabled on those runs and they execute in a scratch directory**,
  because an agent prompt is assembled from tracker rows and a tracker row is text somebody else
  wrote — this is deliberately NOT the autopilot's `--dangerously-skip-permissions` posture, which is
  safe only because it runs code it wrote itself in a throwaway worktree; and **`ask()` returns
  PARSED JSON** (`parseAgentJson`), because that was askGemini's contract and every ✧ call site
  depends on it — the parser is fence-tolerant since a chat-shaped CLI fences JSON far more often
  than a structured API did. **Gemini is not gone from the app**: the per-push review note, semantic
  check assertions, session labelling, triage and the Workbench ops are still Gemini and still
  key-gated. Only the three tab agents moved.
- **AN AGENT'S BINDING IS CODE, NOT DATA (#361, #375).** `src/agents.js` is the registry: the Auditor
  works the Quality tab, the Curator the Roadmap tab, Polaris the Futures tab, the Foreman Mission
  Control's Review room and the Merge agent its Merge room — `surface: 'tab' | 'room'` says which
  kind, so nothing renders "Merge tab" at a screen that does not exist. Each one's `ops`
  list is CLOSED. `agent_configs` holds only what the owner tunes (enabled, model, guidance,
  `ops_off`) — never which surface or which ops, because those are the restriction itself. A route binds
  once (`const auditor = agentClient('auditor')`) and every model call goes through that client,
  which THROWS on an op belonging to another agent; that throw, not a comment, is what stops the
  Quality route running the board cleanup. Adding a ✧ surface means adding its op to the owning
  agent — an unregistered op cannot run at all. An op MOVES with its surface, and #375 is the
  precedent: `reviewbrief`/`refinedraft` were the Curator's and served from the roadmap routes, but
  the Review room was their only surface, so they moved to the Foreman and to `routes/review.js`
  with it. **One surface, one switch** — a room whose ✧ buttons answer to two agents cannot be
  switched off. (A moved op left in an old `ops_off` row is ignored, since `agentConfigShape`
  filters to the agent's own ops, so it degrades to ON.) **A missing config row means ON**, same
  direction as `readSettings()`: several surfaces already work this way, so an unwritten row must
  degrade to working, not to dead ✧ buttons. Switching an agent off stops it acting everywhere, including the Auditor's
  keyless Claude hand-off — off means off, not "off where it costs money". Pinned by
  `server/test/agents.test.mjs` (pure — `gateDecision` takes the config, so no DB is needed).
- **THE FOREMAN ANNOTATES A VERDICT; IT NEVER GIVES ONE (#375).** The Review room's agent. Its
  `readchange` returns a CALL (approve / look / send-back) and the room draws it in the accent, never
  a verdict tone — the three verdict buttons are the only green in that room, and one keypress agrees
  with whatever is on screen. Three things a session gets wrong by guessing: it is **not called the
  Reviewer**, because the room already labels the per-push Gemini read of the diff REVIEWER and two
  of those makes "what did the reviewer say" unanswerable; every answer carries **`blind[]`** (what it
  could not see) and **`read[]`** (what the server actually assembled), and the blind list is rendered
  hardest under an `approve`, since that is what the approval is being given on top of; and `where[]`
  is the one agent field that becomes **a link the owner clicks** — paths into the running mirror
  site — so `cleanPath()` rejects anything that is not a same-origin path (`//host` is a host, not a
  path) and drops it rather than rendering dead text. `triagequeue` returns an ORDER and no
  judgements; a change it fails to place is appended as unplaced rather than dropped from the only
  list the owner is then working from.
- **A MIRROR SITE ON THE CHANGE UNDER REVIEW IS THE POINT OF THE ROOM (#375).** Previews (#208) are
  reachable from the Review room's built changes, and the Foreman's `where[]` turns the URL into
  links at the screens that moved. The previews come in as PROPS from `Control.tsx`, which already
  polls them for the Now and Merge rooms — a second poller would show two answers for one row. Built
  changes only: a ticked one is on main, where the thing to look at is the app itself.
- **`projects.merge_autonomy` is not `automode`** (#363 — auto | plan | off, default plan). `automode`
  says whether a project is BUILT unattended; this says how much of its MERGING one press of the Merge
  room's ▶ Run covers. `plan` still names its branches in the proposed plan (an ordering that hid them
  would not be an honest ordering) but the press leaves them alone. None of the three relaxes the
  conflict probe, the #212 risk gate or the merge confirm.
- **A branch's merge state is FOUR-valued, and `unprobed` is not `clean`** (#363, `web/src/lib/branch.ts`).
  `mergeClean` null means no probe RAN — an older report, git before 2.38, or a claim with no branch
  behind it — so it gets its own state and stays out of the agent's plan. Same rule as a NULL
  `review_verdict`. `behind` is the opposite case: the probe passed, so the merge succeeds; what is
  missing is that nothing has built the branch against the main it would land on. That is worth
  showing and is not worth refusing, so `behind` counts as mergeable.
- **The branch report's `topFiles` is capped and `files` is the true total** (#363). The expanded row
  prints the difference — the #239 rule, and the cap is on size, not on path order, so the biggest
  files are the ones kept.
- **An autopilot `stack-auto-*` session is now READABLE from the browser and still not mirrorable,
  killable or typeable-into** (#366). `listAutoSessions()` is a SIBLING of `listStackSessions()`, and
  the web terminal's mirror/kill/reap paths still read the `stack-term-*` list only — widening
  `listStackSessions` to cover both is the obvious tidy-up, and it hands the browser a kill button
  for a session running with `--dangerously-skip-permissions`. `POST /api/terminal/auto-view` and the
  daemon's `autoView` handler call `capture-pane` and nothing else; `POST /api/terminal/answer` stays
  the only path by which anything but a human types into a running session (see **Answering a
  permission prompt from the browser**). `termAutoSessions().at === 0` means the host has never
  reported, NOT that the fleet is idle, and a slot's `activity` is `null` for the same reason — same
  Fail SILENT rule as a NULL `review_verdict` (see **Fail-safe direction**). Banked spend on a live
  slot is per FINISHED unit, so a running session honestly shows zero and that is not a stall — the
  Watch panel says so rather than rendering an empty list.
- **A worktree report's NULL is not `[]`** (#365) — the same NULL-verdict rule this file already
  states for `review_verdict` and `mergeClean`. No report ran ≠ nothing to report: a reader that
  defaults it to `[]` reports every feature as tree-less, i.e. reports uncommitted work as absent.
  The client type carries `Worktree[] | null` for exactly that reason and `getControl` must never
  default it to `[]`.
- **A feature's STAGE (#365, `web/src/lib/feature.ts`) is derived, never stored**, and two guesses
  cost the first cut its correctness — exactly the guesses a session makes here. A tree at zero
  commits has not landed, it has not started: only a branch that EXISTS on origin can be `landed`,
  and a tree holding commits origin has not seen outranks a merged branch, so reading `ahead === 0`
  on either side as landed marks every freshly created worktree as finished. And absence from
  `claims[]` is NOT evidence an item is done — that list holds items with a non-empty `claimed_by`,
  so an item drops out when the claim is RELEASED too, which `scripts/stack-autopilot.mjs` does
  routinely on runs that committed real work; inferring done-ness from it hides a released-but-open
  item with commits waiting behind a green "landed". Git is the only evidence. Flags are independent
  of stage: a feature can be `pushed` and still hold uncommitted files, and collapsing that into one
  "uncommitted" stage misreports both halves.

## Fail-safe direction (get this right or you delete work)

Every host-side automation reads the API and must decide what an unreachable API means. **The
direction is not uniform, and it is not a bug that it isn't:**

- **Fail SAFE = do nothing** where the action destroys or spends: the terminal idle reaper (#287),
  the skills sync (#228 — it deletes files), the dispatcher, the autopilot arm switch (unreachable =
  no run), `stack worktrees --prune` (#229 — with tmux unreachable it reaps nothing, the same trap
  the idle reaper guards against). An unknown threshold reaps NOTHING.
- **Fail OPEN = keep recording** where the action only records: `readSettings()` and both hooks
  default to "on", so a flaky API degrades to recording rather than to silent-off.

- **Fail SILENT = report nothing** where the reader would otherwise mistake absence for good news.
  `attention[]` and `conflicts[]` are empty with no host daemon on the line, so the Now room reads
  `terminal.connected` and says "Stack cannot see whether a session is stopped" rather than
  "nothing is waiting on you". Same rule as a NULL `review_verdict`: no pass ran ≠ nothing found.
- **Fail LOUD = exit 1 with a reason** where the reader would otherwise mistake "could not look" for
  "looked and found nothing". `scripts/playwright/smoke.mjs` (#291) exits 0 only on a clean pass; an
  unreachable app or a browser that will not launch is the NULL-`review_verdict` lie again if it
  reports zero findings instead of failing.

Related, and just as absolute: **Stack only ever writes or removes skills IT PLANTED.** Each managed
directory carries a `.stack-managed` marker; a skill without one is REPORTED and never touched.
Removal is driven by the server's KEEP list, never by a diff against the last report. And **a preview
never writes to the real database** — its own is a copy, and that isolation is one-directional and
absolute. And `scripts/lib/worktree.mjs` (#229) fails safe in both directions on a worktree:
`removeWorktree` only ever deletes a path git itself vouches for as a worktree of that repo, and
refuses a dirty tree unless forced, since the uncommitted work in it may be the only copy;
`addWorktree` never force-removes a path that is already a worktree, because a live parallel session
may be sitting in it (autopilot's own `remove --force` is safe only because its path is keyed by its
own item id — a shared interactive root has no such guarantee). `orphanWorktrees` only reports;
nothing in the module removes a tree the caller didn't name.

## Answering a permission prompt from the browser

`POST /api/terminal/answer` is the ONLY path by which anything but a human at the keyboard types
into a running session, and every rule on it exists because of one hazard: **the row the human
clicked was drawn from a pane read up to twenty seconds ago.** In twenty seconds a session can be
answered at the keyboard and be sitting on a text input where the menu was, and "1" is then a stray
digit in someone's message.

- **The HOST decides, the server only relays.** The check cannot move server-side: only the host can
  see the pane, and a check against the relay's own cache would be a check against the very
  staleness it exists to catch. The daemon re-reads the pane and refuses unless the prompt it finds
  still matches.
- **The fingerprint covers the BODY, not just the question.** "Do you want to proceed?" is the
  question for every bash command there has ever been — a question-only hash would let a yes aimed
  at `rm -rf build` land on whatever replaced it.
- **Approve sends the plain Yes, never "and don't ask again".** Widening a permission for the rest
  of a session is a decision for the keyboard, where the human can see what they are widening.
  Deny sends Escape, the one keystroke that cannot mean anything else if the pane moved.
- **The refusal is shown, verbatim and beside the row.** "Already answered", "the session moved on"
  are the NORMAL outcomes; swallowing them leaves a button that silently does nothing.
- Autopilot sessions never appear here **by construction** — the runner passes
  `--dangerously-skip-permissions`, so it cannot be blocked this way. Only `stack-term-*` can.

`terminal/prompt-scan.mjs` is pure and leans hard towards null (it wants a numbered menu with both a
yes and a no, a question above it, nothing but key hints below): a false block puts an Approve
button in front of a question nobody asked, which is far worse than a real block noticed a minute
late. `terminal/edit-watch.mjs` reads who is editing what off the **transcripts, not git** — two
sessions in one checkout share a dirty tree, so git cannot say who wrote what and a transcript can.

## Hooks and the host

- **Both hooks must always exit 0** and log only to stderr — never block Claude Code start or stop.
  (`stack-checkpoint.mjs` is a poster, not a hook, so it may exit non-zero; it still never prints the
  token.) Shared logic lives in `hook/stack-post.mjs`.
- **The SessionStart hook is registered WITHOUT `async`** (SessionEnd stays `async`): its
  `additionalContext` has to be captured synchronously to land in the session. It guards the API call
  with a short timeout and emits nothing on any miss.
- **`~/.stack/` holds COPIES, not symlinks.** Editing `hook/*.mjs` changes nothing until they are
  copied over — the installed pair was stale for weeks. `diff hook/<f> ~/.stack/<f>` when a hook fix
  seems inert.
- **The SessionEnd hook posts the commit THIS session made**, read from its own `git commit` results
  in the transcript, falling back to `git rev-parse HEAD` only when it committed nothing. HEAD is
  wrong whenever sessions run in parallel in one checkout.
- The host dials OUT for everything (terminal daemon, dispatcher, branch report, skills sync, the
  merge advisor): the server runs in a container and the host firewall drops container→host traffic.
  Anything needing host state is a poll-and-report, never a push from the server.
- Host-side logs live in `~/.stack/` (`term.log`, `autopilot.log`, `preview.log`, …); the dispatcher
  is a crontab line and removing it disables all runs.
- **An alternative-provider key resolves `process.env` → `~/.stack/env` → `~/.ccm_config`** (the ccm
  tool's file, key=value OR JSON) — `templates/stack-env.example` is the template for the former. The
  resolution lives in `terminal/model-switch.mjs` and every reader must go through it rather than
  reading `process.env` directly, since a standalone script has not loaded `~/.stack/env`. No surface
  ever prints any part of a key — `./stack models` reports the SOURCE and a character count, and that
  is the whole allowance.

## The /checkpoint command + poster

Rich resume content is **Claude-authored, free, no external API**. `.claude/commands/checkpoint.md`
tells the session to read settings via `stack-checkpoint.mjs --settings` (honour `checkpointDetail` +
`includeChores`), derive the slug from the git remote, compose the full schema and pipe it to
`~/.stack/stack-checkpoint.mjs`, which sets `authored:true`, fills commit/branch from git, reads the
token from `~/.stack/env` (never printed) and POSTs to `/api/ingest`. The SessionEnd hook is the
silent metadata backstop so the feed never has gaps. **Don't replace /checkpoint with an API
summariser.**

## Settings that change behaviour

`GET|PATCH /api/settings` is a single row in client camelCase; PATCH takes any subset. Full list in
`routes/settings.js`. The ones whose meaning isn't obvious from the name:

| key | meaning |
| --- | --- |
| `autoRecord` | does the SessionEnd hook post its metadata backstop |
| `keepResumeCard` | off → ingest skips the resume refresh and the deck/Overview drop the card |
| `sessionDefaults` | catalogue keys (lean/ship/checkpoint/confirm/verify) rendered server-side to lines and injected by SessionStart into EVERY project. `ship` = commits pre-authorised, granted once and never re-asked |
| `autopilotEnabled` | the ARM SWITCH. Nightly + scheduled jobs only enqueue while on; ▶ Run now stays manual-only |
| `autopilotPlanSweep` | standing sweep — GET /next stands a `plan` job up for any automode project with unplanned must/should work, same gates as the nightly |
| `autopilotWorkers` | the FLEET-WIDE cap on concurrent autopilot jobs (0 = unlimited, default 3, clamped 1–8); per-project serialisation is separate and NOT tunable |
| `autopilotExecutorModel` / `autopilotAdvisorModel` | #153, **inverted by #285**: the ADVISOR runs the session (holds the main loop, plans, delegates, verifies, commits) and the EXECUTOR is exposed to it as a subagent with the write tools. Advisor unset = single-model on the executor |
| `assistFields` / `assistGuidance` | what ✧ Fill-from-note may fill, and the owner's standing steer. Assist never overrides a value the human set, and **tier S is offered, never assigned** |
| `termIdleHours` | the idle-session reaper's threshold (0 = never); the host does the killing and fails SAFE |
| `accessPinSet` | PIN sign-in available; PATCH takes write-only `accessPin` ('' disables). Any change signs out every PIN-connected device |
| `workbenchModel` | which Gemini model the Workbench's ✧ ops run against ('' = the server's own GEMINI_MODEL). App-wide, not per-project — the SERVER makes the call, same reasoning as `termIdleHours` rather than the device-local auto-refresh |

## Routes

All behind bearer auth except `GET /api/health`, `POST /api/auth/login` and
`GET /api/public/:slug/:token`. One file per surface in `server/src/routes/` — the file is the
reference. The index:

- **Read layers** — `overview.js` (the dashboard deck), `control.js` (Mission Control, incl. the pure
  exported `computeFleetRoles()`), `review.js` (the cross-project Review room AND the Foreman's four
  ops — #375; two of them arrived from `roadmap.js` with the agent), `search.js` (⌘K),
  `timeline.js`, `public.js`. All computed in a handful of aggregate queries — **never one query per
  project**; keep it that way.
- **Per-project collections** — `bugs.js`, `roadmap.js`, `notes.js`, `futures.js`, `checks.js`,
  `audit.js`, `workbench.js` (the canvas over notes+futures, and the seven ✧ ops), mounted under
  `/api/projects/:slug/…` with `mergeParams`.
- **Automation** — `autopilot.js` (the schedule, the job queue and the host dispatcher's
  `GET /next`), `previews.js`, `branches.js`, `skills.js`, `terminal.js`.
- **Plumbing** — `ingest.js`, `settings.js`, `merge.js` (#364 — the Merge agent's read of a proposed
  plan; the only agent op that needs the CODE, so the diffs are gathered host-side), `agents.js` (#361 — the tab agents' config; the
  REGISTRY itself is `src/agents.js`, not a route), `projects.js`, `presence.js`, `auth.js`, `devices.js`,
- **Automation** — `autopilot.js` (the schedule, the job queue, the advise lane and its
  `GET /jobs/:id/advice` read, and the host dispatcher's `GET /next`), `previews.js`, `branches.js`,
  `skills.js`, `terminal.js`.
- **Plumbing** — `ingest.js`, `settings.js`, `projects.js`, `presence.js`, `auth.js`, `devices.js`,
  `tips.js` (app-wide, no slug).

`GET /api/projects/:slug` is the combined detail payload the SessionStart hook reads back.

## Conventions

- **en-AU spelling** everywhere.
- **No secrets in the repo.** `.env` (server) and `~/.stack/env` (hooks) are gitignored and load at
  runtime. The hooks never read tokens from the shell profile or settings.json, and never print them.
- Frontend is **strict TS** with `noUnusedLocals`/`noUnusedParameters` on — keep it clean.
- All persistence and network stays behind `store.ts`.
- **No PAID external AI APIs.** (Owner's decision 2026-07-16.) Gemini on the free tier is sanctioned
  everywhere — routes, ingest, hooks, cron, the autopilot. Two principles survive the loosening:
  • **Gemini annotates, the human disposes.** Its output lands as suggestions (review-inbox items,
    alignment verdicts to accept, the per-push `gemini_note`) — it never mutates tracker state
    itself: no auto-closing bugs, ticking items or merging branches. (#263 carves out one sanctioned
    exception: machine verdicts on low-risk, all-green runs — and #274 carves out its own exception
    to THAT: a refine round is excluded even when the run is green, because it is by definition work
    a human already sent back and only that human's verdict closes it.)
    itself: no auto-closing bugs, ticking items or merging branches — except the one sanctioned
    exception, `verdict_source` on `roadmap_items` under **Data rules** below (#263).
  • **Absent key = silent degrade.** Every Gemini surface no-ops or 503s cleanly without
    `GEMINI_API_KEY`; nothing blocks, nothing errors user-visibly. The client renders those surfaces
    ABSENT rather than disabled, keyed off the detail payload's `geminiReady`.
  • **An empty answer is a valid answer, and the prompt has to invite one.** The ✎ Refine draft
    (`refinedraft`) returns `draft: ""` when the record does not evidence a change, and the dialog
    says so — because a model told to produce a delta will otherwise produce one, and what comes
    back is "verify it works" dressed as a finding. Tested both ways before it shipped: with a
    reviewer finding it names the finding; with a bare run it returns nothing. Any prompt asked for
    a judgement needs the same escape hatch, or it manufactures the judgement.
- **Checks are Stack's only automated regression net.** When a route's payload contract changes,
  change its check in the same commit. A green suite is the evidence that risk-tiered auto-merge
  (#212) and auto-verdict (#263) spend.
- `templates/stack-agent-context.md` is the single source of truth for the portable agent manual — if
  the API or hook contract changes, update it (`scripts/stack-context.mjs` exports it verbatim).
- **A strict build is necessary and no longer sufficient for UI work.** Run
  `scripts/run-ui-smoke.sh` (or `./stack ui-smoke`) before calling a UI change done — two real layout
  bugs reached the owner because a session had no way to see its own rendering (#291), and now it does.
- **A recurring re-fetch goes through `lib/autoRefresh.ts` (#312), never a bare `setInterval`.** One
  device-local setting (Settings → Auto refresh; 0 = off) governs every screen that watches the host —
  the terminal's sessions, previews, Mission Control, the skill tree — and the hook is also what stops
  a hidden tab polling and what refreshes it on return. Device-local because the BROWSER does the
  polling, so a phone and the desktop may answer differently; contrast `termIdleHours`, which is
  app-wide because the HOST does that killing.

## Gotchas

- `server` retries the first Postgres connection — don't "fix" that; it's what survives compose order.
- **A capped list inside a prompt must say it is capped, and must be capped on the right axis**
  (#239, `routes/audit.js`). The auditor reads KNOWN_BUGS as "what is already tracked" and reasons
  from ABSENCE, so a silent slice makes it re-report tracked bugs and tells it nothing is known where
  plenty is. Order by severity (a cap on `created_at DESC` drops the long-standing criticals), and
  state the true total beside the shown count. **Same rule for any list you put in a prompt.**
- In `landFindings`, a finding matching a **fixed** bug is a REGRESSION — it reopens that bug and
  reports `reopened`. Swallowing it as "already tracked" is how a bug that came back goes unmentioned.
- Status vocabulary is `live | building | paused | archived`. The old `active` migrates to `live`.
- The web Dockerfile is multi-stage (Vite build → nginx). nginx does SPA fallback **and** proxies
  `/api` to `server:4000` on the compose network; nginx also proxies `/term*` with upgrade headers.
  In local `npm run dev`, Vite proxies `/api` to `localhost:4000` instead.
- Both closure counts in `totals` lean on `updated_at`, the only stamp either table carries — an edit
  to an already-done item counts too. Read them as MOVEMENT, not an exact ledger.
- `set-option`'s `-t` in tmux 3.x is a target-PANE, so session user options need the `=name:` target
  form (`tmux-session.mjs`); a bare `=name` fails on a session that plainly exists.
- **`autopilot.js`'s `JOB_SELECT` is shared with `control.js` and must stay that way** (#243) —
  `control.js` used to run its own `SELECT j.*`, which would ship the kilobyte `advice` text on every
  Mission Control poll AND leave `adviceReady` false forever, silently disabling the feature. The same
  drift-by-copy risk `shape.js`'s run-ledger shapes exist to guard against.
- `stack-autopilot.mjs` still inlines its own copies of `git worktree add/remove` rather than calling
  `scripts/lib/worktree.mjs` (#229) — deliberately NOT refactored onto the shared module yet. The
  nightly is how this repo builds itself, so a subtle break there is expensive; pointing autopilot at
  the module is a real behaviour change, not a no-op tidy-up, and belongs in its own item.
- `scripts/feature.test.mjs` (#365) is the first test in the repo to run `web/src` TypeScript
  directly under Node's type-stripping loader, with a small `module.registerHooks` shim to resolve
  the extensionless sibling import. A session adding client-side test coverage should follow that
  pattern rather than reinventing one.

## Quick commands

```bash
cd web && npm install && npm run dev     # frontend on :5173 (needs the server running)
cd web && npm run build                  # strict typecheck + production bundle
docker compose up -d --build             # full stack
docker compose exec server npm run seed  # optional demo projects (off by default)

node hook/stack-session-end.mjs --demo     # fire the metadata backstop (no external API)
node hook/stack-session-start.mjs --demo   # print the "where you left off" block for this repo
node hook/stack-checkpoint.mjs --settings  # print current settings (what /checkpoint reads)
cp hook/*.mjs ~/.stack/                    # install the hooks — ~/.stack holds COPIES

node server/test/ingest-identity.test.mjs  # one activity row per SESSION (needs a throwaway server)
node server/test/run-shape.test.mjs        # the run ledger's shared shapes match the old copies
node server/test/fleet-roles.test.mjs      # role attribution + drift detection (pure, no DB)
node server/test/area-lanes.test.mjs       # an area lane admits one worker (pure, no DB)
node server/test/workbench.test.mjs        # the canvas is a placement layer (needs API + DATABASE_URL)
node server/test/plan-night.test.mjs       # a booked plan night carries no item id (needs API + DATABASE_URL)
node server/test/review-queue.test.mjs     # a change is in Review once BUILT (needs API + DATABASE_URL)
node server/test/foreman.test.mjs          # the Review room's agent + its ops' gate (needs API + DATABASE_URL)
node server/test/timeline-window.test.mjs  # days clamp, Extend widens the window, the 30-day default (needs API + DATABASE_URL)
node server/test/debrief-extract.test.mjs  # the debrief's insight extraction (pure, no DB)
node server/test/prompt-scan.test.mjs      # a blocked permission prompt is read (pure, no tmux)
node server/test/auto-scan.test.mjs        # an autopilot pane's activity is read (pure, no tmux)
node server/test/attention.test.mjs        # what is waiting on you + same-file clashes (pure, no DB)
node server/test/agents.test.mjs           # each tab agent is bound to its own tab (pure, no DB)
node server/test/model-switch.test.mjs     # provider key resolution from both key files (pure)
DATABASE_URL=… node server/test/autopilot-next.test.mjs   # the fleet cap + the per-project gate (#335)
DATABASE_URL=… node server/test/area-lane-claim.test.mjs  # the area lane as the CLAIM enforces it (#267)
node web/test/sky-view.test.mts            # the sky's one "fit all" (pure, no DOM)
node server/test/agent-sandbox.test.mjs    # a tab agent runs with every tool off, in a scratch dir (pure)
node scripts/lane.test.mjs                 # branch naming + BOTH spellings parse (pure, no git)
node scripts/risk.test.mjs                 # the shared risk-tier helpers: normalise, label (pure)
node server/test/worktree.test.mjs         # add/remove guards (real git in a throwaway repo, no DB)
node --experimental-strip-types scripts/feature.test.mjs   # feature stages across branch + worktree (pure, no DB)
node server/test/cap-note.test.mjs         # a capped note says it was capped (pure, no DB)
node scripts/context-budget.test.mjs       # THIS file and the agent manual are within budget
node scripts/roadmap-refs.mjs              # every #id cited in the repo, against the real board

./stack tree                               # the branch navigator (--repo <path>, --json)
./stack models                             # which alt providers have a key (--json, --check)
./stack seed-checks --dry                  # what the regression suite would change (--run fires it)
./stack seed-galaxy                        # shape a flat idea funnel into stars/planets (DRY until --run)
./stack risk-backfill [slug]               # what a plan-time risk tiering would write (dry by default, --run to apply)
./stack skills --dry                       # what the skill-tree sync would write/remove on this host
./stack start-session [slug] [--item N]    # queue an automation session (▶ Run now from the terminal)
./stack list-sessions                      # the automation job queue ([slug], --limit, --json)
./stack term [dir]                         # claude in a stack-term tmux session (--shell, --safe)
./stack worktrees --prune                  # reap CLEAN, fully-pushed orphan worktrees (--run, --json)

scripts/run-ui-smoke.sh                    # headless browser pass over the UI (#291; --url, --screens, --report)
scripts/run-ui-smoke.sh --screens dashboard --viewport desktop   # one screen, quickly
./stack ui-smoke --json                    # the same, as JSON

node scripts/stack-autopilot.mjs --project stack --repo /home/bailey/stack --dry  # tonight's pick?
node scripts/stack-autopilot-dispatch.mjs  # one dispatcher poll by hand (normally the cron line)
node scripts/stack-preview.mjs --start <id>  # bring a branch up as a preview (normally spawned)
node hook/stack-gemini-review.mjs --dry    # second-model review of the last commit
node hook/stack-gemini-review.mjs --architect --range main..HEAD  # the structural read (#284)
node terminal/stack-term.mjs               # the web-terminal daemon (normally the @reboot cron line)
crontab -l                                 # the dispatcher line — remove it to disable all runs
tail -f ~/.stack/{term,autopilot,preview}.log
```
