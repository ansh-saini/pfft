-- V2 rituals: allocating a salary credit across buckets, and closing a cycle by
-- deciding where each bucket's leftover goes.

-- The split to prefill the allocate dialog with. Updated to whatever you last
-- confirmed, so the prompt learns from what you actually do rather than from a
-- target you set once.
ALTER TABLE buckets
  ADD COLUMN allocation_amount NUMERIC(12, 2);

ALTER TABLE buckets
  ADD CONSTRAINT chk_bucket_allocation
  CHECK (allocation_amount IS NULL OR allocation_amount >= 0);

-- Ties funding rows to the credit that paid for them, so a salary can be
-- recognised as already allocated and never allocated twice.
ALTER TABLE bucket_ledger
  ADD COLUMN source_txn_id UUID REFERENCES sms_transactions(id) ON DELETE SET NULL;

CREATE INDEX idx_ledger_source_txn ON bucket_ledger (source_txn_id)
  WHERE source_txn_id IS NOT NULL;

-- One row per cycle whose leftover has been dealt with. Without this the
-- close-cycle sweep could run twice and move the same money again.
CREATE TABLE cycle_closes (
  cycle_id   TEXT        PRIMARY KEY,
  closed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note       TEXT
);
