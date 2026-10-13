-- Optional OAuth transport. Existing agent identities and custody stay unchanged.
CREATE TABLE mcp_oauth_requests (
  id_hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL,
  client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT NOT NULL,
  scope TEXT NOT NULL, state TEXT NOT NULL, challenge TEXT NOT NULL,
  principal_id TEXT, credential_hash TEXT, session_id TEXT, project TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX mcp_requests_expiry ON mcp_oauth_requests(expires_at);
CREATE TABLE mcp_oauth_grants (
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id),
  credential_hash TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id),
  project TEXT NOT NULL, client_id TEXT NOT NULL, resource TEXT NOT NULL,
  scope TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX mcp_grants_principal ON mcp_oauth_grants(principal_id, expires_at);
CREATE TABLE mcp_oauth_tokens (
  token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('code','access','refresh')),
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, consumed_by TEXT, redirect_uri TEXT, challenge TEXT
);
CREATE INDEX mcp_tokens_grant ON mcp_oauth_tokens(grant_id);
CREATE INDEX mcp_tokens_expiry ON mcp_oauth_tokens(kind,expires_at);
CREATE INDEX mcp_tokens_grant_kind_created ON mcp_oauth_tokens(grant_id,kind,created_at);
CREATE INDEX mcp_grants_expiry ON mcp_oauth_grants(expires_at);
