import { createAdminClient } from "@/lib/supabase/admin";
import { completeJSON } from "@/lib/llm";
import { CATEGORIES, type TransactionCategory } from "@/lib/categories";
import { mayHoldBucket } from "@/lib/buckets";
import {
  buildPattern,
  confidentFields,
  describePattern,
  sameMerchant,
} from "@/lib/merchantPatterns";
import {
  ANY_MERCHANT_TOLERANCE,
  LOOKBACK_MONTHS,
  SAME_MERCHANT_TOLERANCE,
  recurringMatches,
  settledRecurring,
  type PastTxn,
} from "@/lib/recurring";
import {
  buildExampleLibrary,
  deriveConfidence,
  matchReviewedNote,
  parseModelReply,
  REVIEW_THRESHOLD,
  type ReviewedExample,
  type TagSource,
} from "@/lib/tagging";

export { CATEGORIES, type TransactionCategory };

/**
 * The `bucket_id` half of a tagging update.
 *
 * A rule and a merchant's history both carry a bucket, and neither knows what
 * the category turned out to be. CRED had nine settlements filed in Bills, so
 * history handed Bills to every new one — the same double count fix-002
 * removed. A category that cannot hold a bucket clears the field outright
 * rather than leaving it: the row may already be sitting in one.
 */
export function bucketPatch(category: string | null | undefined): { bucket_id?: string | null } {
  // Buckets are parkings now, and only the user files money to a parking: the
  // tagger never sets one. It still clears one a category cannot hold.
  if (!mayHoldBucket(category)) return { bucket_id: null };
  return {};
}

/** "Payment of INR 11036.48 has been received towards your Axis Bank Credit Card XX7788". */
const CARD_PAYMENT_RECEIVED =
  /payment of\s+(?:rs|inr)\.?\s*[\d,]+(?:\.\d+)?\s+has been received\s+(?:on|towards)\s+your\b[^.]*credit card/i;

export interface TaggerInput {
  id: string;
  merchant: string | null;
  direction: "debit" | "credit";
  amount: number;
  source: string;
  bank: string;
  raw_body: string;
  /**
   * What this was for, in the user's words ("bike fuel", "refund against
   * books"). Stored in `sub_category`; read from the row when not given.
   */
  description?: string | null;
  /** The transaction's date, for a row that is not in the database (a dry run). */
  transaction_date?: string | null;
}

export type TagOptions = {
  /**
   * Re-tag even a row a person has decided by hand. Used when they have just
   * written a new description and want it read.
   */
  force?: boolean;
  /**
   * Decide without writing anything: the tagger test in the app runs made-up
   * SMS through every step, the model included, against the real history.
   */
  dryRun?: boolean;
}

/** What the tagger decided and how sure it was. */
export type TagResult = {
  category: string;
  bucket_id: string | null;
  confidence: number;
  tagged_by: TagSource;
  reasoning: string | null;
};

type Decision = {
  category: string;
  bucket_id: string | null;
  source: TagSource;
  modelConfidence?: number | null;
  reasoning?: string | null;
};

/**
 * Files one transaction: category, bucket, and how sure we are.
 *
 * The user's description (`sub_category`) is the primary input — a merchant
 * name says who, never why. The tagger reads it and never writes it. In
 * order: the card-payment rule; an exact match on a description the user has
 * decided by hand before (replayed); a merchant rule; the same payment
 * recurring around this day in earlier months; merchant history; and only
 * then the model, briefed with how the user's descriptions have been filed
 * and with what was paid around this date before. Confidence is derived from
 * which path decided, never taken from the model's own estimate.
 *
 * A row a person has decided by hand is left alone unless `force` is set.
 */
