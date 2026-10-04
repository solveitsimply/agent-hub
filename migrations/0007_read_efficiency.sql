-- Index existing custody and accountability reads without changing their scope.
CREATE INDEX ownership_owner_session ON ownership(owner_session_id);
CREATE INDEX messages_recipient_delivery ON messages(to_principal_id,delivery_id);
CREATE INDEX check_ins_session_created ON session_check_ins(session_id,created_at);
CREATE INDEX accountability_policies_enabled ON accountability_policies(check_in_enabled,session_id);
