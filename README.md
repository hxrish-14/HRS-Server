# HRS Server

A private, login-protected link-management portal. Files stay on Google
Drive, MediaFire, WeTransfer, or Telegram — this app stores metadata and
enforces exactly who is allowed to see which link.

This is a full rebuild of a previous broken version. §1 explains what was
actually wrong and how it was fixed, before the setup steps.

---

## 1. What was broken, and what was fixed

**Root cause of the frozen "Are you sure?" dialog and the broken login:**
every modal (`.modal-backdrop`) was styled with `display: flex` in CSS.
Browsers hide an element carrying the `hidden` attribute using a built-in
rule, `[hidden] { display: none }` — but that rule lives in the browser's
own default stylesheet, and **any of your own CSS rules that also set
`display` on that element override it**, even when both rules have the
same specificity, because author styles are applied after the browser's
defaults. The old stylesheet never accounted for this, so every modal —
including the confirm dialog — was actually still `display: flex` even
while `hidden` was set. A full-screen, click-blocking, dimmed overlay sat
on top of the entire page (including the login form) from the moment the
page loaded, which explains all of: login "not working," the app getting
stuck on confirm/cancel, dialogs "locking" the interface, and general
unresponsiveness. The fix is one line:

```css
[hidden] { display: none !important; }
```

This is now the first rule in `styles.css`. On top of that fix, this
rebuild adds a small `ModalManager` in `app.js` that:

- always restores button state, page scroll, and pointer events when a
  modal closes, on success, error, *or* timeout;
- lets Escape and a backdrop click close a modal even mid-request; and
- wraps every modal-triggered network call in a 15-second timeout so a
  hung request can never leave a spinner running forever.

**Other reliability fixes in this rebuild:**
- The app now has an explicit **"Checking session…"** screen shown before
  either the login or the dashboard is decided, so protected content is
  never flashed before authentication is verified.
- Login, password reset, and every admin action have real loading /
  success / error / timeout states — nothing spins indefinitely.
- Role-based access again runs entirely through PostgreSQL RLS (see §11),
  not frontend `if (role === "admin")` checks, which were the "security
  loophole" concern.

---

## 2. Features

- Supabase Auth only — no custom password table, ever
- Four roles: `admin`, `harish`, `guest`, `localadmin`, each with per-file
  and per-category access grants enforced by RLS
- Server-enforced login lockout: 5 failed attempts → 10 minute cool-down
- 10-minute inactivity auto-logout with a warning beforehand
- Google-Drive-style dashboard: 12 recent files, then debounced/paginated
  search for the rest — never a full-table download
- Admin: file CRUD, user management, bulk category permissions, per-file
  permission editing, activity log, security events — no SQL textbox
- Gated header **"+ Add file"** button (message instead of a silent no-op
  for guests/signed-out visitors)
- Dark/light theme, Bricolage Grotesque type system, responsive from
  320px up to large desktop/projector displays
- `Ctrl+Alt+H` shortcut (documented OS-shortcut limitation — see §16)

## 3. Project tree

```
hrs-server/
├── index.html
├── styles.css
├── app.js
├── config.js               (real values — safe to expose, see §7)
├── config.example.js       (template for a fresh clone)
├── favicon.svg
├── README.md
├── .gitignore
└── supabase/
    ├── migrations/001_hrserver.sql
    └── functions/
        ├── admin-users/index.ts
        └── health-check/index.ts
```

---

## Step 1 — Install the tools

```bash
# Git (if you don't have it)
# https://git-scm.com/downloads

# Node.js is only needed if you want the Supabase CLI
# https://nodejs.org

# Supabase CLI
npm install -g supabase
```

## Step 2 — Get the project

If you already have the files (as with this delivery), just open the
`hrs-server` folder. Otherwise:

```bash
git clone <your-repo-url>
cd hrs-server
```

## Step 3 — Configure Supabase

```bash
supabase login
supabase init
supabase link --project-ref trgjjtvikddcczkdlzww
```

The publishable/anon key and project URL are already filled in in
`config.js` — see §7 for why that's safe.

