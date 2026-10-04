ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN checkpoint_json TEXT;
ALTER TABLE sessions ADD COLUMN checkpoint_at TEXT;
ALTER TABLE sessions ADD COLUMN closeout_json TEXT;
CREATE TRIGGER session_material_revision AFTER UPDATE OF status,task,label ON sessions
WHEN OLD.status IS NOT NEW.status OR OLD.task IS NOT NEW.task OR OLD.label IS NOT NEW.label
BEGIN UPDATE sessions SET revision=revision+1 WHERE id=NEW.id; END;

-- Observer credentials cannot authenticate as a principal or read inboxes.
CREATE TABLE observers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE observer_sessions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  observer_id TEXT NOT NULL REFERENCES observers(id), native_id TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT -1, state TEXT, goal_state TEXT,
  observed_at TEXT, received_at TEXT,
  UNIQUE(observer_id,native_id)
);
CREATE TABLE accountability_policies (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  check_in_enabled INTEGER NOT NULL DEFAULT 0,
  grace_seconds INTEGER NOT NULL DEFAULT 300,
  daily_limit INTEGER NOT NULL DEFAULT 1,
  escalation_seconds INTEGER NOT NULL DEFAULT 900,
  updated_at TEXT NOT NULL
);
CREATE TABLE session_check_ins (
  session_id TEXT NOT NULL REFERENCES sessions(id), revision INTEGER NOT NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, resolved_at TEXT,
  PRIMARY KEY(session_id,revision)
);
CREATE INDEX check_ins_created ON session_check_ins(created_at);
INSERT INTO principals VALUES ('hub-accountability','Hub accountability','Coordination service','agent','reserved-accountability-no-login','[]',1,'2026-10-03T00:00:00.000Z');
