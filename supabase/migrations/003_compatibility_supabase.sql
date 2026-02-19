-- Compatibility layer for current frontend contract
-- Date: 2026-02-12

begin;

-- 1) AUDIT LOGS: expected actor_id (frontend) vs existing user_id
alter table public.audit_logs
  add column if not exists actor_id uuid;

update public.audit_logs
set actor_id = user_id
where actor_id is null;

create or replace function public.sync_audit_actor_user()
returns trigger
language plpgsql
as $$
begin
  if new.actor_id is null and new.user_id is not null then
    new.actor_id := new.user_id;
  end if;

  if new.user_id is null and new.actor_id is not null then
    new.user_id := new.actor_id;
  end if;

  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'tr_sync_audit_actor_user'
  ) then
    create trigger tr_sync_audit_actor_user
    before insert or update on public.audit_logs
    for each row execute function public.sync_audit_actor_user();
  end if;
end $$;

-- 2) SHIFTS: status + evidence paths expected by frontend
alter table public.shifts add column if not exists status text;
alter table public.shifts add column if not exists start_evidence_path text;
alter table public.shifts add column if not exists end_evidence_path text;

update public.shifts
set status = case state::text
  when 'activo' then 'active'
  when 'finalizado' then 'completed'
  when 'aprobado' then 'approved'
  when 'rechazado' then 'rejected'
  else state::text
end
where status is null;

create or replace function public.shift_state_to_status(p_state text)
returns text
language sql
immutable
as $$
  select case p_state
    when 'activo' then 'active'
    when 'finalizado' then 'completed'
    when 'aprobado' then 'approved'
    when 'rechazado' then 'rejected'
    else p_state
  end;
$$;

create or replace function public.shift_status_to_state(p_status text)
returns public.shift_state
language plpgsql
immutable
as $$
begin
  case lower(coalesce(p_status, ''))
    when 'active' then return 'activo'::public.shift_state;
    when 'completed' then return 'finalizado'::public.shift_state;
    when 'approved' then return 'aprobado'::public.shift_state;
    when 'rejected' then return 'rechazado'::public.shift_state;
    else
      begin
        return p_status::public.shift_state;
      exception when others then
        return 'activo'::public.shift_state;
      end;
  end case;
end;
$$;

create or replace function public.sync_shift_state_status()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.state is null and new.status is not null then
      new.state := public.shift_status_to_state(new.status);
    end if;

    if new.status is null and new.state is not null then
      new.status := public.shift_state_to_status(new.state::text);
    end if;

    return new;
  end if;

  if new.status is distinct from old.status and new.status is not null then
    new.state := public.shift_status_to_state(new.status);
  elsif new.state is distinct from old.state and new.state is not null then
    new.status := public.shift_state_to_status(new.state::text);
  end if;

  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'tr_sync_shift_state_status'
  ) then
    create trigger tr_sync_shift_state_status
    before insert or update on public.shifts
    for each row execute function public.sync_shift_state_status();
  end if;
end $$;

-- 3) SHIFT INCIDENTS: expected table name/shape in frontend
create or replace view public.shift_incidents as
select
  i.id,
  i.shift_id,
  i.description as note,
  i.created_at,
  i.created_by
from public.incidents i;

create or replace function public.shift_incidents_insert()
returns trigger
language plpgsql
as $$
declare
  v_row public.incidents;
begin
  insert into public.incidents (shift_id, description, created_by)
  values (
    new.shift_id,
    coalesce(new.note, ''),
    coalesce(new.created_by, auth.uid())
  )
  returning * into v_row;

  new.id := v_row.id;
  new.shift_id := v_row.shift_id;
  new.note := v_row.description;
  new.created_at := v_row.created_at;
  new.created_by := v_row.created_by;
  return new;
end;
$$;

do $$
begin
  if exists (
    select 1 from pg_trigger where tgname = 'tr_shift_incidents_insert'
  ) then
    drop trigger tr_shift_incidents_insert on public.shift_incidents;
  end if;

  create trigger tr_shift_incidents_insert
  instead of insert on public.shift_incidents
  for each row execute function public.shift_incidents_insert();
end $$;

-- 4) RESTAURANTS: expected geofence_radius_m
alter table public.restaurants
  add column if not exists geofence_radius_m integer;

update public.restaurants
set geofence_radius_m = radius
where geofence_radius_m is null;

