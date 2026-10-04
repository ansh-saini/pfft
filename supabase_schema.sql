-- Run this in your Supabase SQL editor (Database → SQL Editor → New Query)

CREATE TABLE sms_transactions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Raw / metadata (always populated)
  raw_body         TEXT        NOT NULL,
  sender           TEXT,                         -- "AM-ICICIB", "AM-AXISBK", etc.
  received_at      TIMESTAMPTZ,                  -- timestamp from the Shortcut
  is_spam          BOOLEAN     NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Parsed fields (NULL when is_spam = true)
  bank             TEXT,                         -- 'ICICI' | 'AXIS'
  source           TEXT,                         -- 'icici_bank' | 'axis_bank' | 'axis_cc'
  account_last4    TEXT,
  amount           NUMERIC(12, 2),
  direction        TEXT,                         -- 'debit' | 'credit'
  merchant         TEXT,
  upi_ref          TEXT,
  transaction_date DATE,
  transaction_time TIME,

  -- Auto-tagging (populated asynchronously after insert)
  category         TEXT,                         -- see chk_category constraint
  sub_category     TEXT
);

-- Indexes
CREATE INDEX idx_sms_txn_date    ON sms_transactions (transaction_date DESC);
CREATE INDEX idx_sms_txn_bank    ON sms_transactions (bank);
CREATE INDEX idx_sms_txn_spam    ON sms_transactions (is_spam);

-- Optional: check constraint so junk can't sneak into direction
ALTER TABLE sms_transactions
  ADD CONSTRAINT chk_direction CHECK (direction IN ('debit', 'credit') OR direction IS NULL);

ALTER TABLE sms_transactions
  ADD CONSTRAINT chk_category CHECK (
    category IN (
      'Food & Dining',
      'Groceries',
      'Travel & Transport',
      'Utilities',
      'Shopping',
      'Entertainment',
      'Health & Medical',
      'EMI / Loan',
      'Subscription',
      'Salary / Income',
      'Refund',
      'Self Transfer',
      'Other'
    ) OR category IS NULL
  );
