-- 017_profiles_signup_metadata_and_register_employee_phone.sql
-- Persist signup metadata (first_name, last_name, phone_number) into public.users/profiles
-- and extend register_employee RPC with p_phone for OTP/device-security prerequisites.

begin;

-- ---------------------------------------------------------
-- 1) Users schema for signup metadata
-- ---------------------------------------------------------
alter table public.users
  add column if not exists first_name text,
  add column if not exists last_name text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_first_name_len_check'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_first_name_len_check
      check (first_name is null or char_length(trim(first_name)) between 1 and 120);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_last_name_len_check'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_last_name_len_check
      check (last_name is null or char_length(trim(last_name)) between 1 and 120);
  end if;
end $$;

create index if not exists idx_users_first_name
  on public.users (first_name)
  where first_name is not null;

create index if not exists idx_users_last_name
  on public.users (last_name)
  where last_name is not null;

-- ---------------------------------------------------------
-- 2) Phone normalization helper (E.164)
-- ---------------------------------------------------------
create or replace function public.normalize_phone_e164(p_phone text)
returns text
language plpgsql
immutable
as $$
declare
  v_raw text;
  v_clean text;
begin
  v_raw := nullif(trim(p_phone), '');
  if v_raw is null then
    return null;
  end if;

  v_clean := regexp_replace(v_raw, '[\s\-\(\)\.]', '', 'g');

  -- allow international prefix 00 and normalize to +
  if v_clean like '00%' then
    v_clean := '+' || substr(v_clean, 3);
  end if;

  -- allow missing plus and normalize
  if v_clean ~ '^[1-9][0-9]{7,14}$' then
    v_clean := '+' || v_clean;
  end if;

  if v_clean !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Telefono invalido. Use formato E.164 (+573001112233).';
  end if;

  return v_clean;
end;
$$;

-- ---------------------------------------------------------
-- 3) profiles view + update trigger include first/last/phone
-- ---------------------------------------------------------
drop view if exists public.profiles;

create view public.profiles as
select
  u.id,
  u.first_name,
  u.last_name,
  u.full_name,
  u.email,
  u.phone_e164 as phone_number,
  r.name::text as role,
  u.is_active
from public.users u
left join public.roles r on r.id = u.role_id;

create or replace function public.profiles_update()
returns trigger
language plpgsql
as $$
declare
  v_role_id integer;
  v_first_name text;
  v_last_name text;
  v_full_name text;
  v_phone text;
begin
  if new.role is not null then
    select id into v_role_id
    from public.roles
    where name::text = new.role
    limit 1;

    if v_role_id is null then
      raise exception 'Rol invalido: %', new.role;
    end if;
  end if;

  v_first_name := nullif(trim(new.first_name), '');
  v_last_name := nullif(trim(new.last_name), '');
  v_full_name := nullif(trim(new.full_name), '');

  if v_full_name is null and (v_first_name is not null or v_last_name is not null) then
    v_full_name := nullif(trim(concat_ws(' ', v_first_name, v_last_name)), '');
  end if;

  v_phone := public.normalize_phone_e164(new.phone_number);

  update public.users
  set
    first_name = coalesce(v_first_name, first_name),
    last_name = coalesce(v_last_name, last_name),
    full_name = coalesce(v_full_name, full_name),
    phone_e164 = coalesce(v_phone, phone_e164),
    role_id = coalesce(v_role_id, role_id),
    is_active = coalesce(new.is_active, is_active),
    updated_at = now()
  where id = old.id;

  return (
    select p
    from public.profiles p
    where p.id = old.id
  );
end;
$$;

do $$
begin
  if exists (
    select 1 from pg_trigger where tgname = 'tr_profiles_update'
  ) then
    drop trigger tr_profiles_update on public.profiles;
  end if;

  create trigger tr_profiles_update
  instead of update on public.profiles
  for each row execute function public.profiles_update();
end $$;

-- ---------------------------------------------------------
-- 4) register_employee RPC extended with first/last/phone
-- ---------------------------------------------------------
drop function if exists public.register_employee(uuid, text, text);

create or replace function public.register_employee(
  p_user_id uuid,
  p_email text,
  p_full_name text default null,
  p_first_name text default null,
  p_last_name text default null,
  p_phone text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role_id integer;
  v_auth_meta jsonb;
  v_first_name text;
  v_last_name text;
  v_full_name text;
  v_phone text;
begin
  if auth.uid() is null then
    raise exception 'No autenticado.';
  end if;

  if auth.uid() <> p_user_id then
    raise exception 'No autorizado para registrar otro usuario.';
  end if;

  if p_user_id is null or p_email is null then
    raise exception 'Parametros incompletos para registro.';
  end if;

  select coalesce(au.raw_user_meta_data, '{}'::jsonb)
    into v_auth_meta
  from auth.users au
  where au.id = p_user_id
    and lower(coalesce(au.email, '')) = lower(p_email)
  limit 1;

  if not found then
    raise exception 'Usuario auth invalido.';
  end if;

  select id
    into v_role_id
  from public.roles
  where name::text = 'empleado'
  limit 1;

  if v_role_id is null then
    raise exception 'No existe rol empleado en public.roles.';
  end if;

  v_first_name := coalesce(
    nullif(trim(p_first_name), ''),
    nullif(trim(v_auth_meta ->> 'first_name'), '')
  );

  v_last_name := coalesce(
    nullif(trim(p_last_name), ''),
    nullif(trim(v_auth_meta ->> 'last_name'), '')
  );

  v_full_name := coalesce(
    nullif(trim(p_full_name), ''),
    nullif(trim(v_auth_meta ->> 'full_name'), ''),
    nullif(trim(v_auth_meta ->> 'name'), '')
  );

  if v_full_name is null and (v_first_name is not null or v_last_name is not null) then
    v_full_name := nullif(trim(concat_ws(' ', v_first_name, v_last_name)), '');
  end if;

  v_phone := public.normalize_phone_e164(
    coalesce(
      nullif(trim(p_phone), ''),
      nullif(trim(v_auth_meta ->> 'phone_number'), ''),
      nullif(trim(v_auth_meta ->> 'phone'), '')
    )
  );

  insert into public.users (id, email, role_id, first_name, last_name, full_name, phone_e164, is_active)
  values (p_user_id, p_email, v_role_id, v_first_name, v_last_name, v_full_name, v_phone, false)
  on conflict (id) do update
  set
    email = coalesce(excluded.email, public.users.email),
    first_name = coalesce(excluded.first_name, public.users.first_name),
    last_name = coalesce(excluded.last_name, public.users.last_name),
    full_name = coalesce(excluded.full_name, public.users.full_name),
    phone_e164 = coalesce(excluded.phone_e164, public.users.phone_e164),
    updated_at = now();
end;
$$;

grant execute on function public.register_employee(uuid, text, text, text, text, text) to authenticated;

commit;
