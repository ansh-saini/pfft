import { NextResponse } from "next/server";
import { withUser } from "@/lib/api/auth";
import { accountBalances } from "@/lib/accountBalance";
import { loadBalanceInputs } from "@/lib/accountBalanceData";

/**
 * The bank balance as the app keeps it: each account's last reading plus
 * everything recorded since, and how well past readings agreed with that
 * method. A reconciliation or a statement sync adds a reading, which is the
 * next check.
 */
export const GET = withUser(async (_request, supabase) => {
  const { snapshots, txns } = await loadBalanceInputs(supabase);
  const accounts = accountBalances(snapshots, txns);
  const known = accounts.filter((a) => a.balance !== null);
  return NextResponse.json({
    /** Null until every account has at least one reading. */
    total: known.length === accounts.length ? known.reduce((sum, a) => sum + a.balance!, 0) : null,
    accounts,
  });
});
