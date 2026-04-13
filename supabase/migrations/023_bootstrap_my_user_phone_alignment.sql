-- 023_bootstrap_my_user_phone_alignment.sql
-- Ensure bootstrap_my_user persists signup phone metadata into public.users.phone_e164.

begin;
create or replace function public.bootstrap_my_user()
returns table (
  id uuid,
  email text,
  first_name text,
  last_name text,
  full_name text,
  phone_number text,
  role text,
  is_active boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_meta jsonb;
  v_role_id integer;
  v_first_name text;
  v_last_name text;
  v_full_name text;
  v_phone text;
begin
  if v_uid is null then
    raise exception 'No autenticado.';
  end if;

  select
    au.email,
    coalesce(au.raw_user_meta_data, '{}'::jsonb)
  into v_email, v_meta
  from auth.users au
  where au.id = v_uid
  limit 1;

  if v_email is null then
    raise exception 'Usuario auth invalido.';
  end if;

  select r.id
    into v_role_id
  from public.roles r
  where r.name::text = 'empleado'
  limit 1;

  if v_role_id is null then
    raise exception 'No existe rol empleado en public.roles.';
  end if;

  v_first_name := nullif(trim(v_meta ->> 'first_name'), '');
  v_last_name := nullif(trim(v_meta ->> 'last_name'), '');
  v_full_name := coalesce(
    nullif(trim(v_meta ->> 'full_name'), ''),
    nullif(trim(v_meta ->> 'name'), ''),
    nullif(trim(concat_ws(' ', v_first_name, v_last_name)), '')
  );

  v_phone := public.normalize_phone_e164(
    coalesce(
      nullif(trim(v_meta ->> 'phone_number'), ''),
      nullif(trim(v_meta ->> 'phone'), '')
    )
  );

  insert into public.users (
    id,
    email,
    role_id,
    first_name,
    last_name,
    full_name,
    phone_e164,
    is_active
  )
  values (
    v_uid,
    v_email,
    v_role_id,
    v_first_name,
    v_last_name,
    v_full_name,
    v_phone,
    false
  )
  on conflict (id) do update
  set
    email = excluded.email,
    first_name = coalesce(public.users.first_name, excluded.first_name),
    last_name = coalesce(public.users.last_name, excluded.last_name),
    full_name = coalesce(public.users.full_name, excluded.full_name),
    phone_e164 = coalesce(public.users.phone_e164, excluded.phone_e164),
    updated_at = now();

  return query
  select
    p.id,
    p.email,
    p.first_name,
    p.last_name,
    p.full_name,
    p.phone_number,
    p.role,
    p.is_active
  from public.profiles p
  where p.id = v_uid;
end;
$$;
grant execute on function public.bootstrap_my_user() to authenticated;
commit;