create or replace function public.sync_restaurant_radius_columns()
returns trigger
language plpgsql
as $$
begin
  if new.radius is null and new.geofence_radius_m is not null then
    new.radius := new.geofence_radius_m;
  end if;

  if new.geofence_radius_m is null and new.radius is not null then
    new.geofence_radius_m := new.radius;
  end if;

  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'tr_sync_restaurant_radius_columns'
  ) then
    create trigger tr_sync_restaurant_radius_columns
    before insert or update on public.restaurants
    for each row execute function public.sync_restaurant_radius_columns();
  end if;
end $$;

-- 5) RESTAURANT EMPLOYEES (missing in current DB)
create table if not exists public.restaurant_employees (
  id bigserial primary key,
  restaurant_id integer not null references public.restaurants(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (restaurant_id, user_id)
);

-- 5.1) SCHEDULED SHIFTS (planning by date/time)
create table if not exists public.scheduled_shifts (
  id bigserial primary key,
  employee_id uuid not null references public.users(id) on delete cascade,
  restaurant_id integer not null references public.restaurants(id) on delete cascade,
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  status text not null default 'scheduled',
  notes text null,
  started_shift_id integer null references public.shifts(id) on delete set null,
  created_by uuid null references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduled_shifts_time_check check (scheduled_end > scheduled_start),
  constraint scheduled_shifts_status_check check (status in ('scheduled', 'started', 'completed', 'cancelled'))
);

create index if not exists idx_scheduled_shifts_employee_start
  on public.scheduled_shifts (employee_id, scheduled_start);

create extension if not exists btree_gist;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'scheduled_shifts_no_overlap_active'
      and conrelid = 'public.scheduled_shifts'::regclass
  ) then
    alter table public.scheduled_shifts
      add constraint scheduled_shifts_no_overlap_active
      exclude using gist (
        employee_id with =,
        tstzrange(scheduled_start, scheduled_end, '[)') with &&
      )
      where (status in ('scheduled', 'started'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'restaurants_lat_check'
      and conrelid = 'public.restaurants'::regclass
  ) then
    alter table public.restaurants
      add constraint restaurants_lat_check
      check (lat between -90 and 90);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'restaurants_lng_check'
      and conrelid = 'public.restaurants'::regclass
  ) then
    alter table public.restaurants
      add constraint restaurants_lng_check
      check (lng between -180 and 180);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'restaurants_radius_check'
      and conrelid = 'public.restaurants'::regclass
  ) then
    alter table public.restaurants
      add constraint restaurants_radius_check
      check (radius > 0);
  end if;
end $$;

-- 6) USERS/PROFILES compatibility for frontend
alter table public.users
  add column if not exists full_name text;

alter table public.users
  add column if not exists is_active boolean not null default true;

create or replace view public.profiles as
select
  u.id,
  u.full_name,
  u.email,
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

  update public.users
  set
    full_name = coalesce(new.full_name, full_name),
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

