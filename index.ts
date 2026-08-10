// ============================================================================
// Edge Function: time-login
//
// Two-factor login: normal Supabase Auth password + a server-computed
// "current-time password" derived from a secret the browser never sees.
//
// Required secrets (set with `supabase secrets set ...`, never in source):
//   TIME_LOGIN_SECRET      - random long string, the shared static secret
//   TIME_LOGIN_WINDOW_SECS - validity window in seconds (e.g. "30")
//   SUPABASE_URL            (auto-provided by the platform)
//   SUPABASE_SERVICE_ROLE_KEY (auto-provided by the platform)
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TIME_SECRET = Deno.env.get("TIME_LOGIN_SECRET")!;
const WINDOW_SECS = parseInt(Deno.env.get("TIME_LOGIN_WINDOW_SECS") ?? "30", 10);

// How many windows on either side of "now" we accept, to absorb clock skew
// between the code's issuance and its arrival. Keep this small.
const WINDOW_TOLERANCE = 1;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Constant-time string comparison to avoid timing side-channels.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacCode(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(String(counter)),
  );
  const bytes = new Uint8Array(sig);
  // Truncate to a 8-digit numeric code (custom scheme, not TOTP/RFC 6238).
  let num = 0;
  for (let i = 0; i < 4; i++) num = (num << 8) | bytes[i];
  num = num >>> 0;
  return String(num % 100000000).padStart(8, "0");
}

async function isValidTimeCode(code: string): Promise<boolean> {
  if (!/^[0-9]{8}$/.test(code)) return false;
  const nowCounter = Math.floor(Date.now() / 1000 / WINDOW_SECS);
  for (let delta = -WINDOW_TOLERANCE; delta <= WINDOW_TOLERANCE; delta++) {
    const expected = await hmacCode(TIME_SECRET, nowCounter + delta);
    if (timingSafeEqual(expected, code)) return true;
  }
  return false;
}

// Extremely small in-memory rate limiter per isolate. Not a substitute for
// platform-level rate limiting, but cheap protection against rapid guessing.
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 60_000;

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { email?: string; password?: string; timeCode?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const timeCode = (body.timeCode ?? "").trim();

  if (!email || !password || !timeCode) {
    return json({ error: "Authentication failed" }, 401);
  }

  const ip = req.headers.get("x-forwarded-for") ?? "unknown";
  if (rateLimited(`${ip}:${email}`)) {
    return json({ error: "Too many attempts. Try again later." }, 429);
  }

  // 1. Validate the current-time password FIRST — never reveal whether the
  //    password was correct if this fails, and never touch Auth if it fails.
  const timeOk = await isValidTimeCode(timeCode);
  if (!timeOk) {
    return json({ error: "Authentication failed" }, 401);
  }

  // 2. Validate identity + normal password via Supabase Auth, server-side,
  //    using the service role so the anon client never handles this path
  //    directly (keeps both factors gated behind this single endpoint).
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data, error } = await admin.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    return json({ error: "Authentication failed" }, 401);
  }

  // 3. Return only the minimum needed for the browser to establish a
  //    session — never the time-login secret or formula.
  return json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
  });
});
