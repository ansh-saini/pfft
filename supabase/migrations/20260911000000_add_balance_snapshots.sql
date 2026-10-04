-- What the bank actually held, so the app can be checked against it.
--
-- Buckets partition the bank balance in software. Nothing has ever compared the
-- two, so every error so far was found by a human noticing an odd figure. A
-- snapshot is one account's balance at one moment.
--
-- Two origins. 'sms' is recorded automatically: ICICI states "Avl Bal Rs. ..."
-- in its non-UPI alerts, which is the bank's own number and free to keep.
-- 'manual' is typed in — Axis never states a balance in any SMS it sends.
--
-- Only a set of snapshots captured together can be reconciled: comparing an
-- ICICI balance from Tuesday against an Axis balance from Friday produces a
-- number that looks precise and means nothing. Rows written by one Reconcile
-- action share a reconcile_group.

CREATE TABLE balance_snapshots (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bank           TEXT        NOT NULL,
  balance        NUMERIC(12, 2) NOT NULL,
  observed_at    TIMESTAMPTZ NOT NULL,
  origin         TEXT        NOT NULL,
  source_txn_id  UUID        REFERENCES sms_transactions(id) ON DELETE SET NULL,
  reconcile_group UUID,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_snapshot_bank CHECK (bank IN ('ICICI', 'AXIS')),
  CONSTRAINT chk_snapshot_origin CHECK (origin IN ('sms', 'manual'))
);

CREATE INDEX idx_balance_snapshots_bank ON balance_snapshots (bank, observed_at DESC);
CREATE INDEX idx_balance_snapshots_group ON balance_snapshots (reconcile_group)
  WHERE reconcile_group IS NOT NULL;

-- One SMS states one balance, and the backfill re-reads the same messages every
-- time it runs.
CREATE UNIQUE INDEX idx_balance_snapshots_txn ON balance_snapshots (source_txn_id)
  WHERE source_txn_id IS NOT NULL;
