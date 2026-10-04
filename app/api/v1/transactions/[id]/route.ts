import { NextResponse } from "next/server";
import { withUser } from "@/lib/api/auth";
import { toApiTransaction, TX_COLUMNS } from "@/lib/api/data";
import { setBucket, setCategory } from "@/lib/transactions";

type Ctx = { params: Promise<{ id: string }> };

async function load(supabase: Parameters<Parameters<typeof withUser>[0]>[1], id: string) {
  const { data, error } = await supabase
    .from("sms_transactions")
    .select(`${TX_COLUMNS}, raw_body, account_last4`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    ...toApiTransaction(data),
    raw_body: (data.raw_body as string | null) ?? null,
    account_last4: (data.account_last4 as string | null) ?? null,
  };
}

/** One transaction, with the SMS it came from. */
export const GET = withUser<Ctx>(async (_request, supabase, { params }) => {
  const { id } = await params;
  const row = await load(supabase, id);
  if (!row) return NextResponse.json({ error: "No such transaction" }, { status: 404 });
  return NextResponse.json(row);
});

/**
 * A hand decision: `{ "category": "..." }` and/or `{ "bucket_id": "..." | null }`.
 * The tagger will not change these rows again until a new description is
 * written.
 */
export const PATCH = withUser<Ctx>(async (request, supabase, { params }) => {
  const { id } = await params;
  let body: { category?: string | null; bucket_id?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 422 });
  }

  const hasCategory = Object.prototype.hasOwnProperty.call(body, "category");
  const hasBucket = Object.prototype.hasOwnProperty.call(body, "bucket_id");
  if (!hasCategory && !hasBucket) {
    return NextResponse.json({ error: "Send category and/or bucket_id" }, { status: 422 });
  }

  try {
    if (hasCategory) await setCategory(supabase, [id], body.category ?? null);
    if (hasBucket) await setBucket(supabase, [id], body.bucket_id ?? null);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save";
    return NextResponse.json({ error: message }, { status: 422 });
  }

  const row = await load(supabase, id);
  if (!row) return NextResponse.json({ error: "No such transaction" }, { status: 404 });
  return NextResponse.json(row);
});
