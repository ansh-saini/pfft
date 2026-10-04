// Fills in merchant for statement-backfilled transactions inserted before the
// narration parser existed.
//
//   pnpm backfill:merchants           # dry run
//   pnpm backfill:merchants --apply

process.loadEnvFile(".env.local");

import { createClient } from "@supabase/supabase-js";
import { merchantFromNarration } from "../lib/statementReconcile";
import { BACKFILL_NOTE } from "../lib/statementSync";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const apply = process.argv.includes("--apply");

  const { data, error } = await supabase
    .from("sms_transactions")
    .select("id, transaction_date, amount, direction, merchant, raw_body")
    .is("merchant", null)
    .like("raw_body", `%${BACKFILL_NOTE}%`)
    .order("transaction_date");
  if (error) throw new Error(error.message);

  const updates: { id: string; merchant: string; from: string }[] = [];
  const skipped: string[] = [];

  for (const row of data ?? []) {
    // raw_body is "<note> <BANK> <direction> <amount> <narration> <date>".
    const body = (row.raw_body as string).replace(`${BACKFILL_NOTE} `, "");
    const narration = body
      .replace(new RegExp(`^\\w+ ${row.direction} ${row.amount} `), "")
      .replace(/ \d{4}-\d{2}-\d{2}$/, "");

    const merchant = merchantFromNarration(narration);
    if (merchant) updates.push({ id: row.id, merchant, from: narration });
    else skipped.push(narration);
  }

  console.log(`${data?.length ?? 0} backfilled rows with no merchant\n`);
  for (const u of updates) {
    console.log(`  ${u.merchant.padEnd(26)} <- ${u.from.slice(0, 60)}`);
  }
  if (skipped.length) {
    console.log(`\n  no merchant derivable (${skipped.length}):`);
    for (const s of skipped) console.log(`    ${s.slice(0, 70)}`);
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to write ${updates.length} merchants.`);
    return;
  }

  for (const u of updates) {
    const { error } = await supabase
      .from("sms_transactions")
      .update({ merchant: u.merchant })
      .eq("id", u.id)
      .is("merchant", null); // never overwrite one set since the dry run
    if (error) console.error(`  failed ${u.id}: ${error.message}`);
  }
  console.log(`\nUpdated ${updates.length} rows.`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
