import { NextResponse, type NextRequest } from "next/server";
import { anonymousClient, sessionBody } from "@/lib/api/session";

/**
 * `{ "email", "password" }` → a session for the iOS app. The app never talks
 * to Supabase itself; it signs in here and sends the access token back as a
 * Bearer header.
 */
export async function POST(request: NextRequest) {
  let email: unknown;
  let password: unknown;
  try {
    ({ email, password } = await request.json());
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 422 });
  }
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 422 });
  }

  const { data, error } = await anonymousClient().auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    return NextResponse.json({ error: error?.message ?? "Could not sign in" }, { status: 401 });
  }
  return NextResponse.json(sessionBody(data.session));
}
