-- Add body_hash for deduplication on bulk ingest
-- NULL = manual entry (no SMS body); non-null = SMS, must be unique
ALTER TABLE sms_transactions ADD COLUMN body_hash TEXT;

-- Backfill SMS rows; leave manual entries (raw_body='') as NULL
UPDATE sms_transactions
SET body_hash = encode(sha256(raw_body::bytea), 'hex')
WHERE raw_body IS NOT NULL AND raw_body <> '';

-- Remove duplicate SMS rows, keeping the earliest created_at per hash
DELETE FROM sms_transactions
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY body_hash ORDER BY created_at ASC) AS rn
    FROM sms_transactions
    WHERE body_hash IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- Partial unique index: only enforces uniqueness where body_hash is not null
CREATE UNIQUE INDEX idx_sms_txn_body_hash ON sms_transactions (body_hash)
WHERE body_hash IS NOT NULL;
