import { NextResponse } from "next/server";
import { withUser } from "@/lib/api/auth";
import { TX_COLUMNS, toApiTransaction } from "@/lib/api/data";
import { currentBalances } from "@/lib/parkingsData";

type Ctx = { params: Promise<{ id: string }> };

/** One parking: its balance, every move in or out, and what was filed to it. */
export const GET = withUser<Ctx>(async (_request, supabase, { params }) => {
  const { id } = await params;
  const { parkings, moves, byId } = await currentBalances(supabase);
  const parking = parkings.find((p) => p.id === id);
  if (!parking) return NextResponse.json({ error: "No such parking" }, { status: 404 });

  const names = new Map(parkings.map((p) => [p.id, p.name]));
  const own = moves
    .filter((m) => m.bucket_id === id)
    .map((m) => {
      // The other side: another parking for a transfer, Float otherwise.
      const other = m.transfer_group
        ? moves.find((o) => o.transfer_group === m.transfer_group && o.id !== m.id)
        : undefined;
      return {
        id: m.id,
        amount: Number(m.amount),
        kind: m.kind,
        occurred_on: m.occurred_on,
        created_at: m.created_at ?? null,
        counterpart: other ? (names.get(other.bucket_id) ?? "A deleted parking") : m.kind === "adjustment" ? null : "Float",
        note: m.note,
      };
    })
    .sort((a, b) => ((b.occurred_on ?? "") + (b.created_at ?? "")).localeCompare((a.occurred_on ?? "") + (a.created_at ?? "")));

  const { data: txns, error } = await supabase
    .from("sms_transactions")
    .select(TX_COLUMNS)
    .eq("is_spam", false)
    .eq("bucket_id", id)
    .order("transaction_date", { ascending: false });
  if (error) throw new Error(error.message);

  return NextResponse.json({
    parking: { ...parking, balance: byId[id].balance },
    moves: own,
    transactions: (txns ?? []).map((t) => toApiTransaction(t as Record<string, unknown>)),
  });
});

/** `{ "name"?, "goal"? }`: rename, or set or clear (`null`) the goal. */
export const PATCH = withUser<Ctx>(async (request, supabase, { params }) => {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 422 });
  }
  const patch: Record<string, unknown> = {};
  if ("name" in body) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "A parking needs a name" }, { status: 422 });
    patch.name = name;
  }
  if ("goal" in body) {
    const goal = body.goal === null ? null : Number(body.goal);
    if (goal !== null && !(goal > 0)) return NextResponse.json({ error: "A goal must be more than zero" }, { status: 422 });
    patch.target_amount = goal;
  }
  const { data, error } = await supabase
    .from("buckets")
    .update(patch)
    .eq("id", id)
    .eq("type", "saving")
    .select("id, name, target_amount, sort_order")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "No such parking" }, { status: 404 });
  return NextResponse.json({ id: data.id, name: data.name, goal: data.target_amount === null ? null : Number(data.target_amount), sort_order: data.sort_order });
});

/**
 * Deletes a parking. Its money returns to Float without moving anything:
 * its moves go with it and what was filed to it is unfiled.
 */
export const DELETE = withUser<Ctx>(async (_request, supabase, { params }) => {
  const { id } = await params;
  const { data, error } = await supabase.from("buckets").delete().eq("id", id).eq("type", "saving").select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data?.length) return NextResponse.json({ error: "No such parking" }, { status: 404 });
  return NextResponse.json({ deleted: id });
});
