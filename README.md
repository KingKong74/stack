# Stack

A self-hosted command centre for your side projects. Open it and instantly know where every
project stands — the signature element is a **"pick up where you left off"** resume card that
removes the friction of re-loading context when you jump between projects.

Each project tracks its live site, repo, deploy status, an auto-generated **activity feed**
(one summary per session/push), a **bug tracker**, a **MoSCoW roadmap**, and freeform
**sticky notes**. Two screens: a cover-forward **projects dashboard** and a five-tab
**project detail** (Overview · Bugs · Roadmap · Notes · Activity).

The dashboard opens with a **cross-project command deck** — a console that glances across everything:
a resume hero (the one project to jump back into), a quiet attention row (**Blocked · Stale · Bugs**
that stays calm at zero and gets loud only where something needs you), and a merged recent-activity
stream. It's calm when all's well, and every item clicks straight through to the project. The grid of
all projects sits below it.

A push does more than feed the resume card: the SessionEnd hook **auto-extracts candidate bugs
and next-steps** into the trackers, and the dashboard **progress bar is computed** from
roadmap/bug completion — never set by hand.

The UI is a faithful build of the Atlas design handoff. Product name is **Stack** — it's a single
constant (`web/src/lib/ui.ts` → `PRODUCT_NAME`) if you ever want to change it.

## Repo layout

```
stack/
  web/        Vite + React + TypeScript frontend (the dashboard + detail UI)
  server/     Express + Postgres API (ingest + projects + collections)
  hook/       Claude Code hooks + the /checkpoint poster (no external API):
              SessionStart injects "where you left off"; SessionEnd posts a metadata
              backstop; stack-checkpoint.mjs posts Claude-authored /checkpoint JSON;
              stack-post.mjs is the shared lib
  templates/  stack-agent-context.md — portable operating manual for a fresh agent
  scripts/    stack-context.mjs — prints that template (optionally stamped) to stdout
  .claude/commands/checkpoint.md — the /checkpoint slash command (install to ~/.claude/commands/)
  docker-compose.yml   db + server + web, for the mini-PC deploy
```

## Current state

- **The app runs against the live API.** Persistence is Postgres, reached entirely through one
  module, `web/src/store.ts` (every function is async and calls `/api/*` with a bearer token).
  There is no localStorage data layer any more — the API is the source of truth.
- **A first-load token gate** asks for the shared API token, keeps it in `localStorage`, and sends
  it on every request. Any `401` clears it and returns to the gate.
- **The ingest loop is complete:** a push upserts the project, records the session/activity row,
  refreshes the resume fields (COALESCE so a thin checkpoint never wipes a good summary), and lands
  auto-extracted bugs + roadmap items (deduped by fingerprint, tombstoned on delete, never touching
  manual items).
- **The round-trip is closed:** a SessionStart hook injects a concise "where you left off" block at
  the top of a new session, so the next session opens already knowing the state the last one left.
- **The detail screen is hands-on:** the Visit-site and Repo buttons open the project's URLs (and let
  you set them inline when unset), notes are editable in place and can be promoted to a bug or roadmap
  item, and a project can be deleted (cascading its sessions, bugs, roadmap and notes).
- **The command deck glances across everything:** a single server-side aggregate (`GET /api/overview`,
  four queries, never one-per-project) backs the dashboard deck — resume hero, Blocked/Stale/Bugs
  attention row, and a merged activity stream. A project counts as **stale** once a live/building
  project's last push is older than a threshold; that threshold is one constant, `STALE_DAYS` in
  `server/src/util.js` (default 14) — change it there and the deck follows.
- **Directives steer sessions from the dashboard:** each project has a standing instruction list
  (detail → Overview → Directives). Whatever's there is injected **first** into every session
  start — "ship the token gate, don't touch ingest" — so you redirect agents without opening a
  terminal. Lines stay until you remove them; the exported resume brief echoes them too.
- **Live-now presence:** the deck shows which projects have a Claude session open right now (and on
  which branches — parallel worktree sessions each count). The SessionStart hook pings, an authored
  `/checkpoint` proves liveness, SessionEnd clears, and a TTL ages out crashed sessions.
