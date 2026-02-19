-- HARDENING PRODUCCION (PostgreSQL/Supabase)
-- Basado en esquema actual + compatibility_supabase.sql
-- Fecha: 2026-02-19
-- Idempotente y orientado a no romper datos existentes

begin;

-- =========================================================
-- 0) EXTENSIONES NECESARIAS
-- =========================================================
create extension if not exists btree_gist;
create extension if not exists cube;
create extension if not exists earthdistance;

-- =========================================================
-- 1) FUNCIONES DE ROL Y ALCANCE (SIN auth.role())
-- =========================================================
create or replace function public.actor_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select r.name::text
  from public.users u
  join public.roles r on r.id = u.role_id
  where u.id = auth.uid()
  limit 1;
$$;

grant execute on function public.actor_role() to authenticated;

create or replace function public.can_supervise_restaurant(p_restaurant_id integer)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.restaurant_employees re
    where re.restaurant_id = p_restaurant_id
      and re.user_id = auth.uid()
  );
$$;

grant execute on function public.can_supervise_restaurant(integer) to authenticated;

-- =========================================================
-- 2) AUDITORIA INMUTABLE (append-only)
-- =========================================================
alter table public.audit_logs
  add column if not exists actor_user_id uuid;

update public.audit_logs
set actor_user_id = coalesce(actor_user_id, actor_id, user_id)
where actor_user_id is null;

create or replace function public.audit_logs_enforce_insert_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'audit_logs es inmutable (append-only)';
  end if;
  return new;
end;
$$;

create or replace function public.audit_logs_set_actor_from_auth()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  new.actor_user_id := auth.uid();
  new.actor_id := auth.uid();
  new.user_id := auth.uid();

  return new;
end;
$$;

do $$
begin
  if exists (select 1 from pg_trigger where tgname = 'tr_audit_logs_set_actor') then
    drop trigger tr_audit_logs_set_actor on public.audit_logs;
  end if;

  create trigger tr_audit_logs_set_actor
  before insert on public.audit_logs
  for each row execute function public.audit_logs_set_actor_from_auth();

  if exists (select 1 from pg_trigger where tgname = 'tr_audit_logs_block_mutation') then
    drop trigger tr_audit_logs_block_mutation on public.audit_logs;
  end if;

  create trigger tr_audit_logs_block_mutation
  before update or delete on public.audit_logs
  for each row execute function public.audit_logs_enforce_insert_only();
end $$;

revoke update, delete on public.audit_logs from anon, authenticated;

-- =========================================================
-- 3) ENUMS REALES PARA ESTADOS CRITICOS
-- =========================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'incident_status') then
    create type public.incident_status as enum ('open', 'resolved', 'dismissed');
  end if;

  if not exists (select 1 from pg_type where typname = 'delivery_status') then
    create type public.delivery_status as enum ('registered', 'delivered', 'cancelled');
  end if;
end $$;

alter table public.incidents
  add column if not exists status public.incident_status;

update public.incidents
set status = coalesce(status, 'open'::public.incident_status)
where status is null;

alter table public.incidents
  alter column status set default 'open'::public.incident_status;

alter table public.incidents
  alter column status set not null;

alter table public.supply_deliveries
  add column if not exists status public.delivery_status;

update public.supply_deliveries
set status = coalesce(status, 'registered'::public.delivery_status)
where status is null;

alter table public.supply_deliveries
  alter column status set default 'registered'::public.delivery_status;

alter table public.supply_deliveries
  alter column status set not null;

