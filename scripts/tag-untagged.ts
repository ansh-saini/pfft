// Run with: npm run tag:untagged
// Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LLM_BASE_URL, LLM_API_KEY in .env.local

process.loadEnvFile(".env.local");

import { createClient } from "@supabase/supabase-js";
import { tagTransaction, type TaggerInput } from "../lib/tagger";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const { data: rows, error } = await supabase
    .from("sms_transactions")
    .select("id, merchant, direction, amount, source, bank, raw_body")
    .eq("is_spam", false)
    .is("category", null)
    .order("transaction_date", { ascending: false });

  if (error) {
    console.error("Fetch failed:", error.message);
    process.exit(1);
  }

  if (!rows.length) {
    console.log("No untagged transactions.");
    return;
  }

  console.log(`Tagging ${rows.length} transactions...`);

  let ok = 0;
  let fail = 0;

  for (const row of rows) {
    const label = `${row.merchant ?? "?"} ₹${row.amount} (${row.direction})`;
    process.stdout.write(`  ${label} ... `);
    try {
      await tagTransaction(row as TaggerInput);
      process.stdout.write("done\n");
      ok++;
    } catch (e) {
      process.stdout.write(`error: ${(e as Error).message}\n`);
      fail++;
    }
  }

  console.log(`\nDone. ${ok} tagged, ${fail} failed.`);
}

main();
