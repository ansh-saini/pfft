import type { SupabaseClient } from "@supabase/supabase-js";
import { mayHoldBucket } from "./buckets";
import { needsReview } from "./tagging";

/**
 * Whether a transaction needs the user. The one rule behind the Inbox, the
 * dashboard's count and /ingest's `needs_review`.
 *
 * Unreviewed rows with no category, or filed under the confidence line.
 * Parkings are never asked about: a transaction sits in Float unless the user
 * files it to one.
 */
export function needsInput(row: {
  reviewed_at: string | null;
  category: string | null;
  bucket_id: string | null;
  ai_confidence: number | string | null;
}): boolean {
  return needsReview({ ...row, mayHoldBucket: mayHoldBucket(row.category) });
}

/**
 * The fields that mark a row as decided by the user: it leaves the Inbox and
 * the tagger leaves it alone until they write a new description.
 */
export function handDecision() {
  return {
    reviewed_at: new Date().toISOString(),
    tagged_by: "user" as const,
    ai_confidence: 1,
  };
}

export type InboxRow = {
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
  ai_confidence: number | null;
};

/** Every transaction that needs the user, newest first, across all cycles. */
export async function getInboxTransactions(
  supabase: SupabaseClient,
): Promise<InboxRow[]> {
  const { data } = await supabase
    .from("sms_transactions")
    .select(
      "id, transaction_date, received_at, merchant, amount, direction, bank, source, category, sub_category, bucket_id, ai_confidence, reviewed_at",
    )
    .eq("is_spam", false)
    .order("transaction_date", { ascending: false })
    .order("received_at", { ascending: false });

  return (data ?? []).filter(needsInput).map((r) => ({
    id: r.id,
    transaction_date: r.transaction_date,
    received_at: r.received_at,
    merchant: r.merchant,
    amount: r.amount === null ? null : Number(r.amount),
    direction: r.direction,
    bank: r.bank,
    source: r.source,
    category: r.category,
    sub_category: r.sub_category,
    bucket_id: r.bucket_id,
    ai_confidence: r.ai_confidence === null ? null : Number(r.ai_confidence),
  }));
}

export async function getInboxCount(supabase: SupabaseClient): Promise<number> {
  const { data } = await supabase
    .from("sms_transactions")
    .select("category, bucket_id, ai_confidence, reviewed_at")
    .eq("is_spam", false);
  return (data ?? []).filter(needsInput).length;
}
