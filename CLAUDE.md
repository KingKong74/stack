# CLAUDE.md — working notes for Stack

Context for any Claude (or human) picking this repo up in a terminal. Read this first.

## What Stack is

A self-hosted side-project command centre. The point is **frictionless resume**: open a project and
the "pick up where you left off" card tells you exactly where you were. A push also auto-extracts
bugs and next-steps into the trackers, and the dashboard progress is computed, not hand-set. Built
from the Atlas design handoff (colours, type, spacing, copy and interactions are intended to match).

## Architecture

```
web/    Vite + React 18 + TS (strict). Hash-routed, two screens. Persistence is the Postgres API,
        reached ONLY through src/store.ts (every function async, bearer-token auth). Token gate on
        first load; any 401 clears the token and returns to the gate.
server/ Express + Postgres. Idempotent schema migrate on boot, retries first DB connect (survives
        compose start order). Bearer-token auth on every route except GET /api/health; fails closed
        if API_TOKEN is unset.
hook/   Two zero-dependency Node ESM hooks; both always exit 0 and never print the token.
        SessionEnd reads hook JSON on stdin, captures the commit, parses the transcript, optional
        Anthropic summary + extraction, POSTs to /api/ingest. SessionStart derives the project, GETs
        /api/projects/:slug and injects a "where you left off" block via additionalContext (emits
        nothing if the project is untracked or the API is unreachable).
templates/  stack-agent-context.md — the canonical portable agent manual (single source of truth).
scripts/    stack-context.mjs — prints that template to stdout, optionally stamped with slug + API.
```

### Frontend structure (`web/src`)
- `store.ts` — **the only module that touches the network.** Auth helpers (`getToken/setToken/
  clearToken/onAuthChange/verifyToken`) + async data calls: `getOverview` (the command deck),
  `getProjects`, `getProjectDetail`,
  `createProject/patchProject/deleteProject`, `getBugs/createBug/patchBug/deleteBug`,
  `getRoadmap/createRoadmapItem/patchRoadmapItem/deleteRoadmapItem`,
  `getNotes/createNote/patchNote/deleteNote`. `request()` attaches the bearer and throws `AuthError`
  on 401 (which clears the token).
- `types.ts` — Project, Bug, RoadmapItem, Note, Activity, Resume. Status is `live | building |
  paused | archived`. Bug/RoadmapItem/Note carry `source: 'hook' | 'manual'` (drives the "auto" cue).
- `components/TokenGate.tsx` — first-load token screen; `App.tsx` shows it whenever there's no token.
- `lib/ui.ts` — `PRODUCT_NAME`, label/colour maps, `isAccentTag`. `lib/route.ts` — hash router; the
  detail route is `#/p/<slug>[/<tab>]`, so `go.detail(slug, 'activity')` opens straight on a tab.
- `components/CommandDeck.tsx` — the cross-project deck at the top of the dashboard (resume hero,
  Blocked/Stale/Bugs attention row that goes calm at zero, merged activity stream). Renders the
  `getOverview()` payload; all click-throughs use `go.detail(slug, tab?)`.
