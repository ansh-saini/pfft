// Data-integrity audit over every non-spam transaction. Read-only.
//
//   pnpm audit:data
//
// ERROR is a structural problem that breaks the maths — a row with no date
// falls outside every cycle and hides in the carried balance, which is how
// 30,000 of phantom SIP spend went unnoticed for months.
// TODO is work waiting for you. CHECK needs judgment: same-date repeats are
// often genuine, and some merchants really do span categories.
process.loadEnvFile(".env.local");

import { createClient } from "@supabase/supabase-js";
import { isInPool, mayHoldBucket } from "../lib/buckets";
import { needsReview } from "../lib/tagging";
import { isInternal } from "../lib/categories";
import { buildReconciliation, type BalanceSnapshot } from "../lib/balances";
import type { Bucket, DatedLedgerRow, DatedTxn } from "../lib/buckets";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const inr = (n: number) => "Rs " + Math.round(n).toLocaleString("en-IN");

async function main() {
  const { data: buckets } = await supabase
    .from("buckets").select("id, name, type").is("archived_at", null);
  const bname = new Map((buckets ?? []).map((b) => [b.id, b.name]));

  const { data: all } = await supabase
    .from("sms_transactions")
    .select("id, transaction_date, received_at, amount, direction, merchant, category, sub_category, bucket_id, source, bank, is_spam, raw_body, note, ai_confidence, reviewed_at")
    .eq("is_spam", false)
    .order("transaction_date");

  const rows = all ?? [];
  console.log(`${rows.length} non-spam transactions\n`);

  const issues: { level: string; title: string; lines: string[] }[] = [];
  const add = (level: string, title: string, lines: string[]) => {
    if (lines.length) issues.push({ level, title, lines });
  };

  // 1. Exact duplicates: same date, amount, direction, source.
  const groups: Record<string, typeof rows> = {};
  for (const r of rows) {
    if (!r.transaction_date) continue;
    const k = `${r.transaction_date}|${r.amount}|${r.direction}|${r.source}`;
    (groups[k] ??= []).push(r);
  }
  const dupes: string[] = [];
  for (const [k, g] of Object.entries(groups)) {
    if (g.length < 2) continue;
    const backfills = g.filter((r) => /Backfilled/.test(r.raw_body ?? "")).length;
    dupes.push(
      `${k}  ×${g.length}  (${backfills} backfilled, ${g.length - backfills} sms)  ${g.map((r) => r.merchant ?? "—").join(" / ")}`,
    );
  }
  add("CHECK", "Same date + amount + direction + source (may be genuine repeats)", dupes);

  // 2. Structural gaps that break the maths.
  add("ERROR", "No transaction_date — falls outside every cycle",
    rows.filter((r) => !r.transaction_date)
      .map((r) => `${r.id.slice(0, 8)} ${r.direction} ${inr(Number(r.amount))} ${r.merchant ?? "—"}`));

  add("ERROR", "No amount",
    rows.filter((r) => r.amount === null)
      .map((r) => `${r.id.slice(0, 8)} ${r.transaction_date} ${r.merchant ?? "—"}`));

  add("ERROR", "No direction",
    rows.filter((r) => !r.direction)
      .map((r) => `${r.id.slice(0, 8)} ${r.transaction_date} ${inr(Number(r.amount))}`));

  add("ERROR", "Negative or zero amount",
    rows.filter((r) => Number(r.amount) <= 0)
      .map((r) => `${r.id.slice(0, 8)} ${r.transaction_date} ${r.amount} ${r.merchant ?? "—"}`));

  // 3. Work still to do.
  add("TODO", "Untagged", rows.filter((r) => !r.category)
    .map((r) => `${r.transaction_date} ${inr(Number(r.amount))} ${r.merchant ?? "—"}`));

  add("TODO", "In the pool (no bucket)", rows.filter(isInPool)
    .map((r) => `${r.transaction_date} ${inr(Number(r.amount))} ${r.category ?? "untagged"} ${r.merchant ?? "—"}`));

  // 4. Category/bucket combinations that contradict each other.
  const wrongBucket: string[] = [];
  const expect: Record<string, string> = {
    "EMI / Loan": "Bills", Insurance: "Bills", Subscription: "Bills", Utilities: "Bills",
    Investment: "Investing", "Dividend / Interest": "Investing",
  };
  for (const r of rows) {
    if (!r.category || !r.bucket_id) continue;
    const want = expect[r.category];
    const got = bname.get(r.bucket_id);
    if (want && got !== want)
      wrongBucket.push(`${r.transaction_date} ${inr(Number(r.amount))} ${r.category} sits in ${got} (expected ${want}) — ${r.merchant ?? "—"}`);
  }
  add("CHECK", "Category and bucket disagree", wrongBucket);

  // 5. Money that should never have entered a bucket. A card settlement is the
  // loudest case: it charges Bills for a Blinkit order that already drained
  // Needs, so the same rupee is spent twice and lands in the wrong pot.
  add("ERROR", "Salary / internal transfer assigned to a bucket",
    rows.filter((r) => r.bucket_id && (r.category === "Salary / Income" || isInternal(r.category)))
      .map((r) => `${r.transaction_date} ${inr(Number(r.amount))} ${r.category} in ${bname.get(r.bucket_id!)} — ${r.merchant ?? "—"}`));

  // 6. Credit-card bill payments recorded as income.
  add("CHECK", "Credit-card bill payment not marked internal",
    rows.filter((r) => r.direction === "credit" &&
      /payment of .* (has been )?received|received (on|towards) your .*credit card/i.test(r.raw_body ?? "") &&
      !isInternal(r.category))
      .map((r) => `${r.transaction_date} ${inr(Number(r.amount))} cat=${r.category} bucket=${bname.get(r.bucket_id ?? "") ?? "-"} — ${r.merchant ?? "—"}`));

  // 7. Same counterparty tagged inconsistently.
  const byMerchant: Record<string, Set<string>> = {};
  for (const r of rows) {
    if (!r.merchant || !r.category) continue;
    (byMerchant[r.merchant] ??= new Set()).add(r.category);
  }
  add("CHECK", "One merchant, several categories",
    Object.entries(byMerchant).filter(([, c]) => c.size > 1)
      .map(([m, c]) => `${m} → ${[...c].join(", ")}`));

  // 8. Foreign charges whose rupee amount was never confirmed.
  add("TODO", "Foreign card charge — rupee amount not confirmed",
    rows.filter((r) => /confirm INR amount/i.test(r.sub_category ?? ""))
      .map((r) => `${r.transaction_date} stored as ${inr(Number(r.amount))} — ${r.sub_category} — ${r.merchant ?? "—"}`));

  // 9. Missing merchant.
  add("TODO", "No merchant", rows.filter((r) => !r.merchant)
    .map((r) => `${r.transaction_date} ${r.direction} ${inr(Number(r.amount))} ${r.category ?? "untagged"}`));

  // 9b. Rows the tagger was not sure about, waiting for a person.
  add("TODO", "Waiting for review",
    rows
      .filter((r) => needsReview({
        reviewed_at: r.reviewed_at,
        category: r.category,
        bucket_id: r.bucket_id,
        ai_confidence: r.ai_confidence,
        mayHoldBucket: mayHoldBucket(r.category),
      }))
      .map((r) => `${r.transaction_date} ${r.direction} ${inr(Number(r.amount))} ${r.category ?? "untagged"}${r.ai_confidence !== null ? ` (${Math.round(Number(r.ai_confidence) * 100)}%)` : ""} — ${r.merchant ?? "—"}${r.note ? ` — "${r.note}"` : ""}`));

  // 10. The only check against something that did not come from us: does the
  //     app's picture of the money match what the bank said it held?
  const [{ data: snapshots }, { data: ledgerRows }] = await Promise.all([
    supabase.from("balance_snapshots")
      .select("id, bank, balance, observed_at, origin, source_txn_id, reconcile_group, note"),
    supabase.from("bucket_ledger").select("bucket_id, amount, occurred_on, kind"),
  ]);

  const reconciliation = buildReconciliation(
    (snapshots ?? []) as BalanceSnapshot[],
    (buckets ?? []) as Bucket[],
    (ledgerRows ?? []) as DatedLedgerRow[],
    rows as DatedTxn[],
  );

  if (reconciliation.asOf === null) {
    add("TODO", "Never reconciled against the bank",
      ["No reconciliation covers every account. Run Reconcile on /protected/buckets."]);
  } else if (Math.abs(reconciliation.unallocated) > 1) {
    add("TODO", "Buckets do not match the bank", [
      `As of ${reconciliation.asOf.slice(0, 10)}: bank ${inr(reconciliation.bankTotal)}, buckets ${inr(reconciliation.bucketTotal)}, ` +
      `difference ${inr(reconciliation.unallocated)}` +
      (reconciliation.txnsSince ? ` (${reconciliation.txnsSince} transactions since)` : ""),
    ]);
  }

  for (const i of issues) {
    console.log(`\n[${i.level}] ${i.title} — ${i.lines.length}`);
    for (const l of i.lines.slice(0, 14)) console.log(`   ${l}`);
    if (i.lines.length > 14) console.log(`   … ${i.lines.length - 14} more`);
  }
  if (!issues.length) console.log("No issues found.");
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
