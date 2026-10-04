-- Add 'Fitness': sports facility bookings, courts, gyms and coaching (a DDA
-- sports complex slot, a badminton court). They were landing in Health &
-- Medical, which should mean doctors and pharmacies.

ALTER TABLE sms_transactions DROP CONSTRAINT IF EXISTS chk_category;

ALTER TABLE sms_transactions
  ADD CONSTRAINT chk_category CHECK (
    category IN (
      'Food & Dining', 'Groceries', 'Travel & Transport', 'Utilities',
      'Shopping', 'Entertainment', 'Health & Medical', 'Fitness', 'EMI / Loan',
      'Subscription', 'Salary / Income', 'Dividend / Interest', 'Refund',
      'Self Transfer', 'Investment', 'Insurance', 'Bike',
      'Credit Card Bill', 'Other'
    ) OR category IS NULL
  );

ALTER TABLE merchant_mappings DROP CONSTRAINT IF EXISTS chk_mapping_category;

ALTER TABLE merchant_mappings
  ADD CONSTRAINT chk_mapping_category CHECK (
    category IN (
      'Food & Dining', 'Groceries', 'Travel & Transport', 'Utilities',
      'Shopping', 'Entertainment', 'Health & Medical', 'Fitness', 'EMI / Loan',
      'Subscription', 'Salary / Income', 'Dividend / Interest', 'Refund',
      'Self Transfer', 'Investment', 'Insurance', 'Bike',
      'Credit Card Bill', 'Other'
    )
  );