export async function tagTransaction(
  tx: TaggerInput,
  options: TagOptions = {},
): Promise<TagResult | undefined> {
  const supabase = createAdminClient();

  console.log(`[tagger] start id=${tx.id} merchant=${tx.merchant ?? "null"} direction=${tx.direction} amount=${tx.amount}`);

  const { data: row } = await supabase
    .from("sms_transactions")
    .select("sub_category, reviewed_at, transaction_date")
    .eq("id", tx.id)
    .maybeSingle();

  if (row?.reviewed_at && !options.force) {
    console.log(`[tagger] id=${tx.id} was reviewed on ${row.reviewed_at} — leaving it alone`);
    return;
  }

  const note = (tx.description ?? row?.sub_category)?.trim() || null;
  const txDate: string | null = row?.transaction_date ?? tx.transaction_date ?? null;

  const persist = async (decision: Decision, hasHistory: boolean): Promise<TagResult> => {
    const confidence = deriveConfidence({
      source: decision.source,
      modelConfidence: decision.modelConfidence,
      hasNote: note !== null,
      hasHistory,
    });

    if (options.dryRun) {
      console.log(`[tagger] dry run id=${tx.id} → ${decision.category} via ${decision.source} (${confidence})`);
    } else {
      const { error } = await supabase
        .from("sms_transactions")
        .update({
          category: decision.category,
          ...bucketPatch(decision.category),
          ai_confidence: confidence,
          tagged_by: decision.source,
          // The tagger decided this, so it is no longer a hand decision.
          reviewed_at: null,
        })
        .eq("id", tx.id);

      if (error) {
        console.error(`[tagger] DB update failed for id=${tx.id}:`, error.message);
      } else {
        console.log(`[tagger] id=${tx.id} → ${decision.category} via ${decision.source} (${confidence})`);
      }
    }

    return {
      category: decision.category,
      bucket_id: null,
      confidence,
      tagged_by: decision.source,
      reasoning: decision.reasoning ?? null,
    };
  };

  // 1. The card end of a bill payment. "Payment of INR 11036.48 has been
  //    received towards your Axis Bank Credit Card XX7788" is the same money as
  //    the CRED debit out of the savings account, seen from the other side —
  //    not income. The wording is fixed, so match it here rather than asking.
  if (tx.direction === "credit" && CARD_PAYMENT_RECEIVED.test(tx.raw_body)) {
    return persist(
      { category: "Self Transfer", bucket_id: null, source: "rule" },
      false,
    );
  }

  // Everything below wants the buckets and how the user's descriptions have
  // been filed. The library goes into every model call, described or not: the
  // model server caches the system prompt, and one that changed between calls
  // would be read again from the start each time.
  const [{ data: bucketRows }, examples] = await Promise.all([
    supabase.from("buckets").select("id, name").is("archived_at", null).order("sort_order"),
    loadReviewedExamples(supabase),
  ]);
  const buckets = (bucketRows ?? []) as { id: string; name: string }[];
  const bucketIdByName = new Map(buckets.map((b) => [b.name, b.id]));

  // 2. A description the user has decided by hand before is their own
  //    decision. Replay it — no rule, no history, no model.
  const replay = matchReviewedNote(note, examples.filter((e) => e.confirmed));
  if (replay) {
    console.log(`[tagger] id=${tx.id} description "${note}" matches a hand decision`);
    return persist(
      {
        category: replay.category,
        bucket_id: replay.bucket ? (bucketIdByName.get(replay.bucket) ?? null) : null,
        source: "note",
      },
      false,
    );
  }

  // 3. A hand-saved merchant rule is an explicit instruction and wins on the
  //    fields it sets. It does not short-circuit the rest: an older rule may
  //    carry no bucket, and history usually knows it.
  let rule: { category: string; sub_category: string | null; bucket_id: string | null } | null = null;

  if (tx.merchant) {
    const { data: rules, error: mappingError } = await supabase
      .from("merchant_mappings")
      .select("merchant, category, sub_category, bucket_id");

    if (mappingError) {
      console.error(`[tagger] merchant_mappings query error for id=${tx.id}:`, mappingError);
    }

    // Exact spelling first, then the normalised match, so an explicit rule
    // still applies when the bank changes how it writes the name.
    rule =
      rules?.find((r) => r.merchant === tx.merchant) ??
      rules?.find((r) => sameMerchant(r.merchant, tx.merchant)) ??
      null;
  }

  // 5. Learn from how this merchant has already been filed. Matched on a
  //    normalised name: "VSI*YOUTUBEGO" from SMS and "YOUTUBEGOOG" from the
  //    statement are one merchant.
  let history: PastRow[] = [];
  if (tx.merchant) {
    const { data } = await supabase
      .from("sms_transactions")
      .select(PAST_COLUMNS)
      .eq("is_spam", false)
      .not("merchant", "is", null)
      .not("category", "is", null)
      .neq("id", tx.id)
      .order("transaction_date", { ascending: false });

    history = toPast(data).filter((r) => sameMerchant(r.merchant, tx.merchant));
  }

  const pattern = buildPattern(tx.merchant ?? "", history);
  const learned = confidentFields(pattern);

  // 4. The same counterparty, about the same amount, around this day in
  //    earlier months. More specific than the merchant's overall history, so
  //    it decides even when that history is mixed.
  const recurring = txDate
    ? recurringMatches(
        { transaction_date: txDate, amount: tx.amount },
        history.filter((h) => h.direction === tx.direction),
        SAME_MERCHANT_TOLERANCE,
      )
    : [];
  const recurs = settledRecurring(recurring);

  // The same amount on about the same day to anyone else. Only evidence for
  // the model: a different name at the same amount can be coincidence.
  const lookalikes =
    txDate && tx.amount >= LOOKALIKE_FLOOR ? await findLookalikes(supabase, tx, txDate) : [];

  const hasHistory = history.length > 0 || lookalikes.length > 0;

  // The rule wins field by field; a recurrence, then history, supply whatever
  // it left unset.
  const resolved = {
    category: rule?.category ?? recurs?.category ?? learned.category,
    bucket_id: rule?.bucket_id ?? recurs?.bucket_id ?? learned.bucket_id,
  };

  // With no description, a settled merchant is decided here. With one that no
  // hand decision matched, the merchant is only context — "ROHAN VERMA" has
  // been Other/Needs nine times and the description may say this was a loan.
  if (resolved.category && note === null) {
    console.log(
      `[tagger] ${rule ? "rule" : recurs ? `recurring (${recurring.length} earlier months)` : "pattern"} for "${tx.merchant}": ${describePattern(pattern)}`,
    );
    return persist(
      {
        category: resolved.category,
        bucket_id: resolved.bucket_id ?? null,
        source: rule ? "rule" : "history",
      },
      hasHistory,
    );
  }

  // 6. Ask, with the whole record of how this person files money in front of
  //    the model.
  console.log(`[tagger] calling the model for id=${tx.id}${note ? ` with description "${note}"` : ""}`);
  // The model being unreachable — the server down, asleep or slower than the
  // timeout — is not an error in the transaction. The row simply waits in the
  // inbox, and the caller carries on.
  let raw = "";
  try {
    raw = await completeJSON({
      system: systemPrompt(buckets, examples),
      user: userPrompt({
        tx,
        date: txDate,
        description: note,
        history,
        recurring,
        lookalikes,
        resolved,
        bucketName: (id) => buckets.find((b) => b.id === id)?.name ?? null,
      }),
      schema: REPLY_SCHEMA,
    });
  } catch (err) {
    console.error(
      `[tagger] model call failed for id=${tx.id}, left for review:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }

  console.log(`[tagger] model raw response for id=${tx.id}:`, raw);

  const reply = parseModelReply(raw, buckets.map((b) => b.name));
  if (!reply) {
    console.log(`[tagger] id=${tx.id}: no usable answer from the model, left for review`);
    return;
  }

  return persist(
    {
      category: reply.category,
      bucket_id: reply.bucket ? (bucketIdByName.get(reply.bucket) ?? null) : null,
      source: "ai",
      modelConfidence: reply.confidence,
      reasoning: reply.reasoning,
    },
    hasHistory,
  );
}

/**
 * Tags rows by id, a few at a time. For rows that arrive without passing
 * through `/ingest` (statement sync, manual entries) and for re-running the
 * inbox. Rows decided by hand and spam rows are skipped. A failure on one row is
 * logged and does not stop the rest.
 */
export async function tagByIds(ids: string[], concurrency = 4): Promise<void> {
  if (!ids.length) return;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("sms_transactions")
    .select("id, merchant, direction, amount, source, bank, raw_body")
    .in("id", ids)
    .eq("is_spam", false)
    .is("reviewed_at", null);
  if (error) {
    console.error("[tagger] could not load rows to tag:", error.message);
    return;
  }

  const queue = [...(data ?? [])];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      try {
        await tagTransaction({
          id: row.id,
          merchant: row.merchant,
          direction: row.direction as "debit" | "credit",
          amount: Number(row.amount),
          source: row.source ?? "",
          bank: row.bank ?? "",
          raw_body: row.raw_body ?? "",
        });
      } catch (err) {
        console.error(`[tagger] tagging id=${row.id} threw:`, err instanceof Error ? err.message : err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

/**
 * How the user's descriptions have been filed. Hand decisions come first and
 * are marked `confirmed`: only those are replayed without asking. The rest
 * (filed by the tagger with enough confidence, or before scoring existed) are
 * briefing for the model. The bucket travels by name because that is what the
 * model reads and writes.
 */
export async function loadReviewedExamples(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<ReviewedExample[]> {
  const columns = "sub_category, category, buckets:bucket_id(name)";
  const [{ data: decided }, { data: filed }] = await Promise.all([
    supabase
      .from("sms_transactions")
      .select(columns)
      .eq("is_spam", false)
      .not("reviewed_at", "is", null)
      .not("sub_category", "is", null)
      .not("category", "is", null)
      .order("reviewed_at", { ascending: false })
      .limit(400),
    supabase
      .from("sms_transactions")
      .select(columns)
      .eq("is_spam", false)
      .is("reviewed_at", null)
      .not("sub_category", "is", null)
      .not("category", "is", null)
      .or(`ai_confidence.is.null,ai_confidence.gte.${REVIEW_THRESHOLD}`)
      .order("transaction_date", { ascending: false })
      .limit(800),
  ]);

  const toExample = (confirmed: boolean) => (r: {
    sub_category: string | null;
    category: string | null;
    buckets: unknown;
  }): ReviewedExample => ({
    note: r.sub_category as string,
    category: r.category as string,
    bucket: (r.buckets as { name?: string } | null)?.name ?? null,
    confirmed,
  });

  return [...(decided ?? []).map(toExample(true)), ...(filed ?? []).map(toExample(false))];
}

/**
 * The reply's shape, enforced by the model server's grammar: a small model
 * cannot answer with a category that is not listed or with prose around the
 * JSON. `parseModelReply` still checks it.
 */
const REPLY_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...CATEGORIES] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasoning: { type: "string", maxLength: 100 },
  },
  required: ["category", "confidence", "reasoning"],
  additionalProperties: false,
};

function systemPrompt(
  buckets: { name: string }[],
  examples: ReviewedExample[],
): string {
  const library = buildExampleLibrary(examples);
  return `You file transactions for one Indian household's personal finance app. Each transaction gets exactly one category.

Categories — pick exactly one:
${CATEGORIES.map((c) => `- ${c}`).join("\n")}

Category rules:
- "Salary / Income": large credits (₹10,000+) from an employer. Never dividends or interest.
- "Dividend / Interest": passive income — company dividends (DIV, NACH, a company name), REIT/InvIT distributions, savings interest. Often tiny.
- "Self Transfer": money between the user's own accounts. A credit saying a payment was received towards a credit card is the far end of a card settlement — Self Transfer, never income.
- "Credit Card Bill": paying off a card, often via CRED. CRED also pays utility bills; read the narration. Neither this nor Self Transfer is spending.
- "Refund": a credit that reverses or reimburses a spend. "Refund for X" or "refund against X" in a description is a Refund, filed to the bucket X would have drained. A person paying the user back their share of a meal, a trip or a bill is a Refund too, never the meal's or the trip's category: on a credit (money in), a description like "share of dinner" or "paid back for the cab" names what is being repaid, so the category is Refund.
- "Food & Dining": restaurants, cafes, coffee chains, bars, food delivery. "Groceries" is food bought to cook at home.
- "Fitness": sports facility and court bookings (a DDA sports complex such as "DDA YSC", a badminton court), gyms, coaching, sports kit fees. "Health & Medical" is doctors, pharmacies, tests.
- "EMI / Loan": loan repayments. "Investment": SIPs, funds, stocks, broker transfers. "Subscription": recurring digital services.
- Money lent to a person, a shared bill you fronted, a gift, a contribution to a group gift: these are real spending. Use the closest category ("Other" if none fits) and the bucket the household would pay it from.

The user's description is the primary evidence. It is short and casual ("bike fuel", "office lunch", "refund against books") and says what the money was actually for, in their own words. Weigh it above the merchant name and above how the merchant was filed before.
${
  library
    ? `
How this user's descriptions have been filed before, the ones they decided by hand first. The same words mean the same thing again, and similar words usually do:
${library}
`
    : ""
}
Reply with JSON only, no markdown, in exactly this shape:
{"category": "<one of the categories>", "confidence": <0 to 1>, "reasoning": "<one short sentence, under 15 words>"}

Confidence is how sure you are of the category. At 0.5 or above the transaction is filed without asking the user; below 0.5 the user is asked. Be honest: a well-known shop or service you can identify belongs near 0.6 to 0.7, a payment that recurs on the same day every month and has always been filed one way belongs near 0.9, a description that matches one filed before belongs near 0.95, and a person's name with no description, no recurrence and no consistent history is a guess that belongs near 0.4. Never invent a category that is not listed.`;
}

const PAST_COLUMNS =
  "merchant, category, sub_category, bucket_id, transaction_date, amount, direction";

type PastRow = PastTxn & { direction: string | null };

function toPast(
  data:
    | {
        merchant: string | null;
        category: string | null;
        sub_category: string | null;
        bucket_id: string | null;
        transaction_date: string | null;
        amount: number | string | null;
        direction: string | null;
      }[]
    | null,
): PastRow[] {
  return (data ?? [])
    .filter((r) => r.transaction_date)
    .map((r) => ({
      merchant: r.merchant,
      category: r.category,
      sub_category: r.sub_category,
      bucket_id: r.bucket_id,
      transaction_date: r.transaction_date as string,
      amount: Number(r.amount ?? 0),
      direction: r.direction,
    }));
}

/** Below this a same-amount coincidence is too likely to be worth showing. */
const LOOKALIKE_FLOOR = 500;

/**
 * Filed transactions at this amount, same direction, around this day of the
 * month in earlier months, from any counterparty but this one.
 */
async function findLookalikes(
  supabase: ReturnType<typeof createAdminClient>,
  tx: TaggerInput,
  txDate: string,
): Promise<PastRow[]> {
  const since = new Date(txDate);
  since.setMonth(since.getMonth() - LOOKBACK_MONTHS - 1);

  const { data } = await supabase
    .from("sms_transactions")
    .select(PAST_COLUMNS)
    .eq("is_spam", false)
    .eq("direction", tx.direction)
    .not("category", "is", null)
    .neq("id", tx.id)
    .gte("amount", tx.amount * (1 - ANY_MERCHANT_TOLERANCE))
    .lte("amount", tx.amount * (1 + ANY_MERCHANT_TOLERANCE))
    .gte("transaction_date", since.toISOString().slice(0, 10))
    .lt("transaction_date", txDate.slice(0, 7) + "-01");

  const others = toPast(data).filter((r) => !sameMerchant(r.merchant, tx.merchant));
  return recurringMatches({ transaction_date: txDate, amount: tx.amount }, others, ANY_MERCHANT_TOLERANCE);
}

const INR = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

function describePast(p: PastRow, bucketName: (id: string) => string | null): string {
  const bucket = p.bucket_id ? bucketName(p.bucket_id) : null;
  return [
    `- ${p.transaction_date} ₹${INR.format(p.amount)}`,
    p.merchant ? ` to/from ${p.merchant}` : "",
    `: ${p.category ?? "untagged"}`,
    p.sub_category ? ` / ${p.sub_category}` : "",
    bucket ? ` (bucket ${bucket})` : "",
  ].join("");
}

function userPrompt(input: {
  tx: TaggerInput;
  date: string | null;
  description: string | null;
  history: PastRow[];
  recurring: PastRow[];
  lookalikes: PastRow[];
  resolved: { category?: string | null; bucket_id?: string | null };
  bucketName: (id: string) => string | null;
}): string {
  const { tx, description, history, recurring, lookalikes, resolved, bucketName } = input;
  const lines = [
    `Merchant/Party: ${tx.merchant ?? "Unknown"}`,
    `Direction: ${tx.direction === "debit" ? "debit (money out)" : "credit (money in)"}`,
    `Amount: ₹${tx.amount}`,
    `Date: ${input.date ?? "unknown"}`,
    `Bank: ${tx.bank} / ${tx.source}`,
    `Raw SMS: ${tx.raw_body}`,
    `User's description: ${description ? `"${description}"` : "(none)"}`,
  ];

  if (recurring.length) {
    lines.push(
      "",
      "The same party at about this amount around this day in earlier months (a recurring payment is usually the same thing every month):",
      ...recurring.map((p) => describePast(p, bucketName)),
    );
  }

  if (history.length) {
    lines.push(
      "",
      "How this merchant has been filed before, newest first:",
      ...history.slice(0, 10).map((p) => describePast(p, bucketName)),
    );
    if (resolved.category) {
      lines.push(`(Settled pattern: ${resolved.category}. The description overrides it if they disagree.)`);
    }
  }

  if (lookalikes.length) {
    lines.push(
      "",
      "Other parties paid this exact amount around this day in earlier months (may be the same obligation under a different name, or coincidence):",
      ...lookalikes.map((p) => describePast(p, bucketName)),
    );
  }

  return lines.join("\n");
}
