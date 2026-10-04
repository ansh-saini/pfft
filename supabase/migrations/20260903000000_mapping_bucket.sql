-- Merchant mappings remember a bucket too.
--
-- Without this the tagger could recover a category from history but never a
-- bucket, so every incoming transaction landed in the pool and had to be filed
-- by hand — the single biggest reason auto-tagging felt incomplete.

ALTER TABLE merchant_mappings
  ADD COLUMN bucket_id UUID REFERENCES buckets(id) ON DELETE SET NULL;

-- The category constraint predates several categories added since.
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
