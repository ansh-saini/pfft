import { parse } from "@/lib/parser";
import { createHash } from "crypto";

export function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function buildRecord(
  body: string,
  sender?: string,
  timestamp?: string,
) {
  const parsed = parse(body);
  return {
    raw_body: body,
    body_hash: hashBody(body),
    sender: sender ?? null,
    received_at: timestamp ?? new Date().toISOString(),
    is_spam: parsed.is_spam,
    bank: parsed.is_spam ? null : parsed.bank,
    source: parsed.is_spam ? null : parsed.source,
    account_last4: parsed.is_spam ? null : parsed.account_last4,
    amount: parsed.is_spam ? null : parsed.amount,
    direction: parsed.is_spam ? null : parsed.direction,
    merchant: parsed.is_spam ? null : parsed.merchant,
    upi_ref: parsed.is_spam ? null : parsed.upi_ref,
    transaction_date: parsed.is_spam ? null : parsed.transaction_date,
    transaction_time: parsed.is_spam ? null : parsed.transaction_time,
    // Flag an unconverted foreign charge in the note, so it is obvious in every
    // list that the rupee amount still needs confirming.
    sub_category:
      !parsed.is_spam && parsed.foreign_currency
        ? `${parsed.foreign_currency} ${parsed.amount} — confirm INR amount`
        : null,
  };
}

/** Rupees without noise: 412 not 412.00, but 565.93 keeps its paise. */
function money(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded)
    ? rounded.toLocaleString("en-IN")
    : rounded.toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
}

/** Long merchant names would push the useful part off a notification. */
function shortMerchant(name: string | null, max = 18): string {
  if (!name) return "";
  const clean = name.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export type IngestSummaryInput = {
  amount: number | null;
  direction: string | null;
  merchant: string | null;
  category: string | null;
  bucket: string | null;
};

/**
 * Two lines describing what happened to a transaction.
 *
 * `summary` is built for a phone notification and reads as a sentence: how
 * much, which bucket paid, what it was, and who it went to. The verb carries
 * the direction, so no sign is needed in front of the amount.
 */
export function formatIngestSummary(input: IngestSummaryInput): {
  summary: string;
  detail: string;
} {
  const amount = `₹${money(Number(input.amount ?? 0))}`;
  const verb = input.direction === "credit" ? "back to" : "spent on";
  const who = shortMerchant(input.merchant);
  const from = who ? ` (${who})` : "";

  if (!input.category) {
    return {
      summary: `${amount} spent${from} · needs tagging`,
      detail: `${amount} spent${from} · not categorised — waiting in the inbox`,
    };
  }

  if (!input.bucket) {
    return {
      summary: `${amount} spent: ${input.category}${from} · no bucket`,
      detail: `${amount} spent: ${input.category}${from} · no bucket yet — waiting in the inbox`,
    };
  }

  const line = `${amount} ${verb} ${input.bucket}: ${input.category}${from}`;
  return { summary: line, detail: line };
}