- **A Futures tab curates direction:** each project can carry a **north star** — one paragraph on
  what it's becoming, injected into every session start so all agents pull the same way — plus an
  idea funnel: loose "could become…" ideas (yours, or extracted from checkpoints via
  `extract.futures`) that you promote into the roadmap when they firm up, or dismiss.
- **A review inbox keeps you looped in:** everything the hooks auto-extract lands in a
  **Needs review** queue on the deck until you look at it — **Keep** approves it into its tracker,
  **Dismiss** deletes it and tombstones the fingerprint so the next push won't re-create it.
  Approval is sticky across pushes; the block disappears entirely at zero.
- **A ⌘K command palette** searches across everything — project names, bug titles, roadmap items,
  notes and activity summaries — grouped by kind, fully keyboard-driven, and every result jumps
  straight to its project tab with the item highlighted (`GET /api/search`).
- **A scoped Settings screen** (from the avatar) controls how Stack records your work: automatic
  recording, the resume card, the authored-summary detail level, and whether chore-only sessions count
  (`GET|PATCH /api/settings`). Plus a masked token indicator, a connection test, and sign-out.
- **Checkpoints are Claude-authored — free, no external API.** Run `/checkpoint` to write a rich
  resume update; the SessionEnd hook records metadata automatically as a backstop so the activity feed
  never has gaps.

## Run the full stack (compose)

```bash
cp .env.example .env
# set POSTGRES_PASSWORD and API_TOKEN — generate a token with: openssl rand -hex 24
docker compose up -d --build
```

Open the web container (host **`WEB_PORT`**, default **8787**), paste your **API_TOKEN** into the
token gate, and you're in. nginx serves the static bundle and reverse-proxies `/api` to the server
container. Point your Cloudflare Tunnel / Tailscale at that host port.

Optional — drop in a couple of demo projects (off by default):

```bash
docker compose exec server npm run seed
```

## Run the frontend in dev

```bash
cd web
npm install
npm run dev      # http://localhost:5173
```

Vite proxies `/api` to `http://localhost:4000`, so you need the **server running** (compose, or
`cd server && npm install && npm run dev` with `DATABASE_URL` + `API_TOKEN` set). The app opens on
the token gate; paste the same `API_TOKEN` to continue.

## The hooks + /checkpoint (the round-trip)

Stack uses **no external AI API**. Rich resume summaries are authored by Claude itself via the
`/checkpoint` command (free); the hooks are zero-dependency, derive the project the same way (git
remote/branch, falling back to the directory name), load secrets from `~/.stack/env`, never print the
token, and always exit 0 so they can't block or delay Claude Code.

- **SessionEnd** — a clean **metadata backstop**. When a session ends it parses the transcript for the
  commit, branch, files touched, tools used, message count and the last substantive message, and POSTs
  that to `STACK_API/api/ingest` (as `authored:false`). It calls no external API. It's idempotent and
  COALESCE-safe: a metadata post **never overwrites** a richer authored checkpoint or the resume card
  for the same commit — it just guarantees the activity feed never has gaps. It honours the
  `auto_record` and `include_chores` settings (bounded, defaulting to on if the API is unreachable).
- **SessionStart** — asks `STACK_API/api/projects/:slug` for the project's current state and injects a
  concise "where you left off" block (resume summary, current phase, in-progress / next-up / blockers,
  open-bug count, and the last few activity entries) via the hook's `additionalContext` mechanism,
  nudging you to run `/checkpoint` when wrapping up. If the project isn't tracked yet or the API is
  unreachable, it emits nothing and gets out of the way.
- **`/checkpoint`** — the slash command you run when you finish a unit of work. It reads your settings
  (the `checkpoint_detail` level shapes how much the summary explains), derives the slug from the git
  remote, has Claude compose the full checkpoint schema (summary, phase, in-progress, next-up,
  working-well, blockers, tags, plus candidate bugs and next-steps for auto-extraction), and pipes
  that JSON to `~/.stack/stack-checkpoint.mjs`, which posts it (`authored:true`). The poster reads the
  token from `~/.stack/env` and never prints it.

Install on whichever machine runs Claude Code:

