import { NextResponse } from "next/server";
import { withUser } from "@/lib/api/auth";
import { currentBalances, todayInIndia } from "@/lib/parkingsData";

/**
 * `{ "from": <parking id or null for Float>, "to": <parking id or null>, "amount": 5000 }`.
 * Moves money between Float and a parking, or between two parkings, dated
 * today. Nothing can move more than its source holds.
 */
export const POST = withUser(async (request, supabase) => {
  let body: { from?: unknown; to?: unknown; amount?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 422 });
  }
  const from = typeof body.from === "string" ? body.from : null;
  const to = typeof body.to === "string" ? body.to : null;
  const amount = Math.round(Number(body.amount) * 100) / 100;
  if (!(amount > 0)) return NextResponse.json({ error: "Move more than zero" }, { status: 422 });
  if (from === to) return NextResponse.json({ error: "Pick two different places" }, { status: 422 });

  const { parkings, byId, float } = await currentBalances(supabase);
  const name = (id: string | null) => (id === null ? "Float" : parkings.find((p) => p.id === id)?.name);
  if (!name(from) || !name(to)) return NextResponse.json({ error: "No such parking" }, { status: 404 });

  const available = from === null ? float : byId[from].balance;
  if (available === null) {
    return NextResponse.json({ error: "Float is not known until every bank account has a balance reading" }, { status: 409 });
  }
  if (amount > available + 0.001) {
    return NextResponse.json({ error: `${name(from)} holds only ₹${available.toLocaleString("en-IN")}` }, { status: 409 });
  }

  const occurred_on = todayInIndia();
  const note = `${name(from)} → ${name(to)}`;
  const rows =
    from !== null && to !== null
      ? (() => {
          const transfer_group = crypto.randomUUID();
          return [
            { bucket_id: from, amount: -amount, kind: "transfer", transfer_group, occurred_on, note },
            { bucket_id: to, amount, kind: "transfer", transfer_group, occurred_on, note },
          ];
        })()
      : [{ bucket_id: (to ?? from)!, amount: to ? amount : -amount, kind: "funding", occurred_on, note }];

  const { data, error } = await supabase.from("bucket_ledger").insert(rows).select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ids: (data ?? []).map((r) => r.id), from, to, amount });
});
