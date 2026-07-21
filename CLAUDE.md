# CLAUDE.md — working notes for Stack

Context for any Claude (or human) picking this repo up in a terminal. Read this first.

## What Stack is

A self-hosted side-project command centre. The point is **frictionless resume**: open a project and
the "pick up where you left off" card tells you exactly where you were. A push also auto-extracts
bugs and next-steps into the trackers, and the dashboard progress is computed, not hand-set. Built
from the Atlas design handoff (colours, type, spacing, copy and interactions are intended to match).

## Architecture

```
web/    Vite + React 18 + TS (strict). Hash-routed, three screens (dashboard, project detail,
        settings) + a global ⌘K command palette. Persistence is the Postgres API, reached ONLY
        through src/store.ts (every function async, bearer-token auth). Token gate on first load;
        any 401 clears the token and returns to the gate.
server/ Express + Postgres. Idempotent schema migrate on boot, retries first DB connect (survives
        compose start order). Bearer-token auth on every route except GET /api/health; fails closed
        if API_TOKEN is unset.
hook/   Zero-dependency Node ESM. stack-post.mjs is the shared lib (env load, git derivation,
        settings fetch, POST to /api/ingest) imported by both:
        • stack-session-end.mjs — the SessionEnd hook. A pure METADATA backstop: parses the
          transcript for commit/branch/files/tools/message-count + the last substantive message and
          POSTs that (authored:false). Calls NO external API. Always exits 0. Honours auto_record /
          include_chores. Idempotent + COALESCE-safe (never clobbers an authored checkpoint).
          Clears the session's presence row first (POST /api/presence/end) — before any gate, so
          even skipped sessions stop showing as live.
        • stack-session-start.mjs — the SessionStart hook. GETs /api/projects/:slug and injects a
          "where you left off" block via additionalContext (nothing if untracked/unreachable),
          including the project's **north star** when set, the app-wide **session defaults**
          (standing preference lines from Settings, rendered server-side onto the detail payload)
          and any **directives** (the standing steer list from the dashboard) — defaults then
          directives, injected first above everything else; nudges
          /checkpoint when wrapping up. Also fires a live-now **presence ping**
          (POST /api/presence) in parallel with that fetch — same timeout budget, silent on any
          failure, 404 for untracked projects.
        • stack-checkpoint.mjs — the /checkpoint POSTER (not a hook). Reads a checkpoint JSON on
          stdin and POSTs it (authored:true); `--settings` prints current settings. Installs to
          ~/.stack/ alongside the hooks + stack-post.mjs.
terminal/  The web terminal's host-side daemon (#/terminal). stack-term.mjs (npm deps: `ws` + `meow` —
        no native modules; `meow` adds a proper CLI interface with --help and type-safe flags) spawns a real
        login shell or `claude` in a directory jailed to
        STACK_TERM_ROOT (default $HOME), via pty-shim.py (python3 stdlib owns the PTY + resize,
        since the host has no build toolchain for node-pty). The host firewall drops
        container→host traffic, so the daemon dials OUT: one persistent ws to the server's
        /term-agent (bearer = STACK_TOKEN from ~/.stack/env, reconnect with backoff); the server
        relay (server/src/term.js, attached to the same HTTP server as the API) validates each
        browser session's token (both credential classes) BEFORE bridging and strips it — the
        daemon never sees browser credentials. nginx proxies /term* → server:4000 with upgrade
        headers. Runs from crontab (@reboot line); log ~/.stack/term.log. Frames are JSON with
        base64 data, multiplexed by sid over the agent socket. usage-meter.mjs (stdlib-only) tails
        today's real Claude token usage incrementally from ~/.claude/projects transcripts (deduped
        per message id, day-rollover safe); the daemon pairs it with a limit watch on each pty
        stream (ANSI-stripped rolling tail, the autopilot's own limit/reset patterns, +4h when the
        reset time won't parse) and broadcasts `usage` frames — tokens, resetAt/resetLabel and a
        HOST-local one-off calendar slot just past the reset — per live session every 15s, on
        ready and on limit sight; the relay forwards them like output. The relay also serves
        /term-status (#121): any signed-in tab watches ({t:'watch', token} first frame, same
        credential classes) and gets {t:'status', active, count} on connect and on every session
        start/end — the push channel behind the app-wide terminal presence pill; no polling.
        Claude sessions run inside named `stack-term-*` tmux sessions (#171/#188, when tmux is
        installed — direct spawn otherwise): a browser disconnect only detaches, the process
        keeps running. The start frame may carry `skipPerms: true` (a boolean the daemon maps to
        its one allow-listed flag, `--dangerously-skip-permissions` — no path for arbitrary args). The daemon advertises EVERY `stack-term-*` tmux session (`detached`
        frames — on connect, session start/end and a 60s tick), each entry carrying an
        `attached` flag (a client holds it elsewhere — another browser, or a laptop over ssh via
        `stack term`; attaching again just mirrors it, tmux fans one session out to every
        client) and a `tmux capture-pane` tail so the Gemini labeller can name unattended
        sessions. The relay caches the list (labels held name-keyed across re-pushes) for
        GET /api/terminal/detached and forwards browser kill requests (`killDetached`) back —
        only names actually detached are killable. The relay also notes each claude tab's tmux
        name from the ready frame, so Mission Control's session chips can deep-link an attach.
        tmux sessions run with `mouse on` (set server-wide by `sessionArgv`'s command sequence):
        tmux repaints a fixed viewport so the outer xterm never accumulates scrollback — mouse
        mode makes the wheel scroll tmux's own history instead.
templates/  stack-agent-context.md — the canonical portable agent manual (single source of truth).
scripts/    stack-context.mjs — prints that template to stdout, optionally stamped with slug + API.
            stack-tree.mjs — the branch navigator, phase 1 (`stack tree` via the root `stack`
            dispatcher, or `node scripts/stack-tree.mjs`): renders a repo's branch-and-idea
            structure as one textual tree — main as the trunk, autopilot lanes (auto/item-N) and
            idea branches (idea/*) hanging off it, other branches grouped, absorbed branches
            folded back into the trunk (ahead 0 while the trunk has moved on; ahead 0/behind 0 =
            freshly cut, stays an open lane). Reads git only (local + origin refs, deduped
            local-first) — no API, no key, no extra persistence. Every node carries a
            `geminiTake` slot rendered as a placeholder until the stored per-push gemini_note is
            wired in (a later phase, like promote/park/prune from the tree); empty lane/idea
            groups render example placeholder nodes so the intended shape is always visible.
            `--json` emits the underlying model; `--repo <path>` reads another checkout.
            stack-sessions.mjs — automation sessions from the terminal (#115):
            `stack start-session [<slug>] [--item N]` queues a manual autopilot job via the
            same POST /api/autopilot/start as Mission Control's ▶ Run now (slug derived from
            the cwd's git remote when omitted; an already-open session is reported as such,
            never as a fresh start) and prints the session ID; `stack list-sessions [<slug>]
            [--limit N] [--json]` (alias `sessions`) renders the job queue from
            GET /api/autopilot/jobs. Token from ~/.stack/env, never printed; bad/missing
            arguments error out before anything is queued. The root `stack` dispatcher
            resolves each command to a script export (`fn`) and awaits async mains.
            stack-autopilot.mjs — the overnight autopilot (phase 2): works MULTIPLE eligible
            roadmap items per night (must→should; open, unclaimed, not skipped, human-approved;
            up to --max-items, default Settings' autopilotMaxItems) inside a shared night
            budget — the wall-clock cap (Settings' autopilotMinutes) AND a token budget
            (--tokens / STACK_AUTOPILOT_TOKENS override; default Settings' autopilotTokens,
            **0 = unlimited** — the wall clock alone governs) metered from each session's real
            usage via `claude -p --output-format json`. **Dual-model sessions** (#153): the
            session runs on Settings' autopilotExecutorModel (`claude --model`; '' = the CLI's
            default) and, when autopilotAdvisorModel is set, a stronger ADVISOR is exposed to
            it as a read-only custom subagent (`claude --agents`, tools Read/Grep/Glob) the
            executor consults — an ordinary Agent tool call — for the build plan, unblocking
            and a pre-finish sanity check; the night log states both roles and logs the
            session's per-model usage breakdown (`--executor-model`/`--advisor-model`
            override). `--item N` pins a run to exactly that
            roadmap item in any bucket (done/claimed still refuse) — how scheduled + Run-now
            jobs target one thing. A project's `autopilot_area` (#122, the Mission Control
            target picker; '' = whole board) filters the normal pick to one product area —
            --item pins bypass it. Per item: claim the lane, Gemini spec pre-pass (free tier — expands
            title/note into goal/acceptance/out-of-scope; keyless = silently spec-less; a
            refine_note item SKIPS it — the refinement is the spec, and the prompt says what
            landed before and to change only the delta, #146), an
            unattended session in a fresh worktree on branch auto/item-N (never main), push,
            `built_note` stamped on the item (so the Reviews view shows what landed), a checks
            run + Gemini diff review (→ review inbox) — then the next item while budget remains.
            The claim stays until the human merges + ticks the item (that's the don't-re-pick
            marker); a no-commit run releases it. Both the global arm switch AND the project's
            automode flag must be on. Every item attempt lands as a row in `autopilot_runs`
            (POST /api/projects/:slug/autopilot/runs) — the deck's "While you were away" digest
            and the run-history panel read from it. A session that dies on the usage limit
            closes the night GRACEFULLY: the run row says `limit`, pushed branches keep their
            claims, and the runner queues its own resume as a DURABLE `resume` job (#142 —
            POST /api/autopilot/resume, held via `not_before` until just past the reset, parsed
            from the message else +4h; a pinned --item run keeps its pin). The job survives
            reboots and shows on Mission Control + the Terminal, where a human can ▶ Resume now
            (clears the hold — the dispatcher then runs it --force like a manual press), ⏸ Hang
            up (status `paused` — parked until resumed by hand) or × dismiss it; an auto-fired
            resume (hold intact) keeps the arm-switch + automode gates. Only when the API can't
            take the job does the old detached-sleep fallback fire.
            Night end fires an ntfy.sh notification when STACK_NTFY_TOPIC is set in
            ~/.stack/env (free, keyless; unset = silent). Lockfile ~/.stack/autopilot.lock; log
            ~/.stack/autopilot.log. `skipped` items are how you keep human-only work off its plate.
            stack-autopilot-dispatch.mjs — the every-minute cron line (the master on/off
            switch). Polls GET /api/autopilot/next with the HOST's local clock (the server
            can't reach the host — same dial-out pattern as the terminal daemon); the server
            lazily enqueues due work — the armed nightly at Settings' autopilotTime per
            automode project, due Mission Control calendar rows, manual ▶ Run now presses —
            and hands out at most ONE job at a time. The dispatcher runs it (repo resolved as
            $STACK_AUTOPILOT_ROOT/<slug>, default $HOME) and PATCHes the outcome back.
            Manual/scheduled jobs run with --force (explicit human config beats the arm
            switch + automode); nightly keeps both gates. `revert` jobs (#128 — the Reviews
            view's ⎌ Undo) are handled by the dispatcher itself, not the runner: revert every
            main commit tagged #<itemId> (last 400, digit-safe match) in a throwaway worktree,
            push the revert commits, un-tick the item (which clears verdict + claim). `merge`
            jobs (#154 — Mission Control's ⇥ Merge) too: fetch, merge --no-ff origin/<branch>
            into main in a throwaway worktree, push, delete the remote branch; conflicts abort
            + report failed, and the item is NEVER ticked (the human disposes). The dispatcher
            also pushes the **branch report** (#207) every ~10 min (stamp file
            ~/.stack/branch-report.stamp): per repo it can find, fetch --prune then every
            origin branch's ahead/behind vs origin/main, a `git merge-tree --write-tree`
            conflict probe (null when git <2.38) and the item id parsed from the lane name,
            POSTed to /api/projects/:slug/branches — the git truth behind the merge strip.
            Silent when idle or the API is unreachable (fail safe). A missed slot stays missed
            (90-min grace, clamped at midnight) — like the old fixed cron line, but the time
            is now a setting.
.claude/commands/checkpoint.md — the /checkpoint slash command (documented for install to
            ~/.claude/commands/). Tells the session to author the full checkpoint schema and pipe it
            to ~/.stack/stack-checkpoint.mjs (token read from ~/.stack/env, never printed).
```

