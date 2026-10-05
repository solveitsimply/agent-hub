-- Existing credentials retain their permissions. The owner explicitly grants
-- coordinator access; identity, projects, tokens and human receipt stay intact.
ALTER TABLE principals ADD COLUMN coordinator_access INTEGER NOT NULL DEFAULT 0
  CHECK(coordinator_access IN (0,1));
ALTER TABLE messages ADD COLUMN owner_relay_reference TEXT;
