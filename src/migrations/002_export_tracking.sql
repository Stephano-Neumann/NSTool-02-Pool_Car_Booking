-- Change tracking for the Data Export API (incremental loads into Fabric).
-- Mutable tables get updated_at (kept current by triggers); deletions are recorded in deleted_records.

CREATE TABLE deleted_records (
  id          INTEGER PRIMARY KEY,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  deleted_at  TEXT NOT NULL
);

ALTER TABLE users ADD COLUMN updated_at TEXT;
ALTER TABLE vehicles ADD COLUMN updated_at TEXT;
ALTER TABLE bookings ADD COLUMN updated_at TEXT;
ALTER TABLE admin_profiles ADD COLUMN updated_at TEXT;
ALTER TABLE company_vehicles ADD COLUMN updated_at TEXT;
ALTER TABLE company_allocations ADD COLUMN updated_at TEXT;
ALTER TABLE prestarts ADD COLUMN updated_at TEXT;

UPDATE users SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
UPDATE vehicles SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
UPDATE bookings SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
UPDATE admin_profiles SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
UPDATE company_vehicles SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
UPDATE company_allocations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
UPDATE prestarts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- INSERT triggers
CREATE TRIGGER users_ai AFTER INSERT ON users BEGIN UPDATE users SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER vehicles_ai AFTER INSERT ON vehicles BEGIN UPDATE vehicles SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER bookings_ai AFTER INSERT ON bookings BEGIN UPDATE bookings SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER admin_profiles_ai AFTER INSERT ON admin_profiles BEGIN UPDATE admin_profiles SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER company_vehicles_ai AFTER INSERT ON company_vehicles BEGIN UPDATE company_vehicles SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER company_allocations_ai AFTER INSERT ON company_allocations BEGIN UPDATE company_allocations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER prestarts_ai AFTER INSERT ON prestarts BEGIN UPDATE prestarts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

-- UPDATE triggers (users: login bookkeeping and password changes do not count as data changes)
CREATE TRIGGER users_au AFTER UPDATE OF email, name, role, licence, active, policy_ack_at ON users
  BEGIN UPDATE users SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER vehicles_au AFTER UPDATE OF rego, model, archived, archived_at ON vehicles
  BEGIN UPDATE vehicles SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER bookings_au AFTER UPDATE ON bookings WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE bookings SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER admin_profiles_au AFTER UPDATE ON admin_profiles WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE admin_profiles SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER company_vehicles_au AFTER UPDATE ON company_vehicles WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE company_vehicles SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER company_allocations_au AFTER UPDATE ON company_allocations WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE company_allocations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER prestarts_au AFTER UPDATE ON prestarts WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE prestarts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

-- DELETE triggers: tombstones so the lake can remove rows that no longer exist
CREATE TRIGGER bookings_ad AFTER DELETE ON bookings BEGIN
  INSERT INTO deleted_records (entity, entity_id, deleted_at) VALUES ('bookings', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;
CREATE TRIGGER admin_profiles_ad AFTER DELETE ON admin_profiles BEGIN
  INSERT INTO deleted_records (entity, entity_id, deleted_at) VALUES ('admin_profiles', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;
CREATE TRIGGER company_vehicles_ad AFTER DELETE ON company_vehicles BEGIN
  INSERT INTO deleted_records (entity, entity_id, deleted_at) VALUES ('company_vehicles', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;
CREATE TRIGGER company_allocations_ad AFTER DELETE ON company_allocations BEGIN
  INSERT INTO deleted_records (entity, entity_id, deleted_at) VALUES ('company_allocations', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;
