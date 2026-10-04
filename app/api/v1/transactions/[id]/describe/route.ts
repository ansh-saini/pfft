import { NextResponse } from "next/server";
import { withUser } from "@/lib/api/auth";
import { describe } from "@/lib/transactions";

type Ctx = { params: Promise<{ id: string }> };

/**
 * `{ "description": "bike fuel" }`: what the transaction was for. Saved as its
 * description, then the model decides category and bucket from it. Returns what
 * the row holds afterwards.
 */
export const POST = withUser<Ctx>(async (request, supabase, { params }) => {
  const { id } = await params;
  let description: unknown;
  try {
    description = (await request.json()).description;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 422 });
  }
  if (typeof description !== "string") {
    return NextResponse.json({ error: "'description' is required" }, { status: 422 });
  }
  return NextResponse.json(await describe(supabase, id, description));
});
