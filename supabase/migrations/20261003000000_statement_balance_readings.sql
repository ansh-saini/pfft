-- A statement's closing balance is a third kind of balance reading: the bank's
-- own figure, captured on every statement sync. It is what checks the Axis
-- balance, since Axis states no balance over SMS.
ALTER TABLE balance_snapshots DROP CONSTRAINT chk_snapshot_origin;
ALTER TABLE balance_snapshots
  ADD CONSTRAINT chk_snapshot_origin CHECK (origin IN ('sms', 'manual', 'statement'));
