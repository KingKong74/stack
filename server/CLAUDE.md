# server/ — API and database

The root `CLAUDE.md` holds the cross-package rules (mirrored predicates, run gates, fail-safe
directions). This file holds what applies only here. These file headers carry their own rules; read
one before editing its file: `routes/ingest.js` (the most invariants: read it first),
`routes/checks.js`, `routes/worktrees.js`, `routes/terminal.js`, `routes/autopilot.js`,
`routes/sprints.js`, `routes/context.js`, `prompts.js`, `agent-profiles.js`, `pulse.js`, `lanes.js`.

## Structure

- `schema.sql` is idempotent: `ADD COLUMN IF NOT EXISTS` plus convergent data migrations. Read it for
  the column list.
- `util.js` holds `computeProgress` and three single-knob constants every surface reads:
  `STALE_DAYS`, `PRESENCE_TTL_MINUTES` (the crashed-session backstop) and `CHECK_HISTORY_KEEP`.
- `shape.js` holds the shared run-ledger shapes. BIGINT and NUMERIC arrive as strings.
- `settings.js`: `readSettings()` defaults to "on" when the row is missing (fail open).
- One file per surface in `routes/`. Per-project collections mount under `/api/projects/:slug/…`
  with `mergeParams`. `GET /api/projects/:slug` is the combined payload the SessionStart hook reads.
- Everything is behind bearer auth except `GET /api/health`, `POST /api/auth/login` and
  `GET /api/public/:slug/:token`.
- The first Postgres connection retries to survive compose start order. Don't "fix" that.

## Ingest

The package is `{ project, session, extract }`. An extracted row is `source='hook'`, which means
**held**: out of the runner until a human signs it off, and shown in Auto-ideas. The usage fields
(`tokens_used`, `model_usage`, `agent_calls`, `agent_types`) are written only by the hook, because
only the hook reads the transcript.

## Progress (`util.computeProgress`)

All five buckets count. Progress is capped at 90% while any critical/high bug is open, and reads 0%
only on an empty board. It is deliberately **not** a health score.

## Roadmap row semantics

- **`bucket`** is the priority: highest/high/medium/low/lowest (`util.js` BUCKETS). It orders run
  candidates below the sprint rank and excludes none.
- **`risk`** (low/normal/high) is how much damage a wrong build does: not difficulty, not desire.
  `risk_source`: `human` = hand-set, `auto` = the plan-time pre-pass, NULL = nobody chose. Only NULL
  may be replaced by an auto write, enforced by CASE expressions inside `PATCH /roadmap/:id`'s own
  UPDATE.
- **`built_note`** is what actually landed, PATCHed by the completing session; a verdict is given
  against it. Always write one.
- **Un-ticking** clears `review_tag` and `claimed_by` (unless the same PATCH sets them), so a
  sent-back item re-enters fresh. **Ticking** clears `review_tags`, `refine_note` and
  `review_shelved`, so each verify round starts unannotated.
- **A verdict** is `verdict_source` / `verdict_at` / `verdict_evidence`.
- **`refine_note` surviving to the tick** is what answers "is this refine round still open".
- **`claimed_by`** is the branch claim. A terminal tab's is `term:<name>`.

## Sprints

`sprints` has status `planned | active | done`, with at most one `active` per project enforced by a
partial unique index. `sprint_rank` is dense, 0 = top, and rewritten whole on every drop
(`PUT /sprints/:id/order`). `sprint_id` NULL is the backlog. Deleting a sprint releases its items
(ON DELETE SET NULL). Finishing one leaves its unfinished rows in it, because a done sprint is the
record of what was committed to. `starts_on`/`ends_on` are the planned window and gate nothing;
`started_at`/`ended_at` are when it actually ran.

The ✧ Planner (`POST /sprints/:id/plan`) exists for the area lane, not the ranking: a sprint of one
area stalls after the first build. Lane holders are read off every open row, held ones included.

## Autopilot and spend

- **`JOB_SELECT` names its columns on purpose.** `SELECT j.*` would ship the kilobyte `advice` text
  on every poll and leave `adviceReady` false forever.
- `autopilot_jobs.branch` is a real column, but a merge job's branch still round-trips through the
  free-text `detail`, and three places parse it there.
- `projects.merge_autonomy` (auto | plan | off) is how much merging one ▶ Run covers. It is not
  `automode` (whether a project is built unattended). Neither relaxes the conflict probe, the risk
  gate or the confirm.
- A night's outcomes partition into four buckets (`landed` / `failed` / `planned` / `noCommits`) that
  always sum to the run count. **A plan night is the advisor working, not idle**: `planned` sits out
  the land rate but keeps its spend.
- `agent_profiles` holds only overrides (the header says how built-ins survive a DELETE). `--agents`
  is passed only when an advisor is set; with none, every profile is inert, and a surface showing
  them must say so. A profile's tools are data, granted by a screen.

## Other surfaces

- **`DELETE /api/projects/:slug` is soft**: it stamps `deleted_at`, clears the share link and keeps
  every row. Binned projects vanish from live queries. `/purge` is the cascade, binned only.
- **The `worktrees` table is a register, not a manager.** `session_name` keeps the `stack-term-`
  prefix, which the running-sessions strip and host reapers key off.
- **`stack-auto-*` sessions are readable from the browser, not mirrorable, killable or typeable.**
  Don't widen `listStackSessions` to cover both lists.
- **`POST /api/terminal/answer`** is the only path by which anything but a human at the keyboard
  types into a session. The pane it was drawn from may be 20 seconds old, so "1" can land as a stray
  digit in someone's message. The rules are at the route.
- `routes/context.js` is not a CLAUDE.md library, and nothing in it writes one.
- The recipe library (`/api/tips`) has a route and a table but no screen.
- Both closure counts in `totals` lean on `updated_at`: read them as movement, not a ledger.
- **Host-side agent ops outlast a web request.** nginx's `/api` read timeout and each op's own
  timeout must both clear it, and Cloudflare cuts at ~100s regardless.

## Settings whose meaning isn't obvious

One row, in client camelCase; PATCH takes any subset. Full list in `routes/settings.js`.

| key | meaning |
| --- | --- |
| `keepResumeCard` | off → ingest skips the resume refresh and the card is dropped |
| `sessionDefaults` | catalogue keys (lean/ship/checkpoint/confirm/verify/fly) injected by SessionStart into every project. `ship` = commits pre-authorised; `fly` is what makes a session open its own card |
| `autopilotEnabled` | the arm switch. Nightly and scheduled jobs enqueue only while on; ▶ Run now is always manual |
| `autopilotWorkers` | fleet-wide concurrent job cap (0 = unlimited, default 3, clamped 1–8) |
| `autopilotAdvisorModel` / `autopilotExecutorModel` | the advisor runs the session (plans, delegates, verifies, commits); the executor is its subagent with the write tools. Advisor unset = single model |
| `assistFields` / `assistGuidance` | what ✧ Fill-from-note may fill, plus the owner's steer. Never overrides a human's value |
| `termIdleHours` | idle reaper threshold (0 = never). Switches both the host reaper and the daemon's unused sweep |
| `accessPinSet` | PIN sign-in available; PATCH takes write-only `accessPin` ('' disables). Any change signs out every PIN device |

## Tests

`server/test/*.test.mjs`. DB-backed tests need a fresh throwaway Postgres each, and `STACK_API`
unset (the shell profile points it at production, so a bare run 401s against the live app).
