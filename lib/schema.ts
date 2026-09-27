// Database schema, applied automatically (idempotent) on first use.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT,
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  low_stock_days  INTEGER NOT NULL DEFAULT 3,
  -- Recommendations accepted from suggestions; shown as "Recommended", never pre-selected.
  prefs           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connected_accounts (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform         TEXT NOT NULL CHECK (platform IN ('youtube', 'instagram')),
  external_id      TEXT NOT NULL,
  name             TEXT NOT NULL,
  access_token     TEXT,            -- encrypted
  refresh_token    TEXT,            -- encrypted
  token_expires_at TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'needs_reconnect')),
  -- Cached audience data for best-time planning (history, online followers, ...)
  meta             JSONB NOT NULL DEFAULT '{}'::jsonb,
  meta_updated_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, external_id)
);

CREATE TABLE IF NOT EXISTS source_videos (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  duration      DOUBLE PRECISION NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('automation', 'manual')),
  account_ids   TEXT[] NOT NULL DEFAULT '{}',   -- target accounts (Automation mode)
  clip_length   INTEGER NOT NULL,
  format        TEXT NOT NULL CHECK (format IN ('original', 'vertical')),
  posts_per_day INTEGER,
  title         TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  hashtags      TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clips (
  id              TEXT PRIMARY KEY,
  source_video_id TEXT NOT NULL REFERENCES source_videos(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idx             INTEGER NOT NULL,
  storage_key     TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  duration        DOUBLE PRECISION NOT NULL,
  width           INTEGER,
  height          INTEGER,
  start_sec       DOUBLE PRECISION NOT NULL,
  content_type    TEXT NOT NULL DEFAULT 'video/mp4',
  status          TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready', 'scheduled', 'posted', 'deleted')),
  delete_after    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS posts (
  id                TEXT PRIMARY KEY,
  clip_id           TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  account_id        TEXT NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform          TEXT NOT NULL,
  scheduled_at      TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'uploading', 'processing', 'published', 'failed', 'needs_attention', 'cancelled')),
  title             TEXT NOT NULL,
  caption           TEXT NOT NULL,
  external_id       TEXT,            -- YouTube video id / Instagram media id
  container_id      TEXT,            -- Instagram container while processing
  processing_started_at TIMESTAMPTZ,
  permalink         TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  next_attempt_at   TIMESTAMPTZ,
  locked_until      TIMESTAMPTZ,
  published_at      TIMESTAMPTZ,
  metrics_stage     INTEGER NOT NULL DEFAULT 0,
  next_metrics_at   TIMESTAMPTZ,
  idempotency_key   TEXT NOT NULL UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_due_idx ON posts (status, scheduled_at);
CREATE INDEX IF NOT EXISTS posts_account_idx ON posts (account_id, scheduled_at);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id             TEXT PRIMARY KEY,
  post_id        TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  hours_after    INTEGER NOT NULL,
  taken_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  views          INTEGER,
  likes          INTEGER,
  comments       INTEGER,
  shares         INTEGER,
  saves          INTEGER,
  reach          INTEGER,
  avg_watch_sec  DOUBLE PRECISION,
  UNIQUE (post_id, hours_after)
);

CREATE TABLE IF NOT EXISTS suggestions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id      TEXT REFERENCES connected_accounts(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  evidence        TEXT NOT NULL,
  change_summary  TEXT NOT NULL,
  proposed_change JSONB NOT NULL DEFAULT '{}'::jsonb,
  applied_state   JSONB,           -- what was changed, so it can be undone
  can_apply       BOOLEAN NOT NULL DEFAULT true,
  status          TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'rejected', 'undone', 'dismissed')),
  dedupe_key      TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  key      TEXT PRIMARY KEY,         -- makes every email send-once
  user_id  TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_runs (
  name     TEXT PRIMARY KEY,         -- periodic jobs (daily refreshes) remember when they last ran
  last_run TIMESTAMPTZ NOT NULL
);

-- Added later (idempotent): optimized titles/captions/tags.
ALTER TABLE source_videos ADD COLUMN IF NOT EXISTS seo_mode TEXT NOT NULL DEFAULT 'as_written';
ALTER TABLE source_videos ADD COLUMN IF NOT EXISTS topic TEXT NOT NULL DEFAULT '';
ALTER TABLE source_videos ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT '';
ALTER TABLE clips ADD COLUMN IF NOT EXISTS seo JSONB;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS tags TEXT[];

-- Who may sign in: the admin approves requests in the Admin panel (ADMIN_EMAIL is always allowed).
CREATE TABLE IF NOT EXISTS access_list (
  email        TEXT PRIMARY KEY,
  status       TEXT NOT NULL CHECK (status IN ('approved', 'pending', 'blocked')),
  name         TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ,
  decided_by   TEXT
);
`;
