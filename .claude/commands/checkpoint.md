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
       "built": [{ "item": 381, "note": "<what actually landed, where it lives, how it was verified>" }]
     }
   }
   ```

   Leave any list empty (`[]`) when there's nothing real to put in it — do **not**
   invent bugs. Auto-extracted items dedupe by title fingerprint, so don't
   restate ones already tracked.

   **`next_steps` AND `futures` ARE SWITCHED OFF — do not send either.** They
   filed a fresh held roadmap row per follow-up you named, which is how the
   board filled with ideas nobody had agreed to: a checkpoint proposing four
   next-steps opened four cards, every session, and an idea pipeline nobody
   empties makes the board look busy with work no one chose. The route still
   accepts them, so this is one edit away from coming back.

   **The follow-ups themselves are NOT lost, and this is the whole point of the
   change:** they go in `session.next_up` above, which is prose on the resume
   card. The next session reads them in its SessionStart block exactly as
   before — they simply stop becoming tracker rows that someone has to triage.
   Put the same sentences there that you would have put here.

   **`built` — the board row for what you just built.** Everything else in
   `extract` proposes work for later; this one records work that has landed.
   One entry per thing you actually built this session:

   - **Worked a roadmap item?** Send its id **and its title**:
     `{"item": 381, "title": "<that item's exact title>", "note": "…"}`. The note
     becomes that row's `built_note` — the account the human verdicts against in
     the Review room, so write two or three real sentences: what landed, where
     it lives, how it was verified.

     **Send the title. It is a safety check, not decoration.** Roadmap items and
     futures are separate id sequences and both are cited as `#N` everywhere, so
     `#174` is a roadmap item AND an unrelated future. If the title you send
     doesn't match the row that id points at, the entry is refused instead of
     obeyed — which is the only thing standing between a mistyped number and an
     overwritten `built_note` on somebody else's finished work. Only send an
     `item` id you have actually seen on the roadmap this session.
   - **Built something with no row at all?** Send a title instead:
     `{"title": "…", "note": "…", "bucket": "highest", "area": "terminal"}`. It
     attaches to a matching row if one exists, and only files a new one if
     nothing matches. (It used to name a ⚡ FLY card you had opened when you
     started; fly cards are off, so this is the usual case now.) This is the
     case that matters — a feature that ships with no row is a feature nobody
     can cite, review or find again.
   - It **never ticks the item.** The row lands as BUILT, not done, and goes to
     the Review room for the human's verdict. Ticking is theirs, not yours.
   - Leave `built` empty if this session built nothing — a refactor you reverted,
     a question answered, an investigation with no change.

   The poster prints a `built:` line to stderr saying what happened. If it
   reports **ids NOT on this board**, say so to the user: you cited a number
   that doesn't exist and that note was not written anywhere.

   If the session's SessionStart block showed a **North star**, align `next_up`
   with it — that list is now the only place a suggestion for later lands, so it
   is worth writing properly rather than as a stub.

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
