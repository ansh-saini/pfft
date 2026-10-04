-- Notes become the primary way of tagging.
--
-- A merchant name says who, never why. "ROHAN VERMA Rs 370" is lent to a
-- friend one week and an office lunch split the next, and no amount of
-- history can tell them apart. A note written by the person who made the
-- payment can. Category and bucket become outputs derived from it, each with
-- a confidence the system can be honest about.

ALTER TABLE sms_transactions
  -- Free text, written by the user. What this was actually for.
  ADD COLUMN note          TEXT,
  -- How sure the tagger was, 0 to 1. Derived, never self-reported: an exact
  -- match on a note already reviewed is 1.0, a model guess with nothing but a
  -- person's name to go on is capped low.
  ADD COLUMN ai_confidence NUMERIC(3, 2),
  -- Which path filed it.
  ADD COLUMN tagged_by     TEXT,
  -- Set when a person confirmed the row. A reviewed row is frozen: the tagger
  -- never touches it again.
  ADD COLUMN reviewed_at   TIMESTAMPTZ,

  ADD CONSTRAINT chk_txn_confidence CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)),
  ADD CONSTRAINT chk_txn_tagged_by  CHECK (tagged_by IS NULL OR tagged_by IN ('rule', 'note', 'history', 'ai', 'user'));

-- The review queue reads unreviewed rows newest first.
CREATE INDEX idx_txn_review ON sms_transactions (transaction_date DESC)
  WHERE reviewed_at IS NULL AND is_spam = false;
