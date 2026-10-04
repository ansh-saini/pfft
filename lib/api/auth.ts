import "server-only";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

/**
 * A Supabase client that acts as the person holding this access token, the
 * same way the web's cookie client acts as the signed-in person. The iOS app
 * signs in against Supabase auth and sends the access token as a Bearer
 * header; nothing here trusts the app beyond that token.
 */
export async function clientForRequest(
  request: NextRequest,
): Promise<{ supabase: SupabaseClient } | { error: NextResponse }> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return { error: unauthorized("Missing Bearer token") };

  const supabase = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );

  // Checked locally against the project's published signing keys (cached
  // after the first request), the same way the web proxy does it, instead of
  // a round trip to Supabase Auth on every call.
  // A malformed or expired token throws rather than returning an error; both
  // must answer 401 so the app refreshes its session.
  const claims = await supabase.auth.getClaims(token).catch(() => null);
  if (!claims || claims.error || !claims.data?.claims.sub) {
    return { error: unauthorized("Session expired") };
  }

  return { supabase };
}

function unauthorized(message: string) {
  return NextResponse.json({ error: message }, { status: 401 });
}

/** A route handler that runs only for a signed-in person. */
export function withUser<Ctx>(
  handler: (request: NextRequest, supabase: SupabaseClient, ctx: Ctx) => Promise<Response>,
) {
  return async (request: NextRequest, ctx: Ctx): Promise<Response> => {
    const result = await clientForRequest(request);
    if ("error" in result) return result.error;
    try {
      return await handler(request, result.supabase, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      console.error("[api]", request.nextUrl.pathname, message);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  };
}
