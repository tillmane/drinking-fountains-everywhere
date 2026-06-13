CREATE TABLE IF NOT EXISTS fountains (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lat        REAL    NOT NULL,
  lon        REAL    NOT NULL,
  name       TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS fountain_sources (
  fountain_id  INTEGER NOT NULL REFERENCES fountains(id),
  source_type  TEXT    NOT NULL CHECK (source_type IN ('osm', 'city_gis')),
  source_id    TEXT    NOT NULL,
  PRIMARY KEY (fountain_id, source_type, source_id)
);

CREATE TABLE IF NOT EXISTS ratings (
  fountain_id  INTEGER NOT NULL REFERENCES fountains(id),
  device_id    TEXT    NOT NULL,
  score        INTEGER NOT NULL CHECK (score IN (0, 1)),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (fountain_id, device_id)
);

CREATE TABLE IF NOT EXISTS status_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  fountain_id  INTEGER NOT NULL REFERENCES fountains(id),
  device_id    TEXT    NOT NULL,
  status       TEXT    NOT NULL CHECK (status IN ('off', 'on')),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS fountain_attributes (
  fountain_id    INTEGER NOT NULL REFERENCES fountains(id),
  attribute      TEXT    NOT NULL CHECK (attribute IN ('accessible', 'bottle_filler', 'dog_bowl')),
  value          INTEGER NOT NULL CHECK (value IN (0, 1)),
  device_id      TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (fountain_id, attribute)
);

CREATE TABLE IF NOT EXISTS not_found_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  fountain_id  INTEGER NOT NULL REFERENCES fountains(id),
  device_id    TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (fountain_id, device_id)
);

CREATE TABLE IF NOT EXISTS request_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint     TEXT    NOT NULL,
  fountain_id  INTEGER,
  device_pfx   TEXT,
  status       INTEGER NOT NULL,
  ms           INTEGER NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ratings_fountain ON ratings(fountain_id);
CREATE INDEX IF NOT EXISTS idx_fountain_sources_lookup ON fountain_sources(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_status_reports_fountain ON status_reports(fountain_id, created_at);
CREATE INDEX IF NOT EXISTS idx_not_found_fountain ON not_found_reports(fountain_id);
CREATE INDEX IF NOT EXISTS idx_request_log_fountain ON request_log(fountain_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_log_created ON request_log(created_at);
