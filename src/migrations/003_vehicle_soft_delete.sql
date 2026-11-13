-- Soft delete for pool vehicles. A deleted vehicle keeps its row and every booking, trip log and
-- audit record that points at it; it is only flagged and hidden from the app.
ALTER TABLE vehicles ADD COLUMN deleted     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vehicles ADD COLUMN deleted_at  TEXT;
ALTER TABLE vehicles ADD COLUMN deleted_by  TEXT;

-- The export watermark must move when a vehicle is flagged as deleted, so the lake sees it.
DROP TRIGGER vehicles_au;
CREATE TRIGGER vehicles_au AFTER UPDATE OF rego, model, archived, archived_at, deleted, deleted_at, deleted_by ON vehicles
  BEGIN UPDATE vehicles SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
