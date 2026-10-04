-- Buckets: partition the bank balance into named pots with real balances.
-- Bank account stays a dumb container; buckets hold intent.

CREATE TABLE buckets (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL UNIQUE,
  type          TEXT        NOT NULL,
  target_amount NUMERIC(12, 2),          -- optional; per-cycle budget for expenditure, goal for saving
  target_date   DATE,                    -- optional; saving goals only
  is_default    BOOLEAN     NOT NULL DEFAULT false,
  sort_order    INT         NOT NULL DEFAULT 0,
  archived_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_bucket_type CHECK (type IN ('saving', 'expenditure')),
  CONSTRAINT chk_bucket_target CHECK (target_amount IS NULL OR target_amount > 0)
);

-- Exactly one bucket can be the assignment default
CREATE UNIQUE INDEX one_default_bucket ON buckets (is_default) WHERE is_default;

-- Signed money movements that are not transactions: funding, transfers, sweeps, adjustments.
-- Transfers write two rows sharing a transfer_group, amounts negating each other.
CREATE TABLE bucket_ledger (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id      UUID        NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  amount         NUMERIC(12, 2) NOT NULL,   -- signed: positive into bucket, negative out
  kind           TEXT        NOT NULL,
  transfer_group UUID,
  occurred_on    DATE        NOT NULL,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_ledger_kind CHECK (kind IN ('funding', 'transfer', 'sweep', 'adjustment')),
  CONSTRAINT chk_ledger_amount CHECK (amount <> 0)
);

CREATE INDEX idx_ledger_bucket_date ON bucket_ledger (bucket_id, occurred_on);
CREATE INDEX idx_ledger_transfer_group ON bucket_ledger (transfer_group) WHERE transfer_group IS NOT NULL;

-- A transaction points at one bucket, or none (= it is still in the pool)
ALTER TABLE sms_transactions
  ADD COLUMN bucket_id UUID REFERENCES buckets(id) ON DELETE SET NULL;

CREATE INDEX idx_txn_bucket ON sms_transactions (bucket_id);
CREATE INDEX idx_txn_pool ON sms_transactions (transaction_date DESC)
  WHERE bucket_id IS NULL AND is_spam = false;

-- Starting set
INSERT INTO buckets (name, type, target_amount, is_default, sort_order) VALUES
  ('Needs',           'expenditure', 20000, true,  0),
  ('Wants',           'expenditure', 10000, false, 1),
  ('Bills',           'expenditure',  NULL, false, 2),
  ('Investing',       'expenditure',  NULL, false, 3),
  ('Emergency Fund',  'saving',       NULL, false, 4);
