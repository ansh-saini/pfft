import type { SupabaseClient } from "@supabase/supabase-js";
import { BANKS, BANK_SOURCE, type StatementBank } from "./statementSync";
import {
  computeBucketBalances,
  type Bucket,
  type DatedLedgerRow,
  type DatedTxn,
} from "./buckets";

/** A ledger row with the moment it was written, not just the day it is dated. */
export type RecordedLedgerRow = DatedLedgerRow & { created_at?: string | null };

/** A transaction with the moment its SMS arrived. */
export type RecordedTxn = DatedTxn & { received_at?: string | null };

export type SnapshotOrigin = "sms" | "manual" | "statement";

export type BalanceSnapshot = {
  id: string;
  bank: StatementBank;
  balance: number;
  observed_at: string;
  origin: SnapshotOrigin;
  source_txn_id: string | null;
  reconcile_group: string | null;
  note: string | null;
};

/**
 * The balance an SMS states for the account it is about.
 *
 * ICICI puts "Avl Bal Rs. 41,250.00" on its non-UPI alerts and "Available
 * Balance is Rs. 1,88,420.50" on credits — 20 of 451 messages, but they are the
 * bank's own number and cost nothing to keep. Axis states no balance in any
 * message it sends, so Axis is always typed in by hand.
 *
 * A card SMS quotes "Avl Limit", which is headroom on a liability and not a
 * balance at all — matching it would silently add a credit card's unused limit
 * to the bank total. Only account sources are read, and the wording is not
 * matched either.
 */
const AVAILABLE_BALANCE =
  /(?:avl\.?\s*bal(?:ance)?|available\s+balance(?:\s+is)?)\s*:?\s*(?:rs|inr)?\.?\s*([\d,]+(?:\.\d{1,2})?)/i;

const BANK_SOURCES = new Set(Object.values(BANK_SOURCE));

