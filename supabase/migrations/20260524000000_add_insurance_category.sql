-- Add 'Insurance' to category check constraints on both tables

ALTER TABLE sms_transactions
  DROP CONSTRAINT IF EXISTS chk_category;

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
      'Investment',
      'Insurance',
      'Other'
    ) OR category IS NULL
  );

ALTER TABLE merchant_mappings
  DROP CONSTRAINT IF EXISTS chk_mapping_category;

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
      'Investment',
      'Insurance',
      'Other'
    )
  );
