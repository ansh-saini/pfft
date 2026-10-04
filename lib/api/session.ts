import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Session } from "@supabase/supabase-js";

/** A client with no user yet, for signing in and refreshing. */
export function anonymousClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** The parts of a Supabase session the app keeps. */
export function sessionBody(session: Session) {
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in,
    email: session.user.email ?? null,
  };
}
