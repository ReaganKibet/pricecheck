// Shared helpers for all edge functions: auth, JSON responses, DB client.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-api-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/**
 * Every caller (the Lua agent, scrapers, the web app's server) sends the
 * shared secret in `x-api-key`. Functions are deployed with --no-verify-jwt,
 * so this check is what keeps them private.
 */
export function guard(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const expected = Deno.env.get("PRICE_API_KEY");
  if (!expected) return error("PRICE_API_KEY is not set on the server", 500);
  if (req.headers.get("x-api-key") !== expected) return error("unauthorised", 401);
  return null;
}

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically
// to edge functions by Supabase.
export function db(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

export function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}
