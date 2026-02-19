-- 02_cleanup.sql
-- FASE 2: LIMPIEZA SEGURA (SIN BORRADO DE DATOS CRITICOS)

begin;

-- 1) Normalizar shifts.status segun state
update public.shifts
set status = case state::text
  when 'activo' then 'active'
  when 'finalizado' then 'completed'
  when 'aprobado' then 'approved'
  when 'rechazado' then 'rejected'
  else coalesce(status, 'active')
end
where status is null
   or lower(status) not in ('active','completed','approved','rejected');

-- 2) Normalizar scheduled_shifts.status invalido
update public.scheduled_shifts
set status = 'scheduled'
where status is null
   or status not in ('scheduled','started','completed','cancelled');

-- 3) Reparar started_shift_id huerfano
update public.scheduled_shifts ss
set started_shift_id = null,
    status = case when ss.status = 'started' then 'scheduled' else ss.status end,
    updated_at = now()
where ss.started_shift_id is not null
  and not exists (
    select 1 from public.shifts s where s.id = ss.started_shift_id
  );

-- 4) Reparar supplies.restaurant_id huerfano
update public.supplies sp
set restaurant_id = null
where sp.restaurant_id is not null
  and not exists (
    select 1 from public.restaurants r where r.id = sp.restaurant_id
  );

-- 5) quantity invalida en deliveries -> minimo operativo 1
update public.supply_deliveries
set quantity = 1
where quantity is null or quantity <= 0;

-- 6) Coordenadas fuera de rango en shifts -> null seguro
update public.shifts
set start_lat = null
where start_lat is not null and (start_lat < -90 or start_lat > 90);

update public.shifts
set start_lng = null
where start_lng is not null and (start_lng < -180 or start_lng > 180);

update public.shifts
set end_lat = null
where end_lat is not null and (end_lat < -90 or end_lat > 90);

update public.shifts
set end_lng = null
where end_lng is not null and (end_lng < -180 or end_lng > 180);

-- 7) end_time inconsistente -> ajustar a start_time
update public.shifts
set end_time = start_time
where end_time is not null and end_time < start_time;

-- 8) Duplicados turno activo por empleado
--    Se conserva el mas reciente, los demas se cierran como completed.
with ranked as (
  select
    id,
    employee_id,
    row_number() over (partition by employee_id order by start_time desc, id desc) as rn
  from public.shifts
  where state = 'activo' and end_time is null
)
update public.shifts s
set
  end_time = now(),
  state = 'finalizado',
  status = 'completed',
  updated_at = now()
from ranked r
where s.id = r.id
  and r.rn > 1;

-- 9) incidents huerfanos -> preservar en tabla de cuarentena y no perder evidencia
create table if not exists public.incidents_orphan_backup (
  id bigint primary key,
  shift_id integer,
  description text,
  created_at timestamptz,
  created_by uuid,
  backed_up_at timestamptz not null default now()
);

insert into public.incidents_orphan_backup (id, shift_id, description, created_at, created_by)
select i.id, i.shift_id, i.description, i.created_at, i.created_by
from public.incidents i
left join public.shifts s on s.id = i.shift_id
where s.id is null
on conflict (id) do nothing;

commit;
