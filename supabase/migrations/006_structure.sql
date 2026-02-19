-- 03_structure.sql
-- FASE 3: ESTRUCTURA (CONSTRAINTS, INDICES, ENUMS, COLUMNAS ANTIFRAUDE)

begin;

create extension if not exists btree_gist;
create extension if not exists cube;
create extension if not exists earthdistance;

-- 1) ENUMS

do $$
begin
  if not exists (select 1 from pg_type where typname = 'incident_status') then
    create type public.incident_status as enum ('open','resolved','dismissed');
  end if;

  if not exists (select 1 from pg_type where typname = 'delivery_status') then
    create type public.delivery_status as enum ('registered','delivered','cancelled');
  end if;
end $$;

-- 2) COLUMNAS DE ESTADO TIPADAS (sin romper columnas existentes)
alter table public.incidents
  add column if not exists status_v2 public.incident_status;

update public.incidents
set status_v2 = coalesce(status_v2, 'open'::public.incident_status)
where status_v2 is null;

alter table public.incidents
  alter column status_v2 set default 'open'::public.incident_status;

alter table public.supply_deliveries
  add column if not exists status_v2 public.delivery_status;

update public.supply_deliveries
set status_v2 = coalesce(status_v2, 'registered'::public.delivery_status)
where status_v2 is null;

alter table public.supply_deliveries
  alter column status_v2 set default 'registered'::public.delivery_status;

-- 3) EVIDENCIA ANTIFRAUDE
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

-- 4) REPORTES VERIFICABLES
alter table public.reports
  add column if not exists hash_documento text,
  add column if not exists generado_por uuid references public.users(id) on delete set null,
  add column if not exists generated_at timestamptz,
  add column if not exists filtros_json jsonb,
  add column if not exists file_path text;

update public.reports
set generated_at = coalesce(generated_at, now())
where generated_at is null;

-- 5) CHECKS

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'shifts_start_lat_check' and conrelid = 'public.shifts'::regclass
  ) then
    alter table public.shifts
      add constraint shifts_start_lat_check
      check (start_lat is null or start_lat between -90 and 90);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'shifts_start_lng_check' and conrelid = 'public.shifts'::regclass
  ) then
    alter table public.shifts
      add constraint shifts_start_lng_check
      check (start_lng is null or start_lng between -180 and 180);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'shifts_end_lat_check' and conrelid = 'public.shifts'::regclass
  ) then
    alter table public.shifts
      add constraint shifts_end_lat_check
      check (end_lat is null or end_lat between -90 and 90);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'shifts_end_lng_check' and conrelid = 'public.shifts'::regclass
  ) then
    alter table public.shifts
      add constraint shifts_end_lng_check
      check (end_lng is null or end_lng between -180 and 180);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'shifts_time_consistency_check' and conrelid = 'public.shifts'::regclass
  ) then
    alter table public.shifts
      add constraint shifts_time_consistency_check
      check (end_time is null or end_time >= start_time);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'supply_deliveries_quantity_positive_check' and conrelid = 'public.supply_deliveries'::regclass
  ) then
    alter table public.supply_deliveries
      add constraint supply_deliveries_quantity_positive_check
      check (quantity > 0);
  end if;
end $$;

-- 6) INDICES
create index if not exists idx_shifts_employee_state_endtime
  on public.shifts (employee_id, state, end_time);

create index if not exists idx_shifts_restaurant_start_time
  on public.shifts (restaurant_id, start_time desc);

create index if not exists idx_incidents_shift_created_at
  on public.incidents (shift_id, created_at desc);

create index if not exists idx_supply_deliveries_restaurant_delivered_at
  on public.supply_deliveries (restaurant_id, delivered_at desc);

-- 7) UNIQUE PARCIAL ANTIFRAUDE (solo si no hay duplicados)
do $$
begin
  if exists (
    select 1
    from public.shifts
    where state = 'activo' and end_time is null
    group by employee_id
    having count(*) > 1
  ) then
    raise notice 'No se crea uq_shifts_employee_active: existen duplicados activos';
  else
    if not exists (
      select 1 from pg_indexes
      where schemaname = 'public'
        and tablename = 'shifts'
        and indexname = 'uq_shifts_employee_active'
    ) then
      execute 'create unique index uq_shifts_employee_active on public.shifts (employee_id) where state = ''activo'' and end_time is null';
    end if;
  end if;
end $$;

commit;
