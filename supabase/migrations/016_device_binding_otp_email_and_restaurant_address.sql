-- 016_device_binding_otp_email_and_restaurant_address.sql
-- Device trust on first login, phone OTP verification for shift operations,
-- email notification outbox, and normalized restaurant address fields.

begin;
-- ---------------------------------------------------------
-- 1) Restaurants normalized address + enforce geofence required
-- ---------------------------------------------------------
alter table public.restaurants
  add column if not exists address_line text,
  add column if not exists city text,
  add column if not exists state text,
  add column if not exists postal_code text,
  add column if not exists country text,
  add column if not exists place_id text;
create index if not exists idx_restaurants_place_id
  on public.restaurants (place_id)
  where place_id is not null;
create index if not exists idx_restaurants_city_state
  on public.restaurants (city, state)
  where city is not null;
update public.restaurants
set
  radius = coalesce(radius, geofence_radius_m),
  geofence_radius_m = coalesce(geofence_radius_m, radius);
do $$
begin
  if exists (
    select 1
    from public.restaurants
    where lat is null or lng is null or radius is null
  ) then
    raise exception 'No se puede exigir geocerca obligatoria: existen restaurantes sin lat/lng/radius';
  end if;

  alter table public.restaurants
    alter column lat set not null,
    alter column lng set not null,
    alter column radius set not null;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'restaurants'
      and column_name = 'geofence_radius_m'
  ) then
    if exists (
      select 1
      from public.restaurants
      where geofence_radius_m is null
    ) then
      raise exception 'No se puede exigir geofence_radius_m obligatorio: existen restaurantes sin geofence_radius_m';
    end if;

    alter table public.restaurants
      alter column geofence_radius_m set not null;
  end if;
end $$;
-- ---------------------------------------------------------
-- 2) Users: phone for OTP
-- ---------------------------------------------------------
alter table public.users
  add column if not exists phone_e164 text;
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_phone_e164_check'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_phone_e164_check
      check (phone_e164 is null or phone_e164 ~ '^\\+[1-9][0-9]{7,14}$');
  end if;
end $$;
create index if not exists idx_users_phone_e164
  on public.users (phone_e164)
  where phone_e164 is not null;
-- ---------------------------------------------------------
-- 3) Trusted devices + OTP + email outbox
-- ---------------------------------------------------------
create table if not exists public.user_trusted_devices (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  device_fingerprint_hash text not null,
  device_name text null,
  platform text null,
  user_agent text null,
  ip_address inet null,
  first_login_binding boolean not null default false,
  trusted_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz null,
  revoked_by uuid null references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_trusted_devices_hash_len_check check (char_length(device_fingerprint_hash) between 32 and 128),
  unique (user_id, device_fingerprint_hash)
);
create index if not exists idx_user_trusted_devices_user_active
  on public.user_trusted_devices (user_id, revoked_at, last_seen_at desc);
create table if not exists public.user_phone_otps (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  phone_e164 text not null,
  purpose text not null default 'shift_ops',
  code_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  delivery_status text not null default 'pending',
  provider_ref text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_phone_otps_purpose_check check (purpose in ('shift_ops')),
  constraint user_phone_otps_attempts_check check (attempts >= 0 and max_attempts between 1 and 10 and attempts <= max_attempts + 1),
  constraint user_phone_otps_hash_len_check check (char_length(code_hash) between 32 and 128),
  constraint user_phone_otps_phone_check check (phone_e164 ~ '^\\+[1-9][0-9]{7,14}$')
);
create index if not exists idx_user_phone_otps_lookup
  on public.user_phone_otps (user_id, purpose, created_at desc);
create index if not exists idx_user_phone_otps_active
  on public.user_phone_otps (user_id, purpose, expires_at)
  where consumed_at is null;
create table if not exists public.user_phone_verification_sessions (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  purpose text not null default 'shift_ops',
  trusted_device_id bigint not null references public.user_trusted_devices(id) on delete cascade,
  token_hash text not null,
  verified_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_phone_verification_sessions_purpose_check check (purpose in ('shift_ops')),
  constraint user_phone_verification_sessions_hash_len_check check (char_length(token_hash) between 32 and 128),
  unique (user_id, purpose, token_hash)
);
create index if not exists idx_user_phone_verification_sessions_lookup
  on public.user_phone_verification_sessions (user_id, purpose, expires_at desc)
  where revoked_at is null;
