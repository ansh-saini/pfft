import { NextResponse } from "next/server";
import { withUser } from "@/lib/api/auth";
import { ingestMessage } from "@/lib/ingestMessage";

/**
 * `{ "body": "<bank SMS>", "sender"?, "timestamp"? }`: the iOS app's "Log
 * Transaction" action relays a message here. Same processing and reply as
 * `/ingest`; a message already logged answers with what was filed then, so
 * the app can retry safely.
 */
export const POST = withUser(async (request, supabase) => {
  let json: { body?: unknown; sender?: unknown; timestamp?: unknown };
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "'body' field is required" }, { status: 422 });
  }
  if (typeof json.body !== "string" || !json.body.trim()) {
    return NextResponse.json({ error: "'body' field is required" }, { status: 422 });
  }
  const result = await ingestMessage(supabase, {
    body: json.body,
    sender: typeof json.sender === "string" ? json.sender : undefined,
    timestamp: typeof json.timestamp === "string" ? json.timestamp : undefined,
  });
  return NextResponse.json(result.body, { status: result.status });
});
