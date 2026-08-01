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
scripts/   The host-side CLI + automation (autopilot, dispatcher, previews, skills, tree, checks).
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
  modal state), Settings, Control (Mission Control — five rooms behind a live strip and a persistent
  right rail; `Control.tsx` is the shell and each room has its own file: `ControlNow` /
  `ControlRooms` (Nights, Plan) / `ControlReview` / `ControlRoles`, with the merged session
  list in `ControlLanes`). A sixth, BUILD, was removed with its tab: its two gates belong to other
  rooms now — the verdict is Review's whole subject, the merge is the Now room's branch strip — and
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
- **The board order IS the run queue.** `position` is PATCHable and drag-reorderable, and the Plan
  room's Save-order write is the same PATCH the board's drag makes.
- **`claimed_by` is the branch claim** (#277 — called a "lane" until the rename; the `lane/` git ref
  prefix is deliberately unchanged, since it names branches that already exist on origin). It marks
  which parallel session owns an open item, shows as a ⚑ chip and is injected by the SessionStart
  hook as "Branch claims — respect these". Claim before starting; a terminal tab's claim is
  `term:<name>`. The claim is the don't-re-pick marker and stays until a human merges and ticks.
- **`built_note`** — what actually landed, PATCHed by the completing session alongside `done:true`.
  The Review room verdicts against it. Always write one.
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
  which is how pre-Workbench notes and notes filed elsewhere (the ✧ re-entry plan) reach the canvas
  at all. Positions come from the CLIENT — only it knows how tall a card rendered.
- **The Workbench's `polaris` payload is the WHOLE funnel, not what's left of it.** Every idea comes
  down carrying `onCanvas`, because the pull picker's All filter shows an idea already on the canvas
  too — greyed, unpickable — and that flag is the only thing stopping the same idea being pulled
  twice. Filtering the pulled ones out server-side is the obvious "tidy-up" that breaks it. Both
  pinned by `server/test/workbench.test.mjs`.
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
- **Un-ticking a roadmap item clears `review_tag` and `claimed_by`** (unless the same PATCH sets
  them), so a sent-back item re-enters play fresh. Ticking `done:true` clears `review_tags`,
  `refine_note` and `review_shelved` — each verify round starts unannotated.
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
- **`0 = unlimited`** for `autopilotTokens` and `autopilotMaxItems` (#260); positive values are
  clamped. `termIdleHours` `0 = never`.

## Fail-safe direction (get this right or you delete work)

Every host-side automation reads the API and must decide what an unreachable API means. **The
direction is not uniform, and it is not a bug that it isn't:**

- **Fail SAFE = do nothing** where the action destroys or spends: the terminal idle reaper (#287),
  the skills sync (#228 — it deletes files), the dispatcher, the autopilot arm switch (unreachable =
  no run). An unknown threshold reaps NOTHING.
- **Fail OPEN = keep recording** where the action only records: `readSettings()` and both hooks
  default to "on", so a flaky API degrades to recording rather than to silent-off.

- **Fail SILENT = report nothing** where the reader would otherwise mistake absence for good news.
  `attention[]` and `conflicts[]` are empty with no host daemon on the line, so the Now room reads
  `terminal.connected` and says "Stack cannot see whether a session is stopped" rather than
  "nothing is waiting on you". Same rule as a NULL `review_verdict`: no pass ran ≠ nothing found.

Related, and just as absolute: **Stack only ever writes or removes skills IT PLANTED.** Each managed
directory carries a `.stack-managed` marker; a skill without one is REPORTED and never touched.
Removal is driven by the server's KEEP list, never by a diff against the last report. And **a preview
never writes to the real database** — its own is a copy, and that isolation is one-directional and
absolute.

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
- The host dials OUT for everything (terminal daemon, dispatcher, branch report, skills sync): the
  server runs in a container and the host firewall drops container→host traffic. Anything needing
  host state is a poll-and-report, never a push from the server.
- Host-side logs live in `~/.stack/` (`term.log`, `autopilot.log`, `preview.log`, …); the dispatcher
  is a crontab line and removing it disables all runs.

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
  exported `computeFleetRoles()`), `review.js` (the cross-project Review room), `search.js` (⌘K),
  `timeline.js`, `public.js`. All computed in a handful of aggregate queries — **never one query per
  project**; keep it that way.
- **Per-project collections** — `bugs.js`, `roadmap.js`, `notes.js`, `futures.js`, `checks.js`,
  `audit.js`, `workbench.js` (the canvas over notes+futures, and the seven ✧ ops), mounted under
  `/api/projects/:slug/…` with `mergeParams`.
- **Automation** — `autopilot.js` (the schedule, the job queue and the host dispatcher's
  `GET /next`), `previews.js`, `branches.js`, `skills.js`, `terminal.js`.
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
    exception: machine verdicts on low-risk, all-green runs.)
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
- **UI work ships on a strict build plus reasoning, never on a look** — a session cannot see its own
  rendering. Two real layout bugs reached the owner that way (#291).
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
node server/test/workbench.test.mjs        # the canvas is a placement layer (needs API + DATABASE_URL)
node server/test/prompt-scan.test.mjs      # a blocked permission prompt is read (pure, no tmux)
node server/test/attention.test.mjs        # what is waiting on you + same-file clashes (pure, no DB)

./stack tree                               # the branch navigator (--repo <path>, --json)
./stack seed-checks --dry                  # what the regression suite would change (--run fires it)
./stack seed-galaxy                        # shape a flat idea funnel into stars/planets (DRY until --run)
./stack skills --dry                       # what the skill-tree sync would write/remove on this host
./stack start-session [slug] [--item N]    # queue an automation session (▶ Run now from the terminal)
./stack list-sessions                      # the automation job queue ([slug], --limit, --json)
./stack term [dir]                         # claude in a stack-term tmux session (--shell, --safe)

node scripts/stack-autopilot.mjs --project stack --repo /home/bailey/stack --dry  # tonight's pick?
node scripts/stack-autopilot-dispatch.mjs  # one dispatcher poll by hand (normally the cron line)
node scripts/stack-preview.mjs --start <id>  # bring a branch up as a preview (normally spawned)
node hook/stack-gemini-review.mjs --dry    # second-model review of the last commit
node hook/stack-gemini-review.mjs --architect --range main..HEAD  # the structural read (#284)
node terminal/stack-term.mjs               # the web-terminal daemon (normally the @reboot cron line)
crontab -l                                 # the dispatcher line — remove it to disable all runs
tail -f ~/.stack/{term,autopilot,preview}.log
```