create table if not exists public.email_notifications (
  id bigserial primary key,
  event_type text not null,
  dedupe_key text null,
  recipient_email text not null,
  recipient_user_id uuid null references public.users(id) on delete set null,
  subject text not null,
  body_text text not null,
  body_html text null,
  payload jsonb not null default '{}'::jsonb,
  restaurant_id integer null references public.restaurants(id) on delete set null,
  shift_id integer null references public.shifts(id) on delete set null,
  incident_id integer null references public.incidents(id) on delete set null,
  scheduled_shift_id bigint null references public.scheduled_shifts(id) on delete set null,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_error text null,
  provider_ref text null,
  scheduled_for timestamptz not null default now(),
  sent_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_notifications_event_type_check check (
    event_type in (
      'shift_scheduled',
      'shift_started',
      'shift_ended',
      'shift_not_started',
      'incident_created',
      'shift_approved',
      'shift_rejected'
    )
  ),
  constraint email_notifications_status_check check (status in ('pending', 'sending', 'sent', 'failed')),
  constraint email_notifications_email_check check (position('@' in recipient_email) > 1)
);
create unique index if not exists uq_email_notifications_dedupe_key
  on public.email_notifications (dedupe_key);
create index if not exists idx_email_notifications_dispatch
  on public.email_notifications (status, scheduled_for, created_at)
  where status in ('pending', 'failed');
-- ---------------------------------------------------------
-- 4) Generic updated_at touch trigger
-- ---------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
do $$
begin
  if exists (select 1 from pg_trigger where tgname = 'tr_user_trusted_devices_touch_updated_at') then
    drop trigger tr_user_trusted_devices_touch_updated_at on public.user_trusted_devices;
  end if;
  create trigger tr_user_trusted_devices_touch_updated_at
  before update on public.user_trusted_devices
  for each row execute function public.touch_updated_at();

  if exists (select 1 from pg_trigger where tgname = 'tr_user_phone_otps_touch_updated_at') then
    drop trigger tr_user_phone_otps_touch_updated_at on public.user_phone_otps;
  end if;
  create trigger tr_user_phone_otps_touch_updated_at
  before update on public.user_phone_otps
  for each row execute function public.touch_updated_at();

  if exists (select 1 from pg_trigger where tgname = 'tr_user_phone_verification_sessions_touch_updated_at') then
    drop trigger tr_user_phone_verification_sessions_touch_updated_at on public.user_phone_verification_sessions;
  end if;
  create trigger tr_user_phone_verification_sessions_touch_updated_at
  before update on public.user_phone_verification_sessions
  for each row execute function public.touch_updated_at();

  if exists (select 1 from pg_trigger where tgname = 'tr_email_notifications_touch_updated_at') then
    drop trigger tr_email_notifications_touch_updated_at on public.email_notifications;
  end if;
  create trigger tr_email_notifications_touch_updated_at
  before update on public.email_notifications
  for each row execute function public.touch_updated_at();
