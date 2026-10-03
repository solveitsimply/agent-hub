-- Retention can remove every legacy message while clients still hold its
-- cursor. Reserve the historical AUTOINCREMENT high-water mark, including
-- deleted rows, without changing messages or lowering an existing sequence.
INSERT INTO sqlite_sequence(name,seq)
  SELECT 'message_deliveries',COALESCE((SELECT MAX(seq) FROM sqlite_sequence WHERE name='messages'),0)
  WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='message_deliveries');
UPDATE sqlite_sequence
  SET seq=MAX(seq,COALESCE((SELECT MAX(seq) FROM sqlite_sequence WHERE name='messages'),0))
  WHERE name='message_deliveries';
