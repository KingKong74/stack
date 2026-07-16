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
CREATE UNIQUE INDEX IF NOT EXISTS idx_futures_auto_fp
  ON futures (project_id, fingerprint) WHERE source = 'hook';
CREATE INDEX IF NOT EXISTS idx_futures_project ON futures (project_id, created_at DESC);

-- Per-project sticky notes.
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

-- Skip tag: parked roadmap items — planned but not to be picked up yet. They
-- sort to the bottom of their bucket and agents leave them alone; still count
-- toward progress (they remain planned work).
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS skipped BOOLEAN NOT NULL DEFAULT false;
