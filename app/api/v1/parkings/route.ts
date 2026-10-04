import { NextResponse } from "next/server";
import { withUser } from "@/lib/api/auth";
import { getParkingsOverview } from "@/lib/parkingsData";

/**
 * Float and the parkings. Float is the bank balance not parked anywhere; it
 * is null until every account has a balance reading.
 */
export const GET = withUser(async (_request, supabase) => {
  return NextResponse.json(await getParkingsOverview(supabase));
});

/** `{ "name": "Anniversary Trip", "goal": 50000 }`: a new parking, empty. */
export const POST = withUser(async (request, supabase) => {
  let body: { name?: unknown; goal?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 422 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "A parking needs a name" }, { status: 422 });
  const goal = body.goal === null || body.goal === undefined ? null : Number(body.goal);
  if (goal !== null && !(goal > 0)) {
    return NextResponse.json({ error: "A goal must be more than zero" }, { status: 422 });
  }
  const { data: last } = await supabase.from("buckets").select("sort_order").order("sort_order", { ascending: false }).limit(1);
  const { data, error } = await supabase
    .from("buckets")
    .insert({ name, type: "saving", target_amount: goal, is_default: false, sort_order: (last?.[0]?.sort_order ?? 0) + 1 })
    .select("id, name, target_amount, sort_order")
    .single();
  if (error) {
    const taken = error.code === "23505";
    return NextResponse.json({ error: taken ? `There is already a parking called ${name}` : error.message }, { status: taken ? 409 : 500 });
  }
  return NextResponse.json({ id: data.id, name: data.name, goal: data.target_amount === null ? null : Number(data.target_amount), sort_order: data.sort_order, balance: 0 });
});
