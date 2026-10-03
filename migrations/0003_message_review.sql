-- Fail closed for historical agent-to-session messages: prior records carry
-- no independently authenticated delivery approval. Preserve their custody.
ALTER TABLE messages ADD COLUMN review_state TEXT NOT NULL DEFAULT 'PENDING'
  CHECK(review_state IN ('PENDING','APPROVED','REJECTED'));
ALTER TABLE messages ADD COLUMN reviewed_at TEXT;
ALTER TABLE messages ADD COLUMN delivery_id INTEGER;
UPDATE messages SET review_state='APPROVED',reviewed_at=created_at,delivery_id=id
  WHERE from_principal_id='owner';
CREATE TABLE message_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE
);
INSERT INTO message_deliveries(id,message_id)
  SELECT id,id FROM messages;
-- Reserve the entire legacy inbox high-water mark before removing undelivered
-- slots. New approvals then exceed even cursors held by pre-upgrade clients.
DELETE FROM message_deliveries WHERE message_id IN
  (SELECT id FROM messages WHERE review_state='PENDING');
CREATE UNIQUE INDEX messages_delivery_order ON messages(delivery_id);
CREATE INDEX messages_principal_created ON messages(from_principal_id,created_at);
CREATE INDEX messages_review_order ON messages(review_state,id);
CREATE INDEX attribution_principal_started ON session_attribution_segments(principal_id,started_at);