-- =========================================================
-- 4) ANTIFRAUDE TURNOS + VALIDACIONES GEO/TIEMPO
-- =========================================================
create unique index if not exists uq_shifts_employee_active
on public.shifts (employee_id)
where state = 'activo' and end_time is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'shifts_start_lat_check'
      and conrelid = 'public.shifts'::regclass
  ) then
    alter table public.shifts
      add constraint shifts_start_lat_check
      check (start_lat is null or start_lat between -90 and 90);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'shifts_start_lng_check'
      and conrelid = 'public.shifts'::regclass
  ) then
    alter table public.shifts
      add constraint shifts_start_lng_check
      check (start_lng is null or start_lng between -180 and 180);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'shifts_end_lat_check'
      and conrelid = 'public.shifts'::regclass
  ) then
    alter table public.shifts
      add constraint shifts_end_lat_check
      check (end_lat is null or end_lat between -90 and 90);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'shifts_end_lng_check'
      and conrelid = 'public.shifts'::regclass
  ) then
    alter table public.shifts
      add constraint shifts_end_lng_check
      check (end_lng is null or end_lng between -180 and 180);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'shifts_time_consistency_check'
      and conrelid = 'public.shifts'::regclass
  ) then
    alter table public.shifts
      add constraint shifts_time_consistency_check
      check (end_time is null or end_time >= start_time);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'supply_deliveries_quantity_positive_check'
      and conrelid = 'public.supply_deliveries'::regclass
  ) then
    alter table public.supply_deliveries
      add constraint supply_deliveries_quantity_positive_check
      check (quantity > 0);
  end if;
end $$;

-- =========================================================
-- 5) EVIDENCIA INMUTABLE (METADATOS OBLIGATORIOS)
-- =========================================================
alter table public.shifts
  add column if not exists start_evidence_hash text,
  add column if not exists start_evidence_mime_type text,
  add column if not exists start_evidence_size_bytes bigint,
  add column if not exists start_evidence_created_at timestamptz,
  add column if not exists start_evidence_uploaded_by uuid references public.users(id) on delete set null,
  add column if not exists end_evidence_hash text,
  add column if not exists end_evidence_mime_type text,
  add column if not exists end_evidence_size_bytes bigint,
  add column if not exists end_evidence_created_at timestamptz,
  add column if not exists end_evidence_uploaded_by uuid references public.users(id) on delete set null;

create or replace function public.shifts_guard_evidence_immutability()
returns trigger
language plpgsql
as $$
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  if old.start_evidence_path is not null and new.start_evidence_path is distinct from old.start_evidence_path then
    raise exception 'Evidencia de inicio inmutable';
  end if;

  if old.end_evidence_path is not null and new.end_evidence_path is distinct from old.end_evidence_path then
    raise exception 'Evidencia de fin inmutable';
  end if;

  if old.start_evidence_hash is not null and new.start_evidence_hash is distinct from old.start_evidence_hash then
    raise exception 'Hash de evidencia de inicio inmutable';
  end if;

  if old.end_evidence_hash is not null and new.end_evidence_hash is distinct from old.end_evidence_hash then
    raise exception 'Hash de evidencia de fin inmutable';
  end if;

  if new.start_evidence_path is not null then
    if new.start_evidence_hash is null
       or new.start_evidence_mime_type is null
       or new.start_evidence_size_bytes is null
       or new.start_evidence_created_at is null
       or new.start_evidence_uploaded_by is null then
      raise exception 'Metadatos obligatorios faltantes para evidencia de inicio';
    end if;
  end if;

  if new.end_evidence_path is not null then
    if new.end_evidence_hash is null
       or new.end_evidence_mime_type is null
       or new.end_evidence_size_bytes is null
       or new.end_evidence_created_at is null
       or new.end_evidence_uploaded_by is null then
      raise exception 'Metadatos obligatorios faltantes para evidencia de fin';
    end if;
  end if;

  return new;
end;
$$;

do $$
begin
  if exists (select 1 from pg_trigger where tgname = 'tr_shifts_guard_evidence_immutability') then
    drop trigger tr_shifts_guard_evidence_immutability on public.shifts;
  end if;

  create trigger tr_shifts_guard_evidence_immutability
  before update on public.shifts
  for each row execute function public.shifts_guard_evidence_immutability();
end $$;

