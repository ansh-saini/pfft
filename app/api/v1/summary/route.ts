import { NextResponse } from "next/server";
import { withUser } from "@/lib/api/auth";
import { cycleTransactions, resolveCycle } from "@/lib/api/data";
import { getInboxCount } from "@/lib/inbox";
import { salaryCredit, summarise } from "@/lib/summary";
import { paidFromParkings } from "@/lib/parkingsData";

/** The dashboard for one cycle: `?cycle=YYYY-MM`, or the current one. */
export const GET = withUser(async (request, supabase) => {
  const { cycle } = await resolveCycle(supabase, request.nextUrl.searchParams.get("cycle"));
  const [transactions, inboxCount, fromParkings] = await Promise.all([
    cycleTransactions(supabase, cycle),
    getInboxCount(supabase),
    paidFromParkings(supabase, cycle),
  ]);
  const s = summarise(transactions);

  return NextResponse.json({
    cycle,
    income: s.income,
    spend: s.spend,
    investments: s.investments,
    leftover: s.leftover,
    /** The cycle's salary credit, or null while it has not landed. */
    salary: salaryCredit(transactions),
    /** Of this cycle's spend, what parkings paid; the rest came from Float. */
    from_parkings: fromParkings,
    categories: s.categories,
    inbox_count: inboxCount,
    recent: transactions.slice(0, 8),
  });
});
