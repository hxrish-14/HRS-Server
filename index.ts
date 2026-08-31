// ============================================================================
// Edge Function: backup-login
//
// A fallback sign-in path. Verifies the identifier/password against the
// hashed public.backup_logins table (see 004_backup_login.sql), and only
// on a match, asks Supabase Auth itself to issue a REAL session for that
// account's email — via a one-time email OTP code generated server-side,
// never a password Auth ever compares. This runs entirely server-side:
// the service role key never leaves this function.
//
// Why not just return "ok: true" and let the frontend fake a login?
// Because every RLS policy in this project checks auth.uid(), which only
// exists inside a genuine Supabase Auth session — anything less would
// pass a check here and then see zero data everywhere else.
//
// Request:  { identifier, password }
// Response (success): { email, otp }   — client then calls
//                       supabase.auth.verifyOtp({ email, token: otp, type: "email" })
// Response (failure):  { error } with a generic message — never reveals
//                       which part (identifier vs password) was wrong.
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Extremely small in-memory rate limiter per isolate — a courtesy layer
// only, same caveat as elsewhere in this project: not a substitute for
// platform-level rate limiting, but cheap protection against rapid guessing.
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 60_000;
function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) { attempts.set(key, { count: 1, resetAt: now + WINDOW_MS }); return false; }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { identifier?: string; password?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  const identifier = (body.identifier ?? "").trim();
  const password = body.password ?? "";
  if (!identifier || !password) return json({ error: "Invalid credentials" }, 401);

  const ip = req.headers.get("x-forwarded-for") ?? "unknown";
  if (rateLimited(`${ip}:${identifier.toLowerCase()}`)) {
    return json({ error: "Too many attempts. Try again later." }, 429);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const { data: verifyRows, error: verifyErr } = await admin.rpc("verify_backup_login", {
      p_identifier: identifier, p_password: password,
    });
    if (verifyErr) {
      console.error("[backup-login] verify_backup_login RPC error:", verifyErr.message);
      return json({ error: "Backup login is not set up correctly. Run 004_backup_login.sql and set a backup password." }, 500);
    }

    const result = Array.isArray(verifyRows) ? verifyRows[0] : verifyRows;
    if (!result?.ok) return json({ error: "Invalid credentials" }, 401);

    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: result.email,
    });
    if (linkErr || !linkData?.properties?.email_otp) {
      console.error("[backup-login] generateLink failed:", linkErr?.message);
      return json({ error: "Could not issue a session for this account. Check that the email is confirmed in Supabase Auth." }, 500);
    }

    return json({ email: result.email, otp: linkData.properties.email_otp });
  } catch (err) {
    console.error("[backup-login] Unexpected error:", err);
    return json({ error: "Internal error" }, 500);
  }
});
