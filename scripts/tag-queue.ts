// Re-runs the tagger over every row in the Inbox, so rows it can now decide
// leave and only the ones that need a person stay.
//
//   pnpm tag:queue           # tag everything in the Inbox
//   pnpm tag:queue --dry     # only count what is waiting
//   pnpm tag:queue --refresh-ai   # also re-run rows the model filed and nobody
//                                 # has reviewed, e.g. after the tagger changes
//
// Never touches a row decided by hand. Requires NEXT_PUBLIC_SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, LLM_BASE_URL and LLM_API_KEY in .env.local.

process.loadEnvFile(".env.local");

import { createClient } from "@supabase/supabase-js";
import { getInboxTransactions } from "../lib/inbox";
import { tagByIds } from "../lib/tagger";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const before = await getInboxTransactions(supabase);
  const ids = new Set(before.map((r) => r.id));
  console.log(`${before.length} rows in the Inbox.`);

  if (process.argv.includes("--refresh-ai")) {
    const { data } = await supabase
      .from("sms_transactions")
      .select("id")
      .eq("is_spam", false)
      .eq("tagged_by", "ai")
      .is("reviewed_at", null);
    const extra = (data ?? []).filter((r) => !ids.has(r.id));
    for (const r of extra) ids.add(r.id);
    console.log(`${extra.length} more filed by the model and not reviewed, re-running those too.`);
  }

  if (process.argv.includes("--dry") || !ids.size) return;

  await tagByIds([...ids]);

  const after = await getInboxTransactions(supabase);
  console.log(`\n${before.length - after.length} filed, ${after.length} still need a person:`);
  for (const r of after) {
    console.log(
      `  ${r.transaction_date ?? "no date"}  ₹${r.amount}  ${r.merchant ?? "?"}  → ${r.category ?? "untagged"} (${r.ai_confidence ?? "-"})`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
