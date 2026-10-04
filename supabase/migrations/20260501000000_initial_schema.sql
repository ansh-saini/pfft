CREATE TABLE sms_transactions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  raw_body         TEXT        NOT NULL,
  sender           TEXT,
  received_at      TIMESTAMPTZ,
  is_spam          BOOLEAN     NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  bank             TEXT,
  source           TEXT,
  account_last4    TEXT,
  amount           NUMERIC(12, 2),
  direction        TEXT,
  merchant         TEXT,
  upi_ref          TEXT,
  transaction_date DATE,
  transaction_time TIME,

  category         TEXT,
  sub_category     TEXT
);

CREATE INDEX idx_sms_txn_date ON sms_transactions (transaction_date DESC);
CREATE INDEX idx_sms_txn_bank ON sms_transactions (bank);
CREATE INDEX idx_sms_txn_spam ON sms_transactions (is_spam);

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
