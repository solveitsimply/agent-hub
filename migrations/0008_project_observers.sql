-- Existing invitations retain their authority. Observers get explicit project
-- conversation visibility without owner administration or recipient custody.
ALTER TABLE principals ADD COLUMN access_profile TEXT NOT NULL DEFAULT 'agent'
  CHECK(access_profile IN ('agent','observer'));
CREATE INDEX messages_project_id ON messages(project,id);
CREATE TABLE connection_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  connection_id TEXT NOT NULL,
  client TEXT NOT NULL CHECK(client IN ('web','cli','mcp','api')),
  connected_at TEXT NOT NULL,
  UNIQUE(principal_id,connection_id)
);
CREATE INDEX connections_principal_time ON connection_events(principal_id,connected_at);
CREATE INDEX connections_time ON connection_events(connected_at);