end $$;
-- ---------------------------------------------------------
-- 5) Enqueue email when a shift is scheduled
-- ---------------------------------------------------------
create or replace function public.enqueue_shift_scheduled_notifications()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.email_notifications (
    event_type,
    dedupe_key,
    recipient_email,
    recipient_user_id,
    subject,
    body_text,
    payload,
    restaurant_id,
    scheduled_shift_id,
    status,
    scheduled_for
  )
  select
    'shift_scheduled',
    format('shift_scheduled:%s:%s', new.id, u.id),
    u.email,
    u.id,
    format('Turno programado | Restaurante #%s', new.restaurant_id),
    format(
      'Se programo un turno para %s (inicio: %s, fin: %s, restaurante: %s).',
      new.employee_id,
      to_char(new.scheduled_start at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS "UTC"'),
      to_char(new.scheduled_end at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS "UTC"'),
      new.restaurant_id
    ),
    jsonb_build_object(
      'scheduled_shift_id', new.id,
      'employee_id', new.employee_id,
      'restaurant_id', new.restaurant_id,
      'scheduled_start', new.scheduled_start,
      'scheduled_end', new.scheduled_end
    ),
    new.restaurant_id,
    new.id,
    'pending',
    now()
  from public.users u
  join public.roles r on r.id = u.role_id
  where u.is_active = true
    and u.email is not null
    and (
      u.id = new.employee_id
      or r.name = 'super_admin'
      or (
        r.name = 'supervisora'
        and exists (
          select 1
          from public.restaurant_employees re
          where re.user_id = u.id
            and re.restaurant_id = new.restaurant_id
        )
      )
    )
  on conflict (dedupe_key) do nothing;

  return new;
end;
$$;
do $$
begin
  if exists (select 1 from pg_trigger where tgname = 'tr_enqueue_shift_scheduled_notifications') then
    drop trigger tr_enqueue_shift_scheduled_notifications on public.scheduled_shifts;
  end if;

  create trigger tr_enqueue_shift_scheduled_notifications
  after insert on public.scheduled_shifts
  for each row execute function public.enqueue_shift_scheduled_notifications();
end $$;
-- ---------------------------------------------------------
-- 6) Grants + RLS policies
-- ---------------------------------------------------------
alter table public.user_trusted_devices enable row level security;
alter table public.user_phone_otps enable row level security;
alter table public.user_phone_verification_sessions enable row level security;
alter table public.email_notifications enable row level security;
revoke all on table public.user_trusted_devices from public, anon;
revoke all on table public.user_phone_otps from public, anon;
revoke all on table public.user_phone_verification_sessions from public, anon;
revoke all on table public.email_notifications from public, anon;
grant select, insert, update on table public.user_trusted_devices to authenticated;
grant select, insert, update on table public.user_phone_otps to authenticated;
grant select, insert, update on table public.user_phone_verification_sessions to authenticated;
grant select on table public.email_notifications to authenticated;
do $$
declare
  p record;
begin
  for p in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'user_trusted_devices',
        'user_phone_otps',
        'user_phone_verification_sessions',
        'email_notifications'
      )
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;
create policy user_trusted_devices_select_scoped
on public.user_trusted_devices
for select to authenticated
using (
  user_id = auth.uid()
  or public.actor_role_secure() = 'super_admin'
);
create policy user_trusted_devices_insert_self
on public.user_trusted_devices
for insert to authenticated
with check (user_id = auth.uid());
create policy user_trusted_devices_update_scoped
on public.user_trusted_devices
for update to authenticated
using (
  user_id = auth.uid()
  or public.actor_role_secure() = 'super_admin'
)
with check (
  user_id = auth.uid()
  or public.actor_role_secure() = 'super_admin'
);
create policy user_phone_otps_select_scoped
on public.user_phone_otps
for select to authenticated
using (
  user_id = auth.uid()
  or public.actor_role_secure() = 'super_admin'
);
create policy user_phone_otps_insert_self
on public.user_phone_otps
for insert to authenticated
with check (user_id = auth.uid());
create policy user_phone_otps_update_scoped
on public.user_phone_otps
for update to authenticated
using (
  user_id = auth.uid()
  or public.actor_role_secure() = 'super_admin'
)
with check (
  user_id = auth.uid()
  or public.actor_role_secure() = 'super_admin'
);
create policy user_phone_verification_sessions_select_scoped
on public.user_phone_verification_sessions
for select to authenticated
using (
  user_id = auth.uid()
  or public.actor_role_secure() = 'super_admin'
);
create policy user_phone_verification_sessions_insert_self
on public.user_phone_verification_sessions
for insert to authenticated
with check (user_id = auth.uid());
create policy user_phone_verification_sessions_update_scoped
on public.user_phone_verification_sessions
for update to authenticated
using (
  user_id = auth.uid()
  or public.actor_role_secure() = 'super_admin'
)
with check (
  user_id = auth.uid()
  or public.actor_role_secure() = 'super_admin'
);
create policy email_notifications_select_scoped
on public.email_notifications
for select to authenticated
using (
  recipient_user_id = auth.uid()
  or public.actor_role_secure() in ('super_admin', 'supervisora')
);
commit;
