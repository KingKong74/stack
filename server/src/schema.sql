-- Stack schema. Idempotent: safe to run on every boot. New columns use
-- ADD COLUMN IF NOT EXISTS and the data migrations are convergent (re-running
-- them changes nothing once applied).

CREATE TABLE IF NOT EXISTS projects (
  id              SERIAL PRIMARY KEY,
  slug            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  repo            TEXT,
  status          TEXT NOT NULL DEFAULT 'building',    -- live | building | paused | archived
  current_phase   TEXT,
  summary         TEXT,                                -- latest "where we are at"
  next_steps      JSONB NOT NULL DEFAULT '[]'::jsonb,
  blockers        JSONB NOT NULL DEFAULT '[]'::jsonb,
  pinned          BOOLEAN NOT NULL DEFAULT false,
  last_session_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Project additions (resume card + dashboard fields).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS subtitle     TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_url     TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_url     TEXT;  -- browseable repo URL (Repo button)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tint         TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS in_progress  JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS next_up      JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS working_well JSONB NOT NULL DEFAULT '[]'::jsonb;

-- The project's north star: one paragraph on what this project is becoming.
-- Injected into every SessionStart so all sessions pull the same direction,
-- and the yardstick the Futures tab curates ideas against.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS north_star TEXT;

-- Directives: standing instructions for the next session(s), edited on the
-- dashboard and injected verbatim at every SessionStart — how you steer agents
-- without being in the terminal. Lines stay until removed in the UI.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS directives JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Deployment card fields: where this deploys (label) and where its logs live —
-- both hand-edited on the detail Overview's Deployment panel.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deploy_platform TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS logs_url        TEXT;

-- The tech-stack chips on the detail Overview, hand-edited.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tech_stack JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Automode: this project is open to the overnight autopilot. The runner
-- refuses a project with this off (in addition to the global arm switch), and
-- the UI badges automode projects so you can see what's agent-run at a glance.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS automode BOOLEAN NOT NULL DEFAULT false;

-- Status vocabulary migration: active | paused | done | archived  ->
-- live | building | paused | archived. Convert legacy 'active' rows to 'live'.
ALTER TABLE projects ALTER COLUMN status SET DEFAULT 'building';
UPDATE projects SET status = 'live' WHERE status = 'active';

CREATE TABLE IF NOT EXISTS sessions (
  id            SERIAL PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id    TEXT,
  summary       TEXT,
  current_phase TEXT,
  next_steps    JSONB NOT NULL DEFAULT '[]'::jsonb,
  blockers      JSONB NOT NULL DEFAULT '[]'::jsonb,
  files_touched JSONB NOT NULL DEFAULT '[]'::jsonb,
  tools_used    JSONB NOT NULL DEFAULT '[]'::jsonb,
  branch        TEXT,
  cwd           TEXT,
  model         TEXT,
  reason        TEXT,                                  -- session end reason (exit | clear | ...)
  message_count INTEGER,
  source        TEXT NOT NULL DEFAULT 'hook',          -- hook | manual
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session additions: the commit the push landed on, and activity-feed tags.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS commit_hash TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tags        JSONB NOT NULL DEFAULT '[]'::jsonb;
-- authored = a rich Claude-authored /checkpoint (vs the hook's metadata backstop).
-- Once true it stays true, so a later metadata post can't downgrade a rich row.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS authored    BOOLEAN NOT NULL DEFAULT false;
-- gemini_note = the second model's one-line take on the push, stamped after
-- ingest commits (fire-and-forget; an annotation, never state).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS gemini_note TEXT;
-- Real transcript token usage (#178): summed by the SessionEnd hook (deduped
-- per message id), so manual sessions report usage like autopilot runs do.
-- 0 = unknown (pre-#178 rows, or a hook that couldn't read the transcript).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tokens_used BIGINT NOT NULL DEFAULT 0;
-- Per-model transcript usage for an INTERACTIVE session, shaped exactly like
-- autopilot_runs.model_usage so the Roles room reads one shape for both. No
-- costUSD key: a transcript carries no cost, which is why manual spend is
-- reported on tokens. '{}' = the post carried none, NOT "it ran nothing".
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model_usage JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Subagent delegations: how many Agent calls, and of which types. A COUNT and
-- never a cost — the parent transcript records the call and its result but
-- never the subagent's own usage, so there is nothing to sum.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_types JSONB NOT NULL DEFAULT '{}'::jsonb;
-- The subagents' OWN per-model usage, same shape as model_usage. Claude Code
-- writes each subagent its own transcript under `<session-id>/subagents/`; the
-- parent's records only the Agent call and its result, so this is the only
-- place a delegation's real cost exists. It is routinely the LARGER half of a
-- delegating session — a director handing units to a cheap executor bills most
-- of its work here — which is why main-loop-only spend is not the answer.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_usage JSONB NOT NULL DEFAULT '{}'::jsonb;
-- How many delegations left a readable transcript, so "3 delegated, 2 recorded"
-- is sayable rather than implying every one of them was priced.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agents_recorded INTEGER NOT NULL DEFAULT 0;

-- Per-project bug tracker. bug_key is the human "BUG-N" id, unique per project.
CREATE TABLE IF NOT EXISTS bugs (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bug_key     TEXT NOT NULL,                           -- BUG-1, BUG-2, ... per project
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'medium',          -- critical | high | medium | low
  status      TEXT NOT NULL DEFAULT 'open',            -- open | investigating | fixing | fixed
  link_ref    TEXT,                                    -- commit hash this bug was extracted from
  source      TEXT NOT NULL DEFAULT 'manual',          -- hook | manual
  fingerprint TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, bug_key)
);
-- Auto (hook) items dedupe on fingerprint; manual items are never deduped.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bugs_auto_fp
  ON bugs (project_id, fingerprint) WHERE source = 'hook';
-- Review inbox: an auto-extracted item awaits a human look until reviewed_at is
-- set (approve keeps it; dismiss deletes + tombstones). Manual items never need
-- review — the inbox query filters on source = 'hook' AND reviewed_at IS NULL.
-- Ingest's dedup re-point leaves reviewed_at alone, so approving is sticky.
ALTER TABLE bugs          ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_bugs_project ON bugs (project_id, created_at DESC);

-- Per-project MoSCoW roadmap.
CREATE TABLE IF NOT EXISTS roadmap_items (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bucket      TEXT NOT NULL DEFAULT 'should',          -- must | should | could | wont
  title       TEXT NOT NULL,
  note        TEXT,
  done        BOOLEAN NOT NULL DEFAULT false,
  position    INTEGER NOT NULL DEFAULT 0,              -- order within a bucket
  source      TEXT NOT NULL DEFAULT 'manual',          -- hook | manual
  fingerprint TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_roadmap_auto_fp
  ON roadmap_items (project_id, fingerprint) WHERE source = 'hook';
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;  -- see bugs.reviewed_at
-- Lane claims: which parallel session (usually a branch, e.g. lane/ui) owns an
-- open item. Injected by the SessionStart hook so lanes never double-grab.
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS claimed_by TEXT;
-- The archive-review verdict on a completed item: solid | needs-work | rethink.
-- Tagging needs-work/rethink offers to spin a follow-up item back onto the board.
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS review_tag TEXT;
-- The product area (section of the project) an item relates to — mirrors
-- futures.area. NULL = untagged; filters the board.
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS area TEXT;
-- What actually landed: written by the session/agent that completes the item
-- (PATCH built_note alongside done:true) and shown on the Reviews view, so the
-- verdict is made against what was built, not just the ask.
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS built_note TEXT;
-- The implementation plan (#75): ordered steps [{text, done}] for larger items.
-- Edited in the item modal, shown as progress on the card, injected into the
-- autopilot's session prompt — the runner works unticked steps top-down and
-- agents tick steps via PATCH as they land.
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS plan JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Review annotations (#146): quick tags the reviewer sticks on a completed item
-- while it sits in the Reviews pipeline ("fix", "needs-more", …). Cleared when
-- the item completes afresh — each review round starts unannotated.
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS review_tags JSONB NOT NULL DEFAULT '[]'::jsonb;
-- The refinement delta (#146): a refine sends the item back to the board as
-- ITSELF (same id, built_note kept) with just this instruction — what to change
-- on top of what already landed. Cleared when the item completes again (the
-- refinement was addressed).
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS refine_note TEXT;
-- Shelved reviews (#148): a completed item the owner has seen but wants to come
-- back to ("good enough for now — fix a few things later"). Shelved rows leave
-- the main To-verify list for the collapsed Shelved strip. Cleared whenever the
-- item completes afresh, goes back to the board or takes a verdict, so a row is
-- never both awaiting verification and shelved.
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS review_shelved BOOLEAN NOT NULL DEFAULT false;
-- Risk tier (#212): the graduated-trust lever. low | normal | high, set by the
-- human (modal) or at creation. A LOW-risk item whose overnight run lands with
-- green checks and a clean Gemini review auto-queues its own merge job — code
-- reaches main without a human click, but the item is still ticked (and the
-- work verdicted) by the human in Reviews. normal/high never auto-merge.
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS risk TEXT NOT NULL DEFAULT 'normal';
-- The desire tier (#227): S | A | B | C, NULL = unranked. Deliberately distinct
-- from the MoSCoW bucket — bucket is how big/necessary the work is, tier is how
-- much the owner wants it NEXT. It is the PRIMARY sort of the run queue, with
-- the bucket and position as tiebreaks and unranked items sorting last, so a
-- board nobody has ranked behaves exactly as it always did.
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS tier TEXT;
-- When the item was PARKED (#247). Stamped as `skipped` flips true, cleared as
-- it flips false, so "parked 34 days" is the honest age of the park rather than
-- of the last edit. NULL on a parked row = parked before this column existed;
-- the UI falls back to updated_at and says so.
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS skipped_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_roadmap_project ON roadmap_items (project_id, bucket, position);

-- Per-project futures: loose directional ideas, curated against the north star
-- and promoted into the roadmap (promotion = create the roadmap item, then
-- delete the idea — a hook idea's fingerprint is tombstoned on delete like any
-- auto item). Same review-inbox semantics as bugs/roadmap via reviewed_at.
CREATE TABLE IF NOT EXISTS futures (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  note        TEXT,
  source      TEXT NOT NULL DEFAULT 'manual',          -- hook | manual
  fingerprint TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The curation verdict against the north star: on-course | tangent | off-course
-- (NULL = unsorted). The Futures tab groups ideas by this.
ALTER TABLE futures ADD COLUMN IF NOT EXISTS alignment TEXT;
-- Canvas coordinates for the visual canvas view. NULL = auto-layout by alignment group.
ALTER TABLE futures ADD COLUMN IF NOT EXISTS x_coord FLOAT;
ALTER TABLE futures ADD COLUMN IF NOT EXISTS y_coord FLOAT;
-- The Polaris galaxy (#312). An idea's SHAPE in the sky is derived from two
-- columns, never stored as a kind — so there is one place a thing can be:
--   is_star             -> a STAR: a promoted idea with its own orbit
--   parent is a star    -> a PLANET in that star's orbit
--   parent is a planet  -> a MOON, a piece of that planet
--   no parent, judged   -> rides one of the north star's three shells
--   no parent, unjudged -> the drift belt
-- Depth is capped at star → planet → moon by the PATCH route, and a star never
-- carries a parent. ON DELETE SET NULL is the honest fallback: dismissing a
-- planet returns its moons to the shells rather than deleting work you kept.
ALTER TABLE futures ADD COLUMN IF NOT EXISTS parent_id INTEGER
  REFERENCES futures(id) ON DELETE SET NULL;
ALTER TABLE futures ADD COLUMN IF NOT EXISTS is_star BOOLEAN NOT NULL DEFAULT false;
-- Magnitude 1–5 = how much work the idea is (an afternoon → a quarter). NULL is
-- "not sized yet" and stays NULL: the sky draws an unsized idea at its smallest
-- and the panel says so, rather than inventing an estimate nobody gave.
ALTER TABLE futures ADD COLUMN IF NOT EXISTS magnitude SMALLINT;
CREATE INDEX IF NOT EXISTS idx_futures_parent ON futures (parent_id) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_futures_auto_fp
  ON futures (project_id, fingerprint) WHERE source = 'hook';
CREATE INDEX IF NOT EXISTS idx_futures_project ON futures (project_id, created_at DESC);

-- Per-project sticky notes. The Workbench canvas is where they are READ now
-- (the notes wall is gone), but the rows still live here: ingest, search and
-- promote-to-bug/roadmap all address a note, not a card.
CREATE TABLE IF NOT EXISTS notes (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  colour      TEXT NOT NULL DEFAULT '#fef4a8',
  source      TEXT NOT NULL DEFAULT 'manual',          -- hook | manual
  fingerprint TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes (project_id, created_at DESC);

-- The Workbench canvas — the tab that replaced the notes wall. A row here is a
-- PLACEMENT, not content: a note card carries note_id and a polaris card
-- carries future_id, so `notes` and `futures` stay the one source of truth for
-- their own text (edit a card title and the write goes through to the row it
-- wraps). Only an 'ai' card owns its body, because nothing else does.
--
-- Both foreign keys are ON DELETE CASCADE: delete the note or the idea anywhere
-- in the app and its card leaves the canvas with it, so a card can never
-- outlive what it points at.
CREATE TABLE IF NOT EXISTS workbench_cards (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                           -- note | polaris | ai
  note_id     INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  future_id   INTEGER REFERENCES futures(id) ON DELETE CASCADE,
  op          TEXT NOT NULL DEFAULT '',                -- ai only: which op made it
  title       TEXT NOT NULL DEFAULT '',                -- ai only (others read through)
  body        JSONB NOT NULL DEFAULT '{}'::jsonb,      -- lines | phases | chips | chosen
  x           INTEGER NOT NULL DEFAULT 0,
  y           INTEGER NOT NULL DEFAULT 0,
  w           INTEGER NOT NULL DEFAULT 244,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One card per note and per idea: the canvas shows a thing once, and the
-- backfill that materialises cards for pre-Workbench notes leans on this to be
-- safely re-runnable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wb_cards_note
  ON workbench_cards (note_id) WHERE note_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wb_cards_future
  ON workbench_cards (future_id) WHERE future_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wb_cards_project ON workbench_cards (project_id, created_at);

-- Lines between cards. `ai` marks the ones an op drew (dashed on the canvas);
-- cutting one of those drops the output it fed, which is what makes an op
-- undoable without an undo stack.
CREATE TABLE IF NOT EXISTS workbench_edges (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  a_id        INTEGER NOT NULL REFERENCES workbench_cards(id) ON DELETE CASCADE,
  b_id        INTEGER NOT NULL REFERENCES workbench_cards(id) ON DELETE CASCADE,
  ai          BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wb_edges_project ON workbench_edges (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wb_edges_pair ON workbench_edges (a_id, b_id);

-- Per-project checks: HTTP probes run against the project's live application
-- from the Bugs tab ("is the site up, does the API answer"). Run on demand;
-- the last result lives on the row.
CREATE TABLE IF NOT EXISTS checks (
  id            SERIAL PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  expect_status INTEGER NOT NULL DEFAULT 200,
  contains      TEXT,                                  -- optional body keyword
  last_status   TEXT,                                  -- pass | fail | NULL (never run)
  last_code     INTEGER,
  last_ms       INTEGER,
  last_error    TEXT,
  last_run_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checks_project ON checks (project_id, created_at);

-- #278 — the bug↔check link, the one data change the merged Quality page needed.
-- Which check caught this bug: a red check wears the bug filed from it, and the
-- bug wears the check that caught it, so the run→file→fix→re-run loop never
-- loses its thread. NULL = filed by hand. Declared here (not with the bugs
-- table) because it references checks, which is created further down; ON DELETE
-- SET NULL so deleting a check never takes its bug with it.
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS check_id INTEGER REFERENCES checks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bugs_check ON bugs (check_id) WHERE check_id IS NOT NULL;

-- Tombstones: a deleted auto item must not be re-created by the next push.
-- Keyed by project + kind (bug | roadmap | future) + fingerprint.
CREATE TABLE IF NOT EXISTS dismissed_items (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                           -- bug | roadmap
  fingerprint TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, kind, fingerprint)
);

-- Session presence: which projects have a Claude session open right now.
-- The SessionStart hook upserts a row; an authored /checkpoint bumps
-- last_seen_at; the SessionEnd hook (and ingest's metadata backstop) clears it.
-- Liveness = last_seen_at within util.PRESENCE_TTL_MINUTES, so a crashed
-- session ages out on its own. session_id defaults to '' so the per-project
-- upsert key works even when a hook payload carries no id.
CREATE TABLE IF NOT EXISTS presence (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL DEFAULT '',
  branch       TEXT,
  cwd          TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_presence_seen ON presence (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_touch  ON projects (pinned DESC, last_session_at DESC NULLS LAST);

-- Single-row app settings. The boolean primary key (always true) makes this a
-- singleton: there can only ever be one row. Meanings under the no-API model:
--   auto_record       — does the SessionEnd hook post its metadata backstop
--   keep_resume_card  — does ingest refresh the project's resume fields (and the
--                       command deck show the resume hero)
--   checkpoint_detail — how much the /checkpoint authored summary explains
--   include_chores    — do chore-only sessions get a checkpoint
--   session_defaults  — standing session preferences (catalogue keys, e.g. "ship"
--                       = commits pre-authorised); the SessionStart hook injects
--                       the matching lines into every session on every project
CREATE TABLE IF NOT EXISTS settings (
  id                BOOLEAN PRIMARY KEY DEFAULT true,
  auto_record       BOOLEAN NOT NULL DEFAULT true,
  keep_resume_card  BOOLEAN NOT NULL DEFAULT true,
  checkpoint_detail TEXT    NOT NULL DEFAULT 'standard',  -- brief | standard | detailed
  include_chores    BOOLEAN NOT NULL DEFAULT false,
  session_defaults  JSONB   NOT NULL DEFAULT '["ship"]'::jsonb,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT settings_singleton CHECK (id)
);
INSERT INTO settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS session_defaults JSONB NOT NULL DEFAULT '["ship"]'::jsonb;
-- Autopilot controls: the in-app arm switch (the nightly runner exits unless
-- enabled) and the per-run wall-clock cap for the unattended session.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS autopilot_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS autopilot_minutes INTEGER NOT NULL DEFAULT 120;
-- Access PIN: scrypt hash ("scrypt$<salt>$<hash>"); NULL = PIN sign-in disabled.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS access_pin_hash TEXT;
-- Autopilot night controls (Mission Control): the token budget per run
-- (0 = unlimited), the nightly start time (host-local HH:MM — the dispatcher
-- supplies its own local clock, so the server's TZ never matters) and how
-- many items a night may attempt.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS autopilot_tokens    BIGINT  NOT NULL DEFAULT 1500000;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS autopilot_time      TEXT    NOT NULL DEFAULT '23:05';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS autopilot_max_items INTEGER NOT NULL DEFAULT 3;
-- The plan sweep (#255). The board's ✧ To planning agent already hands a PICKED
-- list to a plan session; this is the standing half of the same idea — "the
-- system must plan the implementation of all roadmap items", without anyone
-- having to press anything. While on, GET /next lazily enqueues a plan job for
-- an automode project that still has eligible unplanned must/should work. It
-- sits behind the SAME gates as the nightly (the arm switch and the project's
-- automode), so disarming stops it like everything else.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS autopilot_plan_sweep BOOLEAN NOT NULL DEFAULT true;
-- (#287) How long a web-terminal session may sit with NO output before the host
-- daemon terminates it. 0 = never. Idleness is tmux's own session_activity, so
-- it measures whether work is happening rather than whether a tab is open — a
-- browser left open overnight is the case this exists for. Only stack-term-*
-- sessions are eligible, so the autopilot's stack-auto-* nights (legitimately
-- quiet while a model thinks) are out of scope by construction.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS term_idle_hours INTEGER NOT NULL DEFAULT 6;
-- How long a parked roadmap item may sit before it reads as STALE (#247). The
-- Roadmap tab's Parked view counts days since the park and flags anything past
-- this threshold; purely a surfacing rule, nothing is auto-changed.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS stale_item_days INTEGER NOT NULL DEFAULT 21;
-- Dual-model autopilot (#153): the EXECUTOR model runs the unattended session
-- (claude --model; '' = the CLI's default) while the ADVISOR — a stronger
-- model — is exposed to it as a read-only subagent it consults for plans and
-- unblocking ('' = no advisor, single-model session as before). Model values
-- are claude CLI aliases or full model ids (haiku | sonnet | opus |
-- claude-opus-5 | fable).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS autopilot_executor_model TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS autopilot_advisor_model  TEXT NOT NULL DEFAULT 'claude-opus-5';
-- Opus 5 as the STANDING advisor: a fresh install gets it from the column
-- default above; a database that predates it and never picked an advisor is
-- upgraded ONCE, guarded by its own flag — so an advisor deliberately turned
-- off in Mission Control survives every boot (same shape as tips_seeded).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS advisor_default_applied BOOLEAN NOT NULL DEFAULT false;
UPDATE settings
   SET autopilot_advisor_model = 'claude-opus-5'
 WHERE id AND NOT advisor_default_applied AND COALESCE(autopilot_advisor_model, '') = '';
UPDATE settings SET advisor_default_applied = true WHERE id AND NOT advisor_default_applied;
-- ✧ Fill from note (#131): a standing guidance line folded into the assist
-- prompt, and which fields the assist is allowed to fill (title always is).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS assist_guidance TEXT  NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS assist_fields   JSONB NOT NULL DEFAULT '["title","note","area","lane","priority","tier","risk"]'::jsonb;
-- #298 — tier and risk join the assist catalogue. A fresh install gets them
-- from the column default above; a database written before they existed is
-- upgraded ONCE, guarded by its own flag, so a field switched off by hand in
-- Settings is not switched back on at every boot (same shape as tips_seeded).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS assist_tier_risk_applied BOOLEAN NOT NULL DEFAULT false;
UPDATE settings
   SET assist_fields = assist_fields || '["tier","risk"]'::jsonb
 WHERE id AND NOT assist_tier_risk_applied;
UPDATE settings SET assist_tier_risk_applied = true WHERE id AND NOT assist_tier_risk_applied;

-- Google Calendar sync (#222): OAuth2 credentials for one-way push of
-- autopilot schedule rows to a GCal calendar. All four must be set for sync
-- to work; the client shape never exposes the secret or refresh token.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS gcal_client_id     TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS gcal_client_secret TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS gcal_refresh_token TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS gcal_calendar_id   TEXT NOT NULL DEFAULT '';

-- Device tokens issued by POST /api/auth/login (PIN sign-in). Only the sha256
-- of each token is stored; the bearer gate accepts API_TOKEN or a live row
-- here. Changing or clearing the PIN deletes every row (signs devices out).
CREATE TABLE IF NOT EXISTS auth_tokens (
  id           SERIAL PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

-- Public showcase: a project with a share_token has a tokenless read-only view
-- at GET /api/public/:slug/:token (overview + activity only). NULL = not shared.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS share_token TEXT;

-- Autopilot area targeting (#122): when set, the nightly pick only considers
-- open items carrying this product-area tag. NULL = the whole board. Set from
-- Mission Control's per-project target picker; --item pins ignore it.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS autopilot_area TEXT;

-- Merge autonomy (#363): how much of this project's merging the Merge room's
-- agent may do on one press. Deliberately NOT the same lever as `automode`,
-- which governs whether the project is BUILT overnight — a house can be happy
-- to have a project built unattended and still want every merge of it looked
-- at, and the reverse.
--   auto  the agent's ▶ Run queues a merge job for each of this project's
--         probe-clean branches, in its planned order.
--   plan  (default) those branches appear in the proposed plan so the ordering
--         is honest about them, but the press leaves them alone — they merge
--         from the row, one press each.
--   off   left out of the plan entirely.
-- None of the three relaxes anything else: the #212 risk gate, the conflict
-- probe and the confirm all apply exactly as they do to a hand-pressed merge.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS merge_autonomy TEXT NOT NULL DEFAULT 'plan';

-- Soft delete: deleting a project stamps deleted_at instead of dropping the
-- rows — everything (sessions, bugs, roadmap, notes…) survives for restore.
-- Deleted projects vanish from every live query; Settings lists them with
-- restore / purge (the hard DELETE, which cascades).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Area tags: which part of the product an idea lives in (landing page,
-- settings, mobile, …) — a second, orthogonal axis to alignment. Freeform,
-- filterable on the Futures tab. NULL = untagged.
ALTER TABLE futures ADD COLUMN IF NOT EXISTS area TEXT;

-- Semantic checks: an optional plain-language assertion judged by Gemini
-- against the fetched page ("shows the dashboard with no error banners").
-- Skipped silently when the server has no GEMINI_API_KEY.
ALTER TABLE checks ADD COLUMN IF NOT EXISTS semantic TEXT;

-- The audit brief (#144): the owner's standing steer for the automated bug
-- audit — what to look for, what matters, what to ignore. Gemini has no idea
-- what a project should do without this; it's folded into every audit prompt
-- (and the Claude hand-off prompt). NULL/'' = audit with generic instructions.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS audit_context TEXT;

-- Skip tag: parked roadmap items — planned but not to be picked up yet. They
-- sort to the bottom of their bucket and agents leave them alone; still count
-- toward progress (they remain planned work).
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS skipped BOOLEAN NOT NULL DEFAULT false;

-- Autopilot run history: one row per item attempt, POSTed by the overnight
-- runner. The dashboard's morning digest and Mission Control read from it —
-- before this the only record was ~/.stack/autopilot.log on the host.
CREATE TABLE IF NOT EXISTS autopilot_runs (
  id           BIGSERIAL PRIMARY KEY,
  project_id   BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id      BIGINT,
  item_title   TEXT NOT NULL DEFAULT '',
  branch       TEXT NOT NULL DEFAULT '',
  outcome      TEXT NOT NULL DEFAULT 'landed',  -- landed | no-commits | failed | limit | planned (#219 plan nights)
  commits      INT NOT NULL DEFAULT 0,
  tokens       BIGINT NOT NULL DEFAULT 0,
  cost_usd     NUMERIC(8,2) NOT NULL DEFAULT 0,
  checks_failing INT,
  summary      TEXT NOT NULL DEFAULT '',        -- the session's own account (the night report)
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autopilot_runs_project_idx ON autopilot_runs (project_id, finished_at DESC);
-- Per-model token/cost breakdown (#167): with dual-model sessions the run may
-- span executor + advisor on different models. Stored as
-- { "<model>": { "inputTokens": N, "outputTokens": N, "costUSD": N }, … }
-- (camelCase to match the claude --output-format json schema). NULL on single-
-- model runs and on rows pre-dating this column.
ALTER TABLE autopilot_runs ADD COLUMN IF NOT EXISTS model_usage JSONB;
-- Named tmux session running this autopilot item (#171): the web terminal can
-- attach to it for live monitoring while the run is active. NULL = run was not
-- started inside a tmux session (non-tmux host, or pre-dates this column).
ALTER TABLE autopilot_runs ADD COLUMN IF NOT EXISTS tmux_session TEXT;

-- #273/#282 — the REVIEWER's read on this run, stored instead of thrown away.
-- The night already runs a Gemini second-model review of the branch diff and
-- writes a machine-readable verdict for the #212 auto-merge gate; until now
-- that verdict evaporated the moment the gate read it, so a human opening the
-- review queue in the morning started from nothing. Keeping it means every
-- change arrives pre-verdicted:
--   review_verdict  clean | concerns | blocked | NULL (no review ran — keyless,
--                   no diff, or a pre-#282 row). NEVER a verdict Stack invented.
--   review_note     the reviewer's own sentence on what it found.
--   review_findings how many bugs it filed into the review inbox (0 = clean).
-- Suggestions, not state: the human still gives the verdict. See CLAUDE.md's
-- "Gemini annotates, the human disposes".
ALTER TABLE autopilot_runs ADD COLUMN IF NOT EXISTS review_verdict  TEXT;
ALTER TABLE autopilot_runs ADD COLUMN IF NOT EXISTS review_note     TEXT;
ALTER TABLE autopilot_runs ADD COLUMN IF NOT EXISTS review_findings INT;

-- #284 — the ARCHITECT's read on the same change, kept beside the reviewer's.
-- Two agents asking different questions: the reviewer "is this correct?", the
-- architect "where is this codebase going?". Separate columns because a change
-- can be correct and still drift, and collapsing them would hide exactly that.
--   architect_verdict  aligned | drifting | concerning | NULL (no pass ran)
--   architect_note     one or two sentences on where the change takes the code
--   architect_obs      jsonb list of short structural observations (max 4)
-- Suggestions, not state: it files nothing and closes nothing.
ALTER TABLE autopilot_runs ADD COLUMN IF NOT EXISTS architect_verdict TEXT;
ALTER TABLE autopilot_runs ADD COLUMN IF NOT EXISTS architect_note    TEXT;
ALTER TABLE autopilot_runs ADD COLUMN IF NOT EXISTS architect_obs     JSONB;

-- Scheduled sessions — Mission Control's calendar. A row is "run the autopilot
-- on this project at this time": one-off (run_date set, days empty) or
-- recurring (days = ISO getDay() ints 0-6, run_date NULL). item_id optionally
-- pins the session to one roadmap item instead of the night's normal pick.
-- Times are host-local HH:MM (see autopilot_jobs). One-offs disable themselves
-- after they enqueue, so the row survives as visible history.
CREATE TABLE IF NOT EXISTS autopilot_schedule (
  id               BIGSERIAL PRIMARY KEY,
  project_id       BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id          BIGINT,
  at_time          TEXT NOT NULL,                    -- 'HH:MM' host-local
  days             JSONB NOT NULL DEFAULT '[]'::jsonb,
  run_date         DATE,
  note             TEXT NOT NULL DEFAULT '',
  enabled          BOOLEAN NOT NULL DEFAULT true,
  last_enqueued_on DATE,                             -- local date it last fired (recurring dedup)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The autopilot job queue. The server cannot reach the host (firewall), so a
-- host-side dispatcher polls GET /api/autopilot/next every minute: the server
-- lazily enqueues due work (the armed nightly per automode project, due
-- schedule rows, manual Run-now presses), then hands over at most one job at a
-- time — the dispatcher runs it and PATCHes the outcome back.
CREATE TABLE IF NOT EXISTS autopilot_jobs (
  id          BIGSERIAL PRIMARY KEY,
  project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'manual',   -- manual | nightly | scheduled | revert (#128) | resume (#142)
  item_id     BIGINT,                           -- pin to one roadmap item (manual/scheduled/revert/resume)
  schedule_id BIGINT,                           -- the autopilot_schedule row that spawned it
  night_date  DATE,                             -- nightly dedup: one per project per local date
  status      TEXT NOT NULL DEFAULT 'queued',   -- queued | claimed | running | done | failed | paused (#142 — hung up, held for a human)
  detail      TEXT NOT NULL DEFAULT '',         -- outcome note from the dispatcher
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at  TIMESTAMPTZ,
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS autopilot_jobs_nightly_idx
  ON autopilot_jobs (project_id, night_date) WHERE kind = 'nightly';
-- #255 — the plan sweep enqueues at most ONE open plan job per project. The
-- index is what makes the lazy enqueue idempotent under a dispatcher that polls
-- every minute: a second insert while one is still open simply conflicts.
CREATE UNIQUE INDEX IF NOT EXISTS autopilot_jobs_plan_idx
  ON autopilot_jobs (project_id)
  WHERE kind = 'plan' AND status IN ('queued', 'claimed', 'running');
CREATE INDEX IF NOT EXISTS autopilot_jobs_status_idx ON autopilot_jobs (status, created_at);
-- #142 — a limit-paused session becomes a durable `resume` job instead of a
-- detached sleep on the host: not_before is the earliest hand-out time (the
-- limit reset). GET /next skips queued jobs before it; a human can clear it
-- (▶ Resume now), hold the job (status 'paused' — hang up) or dismiss it.
ALTER TABLE autopilot_jobs ADD COLUMN IF NOT EXISTS not_before TIMESTAMPTZ;

-- Session planner (#228): a scheduled session is a first-class plan, not just
-- a time slot. session_kind picks the runner mode (build | plan | debug |
-- audit), agenda is the ORDERED work list — roadmap item ids (build/plan) or
-- bug keys (debug); [] = the board's own priority order — and area scopes the
-- general pick to one product area. Jobs carry copies so the dispatcher gets
-- the whole plan from GET /next.
ALTER TABLE autopilot_schedule ADD COLUMN IF NOT EXISTS session_kind TEXT  NOT NULL DEFAULT 'build';
ALTER TABLE autopilot_schedule ADD COLUMN IF NOT EXISTS agenda       JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE autopilot_schedule ADD COLUMN IF NOT EXISTS area         TEXT  NOT NULL DEFAULT '';
ALTER TABLE autopilot_jobs     ADD COLUMN IF NOT EXISTS session_kind TEXT  NOT NULL DEFAULT 'build';
ALTER TABLE autopilot_jobs     ADD COLUMN IF NOT EXISTS agenda       JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE autopilot_jobs     ADD COLUMN IF NOT EXISTS area         TEXT  NOT NULL DEFAULT '';

-- Audit area (#143, named by #145): a check can exercise a function of the app, not just
-- probe a page — request method + optional body, plus a JSON-path assertion
-- on the response ("$.status" should equal "ok"). GET probes are unchanged.
ALTER TABLE checks ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'GET';
ALTER TABLE checks ADD COLUMN IF NOT EXISTS req_body TEXT;
ALTER TABLE checks ADD COLUMN IF NOT EXISTS json_path TEXT;
ALTER TABLE checks ADD COLUMN IF NOT EXISTS json_expect TEXT;
-- Authenticated checks (#261). Every Stack route but GET /api/health sits behind
-- bearer auth, so a suite that cannot authenticate can only ever probe the front
-- door — and "checks green" then carries no information for the trust ladder
-- (#212 auto-merge, #263 auto-verdict). An opt-in check has the server attach its
-- OWN API_TOKEN at run time. The token is never stored on the row, never returned
-- to the client, and is attached ONLY when the check's origin is the project's own
-- site_url (or a loopback/compose-internal host) — a check pointed anywhere else
-- runs unauthenticated rather than leaking the token to a third-party URL.
ALTER TABLE checks ADD COLUMN IF NOT EXISTS auth BOOLEAN NOT NULL DEFAULT false;

-- Quality tab run history: one row per Run-all (or run-one) of a project's
-- checks — the health card's pass-rate trend and the History ledger read from
-- it. Summary only; the per-check grain lives in check_results below.
CREATE TABLE IF NOT EXISTS check_runs (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL DEFAULT 'all',              -- all | one
  total       INTEGER NOT NULL,
  passed      INTEGER NOT NULL,
  failed      INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  run_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_check_runs_project ON check_runs (project_id, run_at DESC);

-- #279 — each check's OWN history: one row per check per run. The checks row
-- carries only the latest result, and check_runs only per-run totals, so
-- "this has been flaky for a week" used to be unanswerable — a red light with
-- no diagnosis. These rows are what let the Quality page sparkline a check,
-- say "failed 4 of the last 6 runs", and separate a fresh regression from a
-- long-standing failure.
--   • Written best-effort inside the run, one statement for the whole batch.
--   • Capped per check (util.CHECK_HISTORY_KEEP) by a prune right after the
--     insert, so 30 checks × nightly runs cannot grow without bound.
--   • run_id is nullable on purpose: a run-one still records its result even
--     though the summary row is written after the probes.
CREATE TABLE IF NOT EXISTS check_results (
  id         SERIAL PRIMARY KEY,
  check_id   INTEGER NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id     INTEGER REFERENCES check_runs(id) ON DELETE SET NULL,
  status     TEXT NOT NULL,                             -- pass | fail
  code       INTEGER,
  ms         INTEGER,
  error      TEXT,
  run_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_check_results_check ON check_results (check_id, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_check_results_project ON check_results (project_id, run_at DESC);

-- Branch report (#207): the host dispatcher's git snapshot per project — every
-- origin branch with ahead/behind counts vs origin/main, a merge-tree conflict
-- probe (git ≥2.38; null when unsupported) and the item id parsed from the
-- lane name. One row per project, replaced whole on each report (~10 min);
-- Mission Control's merge strip (#154) reads it off the control payload. The
-- server never touches git itself — the repos live on the host, behind the
-- firewall, so the dispatcher pushes the truth up (same dial-out pattern as
-- the terminal daemon).
CREATE TABLE IF NOT EXISTS branch_reports (
  project_id  BIGINT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  report      JSONB NOT NULL DEFAULT '[]',
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The Tips library (the Stack Planning design's Tips tab): Claude recipes —
-- prompts that worked, kept with the context of WHEN to reach for them.
-- App-wide by design (one library, every project's Tips tab reads it); Run
-- hands the prompt to a claude session in that project via the terminal's
-- one-shot brief handoff, so a recipe is runnable in place without any API.
CREATE TABLE IF NOT EXISTS tips (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  stage       TEXT NOT NULL DEFAULT 'ship',   -- diverge | converge | judge | ship
  surface     TEXT NOT NULL DEFAULT '',       -- where it runs best (Polaris / Roadmap / …)
  blurb       TEXT NOT NULL DEFAULT '',       -- the one-line list-row pitch
  when_note   TEXT NOT NULL DEFAULT '',       -- when to reach for it
  prompt      TEXT NOT NULL,                  -- [square-bracket] slots are fill-ins
  best        JSONB NOT NULL DEFAULT '[]',    -- "works best when" lines
  who_note    TEXT NOT NULL DEFAULT '',       -- provenance — who kept it, where output lands
  pinned      BOOLEAN NOT NULL DEFAULT false, -- pinned recipes sort first
  uses        INTEGER NOT NULL DEFAULT 0,     -- bumped by POST /api/tips/:id/run
  last_run_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Starter kit: seeded exactly once. The settings flag — not table-emptiness —
-- guards it, so deleting every recipe never resurrects these on reboot.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS tips_seeded BOOLEAN NOT NULL DEFAULT false;
DO $$
BEGIN
  IF NOT (SELECT tips_seeded FROM settings WHERE id) THEN
    INSERT INTO tips (name, stage, surface, blurb, when_note, prompt, best, who_note, pinned) VALUES
    ('Stress-test this plan', 'judge', 'Polaris', 'Find where the plan breaks before the plan breaks',
     'Before a plan leaves the room. Claude argues against it once, hard, so the first objection you hear is not in the review.',
     'Read [the current plan] and the [north star]. Give me the three ways this fails in the next quarter, ranked by how likely they are. For each: the earliest signal we would see, and the cheapest thing we could do now to find out. No reassurance.',
     '["The plan is written down — a vague plan gets vague objections.", "You name the horizon. Next quarter beats eventually.", "You ask for the signal, not just the risk — that is the part you can act on."]'::jsonb,
     'Starter recipe. Point it at a roadmap item''s plan steps, or the whole board, before tickets harden.', true),
    ('Judge against the north star', 'judge', 'Polaris', 'One verdict per idea, with the reason in one sentence',
     'When the funnel has more ideas than opinions. You keep the override; Claude just makes sure nothing sits unjudged.',
     'For each unjudged idea in [the funnel], decide: on course, off course, or too early — measured only against [the north star], not against how good the idea is. One sentence of reasoning each. Flag any idea where the north star does not actually settle it.',
     '["You separate good idea from on course in the instruction — they get conflated otherwise.", "You ask it to flag the undecidable ones; those are the ones worth your time.", "Your north star is one sentence. If it is a paragraph, the verdicts get mushy."]'::jsonb,
     'Starter recipe. Verdicts stay yours — the judge queue takes an override in one click.', false),
    ('Find the missing work', 'ship', 'Roadmap', 'The tickets nobody wrote because everyone assumed someone had',
     'Right after a plan turns into roadmap items. Claude reads the plan and the board side by side and reports the gap.',
     'Compare [the plan] to [the open roadmap]. List work the plan implies that has no item. Include the boring kinds — migrations, docs, rollback, monitoring. For each, say which existing item it blocks or is blocked by.',
     '["You name the boring categories explicitly — otherwise you only get feature work.", "You ask for the dependency, so the new items land in the right bucket.", "You run it again after scope changes, not once."]'::jsonb,
     'Starter recipe. Run it after a plan night lands its design sections.', true),
    ('Write the handoff', 'ship', 'Roadmap', 'Context an agent — or a person — can start from cold',
     'Before an item goes to an overnight session. Most agent failures are missing context, not missing capability.',
     'Write the starting brief for [this roadmap item] as if the reader has never seen this repo. Include: what exists already, the files it will touch, the one decision that was made and must not be relitigated, and what done looks like. Cut anything you cannot ground in the plan or the code.',
     '["You name the settled decision explicitly — agents relitigate what you leave open.", "You define done in the brief, not in review.", "You tell it to cut ungrounded claims, or it will invent a helpful-sounding file path."]'::jsonb,
     'Starter recipe. The output belongs in the item''s note — the autopilot folds it into its session prompt.', false),
    ('What did we decide?', 'converge', 'Notes', 'Pull the decisions out of a long session, with what changed',
     'End of a working session, before the context is gone. The output is the thing you keep while you can still correct it.',
     'Read back over [this session]. List only decisions that were actually made — not options discussed. For each: what was decided, and what is now true that was not true before. Then list the open questions nobody closed.',
     '["You force the decision/option split, or you get a summary instead of a record.", "You ask for the open questions in the same pass — they are the agenda for next time.", "A /checkpoint straight after keeps the record on the activity feed."]'::jsonb,
     'Starter recipe. Pairs with /checkpoint — decisions land in the summary, open questions as next steps.', false),
    ('Argue the other side', 'diverge', 'Polaris', 'A real counter-case, not a list of caveats',
     'When you agree with yourself too fast. Claude takes the opposite position and makes the best version of it.',
     'I have converged on [the current direction]. Make the strongest case for the opposite. Argue it as someone who believes it — no hedging, no on-the-other-hand. Then say what would have to be true for that case to win.',
     '["You ban hedging in the prompt, or you get a balanced summary of both sides.", "You ask what would have to be true — that turns an argument into a test.", "You run it before the plan hardens, not after items exist."]'::jsonb,
     'Starter recipe. Solo planning''s missing colleague.', false),
    ('Seed the funnel', 'diverge', 'Polaris', 'Fifteen starting ideas so nobody stares at an empty sky',
     'Minute one of planning something new. Disposable by design — the ideas exist to be disagreed with.',
     'We are planning [the topic]. Give me 15 short ideas for the funnel: 5 things that will obviously be needed, 5 that are usually forgotten, 5 that are questions rather than answers. One line each. Do not rank them.',
     '["You ask for questions as well as answers — a funnel of answers converges too early.", "You forbid ranking; ordering is the judge queue''s job.", "You treat the output as disposable. Dismissing ten of fifteen is a good session."]'::jsonb,
     'Starter recipe. Ideas land on the Polaris sky as futures — judge them against the star after.', false);
    UPDATE settings SET tips_seeded = true WHERE id;
  END IF;
END $$;

-- (#270) Dispatcher heartbeat — the host's every-minute GET /next poll stamps
-- this singleton. Freshness is the ONLY honest signal that the automation loop
-- is alive: the arm switch says what should happen, the heartbeat says whether
-- anything is asking. A dispatcher that stopped polling (cron removed, host
-- rebooted, node missing) must not read as calm on Mission Control.
CREATE TABLE IF NOT EXISTS dispatcher_heartbeat (
  id           BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  last_poll_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  host_local   TEXT NOT NULL DEFAULT ''   -- the host clock the dispatcher reported
);
INSERT INTO dispatcher_heartbeat (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- (#208) Branch previews — a mirror site for pushed work. The point is to LOOK
-- at a branch running before deciding on it, without merging it first.
--
-- One row per preview. The host dispatcher does the work (only it can reach
-- docker and the repo); the server holds the state and the URL, so a preview
-- survives a browser reload, a dispatcher restart and a host reboot.
--
-- Reachability is the whole design constraint here. This host has exactly one
-- public entry — projects.bkos.dev via a token-managed Cloudflare Tunnel to
-- port 8787 — no wildcard DNS, and the tunnel's ingress lives in Cloudflare's
-- dashboard rather than a file we can edit. Serving previews under a path on
-- that origin would break every app whose assets are root-absolute. So each
-- preview gets its OWN ephemeral `cloudflared tunnel --url` quick tunnel: a
-- random *.trycloudflare.com hostname, served at the ROOT path, needing no DNS
-- record and no dashboard access.
--
-- That URL is PUBLIC and unauthenticated for as long as it lives — it is
-- unguessable, never listed, and expires, but it is not access-controlled.
-- expires_at is therefore not tidiness, it is the safety property: the sweep
-- tears a preview down when it passes, so an abandoned preview cannot sit
-- exposed indefinitely.
CREATE TABLE IF NOT EXISTS previews (
  id            BIGSERIAL PRIMARY KEY,
  project_id    BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch        TEXT NOT NULL,
  item_id       BIGINT,                          -- the roadmap item the branch builds, when known
  -- queued → starting → live → stopping → stopped | failed
  status        TEXT NOT NULL DEFAULT 'queued',
  url           TEXT NOT NULL DEFAULT '',        -- the quick tunnel's public URL, once it exists
  detail        TEXT NOT NULL DEFAULT '',        -- progress line / failure reason, for the UI
  port          INTEGER,                         -- host port the preview stack publishes
  compose_project TEXT NOT NULL DEFAULT '',      -- namespaces its containers AND its volumes
  worktree      TEXT NOT NULL DEFAULT '',        -- throwaway checkout, removed on teardown
  tunnel_pid    INTEGER,                         -- the detached cloudflared
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,                     -- the safety property, not tidiness
  stopped_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS previews_project_idx ON previews (project_id, created_at DESC);
-- One LIVE preview per branch. A second request for a branch already previewed
-- returns the existing row rather than racing a duplicate stack onto the host.
CREATE UNIQUE INDEX IF NOT EXISTS previews_open_idx
  ON previews (project_id, branch)
  WHERE status IN ('queued', 'starting', 'live');

-- ---------------------------------------------------------------------------
-- The SKILL TREE (roadmap #228 — note that CLAUDE.md's older `#228` references
-- are to session kinds; that numbering is stale, this table is the skill tree).
--
-- A managed library of Claude Code skills that Stack owns, so how Claude works
-- across the fleet is tuned from one place instead of by hand-editing files on
-- the host. The server cannot see ~/.claude — it runs in a container, and the
-- skills live on the host behind the firewall — so this follows the PREVIEW
-- pattern (#208) rather than pretending otherwise: the server holds the library
-- and the intent, the HOST does the writing, and the host reports back what is
-- actually on disk. `installed_at` is therefore a fact reported by the host,
-- never something the server sets when it saves a row.
CREATE TABLE IF NOT EXISTS skills (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,                    -- kebab-case; it IS the directory name
  scope        TEXT NOT NULL DEFAULT 'global',   -- global (~/.claude) | project (<repo>/.claude)
  project_id   BIGINT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL for global
  description  TEXT NOT NULL DEFAULT '',         -- the frontmatter line that decides relevance
  body         TEXT NOT NULL DEFAULT '',         -- the markdown under the frontmatter
  enabled      BOOLEAN NOT NULL DEFAULT true,    -- off = the host REMOVES it from disk
  installed_at TIMESTAMPTZ,                      -- when the host last wrote this exact content
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One skill of a given name per PLACE. Two partial indexes rather than one
-- UNIQUE (scope, project_id, name), because in Postgres NULLs are distinct —
-- a plain unique constraint would let 'review' be created twice globally.
CREATE UNIQUE INDEX IF NOT EXISTS skills_global_name_idx
  ON skills (name) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS skills_project_name_idx
  ON skills (project_id, name) WHERE scope = 'project';

-- What the host actually has on disk, replaced whole on each sync — the same
-- shape of arrangement as branch_reports (#207). Single row: the skill tree
-- describes ONE host, the one the dispatcher runs on.
CREATE TABLE IF NOT EXISTS skill_reports (
  only_row    BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (only_row),
  report      JSONB NOT NULL DEFAULT '[]',       -- [{name, scope, slug, path, managed, description, body}]
  detail      TEXT NOT NULL DEFAULT '',          -- what the last sync did, for the UI
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- THE TAB AGENTS (#361) — per-agent configuration for Stack's three in-app
-- specialists (Auditor · Quality, Curator · Roadmap, Polaris · Futures).
--
-- The REGISTRY is code (server/src/agents.js): which agents exist, which tab
-- each is bound to and which ops it owns are not data and must not become
-- data — they are the restriction the item asks for, and a row that could
-- widen an agent's op list would be a row that could unbind it from its tab.
-- This table holds only what the owner tunes from Mission Control → Agents.
--
-- A MISSING ROW MEANS ON, with the registry's defaults. Same direction as
-- readSettings(): these agents are how three tabs already work, so a fresh
-- deploy must degrade to working rather than to silently dead ✧ buttons.
-- Only an explicit switch-off switches one off.
CREATE TABLE IF NOT EXISTS agent_configs (
  key          TEXT PRIMARY KEY,                 -- registry key: auditor | curator | polaris
  enabled      BOOLEAN NOT NULL DEFAULT true,    -- off = the agent refuses every op, 409
  model        TEXT NOT NULL DEFAULT '',         -- Claude alias override (#364); '' = the CLI's own
  guidance     TEXT NOT NULL DEFAULT '',         -- the owner's standing steer, prefixed to every prompt
  ops_off      JSONB NOT NULL DEFAULT '[]',      -- op names this agent may not run (subset of its own)
  runs         INTEGER NOT NULL DEFAULT 0,       -- how many times it has been asked
  last_run_at  TIMESTAMPTZ,
  last_op      TEXT NOT NULL DEFAULT '',
  last_outcome TEXT NOT NULL DEFAULT '',         -- 'ok' or the error — an agent that keeps failing says so
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- #364 — what an agent has spent, accumulated. The agents run Claude on the
-- host through the CLI, which reports the cost of every run, and this is the
-- only place the owner can see what the ✧ buttons cost. NUMERIC, so it comes
-- back from pg as a STRING and needs Number() on the way out.
ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS cost_usd NUMERIC NOT NULL DEFAULT 0;
