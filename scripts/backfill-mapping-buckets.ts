// Fills in the bucket on merchant rules saved before rules could hold one.
//
//   pnpm backfill:rules          # dry run
//   pnpm backfill:rules --apply

process.loadEnvFile(".env.local");

import { createClient } from "@supabase/supabase-js";
import { buildPattern, confidentFields, type HistoryRow } from "../lib/merchantPatterns";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const apply = process.argv.includes("--apply");
  const { data: buckets } = await supabase.from("buckets").select("id, name");
  const bname = new Map((buckets ?? []).map((b) => [b.id, b.name]));

  const { data: rules } = await supabase
    .from("merchant_mappings")
    .select("merchant, category, bucket_id");

  let filled = 0;
  for (const rule of rules ?? []) {
    if (rule.bucket_id) continue;

    const { data: hist } = await supabase
      .from("sms_transactions")
      .select("category, sub_category, bucket_id")
      .eq("merchant", rule.merchant)
      .eq("is_spam", false);

    const learned = confidentFields(
      buildPattern(rule.merchant, (hist ?? []) as HistoryRow[]),
    );
    if (!learned.bucket_id) {
      console.log(`  ${rule.merchant.padEnd(30)} no settled bucket — left alone`);
      continue;
    }

    console.log(`  ${rule.merchant.padEnd(30)} → ${bname.get(learned.bucket_id)}`);
    filled++;
    if (apply) {
      const { error } = await supabase
        .from("merchant_mappings")
        .update({ bucket_id: learned.bucket_id })
        .eq("merchant", rule.merchant);
      if (error) console.error(`    failed: ${error.message}`);
    }
  }

  console.log(`\n${filled} rule(s) ${apply ? "updated" : "would be updated"}.`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
