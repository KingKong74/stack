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
  hook/       Claude Code hooks — SessionStart injects "where you left off",
              SessionEnd posts a checkpoint + extraction package per session
  templates/  stack-agent-context.md — portable operating manual for a fresh agent
  scripts/    stack-context.mjs — prints that template (optionally stamped) to stdout
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

## The hooks (the round-trip)

Two zero-dependency Node hooks close the loop. Both derive the project the same way (git
remote/branch, falling back to the directory name), load secrets from `~/.stack/env`, never print
the token, and always exit 0 so they can't block or delay Claude Code.

- **SessionEnd** — when a session ends, captures the current commit (short `rev-parse`), parses the
  transcript, and — if `ANTHROPIC_API_KEY` is set — asks a cheap model for a structured summary
  **plus** the resume sub-lists, a couple of tags, candidate bugs and prioritised next-steps. It
  POSTs that package to `STACK_API/api/ingest`. Without an API key it falls back to the last-message
  summary and empty extraction lists.
- **SessionStart** — when a session starts or resumes, asks `STACK_API/api/projects/:slug` for the
  project's current state and injects a concise "where you left off" block (resume summary, current
  phase, in-progress / next-up / blockers, open-bug count, and the last few activity entries) using
  the SessionStart hook's `additionalContext` mechanism. If the project isn't tracked yet or the API
  is unreachable, it emits nothing and gets out of the way.

Three-step install on whichever machine runs Claude Code:

```bash
# 1. drop both hook scripts
mkdir -p ~/.stack && cp hook/stack-session-start.mjs hook/stack-session-end.mjs ~/.stack/

# 2. create ~/.stack/env  (this file holds the secrets; never commit it)
cat > ~/.stack/env <<'ENV'
STACK_API=https://stack.your-domain
STACK_TOKEN=the-same-value-as-API_TOKEN
# optional — enables structured AI summaries + extraction instead of a raw last-message fallback:
ANTHROPIC_API_KEY=sk-ant-...
ENV

# 3. merge hook/settings.snippet.json into ~/.claude/settings.json
#    (it registers both SessionStart and SessionEnd)
```

Test them without a real session (the end hook fires a synthetic checkpoint with a demo bug +
next-steps; the start hook prints the block it would inject for the current repo):

```bash
node ~/.stack/stack-session-end.mjs --demo
node ~/.stack/stack-session-start.mjs --demo
```

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
