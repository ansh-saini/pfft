import { NextResponse } from "next/server";
import { withUser } from "@/lib/api/auth";
import { computeParkings } from "@/lib/parkings";
import { currentBalances } from "@/lib/parkingsData";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Undoes a move: both halves of a transfer between parkings. Refused when the
 * money has since been spent from the parking it went to.
 */
export const DELETE = withUser<Ctx>(async (_request, supabase, { params }) => {
  const { id } = await params;
  const { parkings, moves, filed } = await currentBalances(supabase);
  const move = moves.find((m) => m.id === id);
  if (!move || (move.kind !== "funding" && move.kind !== "transfer")) {
    return NextResponse.json({ error: "No such move" }, { status: 404 });
  }
  const undone = new Set(
    move.transfer_group ? moves.filter((m) => m.transfer_group === move.transfer_group).map((m) => m.id) : [id],
  );
  const after = computeParkings(parkings.map((p) => p.id), moves.filter((m) => !undone.has(m.id)), filed).byId;
  const short = parkings.find((p) => after[p.id].balance < -0.001);
  if (short) {
    return NextResponse.json({ error: `${short.name} has already moved or spent that money` }, { status: 409 });
  }
  const { error } = await supabase.from("bucket_ledger").delete().in("id", [...undone]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ undone: [...undone] });
});