### Frontend structure (`web/src`)
- `store.ts` — **the only module that touches the network.** Auth helpers (`getToken/setToken/
  clearToken/onAuthChange/verifyToken`) + async data calls: `getOverview` (the command deck),
  `getSearch` (the ⌘K palette), `getSettings/patchSettings`, `getProjects`, `getProjectDetail`,
  `createProject/patchProject/deleteProject`, `getBugs/createBug/patchBug/deleteBug`,
  `getRoadmap/createRoadmapItem/patchRoadmapItem/deleteRoadmapItem`,
  `getFutures/createFuture/patchFuture/deleteFuture`,
  `getNotes/createNote/patchNote/deleteNote`. `request()` attaches the bearer and throws `AuthError`
  on 401 (which clears the token).
- `components/CommandPalette.tsx` — the global ⌘K palette. Centred modal over a dimmed/blurred
  backdrop: debounced query, scope chips (All/Bugs/Roadmap/Notes/Activity with counts), grouped
  results with kind icons, the matched term marked in terracotta, full keyboard control (⌘K toggles,
  ↑↓ across groups, ↵ opens → `go.detail(slug, tab, highlight)`, esc closes), focus trap + restore,
  reduced-motion respected. Opened from the dashboard/detail search box or ⌘K anywhere (state lives
  in `App.tsx`).
