CREATE TABLE users (
  id             INTEGER PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin', 'driver')),
  licence        TEXT NOT NULL DEFAULT '',
  password_hash  TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  policy_ack_at  TEXT,
  created_at     TEXT NOT NULL,
  last_login_at  TEXT
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL
);

CREATE TABLE vehicles (
  id           INTEGER PRIMARY KEY,
  rego         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  model        TEXT NOT NULL,
  archived     INTEGER NOT NULL DEFAULT 0,
  archived_at  TEXT
);

CREATE TABLE bookings (
  id             INTEGER PRIMARY KEY,
  vehicle_id     INTEGER NOT NULL REFERENCES vehicles(id),
  user_id        INTEGER REFERENCES users(id),
  driver_name    TEXT NOT NULL,
  licence        TEXT NOT NULL,
  email          TEXT,
  department     TEXT NOT NULL,
  cost_centre    TEXT NOT NULL,
  use_type       TEXT NOT NULL CHECK (use_type IN ('Business', 'Private')),
  pickup         TEXT NOT NULL,
  ret            TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  created_at     TEXT NOT NULL,
  reviewed_at    TEXT,
  reviewed_by    INTEGER REFERENCES users(id),
  actual_pickup  TEXT,
  actual_return  TEXT,
  start_km       INTEGER,
  finish_km      INTEGER,
  start_notes    TEXT,
  finish_notes   TEXT,
  fuel_ok        INTEGER
);
CREATE INDEX idx_bookings_vehicle ON bookings(vehicle_id, pickup);
CREATE INDEX idx_bookings_user ON bookings(user_id);

CREATE TABLE admin_profiles (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  email  TEXT NOT NULL
);

CREATE TABLE alerts_log (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  booking_id  INTEGER,
  recipients  TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  sent_at     TEXT NOT NULL,
  delivered   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

CREATE TABLE policy_document (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  filename     TEXT NOT NULL,
  size         INTEGER NOT NULL,
  uploaded_at  TEXT NOT NULL,
  uploaded_by  INTEGER REFERENCES users(id),
  data         BLOB NOT NULL
);

CREATE TABLE company_vehicles (
  id               INTEGER PRIMARY KEY,
  rego             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  model            TEXT NOT NULL,
  due_service_km   INTEGER
);

CREATE TABLE company_allocations (
  id            INTEGER PRIMARY KEY,
  driver_name   TEXT NOT NULL,
  driver_email  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  vehicle_id    INTEGER NOT NULL REFERENCES company_vehicles(id) ON DELETE CASCADE
);

CREATE TABLE prestarts (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  month_key        TEXT NOT NULL,
  items            TEXT NOT NULL,
  notes            TEXT NOT NULL DEFAULT '',
  mex_number       TEXT NOT NULL DEFAULT '',
  fault_completed  INTEGER NOT NULL DEFAULT 0,
  submitted_at     TEXT NOT NULL,
  UNIQUE (user_id, month_key)
);

CREATE TABLE km_log (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  month_key     TEXT NOT NULL,
  odometer      INTEGER NOT NULL,
  submitted_at  TEXT NOT NULL,
  UNIQUE (user_id, month_key)
);

CREATE TABLE incidents (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  name           TEXT NOT NULL,
  licence        TEXT NOT NULL,
  email          TEXT NOT NULL,
  submitted_at   TEXT NOT NULL,
  description    TEXT NOT NULL,
  weather        TEXT NOT NULL DEFAULT '',
  weather_other  TEXT NOT NULL DEFAULT '',
  road_surface   TEXT NOT NULL DEFAULT '',
  speed_limit    TEXT NOT NULL DEFAULT '',
  visibility     TEXT NOT NULL DEFAULT '',
  third_party    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  detail     TEXT
);
