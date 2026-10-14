-- Optional native delivery transport. No native authority, inbox or claim
-- custody is inherited from ordinary principals. Deployment defaults off.
CREATE TABLE native_relay_devices (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  project TEXT NOT NULL,
  public_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  peers_json TEXT NOT NULL,
  profiles_json TEXT NOT NULL,
  can_send INTEGER NOT NULL CHECK(can_send IN (0,1)),
  can_receive INTEGER NOT NULL CHECK(can_receive IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  expires_at INTEGER NOT NULL,
  info_json TEXT,
  info_expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE native_relay_requests (
  sender_id TEXT NOT NULL REFERENCES native_relay_devices(id),
  recipient_id TEXT NOT NULL REFERENCES native_relay_devices(id),
  request_id TEXT NOT NULL,
  native_request_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('inspect','prepare','deliver','receipt','acknowledge')),
  project TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT,
  reply_json TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','complete','expired')),
  claim_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(sender_id,recipient_id,request_id,operation)
);
CREATE INDEX native_relay_pending ON native_relay_requests(recipient_id,state,expires_at);
CREATE INDEX native_relay_sender_day ON native_relay_requests(sender_id,created_at);
CREATE INDEX native_relay_retention ON native_relay_requests(created_at);
CREATE TABLE native_relay_capacity (id INTEGER PRIMARY KEY CHECK(id=1), retained INTEGER NOT NULL DEFAULT 0 CHECK(retained>=0));
INSERT INTO native_relay_capacity VALUES(1,0);
CREATE TABLE native_relay_daily_usage (device_id TEXT NOT NULL, day INTEGER NOT NULL, requests INTEGER NOT NULL, PRIMARY KEY(device_id,day));
CREATE TRIGGER native_relay_admitted AFTER INSERT ON native_relay_requests BEGIN
  UPDATE native_relay_capacity SET retained=retained+1 WHERE id=1;
  INSERT INTO native_relay_daily_usage VALUES(NEW.sender_id,CAST(NEW.created_at/86400 AS INTEGER),1)
    ON CONFLICT(device_id,day) DO UPDATE SET requests=requests+1;
END;
CREATE TRIGGER native_relay_removed AFTER DELETE ON native_relay_requests BEGIN
  UPDATE native_relay_capacity SET retained=retained-1 WHERE id=1;
END;
