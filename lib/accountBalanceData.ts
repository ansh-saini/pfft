import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BalanceSnapshot } from "@/lib/balances";
import type { BalanceTxn } from "@/lib/accountBalance";
import { BANKS, BANK_SOURCE } from "@/lib/statementSync";
import type { KnownAccount } from "@/lib/statementBank";

/** What `accountBalances` needs: every reading, and every account transaction. */
export async function loadBalanceInputs(
  supabase: SupabaseClient,
): Promise<{ snapshots: BalanceSnapshot[]; txns: BalanceTxn[] }> {
  const [{ data: snapshots, error: snapError }, { data: txns, error: txnError }] = await Promise.all([
    supabase.from("balance_snapshots").select("*"),
    supabase
      .from("sms_transactions")
      .select("source, direction, amount, transaction_date, received_at")
      .eq("is_spam", false)
      .in("source", Object.values(BANK_SOURCE)),
  ]);
  if (snapError || txnError) throw new Error((snapError ?? txnError)!.message);
  return { snapshots: (snapshots ?? []) as BalanceSnapshot[], txns: (txns ?? []) as BalanceTxn[] };
}

/**
 * The user's bank accounts as their SMS name them: for each bank, the
 * account digits seen most often (e.g. ICICI "123", Axis "4321").
 */
export async function loadAccounts(supabase: SupabaseClient): Promise<KnownAccount[]> {
  const { data, error } = await supabase
    .from("sms_transactions")
    .select("source, account_last4")
    .in("source", Object.values(BANK_SOURCE))
    .not("account_last4", "is", null);
  if (error) throw new Error(error.message);
  const counts = new Map<string, Map<string, number>>();
  for (const row of data ?? []) {
    const bySource = counts.get(row.source) ?? new Map<string, number>();
    bySource.set(row.account_last4, (bySource.get(row.account_last4) ?? 0) + 1);
    counts.set(row.source, bySource);
  }
  return BANKS.flatMap((bank) => {
    const bySource = counts.get(BANK_SOURCE[bank]);
    if (!bySource) return [];
    const [last4] = [...bySource.entries()].sort((a, b) => b[1] - a[1])[0];
    return [{ bank, last4 }];
  });
}