## Step 4 — Run the database migration

1. Open the Supabase Dashboard → **SQL Editor**.
2. Open `supabase/migrations/001_hrserver.sql` from this project.
3. Read the top of the file — it's marked **DESTRUCTIVE RESET**. It only
   drops HRS Server's own tables/functions (`profiles`, `files`, etc.); it
   never touches `auth.users` or anything else in your Supabase project.
   If this is a brand-new project, there's nothing to lose. If not, back
   up first.
4. Paste the whole file into the SQL Editor and run it.
5. Confirm there are no errors. You should now see `profiles`, `files`,
   `categories`, `file_access`, `login_attempts`, `activity_log`, and
   `security_events` under **Table Editor**.

## Step 5 — Create authentication users

Go to **Authentication → Users → Add user** and create four users. Set
each password yourself — the bootstrap passwords are *not* written
anywhere in this repository, by design.

**Email-uniqueness note:** the source brief listed the same email for
Admin and Harish. Supabase Auth requires unique emails, so this build
uses Gmail's `+` sub-addressing (still delivers to the same inbox):

| Role       | Auth email                                 | Username     |
|------------|----------------------------------------------|--------------|
| admin      | `harishramesh004@gmail.com`                   | `admin`      |
| harish     | `harishramesh004+harish@gmail.com`            | `harish`     |
| guest      | `harishramesh004+guest@gmail.com` *(placeholder — replace if you have a real guest address)* | `guest` |
| localadmin | `harishramesh004+localadmin@gmail.com`        | `localadmin` |

Set the initial passwords in the dashboard directly, then have each
person change their own password on first login via **Forgot password**.

## Step 6 — Create profiles + seed demo data

Copy each user's UUID from the Users list, then run in the SQL Editor:

```sql
insert into public.profiles (id, username, display_name, email, role, manager_id) values
  ('<admin-uuid>',      'admin',      'Admin',      'harishramesh004@gmail.com',           'admin',      null),
  ('<harish-uuid>',     'harish',     'Harish',     'harishramesh004+harish@gmail.com',     'harish',     '<admin-uuid>'),
  ('<guest-uuid>',      'guest',      'Guest',      'harishramesh004+guest@gmail.com',      'guest',      '<admin-uuid>'),
  ('<localadmin-uuid>', 'localadmin', 'Localadmin', 'harishramesh004+localadmin@gmail.com', 'localadmin', '<admin-uuid>');
```

Then add a small demo dataset so the dashboard isn't empty on first login
(replace `<admin-uuid>`, `<harish-uuid>`, `<guest-uuid>` again):

```sql
-- a few files across the seeded categories
insert into public.files (file_name, file_link, file_type, file_size, file_category_id, source_platform, description, created_by)
select 'Welcome Guide.pdf', 'https://drive.google.com/file/d/example/view', 'pdf', '1.2 MB', id, 'google_drive', 'Getting started guide.', '<admin-uuid>'
from public.categories where name = 'Documents';

insert into public.files (file_name, file_link, file_type, file_size, file_category_id, source_platform, description, created_by)
select 'Semester Notes.zip', 'https://mediafire.com/file/example', 'zip', '48 MB', id, 'mediafire', 'Compiled notes.', '<admin-uuid>'
from public.categories where name = 'Academic';

-- grant Harish and Guest access to the files that now exist
insert into public.file_access (file_id, user_id, granted_by)
select id, '<harish-uuid>', '<admin-uuid>' from public.files;

insert into public.file_access (file_id, user_id, granted_by)
select id, '<guest-uuid>', '<admin-uuid>' from public.files where file_name = 'Welcome Guide.pdf';
```

Admin automatically sees all files via RLS — no `file_access` rows needed
for the admin account.

## Step 7 — Configure the frontend

`config.js` already has this project's real Supabase URL and
publishable/anon key filled in — nothing to edit for this deployment.
That key is *designed* to be public: it identifies the project, not a
privileged credential, and every read/write it can make is still filtered
by the RLS policies in the migration. If you fork this for a different
Supabase project, copy `config.example.js` to `config.js` and fill in
your own values.

