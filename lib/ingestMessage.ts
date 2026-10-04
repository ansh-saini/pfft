import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { tagTransaction } from "@/lib/tagger";
import { buildRecord, formatIngestSummary, hashBody } from "@/lib/ingest";
import { parse } from "@/lib/parser";
import { recordSmsBalance } from "@/lib/balances";
import { needsInput } from "@/lib/inbox";

export type IngestInput = {
  body: string;
  sender?: string;
  timestamp?: string;
};

/**
 * One bank SMS, start to finish: parse, insert, keep any stated balance, tag,
 * and read back what was filed. Called by `/api/v1/ingest` (the iOS app,
 * signed in). Returns the HTTP status and the JSON body.
 */
export async function ingestMessage(
  supabase: SupabaseClient,
  input: IngestInput,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = input.body.trim();
  const parsed = parse(text);

  console.log("[ingest] parsed:", {
    is_spam: parsed.is_spam,
    bank: parsed.is_spam ? null : parsed.bank,
    source: parsed.is_spam ? null : parsed.source,
    merchant: parsed.is_spam ? null : parsed.merchant,
    direction: parsed.is_spam ? null : parsed.direction,
    amount: parsed.is_spam ? null : parsed.amount,
  });

  // Shared with the bulk route so both paths behave identically. Building the
  // row here separately meant the foreign-currency flag only reached bulk
  // ingest, and a live card charge lost it.
  const record = buildRecord(text, input.sender, input.timestamp);

  const { data, error } = await supabase
    .from("sms_transactions")
    .insert(record)
    .select("id")
    .single();

  if (error) {
    // 23505 is the unique body hash: this SMS was logged before. The app
    // retries a message whose reply it never saw, so answer with what that
    // first attempt filed rather than an error.
    if (error.code === "23505") {
      const { data: existing } = await supabase
        .from("sms_transactions")
        .select("id")
        .eq("body_hash", hashBody(text))
        .single();
      if (existing) return filedResult(supabase, existing.id, record, undefined, true);
    }
    console.error("[ingest] Supabase insert error:", error);
    return { status: 500, body: { error: "Database error", detail: error.message } };
  }

  console.log("[ingest] inserted row id:", data.id);

  // The bank states its own balance on some messages. It costs nothing to keep
  // and it is the only figure in the system that did not come from us.
  const balance = await recordSmsBalance(supabase, {
    id: data.id,
    source: record.source,
    raw_body: input.body,
    received_at: record.received_at,
    transaction_date: record.transaction_date,
  });
  if (balance !== null) {
    console.log(`[ingest] balance snapshot recorded: ${balance}`);
  }

  // Skip tagging for spam or unparseable messages
  if (record.is_spam) {
    console.log("[ingest] is_spam=true, skipping tagger");
    return {
      status: 200,
      body: {
        status: "ok",
        id: data.id,
        is_spam: true,
        summary: "Not a transaction — ignored",
        detail: "Not a transaction — ignored",
        parsed: null,
      },
    };
  }

  let tag: Awaited<ReturnType<typeof tagTransaction>> | undefined;
  try {
    tag = await tagTransaction({
      id: data.id,
      merchant: record.merchant,
      direction: record.direction as "debit" | "credit",
      amount: record.amount!,
      source: record.source!,
      bank: record.bank!,
      raw_body: input.body,
    });
    console.log("[ingest] tagger result:", tag ?? "no tag returned");
  } catch (err) {
    console.error("[ingest] tagTransaction threw:", err);
  }

  return filedResult(supabase, data.id, record, tag, false);
}

/**
 * Reads back what the tagger settled on, including the bucket it filed the
 * transaction into, so the caller can show the outcome without a second
 * request.
 */
async function filedResult(
  supabase: SupabaseClient,
  id: string,
  record: ReturnType<typeof buildRecord>,
  tag: Awaited<ReturnType<typeof tagTransaction>> | undefined,
  duplicate: boolean,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { data: filed } = await supabase
    .from("sms_transactions")
    .select("category, sub_category, bucket_id, ai_confidence, tagged_by, reviewed_at, is_spam, buckets:bucket_id(name)")
    .eq("id", id)
    .single();

  const bucketRow = filed?.buckets as { name?: string } | null;
  const bucket = bucketRow?.name ?? null;
  const category = filed?.category ?? tag?.category ?? null;
  const isSpam = filed?.is_spam ?? record.is_spam;

  const { summary, detail } = isSpam
    ? { summary: "Not a transaction — ignored", detail: "Not a transaction — ignored" }
    : formatIngestSummary({
        amount: record.amount,
        direction: record.direction,
        merchant: record.merchant,
        category,
        bucket,
      });

  return {
    status: 200,
    body: {
      status: "ok",
      id,
      is_spam: isSpam,
      /** True when this SMS was already logged; the rest describes that row. */
      ...(duplicate ? { duplicate: true } : {}),
      /** Built for a phone notification. */
      summary,
      /** Same event with the category spelled out. */
      detail,
      /** How sure the tagger was, 0-1. Under 0.5 the row waits in the Inbox. */
      confidence: tag?.confidence ?? filed?.ai_confidence ?? null,
      tagged_by: tag?.tagged_by ?? filed?.tagged_by ?? null,
      /**
       * True means ask "what was this for?" and POST the answer to
       * /api/v1/transactions/[id]/describe.
       */
      needs_review: isSpam ? false : filed ? needsInput(filed) : true,
      parsed: isSpam
        ? null
        : {
            category,
            sub_category: filed?.sub_category ?? null,
            bucket,
            bank: record.bank,
            source: record.source,
            amount: record.amount,
            direction: record.direction,
            merchant: record.merchant,
            transaction_date: record.transaction_date,
          },
    },
  };
}
