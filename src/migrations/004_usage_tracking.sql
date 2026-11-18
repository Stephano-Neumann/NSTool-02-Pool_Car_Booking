-- App usage analytics, loaded into Fabric through the Data Export API.
--
-- usage_sessions: one row per visit (a browser tab, from first screen to leaving). Time in the app is
--   active_seconds: only time with the page visible counts, sent by the browser every minute.
-- usage_events: append-only. 'view' = a screen was opened; 'action' = a change was made through the API
--   (method + path with ids replaced by :id, and the HTTP status, so failed attempts show too).
-- role is the account type at that moment (admin | driver); page is which site: 'user' (/) or 'admin' (/nsadmin).
-- Kept for USAGE_RETENTION_DAYS (default 365), then purged from the app; the lake keeps what it loaded.

CREATE TABLE usage_sessions (
  id              INTEGER PRIMARY KEY,
  session_key     TEXT NOT NULL UNIQUE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  page            TEXT NOT NULL CHECK (page IN ('user', 'admin')),
  device          TEXT NOT NULL CHECK (device IN ('desktop', 'mobile', 'tablet', 'other')),
  started_at      TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  ended_at        TEXT,
  active_seconds  INTEGER NOT NULL DEFAULT 0,
  views           INTEGER NOT NULL DEFAULT 0,
  actions         INTEGER NOT NULL DEFAULT 0,
  current_view    TEXT,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_usage_sessions_user ON usage_sessions(user_id, started_at);
CREATE INDEX idx_usage_sessions_seen ON usage_sessions(last_seen_at);

CREATE TABLE usage_events (
  id                INTEGER PRIMARY KEY,
  at                TEXT NOT NULL,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_session_id  INTEGER REFERENCES usage_sessions(id) ON DELETE SET NULL,
  role              TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('view', 'action')),
  name              TEXT NOT NULL,
  status            INTEGER,
  duration_ms       INTEGER
);
CREATE INDEX idx_usage_events_at ON usage_events(at);
CREATE INDEX idx_usage_events_user ON usage_events(user_id, at);