**Never** put the service role key, the database password, or the
`postgresql://...` connection string in `config.js`, `app.js`, or any
committed file.

## Step 8 — Run locally

```bash
npx serve .
# or
python3 -m http.server 8080
```

Open the printed URL. Deploy the Edge Functions once, from your machine
(these need the Supabase CLI, not the browser):

```bash
supabase functions deploy admin-users
supabase functions deploy health-check
```

## Step 9 — Test login

Log in as each of the four accounts and confirm:

- **Admin** sees Files, Categories, Users, Permissions, Activity, Security
  and every file.
- **Harish** and **Guest** see only Home/Files/Categories and only the
  files granted to them in Step 6.
- **Localadmin** sees Home/Files/Categories but zero files (no grants were
  ever created for it — this is by design, not a bug).

## Step 10 — Deploy to GitHub

```bash
git init
git add .
git commit -m "HRS Server"
git push
```

Any static host works (GitHub Pages, Netlify, Vercel, Cloudflare Pages) —
no build step is required.

**GitHub Pages note:** this is a single-page app with no server-side
routing — everything happens on one `index.html` with in-page view
switching (no `/dashboard`, `/files`, etc. as real URLs), so it works on
GitHub Pages out of the box with no hash-routing workaround needed. If you
later add real sub-paths, GitHub Pages will 404 on a hard refresh unless
you add a `404.html` that redirects back to `index.html`, or switch to
hash-based routes.

---

## 11. Security model (plain language)

- **Authentication** is 100% Supabase Auth — this app never sees or
  stores a plaintext password.
- **RLS (Row Level Security)** is Postgres's own permission system: every
  query, even one sent by hand-editing the browser's network request, is
  filtered by policies in `001_hrserver.sql`. Editing JavaScript or
  DevTools cannot change what the database will hand back.
- **Role authorization**: only admin can write `files`, `categories`,
  `file_access`, or any `profiles` row (including their own — nobody can
  self-promote). The frontend hiding a button is convenience, not
  security; the real check happens in Postgres.
- **SQL injection protection**: the app only ever uses the Supabase query
  builder or fixed, parameterized functions — no user input is ever
  concatenated into SQL.
- **XSS protection**: every dynamic value goes through `escapeHtml()`
  before it's placed on the page — never raw `innerHTML` of database
  content.
- **Session timeout**: enforced client-side (10 minutes) as a convenience;
  the real backstop is that Supabase sessions themselves expire.
- **Rate limiting / lockout**: the 5-attempts / 10-minute lockout is
  enforced by a Postgres function (`is_locked_out`), reachable only
  through that function — the underlying `login_attempts` table grants no
  direct access to anyone, so a client can't just skip the check.
- **Security events**: failed logins, lockouts, and unauthorized function
  calls are written to `security_events`, readable only by admin.

**No false claims:** this system does not claim to be unhackable, and
DevTools cannot be disabled by a website — a user always controls their
own browser. What's guaranteed instead is that changing a role variable,
skipping a frontend check, or calling the Supabase REST API directly
still hits the same RLS policies as the real UI.

## 12. Admin usage

**Files** — Files screen (or the header "+ Add file", admin only) → Add,
fill fields, tick accessible users → Save. Edit/Delete the same way.
**Users** — Users screen → Add user (creates the Auth user + profile via
the `admin-users` function) or Edit an existing one. **Reset password**
sends Supabase's own recovery email.
**Permissions** — bulk grant/revoke a whole category to a user from the
Permissions screen, or edit individual files there too.
**Activity / Security** — read-only logs, admin only.

## 13. Adding files (step by step)

```
Login as Admin
→ Files (or header "+ Add file")
→ Enter file name
→ Paste an https:// link
→ Choose source platform
→ Choose category
→ (optional) file type / size / description
→ Tick which users can see it
→ Save
```

## 14. Adding users (step by step)

```
Admin → Users → Add user
→ Username, display name, email, role, manager
→ Save (creates the Supabase Auth account + profile automatically,
   and emails a password-setup link — no password is ever typed here)
```

## 15. Permissions (step by step)

