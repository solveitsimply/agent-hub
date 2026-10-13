-- Snapshot lifetime policy at consent; never extend an existing grant.
-- Legacy requests/grants retain their original seven-day maximum and expiry.
ALTER TABLE mcp_oauth_requests ADD COLUMN max_age_seconds INTEGER NOT NULL DEFAULT 604800
  CHECK(typeof(max_age_seconds)='integer' AND max_age_seconds BETWEEN 86400 AND 7776000);
ALTER TABLE mcp_oauth_requests ADD COLUMN idle_seconds INTEGER NOT NULL DEFAULT 604800
  CHECK(typeof(idle_seconds)='integer' AND idle_seconds BETWEEN 86400 AND 2592000 AND idle_seconds<=max_age_seconds);
ALTER TABLE mcp_oauth_grants ADD COLUMN idle_seconds INTEGER NOT NULL DEFAULT 604800
  CHECK(typeof(idle_seconds)='integer' AND idle_seconds BETWEEN 86400 AND 2592000);
