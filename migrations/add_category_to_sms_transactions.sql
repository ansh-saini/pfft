-- Run in Supabase SQL Editor (Database → SQL Editor → New Query)
-- Adds auto-tagging columns to existing sms_transactions table

ALTER TABLE sms_transactions
  ADD COLUMN IF NOT EXISTS category     TEXT,
  ADD COLUMN IF NOT EXISTS sub_category TEXT;

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
