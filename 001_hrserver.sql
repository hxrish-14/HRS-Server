-- ============================================================================
-- HRS Server — 001_hrserver.sql
--
-- ⚠️  DESTRUCTIVE RESET ⚠️
-- This drops and recreates ONLY the HRS Server application tables/functions/
-- policies listed below. It does NOT touch auth.users or any other Supabase
-- infrastructure. Back up any real data first if this isn't a fresh project.
-- Auth users themselves are never created or deleted by this file — see
-- README "Step 5: Create authentication users" for that step.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------
-- DESTRUCTIVE RESET — drops HRS Server objects only, nothing in auth.*
-- ----------------------------------------------------------------------
drop table if exists public.security_events cascade;
drop table if exists public.activity_log cascade;
drop table if exists public.login_attempts cascade;
drop table if exists public.file_access cascade;
drop table if exists public.files cascade;
drop table if exists public.categories cascade;
drop table if exists public.profiles cascade;

drop function if exists public.is_admin() cascade;
drop function if exists public.current_role_name() cascade;
drop function if exists public.is_locked_out(text) cascade;
drop function if exists public.record_login_attempt(text, boolean, text, text) cascade;
drop function if exists public.log_activity(text, text, jsonb) cascade;
drop function if exists public.log_security_event(text, text, text, jsonb) cascade;
drop function if exists public.touch_last_seen() cascade;
drop function if exists public.admin_create_file(text, text, text, text, uuid, text, text) cascade;
drop function if exists public.admin_grant_category_access(uuid, uuid) cascade;
drop function if exists public.admin_revoke_category_access(uuid, uuid) cascade;
drop function if exists public.set_updated_at() cascade;

