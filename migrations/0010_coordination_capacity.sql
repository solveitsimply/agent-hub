-- Materialize capacity accounting so admission never scans retained messages.
CREATE INDEX messages_reply ON messages(reply_to);
CREATE INDEX sessions_principal_external_normalized ON sessions(principal_id,lower(external_id));
CREATE TABLE hub_message_storage (
  id INTEGER PRIMARY KEY CHECK(id=1),
  messages INTEGER NOT NULL DEFAULT 0 CHECK(messages>=0),
  body_bytes INTEGER NOT NULL DEFAULT 0 CHECK(body_bytes>=0)
);
INSERT INTO hub_message_storage SELECT 1,COUNT(*),COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM messages;
CREATE TABLE hub_message_usage (
  scope TEXT NOT NULL CHECK(scope IN ('workspace','principal','session')),
  scope_id TEXT NOT NULL,
  day TEXT NOT NULL,
  messages INTEGER NOT NULL CHECK(messages>=0),
  PRIMARY KEY(scope,scope_id,day)
);
INSERT INTO hub_message_usage SELECT 'workspace','*',substr(created_at,1,10),COUNT(*) FROM messages GROUP BY substr(created_at,1,10);
INSERT INTO hub_message_usage SELECT 'principal',from_principal_id,substr(created_at,1,10),COUNT(*) FROM messages GROUP BY from_principal_id,substr(created_at,1,10);
INSERT INTO hub_message_usage SELECT 'session',from_session_id,substr(created_at,1,10),COUNT(*) FROM messages WHERE from_session_id IS NOT NULL GROUP BY from_session_id,substr(created_at,1,10);
CREATE TRIGGER hub_message_insert AFTER INSERT ON messages BEGIN
  UPDATE hub_message_storage SET messages=messages+1,body_bytes=body_bytes+length(CAST(NEW.body AS BLOB)) WHERE id=1;
  INSERT INTO hub_message_usage VALUES ('workspace','*',substr(NEW.created_at,1,10),1)
    ON CONFLICT(scope,scope_id,day) DO UPDATE SET messages=messages+1;
  INSERT INTO hub_message_usage VALUES ('principal',NEW.from_principal_id,substr(NEW.created_at,1,10),1)
    ON CONFLICT(scope,scope_id,day) DO UPDATE SET messages=messages+1;
  INSERT INTO hub_message_usage SELECT 'session',NEW.from_session_id,substr(NEW.created_at,1,10),1 WHERE NEW.from_session_id IS NOT NULL
    ON CONFLICT(scope,scope_id,day) DO UPDATE SET messages=messages+1;
END;
CREATE TRIGGER hub_message_delete AFTER DELETE ON messages BEGIN
  UPDATE hub_message_storage SET messages=messages-1,body_bytes=body_bytes-length(CAST(OLD.body AS BLOB)) WHERE id=1;
END;
CREATE TRIGGER hub_message_body_update AFTER UPDATE OF body ON messages BEGIN
  UPDATE hub_message_storage SET body_bytes=body_bytes+length(CAST(NEW.body AS BLOB))-length(CAST(OLD.body AS BLOB)) WHERE id=1;
END;
-- Original sessions and messages remain immutable history. Old IDs resolve to
-- their canonical registration; no message IDs or delivery cursors are changed.
CREATE TABLE session_aliases (
  alias_session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  canonical_session_id TEXT NOT NULL REFERENCES sessions(id),
  merged_at TEXT NOT NULL,
  merged_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  source_snapshot_json TEXT NOT NULL,
  target_snapshot_json TEXT NOT NULL,
  CHECK(alias_session_id<>canonical_session_id)
);
CREATE INDEX session_aliases_canonical ON session_aliases(canonical_session_id);
