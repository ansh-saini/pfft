import { createHash } from "crypto";
import { merchantFromNarration, type StatementRow } from "./statementReconcile";

export const BANKS = ["ICICI", "AXIS"] as const;
export type StatementBank = (typeof BANKS)[number];

/** Which `sms_transactions.source` each bank's account statement covers. */
export const BANK_SOURCE: Record<StatementBank, string> = {
  ICICI: "icici_bank",
  AXIS: "axis_bank",
};

export const BACKFILL_NOTE =
  "[Backfilled from account statement — original SMS not available]";

export type DateRange = { start: string; end: string };

export type SyncPeriod = {
  period_start: string;
  period_end: string;
};

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Collapses overlapping and back-to-back ranges into the fewest that cover the same days. */
export function mergeRanges(ranges: DateRange[]): DateRange[] {
  const sorted = [...ranges]
    .filter((r) => r.start <= r.end)
    .sort((a, b) => a.start.localeCompare(b.start));

  const merged: DateRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    // Adjacent counts as contiguous: 1–31 Jul then 1–30 Aug is one unbroken span.
    if (last && range.start <= addDays(last.end, 1)) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * The days inside `window` that no range covers — the periods still needing a
 * statement. Holes in the middle are reported too, not just the tail.
 */
export function pendingRanges(
  covered: DateRange[],
  window: DateRange,
): DateRange[] {
  if (window.start > window.end) return [];

  const merged = mergeRanges(covered);
  const gaps: DateRange[] = [];
  let cursor = window.start;

  for (const range of merged) {
    if (range.end < cursor) continue;
    if (range.start > window.end) break;
    if (range.start > cursor) {
      gaps.push({ start: cursor, end: addDays(range.start, -1) });
    }
    cursor = addDays(range.end, 1);
    if (cursor > window.end) return gaps;
  }

  if (cursor <= window.end) gaps.push({ start: cursor, end: window.end });
  return gaps;
}

export type BankSyncState = {
  bank: StatementBank;
  lastSyncedThrough: string | null;
  lastSyncedAt: string | null;
  pending: DateRange[];
  fullySynced: boolean;
};

export type SyncState = {
  window: DateRange | null;
  banks: BankSyncState[];
  fullySynced: boolean;
};

export function buildSyncState(
  periodsByBank: Record<StatementBank, SyncPeriod[]>,
  syncedAtByBank: Record<StatementBank, string | null>,
  window: DateRange | null,
): SyncState {
  const banks = BANKS.map((bank) => {
    const periods = periodsByBank[bank] ?? [];
    const covered = periods.map((p) => ({
      start: p.period_start,
      end: p.period_end,
    }));
    const merged = mergeRanges(covered);
    const pending = window ? pendingRanges(covered, window) : [];

    return {
      bank,
      lastSyncedThrough: merged.length
        ? merged[merged.length - 1].end
        : null,
      lastSyncedAt: syncedAtByBank[bank] ?? null,
      pending,
      fullySynced: window !== null && pending.length === 0,
    };
  });

  return {
    window,
    banks,
    fullySynced: window !== null && banks.every((b) => b.fullySynced),
  };
}

/**
 * Rows to insert for statement entries with no matching SMS. The hash matches
 * what `scripts/reconcile-statements.ts` writes, so the two paths dedupe against
 * each other and re-syncing the same statement inserts nothing.
 */
export function buildBackfillRecords(
  missing: StatementRow[],
  bank: StatementBank,
  source: string,
  accountLast4: string | null,
) {
  return missing.map((m) => ({
    raw_body: `${BACKFILL_NOTE} ${bank} ${m.direction} ${m.amount} ${m.description.slice(0, 200)} ${m.date}`,
    body_hash: createHash("sha256")
      .update(
        `backfill-${bank}-${m.date}-${m.amount}-${m.direction}-${m.upiRef ?? m.description}`,
      )
      .digest("hex"),
    sender: null,
    received_at: null,
    is_spam: false,
    bank,
    source,
    account_last4: accountLast4,
    amount: m.amount,
    direction: m.direction,
    // Statement narrations bury the counterparty in routing codes; without
    // this the row shows as "—" in the inbox.
    merchant: merchantFromNarration(m.description),
    upi_ref: m.upiRef,
    transaction_date: m.date,
    transaction_time: null,
    category: null,
    sub_category: null,
  }));
}
