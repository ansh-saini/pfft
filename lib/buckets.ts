import type { SupabaseClient } from "@supabase/supabase-js";
import { INTERNAL_CATEGORIES } from "./categories";

export const BUCKET_TYPES = ["saving", "expenditure"] as const;
export type BucketType = (typeof BUCKET_TYPES)[number];

export const LEDGER_KINDS = ["funding", "transfer", "sweep", "adjustment"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** Categories that never enter the pool — funding source and internal movement, not spend. */
export const POOL_EXCLUDED_CATEGORIES = [
  "Salary / Income",
  ...INTERNAL_CATEGORIES,
] as const;

export type Bucket = {
  id: string;
  name: string;
  type: BucketType;
  target_amount: number | null;
  target_date: string | null;
  /** What the allocate dialog prefills for this bucket, from the last split confirmed. */
  allocation_amount: number | null;
  is_default: boolean;
  sort_order: number;
};

export type LedgerRow = {
  bucket_id: string;
  amount: number | string;
};

export type DatedLedgerRow = LedgerRow & {
  occurred_on: string | null;
  kind?: string | null;
};

export type AssignedTxn = {
  bucket_id: string | null;
  amount: number | string | null;
  direction: string | null;
};

export type DatedTxn = AssignedTxn & { transaction_date: string | null };

/** Half-open date range, matching the shape `getCycles()` returns. */
export type CycleWindow = { startDate: string; endDate: string };

export type PoolCandidate = {
  bucket_id: string | null;
  category: string | null;
};

export type PoolTxn = {
  id: string;
  transaction_date: string | null;
  received_at: string | null;
  merchant: string | null;
  amount: number | null;
  direction: string | null;
  bank: string | null;
  source: string | null;
  category: string | null;
  sub_category: string | null;
  bucket_id: string | null;
};

export type BucketBalance = {
  /** Money put in deliberately: funding, transfers in/out, sweeps, adjustments. */
  funded: number;
  /** Net spend: debits minus credits. A refund reduces what you have spent. */
  spent: number;
  /** Credits assigned to this bucket (refunds). Already deducted from `spent`. */
  returned: number;
  /** funded − spent. Negative means overspent. */
  balance: number;
};

/**
 * A bucket's balance is always derived — never stored — so it cannot drift
 * from the events that produced it.
 */
export function computeBucketBalances(
  buckets: Bucket[],
  ledger: LedgerRow[],
  txns: AssignedTxn[],
): Record<string, BucketBalance> {
  const result: Record<string, BucketBalance> = {};
  for (const bucket of buckets) {
    result[bucket.id] = { funded: 0, spent: 0, returned: 0, balance: 0 };
  }

  for (const row of ledger) {
    const entry = result[row.bucket_id];
    if (!entry) continue;
    entry.funded += Number(row.amount ?? 0);
  }

  for (const txn of txns) {
    if (!txn.bucket_id) continue;
    const entry = result[txn.bucket_id];
    if (!entry) continue;
    const amount = Number(txn.amount ?? 0);
    if (txn.direction === "credit") {
      entry.returned += amount;
      entry.spent -= amount;
    } else {
      entry.spent += amount;
    }
  }

  for (const entry of Object.values(result)) {
    entry.balance = entry.funded - entry.spent;
  }

  return result;
}

export async function getBuckets(supabase: SupabaseClient): Promise<Bucket[]> {
  const { data } = await supabase
    .from("buckets")
    .select(
      "id, name, type, target_amount, target_date, allocation_amount, is_default, sort_order",
    )
    .is("archived_at", null)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  return (data ?? []).map((row) => ({
    ...row,
    target_amount: row.target_amount === null ? null : Number(row.target_amount),
    allocation_amount:
      row.allocation_amount === null ? null : Number(row.allocation_amount),
  })) as Bucket[];
}

/** True when a transaction is still waiting to be assigned to a bucket. */
export function isInPool(txn: PoolCandidate): boolean {
  if (txn.bucket_id) return false;
  if (txn.category === null || txn.category === undefined) return true;
  return !POOL_EXCLUDED_CATEGORIES.includes(
    txn.category as (typeof POOL_EXCLUDED_CATEGORIES)[number],
  );
}

/**
 * True when a row of this category may sit in a bucket at all.
 *
 * The mirror of `isInPool` for the write side: a category that never enters the
 * pool is not spend, so a bucket must never hold it. `isInPool` only kept these
 * rows out of the inbox, which left every path that writes `bucket_id` from a
 * rule, from history or from a saved plan free to file them anyway — and all
 * eleven card settlements were back in Bills three days after being cleared.
 *
 * An untagged row may hold one: the bucket is often assigned before the
 * category is known.
 */
export function mayHoldBucket(category: string | null | undefined): boolean {
  if (category === null || category === undefined) return true;
  return !POOL_EXCLUDED_CATEGORIES.includes(
    category as (typeof POOL_EXCLUDED_CATEGORIES)[number],
  );
}
