-- Incident address, and photo attachments for incident reports and monthly prestart checks.
-- Photos are stored in the database (like the policy PDF) so they are backed up with everything else.

ALTER TABLE incidents ADD COLUMN address TEXT NOT NULL DEFAULT '';

CREATE TABLE photos (
  id          INTEGER PRIMARY KEY,
  owner_type  TEXT NOT NULL CHECK (owner_type IN ('incident', 'prestart')),
  owner_id    INTEGER NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  data        BLOB NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_photos_owner ON photos(owner_type, owner_id);
