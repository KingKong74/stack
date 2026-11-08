<!--
  Stack — portable agent operating manual.
  This file is the single source of truth. If the API or hook contract changes,
  update THIS file (it is exported verbatim by scripts/stack-context.mjs).
  Pipe it into a project's CLAUDE.md or your global ~/.claude/CLAUDE.md.
-->
# Working with my projects through Stack

Stack is my self-hosted side-project command centre. Each project has a live
"where you left off" resume card, an activity feed, a bug tracker, a priority
roadmap and sticky notes. State is **auto-managed** — you don't have to curate it.

## Codex sessions

Stack Terminal launches Claude and Codex natively, with Shell as a utility. New Codex sessions
use YOLO mode; its sidepanel lists account models and reported quota windows. Codex has no automatic
resume injection, branch claims, SessionEnd backstop or usage/edit tracking. Read live state and
claims before choosing board work. Author checkpoint JSON and pipe it to
`node ~/.stack/stack-checkpoint.mjs`; `/checkpoint` is a Claude command, not a Codex command.
Unknown telemetry never means zero usage or no active work.

## Trust the injected context

Three Claude Code hooks keep Stack in sync with reality:

- **SessionStart** injects a *"where you left off"* block at the top of the
  session — the resume summary, current phase, what's in progress / next up, any
  blockers, the open-bug count and the last few activity entries. It opens with
  any **session defaults** (app-wide standing preferences set in Stack settings —
  e.g. "commits are pre-authorised: commit and push each unit without asking")
  followed by the project's **directives**. Treat both as granted permissions and
  standing orders — don't re-ask for what they already grant.
- **SessionEnd** is a metadata backstop. It captures the commit, branch,
  files touched, tools used and the last substantive message, and posts that so
  the activity feed never has gaps, and never overwrites a richer authored
  checkpoint or the resume card.
- **PostToolUse on ExitPlanMode** files an approved plan as an Artifacts doc. It
  adds no roadmap items.

When a "where you left off" block is present, **trust it** rather than
reconstructing context by re-reading the whole repo. It reflects the live state
as of the last push. Only dig deeper when the task needs detail the block omits.

## Checkpoint your work with `/checkpoint`

Rich resume content is **authored by you**, not by an external model — it's free
and uses no API. When you wrap up meaningful work, run **`/checkpoint`**. It:

- reads the settings (`checkpoint_detail`, `include_chores`), derives the slug,
- has you compose the full checkpoint schema — summary, current phase, in-progress,
  next-up, working-well, blockers, tags, plus candidate bugs and next-steps for
  auto-extraction — and
- pipes that JSON to `~/.stack/stack-checkpoint.mjs`, which posts it (reading the
  token from `~/.stack/env`, never printing it).

Make `/checkpoint` routine when finishing a unit of work; it is what makes the
resume card and trackers rich. On the spine (#626): send `session.slice` (the id
from SessionStart's "Your slice") and, only for a real design call, up to three
`extract.decisions` (`title`, `context`, `decision`, `consequences`). They file
as **proposed** ADRs; only the owner accepts one. An approved plan-mode plan is
linked to your branch's slice and fills its spec only if that spec is empty.

## Reading a project's live state on demand

The block is a snapshot. For the current state at any moment, read the API:

- `GET /api/projects` — all projects with computed progress.
- `GET /api/projects/<slug>` — one project plus its activity, bugs, roadmap,
  notes and checks. This is the authoritative "how is this project doing right
  now".
  If it carries a **north star** (`northStar`), treat it as the project's
  direction and pull your work towards it. If it carries **directives**, they
  are standing instructions from the owner — honour them before anything else,
  and don't remove them yourself (they're cleared from the dashboard).
- `GET /api/agent-profiles` — Stack's agents, and since #520 the only thing the
  word means here: the SPAWN PROFILES an autopilot run hands `claude --agents`.
  Each is a subagent with its own prompt, model and granted tools.
  **These are not you** — you are the session; these are what a *run* delegates
  to. Worth reading to explain what an autopilot build actually spawned, or why
  it spawned nothing: `--agents` is passed only when an ADVISOR model is set, so
  on a single-model install every profile is inert. `policy.spawnsAgents` says
  which, and `defaultSpawn` is the server resolving a real one.
  **A ✧ is a plain Gemini route**, so a 503 from one means `GEMINI_API_KEY`.

- `GET /api/projects/<slug>/artifacts` — docs, plans, designs, links and files
  kept beside the work (`…/artifacts/<id>/file` is the bytes). Write only when asked.
- `GET /api/spaces` — areas, hubs' workflows, the wishlist. **Report each run
  of a hub workflow you run**: `POST /api/spaces/workflows/<id>/runs {"ok":bool}`.

**Repo instructions belong to the repo.** Mission Control → Context reads
CLAUDE.md and AGENTS.md live from disk. Only a human Save writes them, guarded
by the opened hash. Stack stores no copy and never syncs one back on a schedule.

The base URL and slug for the project you're in are stamped at the bottom of this
file when it was exported (or are blank in the generic template).

## Auth

