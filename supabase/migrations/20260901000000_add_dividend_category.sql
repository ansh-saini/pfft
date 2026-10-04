-- Add 'Dividend / Interest' — passive income from holdings and bank balances.
--
-- It needs its own category rather than reusing an existing one: 'Salary /
-- Income' drives the salary allocation prompt, so a ₹4 dividend would raise a
-- prompt to allocate ₹4; and 'Investment' means money going *out* into
-- investments, which the dashboard's Invested card sums.

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
      'Dividend / Interest',
      'Refund',
      'Self Transfer',
      'Investment',
      'Insurance',
      'Bike',
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
      'Dividend / Interest',
      'Refund',
      'Self Transfer',
      'Investment',
      'Insurance',
      'Bike',
      'Other'
    )
  );
