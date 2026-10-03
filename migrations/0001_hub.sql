PRAGMA foreign_keys = ON;
CREATE TABLE principals (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, account TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','agent')),
  token_hash TEXT NOT NULL UNIQUE, projects_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL
);
INSERT INTO principals VALUES ('owner','Workspace owner','Owner','owner','reserved-owner-hash','["*"]',1,'2026-10-03T00:00:00.000Z');
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id),
  external_id TEXT NOT NULL, machine TEXT NOT NULL, label TEXT NOT NULL,
  project TEXT NOT NULL, task TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RUNNING','WAITING_ON_USER','WAITING_ON_AGENT','BLOCKED','DONE')),
  environment TEXT, details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, archived_at TEXT,
  UNIQUE(principal_id,external_id)
);
CREATE INDEX sessions_project_seen ON sessions(project,archived_at,last_seen_at);
CREATE INDEX sessions_principal_active ON sessions(principal_id,archived_at);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_principal_id TEXT NOT NULL REFERENCES principals(id),
  to_principal_id TEXT NOT NULL REFERENCES principals(id),
  from_session_id TEXT REFERENCES sessions(id), to_session_id TEXT REFERENCES sessions(id),
  project TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('NOTE','HANDOFF','QUESTION','ANSWER')),
  body TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
  reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, acknowledged_at TEXT,
  CHECK(from_session_id IS NOT NULL OR to_session_id IS NOT NULL),
  UNIQUE(from_principal_id,idempotency_key)
);
CREATE INDEX messages_from_session ON messages(from_session_id,id);
CREATE INDEX messages_to_session ON messages(to_session_id,id);
CREATE INDEX messages_created ON messages(created_at);
CREATE TABLE ownership (
  project TEXT NOT NULL, resource_key TEXT NOT NULL,
  owner_session_id TEXT NOT NULL REFERENCES sessions(id), claimed_at TEXT NOT NULL,
  PRIMARY KEY(project,resource_key)
);
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, principal_id TEXT NOT NULL REFERENCES principals(id),
  action TEXT NOT NULL, target_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX audit_created ON audit_events(created_at);
