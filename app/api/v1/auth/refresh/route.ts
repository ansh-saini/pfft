import { NextResponse, type NextRequest } from "next/server";
import { anonymousClient, sessionBody } from "@/lib/api/session";

/** `{ "refresh_token" }` → a fresh session. 401 means sign in again. */
export async function POST(request: NextRequest) {
  let refreshToken: unknown;
  try {
    refreshToken = (await request.json()).refresh_token;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 422 });
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    return NextResponse.json({ error: "'refresh_token' is required" }, { status: 422 });
  }

  const { data, error } = await anonymousClient().auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) {
    return NextResponse.json({ error: error?.message ?? "Session expired" }, { status: 401 });
  }
  return NextResponse.json(sessionBody(data.session));
}
