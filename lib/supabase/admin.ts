import { createClient } from "@supabase/supabase-js";

// Service-role client for server-side background operations (no cookie context needed).
// Never expose to the browser.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
