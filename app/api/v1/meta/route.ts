import { NextResponse } from "next/server";
import { withUser } from "@/lib/api/auth";
import { CATEGORIES } from "@/lib/categories";
import { getBuckets, mayHoldBucket } from "@/lib/buckets";
import { getCycles, getCurrentCycleId } from "@/lib/cycles";
import { loadAccounts } from "@/lib/accountBalanceData";

/** What the app needs to draw pickers: categories, buckets, cycles, and the
 * user's accounts (to tell which bank a shared statement is from). */
export const GET = withUser(async (_request, supabase) => {
  const [buckets, cycles, accounts] = await Promise.all([
    getBuckets(supabase),
    getCycles(supabase),
    loadAccounts(supabase),
  ]);
  return NextResponse.json({
    categories: CATEGORIES.map((name) => ({ name, may_hold_bucket: mayHoldBucket(name) })),
    buckets: buckets.map((b) => ({
      id: b.id,
      name: b.name,
      type: b.type,
      is_default: b.is_default,
    })),
    cycles,
    current_cycle_id: getCurrentCycleId(cycles),
    accounts,
  });
});
