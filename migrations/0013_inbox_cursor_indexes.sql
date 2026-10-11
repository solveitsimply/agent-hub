-- Add chat/cursor seeks without rewriting messages or retained delivery IDs.
CREATE INDEX messages_to_session_delivery ON messages(to_session_id,delivery_id);
CREATE INDEX messages_from_session_delivery ON messages(from_session_id,delivery_id);
