# Statement reconciliation

Some SMS never reach `sms_transactions` — dividend/interest/RD/REIT
narrations in particular seem to not always arrive as SMS at all (confirmed
by grepping the DB for zero matching rows, spam or otherwise, across any
month). Every few months, cross-check the account statements against the DB
and backfill the gaps.

## Process

1. Export CSV statements from ICICI (retail internet banking → statements)
   and Axis (netbanking → account statement) covering the period since the
   last sync. Save them as:
   - `statements/icici-last-3-months.csv`
   - `statements/axis-last-3-months.csv`

   (filenames are just convention — pass `--icici` / `--axis` to point at
   different paths.)

2. Dry run:

   ```bash
   pnpm reconcile
   ```

   Prints, per bank:
   - rows in the statement with no matching DB row (`transaction_date` +
     `amount` + `direction`) — these are the gaps
   - DB rows with no matching statement row — informational only, usually
     credit-card transactions (different statement entirely) or dates
     outside the statement's range. Not touched either way.

3. Review the "Missing from DB" list. If it includes real transactions (not
   ones you've decided to skip, e.g. equity dividends), backfill:

   ```bash
   pnpm reconcile -- --apply
   ```

   Inserts each missing row with `category: null` and a `raw_body` tagged
   `[Backfilled from account statement — original SMS not available]`, so
   they're identifiable later and distinct from real SMS ingest.

4. Categorize the new rows:

   ```bash
   pnpm tag:untagged
   ```

Re-running `--apply` is idempotent — inserts are deduped by a hash of
`bank + date + amount + direction + upi_ref (or description)`, so reconciling
the same statement twice won't double-insert.

## Format quirks (why this isn't a naive CSV diff)

**ICICI**: some `Transaction Remarks` cells contain a literal newline (the
bank name wraps mid-cell), which splits one logical transaction across two
physical CSV lines — the continuation line starts with `,,,,,`.
`parseICICIStatement` re-joins those before parsing.

**Axis**: the header row says `DR,CR`, but empirically the `DR` column holds
money **in** (credit) and `CR` holds money **out** (debit) — backwards from
the header label. This was verified by checking balance deltas row-to-row
against the statement's own running balance column. `parseAxisStatement`
asserts this polarity on every run (`assertAxisPolarity` in
`lib/statementReconcile.ts`) and throws if a future export doesn't hold to
it, rather than silently mis-parsing debits as credits.

**Matching**: statement rows are matched to DB rows by `(date, amount,
direction)` as a multiset — each DB row consumed at most once. Merchant text
almost never matches character-for-character between SMS and statement
narrations, so it isn't used for matching. Only `source in (icici_bank,
axis_bank)` DB rows are compared — credit card transactions (`icici_cc`,
`axis_cc`) live on separate statements and are correctly absent here.

## Known excluded categories

Equity dividend credits (company name + "DIV" in the Axis narration, e.g.
`ACH-CR-SCHAEFFLER DIV...`) have been deliberately left un-backfilled — low
value, high volume, not worth tracking per-instrument. `pnpm reconcile` will
keep surfacing them as "missing"; that's expected, not a bug.

## Code

- `lib/statementReconcile.ts` — parsers (`parseICICIStatement`,
  `parseAxisStatement`) and the matcher (`reconcileAgainstDb`). Unit tested
  in `lib/statementReconcile.test.ts`, including the two quirks above.
- `scripts/reconcile-statements.ts` — CLI: reads the CSVs, queries the DB,
  prints the report, and (`--apply`) inserts + dedupes.