```bash
# 1. drop the hooks, the shared lib and the /checkpoint poster
mkdir -p ~/.stack && cp hook/stack-session-start.mjs hook/stack-session-end.mjs \
  hook/stack-post.mjs hook/stack-checkpoint.mjs ~/.stack/

# 2. install the /checkpoint slash command
mkdir -p ~/.claude/commands && cp .claude/commands/checkpoint.md ~/.claude/commands/

# 3. create ~/.stack/env  (this file holds the secrets; never commit it)
cat > ~/.stack/env <<'ENV'
STACK_API=https://stack.your-domain
STACK_TOKEN=the-same-value-as-API_TOKEN
ENV

# 4. merge hook/settings.snippet.json into ~/.claude/settings.json
#    (it registers both SessionStart and SessionEnd)
```

Test without a real session (the end hook fires its metadata backstop; the start hook prints the block
it would inject; the poster can author a checkpoint or print the current settings):

```bash
node ~/.stack/stack-session-end.mjs --demo
node ~/.stack/stack-session-start.mjs --demo
node ~/.stack/stack-checkpoint.mjs --settings
echo '{"project":{"slug":"stack"},"session":{"summary":"Quick manual checkpoint."}}' | node ~/.stack/stack-checkpoint.mjs
```

## Set up a new project (and get Claude connected)

One-time machine setup first (hooks + `~/.stack/env` + `/checkpoint` — the section above). After
that, connecting a project is mostly automatic:

1. **Just start working.** Open Claude Code in the project's repo and do a unit of work. The slug is
   derived from the git remote (`owner/repo` tail, lowercased; falls back to the directory name if
   there's no remote), so there's nothing to register — **the first checkpoint or session-end post
   creates the project in Stack**, assigns it a tint, and fills the repo URL.

2. **Run `/checkpoint` when you wrap up.** That's what makes the resume card rich — the summary,
   current phase, in-progress / next-up / working-well / blockers, and candidate bugs + next-steps
   for the trackers. (If you forget, the SessionEnd hook still records a metadata backstop, so the
   activity feed never has gaps.)

3. **Give the project's agents the manual** (optional but recommended). Stamp the portable
   operating manual into the project's `CLAUDE.md` so any fresh session knows how Stack works, that
   the injected "where you left off" block is trustworthy, and how to read live state from the API:

   ```bash
   node scripts/stack-context.mjs --slug <project-slug> --api https://stack.your-domain >> /path/to/project/CLAUDE.md
   ```

4. **Dress the card in the UI.** Open the project in Stack and set the subtitle, site URL and
   status (the repo URL will already be filled from the first push; a hand-set value is never
   overwritten by ingest).

5. **Verify the round-trip** from the project's directory:

   ```bash
   node ~/.stack/stack-session-start.mjs --demo   # prints the "where you left off" block Claude will see
   node ~/.stack/stack-checkpoint.mjs --settings  # confirms the poster can reach the API + token works
   ```

Troubleshooting: a **401** means `STACK_TOKEN` in `~/.stack/env` doesn't match the server's
`API_TOKEN`; a silent SessionStart just means the project has no checkpoints yet or the API was
unreachable (the hooks never block); `Cannot find module ~/.stack/stack-checkpoint.mjs` means the
install step above wasn't run on this machine (it copies **four** files — the two hooks,
`stack-post.mjs` and the poster).

## The agent-context template

`templates/stack-agent-context.md` is a portable operating manual a fresh Claude session can load to
understand how to work with your projects through Stack — that state is auto-managed by the hooks (so
trust the injected block), how to read live state from the API, the bearer-auth model, and the house
rules. It's the single source of truth; if the API or hook contract changes, update that file.

Export it (optionally stamped with a project's slug and your API base) and pipe it where you want it:

```bash
node scripts/stack-context.mjs                                  # the generic template
node scripts/stack-context.mjs --slug stack --api https://stack.your-domain
node scripts/stack-context.mjs --slug stack >> path/to/project/CLAUDE.md
node scripts/stack-context.mjs --api https://stack.your-domain >> ~/.claude/CLAUDE.md
```

## Conventions

- en-AU spelling throughout.
- No secrets in the repo. Secrets load at runtime from `.env` (server) and `~/.stack/env` (hook).
- `web/src/store.ts` is the only module that touches the network — keep it that way.
