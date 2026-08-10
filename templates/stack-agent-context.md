<!--
  Stack — portable agent operating manual.
  This file is the single source of truth. If the API or hook contract changes,
  update THIS file (it is exported verbatim by scripts/stack-context.mjs).
  Pipe it into a project's CLAUDE.md or your global ~/.claude/CLAUDE.md.
-->
# Working with my projects through Stack

Stack is my self-hosted side-project command centre. Each project has a live
"where you left off" resume card, an activity feed, a bug tracker, a MoSCoW
roadmap and sticky notes. State is **auto-managed** — you don't have to curate it.

## Trust the injected context

Two Claude Code hooks keep Stack in sync with reality:

- **SessionStart** injects a concise *"where you left off"* block at the top of the
  session — the resume summary, current phase, what's in progress / next up, any
  blockers, the open-bug count and the last few activity entries. It opens with
  any **session defaults** (app-wide standing preferences set in Stack settings —
  e.g. "commits are pre-authorised: commit and push each unit without asking")
  followed by the project's **directives**. Treat both as granted permissions and
  standing orders — don't re-ask for what they already grant.
- **SessionEnd** is a metadata backstop only. It captures the commit, branch,
  files touched, tools used and the last substantive message, and posts that so
  the activity feed never has gaps. **It calls no external API.** It is
  COALESCE-safe: a metadata post never overwrites a richer authored checkpoint or
  the resume card for the same commit.

When a "where you left off" block is present, **trust it** rather than
reconstructing context by re-reading the whole repo. It reflects the live state
as of the last push. Only dig deeper when the task needs detail the block omits.

## Checkpoint your work with `/checkpoint`

Rich resume content is **authored by you**, not by an external model — it's free
and uses no API. When you wrap up meaningful work, run **`/checkpoint`**. It:

- reads the current settings (the `checkpoint_detail` level shapes how much your
  summary explains; `include_chores` decides whether chore-only sessions count),
- derives the project slug from the git remote,
- has you compose the full checkpoint schema — summary, current phase, in-progress,
  next-up, working-well, blockers, tags, plus candidate bugs, next-steps and
  futures (loose directional ideas, distinct from concrete next-steps) for
  auto-extraction — and
- pipes that JSON to `~/.stack/stack-checkpoint.mjs`, which posts it (reading the
  token from `~/.stack/env`, never printing it).

Make `/checkpoint` routine when finishing a unit of work. The hook silently
guarantees the feed is never empty; `/checkpoint` is what makes the resume card
and trackers rich.

## Reading a project's live state on demand

The block is a snapshot. For the current state at any moment, read the API:

- `GET /api/projects` — all projects with computed progress.
- `GET /api/projects/<slug>` — one project plus its activity, bugs, roadmap,
  notes and futures. This is the authoritative "how is this project doing right
  now".
  If it carries a **north star** (`northStar`), treat it as the project's
  direction and pull your work towards it. If it carries **directives**, they
  are standing instructions from the owner — honour them before anything else,
  and don't remove them yourself (they're cleared from the dashboard).
- `GET /api/agents` — Stack's own in-app agents (Auditor · Quality tab,
  Curator · Roadmap tab, Polaris · Futures tab, Drafter · Workbench tab,
  Foreman · Review room, Merge agent · Merge room, Scribe · Instructions tab).
  **These are not you**: they are the ✧ buttons on those surfaces, each
  restricted to its own, and any of them can be switched off in Mission
  Control → Agents. The four project-tab agents also carry a `console` — a live
  Claude session in the project's checkout, opened from a strip on their own
  tab and running in tmux on the host. It has its own switch (`consoleEnabled`
  on the PATCH), is not an op, and never appears in `ops`. Its session is
  SPAWNED as that agent: `GET /api/projects/:slug/console/:key` composes the
  briefing (identity, remit, the owner's standing guidance and a snapshot of the
  tab) and the host appends it to the session's system prompt, so one of these
  may introduce itself as the Auditor or the Curator — that is a primed console,
  not another session pretending to be one. Worth reading only to
  explain why a ✧ surface is missing, or why one of those routes answered 409
  (switched off) or 503 (the backend is down — since #364 they run `claude -p`
  on the host through the terminal daemon, so that daemon is their backend
  rather than an API key; the Scribe's read-only quick passes are the one
  exception and still run on Gemini, so a 503 there means the key, not the
  daemon — each op reports which in `backend`).
- `GET /api/instructions` — the CLAUDE.md tree Stack manages: the personal
  `~/.claude/CLAUDE.md` and each project's root and nested files, plus what the
  host last found on disk. **Worth reading when you are about to change a
  CLAUDE.md**: a file listed here with `enabled` is written by the host from
  Stack's copy on its next sync, so editing it in the repo by hand is a change
  that gets overwritten. Edit it through `PATCH /api/instructions/<id>` instead,
  or leave it alone. A file the report lists as `managed: false` is nobody's but
  the repo's — edit that one normally.

The base URL and slug for the project you're in are stamped at the bottom of this
file when it was exported (or are blank in the generic template).

## Auth

Every route except `GET /api/health` needs a bearer token. The token lives in
`~/.stack/env` as `STACK_TOKEN` (alongside `STACK_API`). The hooks load it from
there. **Never print, echo, log or commit the token**, and never read it from a
shell profile or settings file — `~/.stack/env` is the only source.

## Don't hand-create duplicates

Bugs, roadmap items and futures **auto-extract from sessions** and dedupe by a
fingerprint of their title. So:

