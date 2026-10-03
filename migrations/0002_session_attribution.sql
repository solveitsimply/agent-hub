CREATE TABLE session_attribution_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  UNIQUE(session_id, idempotency_key)
);
CREATE INDEX attribution_session_order ON session_attribution_segments(session_id, id);