```
Admin → Permissions
→ pick a category and a user → Grant or Revoke
   (applies to every file currently in that category)

or, per file:
Admin → Permissions → "Manage access" on a specific file
→ tick/untick users → Save
```

## 16. Keyboard shortcut

`Ctrl+Alt+H` opens `https://hxrish-14.github.io/Harish-Portfolio/` in a
new tab. `Win+Alt+H` was requested, but browsers cannot reliably intercept
OS-reserved key combinations — `Ctrl+Alt+H` is the practical, guaranteed
fallback actually wired up.

## 17. Current-time verification code

This is **not** a login mechanism. It's an optional, admin-only, purely
client-side helper for out-of-band identity confirmation (for example,
reading a short code to someone over a phone call before making a manual
account change) — found on the **Security** screen.

- **Format:** `<username>@<HH><MM>`, 12-hour clock, zero-padded, using the
  admin's own browser clock/timezone. Midnight and noon both display `12`
  (by design — this is a coarse, human-readable check, not a
  cryptographic one).
- **Validity:** informal — treat it as stale after a few minutes. There is
  no server-side expiry because there is no server-side check at all.
- It is **never** sent over the network, stored, logged, or accepted
  anywhere as a password. It cannot bypass Supabase Auth, and Supabase
  Auth is completely unaware it exists.
- **To disable it:** delete the "Identity verification code" panel block
  from the Security screen in `index.html`, and the two related functions
  (`computeVerificationCode`, `handleGenerateCode`) in `app.js`. Nothing
  else in the app depends on it.

## 18. Universal add procedures

**One or many users:** Users → Add user, repeated. No SQL after Step 6.
**One or many files:** Files → Add file, repeated; or, if you prefer SQL:

```sql
select admin_create_file(
  'Name.pdf', 'https://drive.google.com/...', 'pdf', '2 MB',
  '<category-uuid>', 'Description', 'google_drive'
);
```

**Bulk category access for many users:** repeat the Permissions screen's
Grant action per user, or:

```sql
select admin_grant_category_access('<category-uuid>', '<user-uuid>');
select admin_revoke_category_access('<category-uuid>', '<user-uuid>');
```

## 19. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| A dialog won't close / page feels frozen | Should not happen anymore — see §1. If it recurs, check that `[hidden] { display: none !important; }` is still the first rule in `styles.css` and wasn't removed by an edit. |
| "Too many failed attempts" right away | A previous test tripped the 10-minute lockout for that email; wait, or clear rows from `login_attempts` in dev. |
| Admin tabs missing | The signed-in profile's `role` isn't exactly `admin`. |
| New user creation fails | `admin-users` function isn't deployed, or the caller isn't `admin`. |
| Files list empty for a real user | No `file_access` row grants them that file, or the file is `is_active = false`. |
| Stuck on "Checking session…" | Supabase URL/key in `config.js` are wrong, or the network request timed out — check the browser console. |

## 20. Security warnings / limitations

- This protects the **link**, not the file — an authorized user could
  still share the URL outside the app.
- Profile photos live in a **public** storage bucket; anyone with the URL
  can view a photo (URLs aren't guessable, but the bucket isn't private).
- The `pagehide` sign-out is best-effort only — real protection is session
  expiry + inactivity timeout + RLS, not the browser closing cleanly.
- Recommended response headers for your static host (adjust
  `connect-src`/`script-src` if you vendor the Supabase client instead of
  the jsDelivr CDN build):

```
Content-Security-Policy: default-src 'self'; connect-src 'self' https://*.supabase.co; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=()
```

## 21. Keep-alive

Point an external scheduler (cron, GitHub Actions on a schedule, or a free
monitor like UptimeRobot) at the deployed `health-check` function every
few days — never a browser login loop:

```
GET https://trgjjtvikddcczkdlzww.supabase.co/functions/v1/health-check
```

---

This system is designed according to realistic web-security principles.
It is not, and no system is, "unhackable," and DevTools cannot be
disabled — only made irrelevant to real authorization decisions, which is
what the RLS policies in `001_hrserver.sql` actually do.
