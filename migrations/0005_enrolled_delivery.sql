-- Enrollment authorizes scoped coordination, never human approval of content.
-- Release only pending history whose exact session/principal/project custody
-- is still valid. Explicit rejections and inactive history remain undelivered.
UPDATE messages SET review_state='APPROVED',reviewed_at=NULL
WHERE review_state='PENDING'
  AND EXISTS (SELECT 1 FROM principals p WHERE p.id=messages.from_principal_id AND p.active=1
    AND (p.role='owner' OR EXISTS (SELECT 1 FROM json_each(p.projects_json) WHERE value=messages.project)))
  AND EXISTS (SELECT 1 FROM principals p WHERE p.id=messages.to_principal_id AND p.active=1
    AND (p.role='owner' OR EXISTS (SELECT 1 FROM json_each(p.projects_json) WHERE value=messages.project)))
  AND ((from_session_id IS NULL AND from_principal_id='owner') OR EXISTS
    (SELECT 1 FROM sessions s WHERE s.id=messages.from_session_id AND s.principal_id=messages.from_principal_id
      AND s.project=messages.project AND s.archived_at IS NULL))
  AND ((to_session_id IS NULL AND to_principal_id='owner' AND kind='QUESTION') OR EXISTS
    (SELECT 1 FROM sessions s WHERE s.id=messages.to_session_id AND s.principal_id=messages.to_principal_id
      AND s.project=messages.project AND s.archived_at IS NULL));
-- Append newly admitted history above the preserved delivery high-water mark.
INSERT INTO message_deliveries(message_id)
  SELECT id FROM messages WHERE review_state='APPROVED' AND to_session_id IS NOT NULL AND delivery_id IS NULL
  ORDER BY id ON CONFLICT(message_id) DO NOTHING;
UPDATE messages SET delivery_id=(SELECT id FROM message_deliveries WHERE message_id=messages.id)
  WHERE review_state='APPROVED' AND to_session_id IS NOT NULL AND delivery_id IS NULL;