-- =========================================================
-- 6) RATE LIMIT PERSISTENTE EN BD
-- =========================================================
create table if not exists public.security_rate_limit_events (
  id bigserial primary key,
  action text not null,
  actor_id uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_rate_limit_action_actor_created_at
  on public.security_rate_limit_events (action, actor_id, created_at desc);

create or replace function public.enforce_rate_limit(
  p_action text,
  p_max_attempts integer,
  p_window interval,
  p_actor_id uuid default auth.uid()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_actor_id is null then
    raise exception 'No autenticado';
  end if;

  insert into public.security_rate_limit_events (action, actor_id)
  values (p_action, p_actor_id);

  select count(*)
    into v_count
  from public.security_rate_limit_events e
  where e.action = p_action
    and e.actor_id = p_actor_id
    and e.created_at >= now() - p_window;

  if v_count > p_max_attempts then
    raise exception 'Rate limit excedido para accion %', p_action;
  end if;

  delete from public.security_rate_limit_events
  where created_at < now() - interval '7 days';
end;
$$;

grant execute on function public.enforce_rate_limit(text, integer, interval, uuid) to authenticated;

-- =========================================================
-- 7) REPORTES VERIFICABLES
-- =========================================================
alter table public.reports
  add column if not exists hash_documento text,
  add column if not exists generado_por uuid references public.users(id) on delete set null,
  add column if not exists generated_at timestamptz,
  add column if not exists filtros_json jsonb,
  add column if not exists file_path text;

update public.reports
set generated_at = coalesce(generated_at, now())
where generated_at is null;

-- =========================================================
-- 8) CUMPLIMIENTO LEGAL (CONSENTIMIENTO + SALUD)
-- =========================================================
create table if not exists public.legal_terms_versions (
  id bigserial primary key,
  code text not null unique,
  title text not null,
  content text not null,
  version text not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid null references public.users(id) on delete set null
);

create table if not exists public.user_legal_acceptances (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  legal_terms_id bigint not null references public.legal_terms_versions(id) on delete restrict,
  accepted_at timestamptz not null default now(),
  ip_address inet null,
  user_agent text null,
  unique (user_id, legal_terms_id)
);

create table if not exists public.shift_health_forms (
  id bigserial primary key,
  shift_id integer not null references public.shifts(id) on delete cascade,
  phase text not null check (phase in ('start', 'end')),
  fit_for_work boolean not null,
  declaration text null,
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null references public.users(id) on delete restrict,
  unique (shift_id, phase)
);

-- =========================================================
-- 9) ENDURECIMIENTO RPC (OWNERSHIP + ANTIFRAUDE)
-- =========================================================

-- Bloquea invocacion directa de funciones internas sensibles
revoke execute on function public.start_shift(uuid, integer, double precision, double precision) from anon, authenticated;
revoke execute on function public.end_shift(integer, double precision, double precision) from anon, authenticated;