- `screens/` Dashboard (loads projects + overview independently — a deck hiccup never blanks the
  grid; renders the deck above the "All projects" grid; status filters, computed progress on cards),
  ProjectDetail (loads project+activity+collections, owns tab/modal state, persists on mutate;
  initial tab comes from the route so the deck can deep-link to e.g. a project's Activity tab).
- `detail/` Overview, Bugs (auto cue), Roadmap (done toggle + auto cue), Notes (inline edit on the
  sticky; promote → bug/roadmap prefills the existing modal, then a keep/delete-the-note confirm),
  Activity. ProjectDetail also owns: the Visit-site/Repo buttons (open the URL, or inline-set it when
  unset via `patchProject`), and a quiet delete-project control behind a `ConfirmModal`.
- `components/` — `Modal`, `ConfirmModal` (delete / keep-or-delete), `BugModal`/`RoadmapModal`
  (both take an optional `initialTitle` for note promotion), `NewProjectModal`, `TokenGate`.
- `styles.css` — design tokens + component classes. Roadmap done/auto cues, token gate, note
  edit/promote, the confirm/danger controls and the status/severity/priority colour variants live
  near the bottom.

### Backend shape (`server/src`)
- `schema.sql` — idempotent (ADD COLUMN IF NOT EXISTS + convergent data migrations). Tables:
  - `projects` — + `subtitle, site_url, repo_url, tint, in_progress, next_up, working_well` (the
    jsonb fields are the resume sub-lists). Status default `building`; legacy `active` rows migrate
    to `live`. `repo` is the `owner/repo` identity; `repo_url` is the browseable URL the Repo button
    opens (filled once by ingest, never overwriting a hand-set value).
  - `sessions` — the activity feed. + `commit_hash`, `tags` jsonb.
  - `bugs` — `bug_key` (BUG-N per project), title, severity, status, `link_ref` (commit), `source`,
    `fingerprint`. Partial unique index on (project, fingerprint) WHERE source='hook'.
  - `roadmap_items` — `bucket`, title, note, `done`, `position`, `source`, `fingerprint`.
  - `notes` — text, `colour`, `source`.
  - `dismissed_items` — tombstones, keyed (project, kind `bug|roadmap`, fingerprint).
- `util.js` — `slugify`, `fingerprint` (title normalised: lowercased, punctuation + extra
  whitespace stripped), `relativeTime`, palettes, **`computeProgress` — the one documented progress
  model** (see below), and **`STALE_DAYS`** — the single knob for the command deck's stale threshold
  (default 14; the only place to change it).
- `shape.js` — row → client-shape mappers (bug/roadmap/note/activity/project).
- `routes/ingest.js` — `POST /api/ingest`: see the package + behaviour below.
- `routes/overview.js` — `GET /api/overview`: the cross-project command deck, computed in four
  aggregate queries (projects, bugs agg, recent sessions, week count) — never one-per-project. Shape
  documented below.
- `routes/projects.js` — list (computed progress), combined detail, create, extended PATCH, delete.
- `routes/{bugs,roadmap,notes}.js` — per-project collection CRUD, mounted under
  `/api/projects/:slug/...` (mergeParams).
- `seed.js` — optional `npm run seed`, NOT run on boot.

## The ingest package (what the hook sends)

```jsonc
{
  "project": { "slug": "stack", "name": "Stack", "repo": "owner/repo",
               "repo_url": "https://github.com/owner/repo" },
  "session": {
    "session_id": "…", "commit_hash": "6234a79", "branch": "main",
    "cwd": "…", "model": "…", "reason": "exit", "message_count": 12,
    "summary": "…", "current_phase": "…",
    "next_steps": ["…"], "blockers": ["…"],
    "in_progress": ["…"], "next_up": ["…"], "working_well": ["…"],
    "tags": ["backend", "in progress"],
    "files_touched": ["…"], "tools_used": ["…"]
  },
  "extract": {
    "bugs":       [{ "title": "…", "severity": "critical|high|medium|low" }],
    "next_steps": [{ "title": "…", "priority": "must|should|could|wont" }]
  }
}
```

Ingest, in one transaction: upsert the project by slug (first push creates it + assigns a tint by
cycling the palette, and fills `repo_url` once — `COALESCE(repo_url, …)` so a hand-set URL is never
overwritten); record the session, **idempotent on commit_hash / session_id** (re-running the
hook for the same push updates that row, never duplicates the activity); refresh the live resume
fields with COALESCE / keep-if-empty; then land extraction — each bug becomes an open bug with
`link_ref` = the commit (so the bug→activity chip resolves), each next-step a roadmap item in its
bucket (default `should`). Dedup by fingerprint: an existing auto item is re-pointed at the commit,
not duplicated; a fingerprint in `dismissed_items` is skipped; manual items are never touched.

## Progress model (`util.computeProgress`)

The single, tweakable definition of "how done is a project". Only Must/Should roadmap items count; a
done Must weighs double a done Should; `progress = doneWeight / totalWeight` as a 0–100 integer;
capped at 90% while any critical/high bug is open; 0% when there are no Must/Should items. Exposed on
every project payload (`progress`) and recomputed on the dashboard each load.

## The overview payload (`GET /api/overview` → the command deck)

The cross-project glance layer, computed server-side in four aggregate queries (never one-per-project):

```jsonc
{
  "resume":  { "slug": "…", "name": "…", "tint": "#…|null",
               "summary": "…", "currentPhase": "…", "nextUp": ["…"] },   // or null
  // resume = most-recently-touched live|building project (by last_session_at, not pin order),
  //          falling back to the most-recently-touched of any status; null if there are no projects.
  "blockers": [ { "slug": "…", "name": "…", "text": "…" } ],            // every stored blocker line, flat
  "stale":    [ { "slug": "…", "name": "…", "since": "2w ago" } ],      // live|building, last push > STALE_DAYS
  "bugs":     { "total": 3, "projects": [ { "slug": "…", "name": "…", "count": 2 } ] }, // open critical|high
  "activity": [ { "slug": "…", "name": "…", "hash": "…", "branch": "…",
                  "summary": "…", "tags": ["…"], "when": "just now" } ], // merged, newest first, ~12
  "totals":   { "byStatus": { "live": 0, "building": 3, "paused": 0, "archived": 0 },
                "openBugs": 4, "pushesThisWeek": 2 }
}
```

`stale` excludes paused/archived (dormant on purpose) and projects that have never pushed; the
threshold is the single constant `util.STALE_DAYS` (default 14). The deck loads independently of the
project grid on the dashboard, so an overview hiccup never blanks the grid.

## Routes (all behind bearer auth except GET /api/health)

- `POST /api/ingest` (also the source the SessionStart hook reads back via `GET /api/projects/:slug`)
- `GET /api/overview` (cross-project command deck — resume, blockers, stale, bugs, activity, totals)
- `GET /api/projects` · `POST /api/projects` · `GET /api/projects/:slug` (project + activity +
  collections + progress; the detail payload includes `blockers` for the start hook) ·
  `PATCH /api/projects/:slug` (subtitle, site_url, repo_url, status, pin, …) ·
  `DELETE /api/projects/:slug` (cascades sessions/bugs/roadmap/notes via FK `ON DELETE CASCADE`)
- `GET|POST /api/projects/:slug/bugs` · `PATCH|DELETE /api/projects/:slug/bugs/:bugKey`
- `GET|POST /api/projects/:slug/roadmap` · `PATCH|DELETE /api/projects/:slug/roadmap/:id`
- `GET|POST /api/projects/:slug/notes` · `PATCH /api/projects/:slug/notes/:id` (text) ·
  `DELETE /api/projects/:slug/notes/:id`

Deleting a `source='hook'` bug or roadmap item tombstones its fingerprint so the next push won't
re-create it.

## Conventions

- **en-AU spelling** everywhere.
- **No secrets in the repo.** `.env` (server) and `~/.stack/env` (hooks) are gitignored and load at
  runtime. The hooks never read tokens from the shell profile or settings.json, and never print them.
- Frontend is **strict TS** with `noUnusedLocals`/`noUnusedParameters` on — keep it clean.
- All persistence/network stays behind `store.ts`. Components never `fetch` or touch storage directly.
- Both hooks must **always exit 0** and log only to stderr — never block Claude Code start or stop.
- `templates/stack-agent-context.md` is the single source of truth for the portable agent manual; if
  the API or hook contract changes, update it (it's exported verbatim by `scripts/stack-context.mjs`).

## Gotchas

- `server` retries the first Postgres connection — don't "fix" that; it's what survives compose order.
- Ingest uses COALESCE / keep-if-empty on update so short/empty checkpoints don't overwrite a good
  summary. Preserve that property when extending.
- Ingest is idempotent on commit_hash / session_id; auto-extraction dedups on fingerprint and honours
  the tombstone table. Keep all three when touching ingest.
- The web Dockerfile is multi-stage (Vite build → nginx). nginx does SPA fallback **and** proxies
  `/api` to `server:4000` on the compose network. In local `npm run dev`, Vite proxies `/api` to
  `localhost:4000` instead (see `vite.config.ts`).
- Status vocabulary is `live | building | paused | archived`. The old `active` migrates to `live`.
- The SessionStart hook is registered **without** `async` (SessionEnd stays `async`): its
  `additionalContext` has to be captured synchronously to land in the session. It guards the API call
  with a short timeout and emits nothing on any miss, so it never delays startup.

## Quick commands

```bash
cd web && npm install && npm run dev     # frontend on :5173 (needs the server running)
cd web && npm run build                  # strict typecheck + production bundle
docker compose up -d --build             # full stack
docker compose exec server npm run seed  # optional demo projects (off by default)
node hook/stack-session-end.mjs --demo     # fire a synthetic checkpoint + extraction
node hook/stack-session-start.mjs --demo   # print the "where you left off" block for this repo
node scripts/stack-context.mjs --slug stack --api https://stack.your-domain  # export agent manual
```
