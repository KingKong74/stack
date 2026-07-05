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
  now". If it carries a **north star** (`northStar`), treat it as the project's
  direction and pull your work towards it. If it carries **directives**, they
  are standing instructions from the owner — honour them before anything else,
  and don't remove them yourself (they're cleared from the dashboard).

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

## Lane claims (parallel sessions)

Open roadmap items can carry a claim (`claimedBy` — usually a branch name like
`lane/ui`). The SessionStart block lists current claims. The protocol:

- **Never start an item claimed by another lane.**
- **Never start an item with `skipped: true`** — it's parked on purpose; the
  owner unparks it from the UI when it's back in play.
- If you're one of several parallel sessions and you pick up a roadmap item,
  **claim it first** (your claim label = your branch name):

  ```bash
  source ~/.stack/env
  curl -s -X PATCH "$STACK_API/api/projects/<slug>/roadmap/<id>" \
    -H "authorization: Bearer $STACK_TOKEN" -H 'content-type: application/json' \
    -d '{"claimed_by":"<your-branch>"}'
  ```

- Marking the item `{"done":true}` finishes it; send `{"claimed_by":""}` to
  release one you're abandoning. Never print the token while doing this.

## House rules

- **en-AU spelling** everywhere (colour, behaviour, summarise, …).
- **`web/src/store.ts` is the only module that talks to the network.** If you add
  a data call, it goes there — components never `fetch` or touch storage directly.
- **Both hooks must always exit 0** and log only to stderr. They must never block
  or delay Claude Code starting or stopping.
- **No secrets in the repo.** Secrets load at runtime from `.env` (server) and
  `~/.stack/env` (hooks).