create or replace function public.start_shift(
  lat double precision,
  lng double precision,
  evidence_path text default null,
  evidence_hash text default null,
  evidence_mime_type text default null,
  evidence_size_bytes bigint default null
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
  v_role text;
  v_server_evidence_path text;
begin
  v_employee_id := auth.uid();
  if v_employee_id is null then
    raise exception 'No autenticado';
  end if;

  perform public.enforce_rate_limit('start_shift', 6, interval '15 minutes', v_employee_id);

  if lat is null or lng is null or not isfinite(lat) or not isfinite(lng)
     or lat < -90 or lat > 90 or lng < -180 or lng > 180 then
    raise exception 'Coordenadas invalidas';
  end if;

  v_role := public.actor_role();
  if v_role not in ('empleado', 'supervisora', 'super_admin') then
    raise exception 'Rol no autorizado para iniciar turno';
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

  -- Core geofence + unicidad turno activo
  insert into public.shifts (employee_id, restaurant_id, start_time, start_lat, start_lng, state, status)
  select v_employee_id, v_restaurant_id, now(), lat, lng, 'activo', 'active'
  from public.restaurants r
  where r.id = v_restaurant_id
    and earth_distance(ll_to_earth(r.lat, r.lng), ll_to_earth(lat, lng)) <= r.radius
  returning id into v_shift_id;

  update public.scheduled_shifts
  set status = 'started', started_shift_id = v_shift_id, updated_at = now()
  where id = v_scheduled_id;

  -- ruta generada por backend (se ignora ruta cliente)
  v_server_evidence_path := format(
    'secure/%s/shifts/%s/start_%s.jpg',
    v_employee_id,
    v_shift_id,
    to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISSMS')
  );

  if evidence_hash is null or evidence_mime_type is null or evidence_size_bytes is null then
    raise exception 'Metadatos de evidencia obligatorios (hash/mime/size)';
  end if;

  update public.shifts
  set
    start_evidence_path = v_server_evidence_path,
    start_evidence_hash = evidence_hash,
    start_evidence_mime_type = evidence_mime_type,
    start_evidence_size_bytes = evidence_size_bytes,
    start_evidence_created_at = now(),
    start_evidence_uploaded_by = v_employee_id,
    updated_at = now()
  where id = v_shift_id;

  return v_shift_id;
end;
$$;

create or replace function public.end_shift(
  shift_id integer,
  lat double precision,
  lng double precision,
  evidence_path text default null,
  evidence_hash text default null,
  evidence_mime_type text default null,
  evidence_size_bytes bigint default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_actor_role text;
  v_employee_id uuid;
  v_restaurant_id integer;
  v_rest_lat double precision;
  v_rest_lng double precision;
  v_rest_radius integer;
  v_server_evidence_path text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'No autenticado';
  end if;

  perform public.enforce_rate_limit('end_shift', 8, interval '15 minutes', v_actor_id);

  if lat is null or lng is null or not isfinite(lat) or not isfinite(lng)
     or lat < -90 or lat > 90 or lng < -180 or lng > 180 then
    raise exception 'Coordenadas invalidas';
  end if;

  select s.employee_id, s.restaurant_id
    into v_employee_id, v_restaurant_id
  from public.shifts s
  where s.id = shift_id
    and s.end_time is null;

  if v_employee_id is null then
    raise exception 'Turno invalido o ya finalizado';
  end if;

  v_actor_role := public.actor_role();

  if v_actor_role = 'empleado' and v_employee_id <> v_actor_id then
    raise exception 'No autorizado para cerrar turno ajeno';
  end if;

  if v_actor_role = 'supervisora' and not public.can_supervise_restaurant(v_restaurant_id) then
    raise exception 'Supervisora no asignada a restaurante del turno';
  end if;

  if v_actor_role not in ('empleado', 'supervisora', 'super_admin') then
    raise exception 'Rol no autorizado';
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
  where id = shift_id
    and end_time is null;

  if not found then
    raise exception 'Turno invalido o ya finalizado';
  end if;

  update public.scheduled_shifts
  set status = 'completed', updated_at = now()
  where started_shift_id = shift_id
    and status in ('scheduled', 'started');

  v_server_evidence_path := format(
    'secure/%s/shifts/%s/end_%s.jpg',
    v_employee_id,
    shift_id,
    to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISSMS')
  );

  if evidence_hash is null or evidence_mime_type is null or evidence_size_bytes is null then
    raise exception 'Metadatos de evidencia obligatorios (hash/mime/size)';
  end if;

  update public.shifts
  set
    end_evidence_path = v_server_evidence_path,
    end_evidence_hash = evidence_hash,
    end_evidence_mime_type = evidence_mime_type,
    end_evidence_size_bytes = evidence_size_bytes,
    end_evidence_created_at = now(),
    end_evidence_uploaded_by = v_actor_id,
    updated_at = now()
  where id = shift_id;
end;
$$;

grant execute on function public.start_shift(double precision, double precision, text, text, text, bigint) to authenticated;
grant execute on function public.end_shift(integer, double precision, double precision, text, text, text, bigint) to authenticated;

-- =========================================================
-- 10) POLICIES RLS REFORZADAS (TABLAS CRITICAS)
-- =========================================================
alter table public.shifts enable row level security;
alter table public.incidents enable row level security;
alter table public.scheduled_shifts enable row level security;
alter table public.supplies enable row level security;
alter table public.reports enable row level security;
alter table public.audit_logs enable row level security;

-- SHIFTS

do $$
begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='shifts' and policyname='shifts_select_hardened') then
    drop policy shifts_select_hardened on public.shifts;
  end if;

  if exists (select 1 from pg_policies where schemaname='public' and tablename='shifts' and policyname='shifts_update_hardened') then
    drop policy shifts_update_hardened on public.shifts;
  end if;

  create policy shifts_select_hardened
  on public.shifts
  for select
  to authenticated
  using (
    employee_id = auth.uid()
    or public.actor_role() = 'super_admin'
    or (public.actor_role() = 'supervisora' and public.can_supervise_restaurant(restaurant_id))
  );

  create policy shifts_update_hardened
  on public.shifts
  for update
  to authenticated
  using (
    public.actor_role() = 'super_admin'
    or (public.actor_role() = 'supervisora' and public.can_supervise_restaurant(restaurant_id))
  )
  with check (
    public.actor_role() = 'super_admin'
    or (public.actor_role() = 'supervisora' and public.can_supervise_restaurant(restaurant_id))
  );
