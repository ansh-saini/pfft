-- Add 'Credit Card Bill'.
--
-- Card bill payments were scattered across Subscription and Shopping, which
-- made them look like discretionary spend. They are neither: they are the
-- monthly settlement of a card.
--
-- They stay real spend rather than being marked internal, because card swipe
-- SMS are only partly captured — roughly 11,700 of swipes recorded against
-- 43,900 of bill payments. Treating the bills as internal today would delete
-- most of that spending from the books. Once swipe capture is reliable these
-- become internal and the swipes carry the detail.

ALTER TABLE sms_transactions DROP CONSTRAINT IF EXISTS chk_category;

ALTER TABLE sms_transactions
  ADD CONSTRAINT chk_category CHECK (
    category IN (
      'Food & Dining', 'Groceries', 'Travel & Transport', 'Utilities',
      'Shopping', 'Entertainment', 'Health & Medical', 'EMI / Loan',
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
      'Shopping', 'Entertainment', 'Health & Medical', 'EMI / Loan',
      'Subscription', 'Salary / Income', 'Dividend / Interest', 'Refund',
      'Self Transfer', 'Investment', 'Insurance', 'Bike',
      'Credit Card Bill', 'Other'
    )
  );
