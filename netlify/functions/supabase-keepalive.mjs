import { createClient } from "@supabase/supabase-js";

// Runs in production every six hours (UTC) to generate a tiny read-only DB request.
export const config = { schedule: "0 */6 * * *" };

export default async function keepSupabaseAwake() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase keep-alive is missing public project configuration.");

  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { error } = await client.from("profiles").select("id").limit(1);
  if (error) throw new Error(`Supabase keep-alive request failed (${error.code || "unknown"}).`);
}