end $$;

-- INCIDENTS

do $$
begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='incidents' and policyname='incidents_select_hardened') then
    drop policy incidents_select_hardened on public.incidents;
  end if;

  if exists (select 1 from pg_policies where schemaname='public' and tablename='incidents' and policyname='incidents_insert_hardened') then
    drop policy incidents_insert_hardened on public.incidents;
  end if;

  create policy incidents_select_hardened
  on public.incidents
  for select
  to authenticated
  using (
    public.actor_role() = 'super_admin'
    or exists (
      select 1
      from public.shifts s
      where s.id = incidents.shift_id
        and (
          s.employee_id = auth.uid()
          or (public.actor_role() = 'supervisora' and public.can_supervise_restaurant(s.restaurant_id))
        )
    )
  );

  create policy incidents_insert_hardened
  on public.incidents
  for insert
  to authenticated
  with check (
    created_by = auth.uid()
    and (
      public.actor_role() = 'super_admin'
      or exists (
        select 1
        from public.shifts s
        where s.id = incidents.shift_id
          and (
            s.employee_id = auth.uid()
            or (public.actor_role() = 'supervisora' and public.can_supervise_restaurant(s.restaurant_id))
          )
      )
    )
  );
end $$;

-- SCHEDULED SHIFTS

do $$
begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='scheduled_shifts' and policyname='scheduled_shifts_select_hardened') then
    drop policy scheduled_shifts_select_hardened on public.scheduled_shifts;
  end if;

  if exists (select 1 from pg_policies where schemaname='public' and tablename='scheduled_shifts' and policyname='scheduled_shifts_write_hardened') then
    drop policy scheduled_shifts_write_hardened on public.scheduled_shifts;
  end if;

  create policy scheduled_shifts_select_hardened
  on public.scheduled_shifts
  for select
  to authenticated
  using (
    employee_id = auth.uid()
    or public.actor_role() = 'super_admin'
    or (public.actor_role() = 'supervisora' and public.can_supervise_restaurant(restaurant_id))
  );

  create policy scheduled_shifts_write_hardened
  on public.scheduled_shifts
  for all
  to authenticated
  using (
    public.actor_role() = 'super_admin'
    or (public.actor_role() = 'supervisora' and public.can_supervise_restaurant(restaurant_id))
  )
  with check (
    public.actor_role() = 'super_admin'
    or (public.actor_role() = 'supervisora' and public.can_supervise_restaurant(restaurant_id))
  );
end $$;

-- SUPPLIES

