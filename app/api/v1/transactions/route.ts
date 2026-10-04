import { NextResponse } from "next/server";
import { withUser } from "@/lib/api/auth";
import { cycleTransactions, resolveCycle, toApiTransaction, TX_COLUMNS } from "@/lib/api/data";

/**
 * `?cycle=YYYY-MM` lists that cycle (default: the current one). `?q=` searches
 * merchant and description across every cycle instead, newest first.
 */
export const GET = withUser(async (request, supabase) => {
  const params = request.nextUrl.searchParams;
  const q = params.get("q")?.trim();

  if (q) {
    // PostgREST's or() splits on commas and parentheses; keep them out.
    const term = q.replace(/[,()%*]/g, " ").trim();
    const { data, error } = await supabase
      .from("sms_transactions")
      .select(TX_COLUMNS)
      .eq("is_spam", false)
      .or(`merchant.ilike.*${term}*,sub_category.ilike.*${term}*,category.ilike.*${term}*`)
      .order("transaction_date", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return NextResponse.json({ cycle: null, transactions: (data ?? []).map(toApiTransaction) });
  }

  const { cycle } = await resolveCycle(supabase, params.get("cycle"));
  return NextResponse.json({ cycle, transactions: await cycleTransactions(supabase, cycle) });
});