Every route except `GET /api/health` needs a bearer token. The token lives in
`~/.stack/env` as `STACK_TOKEN` (alongside `STACK_API`). The hooks load it from
there. **Never print, echo, log or commit the token**, and never read it from a
shell profile or settings file — `~/.stack/env` is the only source.

## Don't hand-create duplicates

Bugs and roadmap items **auto-extract from sessions** and dedupe by a
fingerprint of their title. So:

- Don't re-add by hand what the hook extracts: it makes a near-duplicate.
- Deleting an auto item tombstones it, so the next push won't resurrect it.
- The extractor never touches manual items: use one for what a summary won't capture.

## Suggest the tests this session showed were missing (#500)

`extract.tests` on a checkpoint files what nothing checks yet. It lands in
**For you → Auto-ideas**, held from the autopilot until the owner keeps,
promotes or dismisses it — never straight onto the board.

```json
"tests": [
  { "title": "A red check's bug link survives a re-run", "kind": "bug", "target": "BUG-31" },
  { "title": "The health route answers before the database is up", "kind": "function", "target": "GET /api/health" }
]
```

- `kind` is REQUIRED — `bug` (a test that would have caught a defect this
  session saw) or `function` (a check on a named route or function nothing
  watches). Any other kind is dropped rather than guessed at.
- `target` is what makes it actionable: a bug key, or the route's real name.
  "the API" is not a target. It may be empty on a `bug` entry whose defect was
  described but never filed.
- **At most six**, fewer is better, `[]` when nothing was missing. A `bug`
  entry naming a bug a check already covers is dropped server-side.

Narrower than `next_steps` (switched off): a missing test is bounded by what
actually broke.

## FLY CARDS ARE SWITCHED OFF (#381, paused #477)

**Do not open a roadmap card for the work you are asked to do.** The `fly`
session default is off, so you will not be told to, and you should not do it
unasked. Record what you did in your summary and in `/checkpoint` instead.

A card the OWNER asks you to open is a different thing: post it `source:"manual"`
(a human asked for it, so it is committed work and never held) and say so — and
not for trivia, a typo or a question answered. The test is whether the owner
would want it on the board tomorrow.

## Branch naming

Cut branches as **`<kind>/<id>-<summary>`** — `feat/271-mission-control`,
`fix/312-galaxy-drift-belt`, `ui/288-roles-room-by-job`. The kinds are
`feat · fix · ui · refactor · perf · test · docs · chore`; a bug's branch is
`fix/bug-<n>-<summary>` and an audit night's is `test/audit-<date>`. The
autopilot names its own lanes this way, and the kind is read off the branch
name before anything reads the diff. Get it wrong and the branch still merges;
it just lands in the unlabelled bucket.

Older `auto/item-N-<summary>` branches are still read everywhere (they are
still on origin and still named in claims). Don't rename them — a claim is a
live string on a roadmap row.

## Branch claims (parallel sessions)

Open roadmap items can carry a claim (`claimedBy` — the branch name, e.g.
`ui/12-dark-mode`). The SessionStart block lists current claims. The protocol:

- **Never start an item claimed by another branch.**
- **Never start an unapproved auto-found item.** An item with `source: "hook"`
  was extracted from a push by the tooling, not written by the owner, and until
  they sign it off (`reviewed: true`) it is not work anybody has agreed to. Every unattended path already refuses it, so if you
  find one in front of you, leave it and take the next item. An item with
  `source: "manual"` is approved the moment it exists — a human wrote it —
  whatever `reviewed` says.
- **Never start an item with `skipped: true`**: it's parked on purpose; the
  owner unparks it when it's back in play.
- **Only the READY queue is yours to build**: items with `ready: true`, in
  `readyRank` order, lowest first. The sprint in progress (`status: "active"`
  in `sprints`) is the PLANNING lane: designed and broken down, not built.
  An empty Ready queue means nothing to build unattended.
- **The spine**: `charter` is the charter's opening; `milestones` hold
  `slices`; `sliceId` null is the Icebox (off the board, never Ready).
- **Never set `ready`/`readyRank`, move an existing item's slice, or write a
  milestone, slice or sprint.** Those are the owner's call. A sprint commits
  to slices: an item is in one iff its slice is (`sprintId` is derived and a
  write is refused). You MAY file NEW items into a slice (`sliceId`) on
  `POST /roadmap` or `/batch`; they land at its bottom. A part with no
  `sliceId` takes its parent's. Filing is not
  approval: a `fly`/`plan` item stays held until signed off.
- **To propose a plan, POST a PROPOSITION**, not milestones/slices:
  `POST /api/projects/<slug>/propositions` `{sourceKey, title, outcome,
  purpose, artifactId?, links[], tree:{milestones:[{key, name, goal,
  milestoneId?, slices:[{key, title, spec, items:[{key, title, kind, spec,
  dependsOn[]}]}]}]}}`. A stable `sourceKey` (e.g. `artifact:6`) makes a
  retry update, never copy; 409 `dismissed` = never re-propose; 409 `edited`
  = the owner owns it, use a new key. Accept and dismiss are the owner's.
