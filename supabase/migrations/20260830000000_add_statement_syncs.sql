-- Records which date ranges of each bank account have been verified against an
-- account statement, so the dashboard can say what still needs syncing.

CREATE TABLE statement_syncs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bank            TEXT        NOT NULL,
  period_start    DATE        NOT NULL,
  period_end      DATE        NOT NULL,
  rows_seen       INT         NOT NULL DEFAULT 0,
  rows_backfilled INT         NOT NULL DEFAULT 0,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_sync_bank CHECK (bank IN ('ICICI', 'AXIS')),
  CONSTRAINT chk_sync_period CHECK (period_end >= period_start)
);

CREATE INDEX idx_statement_syncs_bank ON statement_syncs (bank, period_end DESC);
