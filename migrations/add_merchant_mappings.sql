-- Run in Supabase SQL Editor (Database → SQL Editor → New Query)
-- Adds merchant_mappings table for manual category overrides

CREATE TABLE merchant_mappings (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant     TEXT        NOT NULL UNIQUE,
  category     TEXT        NOT NULL,
  sub_category TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE merchant_mappings
  ADD CONSTRAINT chk_mapping_category CHECK (
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
    )
  );
