// Reads the balance out of every bank SMS already stored.
//
//   pnpm backfill:balances          # dry run
//   pnpm backfill:balances --apply
//
// ICICI states "Avl Bal Rs. ..." on its non-UPI alerts, so a history of what
// the bank actually held is sitting in raw_body and has never been read. Axis
// states no balance in any message it sends — those accounts are typed in by
// hand at a reconciliation.

process.loadEnvFile(".env.local");

import { createClient } from "@supabase/supabase-js";
import { parseAvailableBalance, bankForSource } from "../lib/balances";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const inr = (n: number) =>
  "Rs " + n.toLocaleString("en-IN", { minimumFractionDigits: 2 });

async function main() {
  const apply = process.argv.includes("--apply");

  const { data, error } = await supabase
    .from("sms_transactions")
    .select("id, source, raw_body, received_at, transaction_date")
    .eq("is_spam", false)
    .order("transaction_date", { ascending: true });

  if (error) throw new Error(`Could not load transactions: ${error.message}`);

  const { data: existing } = await supabase
    .from("balance_snapshots")
    .select("source_txn_id")
    .not("source_txn_id", "is", null);
  const already = new Set((existing ?? []).map((r) => r.source_txn_id as string));

  const rows = (data ?? [])
    .map((txn) => {
      const balance = parseAvailableBalance(txn.raw_body, txn.source);
      const bank = bankForSource(txn.source);
      if (balance === null || !bank) return null;
      return {
        bank,
        balance,
        observed_at:
          txn.received_at ??
          (txn.transaction_date ? `${txn.transaction_date}T00:00:00Z` : new Date().toISOString()),
        origin: "sms" as const,
        source_txn_id: txn.id,
      };
    })
    .filter((r) => r !== null)
    .filter((r) => !already.has(r.source_txn_id));

  if (rows.length === 0) {
    console.log("No new balances to read.");
    return;
  }

  for (const row of rows) {
    console.log(`  ${row.observed_at.slice(0, 10)}  ${row.bank.padEnd(6)} ${inr(row.balance).padStart(16)}`);
  }
  console.log(`\n${rows.length} snapshot(s) ${apply ? "written" : "would be written"}.`);

  if (!apply) {
    console.log("Dry run. Re-run with --apply.");
    return;
  }

  for (let i = 0; i < rows.length; i += 200) {
    const { error: insertError } = await supabase
      .from("balance_snapshots")
      .insert(rows.slice(i, i + 200));
    if (insertError) throw new Error(insertError.message);
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
