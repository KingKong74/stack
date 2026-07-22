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
-- Autopilot night controls (Mission Control): the token budget per run
-- (0 = unlimited), the nightly start time (host-local HH:MM — the dispatcher
-- supplies its own local clock, so the server's TZ never matters) and how
-- many items a night may attempt.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS autopilot_tokens    BIGINT  NOT NULL DEFAULT 1500000;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS autopilot_time      TEXT    NOT NULL DEFAULT '23:05';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS autopilot_max_items INTEGER NOT NULL DEFAULT 3;
-- Dual-model autopilot (#153): the EXECUTOR model runs the unattended session
-- (claude --model; '' = the CLI's default) while the ADVISOR — a stronger
-- model — is exposed to it as a read-only subagent it consults for plans and
-- unblocking ('' = no advisor, single-model session as before). Model values
-- are claude CLI aliases (haiku | sonnet | opus | fable).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS autopilot_executor_model TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS autopilot_advisor_model  TEXT NOT NULL DEFAULT '';
-- ✧ Fill from note (#131): a standing guidance line folded into the assist
-- prompt, and which fields the assist is allowed to fill (title always is).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS assist_guidance TEXT  NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS assist_fields   JSONB NOT NULL DEFAULT '["title","note","area","lane","priority"]'::jsonb;

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
CREATE INDEX IF NOT EXISTS autopilot_jobs_status_idx ON autopilot_jobs (status, created_at);
-- #142 — a limit-paused session becomes a durable `resume` job instead of a
-- detached sleep on the host: not_before is the earliest hand-out time (the
-- limit reset). GET /next skips queued jobs before it; a human can clear it
-- (▶ Resume now), hold the job (status 'paused' — hang up) or dismiss it.
ALTER TABLE autopilot_jobs ADD COLUMN IF NOT EXISTS not_before TIMESTAMPTZ;

-- Audit area (#143, named by #145): a check can exercise a function of the app, not just
-- probe a page — request method + optional body, plus a JSON-path assertion
-- on the response ("$.status" should equal "ok"). GET probes are unchanged.
ALTER TABLE checks ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'GET';
ALTER TABLE checks ADD COLUMN IF NOT EXISTS req_body TEXT;
ALTER TABLE checks ADD COLUMN IF NOT EXISTS json_path TEXT;
ALTER TABLE checks ADD COLUMN IF NOT EXISTS json_expect TEXT;

-- Audit tab run history: one row per Run-all (or run-one) of a project's
-- checks — the dashboard's trend strip and last-run stats read from it.
-- Summary only; per-check results stay on the checks rows themselves.
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
