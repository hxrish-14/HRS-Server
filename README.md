# Private File Vault

A lightweight, private file-*link* manager. Files themselves stay on MediaFire
or Telegram — this app stores metadata and enforces who is allowed to see
which link.

## 1. Architecture

```
Browser (HTML/CSS/vanilla JS, Supabase anon key only)
        │
        ├── Supabase Auth ── password check (via Edge Function)
        ├── Postgres + RLS ── all read/write authorization
        └── Edge Function "time-login" ── second-factor check + password
                                            check, using the service role
                                            key server-side only
```

The browser is never trusted. Every authorization decision is enforced by
PostgreSQL Row Level Security, not by JavaScript `if (role === "admin")`
checks. The frontend only *hides* controls for UX; it cannot grant access.

## 2. Features

- Two-factor login: Supabase Auth password **+** a custom current-time
  password (not OTP/TOTP), verified server-side in an Edge Function.
- Three roles: `admin`, `harish`, `guest`, each with per-file access grants.
- Debounced, database-backed search and category filtering.
- Admin dashboard: add/edit/deactivate files, manage categories, manage
  per-file permissions, change external links — no redeploy needed.
- Download and audit logging.
- Full light/dark-safe design tokens, responsive layout, keyboard and
  screen-reader accessible.

## 3. File structure

```
private-file-vault/
├── index.html
├── style.css
├── app.js
├── database.sql
├── README.md
└── supabase/functions/time-login/index.ts
```

## 4. Supabase project setup

1. Create a project at supabase.com.
2. Project Settings → API → copy the **Project URL** and **anon/publishable
   key**. You will paste these into `app.js` (step 8).
3. Do **not** copy the service role key anywhere in this repo — it is only
   used inside the Edge Function runtime, which the platform injects
   automatically.

## 5. Database setup

In the Supabase SQL editor, run the entire contents of `database.sql`. It
creates all tables, indexes, RLS policies, helper functions, and seeds the
default categories. It contains **no** credentials.

## 6. Auth user creation

In Authentication → Users, create three users manually (or via the Admin
API), setting the permanent passwords yourself — they are never stored in
this repository:

```
Admin@privateserver.co.in
Harish@privateserver.co.in
Guest@privateserver.co.in
```

## 7. Role/profile setup

After creating the users above, copy each generated UUID and insert their
profile rows:

```sql
insert into public.profiles (id, username, display_name, role) values
  ('<admin-auth-uuid>',  'admin',  'Admin',  'admin'),
  ('<harish-auth-uuid>', 'harish', 'Harish', 'harish'),
  ('<guest-auth-uuid>',  'guest',  'Guest',  'guest');
```

## 8. Frontend configuration

Open `app.js` and edit the `CONFIG` block at the top:

```javascript
const CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_ANON_PUBLISHABLE_KEY",
  TIME_LOGIN_FUNCTION: "time-login",
};
```

These are the only two secrets allowed in frontend code — the anon key is
designed to be public and is meaningless without RLS + Auth behind it.

## 9. Edge Function deployment

```bash
supabase functions deploy time-login
```

## 10. Edge Function secret configuration

```bash
supabase secrets set TIME_LOGIN_SECRET="a-long-random-string-only-you-know"
supabase secrets set TIME_LOGIN_WINDOW_SECS="30"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by
the platform — do not set them yourself.

### Current-time password format (safe to document)

The code is an **8-digit number**, derived server-side from
`HMAC-SHA256(TIME_LOGIN_SECRET, floor(server_time / WINDOW_SECS))`,
truncated to 8 digits. It changes every `TIME_LOGIN_WINDOW_SECS` seconds and
is validated with a ±1 window of tolerance for clock drift. This is **not**
RFC 6238 TOTP — it has no client-visible seed, QR code, or authenticator-app
compatibility by design. Whoever needs to log in must be given a way to
compute this code out of band (e.g. a small script you keep for yourself
that knows the secret); that generator is intentionally outside this
repository.

## 11. RLS explanation

- `is_admin()` / `current_role_name()` are `security definer` functions so
  policies can check the caller's role without recursive RLS lookups.
- `admin` bypasses file-visibility restrictions entirely.
- `harish` and `guest` can only `select` rows in `files` that are `is_active
  = true` **and** have a matching row in `file_access` for their own user id.
- Only `admin` can insert/update/delete `files`, `categories`, and
  `file_access`.
- `download_logs` inserts are restricted to logging your *own* successful,
  authorized downloads — you cannot log downloads for files you can't see.
- `audit_logs` are written by the admin client and readable only by admin.

## 12. Local testing

Any static file server works, e.g.:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Open the printed URL in a browser.

## 13. Deployment

Host `index.html`, `style.css`, `app.js` on any static host (GitHub Pages,
Netlify, Vercel, Cloudflare Pages). No build step is required.

## 14. Security checklist

```
[ ] Guest cannot access Harish-only files
[ ] Harish cannot access Guest-only files
[ ] Guest cannot access admin functions
[ ] Harish cannot access admin functions
[ ] Modified frontend cannot bypass RLS
[ ] Service-role key is not exposed
[ ] Passwords are not stored in database.sql
[ ] Passwords are not stored in frontend
[ ] XSS test fails safely
[ ] Dangerous URLs are rejected
[ ] Unauthorized database queries fail
[ ] Expired current-time authentication fails
[ ] Browser clock manipulation does not bypass authentication
[ ] Logout works
[ ] Session restoration works
[ ] Broken links are handled
[ ] Network errors are handled
```

To verify RLS directly, open the browser console while logged in as
`guest` and try `supabase.from('files').select('*')` for a file only
`harish` has access to — it should return an empty array, not an error,
and never the row.

## 15. Known limitations

- This app protects access to the **link**, not the file itself. Once an
  authorized user receives a MediaFire or Telegram URL, they could share it
  outside the app — that is outside this system's control.
- The in-memory rate limiter in the Edge Function is per-isolate and best
  effort only; for stronger abuse protection, add Supabase's built-in rate
  limiting or a WAF in front of the function.
- Do not attempt to use this system to bypass MediaFire's or Telegram's own
  security or terms of service.

## 16. How to add files

Admin → Files → **Add file** → fill in name, category, source, description,
URL, active status, and tick which users can see it → Save.

## 17. How to change links

Admin → Files → open the file → edit **External URL** → Save. No code
changes or redeploy required.

## 18. How to change permissions

Admin → Files → open the file → tick/untick users under **Accessible
users** → Save. This rewrites the `file_access` rows for that file.

## 19. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Login always fails | Wrong `TIME_LOGIN_SECRET` on the generator side, clock drift beyond the tolerance window, or wrong Supabase password |
| Files list is empty for a real user | No `file_access` row grants them that file, or the file is inactive |
| "Could not establish a session" | Edge Function returned tokens but `setSession` failed — check the anon key matches the project |
| Admin tab doesn't appear | The user's `profiles.role` isn't exactly `admin` |
| CORS error calling the function | Confirm the function is deployed and the URL/anon key in `CONFIG` are correct |

## 20. Security headers (deployment-specific)

If your static host allows custom headers, add:

```
Content-Security-Policy: default-src 'self'; connect-src 'self' https://*.supabase.co; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=()
Strict-Transport-Security: max-age=63072000; includeSubDomains
```

Adjust `connect-src`/`script-src` if you self-host the Supabase JS client
instead of using the jsDelivr CDN build.

---

This system is designed according to realistic web-security principles —
it is not, and no system is, "unbreakable."
