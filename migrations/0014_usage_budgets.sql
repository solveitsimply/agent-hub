-- One bounded counter per UTC day. No actor identifiers or message contents.
CREATE TABLE hub_daily_usage (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL CHECK(requests >= 0),
  rows_read INTEGER NOT NULL CHECK(rows_read >= 0),
  rows_written INTEGER NOT NULL CHECK(rows_written >= 0)
);
