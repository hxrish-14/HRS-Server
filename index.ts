// ============================================================================
// Edge Function: admin-users
//
// Performs privileged Supabase Auth operations (create user, send password
// reset, disable user) that require the service role key. Never callable
// with unchecked privilege: every request must carry the caller's own
// access token, and this function verifies — server-side, against the
// database — that the caller's profile role is 'admin' before doing
// anything. A modified frontend cannot skip this check.
//
// Actions:
//   { action: "create",  email, username, display_name, role, manager_id? }
//   { action: "reset_password", user_id }
//   { action: "disable", user_id }
//   { action: "enable",  user_id }
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
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const VALID_ROLES = ["admin", "harish", "guest", "localadmin"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const callerToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!callerToken) return json({ error: "Missing authorization" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Identify the caller from their own token, then look up their role in
  // the database — never trust a role claim sent in the request body.
  const { data: callerUser, error: callerErr } = await admin.auth.getUser(callerToken);
  if (callerErr || !callerUser?.user) return json({ error: "Invalid session" }, 401);

  const { data: callerProfile } = await admin
    .from("profiles").select("role, is_active").eq("id", callerUser.user.id).single();

  if (!callerProfile || callerProfile.role !== "admin" || !callerProfile.is_active) {
    await admin.from("activity_log").insert({
      user_id: callerUser.user.id,
      event_type: "unauthorized_access_attempt",
      severity: "critical",
      metadata: { function: "admin-users" },
    });
    return json({ error: "Not authorized" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  try {
    switch (body.action) {
      case "create": {
        const { email, username, display_name, role, manager_id } = body as Record<string, string>;
        if (!email || !username || !display_name || !VALID_ROLES.includes(role)) {
          return json({ error: "Missing or invalid fields" }, 400);
        }
        const { data: created, error: createErr } = await admin.auth.admin.createUser({
          email, email_confirm: true,
        });
        if (createErr || !created.user) return json({ error: "Could not create the auth user" }, 400);

        const { error: profileErr } = await admin.from("profiles").insert({
          id: created.user.id, username, display_name, email, role,
          manager_id: manager_id || null,
        });
        if (profileErr) return json({ error: "Auth user created, but profile insert failed" }, 500);

        await admin.from("activity_log").insert({
          user_id: callerUser.user.id, event_type: "user_created", severity: "info",
          metadata: { new_user_id: created.user.id, role },
        });

        // A password-recovery email is sent instead of returning any password.
        await admin.auth.resetPasswordForEmail(email);
        return json({ id: created.user.id });
      }

      case "reset_password": {
        const { user_id } = body as Record<string, string>;
        const { data: target } = await admin.from("profiles").select("email").eq("id", user_id).single();
        if (!target) return json({ error: "User not found" }, 404);
        await admin.auth.resetPasswordForEmail(target.email);
        await admin.from("activity_log").insert({
          user_id: callerUser.user.id, event_type: "password_reset_requested", severity: "info",
          metadata: { target_user_id: user_id },
        });
        return json({ ok: true });
      }

      case "disable":
      case "enable": {
        const { user_id } = body as Record<string, string>;
        const isActive = body.action === "enable";
        const { error: updErr } = await admin.from("profiles").update({ is_active: isActive }).eq("id", user_id);
        if (updErr) return json({ error: "Could not update user" }, 500);
        await admin.auth.admin.updateUserById(user_id, { ban_duration: isActive ? "none" : "876000h" });
        await admin.from("activity_log").insert({
          user_id: callerUser.user.id,
          event_type: isActive ? "user_enabled" : "user_disabled",
          severity: "info",
          metadata: { target_user_id: user_id },
        });
        return json({ ok: true });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch {
    return json({ error: "Internal error" }, 500);
  }
});
