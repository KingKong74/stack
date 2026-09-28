# CLAUDE.md — Stack

This file holds what a session would get **wrong** without being told: rules with no compiler behind
them, and why they are the way they are. It is not a feature list or an API reference, because the
code is the reference and a doc that restates it drifts.

Rules live as close to their code as possible:

- **A rule governing one file** goes in that file's header. Read the header before editing the file.
- **A rule governing one package** goes in that directory's `CLAUDE.md` (`web/`, `server/`,
  `scripts/`, `hook/`, `terminal/`). Claude Code loads it when you work there.
- **This file** holds only what spans packages: the mirrored rules, the fail-safe directions, and the
  hard nevers.

Every file has a size budget, enforced by `node scripts/context-budget.test.mjs`. If one is over,
cut restatement and history. Don't raise the cap. Describe how things are now, not what they used to
be. The why behind a shipped feature lives in its commit message and its `built_note`.

## What Stack is

A self-hosted command centre for side projects. The point is **frictionless resume**: open a project
and the resume card tells you where you left off. A push auto-extracts bugs and next steps into the
trackers, and progress is computed, never hand-set. Unattended builds run overnight from the
**sprint in progress** in each project. A human gives the verdicts.

## Map

| dir | what | read first |
| --- | --- | --- |
| `web/` | Vite + React 18 + strict TS, hash-routed. `src/store.ts` is the only network/storage module | `web/CLAUDE.md` |
| `server/` | Express + Postgres. Idempotent migrate on boot; refuses to start without `API_TOKEN` | `server/CLAUDE.md` |
| `scripts/` | Host-side CLI (`./stack`), the autopilot runner + dispatcher, tests, Playwright smoke | `scripts/CLAUDE.md` |
| `hook/` | Zero-dependency Claude Code hooks + the `/checkpoint` poster | `hook/CLAUDE.md` |
| `terminal/` | The web terminal's host daemon | `terminal/CLAUDE.md` |
| `templates/` | `stack-agent-context.md`, the portable agent manual (exported verbatim; update it when the API or hook contract changes) | — |

The server runs in a container, and the host firewall drops container→host traffic. **Everything
host-side dials out**: terminal daemon, dispatcher, branch report, skills sync. Anything that needs
host state is a poll-and-report, never a push from the server.

## Before you change what a roadmap row means

Several predicates are **copied across packages that cannot import one another**. Nothing but
discipline keeps them in step. Change one copy, change them all, in the same commit.

