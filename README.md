# HRS Server

A private, login-protected link-management portal. Files stay on Google
Drive, MediaFire, WeTransfer, or Telegram — this app stores metadata and
enforces exactly who is allowed to see which link.

## 1. Overview

Rebuilt from an earlier version with a security-first architecture: the
browser is treated as fully untrusted. Every authorization decision is
enforced by PostgreSQL Row Level Security and two narrowly-scoped Edge
Functions — never by frontend JavaScript.

## 2. Features

- Supabase Auth (no custom password handling, ever)
- Four roles: `admin`, `harish`, `guest`, `localadmin`, each with per-file
  and per-category access grants
- Server-enforced login lockout (5 failed attempts → 10 minute cool-down)
- 10-minute inactivity auto-logout with a warning beforehand
- Admin dashboard: file CRUD, user management, bulk category permissions,
  per-file permission editing, activity log, security events — no SQL
  textbox anywhere
- Debounced, database-backed, paginated search
- Profile cards with online/last-seen status
- Dark/light theme, Bricolage Grotesque type system, responsive from 320px
  to large desktop displays
- `Ctrl+Alt+H` shortcut (documented deviation — see §9)

## 3. Architecture

```
Browser (HTML/CSS/vanilla JS, anon key only)
   ├── Supabase Auth ──────────── login, logout, password reset
   ├── Postgres + RLS ─────────── all read/write authorization
   ├── Edge Function "admin-users" ── privileged Auth admin ops
   │      (create user, reset password, disable/enable)
   └── Edge Function "health-check" ── external keep-alive only
```

## 4. Folder structure

```
hrs-server/
├── index.html
├── styles.css
├── app.js
├── favicon.svg
├── README.md
├── .gitignore
├── .env.example
└── supabase/
    ├── migrations/database.sql
    └── functions/
        ├── admin-users/index.ts
        └── health-check/index.ts
```

## 5. Supabase setup

Project is already provisioned:

- Project URL: `https://trgjjtvikddcczkdlzww.supabase.co`
- Publishable/anon key: already placed in `app.js` `CONFIG` — this key is
  designed to be public and is meaningless without RLS behind it.
- **Never** put the service role key, the database password, or the
  `postgresql://...` connection string in any file in this repository.
  The connection string is for local `psql`/CLI admin use only.

```bash
supabase login
supabase init
supabase link --project-ref trgjjtvikddcczkdlzww
```

## 6. Database setup

Run `supabase/migrations/database.sql` in the Supabase SQL editor (or
`supabase db push`). It is idempotent — safe to re-run — and contains
**no credentials**. It creates all tables, indexes, RLS policies, helper
functions, the `avatars` storage bucket, and seeds categories only.

## 7. Authentication setup

Create Auth users through Supabase (dashboard, or `supabase.auth.admin.
createUser` from a trusted machine) — never through a custom table.

**Email-uniqueness note (deviation from the original request):** Supabase
Auth requires unique emails, and the source material listed the same
address for both Admin and Harish. Rather than break Auth uniqueness, this
build uses Gmail's `+` sub-addressing, which still delivers to the same
inbox:

| Role       | Auth email                                  |
|------------|----------------------------------------------|
| admin      | `harishramesh004@gmail.com`                   |
| harish     | `harishramesh004+harish@gmail.com`            |
| guest      | `harishramesh004+guest@gmail.com` *(placeholder — replace with a real guest address if one exists)* |
| localadmin | `harishramesh004+localadmin@gmail.com`        |

Set each user's initial password directly in the Supabase dashboard (or
via the Auth Admin API) — **not** in any file here. The three bootstrap
passwords you supplied separately should be set this way once, then
rotated by each person through **Forgot password** or **Change password**
in the app; they must never be committed to source control.

## 8. Initial user creation (bootstrap)

After creating the four Auth users, insert their profile rows (replace
the UUIDs with the ones Supabase generated):

