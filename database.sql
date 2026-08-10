-- ============================================================================
-- Secure Personal File Vault — Database Schema
-- Run this once in the Supabase SQL editor (or via `supabase db push`).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles  (mirrors auth.users, adds app-level role)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique,
  display_name text not null,
  role         text not null check (role in ('admin', 'harish', 'guest')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. categories
-- ---------------------------------------------------------------------------
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. files
-- ---------------------------------------------------------------------------
create table if not exists public.files (
  id           uuid primary key default gen_random_uuid(),
  file_name    text not null,
  category_id  uuid references public.categories(id) on delete set null,
  description  text,
  external_url text not null,
  source       text not null check (source in ('mediafire', 'telegram', 'other')),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint files_url_scheme_check check (
    external_url ~* '^https://'
  )
);

-- ---------------------------------------------------------------------------
-- 4. file_access  (many-to-many: which users may see which files)
-- ---------------------------------------------------------------------------
create table if not exists public.file_access (
  file_id    uuid not null references public.files(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (file_id, user_id)
);

-- ---------------------------------------------------------------------------
-- 5. download_logs
-- ---------------------------------------------------------------------------
create table if not exists public.download_logs (
  id            uuid primary key default gen_random_uuid(),
  file_id       uuid references public.files(id) on delete set null,
  user_id       uuid references public.profiles(id) on delete set null,
  downloaded_at timestamptz not null default now(),
  source        text
);

-- ---------------------------------------------------------------------------
-- 6. audit_logs
-- ---------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles(id) on delete set null,
  action      text not null,
  target_type text not null,
  target_id   uuid,
  created_at  timestamptz not null default now(),
  metadata    jsonb
);

-- ---------------------------------------------------------------------------
-- 7. Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_files_file_name    on public.files using gin (to_tsvector('simple', file_name));
create index if not exists idx_files_category_id   on public.files (category_id);
create index if not exists idx_files_is_active     on public.files (is_active);
create index if not exists idx_file_access_file_id on public.file_access (file_id);
create index if not exists idx_file_access_user_id on public.file_access (user_id);
create index if not exists idx_dl_logs_file_id     on public.download_logs (file_id);
create index if not exists idx_dl_logs_user_id     on public.download_logs (user_id);
create index if not exists idx_audit_user_id       on public.audit_logs (user_id);
create index if not exists idx_audit_created_at    on public.audit_logs (created_at);

-- ---------------------------------------------------------------------------
-- 8. updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated on public.profiles;
create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists trg_categories_updated on public.categories;
create trigger trg_categories_updated before update on public.categories
  for each row execute function public.set_updated_at();

drop trigger if exists trg_files_updated on public.files;
create trigger trg_files_updated before update on public.files
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 9. Helper: current user's role (security definer to avoid RLS recursion)
-- ---------------------------------------------------------------------------
create or replace function public.current_role_name()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select role from public.profiles where id = auth.uid()) = 'admin', false);
$$;

-- ---------------------------------------------------------------------------
-- 10. Enable RLS
-- ---------------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.categories    enable row level security;
alter table public.files         enable row level security;
alter table public.file_access   enable row level security;
alter table public.download_logs enable row level security;
alter table public.audit_logs    enable row level security;

-- ---------------------------------------------------------------------------
-- 11. Policies — profiles
-- ---------------------------------------------------------------------------
create policy "profiles_select_own_or_admin"
  on public.profiles for select
  using (id = auth.uid() or public.is_admin());

create policy "profiles_update_admin_only"
  on public.profiles for update
  using (public.is_admin());

-- No public insert/delete policy: profiles are provisioned manually after
-- creating the Supabase Auth user (see README section "Auth user creation").

-- ---------------------------------------------------------------------------
-- 12. Policies — categories
-- ---------------------------------------------------------------------------
create policy "categories_select_authenticated"
  on public.categories for select
  using (auth.uid() is not null);

create policy "categories_write_admin_only"
  on public.categories for insert
  with check (public.is_admin());

create policy "categories_update_admin_only"
  on public.categories for update
  using (public.is_admin());

create policy "categories_delete_admin_only"
  on public.categories for delete
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 13. Policies — files
-- Admin sees everything. Other roles only see active files explicitly
-- granted to them via file_access.
-- ---------------------------------------------------------------------------
create policy "files_select_admin_all"
  on public.files for select
  using (public.is_admin());

create policy "files_select_granted_active"
  on public.files for select
  using (
    is_active = true
    and exists (
      select 1 from public.file_access fa
      where fa.file_id = files.id and fa.user_id = auth.uid()
    )
  );

create policy "files_insert_admin_only"
  on public.files for insert
  with check (public.is_admin());

create policy "files_update_admin_only"
  on public.files for update
  using (public.is_admin());

create policy "files_delete_admin_only"
  on public.files for delete
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 14. Policies — file_access
-- Users may see their own grant rows (so the UI can know what it has);
-- only admin may write.
-- ---------------------------------------------------------------------------
create policy "file_access_select_own_or_admin"
  on public.file_access for select
  using (user_id = auth.uid() or public.is_admin());

create policy "file_access_write_admin_only"
  on public.file_access for insert
  with check (public.is_admin());

create policy "file_access_delete_admin_only"
  on public.file_access for delete
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 15. Policies — download_logs
-- Any authenticated user may insert a log row for themselves, for a file
-- they are actually permitted to see. Only admin can read logs.
-- ---------------------------------------------------------------------------
create policy "download_logs_select_admin_only"
  on public.download_logs for select
  using (public.is_admin());

create policy "download_logs_insert_self"
  on public.download_logs for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.files f
      where f.id = file_id
        and f.is_active = true
        and (
          public.is_admin()
          or exists (
            select 1 from public.file_access fa
            where fa.file_id = f.id and fa.user_id = auth.uid()
          )
        )
    )
  );

-- ---------------------------------------------------------------------------
-- 16. Policies — audit_logs
-- Written only by admin actions (from the client, acting as admin), read
-- only by admin. Sensitive actions from the Edge Function use the service
-- role and bypass RLS entirely.
-- ---------------------------------------------------------------------------
create policy "audit_logs_select_admin_only"
  on public.audit_logs for select
  using (public.is_admin());

create policy "audit_logs_insert_admin_only"
  on public.audit_logs for insert
  with check (public.is_admin() and (user_id = auth.uid() or user_id is null));

-- ---------------------------------------------------------------------------
-- 17. Seed data — categories only. No credentials, ever.
-- ---------------------------------------------------------------------------
insert into public.categories (name, description) values
  ('Programming', 'Programming courses, tutorials, and code archives'),
  ('Courses',     'Structured multi-part learning material'),
  ('Software',    'Installers, tools, and utilities'),
  ('Books',       'E-books and reading material'),
  ('Documents',   'PDFs, notes, and reference documents'),
  ('Other',       'Anything that does not fit another category')
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- 18. Post-setup: after creating the three Supabase Auth users, insert
-- their profiles manually, e.g.:
--
--   insert into public.profiles (id, username, display_name, role) values
--     ('<admin-auth-uuid>',  'admin',  'Admin',  'admin'),
--     ('<harish-auth-uuid>', 'harish', 'Harish', 'harish'),
--     ('<guest-auth-uuid>',  'guest',  'Guest',  'guest');
--
-- See README.md → "Auth user creation" for the full walkthrough.
-- ---------------------------------------------------------------------------