export function parseAvailableBalance(
  rawBody: string | null | undefined,
  source: string | null | undefined,
): number | null {
  if (!rawBody || !source || !BANK_SOURCES.has(source)) return null;

  const match = AVAILABLE_BALANCE.exec(rawBody);
  if (!match) return null;

  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

export function bankForSource(source: string | null | undefined): StatementBank | null {
  const entry = Object.entries(BANK_SOURCE).find(([, s]) => s === source);
  return entry ? (entry[0] as StatementBank) : null;
}

export type AccountLine = {
  bank: StatementBank;
  /** The balance used in the reconciliation, when this account was part of one. */
  balance: number | null;
  observedAt: string | null;
  origin: SnapshotOrigin | null;
  /** Latest balance the bank itself stated over SMS, whenever that was. */
  smsBalance: number | null;
  smsObservedAt: string | null;
};

export type Reconciliation = {
  /** When every account was captured. Null until one full reconciliation exists. */
  asOf: string | null;
  accounts: AccountLine[];
  bankTotal: number;
  bucketTotal: number;
  /** Bank minus buckets. Positive is money no bucket claims; negative means the buckets claim money the bank does not hold. */
  unallocated: number;
  /** Transactions that landed after the reconciliation — how far the picture has moved since. */
  txnsSince: number;
};

function latest<T extends { observed_at: string }>(rows: T[]): T | null {
  return rows.reduce<T | null>(
    (best, row) => (best && best.observed_at >= row.observed_at ? best : row),
    null,
  );
}

/**
 * Had this row's money already left the bank when the balance was read?
 *
 * On any other day the date settles it. On the day of the reconciliation itself
 * the date cannot: `transaction_date` is a DATE, so without something finer
 * every transaction arriving later that day counts as though it came first, and
 * a reconciliation reading "matches" at breakfast drifts apart by lunchtime.
 *
 * The moment the row was recorded is that finer evidence, but only when it is
 * same-day — an SMS lands within seconds of the payment, so it dates the
 * movement well. A row backfilled from a statement was recorded weeks after the
 * money moved, which says nothing about the day it moved, so those fall back to
 * the date they carry.
 */
export function countedAt(
  movedOn: string | null,
  recordedAt: string | null,
  asOf: string,
): boolean {
  if (movedOn === null) return false;

  const asOfDate = asOf.slice(0, 10);
  if (movedOn > asOfDate) return false;
  if (movedOn < asOfDate) return true;

  const sameDayEvidence = recordedAt !== null && recordedAt.slice(0, 10) === movedOn;
  return sameDayEvidence ? recordedAt! <= asOf : true;
}

/**
 * Bank balance against bucket balances, at the one moment both were true.
 *
 * Only a complete `reconcile_group` counts. Every account has to be captured
 * together: an ICICI balance read on Tuesday against an Axis balance read on
 * Friday gives a difference that looks exact and measures nothing, which is the
 * failure this whole feature exists to stop.
 *
 * Bucket balances are recomputed as of that date rather than taken as they
 * stand now, for the same reason.
 */
export function buildReconciliation(
  snapshots: BalanceSnapshot[],
  buckets: Bucket[],
  ledger: RecordedLedgerRow[],
  txns: RecordedTxn[],
): Reconciliation {
  const smsLatest = new Map<StatementBank, BalanceSnapshot>();
  for (const bank of BANKS) {
    const found = latest(
      snapshots.filter((s) => s.bank === bank && s.origin === "sms"),
    );
    if (found) smsLatest.set(bank, found);
  }

  const groups = new Map<string, BalanceSnapshot[]>();
  for (const snap of snapshots) {
    if (!snap.reconcile_group) continue;
    const rows = groups.get(snap.reconcile_group) ?? [];
    rows.push(snap);
    groups.set(snap.reconcile_group, rows);
  }

  const complete = [...groups.values()]
    .filter((rows) => BANKS.every((bank) => rows.some((r) => r.bank === bank)))
    .sort((a, b) => (latest(a)!.observed_at < latest(b)!.observed_at ? -1 : 1));

  const current = complete.at(-1) ?? null;

  const accounts: AccountLine[] = BANKS.map((bank) => {
    const snap = current?.find((r) => r.bank === bank) ?? null;
    const sms = smsLatest.get(bank) ?? null;
    return {
      bank,
      balance: snap ? Number(snap.balance) : null,
      observedAt: snap?.observed_at ?? null,
      origin: snap?.origin ?? null,
      smsBalance: sms ? Number(sms.balance) : null,
      smsObservedAt: sms?.observed_at ?? null,
    };
  });

  if (!current) {
    return {
      asOf: null,
      accounts,
      bankTotal: 0,
      bucketTotal: 0,
      unallocated: 0,
      txnsSince: 0,
    };
  }

  const asOf = latest(current)!.observed_at;

  const bankTotal = current.reduce((sum, row) => sum + Number(row.balance), 0);

  const asOfBalances = computeBucketBalances(
    buckets,
    // A ledger row never moves money in the bank — it only partitions what is
    // already there — so when it was written does not matter. The date it is
    // dated does.
    ledger.filter((row) => row.occurred_on !== null && row.occurred_on <= asOf.slice(0, 10)),
    txns.filter((row) => countedAt(row.transaction_date, row.received_at ?? null, asOf)),
  );
  const bucketTotal = Object.values(asOfBalances).reduce(
    (sum, b) => sum + b.balance,
    0,
  );

  return {
    asOf,
    accounts,
    bankTotal,
    bucketTotal,
    unallocated: Math.round((bankTotal - bucketTotal) * 100) / 100,
    txnsSince: txns.filter(
      (row) => !countedAt(row.transaction_date, row.received_at ?? null, asOf),
    ).length,
  };
}

/**
 * Keep the balance an incoming SMS stated. Written after the transaction so the
 * snapshot can point at the message it came from; a repeat ingest of the same
 * SMS hits the unique index and is ignored rather than double-counted.
 */
export async function recordSmsBalance(
  supabase: SupabaseClient,
  txn: {
    id: string;
    source: string | null;
    raw_body: string | null;
    received_at?: string | null;
    transaction_date?: string | null;
  },
): Promise<number | null> {
  const balance = parseAvailableBalance(txn.raw_body, txn.source);
  const bank = bankForSource(txn.source);
  if (balance === null || !bank) return null;

  const observedAt =
    txn.received_at ??
    (txn.transaction_date ? `${txn.transaction_date}T00:00:00Z` : new Date().toISOString());

  const { error } = await supabase.from("balance_snapshots").insert({
    bank,
    balance,
    observed_at: observedAt,
    origin: "sms",
    source_txn_id: txn.id,
  });

  // 23505 is the unique index on source_txn_id: this SMS has been read before.
  if (error && error.code !== "23505") {
    console.error(`[balances] snapshot insert failed for txn ${txn.id}:`, error.message);
    return null;
  }

  return balance;
}