do $$
begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='supplies' and policyname='supplies_select_hardened') then
    drop policy supplies_select_hardened on public.supplies;
  end if;

  if exists (select 1 from pg_policies where schemaname='public' and tablename='supplies' and policyname='supplies_write_hardened') then
    drop policy supplies_write_hardened on public.supplies;
  end if;

  create policy supplies_select_hardened
  on public.supplies
  for select
  to authenticated
  using (
    public.actor_role() = 'super_admin'
    or (
      public.actor_role() = 'supervisora'
      and restaurant_id is not null
      and public.can_supervise_restaurant(restaurant_id)
    )
  );

  create policy supplies_write_hardened
  on public.supplies
  for all
  to authenticated
  using (
    public.actor_role() = 'super_admin'
    or (
      public.actor_role() = 'supervisora'
      and restaurant_id is not null
      and public.can_supervise_restaurant(restaurant_id)
    )
  )
  with check (
    public.actor_role() = 'super_admin'
    or (
      public.actor_role() = 'supervisora'
      and restaurant_id is not null
      and public.can_supervise_restaurant(restaurant_id)
    )
  );
end $$;

-- REPORTS

do $$
begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='reports' and policyname='reports_select_hardened') then
    drop policy reports_select_hardened on public.reports;
  end if;

  if exists (select 1 from pg_policies where schemaname='public' and tablename='reports' and policyname='reports_write_hardened') then
    drop policy reports_write_hardened on public.reports;
  end if;

  create policy reports_select_hardened
  on public.reports
  for select
  to authenticated
  using (public.actor_role() in ('super_admin', 'supervisora'));

  create policy reports_write_hardened
  on public.reports
  for all
  to authenticated
  using (public.actor_role() = 'super_admin')
  with check (public.actor_role() = 'super_admin');
end $$;

-- AUDIT LOGS (sin SELECT publico)

do $$
begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='audit_logs' and policyname='audit_logs_select_hardened') then
    drop policy audit_logs_select_hardened on public.audit_logs;
  end if;

  if exists (select 1 from pg_policies where schemaname='public' and tablename='audit_logs' and policyname='audit_logs_insert_hardened') then
    drop policy audit_logs_insert_hardened on public.audit_logs;
  end if;

  create policy audit_logs_select_hardened
  on public.audit_logs
  for select
  to authenticated
  using (public.actor_role() in ('super_admin', 'supervisora'));

  create policy audit_logs_insert_hardened
  on public.audit_logs
  for insert
  to authenticated
  with check (actor_user_id = auth.uid());
end $$;

-- =========================================================
-- 11) NORMALIZACION CONTROLADA (sin romper compatibilidad)
-- =========================================================
-- Mantener state como fuente canónica y status como espejo de compatibilidad.
create or replace function public.sync_shift_state_status_hardened()
returns trigger
language plpgsql
as $$
begin
  -- state es canonico; status siempre derivado
  if new.state is not null then
    new.status := case new.state::text
      when 'activo' then 'active'
      when 'finalizado' then 'completed'
      when 'aprobado' then 'approved'
      when 'rechazado' then 'rejected'
      else new.state::text
    end;
  elsif new.status is not null then
    -- compatibilidad legado
    new.state := case lower(new.status)
      when 'active' then 'activo'::public.shift_state
      when 'completed' then 'finalizado'::public.shift_state
      when 'approved' then 'aprobado'::public.shift_state
      when 'rejected' then 'rechazado'::public.shift_state
      else 'activo'::public.shift_state
    end;
    new.status := case new.state::text
      when 'activo' then 'active'
      when 'finalizado' then 'completed'
      when 'aprobado' then 'approved'
      when 'rechazado' then 'rejected'
      else new.state::text
    end;
  end if;

  return new;
end;
$$;

do $$
begin
  if exists (select 1 from pg_trigger where tgname = 'tr_sync_shift_state_status') then
    drop trigger tr_sync_shift_state_status on public.shifts;
  end if;

  create trigger tr_sync_shift_state_status
  before insert or update on public.shifts
  for each row execute function public.sync_shift_state_status_hardened();
end $$;

commit;