-- 7) SELF REGISTRATION RPC (empleado)
create or replace function public.register_employee(
  p_user_id uuid,
  p_email text,
  p_full_name text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role_id integer;
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

  if not exists (
    select 1
    from auth.users au
    where au.id = p_user_id
      and lower(coalesce(au.email, '')) = lower(p_email)
  ) then
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

  insert into public.users (id, email, role_id, full_name, is_active)
  values (p_user_id, p_email, v_role_id, p_full_name, false)
  on conflict (id) do update
  set
    full_name = coalesce(excluded.full_name, public.users.full_name),
    updated_at = now();
end;
$$;

grant execute on function public.register_employee(uuid, text, text) to authenticated;

create or replace function public.app_user_role(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select r.name::text
  from public.users u
  join public.roles r on r.id = u.role_id
  where u.id = p_user_id
  limit 1;
$$;

grant execute on function public.app_user_role(uuid) to authenticated;

create or replace function public.assign_scheduled_shift(
  p_employee_id uuid,
  p_restaurant_id integer,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_notes text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_actor_role text;
  v_new_id bigint;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'No autenticado';
  end if;

  v_actor_role := public.app_user_role(v_actor_id);
  if v_actor_role not in ('super_admin', 'supervisora') then
    raise exception 'No autorizado para programar turnos';
  end if;

  if p_scheduled_end <= p_scheduled_start then
    raise exception 'Rango horario invalido';
  end if;

  if not exists (select 1 from public.users where id = p_employee_id and is_active = true) then
    raise exception 'Empleado invalido o inactivo';
  end if;

  if exists (
    select 1
    from public.scheduled_shifts s
    where s.employee_id = p_employee_id
      and s.status in ('scheduled', 'started')
      and tstzrange(s.scheduled_start, s.scheduled_end, '[)') &&
          tstzrange(p_scheduled_start, p_scheduled_end, '[)')
  ) then
    raise exception 'El empleado ya tiene un turno programado en ese rango';
  end if;

  insert into public.scheduled_shifts (
    employee_id,
    restaurant_id,
    scheduled_start,
    scheduled_end,
    status,
    notes,
    created_by
  )
  values (
    p_employee_id,
    p_restaurant_id,
    p_scheduled_start,
    p_scheduled_end,
    'scheduled',
    p_notes,
    v_actor_id
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;

grant execute on function public.assign_scheduled_shift(uuid, integer, timestamptz, timestamptz, text) to authenticated;

create or replace function public.list_my_scheduled_shifts(p_limit integer default 10)
returns table (
  id bigint,
  employee_id uuid,
  restaurant_id integer,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  status text,
  notes text
)
language sql
security definer
set search_path = public
as $$
  select
    s.id,
    s.employee_id,
    s.restaurant_id,
    s.scheduled_start,
    s.scheduled_end,
    s.status,
    s.notes
  from public.scheduled_shifts s
  where s.employee_id = auth.uid()
  order by s.scheduled_start desc
  limit greatest(1, coalesce(p_limit, 10));
$$;

grant execute on function public.list_my_scheduled_shifts(integer) to authenticated;

create or replace function public.list_scheduled_shifts(p_limit integer default 50)
returns table (
  id bigint,
  employee_id uuid,
  restaurant_id integer,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  status text,
  notes text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_actor_role text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'No autenticado';
  end if;

  v_actor_role := public.app_user_role(v_actor_id);
  if v_actor_role not in ('super_admin', 'supervisora') then
    raise exception 'No autorizado';
  end if;

  return query
  select
    s.id,
    s.employee_id,
    s.restaurant_id,
    s.scheduled_start,
    s.scheduled_end,
    s.status,
    s.notes
  from public.scheduled_shifts s
  order by s.scheduled_start desc
  limit greatest(1, coalesce(p_limit, 50));
end;
$$;

grant execute on function public.list_scheduled_shifts(integer) to authenticated;

-- 8) SUPPLIES compatibility columns
alter table public.supplies
  add column if not exists stock integer not null default 0;

alter table public.supplies
  add column if not exists restaurant_id integer references public.restaurants(id) on delete set null;

-- 9) HARDEN CORE SHIFT FUNCTIONS (avoid inherited logic bugs)
create or replace function public.start_shift(
  employee_id uuid,
  restaurant_id integer,
  lat double precision,
  lng double precision
)
returns integer
language plpgsql
as $$
declare
  v_rest_lat double precision;
  v_rest_lng double precision;
  v_rest_radius integer;
  v_active_count integer;
  v_shift_id integer;
begin
  select r.lat, r.lng, r.radius
    into v_rest_lat, v_rest_lng, v_rest_radius
  from public.restaurants r
  where r.id = restaurant_id;

  if v_rest_lat is null or v_rest_lng is null or v_rest_radius is null then
    raise exception 'Restaurante invalido o sin geocerca configurada';
  end if;

  if earth_distance(ll_to_earth(v_rest_lat, v_rest_lng), ll_to_earth(lat, lng)) > v_rest_radius then
    raise exception 'GPS fuera de radio';
  end if;

  select count(*)
    into v_active_count
  from public.shifts s
  where s.employee_id = start_shift.employee_id
    and s.state = 'activo';

  if v_active_count > 0 then
    raise exception 'Ya existe un turno activo';
  end if;

  insert into public.shifts (employee_id, restaurant_id, start_time, start_lat, start_lng, state, status)
  values (employee_id, restaurant_id, now(), lat, lng, 'activo', 'active')
  returning id into v_shift_id;

  return v_shift_id;
end;
$$;

create or replace function public.end_shift(
  shift_id integer,
  lat double precision,
  lng double precision
)
returns void
language plpgsql
as $$
declare
  v_rest_lat double precision;
  v_rest_lng double precision;
  v_rest_radius integer;
  v_restaurant_id integer;
begin
  select s.restaurant_id
    into v_restaurant_id
  from public.shifts s
  where s.id = end_shift.shift_id;

  if v_restaurant_id is null then
    raise exception 'Turno no existe';
  end if;

  select r.lat, r.lng, r.radius
    into v_rest_lat, v_rest_lng, v_rest_radius
  from public.restaurants r
  where r.id = v_restaurant_id;

  if v_rest_lat is null or v_rest_lng is null or v_rest_radius is null then
    raise exception 'Restaurante invalido o sin geocerca configurada';
  end if;

  if earth_distance(ll_to_earth(v_rest_lat, v_rest_lng), ll_to_earth(lat, lng)) > v_rest_radius then
    raise exception 'GPS fuera de radio';
  end if;

  update public.shifts
  set
    end_time = now(),
    end_lat = lat,
    end_lng = lng,
    state = 'finalizado',
    status = 'completed',
    updated_at = now()
  where id = end_shift.shift_id
    and end_time is null;

  if not found then
    raise exception 'Turno invalido o ya finalizado';
  end if;
end;
$$;

-- 10) RPC compatibility wrappers expected by frontend
create or replace function public.get_my_active_shift()
returns table (
  id integer,
  start_time timestamptz,
  end_time timestamptz,
  status text
)
language sql
security definer
set search_path = public
as $$
  select s.id, s.start_time, s.end_time, s.status
  from public.shifts s
  where s.employee_id = auth.uid()
    and s.end_time is null
  order by s.start_time desc
  limit 1;
$$;

create or replace function public.start_shift(
  lat double precision,
  lng double precision,
  evidence_path text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_id uuid;
  v_restaurant_id integer;
  v_shift_id integer;
  v_scheduled_id bigint;
begin
  v_employee_id := auth.uid();

  if v_employee_id is null then
    raise exception 'No autenticado';
  end if;

  select s.id, s.restaurant_id
    into v_scheduled_id, v_restaurant_id
  from public.scheduled_shifts s
  where s.employee_id = v_employee_id
    and s.status = 'scheduled'
    and now() between (s.scheduled_start - interval '15 minutes') and (s.scheduled_end + interval '15 minutes')
  order by s.scheduled_start asc
  limit 1;

  if v_restaurant_id is null then
    raise exception 'No hay turno programado vigente para iniciar';
  end if;

  v_shift_id := public.start_shift(v_employee_id, v_restaurant_id, lat, lng);

  update public.scheduled_shifts
  set
    status = 'started',
    started_shift_id = v_shift_id,
    updated_at = now()
  where id = v_scheduled_id;

  if evidence_path is not null then
    update public.shifts
    set start_evidence_path = evidence_path,
        updated_at = now()
    where id = v_shift_id;
  end if;

  return v_shift_id;
end;
$$;

create or replace function public.end_shift(
  shift_id integer,
  lat double precision,
  lng double precision,
  evidence_path text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.end_shift(shift_id, lat, lng);

  update public.scheduled_shifts
  set
    status = 'completed',
    updated_at = now()
  where started_shift_id = shift_id
    and status in ('scheduled', 'started');

  if evidence_path is not null then
    update public.shifts
    set end_evidence_path = evidence_path,
        updated_at = now()
    where id = shift_id;
  end if;
end;
$$;

-- 11) STORAGE bucket and policies (guarded: can fail if caller is not owner)
do $$
begin
  begin
    insert into storage.buckets (id, name, public)
    values ('evidence', 'evidence', false)
    on conflict (id) do nothing;
  exception when insufficient_privilege then
    raise notice 'Sin permisos para crear bucket evidence desde SQL Editor. Crealo manualmente en Storage > Buckets.';
  end;

  if exists (
    select 1
    from pg_tables
    where schemaname = 'storage'
      and tablename = 'objects'
      and tableowner = current_user
  ) then
    execute 'alter table storage.objects enable row level security';

    if exists (
      select 1 from pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname = 'evidence_select'
    ) then
      execute 'drop policy evidence_select on storage.objects';
    end if;

    if exists (
      select 1 from pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname = 'evidence_insert'
    ) then
      execute 'drop policy evidence_insert on storage.objects';
    end if;

    if exists (
      select 1 from pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname = 'evidence_update'
    ) then
      execute 'drop policy evidence_update on storage.objects';
    end if;

    if exists (
      select 1 from pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname = 'evidence_delete'
    ) then
      execute 'drop policy evidence_delete on storage.objects';
    end if;

    execute 'create policy evidence_select on storage.objects for select to authenticated using (bucket_id = ''evidence'')';
    execute 'create policy evidence_insert on storage.objects for insert to authenticated with check (bucket_id = ''evidence'' and owner_id = auth.uid()::text)';
    execute 'create policy evidence_update on storage.objects for update to authenticated using (bucket_id = ''evidence'' and owner_id = auth.uid()::text) with check (bucket_id = ''evidence'' and owner_id = auth.uid()::text)';
    execute 'create policy evidence_delete on storage.objects for delete to authenticated using (bucket_id = ''evidence'' and owner_id = auth.uid()::text)';
  else
    raise notice 'Sin ownership sobre storage.objects. Configura policies de evidence manualmente en Storage > Policies.';
  end if;
end $$;

-- 12) RLS + POLICIES by role (BPMN aligned)
create or replace function public.current_actor_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select public.app_user_role(auth.uid());
$$;

grant execute on function public.current_actor_role() to authenticated;

alter table public.users enable row level security;
alter table public.restaurants enable row level security;
alter table public.restaurant_employees enable row level security;
alter table public.shifts enable row level security;
alter table public.incidents enable row level security;
alter table public.scheduled_shifts enable row level security;
alter table public.audit_logs enable row level security;
alter table public.supplies enable row level security;
alter table public.supply_deliveries enable row level security;
alter table public.reports enable row level security;

create or replace function public.set_supply_delivery_defaults()
returns trigger
language plpgsql
as $$
begin
  if new.delivered_at is null then
    new.delivered_at := now();
  end if;

  if new.delivered_by is null then
    new.delivered_by := auth.uid();
  end if;

  return new;
end;
$$;

do $$
begin
  if exists (select 1 from pg_trigger where tgname = 'tr_supply_deliveries_defaults') then
    drop trigger tr_supply_deliveries_defaults on public.supply_deliveries;
  end if;

  create trigger tr_supply_deliveries_defaults
  before insert on public.supply_deliveries
  for each row execute function public.set_supply_delivery_defaults();
end $$;

do $$
begin
  -- users
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'users' and policyname = 'users_select_self_or_admin') then
    drop policy users_select_self_or_admin on public.users;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'users' and policyname = 'users_update_admin') then
    drop policy users_update_admin on public.users;
  end if;
  create policy users_select_self_or_admin
  on public.users
  for select
  to authenticated
  using (id = auth.uid() or public.current_actor_role() in ('super_admin', 'supervisora'));

  create policy users_update_admin
  on public.users
  for update
  to authenticated
  using (public.current_actor_role() = 'super_admin')
  with check (public.current_actor_role() = 'super_admin');

  -- restaurants
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'restaurants' and policyname = 'restaurants_select_authenticated') then
    drop policy restaurants_select_authenticated on public.restaurants;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'restaurants' and policyname = 'restaurants_write_super_admin') then
    drop policy restaurants_write_super_admin on public.restaurants;
  end if;
  create policy restaurants_select_authenticated
  on public.restaurants
  for select
  to authenticated
  using (true);

  create policy restaurants_write_super_admin
  on public.restaurants
  for all
  to authenticated
  using (public.current_actor_role() = 'super_admin')
  with check (public.current_actor_role() = 'super_admin');

  -- restaurant_employees
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'restaurant_employees' and policyname = 'restaurant_employees_select_scoped') then
    drop policy restaurant_employees_select_scoped on public.restaurant_employees;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'restaurant_employees' and policyname = 'restaurant_employees_write_admin') then
    drop policy restaurant_employees_write_admin on public.restaurant_employees;
  end if;
  create policy restaurant_employees_select_scoped
  on public.restaurant_employees
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or public.current_actor_role() in ('super_admin', 'supervisora')
  );

  create policy restaurant_employees_write_admin
  on public.restaurant_employees
  for all
  to authenticated
  using (public.current_actor_role() = 'super_admin')
  with check (public.current_actor_role() = 'super_admin');

  -- shifts
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'shifts' and policyname = 'shifts_select_by_role') then
    drop policy shifts_select_by_role on public.shifts;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'shifts' and policyname = 'shifts_update_supervision') then
    drop policy shifts_update_supervision on public.shifts;
  end if;
  create policy shifts_select_by_role
  on public.shifts
  for select
  to authenticated
  using (
    employee_id = auth.uid()
    or public.current_actor_role() in ('super_admin', 'supervisora')
  );

  create policy shifts_update_supervision
  on public.shifts
  for update
  to authenticated
  using (public.current_actor_role() in ('super_admin', 'supervisora'))
  with check (public.current_actor_role() in ('super_admin', 'supervisora'));

  -- incidents
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'incidents' and policyname = 'incidents_select_by_role') then
    drop policy incidents_select_by_role on public.incidents;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'incidents' and policyname = 'incidents_insert_scoped') then
    drop policy incidents_insert_scoped on public.incidents;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'incidents' and policyname = 'incidents_update_supervision') then
    drop policy incidents_update_supervision on public.incidents;
  end if;
  create policy incidents_select_by_role
  on public.incidents
  for select
  to authenticated
  using (
    public.current_actor_role() in ('super_admin', 'supervisora')
    or exists (
      select 1
      from public.shifts s
      where s.id = incidents.shift_id
        and s.employee_id = auth.uid()
    )
  );

  create policy incidents_insert_scoped
  on public.incidents
  for insert
  to authenticated
  with check (
    created_by = auth.uid()
    and (
      public.current_actor_role() in ('super_admin', 'supervisora')
      or exists (
        select 1
        from public.shifts s
        where s.id = incidents.shift_id
          and s.employee_id = auth.uid()
      )
    )
  );

  create policy incidents_update_supervision
  on public.incidents
  for update
  to authenticated
  using (public.current_actor_role() in ('super_admin', 'supervisora'))
  with check (public.current_actor_role() in ('super_admin', 'supervisora'));

  -- scheduled_shifts
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'scheduled_shifts' and policyname = 'scheduled_shifts_select_by_role') then
    drop policy scheduled_shifts_select_by_role on public.scheduled_shifts;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'scheduled_shifts' and policyname = 'scheduled_shifts_write_supervision') then
    drop policy scheduled_shifts_write_supervision on public.scheduled_shifts;
  end if;
  create policy scheduled_shifts_select_by_role
  on public.scheduled_shifts
  for select
  to authenticated
  using (
    employee_id = auth.uid()
    or public.current_actor_role() in ('super_admin', 'supervisora')
  );

  create policy scheduled_shifts_write_supervision
  on public.scheduled_shifts
  for all
  to authenticated
  using (public.current_actor_role() in ('super_admin', 'supervisora'))
  with check (public.current_actor_role() in ('super_admin', 'supervisora'));

  -- audit_logs
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'audit_logs' and policyname = 'audit_logs_select_supervision') then
    drop policy audit_logs_select_supervision on public.audit_logs;
  end if;
  create policy audit_logs_select_supervision
  on public.audit_logs
  for select
  to authenticated
  using (public.current_actor_role() in ('super_admin', 'supervisora'));

  -- supplies
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'supplies' and policyname = 'supplies_select_supervision') then
    drop policy supplies_select_supervision on public.supplies;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'supplies' and policyname = 'supplies_write_supervision') then
    drop policy supplies_write_supervision on public.supplies;
  end if;
  create policy supplies_select_supervision
  on public.supplies
  for select
  to authenticated
  using (public.current_actor_role() in ('super_admin', 'supervisora'));

  create policy supplies_write_supervision
  on public.supplies
  for all
  to authenticated
  using (public.current_actor_role() in ('super_admin', 'supervisora'))
  with check (public.current_actor_role() in ('super_admin', 'supervisora'));

  -- supply_deliveries
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'supply_deliveries' and policyname = 'supply_deliveries_select_supervision') then
    drop policy supply_deliveries_select_supervision on public.supply_deliveries;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'supply_deliveries' and policyname = 'supply_deliveries_insert_supervision') then
    drop policy supply_deliveries_insert_supervision on public.supply_deliveries;
  end if;
  create policy supply_deliveries_select_supervision
  on public.supply_deliveries
  for select
  to authenticated
  using (public.current_actor_role() in ('super_admin', 'supervisora'));

  create policy supply_deliveries_insert_supervision
  on public.supply_deliveries
  for insert
  to authenticated
  with check (
    delivered_by = auth.uid()
    and public.current_actor_role() in ('super_admin', 'supervisora')
  );

  -- reports
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reports' and policyname = 'reports_select_supervision') then
    drop policy reports_select_supervision on public.reports;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reports' and policyname = 'reports_write_super_admin') then
    drop policy reports_write_super_admin on public.reports;
  end if;
  create policy reports_select_supervision
  on public.reports
  for select
  to authenticated
  using (public.current_actor_role() in ('super_admin', 'supervisora'));

  create policy reports_write_super_admin
  on public.reports
  for all
  to authenticated
  using (public.current_actor_role() = 'super_admin')
  with check (public.current_actor_role() = 'super_admin');
end $$;

commit;