- `screens/Settings.tsx` — the Settings screen (reached from the avatar / `#/settings`). Sections:
  **Push summaries** (the cream card — switches + Brief/Standard/Detailed segmented control,
  optimistic with rollback), **Session defaults** (switches over the `DIRECTIVES` catalogue from
  `lib/brief.ts` — app-wide standing preferences PATCHed as `sessionDefaults` and injected into
  every session by the start hook, e.g. commits pre-authorised), **Autopilot** (the overnight
  runner's arm switch + 1h/2h/3h session cap — the cron no-ops while disarmed), **Terminal**
  (device-local like Appearance: opens-with Claude/Shell seg + the skip-permissions switch,
  `store.getTermSessionPrefs/setTermSessionPrefs`), **Appearance**
  (theme) and **Access** (masked token, Test connection, the **access PIN** — set/change/disable;
  any change signs out all PIN-connected devices — and Sign out). Uses `getSettings/patchSettings`;
  a 401 anywhere returns to the gate. The TokenGate offers "Sign in with a PIN instead"
  (`store.loginWithPin` → POST /api/auth/login → this browser's own device token).
- `types.ts` — Project, Bug, RoadmapItem, Future, Note, Activity, Resume. Status is `live | building |
  paused | archived`. Bug/RoadmapItem/Future/Note carry `source: 'hook' | 'manual'` (drives the
  "auto" cue).
- `components/TokenGate.tsx` — first-load token screen; `App.tsx` shows it whenever there's no token.
- `lib/brief.ts` — the exportable **resume brief**: `buildBrief(input, options)` renders a concise
  markdown template (status/phase/last push, session preferences, summary, in progress, next up,
  blockers, open bugs, open must/should roadmap deduped against next-up, working-well, recent
  pushes) and `downloadBrief` saves it as `<slug>-resume-brief.md`. Options: `compact` (efficiency
  mode — tighter caps, drops working-well) and `directives` — keys into the exported `DIRECTIVES`
  catalogue (reduce token usage, commit+push each unit, checkpoint on wrap-up, confirm big changes,
  verify before done) rendered as a "Session preferences" section. Pure formatting — data comes in
  via store.ts callers. Export buttons live on both "Pick up where you left off" cards (detail
  Overview + deck hero); both open `components/ExportBriefModal.tsx`, the curate-then-export step
  (Full/Compact seg control + preference switches, persisted device-local via
  `store.getBriefPrefs/setBriefPrefs`; the deck hero fetches `getProjectDetail` on confirm). Step 2
  is the **tinker view**: the generated markdown in an editable textarea with a token estimate
  (`estimateTokens`), a deterministic **Tighten** pass (`tightenBrief` — strips decoration + footer,
  no AI API), copy-to-clipboard and download.
- **Dark mode** — Settings → Appearance (System/Light/Dark, device-local via
  `store.getThemePref/setThemePref`; App resolves to `<html data-theme>`). The dark palette is one
  `[data-theme='dark']` override block on the same named tokens at the top of `styles.css`, plus a
  short list of literal-background fixups right below it. Stickies keep their paper colours.
- `screens/Control.tsx` — **Mission Control** (`#/control`, the Dashboard header's "Mission
  Control" button): every project's automation from one point. The autopilot console (arm switch
  + session cap up to 6h + **token budget incl. ∞ Unlimited** + **nightly start time** + items
  per night + the **Executor / Advisor model pickers** (#153 — which model runs the session
  and which stronger one it consults; Default/Off = single-model as before) — all PATCHed
  straight to settings, optimistic with rollback) over the **scheduled
  sessions card** (week-ahead strip + standing list: one-off / daily / chosen-days sessions per
  project, optionally pinned to one roadmap item — `store.createAutopilotSchedule` et al) and
  one row per project: automode toggle (`patchProject {automode}`), status, live presence, last
  push, **▶ Run now** (queues a manual job via `store.startAutopilot`; open jobs show as live
  queued/running/done chips, refreshed on a 30s tick), tonight's likely pick (deep-links to the
  roadmap item), last `auto/*` run, claim chips, review/serious-bug counts and blockers.
  The **merge strip** (#154, git-aware via #207): one chip per open branch — the host's branch
  report supplies real state (↑ahead/↓behind, ✓ merges clean / ⚠ conflicts with main, last
  subject on hover), claims the report hasn't seen fall back to plain chips, and a 🧹 count
  flags fully-merged origin branches never deleted; **⇥ Merge** (`store.queueMerge`) queues a
  `merge` job with a probe-known-conflict warning in the confirm modal.
  The **paused-sessions strip** (#142) sits above the recent-jobs chips: one ⏸ chip per
  limit-paused `resume` job showing its resume time, with **▶ Resume now**
  (`store.resumeAutopilotJob`), **⏸ Hang up** (`hangupAutopilotJob` — parks it until resumed
  by hand) and **× Dismiss** (`dismissAutopilotJob`); a project row with a held resume shows
  "resumes <time>" in place of ▶ Run now.
  The **running-sessions strip** (below the totals row) is one ▶ chip per terminal session —
  web-attached ones, detached tmux survivors AND sessions attached on another device (a laptop
  over ssh via `stack term`; deduped against the web chips by tmux name, `.away` green-dashed) —
  each a jump-in that opens `go.terminal(cwd, tmuxName)` (`#/terminal?cwd=…&attach=…`; the
  Terminal screen switches to the tab that already holds the session, re-attaches, or mirrors an
  attached one), wearing Gemini's label of what the session is doing: labelling fires
  automatically whenever unlabelled sessions appear (`labelTerminalSessions`, silent when
  keyless; ✧ Re-label re-asks by hand). The ⌨ Terminal button sits beside the screen's
  Settings / Mission Control tabs (`.tab-term`, in `Settings.tsx`), not in the totals row.
  Renders `getControl()`; automode projects sort first (`.mc-*` styles).
- `screens/Terminal.tsx` — the web terminal (`#/terminal[?cwd=<dir>][&attach=<tmux>]`,
  lazy-loaded so xterm.js stays out of the main bundle; a bare open — no cwd, no attach —
  resolves its auto-session cwd to the overview's resume slug, the most recently touched
  project, falling back to home on any miss; entry points on Mission Control — the strip's ⌨ Terminal button
  and a per-row ⌨ that prefills the project's slug as the cwd). xterm.js + fit addon over
  `store.openTerminal()` (the only place the ws transport + token live); Shell/Claude seg control,
  status line, reconnectable. The **usage strip** renders the daemon's `usage` frames: today's
  token count as a live bar against an editable device-local daily budget
  (`store.getTermUsagePrefs/setTermUsagePrefs`), the limit-reset time when a usage limit hits, and
  session booking around the reset — manual mode is a ▶ Book button, the auto-book toggle books
  the one-off Mission Control calendar slot itself (once per slot; project = the cwd's first
  segment, which IS the dispatcher's slug). The strip also shows the cwd project's **paused
  session** (#142) when one sits in the queue — a limit-hit `resume` job with its resume time
  and in-place ▶ Resume now / Hang up (polled via `store.getAutopilotJobs` while the screen
  shows, re-checked when a limit frame lands). **Detached sessions** (#188): a strip of ▶
  re-attach chips for claude sessions still running on the host with no browser attached
  (`store.getDetachedSessions`, refreshed when the screen shows and on live-count changes; ×
  kills the host process behind a ConfirmModal via `store.killDetachedSession`). A claude tab
  also remembers its tmux session name device-locally (`store.getTermTmuxName` et al, keyed by
  cwd) so a plain page reload re-attaches the same session automatically; an exit frame while
  attached — the process really ending — forgets the mapping. The screen auto-opens a session on
  arrival per the device's **Terminal prefs** (Settings → Terminal, `store.getTermSessionPrefs`:
  opens-with claude|shell, default claude; skip-permissions default on — sent as the start
  frame's `skipPerms` boolean). The quick-commands rail defaults COLLAPSED, its starter kit is
  essentials-only (git/compose/autopilot-log — deliberately NO claude commands: claude typed
  into a shell tab bypasses tmux persistence), and it hosts the **✧ command help**
  (`store.termAssist` → POST /api/terminal/assist): describe a goal, Gemini returns one command
  — ⌨ types it into the active session without Enter, + Save adds it to the quick commands.
- `lib/ui.ts` — `PRODUCT_NAME`, label/colour maps, `isAccentTag`. `lib/route.ts` — hash router; routes
  are `#/`, `#/settings`, `#/control`, `#/terminal`, and `#/p/<slug>[/<tab>][?hl=<x>]`. `go.detail(slug, tab, highlight)` opens
  straight on a tab and (via `hl`) flags an item — the tab disambiguates what `hl` means: a commit
  hash (activity), a bug key (bugs) or a row id (roadmap/notes). `go.settings()` opens Settings.
- `components/CommandDeck.tsx` — the cross-project deck at the top of the dashboard (resume hero,
  the **live-now strip** — green presence chips per project with branches and session count, gone
  when quiet — the **lanes strip** — ⚑ chips for open lane-claimed roadmap items, deep-linking to
  the item, gone when nothing's claimed — the **review inbox**, Blocked/Stale/Bugs attention row
  that goes calm at zero, merged activity stream). Renders the `getOverview()` payload; all click-throughs use `go.detail(slug, tab?)`.
  The review inbox (`ReviewQueue`) lists auto-extracted items no human has looked at yet:
  **Keep** = `patchBug/patchRoadmapItem {reviewed:true}` (stays in its tracker), **Dismiss** =
  the existing DELETE (tombstones the fingerprint); rows settle optimistically and the whole
  block disappears at zero. Titles deep-link via `go.detail(slug, tab, highlight)`.
- `screens/` Dashboard (loads projects + overview independently — a deck hiccup never blanks the
  grid; renders the deck above the "All projects" grid; status filters, computed progress on cards),
  ProjectDetail (loads project+activity+collections, owns tab/modal state, persists on mutate;
  initial tab comes from the route so the deck can deep-link to e.g. a project's Activity tab;
  the Bugs/Roadmap tab titles carry open-count badges).
- The detail payload carries `liveBranches` (presence rows inside the TTL): the board's
  in-progress lock (dim + read-only) only bites while an item's `claimed_by` matches a live
  branch — a stale claim keeps its ⚑ don't-re-pick chip but stays editable (BUG-2).
- `detail/` Overview (resume card, the **project-scoped review queue** — same Keep/Dismiss semantics
  as the deck inbox, computed client-side from the collections' `reviewed` flags — the **Directives
  card** (add/remove steer lines, persisted whole via `patchProject {directives}`) and the
  **editable Deployment panel** — status/platform/logs URL via `patchProject` — and the **editable
  Tech stack panel** — chips via `patchProject {tech_stack}`), Bugs (auto cue),
  Roadmap (the Board/Reviews switch sits above the content, left, full seg size (#129); + Add tops
  each column (#112); tick moves an item into the Reviews pipeline — still counted by
  progress; hover ✎/× edit + delete, edit reuses RoadmapModal in `mode='edit'` incl. the Lane
  field and the **Plan** editor (#75 — ordered `{text, done}` steps; the card wears a ☰ n/m
  progress chip and the autopilot works unticked steps top-down); open items show ⚑ claim chips;
  the **Reviews view** (#132/#117) clusters To-verify items under completion-day headers, labels
  every row with #id + an origin chip (⚙ autopilot — auto/* claim or a landed run — / ⚑ lane /
  by hand, with an origin filter when mixed) and the run-ledger chip (branch · commits · tokens ·
  cost, session summary on hover) via `store.getAutopilotRuns`; each To-verify row also has
  **✧ Brief** (#134 — Gemini's reviewer brief: what shipped, test steps, risks; in-memory),
  **⌨ Session** (opens a terminal in the project primed with the review — item, built_note and
  verify instructions ride the board's one-shot `stack.term.brief` handoff),
  **⎌ Undo** (#128 — confirm modal → `store.queueUndo` → a `revert` job the host dispatcher runs),
  toggleable **annotation chips** (#146 — Fix / Needs more / Polish / Question, PATCHed whole as
  `review_tags`; read-only in the archive), **＋ Bug / ＋ Audit** (#146 — prefill a bug ticket /
  an audit-area roadmap item referencing the row) and **⏸ Later** (#148 — shelves the review:
  PATCH `{review_shelved:true}` moves the row off the To-verify list into a collapsed **Shelved**
  strip below it — same row, same actions — and ▶ To review brings it back; the Reviews badge
  counts only the active list); Solid is the only pickable verdict — **✎ Refine**
  (#146, replacing #141's full-rework modal) takes just the delta: PATCH `{done:false, refine_note}`
  sends the item back as ITSELF (same id, built_note kept, verdict + claim cleared), the board card
  shows the pending ↻ refinement, and an optional checkbox queues a pinned autopilot session via
  `store.startAutopilot`), Futures (the **north star**
  — one editable paragraph on what the project is becoming, PATCHed as `north_star` and injected by
  the SessionStart hook — plus the idea funnel: loose ideas added/extracted, promote → prefills the
  RoadmapModal then a keep/delete-the-idea confirm, dismiss deletes + tombstones; ideas are
  editable in place, the composer takes "first line = idea, rest = why", and each idea carries an
  **alignment verdict** — ✦ Judge → On course / Tangent / Off course, pick the same to clear —
  which is how the list groups itself), Audit (`detail/Audit.tsx` — the dedicated testing +
  audit dashboard, moved out of the Bugs tab: a health header (pass rate, per-state counts,
  avg response, last run) over a **run-history trend strip** (each bar one Run-all, from the
  `check_runs` ledger via `store.getCheckRuns` — the tab's own fetch, refreshed when a run
  settles), a **failing-now callout** (every red test with its error, → Bug and re-run in
  place; gone at zero — the Audit tab badge counts these), the test suite (#143, named by
  #145 — HTTP tests
  against the live app: plain probes and function tests with a method picker + request body
  (JSON bodies sent as application/json), assertions on status / body keyword / a JSON dot-path
  value / a Gemini-judged expectation; Run all / run one, quick-add "Site up" from site_url,
  ✎ edit-in-place via `patchCheck` — editing anything but the name clears the stored result —
  failing tests offer "→ Bug" prefilled into the BugModal) and the ✧ Bug audit panel (#144 —
  Gemini + the Claude-prompt hand-off)), Notes (inline
  edit on the sticky; promote → bug/roadmap prefills the existing modal, then a
  keep/delete-the-note confirm), Activity. ProjectDetail also owns: the Visit-site/Repo buttons (open the URL, or inline-set it when
  unset via `patchProject`), and a quiet delete-project control behind a `ConfirmModal`.
- `components/TermStatusPill.tsx` — the global terminal presence pill (#121): mounted once in
  `App.tsx` so every open Stack tab shows when a web-terminal session is live anywhere. Fed by
  `store.watchTermStatus` (a small ws to the relay's `/term-status` — pushed on connect + every
  session start/end + detached-list change, 15s reconnect that reads as quiet while down). The
  status frame is claude-aware: `{active, count, claude, unattended}` — claude tabs outrank shells
  in the wording ("Claude session active"), and claude running on the host with NO client anywhere
  still shows ("Claude running unattended"), so a walked-away session is never invisible. Renders
  nothing at zero and on the Terminal screen itself; an anchor to `#/terminal` (middle-click opens
  a new tab; `.term-presence` styles, terracotta dot via `.claude`).
- `components/` — `Modal` (scrolls when tall), `ConfirmModal` (delete / keep-or-delete),
  `BugModal`/`RoadmapModal` (both take an optional `initialTitle` for note promotion; RoadmapModal
  also `initialNote` + `mode='edit'`), `NewProjectModal`, `TokenGate`, `ConnectGuide` (the in-app
  onboarding modal — Dashboard "Connect" button; steps stamped with `window.location.origin`, token
  never shown, plus the **parallel-lanes worktree playbook**), `ExportBriefModal`.
- `styles.css` — **the formal palette is the named CSS variables at the top of `:root`** (Atlas):
  neutrals (`--paper --surface --sand --keyline --muted --ink`), the terracotta accent ramp
  (`--accent-deep` hover · `--accent` · `--accent-soft` · `--accent-tint` · `--accent-tint-border`)
  and semantic tones (`--live --building --sage --critical --paused`). Every terracotta button hovers
  to `--accent-deep`. Supporting tokens below alias these (no value changes). Command palette
  (`.cmdk-*`), Settings (`.set-*`, `.switch`, `.seg-control`) and the search deep-link `.hl` rows
  live near the bottom, after the command-deck block.

### Backend shape (`server/src`)
- `schema.sql` — idempotent (ADD COLUMN IF NOT EXISTS + convergent data migrations). Tables:
  - `projects` — + `subtitle, site_url, repo_url, tint, in_progress, next_up, working_well` (the
    jsonb fields are the resume sub-lists), `north_star` (the direction paragraph — PATCHable,
    injected by the SessionStart hook, shown/edited on the Futures tab) and `directives` (jsonb
    list — the standing steer instructions, edited on the detail Overview's Directives card,
    injected FIRST by the SessionStart hook and echoed in the exported brief; lines stay until
    removed in the UI), `automode` (bool, default false — this project is open to the overnight
    autopilot; the runner refuses a project with it off, on top of the global arm switch; drives
    the ⚙ auto pill on dashboard cards and the click-toggle badge in the detail title row),
    plus `deploy_platform` + `logs_url` (the hand-edited Deployment panel) and
    `tech_stack` (jsonb — the hand-edited chips on the Tech stack panel). Status default `building`; legacy `active` rows migrate
    to `live`. `repo` is the `owner/repo` identity; `repo_url` is the browseable URL the Repo button
    opens (filled once by ingest, never overwriting a hand-set value).
  - `sessions` — the activity feed. + `commit_hash`, `tags` jsonb, `authored` bool (a rich
    /checkpoint vs the hook's metadata backstop; sticky — once true it stays true).
  - `settings` — single row (boolean PK = true, CHECK singleton). `auto_record`, `keep_resume_card`,
    `checkpoint_detail` (brief|standard|detailed), `include_chores`, `session_defaults` (jsonb list
    of catalogue keys — the app-wide standing session preferences, default `["ship"]` = commits
    pre-authorised; the catalogue lives in `settings.js` `SESSION_DEFAULTS`, keys mirror the web's
    `DIRECTIVES` in `lib/brief.ts`). Seeded once on migrate.
  - `bugs` — `bug_key` (BUG-N per project), title, severity, status, `link_ref` (commit), `source`,
    `fingerprint`, `reviewed_at`. Partial unique index on (project, fingerprint) WHERE source='hook'.
  - `roadmap_items` — `bucket`, title, note, `done`, `position` (PATCHable — the board is
    drag-reorderable and its order is the autopilot queue), `source`, `fingerprint`,
    `reviewed_at`, `area` (the product-area tag, mirroring `futures.area` — chips + filter on the
    board, set from the RoadmapModal's Area field with a datalist of the project's known areas),
    `built_note` (what actually landed — PATCHed by the completing session/agent alongside
    `done:true`, displayed on the Roadmap tab's **Reviews** view so verdicts are made against
    what was built; the agent template documents the protocol),
    `claimed_by` (the **lane claim** — which parallel session owns an open item;
    set via POST/PATCH, shown as a ⚑ chip, injected by the SessionStart hook as "Lane claims —
    respect these"; the agent template documents the claim-before-starting protocol) and
    `review_tag` (the **archive verdict**: solid | needs-work | rethink — set from the Archive's
    Review button; needs-work/rethink prefill a follow-up item back onto the board),
    `review_tags` (#146 — jsonb list of short review annotations, 'fix' / 'needs-more' / …,
    toggled as chips on To-verify rows), `refine_note` (#146 — the refinement delta: a refine
    sends the item back to the board as itself carrying just this instruction; the runner builds
    against it instead of a fresh spec) and `review_shelved` (#148 — the **review shelf**: a
    completed item set aside to review later, off the main To-verify list into the collapsed
    Shelved strip; cleared by `done` in either direction and by a real verdict, so a row is
    never both awaiting verification and shelved). A fresh completion (`done:true`) clears all
    three — each To-verify round starts unannotated, unshelved, and an addressed refinement
    retires.
  - `futures` — loose directional ideas: title, `note`, `source`, `fingerprint`, `reviewed_at`,
    `alignment` (the curation verdict against the north star: on-course | tangent | off-course,
    NULL = unsorted; PATCHable, '' clears; the Futures tab groups by it — on-course first,
    off-course last). Same dedup index and tombstone semantics as bugs/roadmap (kind `future`);
    promotion to the roadmap is a client flow (create the roadmap item, delete the idea).
  - `reviewed_at` (bugs + roadmap_items + futures) drives the **review inbox**: a hook-created item
    needs review while NULL; PATCH `{reviewed:true}` sets it (approve), DELETE dismisses (tombstone).
    Ingest's dedup re-point never touches it, so approving is sticky across pushes. Marking a
    roadmap item `done` also sets it (a human touch counts as review — archived items never
    linger in the inbox).
  - `notes` — text, `colour`, `source`.
  - `checks` — the Audit tab's test suite: HTTP tests against the project's live app. A row is
    a probe or a function test (#143): name, url, `method` (GET|POST|PUT|PATCH|DELETE|HEAD),
    `expect_status`, `req_body` (sent for non-GET/HEAD; JSON bodies as application/json), and
    the assertions — optional `contains` keyword, `json_path` + `json_expect` (dot path into a
    JSON response; empty expect = the path just has to exist) and the Gemini-judged `semantic`
    line — with the last result on the row (`last_status/code/ms/error/run_at`). Run on demand,
    bounded (8s), never scheduled.
  - `check_runs` — the Audit tab's run history: one summary row per POST /checks/run
    (scope all|one, total/passed/failed, duration_ms) — the dashboard's trend strip and
    last-run stat. Written best-effort after the checks save their results (an insert hiccup
    never fails the run); the autopilot's nightly checks run lands here too.
  - `dismissed_items` — tombstones, keyed (project, kind `bug|roadmap|future`, fingerprint).
  - `autopilot_schedule` + `autopilot_jobs` — Mission Control's calendar and the job queue the
    host dispatcher polls (see scripts/stack-autopilot-dispatch.mjs). Schedule rows: host-local
    `at_time`, one-off `run_date` or recurring `days`, optional pinned `item_id`, `enabled`.
    Jobs: kind manual|nightly|scheduled|revert|resume|merge, status queued|claimed|running|
    done|failed|paused; a partial unique index on (project, night_date) makes the nightly
    enqueue idempotent. `resume` jobs (#142) carry `not_before` — GET /next skips a queued job
    until its hold passes, and a `paused` (hung-up) job is never handed out at all.
  - `branch_reports` — the host dispatcher's git snapshot (#207), one row per project replaced
    whole every ~10 min: jsonb list of origin branches with ahead/behind vs main, the
    merge-tree conflict probe (`mergeClean` true|false|null) and the parsed item id, plus
    `reported_at`. Read only by the control payload — Mission Control's merge strip.
  - `presence` — live sessions, keyed (project, session_id). SessionStart upserts, an authored
    /checkpoint bumps `last_seen_at`, SessionEnd (and ingest's metadata backstop) deletes;
    liveness = within `util.PRESENCE_TTL_MINUTES` (default 240 — the crashed-session backstop,
    and the second single-knob constant alongside `STALE_DAYS`).
- `util.js` — `slugify`, `fingerprint` (title normalised: lowercased, punctuation + extra
  whitespace stripped), `relativeTime`, palettes, **`computeProgress` — the one documented progress
  model** (see below), and **`STALE_DAYS`** — the single knob for the command deck's stale threshold
  (default 14; the only place to change it).
- `shape.js` — row → client-shape mappers (bug/roadmap/note/activity/project). The detail shape also
  carries `keepResumeCard` (the global flag) so the detail Overview hides its resume card cleanly,
  and `sessionDefaults` (the rendered standing-preference lines) for the SessionStart hook.
- `settings.js` — the single-row settings: `readSettings(client?)` (accepts a txn client; defaults on
  failure) and `settingsShape` (row → client camelCase). Imported by ingest/overview/projects.
- `routes/ingest.js` — `POST /api/ingest`: see the package + behaviour below.
- `routes/overview.js` — `GET /api/overview`: the cross-project command deck, computed in seven
  aggregate queries (projects, bugs agg, recent sessions, week count, review inbox, presence,
  lane claims) — never one-per-project. Reads
  settings: when `keep_resume_card` is off, `resume` is null and `keepResumeCard:false` lets the deck
  drop the hero. Shape documented below.
- `routes/search.js` — `GET /api/search?q=…`: the ⌘K palette. Six capped ILIKE queries (projects,
  bugs, roadmap, futures, notes, activity); grouped results, each with kind, owning project, title,
  meta and a `{slug, tab, highlight}` target. Per-group + total caps; empty query → nothing.
- `routes/settings.js` — `GET|PATCH /api/settings`: the single-row settings (camelCase). Shape below.
- `routes/projects.js` — list (computed progress), combined detail, create, extended PATCH, delete.
- `routes/{bugs,roadmap,notes}.js` — per-project collection CRUD, mounted under
  `/api/projects/:slug/...` (mergeParams).
- `seed.js` — optional `npm run seed`, NOT run on boot.

## The ingest package (what /checkpoint and the hook send)

```jsonc
{
  "project": { "slug": "stack", "name": "Stack", "repo": "owner/repo",
               "repo_url": "https://github.com/owner/repo" },
  "session": {
    "session_id": "…", "commit_hash": "6234a79", "branch": "main",
    "cwd": "…", "model": "…", "reason": "exit", "message_count": 12,
    "authored": true,                  // true = rich /checkpoint; false = the hook's metadata backstop
    "summary": "…", "current_phase": "…",
    "next_steps": ["…"], "blockers": ["…"],
    "in_progress": ["…"], "next_up": ["…"], "working_well": ["…"],
    "tags": ["backend", "in progress"],
    "files_touched": ["…"], "tools_used": ["…"]
  },
  "extract": {
    "bugs":       [{ "title": "…", "severity": "critical|high|medium|low" }],
    "next_steps": [{ "title": "…", "priority": "must|should|could|wont" }],
    "futures":    [{ "title": "…", "note": "…" }]   // directional ideas → the Futures tab
  }
}
```

Ingest, in one transaction: upsert the project by slug (first push creates it + assigns a tint by
cycling the palette, and fills `repo_url` once — `COALESCE(repo_url, …)` so a hand-set URL is never
overwritten); record the session, **idempotent on commit_hash / session_id** (re-running for the same
push updates that row, never duplicates the activity); refresh the live resume fields; then land
extraction — each bug becomes an open bug with `link_ref` = the commit (so the bug→activity chip
resolves), each next-step a roadmap item in its bucket (default `should`), each future an idea on
the Futures tab. Dedup by fingerprint: an
existing auto item is re-pointed at the commit, not duplicated; a fingerprint in `dismissed_items` is
skipped; manual items are never touched.

**`authored` is what makes the metadata backstop safe.** A `/checkpoint` posts `authored:true` (rich);
the SessionEnd hook posts `authored:false` (metadata). The session-row update is COALESCE-safe: a
metadata post never overwrites an existing authored summary/current_phase, and the jsonb lists only
overwrite when non-empty — so the activity feed always has content but a thin post can't blank a rich
one. `authored` is sticky (`authored OR $incoming`). The project **resume refresh (step 3) runs only
for `authored:true` posts** (and only when `keep_resume_card` is on) — the metadata hook never touches
the resume card; it just records the activity row and bumps `last_session_at`.

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
  "presence": [ { "slug": "…", "name": "…", "count": 2,                  // live sessions now
                  "branches": ["main", "wt-x"], "seen": "5m ago" } ],
  "claims":   [ { "slug": "…", "name": "…", "lane": "lane/ui",           // open lane-claimed items
                  "title": "…", "id": "42" } ],
  // resume = most-recently-touched live|building project (by last_session_at, not pin order),
  //          falling back to the most-recently-touched of any status; null if there are no projects.
  "keepResumeCard": true,   // false when keep_resume_card is off → the deck drops the hero entirely
  "review":  { "total": 2,  // hook-created items with reviewed_at IS NULL, newest first, items capped at 8
               "items": [ { "kind": "bug|roadmap", "slug": "…", "name": "…", "id": "BUG-3|42",
                            "title": "…", "meta": "high|should", "when": "2h ago" } ] },
  "blockers": [ { "slug": "…", "name": "…", "text": "…" } ],            // every stored blocker line, flat
  "stale":    [ { "slug": "…", "name": "…", "since": "2w ago" } ],      // live|building, last push > STALE_DAYS
  "bugs":     { "total": 3, "projects": [ { "slug": "…", "name": "…", "count": 2 } ] }, // open critical|high
  "activity": [ { "slug": "…", "name": "…", "hash": "…", "branch": "…",
                  "summary": "…", "tags": ["…"], "when": "just now" } ], // merged, newest first, ~12
  "graph":    [ { "date": "YYYY-MM-DD", "count": 3 } ],  // year of daily push counts → the deck's
                                                          // compact contribution strip (click = timeline)
  "totals":   { "byStatus": { "live": 0, "building": 3, "paused": 0, "archived": 0 },
                "openBugs": 4, "pushesThisWeek": 2 }
}
```

`stale` excludes paused/archived (dormant on purpose) and projects that have never pushed; the
threshold is the single constant `util.STALE_DAYS` (default 14). The deck loads independently of the
project grid on the dashboard, so an overview hiccup never blanks the grid.

## The search payload (`GET /api/search?q=…` → the ⌘K palette)

Five capped, case-insensitive ILIKE queries (project name/subtitle, bug title, roadmap title/note,
note text, session summary). Results grouped by kind; each result carries its owning project and a
navigation target. An empty query returns empty groups.

```jsonc
{
  "query": "fog",
  "groups": {
    // kind ∈ project|bug|roadmap|future|note|activity; meta = status (bug) / priority (roadmap) / 'idea' (future) / relative time (note,activity)
    "projects": [ { "kind": "project", "slug": "…", "name": "…", "tint": "#…|null",
                    "title": "…", "meta": "…",
                    "target": { "slug": "…", "tab": "overview", "highlight": null } } ],
    "bugs":     [ { …, "target": { "slug": "…", "tab": "bugs",     "highlight": "BUG-3" } } ],
    "roadmap":  [ { …, "target": { "slug": "…", "tab": "roadmap",  "highlight": "42" } } ],
    "notes":    [ { …, "target": { "slug": "…", "tab": "notes",    "highlight": "7" } } ],
    "activity": [ { …, "target": { "slug": "…", "tab": "activity", "highlight": "6234a79" } } ]
  },
  "counts": { "projects": 0, "bugs": 1, "roadmap": 1, "notes": 1, "activity": 1, "total": 4 },
  "projectCount": 2          // distinct projects across all results → "N results across M projects"
}
```

Caps: `PER_GROUP` (6) + `TOTAL_CAP` (24, trimming the largest groups first). `highlight` is consumed
by `go.detail(slug, tab, highlight)` → the tab decides what it means (commit / bug key / row id) and
the existing `.hl` ring flags the row.

## The settings payload (`GET|PATCH /api/settings`)

Single row, client camelCase. Meanings under the no-API model:

```jsonc
{
  "autoRecord": true,         // does the SessionEnd hook post its metadata backstop
  "keepResumeCard": true,     // does ingest refresh resume fields + does the deck/Overview show the card
  "checkpointDetail": "standard", // brief|standard|detailed — read by /checkpoint to shape the summary
  "includeChores": false,     // do chore-only sessions get a checkpoint (hook + /checkpoint guidance)
  "sessionDefaults": ["ship"],// standing session preferences (catalogue keys: lean|ship|checkpoint|
                              // confirm|verify). Rendered to lines server-side and injected by the
                              // SessionStart hook into EVERY project's block (above directives) via
                              // the detail payload's `sessionDefaults` — permissions granted once,
                              // e.g. "ship" = commits pre-authorised, never re-asked per chat
  "autopilotEnabled": false,  // the ARM SWITCH — the dispatcher polls every minute but nightly +
                              // scheduled jobs only enqueue while this is on (fails SAFE:
                              // unreachable API = no run); ▶ Run now stays manual-only
  "autopilotMinutes": 120,    // wall-clock cap per unattended session (clamped 15–360)
  "autopilotTokens": 1500000, // token budget per run; 0 = UNLIMITED (positive values floored at 100k)
  "autopilotTime": "23:05",   // nightly start, HOST-local HH:MM (the dispatcher supplies its clock)
  "autopilotMaxItems": 3,     // most items attempted per night (clamped 1–10)
  "autopilotExecutorModel": "", // #153 — model alias sessions run as ('' = CLI default; haiku|sonnet|opus)
  "autopilotAdvisorModel": "",  // #153 — stronger model exposed as the "advisor" subagent ('' = off; sonnet|opus|fable)
  "assistGuidance": "",       // ✧ Fill from note (#131): standing owner steer folded into the prompt
  "assistFields": ["title","note","area","lane","priority"], // what the assist may fill (title always)
  "accessPinSet": false       // PIN sign-in available; PATCH accepts write-only `accessPin`
                              // ('' disables) — any accessPin change deletes all auth_tokens
                              // (signs out every PIN-connected device)
}
```

PATCH accepts any subset; unknown keys ignored, `checkpointDetail` coerced to the allowed set. The
hook and the /checkpoint poster read these (bounded, **default-on if the API is unreachable**, never
blocking). `keep_resume_card` off → ingest still inserts the activity row but doesn't touch resume
fields, the overview drops the hero, and the detail Overview hides its resume card.

## The /checkpoint command + poster

Rich resume content is **Claude-authored, free, no external API**. `.claude/commands/checkpoint.md`
(install to `~/.claude/commands/`) tells the session to: read settings via
`stack-checkpoint.mjs --settings` (honour `checkpointDetail` + `includeChores`), derive the slug from
the git remote, compose the full schema (summary, current_phase, in_progress, next_up, working_well,
blockers, tags, plus `extract.bugs` + `extract.next_steps`), and pipe that JSON to
`~/.stack/stack-checkpoint.mjs`. The poster sets `authored:true`, fills commit/branch from git, reads
the token from `~/.stack/env` (**never printed**) and POSTs to `/api/ingest`. The SessionEnd hook is
the silent metadata backstop so the feed never has gaps.

## Routes (all behind bearer auth except GET /api/health)

- `POST /api/ingest` (also the source the SessionStart hook reads back via `GET /api/projects/:slug`)
- `GET /api/overview` (cross-project command deck — resume, blockers, stale, bugs, activity, totals)
- `GET /api/control` (Mission Control, `#/control` — per-project automation state in aggregate
  queries: automode, presence, open lane claims, review counts, serious bugs, blockers, tonight's
  likely autopilot pick per automode project (mirrors the runner's eligibility rules) and the last
  `auto/*` push; plus the full autopilot config (arm, cap, tokens, time, maxItems), the schedule
  rows, the recent job queue and cross-project totals)
- `GET /api/search?q=…` (the ⌘K palette — grouped results across all kinds; see shape below)
- `GET /api/timeline` (the #/timeline screen — last month of pushes grouped by day + 53 weeks of
  daily counts for the contribution grid; soft-deleted projects excluded)
- `GET /api/public/:slug/:token` (**no bearer** — the public showcase, guarded by the project's
  own share_token; strictly overview + activity, wrong slug/token both 404)
- `POST /api/auth/login` (**no bearer** — PIN sign-in: `{pin}` → `{token}`, a device token whose
  sha256 lands in `auth_tokens`; the bearer gate accepts API_TOKEN **or** a live device token.
  403 until an access PIN is set in Settings; 5 wrong PINs per IP → 15-minute lockout)
- `GET|PATCH /api/settings` (single-row app settings; see shape below)
- `POST /api/presence` (live-now ping from the SessionStart hook; 404 for untracked projects) ·
  `POST /api/presence/end` (idempotent clear from the SessionEnd hook)
- `GET /api/projects` · `POST /api/projects` · `GET /api/projects/:slug` (project + activity +
  collections + progress; the detail payload includes `blockers` for the start hook,
  `keepResumeCard`, `sessionDefaults` (rendered lines) and `shareToken`) ·
  `PATCH /api/projects/:slug` (subtitle, site_url, repo_url, status, pin, …) ·
  `DELETE /api/projects/:slug` (**soft** — stamps `deleted_at`, clears the share link, keeps every
  row; deleted projects vanish from all live queries and their collection routes 404) ·
  `GET /api/projects/deleted` (the bin) · `POST /api/projects/:slug/restore` ·
  `DELETE /api/projects/:slug/purge` (the real cascade delete — only valid on binned projects) ·
  `POST /api/projects/:slug/share` (mint/rotate the showcase token) · `DELETE .../share` (disable)
- `GET|POST /api/projects/:slug/bugs` · `PATCH|DELETE /api/projects/:slug/bugs/:bugKey`
  (PATCH also takes `reviewed: bool` — the review-inbox approve)
- `GET|POST /api/projects/:slug/roadmap` · `PATCH|DELETE /api/projects/:slug/roadmap/:id`
  (POST takes `claimed_by` + `area`; PATCH also takes `reviewed: bool`, `claimed_by` ('' releases),
  `review_tag: solid|needs-work|rethink` ('' clears), `done: bool` — ticking stamps `reviewed_at`;
  un-ticking also clears `review_tag` + `claimed_by` (unless the same PATCH sets them explicitly)
  so a sent-back item re-enters play fresh: through To verify on re-completion, pickable by the
  autopilot again — `skipped: bool` — the parked flag:
  sinks to the bottom of its bucket, agents never pick it up, still counts toward progress —
  plus `area`, `position` (drag-reorder), `built_note` (the what-landed account), `plan`
  (#75 — the implementation plan, a whole-list jsonb of `{text, done}` steps; agents tick a step
  by re-sending the list, the autopilot injects it into its session prompt), `review_tags`
  (#146 — whole-list like plan; cleaned + deduped), `refine_note` (#146 — '' clears; ticking
  `done:true` clears both unless the same PATCH sets them) and `review_shelved: bool` (#148 —
  the review shelf; cleared by `done` in either direction and by a real `review_tag` verdict,
  unless the same PATCH sets it explicitly)) ·
  `POST /api/projects/:slug/roadmap/suggest-title` (Gemini titles an item from its note;
  suggestion only, 503 keyless) ·
  `POST /api/projects/:slug/roadmap/assist` (the modal's ✧ Fill-from-note: Gemini reads the note
  and returns title + tidied note + area + lane + priority — prefills the fields, the human
  saves; lanes only ever suggested from the open set; honours the `assistGuidance` +
  `assistFields` settings (#131) — switched-off fields come back empty) ·
  `POST /api/projects/:slug/roadmap/:id/review-brief` (#134 — Gemini's reviewer brief for a
  completed item: summary + test steps + risks from the item, built_note, its landed run and
  the checks; annotation only, 503 keyless) ·
  `POST /api/projects/:slug/roadmap/cleanup` (the board's ✧ Clean up: Gemini reviews all open
  items and suggests missing areas / cleaned titles / honest buckets, only where something's
  off; the client shows a tickable list and applies through the normal PATCH)
- `GET|POST /api/projects/:slug/futures` · `PATCH|DELETE /api/projects/:slug/futures/:id`
  (PATCH: title/note/reviewed/`alignment: on-course|tangent|off-course` ('' clears);
  DELETE tombstones a hook idea) · `POST /api/projects/:slug/futures/:id/judge` (Gemini-suggested
  verdict + why — suggestion only, 503 without a server key, 400 without a north star)
- `POST /api/projects/:slug/polaris` (**Polaris** — the Futures tab's Gemini terminal: `{message,
  history}` → `{reply}`, grounded in north star/phase/open roadmap/funnel/bug count; replies only,
  never writes state; 503 without a key. The web terminal sits under the North star box
  (`components/Polaris.tsx`, click-to-expand) and REPLACED the Roadmap tab's ✧ Intake button — the
  intake route survives as Polaris's `/sort` command, with apply/move/drop done in-terminal
  through the normal CRUD paths)
- `GET|POST /api/projects/:slug/notes` · `PATCH /api/projects/:slug/notes/:id` (text) ·
  `DELETE /api/projects/:slug/notes/:id`
- `GET|POST /api/projects/:slug/checks` · `PATCH /api/projects/:slug/checks/:id` (#143 — edit
  any subset of the POST fields; changing anything but the name clears the stored result) ·
  `DELETE /api/projects/:slug/checks/:id` ·
  `POST /api/projects/:slug/checks/run` (all, or one with `{id}`; returns updated rows — and
  lands a summary row in `check_runs`) ·
  `GET /api/projects/:slug/checks/runs?limit=` (the run history, newest first — the Audit
  dashboard's trend strip)
- `GET|POST /api/projects/:slug/autopilot/runs` (the overnight runner's ledger — one row per
  item attempt: outcome landed|no-commits|failed|limit, commits, tokens, cost, checks, the
  session's own summary; the overview's `autopilotRuns` digest reads the last 20h)
- `POST /api/projects/:slug/branches` (#207 — the host dispatcher's branch report, replacing
  the project's `branch_reports` row whole; write side only, Mission Control reads it folded
  into the control payload: enriched `branches` chips (ahead/behind/mergeClean/subject/when),
  `absorbedBranches` (fully-merged origin branches never deleted — prune hint) and
  `branchesWhen` (report freshness))
- **Global autopilot scheduling** (`/api/autopilot/…`, routes/autopilot.js `autopilotGlobal`):
  `GET|POST /schedule` + `PATCH|DELETE /schedule/:id` (the Mission Control calendar — one-off
  `runDate` or recurring `days` getDay() ints, host-local `atTime`, optional pinned `itemId`;
  one-offs disable themselves after firing) · `POST /start` (the ▶ Run now button AND the
  `stack start-session` CLI — queues a manual job; an open job for the project is returned
  instead of duplicated — and if that open job is a held `resume`, Run now clears its hold so
  it fires immediately) · `POST /merge` (#154 — the merge strip's ⇥ Merge: `{slug, branch,
  itemId?}` queues a `merge` job the dispatcher runs — merge --no-ff into main in a throwaway
  worktree, push, delete the remote branch; idempotent per branch, 409 while another job is
  open, and the item is never auto-ticked) · `POST /resume` (#142 — the runner's graceful limit-pause:
  `{slug, itemId?, minutes}` queues/re-points the project's `resume` job, held for `minutes`
  — relative, so host/server clock skew never matters) · `POST /undo` (#128 — the Reviews view's ⎌ Undo: queues a `revert`
  job for a completed item; idempotent per item, 409 while another job is open. The dispatcher
  reverts the item's #N-tagged main commits in a throwaway worktree, pushes, then un-ticks the
  item) · `GET /jobs?slug=&limit=` (recent automation sessions newest
  first — the read side of /start, what `stack list-sessions` renders; Mission Control
  keeps reading jobs off the control payload) ·
  `GET /next?local=YYYY-MM-DDTHH:MM&dow=N` (the host dispatcher's poll: recovers stale jobs,
  lazily enqueues due nightly/scheduled work, hands out at most one claimed job — serialised) ·
  `PATCH /jobs/:id` (the dispatcher's outcome report: running|done|failed|queued + detail;
  #142 adds the human controls — `{status:'paused'}` hangs a queued/claimed job up (409
  otherwise — a running session has no kill channel), `{status:'queued', notBefore:null}`
  resumes it now; returns the updated job shape) · `DELETE /jobs/:id` (#142 — dismiss a
  queued/paused job; 409 for anything claimed/running/finished)
- `POST /api/terminal/label` (#120 — ✧ Gemini names what each running terminal session is doing:
  the open web sessions (relay's rolling ANSI-stripped output tail) AND the detached tmux
  survivors (the daemon's captured pane tails) in one pass; annotation only, in-memory, 503
  keyless. Returns `{sessions, detached}`; both lists also ride the control payload's
  `terminal.{sessions,detached}`, where Mission Control renders them as ▶ jump-in chips —
  `#/terminal?cwd=…&attach=<tmux name>` — and auto-fires this route whenever unlabelled
  sessions appear.) ·
  `GET /api/terminal/detached` (#188 — the surviving `stack-term-*` tmux sessions with no client
  attached, from the relay's cache of the daemon's advertisements, each with its Gemini `label`
  when one has been made; empty while the daemon is offline) · `POST /api/terminal/detached/kill` (`{name}` — kill an orphaned tmux session on the
  host; the daemon refuses names that aren't actually detached, so a live session is unkillable
  through this route) · `POST /api/terminal/assist` (`{prompt, cwd}` — ✧ the rail's command help:
  Gemini suggests one shell command + a save-label + a caveat line; suggestion only, the client
  types it without Enter; 503 keyless)

Deleting a `source='hook'` bug, roadmap item or future tombstones its fingerprint so the next push
won't re-create it.

## Conventions

- **en-AU spelling** everywhere.
- **No secrets in the repo.** `.env` (server) and `~/.stack/env` (hooks) are gitignored and load at
  runtime. The hooks never read tokens from the shell profile or settings.json, and never print them.
- Frontend is **strict TS** with `noUnusedLocals`/`noUnusedParameters` on — keep it clean.
- All persistence/network stays behind `store.ts`. Components never `fetch` or touch storage directly.
- Both **hooks** must **always exit 0** and log only to stderr — never block Claude Code start or stop.
  (The `stack-checkpoint.mjs` poster is not a hook — it may exit non-zero so /checkpoint can report a
  failure — but it still never prints the token.) Shared logic lives in `hook/stack-post.mjs`.
- **No PAID external AI APIs.** (Owner's decision 2026-07-16, superseding the 2026-07-05
  one-exception rule: that rule was about paid APIs all along.) Gemini on the free tier is
  sanctioned **everywhere** — routes, ingest, hooks, cron, the autopilot — no longer
  manual-only. Two principles survive the loosening:
  • **Gemini annotates, the human disposes.** Gemini output lands as suggestions and annotations
    (review-inbox items, alignment verdicts to accept, the per-push `gemini_note`) — it never
    mutates tracker state itself (no auto-closing bugs, ticking roadmap items, merging branches).
  • **Absent key = silent degrade.** Every Gemini surface no-ops or 503s cleanly without
    `GEMINI_API_KEY`; nothing blocks, nothing errors user-visibly.
  Rich checkpoints stay Claude-authored via `/checkpoint` (free, in-session) — don't replace that
  with an API summariser. Surfaces: `hook/stack-gemini-review.mjs` (second-model diff review →
  review inbox; run manually or from the autopilot), `server/src/gemini.js` + judge/intake/
  polaris/semantic-checks/replan routes, and the post-ingest `gemini_note` (a one-line second-model take
  stamped onto each push in the activity feed). Key from server env / `~/.stack/env`; model
  default gemini-2.5-flash for all surfaces.
- Colour is the named CSS variables at the top of `styles.css` `:root` — add/adjust tones there, not
  as inline hexes; terracotta buttons hover to `--accent-deep`.
- `templates/stack-agent-context.md` is the single source of truth for the portable agent manual; if
  the API or hook contract changes, update it (it's exported verbatim by `scripts/stack-context.mjs`).

## Gotchas

- `server` retries the first Postgres connection — don't "fix" that; it's what survives compose order.
- Ingest uses COALESCE / keep-if-empty on update so short/empty checkpoints don't overwrite a good
  summary, and the `authored` flag means a metadata backstop never clobbers a rich /checkpoint for the
  same commit. Preserve both properties when extending.
- Ingest is idempotent on commit_hash / session_id; auto-extraction dedups on fingerprint and honours
  the tombstone table. Keep all three when touching ingest.
- `readSettings()` defaults to "on" when the row is missing, and the hook/poster default to "on" when
  the API is unreachable — so a flaky API degrades to recording, never to silent-off. Keep that.
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
node hook/stack-session-end.mjs --demo     # fire the metadata backstop (no external API)
node hook/stack-session-start.mjs --demo   # print the "where you left off" block for this repo
node hook/stack-checkpoint.mjs --settings  # print current settings (what /checkpoint reads)
echo '{"project":{"slug":"stack"},"session":{"summary":"…"}}' | node hook/stack-checkpoint.mjs  # author a checkpoint
node scripts/stack-context.mjs --slug stack --api https://stack.your-domain  # export agent manual
./stack tree                               # the branch navigator (also --repo <path>, --json)
./stack start-session [slug] [--item N]    # start an automation session (▶ Run now from the terminal)
./stack list-sessions                      # the automation job queue (also [slug], --limit, --json)
./stack term [dir]                         # claude in a stack-term tmux session (laptop/ssh — shows on
                                           # Mission Control, mirrorable from the web; --shell, --safe)
node terminal/stack-term.mjs               # the web-terminal daemon (normally via the @reboot cron line)
tail -f ~/.stack/term.log                  # its log
node hook/stack-gemini-review.mjs --dry    # second-model review of the last commit (Gemini; --dry = print only)
node scripts/stack-autopilot.mjs --project stack --repo /home/bailey/stack --dry  # what would tonight's run pick?
node scripts/stack-autopilot-dispatch.mjs  # one dispatcher poll by hand (normally the cron line)
crontab -l                                 # the dispatcher line (every minute; remove it to disable all runs)
```