- Don't manually re-add a bug or next-step the hook will extract anyway — you'll
  just create a near-duplicate.
- Deleting an auto item tombstones it, so the next push won't resurrect it.
- Manual items are never touched by the extractor. Reach for a manual bug/roadmap
  item/note when you want something the session summary wouldn't capture.

## Open a FLY card when you start ad-hoc work (#381)

Asked to build something **not already a roadmap item**? Open a card first, or
the work lives only in this transcript — not somewhere the owner can review it,
rework it, or find it next week.

```bash
source ~/.stack/env
curl -s -X POST "$STACK_API/api/projects/<slug>/roadmap" \
  -H "authorization: Bearer $STACK_TOKEN" -H 'content-type: application/json' \
  -d '{"source":"fly","session":"'"$(tmux display-message -p '#S' 2>/dev/null)"'",
       "title":"Fix the console strip flicker","note":"What was asked for.",
       "bucket":"should","area":"terminal"}'
```

- **`source:"fly"`** is the marker — a live session opened this, as against
  `manual` (a human typed it) and `hook` (extracted from a push). Posting
  `"hook"` is refused; that source is the extractor's alone.
- **`session`** is your tmux session name. Send it if you can find it; the card
  is created without one, and inventing a plausible name is far worse.
- **It is HELD from the overnight runner** until the owner signs it off, like a
  hook item — you are recording work, not commissioning a night of it. It does
  not stop YOU doing the work now.
- **One card per piece of work, not per turn.** The same title twice from one
  session returns the first card (200, not 201) — don't lean on that.
- **409 with `"dismissed":true`** = the owner deleted that card. Don't post it
  again; say so in your summary.
- Then treat it as any other item: claim it, and write a `built_note` when done.

Not for trivia — a typo, a question answered, a file read. The test is whether
the owner would want it on the board tomorrow.

## Branch naming

Cut branches as **`<kind>/<id>-<summary>`** — `feat/271-mission-control`,
`fix/312-galaxy-drift-belt`, `ui/288-roles-room-by-job`. The kinds are
`feat · fix · ui · refactor · perf · test · docs · chore`; a bug's branch is
`fix/bug-<n>-<summary>` and an audit night's is `test/audit-<date>`. The
autopilot names its own lanes this way, and Mission Control's Merge room
filters and groups on the prefix — so the kind is read off the branch name
before anything reads the diff. Get it wrong and the branch still merges; it
just lands in the unlabelled bucket.

Older `auto/item-N-<summary>` branches are still read everywhere (they are
still on origin and still named in claims). Don't rename them — a claim is a
live string on a roadmap row.

## Branch claims (parallel sessions)

Open roadmap items can carry a claim (`claimedBy` — the branch name, e.g.
`ui/12-dark-mode`). The SessionStart block lists current claims. The protocol:

- **Never start an item claimed by another branch.**
- **Never start an unapproved auto-found item.** An item with `source: "hook"`
  was extracted from a push by the tooling, not written by the owner, and until
  they sign it off in the Plan room inbox (`reviewed: true`) it is not work
  anybody has agreed to. Every unattended path already refuses it, so if you
  find one in front of you, leave it and take the next item. An item with
  `source: "manual"` is approved the moment it exists — a human wrote it —
  whatever `reviewed` says.
- **Never start an item with `skipped: true`** — it's parked on purpose; the
  owner unparks it from the UI when it's back in play. (The Roadmap tab's Parked
  view ages every parked item and flags the stale ones, so nothing rots unseen.)
- **Respect the desire tier.** Open items may carry `tier` — `S`/`A`/`B`/`C`,
  the owner's ranking of what they want NEXT, deliberately separate from the
  MoSCoW bucket's sizing. It is the primary sort of the run queue: work S before
  A before B before C, and unranked items last. Never set or change a tier
  yourself — it's the owner's ground truth for what matters.
- **A claim is on the ITEM; the collision is on the FILE.** Mission Control now
  watches which files each live session is writing (read off the transcripts —
  two sessions in one checkout share a dirty tree, so git cannot tell them
  apart) and flags a file two of you are editing at once. The claim is still
  the protocol; this only means the owner sees it when the protocol is not
  enough. If you are in a shared checkout, prefer a worktree for anything that
  rewrites a large file.
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
  it lives and how it was verified. The human verdicts against it in the Review
  room.

  **If your work is on a branch and you have not merged it, do NOT tick the
  item.** `done` means shipped, and an unmerged branch has not shipped. Write
  the `built_note`, leave `claimed_by` on the branch, and leave `done` alone:
- **When you finish an item, tell the reviewer what landed.** Include a
  `built_note` alongside `done:true` — two or three plain sentences on what was
  actually built, where it lives and how it was verified. It appears on the
  Roadmap tab's Reviews view, and the human verdicts against it. Anything past
  2000 characters is kept to 2000 with a line saying how long the note really
  was — so a long note loses its tail, and everyone reading it can see that:

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
  complete a roadmap item outside the overnight runner, also land a run-ledger
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

  Stopping partway is fine — ticked steps tell the next session (or the
  overnight autopilot, which injects the plan into its prompt) where to resume.

  An empty `plan` on an open must/should item is what the **plan sweep** looks
  for: while it's on, the server stands up an unattended plan session for any
  automode project with work that has no design yet, so a build night rarely
  starts from a bare title. A plan session designs and PATCHes steps back — it
  never builds, never ticks and never touches a plan whose steps you've already
  started ticking.
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