-- ============================================================================
-- 1. profiles
-- ============================================================================
create table public.profiles (
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
create table public.categories (
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
create table public.files (
  id                uuid primary key default gen_random_uuid(),
  file_name         text not null,
  file_link         text not null,
  file_type         text,
  file_size         text,
  file_category_id  uuid references public.categories(id) on delete set null,
  source_platform   text not null check (source_platform in
                      ('google_drive', 'mediafire', 'wetransfer', 'telegram', 'other')),
  description       text,
  is_active         boolean not null default true,
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint files_link_https_check check (file_link ~* '^https://')
);

-- ============================================================================
-- 4. file_access
-- ============================================================================
create table public.file_access (
  id         uuid primary key default gen_random_uuid(),
  file_id    uuid not null references public.files(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  granted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (file_id, user_id)
);

-- ============================================================================
-- 5. login_attempts — backs server-side lockout, touched only via functions
-- ============================================================================
create table public.login_attempts (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  success      boolean not null,
  ip_address   text,
  user_agent   text,
  attempted_at timestamptz not null default now()
);

-- ============================================================================
-- 6. activity_log — general, non-security activity
-- ============================================================================
create table public.activity_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles(id) on delete set null,
  event_type text not null,
  metadata   jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 7. security_events — failed logins, lockouts, unauthorized attempts
-- ============================================================================
create table public.security_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles(id) on delete set null,
  event_type text not null,
  severity   text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  message    text,
  metadata   jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 8. Indexes
-- ============================================================================
create index idx_profiles_role       on public.profiles (role);
create index idx_profiles_username   on public.profiles (username);
create index idx_profiles_last_seen  on public.profiles (last_seen_at);
create index idx_files_name          on public.files using gin (to_tsvector('simple', file_name));
create index idx_files_category      on public.files (file_category_id);
create index idx_files_source        on public.files (source_platform);
create index idx_files_created_at    on public.files (created_at desc);
create index idx_file_access_user    on public.file_access (user_id);
create index idx_file_access_file    on public.file_access (file_id);
create index idx_login_attempts_mail on public.login_attempts (email, attempted_at desc);
create index idx_activity_user       on public.activity_log (user_id);
create index idx_activity_created    on public.activity_log (created_at desc);
create index idx_security_user       on public.security_events (user_id);
create index idx_security_created    on public.security_events (created_at desc);

-- ============================================================================
-- 9. updated_at trigger
-- ============================================================================
create function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger trg_categories_updated before update on public.categories
  for each row execute function public.set_updated_at();
create trigger trg_files_updated before update on public.files
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 10. Role helpers (security definer → no RLS recursion)
-- ============================================================================
create function public.current_role_name()
returns text language sql security definer set search_path = public stable as $$
  select role from public.profiles where id = auth.uid();
$$;

create function public.is_admin()
returns boolean language sql security definer set search_path = public stable as $$
  select coalesce((select role from public.profiles where id = auth.uid()) = 'admin', false);
$$;

-- ============================================================================
-- 11. Login lockout — the REAL enforcement layer, not the frontend counter
-- ============================================================================
create function public.is_locked_out(p_email text)
returns boolean language sql security definer set search_path = public stable as $$
  select count(*) >= 5
  from public.login_attempts
  where email = lower(p_email) and success = false
    and attempted_at > now() - interval '10 minutes';
$$;

create function public.log_security_event(
  p_event_type text, p_severity text default 'warning', p_message text default null, p_metadata jsonb default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.security_events (user_id, event_type, severity, message, metadata)
  values (auth.uid(), p_event_type, p_severity, p_message, p_metadata);
end;
$$;

create function public.record_login_attempt(
  p_email text, p_success boolean, p_ip text default null, p_user_agent text default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.login_attempts (email, success, ip_address, user_agent)
  values (lower(p_email), p_success, p_ip, p_user_agent);

  if not p_success then
    insert into public.security_events (event_type, severity, message, metadata)
    values ('failed_login', 'warning', 'Failed login attempt', jsonb_build_object('email', lower(p_email)));

    if public.is_locked_out(p_email) then
      insert into public.security_events (event_type, severity, message, metadata)
      values ('lockout_triggered', 'critical', 'Account temporarily locked after 5 failed attempts',
              jsonb_build_object('email', lower(p_email)));
    end if;
  end if;
end;
$$;

revoke all on public.login_attempts from anon, authenticated;
revoke all on public.security_events from anon, authenticated;
grant execute on function public.is_locked_out(text) to anon, authenticated;
grant execute on function public.record_login_attempt(text, boolean, text, text) to anon, authenticated;
grant execute on function public.log_security_event(text, text, text, jsonb) to authenticated;

-- ============================================================================
-- 12. General activity logger
-- ============================================================================
create function public.log_activity(p_event_type text, p_metadata jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.activity_log (user_id, event_type, metadata) values (auth.uid(), p_event_type, p_metadata);
end;
$$;
grant execute on function public.log_activity(text, jsonb) to authenticated;

-- ============================================================================
-- 13. Heartbeat
-- ============================================================================
create function public.touch_last_seen()
returns void language sql security definer set search_path = public as $$
  update public.profiles set last_seen_at = now() where id = auth.uid();
$$;
grant execute on function public.touch_last_seen() to authenticated;

-- ============================================================================
-- 14. Admin convenience functions — no SQL textbox needed in the UI
-- ============================================================================
create function public.admin_create_file(
  p_file_name text, p_file_link text, p_file_type text, p_file_size text,
  p_category_id uuid, p_description text, p_source_platform text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'Not authorized'; end if;
  if p_file_link !~* '^https://' then raise exception 'Only https:// links are allowed'; end if;

  insert into public.files (file_name, file_link, file_type, file_size, file_category_id,
                             description, source_platform, created_by)
  values (p_file_name, p_file_link, p_file_type, p_file_size, p_category_id,
          p_description, p_source_platform, auth.uid())
  returning id into v_id;

  perform public.log_activity('file_created', jsonb_build_object('file_id', v_id));
  return v_id;
end;
$$;
grant execute on function public.admin_create_file(text, text, text, text, uuid, text, text) to authenticated;

create function public.admin_grant_category_access(p_category_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not authorized'; end if;
  insert into public.file_access (file_id, user_id, granted_by)
  select f.id, p_user_id, auth.uid() from public.files f where f.file_category_id = p_category_id
  on conflict (file_id, user_id) do nothing;
  perform public.log_activity('access_granted', jsonb_build_object('category_id', p_category_id, 'user_id', p_user_id));
end;
$$;
grant execute on function public.admin_grant_category_access(uuid, uuid) to authenticated;

create function public.admin_revoke_category_access(p_category_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not authorized'; end if;
  delete from public.file_access fa using public.files f
  where fa.file_id = f.id and f.file_category_id = p_category_id and fa.user_id = p_user_id;
  perform public.log_activity('access_revoked', jsonb_build_object('category_id', p_category_id, 'user_id', p_user_id));
end;
$$;
grant execute on function public.admin_revoke_category_access(uuid, uuid) to authenticated;

-- ============================================================================
-- 15. Enable RLS everywhere
-- ============================================================================
alter table public.profiles       enable row level security;
alter table public.categories     enable row level security;
alter table public.files          enable row level security;
alter table public.file_access    enable row level security;
alter table public.activity_log   enable row level security;
alter table public.security_events enable row level security; -- no policies: functions only
alter table public.login_attempts enable row level security;  -- no policies: functions only

-- ============================================================================
-- 16. Policies — profiles (nobody can self-promote; admin manages all)
-- ============================================================================
create policy "profiles_select_self_or_admin" on public.profiles for select
  using (id = auth.uid() or public.is_admin());
create policy "profiles_update_admin_only" on public.profiles for update using (public.is_admin());
create policy "profiles_insert_admin_only" on public.profiles for insert with check (public.is_admin());

-- ============================================================================
-- 17. Policies — categories
-- ============================================================================
create policy "categories_select_authenticated" on public.categories for select using (auth.uid() is not null);
create policy "categories_write_admin_only" on public.categories for insert with check (public.is_admin());
create policy "categories_update_admin_only" on public.categories for update using (public.is_admin());
create policy "categories_delete_admin_only" on public.categories for delete using (public.is_admin());

-- ============================================================================
-- 18. Policies — files
--     Admin: all files, active or not. harish/guest: active + granted only.
--     localadmin: no grants are ever created, so it sees nothing.
-- ============================================================================
create policy "files_select_admin_all" on public.files for select using (public.is_admin());
create policy "files_select_granted_active" on public.files for select
  using (
    is_active = true
    and exists (select 1 from public.file_access fa where fa.file_id = files.id and fa.user_id = auth.uid())
  );
create policy "files_insert_admin_only" on public.files for insert with check (public.is_admin());
create policy "files_update_admin_only" on public.files for update using (public.is_admin());
create policy "files_delete_admin_only" on public.files for delete using (public.is_admin());

-- ============================================================================
-- 19. Policies — file_access
-- ============================================================================
create policy "file_access_select_own_or_admin" on public.file_access for select
  using (user_id = auth.uid() or public.is_admin());
create policy "file_access_write_admin_only" on public.file_access for insert with check (public.is_admin());
create policy "file_access_delete_admin_only" on public.file_access for delete using (public.is_admin());

-- ============================================================================
-- 20. Policies — activity_log (own rows or admin)
-- ============================================================================
create policy "activity_select_self_or_admin" on public.activity_log for select
  using (user_id = auth.uid() or public.is_admin());

-- ============================================================================
-- 21. Storage — profile photos
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read" on storage.objects for select using (bucket_id = 'avatars');
drop policy if exists "avatars_admin_write" on storage.objects;
create policy "avatars_admin_write" on storage.objects for insert with check (bucket_id = 'avatars' and public.is_admin());
drop policy if exists "avatars_admin_update" on storage.objects;
create policy "avatars_admin_update" on storage.objects for update using (bucket_id = 'avatars' and public.is_admin());
drop policy if exists "avatars_admin_delete" on storage.objects;
create policy "avatars_admin_delete" on storage.objects for delete using (bucket_id = 'avatars' and public.is_admin());

-- ============================================================================
-- 22. Seed — categories + demo data (no credentials, ever)
-- ============================================================================
insert into public.categories (name, description) values
  ('Documents', 'General reference documents'),
  ('Academic',  'Coursework and study material'),
  ('Projects',  'Project archives and deliverables'),
  ('Software',  'Installers and tools'),
  ('Personal',  'Personal files'),
  ('Important', 'High-priority material')
on conflict (name) do nothing;

-- Demo files and role grants are inserted after the four bootstrap profiles
-- exist — see README "Step 6: seed demo data" for the ready-to-run block
-- (it references the profile UUIDs you'll have by then, so it can't be
-- hardcoded here).