```sql
insert into public.profiles (id, username, display_name, email, role, manager_id) values
  ('<admin-uuid>',      'admin',      'Admin',      'harishramesh004@gmail.com',            'admin',      null),
  ('<harish-uuid>',     'harish',     'Harish',     'harishramesh004+harish@gmail.com',      'harish',     '<admin-uuid>'),
  ('<guest-uuid>',      'guest',      'Guest',      'harishramesh004+guest@gmail.com',       'guest',      '<admin-uuid>'),
  ('<localadmin-uuid>', 'localadmin', 'Localadmin', 'harishramesh004+localadmin@gmail.com',  'localadmin', '<admin-uuid>');
```

From then on, use the in-app **Users** screen (admin only) — it calls the
`admin-users` Edge Function, so no further manual SQL is needed to add,
edit, disable, or reset passwords for users.

## 9. Dynamic-password note

The source brief mentioned a `Admin@0811`-style time-suffixed password.
As instructed, this build does **not** use that as real authentication —
a predictable, time-derived suffix is guessable and would weaken, not
strengthen, login security. Real authentication is Supabase Auth's
password + the server-enforced lockout in §11. If you still want an
extra time-based factor later, treat it as a genuinely separate project
(see the companion "Secure Personal File Vault" build for a properly
server-verified version of that idea) rather than bolting a predictable
suffix onto the real password.

## 10. Environment configuration

`app.js` → `CONFIG` holds the only two frontend secrets allowed: the
Supabase URL and the publishable anon key. `.env.example` documents the
same values for any future build tooling — it contains no real secrets.

## 11. RLS explanation

- `is_admin()` / `current_role_name()` are `security definer` functions so
  policies can check the caller's role without recursive RLS lookups.
- `admin` reads all files (active and inactive) directly through a policy
  — no redundant per-file grant rows needed for admin.
- `harish`, `guest`, `localadmin` can only `select` `files` rows that are
  `is_active = true` **and** have a matching `file_access` row for their
  own `auth.uid()`. `localadmin` is simply never granted any, so it
  structurally sees zero files.
- Only `admin` can write `files`, `categories`, `file_access`, or update
  any `profiles` row (including their own role — nobody can self-promote).
- `login_attempts` has RLS enabled with **no policies**, so it is reachable
  only through the `is_locked_out()` / `record_login_attempt()` security
  definer functions — this is what makes the lockout real rather than
  cosmetic.
- `activity_log` is written only through `log_activity()` (security
  definer); readable by the row's own user or admin.

## 12. Admin usage

**Files** — Add/Edit/Delete, toggle active, change category/source/link,
manage per-file access — all from dialogs, no SQL.
**Users** — Add/Edit, change role, disable/enable, send password reset —
via the Users screen, backed by `admin-users`.
**Permissions** — bulk grant/revoke a whole category to a user, or edit
individual files from the Permissions screen.
**Activity / Security** — read-only views over `activity_log`, filtered by
severity.

## 13. File management

See §12. Changing a link or permission takes effect immediately — no
redeploy, no code change.

## 14. Permission management

