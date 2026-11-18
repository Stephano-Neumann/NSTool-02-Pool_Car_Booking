-- Usage analytics carry the person's name and email as they were at the time, so the data reads on its own
-- in the lake without a join to users. Existing rows are filled in from users.
ALTER TABLE usage_sessions ADD COLUMN user_name  TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_sessions ADD COLUMN user_email TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_events   ADD COLUMN user_name  TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_events   ADD COLUMN user_email TEXT NOT NULL DEFAULT '';

-- Sessions also move their watermark so an incremental load picks up the new values.
UPDATE usage_sessions SET
  user_name  = COALESCE((SELECT name  FROM users WHERE users.id = usage_sessions.user_id), ''),
  user_email = COALESCE((SELECT email FROM users WHERE users.id = usage_sessions.user_id), ''),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
UPDATE usage_events SET
  user_name  = COALESCE((SELECT name  FROM users WHERE users.id = usage_events.user_id), ''),
  user_email = COALESCE((SELECT email FROM users WHERE users.id = usage_events.user_id), '');
