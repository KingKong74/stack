---
description: Author a rich Stack checkpoint for the current work and post it (no external API)
allowed-tools: Bash(git:*), Bash(node:*), Bash(cat:*)
---

# /checkpoint — author a Stack checkpoint

Summarise the work in this session into Stack's full checkpoint schema and post
it to the Stack API. Rich resume content is **authored by you** here — it costs
nothing and uses no external API. (The SessionEnd hook only ever records bare
metadata as a backstop, so this is how the resume card and trackers stay rich.)

> Install: copy this file to `~/.claude/commands/checkpoint.md` so `/checkpoint`
> is available in every project. It relies on `~/.stack/stack-checkpoint.mjs`
> (the poster) and `~/.stack/env` (which holds `STACK_API` and `STACK_TOKEN`).

Do the following:

1. **Read the settings** (they shape this checkpoint). Run:

   ```bash
   node ~/.stack/stack-checkpoint.mjs --settings
   ```

   It prints JSON like `{"autoRecord":true,"keepResumeCard":true,"checkpointDetail":"standard","includeChores":false}`.
   - `checkpointDetail` controls how much your `summary` explains:
     - **brief** — one or two sentences, just enough to re-orient.
     - **standard** — a balanced paragraph plus the concrete next moves.
     - **detailed** — a fuller account: what changed, why, and the current state.
   - `includeChores` — if **false** and this session was chore-only (formatting,
     dependency bumps, config, no real feature/fix), **stop** and tell the user
     you skipped the checkpoint. If **true**, checkpoint anyway.

2. **Gather the git context** for the project identity and commit:

   ```bash
   git rev-parse --short HEAD; git rev-parse --abbrev-ref HEAD; git config --get remote.origin.url
   ```

   Derive the **slug** from the repo name (the `owner/repo` tail of the remote,
   lowercased, non-alphanumerics → `-`). If there's no remote, use the current
   directory name.

3. **Compose the checkpoint** as a single JSON object matching this schema. Be
   concrete and specific to *this* session; write in en-AU. Shape the `summary`
   to the `checkpointDetail` level from step 1.

   ```json
   {
     "project": { "slug": "<derived-slug>" },
     "session": {
       "commit_hash": "<short hash>",
       "branch": "<branch>",
       "summary": "<what was done and the current state>",
       "current_phase": "<short label, <8 words>",
       "in_progress": ["<things mid-flight right now>"],
       "next_up": ["<the suggested next moves, imperative>"],
       "working_well": ["<things paying off / worth keeping>"],
       "blockers": ["<anything unresolved or blocking>"],
       "tags": ["<up to 4 short lowercase labels>"]
     },
     "extract": {
       "bugs": [{ "title": "<bug found/introduced>", "severity": "critical|high|medium|low" }],
       "next_steps": [{ "title": "<concrete follow-up>", "priority": "must|should|could|wont" }],
       "futures": [{ "title": "<directional idea for later>", "note": "<why it might matter>" }]
     }
   }
   ```

   Leave any list empty (`[]`) when there's nothing real to put in it — do **not**
   invent bugs, next-steps or futures. Auto-extracted items dedupe by title
   fingerprint, so don't restate ones already tracked.

   `futures` vs `next_steps`: a next-step is concrete work someone could start
   tomorrow; a future is a **directional idea** worth curating later ("could
   become a review platform", "consider a public read-only mode"). If the
   session's SessionStart block showed a **North star**, align `next_up` with it
   and use `futures` for ideas that would bend the direction.

4. **Post it.** Pipe the JSON straight to the poster — it reads the token from
   `~/.stack/env` itself, so **never print, echo or paste the token**:

   ```bash
   cat <<'JSON' | node ~/.stack/stack-checkpoint.mjs
   { ...the JSON object you composed... }
   JSON
   ```

   The poster sets `authored: true` and fills the commit/branch from git if you
   omit them. On success it prints `checkpoint saved for <slug> @ <hash>` to
   stderr. Tell the user it's checkpointed; if it failed, relay the short error.

$ARGUMENTS
