// One-off: move dividend, REIT distribution and bank-interest credits onto the
// 'Dividend / Interest' category.
//
//   pnpm tsx scripts/retag-dividends.ts           # dry run
//   pnpm tsx scripts/retag-dividends.ts --apply

process.loadEnvFile(".env.local");

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const CATEGORY = "Dividend / Interest";

// Narration markers seen across both banks. NACH alone is not enough — it is a
// clearing rail used for debits too — so it only counts on a credit.
const DIVIDEND = /\b(div|dividend|interest|reit|nach)\b/i;

async function main() {
  const apply = process.argv.includes("--apply");

  const { data, error } = await supabase
    .from("sms_transactions")
    .select("id, transaction_date, amount, merchant, category, raw_body")
    .eq("direction", "credit")
    .eq("is_spam", false)
    .order("transaction_date");
  if (error) throw new Error(error.message);

  const hits = (data ?? []).filter(
    (r) =>
      r.category !== CATEGORY &&
      DIVIDEND.test(`${r.merchant ?? ""} ${r.raw_body ?? ""}`),
  );

  if (hits.length === 0) {
    console.log("Nothing to retag.");
    return;
  }

  console.log(`${hits.length} credits to move onto "${CATEGORY}":\n`);
  let total = 0;
  for (const h of hits) {
    total += Number(h.amount);
    console.log(
      `  ${h.transaction_date}  Rs ${String(Math.round(Number(h.amount))).padStart(6)}  ` +
        `${(h.category ?? "untagged").padEnd(20)} -> ${CATEGORY}   ${h.merchant ?? "(no merchant)"}`,
    );
  }
  console.log(`\n  total Rs ${Math.round(total).toLocaleString("en-IN")}`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write.");
    return;
  }

  const { data: updated, error: updateError } = await supabase
    .from("sms_transactions")
    .update({ category: CATEGORY })
    .in(
      "id",
      hits.map((h) => h.id),
    )
    .select("id");
  if (updateError) throw new Error(updateError.message);

  console.log(`\nRetagged ${updated?.length ?? 0} transactions.`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
