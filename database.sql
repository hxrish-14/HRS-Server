-- ============================================================================
-- HRS Server — Database Migration
-- Idempotent: safe to re-run. Contains NO credentials of any kind.
-- Run in the Supabase SQL editor or via `supabase db push`.
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
-- 1. profiles
-- ============================================================================
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  username          text not null unique,
  display_name      text not null,
  email             text not null,
  role              text not null check (role in ('admin', 'harish', 'guest', 'localadmin')),
  manager_id        uuid references public.profiles(id) on delete set null,
  profile_photo_url text,
  is_active         boolean not null default true,
  last_login_at     timestamptz,
  last_seen_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ============================================================================
-- 2. categories
-- ============================================================================
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ============================================================================
-- 3. files
-- ============================================================================
create table if not exists public.files (
  id              uuid primary key default gen_random_uuid(),
  file_name       text not null,
  file_link       text not null,
  file_type       text,
  file_size       text,
  category_id     uuid references public.categories(id) on delete set null,
  description     text,
  source_platform text not null check (source_platform in
                    ('google_drive', 'mediafire', 'wetransfer', 'telegram', 'other')),
  is_active       boolean not null default true,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint files_link_https_check check (file_link ~* '^https://')
);

-- ============================================================================
-- 4. file_access  (normalized many-to-many; never a comma-separated string)
-- ============================================================================
create table if not exists public.file_access (
  id         uuid primary key default gen_random_uuid(),
  file_id    uuid not null references public.files(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  granted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (file_id, user_id)
);

-- ============================================================================
-- 5. login_attempts  (drives server-side lockout — never client-only)
-- ============================================================================
create table if not exists public.login_attempts (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  success      boolean not null,
  ip_address   text,
  user_agent   text,
  attempted_at timestamptz not null default now()
);

-- ============================================================================
-- 6. activity_log  (activity + security events share one auditable table)
-- ============================================================================
create table if not exists public.activity_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles(id) on delete set null,
  event_type  text not null,
  severity    text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  ip_address  text,
  user_agent  text,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

-- ============================================================================
-- 7. Indexes
-- ============================================================================
create index if not exists idx_profiles_role          on public.profiles (role);
create index if not exists idx_profiles_username       on public.profiles (username);
create index if not exists idx_profiles_last_seen      on public.profiles (last_seen_at);
create index if not exists idx_files_name_trgm         on public.files using gin (to_tsvector('simple', file_name));
create index if not exists idx_files_category          on public.files (category_id);
create index if not exists idx_files_source            on public.files (source_platform);
create index if not exists idx_files_created_at        on public.files (created_at desc);
create index if not exists idx_file_access_user_id     on public.file_access (user_id);
create index if not exists idx_file_access_file_id     on public.file_access (file_id);
create index if not exists idx_login_attempts_email    on public.login_attempts (email, attempted_at desc);
create index if not exists idx_activity_user_id        on public.activity_log (user_id);
create index if not exists idx_activity_created_at     on public.activity_log (created_at desc);
create index if not exists idx_activity_event_type     on public.activity_log (event_type);

-- ============================================================================
-- 8. updated_at trigger helper
-- ============================================================================
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

-- ============================================================================
-- 9. Role helpers (security definer → no RLS recursion)
-- ============================================================================
create or replace function public.current_role_name()
returns text language sql security definer set search_path = public stable as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql security definer set search_path = public stable as $$
  select coalesce((select role from public.profiles where id = auth.uid()) = 'admin', false);
$$;

-- ============================================================================
-- 10. Login lockout functions
--     Frontend calls is_locked_out() before attempting Supabase Auth login,
--     then record_login_attempt() after, regardless of outcome. This is the
--     real enforcement layer — the frontend lockout UI is a courtesy only.
-- ============================================================================
create or replace function public.is_locked_out(p_email text)
returns boolean language sql security definer set search_path = public stable as $$
  select count(*) >= 5
  from public.login_attempts
  where email = lower(p_email)
    and success = false
    and attempted_at > now() - interval '10 minutes';
$$;

create or replace function public.record_login_attempt(
  p_email text, p_success boolean, p_ip text default null, p_user_agent text default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.login_attempts (email, success, ip_address, user_agent)
  values (lower(p_email), p_success, p_ip, p_user_agent);

  insert into public.activity_log (event_type, severity, ip_address, user_agent, metadata)
  values (
    case when p_success then 'login_success' else 'login_failed' end,
    case when p_success then 'info' else 'warning' end,
    p_ip, p_user_agent, jsonb_build_object('email', lower(p_email))
  );

  if not p_success and public.is_locked_out(p_email) then
    insert into public.activity_log (event_type, severity, ip_address, user_agent, metadata)
    values ('lockout_triggered', 'critical', p_ip, p_user_agent, jsonb_build_object('email', lower(p_email)));
  end if;
end;
$$;

-- Anon (pre-auth) callers must be able to run these two, and nothing else.
revoke all on public.login_attempts from anon, authenticated;
grant execute on function public.is_locked_out(text) to anon, authenticated;
grant execute on function public.record_login_attempt(text, boolean, text, text) to anon, authenticated;

-- ============================================================================
-- 11. Generic activity logger for authenticated actions
-- ============================================================================
create or replace function public.log_activity(
  p_event_type text, p_severity text default 'info', p_metadata jsonb default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.activity_log (user_id, event_type, severity, metadata)
  values (auth.uid(), p_event_type, p_severity, p_metadata);
end;
$$;
grant execute on function public.log_activity(text, text, jsonb) to authenticated;

-- ============================================================================
-- 12. Heartbeat (updates last_seen_at without granting broader update rights)
-- ============================================================================
create or replace function public.touch_last_seen()
returns void language sql security definer set search_path = public as $$
  update public.profiles set last_seen_at = now() where id = auth.uid();
$$;
grant execute on function public.touch_last_seen() to authenticated;

-- ============================================================================
-- 13. Admin convenience functions (no SQL textbox needed in the UI)
-- ============================================================================
create or replace function public.admin_create_file(
  p_file_name text, p_file_link text, p_file_type text, p_file_size text,
  p_category_id uuid, p_description text, p_source_platform text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'Not authorized'; end if;
  if p_file_link !~* '^https://' then raise exception 'Only https:// links are allowed'; end if;

  insert into public.files (file_name, file_link, file_type, file_size, category_id,
                             description, source_platform, created_by)
  values (p_file_name, p_file_link, p_file_type, p_file_size, p_category_id,
          p_description, p_source_platform, auth.uid())
  returning id into v_id;

  perform public.log_activity('file_created', 'info', jsonb_build_object('file_id', v_id));
  return v_id;
end;
$$;
grant execute on function public.admin_create_file(text, text, text, text, uuid, text, text) to authenticated;

create or replace function public.admin_grant_category_access(p_category_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not authorized'; end if;

  insert into public.file_access (file_id, user_id, granted_by)
  select f.id, p_user_id, auth.uid()
  from public.files f
  where f.category_id = p_category_id
  on conflict (file_id, user_id) do nothing;

  perform public.log_activity('permission_changed', 'info',
    jsonb_build_object('category_id', p_category_id, 'user_id', p_user_id, 'action', 'grant_category'));
end;
$$;
grant execute on function public.admin_grant_category_access(uuid, uuid) to authenticated;

create or replace function public.admin_revoke_category_access(p_category_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not authorized'; end if;

  delete from public.file_access fa
  using public.files f
  where fa.file_id = f.id and f.category_id = p_category_id and fa.user_id = p_user_id;

  perform public.log_activity('permission_changed', 'info',
    jsonb_build_object('category_id', p_category_id, 'user_id', p_user_id, 'action', 'revoke_category'));
end;
$$;
grant execute on function public.admin_revoke_category_access(uuid, uuid) to authenticated;

-- ============================================================================
-- 14. Enable RLS everywhere
-- ============================================================================
alter table public.profiles      enable row level security;
alter table public.categories    enable row level security;
alter table public.files         enable row level security;
alter table public.file_access   enable row level security;
alter table public.activity_log  enable row level security;
alter table public.login_attempts enable row level security; -- no policies: only functions above may touch it

-- ============================================================================
-- 15. Policies — profiles
--     Nobody may write their own role/is_active/manager_id from the client;
--     only admin may write any profile field.
-- ============================================================================
create policy "profiles_select_self_or_admin"
  on public.profiles for select
  using (id = auth.uid() or public.is_admin());

create policy "profiles_update_admin_only"
  on public.profiles for update
  using (public.is_admin());

create policy "profiles_insert_admin_only"
  on public.profiles for insert
  with check (public.is_admin());

-- ============================================================================
-- 16. Policies — categories
-- ============================================================================
create policy "categories_select_authenticated"
  on public.categories for select
  using (auth.uid() is not null);

create policy "categories_write_admin_only"
  on public.categories for insert with check (public.is_admin());
create policy "categories_update_admin_only"
  on public.categories for update using (public.is_admin());
create policy "categories_delete_admin_only"
  on public.categories for delete using (public.is_admin());

-- ============================================================================
-- 17. Policies — files
--     Admin: all active + inactive files. harish/guest/localadmin: only
--     active files explicitly granted via file_access. localadmin never
--     receives grants, so it structurally sees nothing here.
-- ============================================================================
create policy "files_select_admin_all"
  on public.files for select using (public.is_admin());

create policy "files_select_granted_active"
  on public.files for select
  using (
    is_active = true
    and exists (select 1 from public.file_access fa where fa.file_id = files.id and fa.user_id = auth.uid())
  );

create policy "files_insert_admin_only" on public.files for insert with check (public.is_admin());
create policy "files_update_admin_only" on public.files for update using (public.is_admin());
create policy "files_delete_admin_only" on public.files for delete using (public.is_admin());

-- ============================================================================
-- 18. Policies — file_access
-- ============================================================================
create policy "file_access_select_own_or_admin"
  on public.file_access for select using (user_id = auth.uid() or public.is_admin());
create policy "file_access_write_admin_only"
  on public.file_access for insert with check (public.is_admin());
create policy "file_access_delete_admin_only"
  on public.file_access for delete using (public.is_admin());

-- ============================================================================
-- 19. Policies — activity_log
--     Insert only through log_activity()/record_login_attempt() (security
--     definer, bypasses these policies). Direct table access is read-only
--     for admin, and a user may read their own rows.
-- ============================================================================
create policy "activity_select_self_or_admin"
  on public.activity_log for select using (user_id = auth.uid() or public.is_admin());

-- ============================================================================
-- 20. Storage — profile photos
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Public bucket: profile photos are viewable by anyone with the URL (documented
-- in README). Only admin may write/replace/delete avatar files.
drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read" on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists "avatars_admin_write" on storage.objects;
create policy "avatars_admin_write" on storage.objects
  for insert with check (bucket_id = 'avatars' and public.is_admin());

drop policy if exists "avatars_admin_update" on storage.objects;
create policy "avatars_admin_update" on storage.objects
  for update using (bucket_id = 'avatars' and public.is_admin());

drop policy if exists "avatars_admin_delete" on storage.objects;
create policy "avatars_admin_delete" on storage.objects
  for delete using (bucket_id = 'avatars' and public.is_admin());

-- ============================================================================
-- 21. Seed — categories only. No user credentials, ever.
-- ============================================================================
insert into public.categories (name, description) values
  ('Academic',    'Coursework, notes, and study material'),
  ('Software',    'Installers and tools'),
  ('Media',       'Video, audio, and image archives'),
  ('Documents',   'PDFs and reference documents'),
  ('Other',       'Anything that does not fit another category')
on conflict (name) do nothing;

-- ============================================================================
-- 22. Universal setup helper — see README "Universal admin setup query" for
-- the full walkthrough of creating users and files without hand-written SQL
-- each time. In short, after creating an Auth user:
--
--   insert into public.profiles (id, username, display_name, email, role, manager_id)
--   values ('<auth-uuid>', 'harish', 'Harish', 'harishramesh004+harish@gmail.com',
--           'harish', '<admin-profile-uuid>');
--
-- and to add a file as admin (client-side, via RPC, no raw SQL needed):
--
--   select admin_create_file('Notes.pdf', 'https://drive.google.com/...',
--           'pdf', '2 MB', '<category-uuid>', 'Semester notes', 'google_drive');
-- ============================================================================
