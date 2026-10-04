import { NextResponse } from "next/server";
import { withUser } from "@/lib/api/auth";
import { getInboxTransactions } from "@/lib/inbox";

/** Every transaction that needs the user, across all cycles. */
export const GET = withUser(async (_request, supabase) => {
  return NextResponse.json({ transactions: await getInboxTransactions(supabase) });
});
