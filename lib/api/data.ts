import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCycles, getCurrentCycleId, type Cycle } from "../cycles";

/** Every column the app shows for a transaction in a list. */
export const TX_COLUMNS =
  "id, transaction_date, received_at, merchant, amount, direction, bank, source, category, sub_category, bucket_id, ai_confidence, tagged_by, reviewed_at";

export type ApiTransaction = {
  id: string;
  transaction_date: string | null;
  received_at: string | null;
  merchant: string | null;
  amount: number;
  direction: string | null;
  bank: string | null;
  source: string | null;
  category: string | null;
  sub_category: string | null;
  bucket_id: string | null;
  ai_confidence: number | null;
  tagged_by: string | null;
  reviewed_at: string | null;
};

/** Numbers arrive from PostgREST as strings for NUMERIC columns. */
export function toApiTransaction(r: Record<string, unknown>): ApiTransaction {
  return {
    id: r.id as string,
    transaction_date: (r.transaction_date as string | null) ?? null,
    received_at: (r.received_at as string | null) ?? null,
    merchant: (r.merchant as string | null) ?? null,
    amount: Number(r.amount ?? 0),
    direction: (r.direction as string | null) ?? null,
    bank: (r.bank as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    category: (r.category as string | null) ?? null,
    sub_category: (r.sub_category as string | null) ?? null,
    bucket_id: (r.bucket_id as string | null) ?? null,
    ai_confidence: r.ai_confidence === null || r.ai_confidence === undefined ? null : Number(r.ai_confidence),
    tagged_by: (r.tagged_by as string | null) ?? null,
    reviewed_at: (r.reviewed_at as string | null) ?? null,
  };
}

/**
 * The cycle a request asks for (`?cycle=YYYY-MM`), or the current one. The
 * same fallback the dashboard uses when there are no transactions yet: this
 * calendar month.
 */
export async function resolveCycle(
  supabase: SupabaseClient,
  requested: string | null,
): Promise<{ cycles: Cycle[]; cycle: Cycle }> {
  const cycles = await getCycles(supabase);
  const id = requested ?? getCurrentCycleId(cycles);
  const found = cycles.find((c) => c.id === id);
  if (found) return { cycles, cycle: found };

  const now = new Date();
  const start = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  const end = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1));
  return {
    cycles,
    cycle: {
      id: start.toISOString().slice(0, 7),
      label: start.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }),
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    },
  };
}

export async function cycleTransactions(
  supabase: SupabaseClient,
  cycle: Cycle,
): Promise<ApiTransaction[]> {
  const { data, error } = await supabase
    .from("sms_transactions")
    .select(TX_COLUMNS)
    .eq("is_spam", false)
    .gte("transaction_date", cycle.startDate)
    .lt("transaction_date", cycle.endDate)
    .order("transaction_date", { ascending: false })
    .order("received_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(toApiTransaction);
}