- **A claim is on the ITEM; the collision is on the FILE.** A claim says who
  owns a roadmap row, not who owns a file — two sessions in one checkout share
  a dirty tree, so git cannot tell their edits apart. If you are in a shared
  checkout, prefer a worktree for anything that rewrites a large file.
- If you're one of several parallel sessions and you pick up a roadmap item,
  **claim it first** (your claim label = your branch name):

  ```bash
  source ~/.stack/env
  curl -s -X PATCH "$STACK_API/api/projects/<slug>/roadmap/<id>" \
    -H "authorization: Bearer $STACK_TOKEN" -H 'content-type: application/json' \
    -d '{"claimed_by":"<your-branch>"}'
  ```

- Marking the item `{"done":true}` finishes it; send `{"claimed_by":""}` to
  release one you're abandoning. Un-ticking (`{"done":false}`) sends an item
  back into play fresh: the server clears its archive verdict and branch claim
  so it re-enters the To verify pipeline and is pickable again. Never print
  the token while doing this.
- **When you finish an item, tell the reviewer what landed.** Write a
  `built_note` — two or three plain sentences on what was actually built, where
  it lives and how it was verified. The card moves itself into the board's **To
  verify** column and the human verdicts against it there.

  **If your work is on a branch and you have not merged it, do NOT tick the
  item.** `done` means shipped, and an unmerged branch has not shipped. Write
  the `built_note`, leave `claimed_by` on the branch, and leave `done` alone:
  ```bash
  curl -s -X PATCH "$STACK_API/api/projects/<slug>/roadmap/<id>" \
    -H "authorization: Bearer $STACK_TOKEN" -H 'content-type: application/json' \
    -d '{"built_note":"<what landed, where, how verified>"}'
  ```

  That is not "leaving it unfinished" — a `built_note` plus a branch claim is
  exactly what puts the change into the Review queue, and it lands there as
  work still on a branch so the human reads it BEFORE it merges. Ticking it
  instead would count unmerged work towards the project's progress and skip the
  read entirely. Once the human approves it, merging is what ticks it off.

  Tick it yourself (`{"done":true,"built_note":"…"}`) only when what you built
  is already on the main branch.
- **Manual execution sessions report usage like autopilot runs do.** When you
  complete a roadmap item outside the autopilot, also land a run-ledger
  row so the Reviews view shows the same branch/commits/tokens chip for manual
  work (tokens/cost optional — include them when you know them):

  ```bash
  curl -s -X POST "$STACK_API/api/projects/<slug>/autopilot/runs" \
    -H "authorization: Bearer $STACK_TOKEN" -H 'content-type: application/json' \
    -d '{"item_id":<id>,"item_title":"<title>","branch":"<branch>","outcome":"landed","commits":<n>,"summary":"<one paragraph on what landed>"}'
  ```
- **Items can carry an implementation plan** — `plan`, an ordered list of
  `{"text": "…", "done": false}` steps the owner wrote for bigger work. Work the
  unticked steps top-down. As each step lands, PATCH the FULL updated list back
  (the whole array replaces, there is no per-step endpoint):

  ```bash
  curl -s -X PATCH "$STACK_API/api/projects/<slug>/roadmap/<id>" \
    -H "authorization: Bearer $STACK_TOKEN" -H 'content-type: application/json' \
    -d '{"plan":[{"text":"first step","done":true},{"text":"second step","done":false}]}'
  ```

  Stopping partway is fine: ticked steps tell the next session where to resume.

  The **plan sweep** designs the sprint's plan-less items, filing big ones as
  held `plan` pieces; it never builds, ticks or touches a started plan.
- **Items can carry a `spec`**: `{"goal","acceptance":[],"files":[],"outOfScope":[]}`,
  on POST or PATCH. A build run is held to it. `POST /roadmap/batch` with
  `{"items":[…]}` makes up to 50 at once, all or nothing; each may take
  `parentId`. `source:"plan"` rows are held until the owner approves them.
- **An item may come back as a refinement** — if it carries a `refineNote`, it
  was built before and sent back with a delta. `builtNote` says what already
  landed; change ONLY what the refinement asks for, on top of that — don't
  rebuild from the title/note as if it were fresh. Completing the item again
  (`done:true`) clears the refinement automatically — never PATCH `refine_note`
  yourself; it's the owner's steer, not yours to edit.

## House rules

- **en-AU spelling** everywhere (colour, behaviour, summarise, …).
- **`web/src/store.ts` is the only module that talks to the network.** If you add
  a data call, it goes there — components never `fetch` or touch storage directly.
- **Both hooks must always exit 0** and log only to stderr. They must never block
  or delay Claude Code starting or stopping.
- **No secrets in the repo.** Secrets load at runtime from `.env` (server) and
  `~/.stack/env` (hooks).
- **A strict build is not enough for UI work — you cannot see your own rendering.**
  Before calling a UI change done, run `scripts/run-ui-smoke.sh` (or
  `./stack ui-smoke`), a headless-browser pass over the app that catches layout
  and console/network breakage a typecheck can't.