Per-file: open the file in the modal → tick/untick users → Save (replaces
the file's access list). Bulk: Permissions screen → pick a category and a
user → Grant or Revoke.

## 15. Category management

Categories screen → admin can add new categories. (Rename/disable can be
added the same way as file editing if you need it later — the schema
already supports `is_active` on categories.)

## 16. Password reset

Uses Supabase's own recovery flow (`resetPasswordForEmail`) everywhere —
on the login screen, from a user's own "Change password" menu item, and
from the admin Users dialog. No custom password table, ever.

## 17. Security model

The frontend never decides authorization — it only decides what to show.
If someone edits JavaScript, opens DevTools, or calls the Supabase REST
API directly, every read and write still passes through the RLS policies
in `database.sql`. Login lockout is enforced by a database function, not
a client-side counter. The two Edge Functions hold the only code that
touches the service role key, and both re-verify the caller's role from
the database before doing anything privileged.

**No fake security:** DevTools cannot be blocked, and this system does not
claim otherwise. Changing a `role` variable in a live session changes
nothing server-side — the database still checks the real row in
`profiles`.

## 18. Keep-alive considerations

Do **not** create a browser login loop or use `localadmin` as a fake
session just to keep the project active. Instead, point an external
scheduler (a cron job, GitHub Actions on a schedule, or a free uptime
monitor like UptimeRobot/cron-job.org) at the deployed `health-check`
Edge Function every few days:

```
GET https://trgjjtvikddcczkdlzww.supabase.co/functions/v1/health-check
```

## 19. Local development

```bash
npx serve .
# or
python3 -m http.server 8080
```

## 20. GitHub deployment

This repo is upload-ready as-is. `.gitignore` excludes any local `.env`
files. Before pushing, a quick manual secret scan is still good practice:
search the repo for `service_role`, `postgresql://`, and `password=` — none
should appear (they don't, in this build).

For hosting, GitHub Pages or any static host works for `index.html`,
`styles.css`, `app.js`, and `favicon.svg`. Deploy the Edge Functions
separately:

```bash
supabase functions deploy admin-users
supabase functions deploy health-check
```

## 21. Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Too many failed attempts" immediately | Someone else (or a previous test) tripped the 10-minute lockout for that email — wait or clear `login_attempts` in dev |
| Admin/Users/Permissions tabs missing | The signed-in profile's `role` isn't exactly `admin` |
| New user creation fails silently | `admin-users` function not deployed, or the caller's profile isn't `admin` |
| Files list empty for a real user | No `file_access` row grants them that file, or the file is inactive |
| CORS or 401 calling `admin-users` | Confirm the function is deployed and the browser is sending the current session's access token |

## 22. Security warnings / limitations

- This protects the **link**, not the file. An authorized user could still
  share the external URL outside the app — that's outside this system.
- Profile photos live in a **public** storage bucket (§20 below) —
  anyone with the URL can view a photo, though URLs are not guessable.
  Make the bucket private later if that matters for your use case.
- The `pagehide` sign-out is best-effort only; do not treat it as a
  guarantee. Real protection is session expiry + inactivity timeout + RLS.
- Suggested response headers (adjust `connect-src`/`script-src` if you
  vendor the Supabase client instead of using the jsDelivr CDN build):

```
Content-Security-Policy: default-src 'self'; connect-src 'self' https://*.supabase.co; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=()
```

## 23. Universal user/file creation procedure

**Users:** Users screen → Add user → fill fields → Save. No SQL. (First
four bootstrap users only need the one-time SQL in §8.)

**Files:** Files screen → Add file → fill fields, tick accessible users →
Save. Equivalent RPC form, if you ever need it outside the UI:

```sql
select admin_create_file(
  'Semester 4 Notes.pdf', 'https://drive.google.com/...', 'pdf', '2 MB',
  '<category-uuid>', 'Compiled notes', 'google_drive'
);
```

**Bulk category access:**

```sql
select admin_grant_category_access('<category-uuid>', '<user-uuid>');
select admin_revoke_category_access('<category-uuid>', '<user-uuid>');
```

---

## 24. Security test checklist

```
[ ] Guest cannot access Harish-only files
[ ] Harish cannot access Guest-only files
[ ] Guest cannot access admin functions
[ ] Harish cannot access admin functions
[ ] Localadmin has zero file access
[ ] Modified frontend cannot bypass RLS (test via browser console REST calls)
[ ] Changing a role variable in DevTools does not grant privilege
[ ] Service-role key is not exposed anywhere in frontend code
[ ] Database password is not in the repository
[ ] Passwords are not stored in database.sql or app.js
[ ] 5 failed logins trigger a 10-minute lockout (server-enforced)
[ ] Lockout persists even if login_attempts is queried directly by anon (it can't be)
[ ] 10-minute inactivity logs the user out, with a prior warning
[ ] XSS payload in a file name/description renders as literal text
[ ] javascript:/data:/file: URLs are rejected when adding a file
[ ] SQL-injection-style input in search does not alter query behavior
[ ] Logout works; session does not silently persist
[ ] Session restoration works after a page reload while still logged in
[ ] Broken/unreachable external links show a normal, non-blank state
[ ] Network loss shows the offline banner and doesn't corrupt state
```

This system is designed according to realistic web-security principles.
It is not, and no system is, "unhackable."