| rule | definition | copies |
| --- | --- | --- |
| **Built** | `done` OR (`built_note` non-empty AND `claimed_by` non-empty). Both halves are load-bearing: un-ticking clears `claimed_by` but keeps `built_note`. Nothing in Stack ticks an item, so a path acting on built work must use this, never `done` alone | `lib/plan.ts` `isBuilt` (the client's only copy), every server path acting on built work |
| **Approved to run** | `source NOT IN ('hook','fly') OR reviewed_at IS NOT NULL`. There's no column: a flag would become a second truth that drifts. A manual item is never held | `server/src/approval.js`, `scripts/lib/approval.mjs`, `web/src/lib/approval.ts` |
| **Area lane** | key `(project, area)`. An area with an open claimed item admits no second worker. Untagged (`''`) is never a lane; a worker never blocks itself | `server/src/lanes.js`, `routes/autopilot.js` claim, the runner's pick |
| **Run order** | active sprint's rows by `sprint_rank`, then `bucket`, then payload order. Rank only means something inside the active sprint (backlog rows are all 0) | `routes/autopilot.js`, the runner, `lib/plan.ts` `queueOrder` |
| **Schedule** | minutes from week zero (`sched_*_min`; `plan_*_min` is the write-once baseline a drag never moves). BIGINT arrives from pg as a string | `routes/roadmap.js`, `shape.js`, `lib/plan.ts`, `lib/spine.ts` |
| **Branch name** | `<kind>/<id>-<summary>`. The legacy `auto/item-N-<slug>` must parse forever, with kind `''`, never `feat` | `scripts/lib/lane.mjs`, `web/src/lib/branch.ts` |
| **Which screen** | `homeOf` → `auto \| roadmap \| board`. Call `isBoardWork`, never `!isIdea` | `lib/plan.ts` (single copy; keep it that way) |
| **Brandmark geometry** | the logo's plates | `components/Brandmark.tsx`, `scripts/render-icons.mjs`, `scripts/lib/brandmark.cjs` |

Also:

- **`bucket` is the priority** (highest…lowest). A row is born `medium`. `computeProgress` weights
  all five buckets, and **the default bucket and the weights are one decision**: leave `medium` out
  of the sum and every new board reads 0% forever.
- **Deleting a `source='hook'` row tombstones its fingerprint** so the next push can't re-create it.
  That's what Dismiss means, and why it has no undo.
- `server/CLAUDE.md` has the rest of the column semantics.

## Before you change who or what may run

Gates, outermost first. Each is enforced where it is explained:

1. **The sprint in progress.** The automation only touches the project's `active` sprint. The
   database allows at most one per project (a partial unique index). **No active sprint means the
   night does nothing**, and says so out loud; it never falls back to the board. Run now and a
   calendar row are not gated, because each names one item a human picked.
2. **Approval** (above). An unattended enqueue drops a held item silently; Run now refuses out loud
   and names it.
3. **Fleet cap** (`autopilotWorkers`, tunable), **per-project serialisation** (not tunable: every job
   shares one checkout and git's ref locks), **area lane**. All three live in `CLAIM_NEXT_SQL`'s one
   WHERE (`routes/autopilot.js`). Widening concurrency widens the fleet cap only. A skipped job
   always logs why.

Who writes what:

- **Agents never write `sprint_id` or `sprint_rank`.** A POST never sets a sprint, or the extractor
  could commission tonight's work by writing a title. The ✧ Planner proposes; Apply is the human's
  drag route.
- **`risk` is written only through `PATCH /roadmap/:id`**, whose CASE guard lets an auto write
  replace only a NULL `risk_source`. A `low` item whose run lands green auto-queues its own merge, so
  a casual risk write is expensive.
- **A verdict is the human's**, with one sanctioned exception: machine verdicts on low-risk all-green
  runs (#263; the conditions are in `scripts/lib/autoverdict.mjs`'s header). **A refine round is
  never machine-closed** (#274): no auto-merge, no auto-verdict.
- **An agent annotates a verdict; it never gives one.** Its output is a call (approve / look /
  send-back), drawn in the accent, never a verdict tone. It carries `blind[]` (what it couldn't see)
  and `read[]` (what it was given). An agent-authored link is reduced to a same-origin path before
  rendering.
- **An empty second-model read means no pass ran**, not "nothing found". A NULL
  `review_verdict`/`architect_verdict`/`advice` renders as NO REVIEW, never green. The same goes for a
  branch merge state of `unprobed`: it is not `clean`.
- **"Agent" means a spawn profile** (`agent_profiles`), nothing else. A spawn always gets at least one
  building agent, or the expensive director model silently does the building.

## Before you change a route or payload

- **Change its check in the same commit.** Checks are Stack's only automated regression net, and a
  green suite is what the risk gate and auto-verdicts spend.
- `/report` writes `check_results` but never a `check_runs` row. `check_runs` is the suite ledger,
  and one reported result would read as a passing suite manufactured from outside.
- Shared run-ledger shapes live in `server/src/shape.js`. **BIGINT and NUMERIC come back from pg as
  strings.**
- If the API or hook contract changes, update `templates/stack-agent-context.md`.

## Before you ship UI

A strict build is necessary but not sufficient. Run `./stack ui-smoke` (layout), then
`scripts/run-palette-audit.sh` if you touched tone (contrast; the smoke is blind to colour). **A
screenshot is not a substitute** for either. `web/CLAUDE.md` has the rest.

## Before you add a model call

- **No paid external AI APIs** (owner's decision). Gemini's free tier is sanctioned everywhere. The
  local OmniRoute gateway is free unless `OMNIROUTE_MODEL` names a paid model in `~/.stack/env`.
- **Gemini annotates, the human disposes**: it never closes bugs, ticks items or merges branches.
- **An absent key degrades silently**: the route no-ops or 503s, and the client renders the feature
  absent (off `geminiReady`), not disabled.
- **An empty answer must be a valid answer, and the prompt must invite one.** A model told to produce
  a finding will manufacture one.
- **A capped prompt states its own cap** on the right axis (`server/src/prompts.js`'s header). A model
  that silently saw a tenth of a diff answers confidently about the rest.
- **Spend is two populations that never mix**: `autopilot_runs` (answers to the model policy) and
  `sessions.model_usage` (a human's choice, never "drift"). A merged share is token-based, because a
  transcript carries no cost.
- **Don't replace `/checkpoint` with an API summariser.** Resume content is authored by the session
  itself, for free.

## Fail-safe direction

Every host-side automation must decide what an unreachable API means. The direction is deliberately
not uniform. **Get it wrong and you delete work:**

- **Fail safe = do nothing** where the action destroys or spends: idle reaper, skills sync,
  dispatcher, arm switch, worktree prune, drop pruning. An unknown threshold reaps nothing.
- **Fail open = keep recording** where the action only records: `readSettings()` and both hooks
  default to "on".
- **Fail silent = report nothing, and say you can't see**, where absence would read as good news.
  `attention[]` and `conflicts[]` are empty with no host daemon, so check `terminal.connected` and say
  "Stack cannot see", never "nothing is waiting".
- **Fail loud = exit 1 with a reason** where "could not look" would read as "looked, found nothing":
  the Playwright smoke exits 0 only on a clean pass.

## Never

- Never commit secrets. `.env` and `~/.stack/env` are gitignored. Hooks never read tokens from the
  shell profile and never print them. No surface prints any part of a provider key.
- Never write a repo's `CLAUDE.md` from Stack. It once silently reverted this file for days. If
  something ever needs to, it gets an off switch before it gets a schedule.
- Never remove a skill Stack didn't plant (no `.stack-managed` marker → report, don't touch).
- Never let a preview write to the real database.
- Never give the browser kill/type access to `stack-auto-*` sessions (they run with
  `--dangerously-skip-permissions`).
- Never add an inline hex colour. The palette is the `:root` tokens in `web/src/styles.css`.
- Never bypass `lib/autoRefresh.ts` with a bare `setInterval` for a recurring re-fetch.
- Read layers (`overview`, `search`, `timeline`, `public`) are a few aggregate queries, never one
  query per project.

## Conventions

- **en-AU spelling** everywhere. Strict TS with `noUnusedLocals`/`noUnusedParameters`.
- Branch claims: claim (`claimed_by`) before starting; it stays until a human merges and ticks.
  **A non-Claude runtime launched from the terminal gets no injected branch claims**, so lane
  discipline there is on the human. Say so.
- Commits are pre-authorised by the owner's session defaults. The checkout at `/home/bailey/stack`
  is shared by parallel sessions, so check HEAD and stage only your own hunks.

## Tests and commands

`ls server/test/ scripts/*.test.mjs` is the test index; each header says how to run it. Most are pure
(`node <file>`). DB-backed ones need `DATABASE_URL`: stand up a throwaway `postgres:16-alpine` rather
than treating a missing database as a blocker, and unset `STACK_API`, which points at production.

```bash
./stack                                    # host CLI; bare lists sub-commands; writers are dry until --run
./stack ui-smoke                           # layout smoke (Playwright)
node scripts/context-budget.test.mjs       # the CLAUDE.md budgets
node scripts/roadmap-refs.mjs              # checks every #id cited in the repo against the board
node scripts/stack-autopilot.mjs --project stack --repo /home/bailey/stack --dry   # tonight's pick
cp hook/*.mjs ~/.stack/                    # install hooks — ~/.stack holds COPIES
crontab -l                                 # the dispatcher line; remove it to disable all runs
tail -f ~/.stack/{term,autopilot,preview}.log
```
