import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CATEGORIES, type TransactionCategory } from "./categories";
import { mayHoldBucket } from "./buckets";
import { handDecision } from "./inbox";
import { tagTransaction } from "./tagger";

/**
 * The edits a person makes to a transaction, shared by the web's server
 * actions and the iOS app's API. Each takes the caller's own Supabase client
 * so it runs as them.
 */

export type Described = {
  category: string | null;
  bucket_id: string | null;
  ai_confidence: number | null;
};

/**
 * The user says what a transaction was for ("bike fuel", "refund against
 * books"). Saved as its description (`sub_category`), then the tagger re-reads
 * the row and decides category and bucket from it, even on a row decided by
 * hand before. Returns what the row holds afterwards; if the model could not
 * be reached it keeps what it had and stays in the Inbox.
 */
export async function describe(
  supabase: SupabaseClient,
  id: string,
  description: string,
): Promise<Described> {
  const trimmed = description.trim() || null;

  const { data: row, error } = await supabase
    .from("sms_transactions")
    .update({ sub_category: trimmed })
    .eq("id", id)
    .select("id, merchant, direction, amount, source, bank, raw_body")
    .single();
  if (error) throw new Error(error.message);

  if (trimmed) {
    await tagTransaction(
      {
        id: row.id,
        merchant: row.merchant,
        direction: row.direction as "debit" | "credit",
        amount: Number(row.amount),
        source: row.source ?? "",
        bank: row.bank ?? "",
        raw_body: row.raw_body ?? "",
        description: trimmed,
      },
      { force: true },
    );
  }

  const { data: filed, error: readError } = await supabase
    .from("sms_transactions")
    .select("category, bucket_id, ai_confidence")
    .eq("id", id)
    .single();
  if (readError) throw new Error(readError.message);

  return {
    category: filed.category,
    bucket_id: filed.bucket_id,
    ai_confidence: filed.ai_confidence === null ? null : Number(filed.ai_confidence),
  };
}

export function assertCategory(category: string | null): void {
  if (category !== null && !CATEGORIES.includes(category as TransactionCategory)) {
    throw new Error(`Invalid category: ${category}`);
  }
}

/**
 * The user picks a category by hand, for one or many rows. The tagger will not
 * change it again. Money that is not spending leaves its bucket.
 */
export async function setCategory(
  supabase: SupabaseClient,
  ids: string[],
  category: string | null,
  extra: { sub_category?: string | null } = {},
): Promise<void> {
  if (ids.length === 0) return;
  assertCategory(category);

  const { error } = await supabase
    .from("sms_transactions")
    .update({
      category,
      ...extra,
      ...(mayHoldBucket(category) ? {} : { bucket_id: null }),
      ...handDecision(),
    })
    .in("id", ids);
  if (error) throw new Error(error.message);
}

/**
 * The user puts rows in a bucket, or back in the pool with null. A hand
 * decision: the tagger will not move them again.
 */
export async function setBucket(
  supabase: SupabaseClient,
  ids: string[],
  bucketId: string | null,
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from("sms_transactions")
    .update({ bucket_id: bucketId, ...handDecision() })
    .in("id", ids);
  if (error) throw new Error(error.message);
}
