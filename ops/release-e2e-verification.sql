-- release-e2e-verification.sql
-- SQL pack para verificar resultados despues de pruebas A-I.

-- 1) Restaurante activo/inactivo
select id, name, is_active
from public.restaurants
order by id;

-- 2) Usuarios y rol efectivo
select u.id, u.email, r.name as role, u.is_active, u.updated_at
from public.users u
left join public.roles r on r.id = u.role_id
order by u.updated_at desc nulls last;

-- 3) Turnos programados recientes
select
  s.id,
  s.employee_id,
  e.email as employee_email,
  s.restaurant_id,
  r.name as restaurant_name,
  s.scheduled_start,
  s.scheduled_end,
  s.status,
  s.started_shift_id,
  s.created_by,
  s.updated_at
from public.scheduled_shifts s
left join public.users e on e.id = s.employee_id
left join public.restaurants r on r.id = s.restaurant_id
order by s.id desc
limit 100;

-- 4) Solapes activos (debe ser 0)
select
  s1.employee_id,
  s1.id as shift_a,
  s2.id as shift_b,
  s1.scheduled_start as a_start,
  s1.scheduled_end as a_end,
  s2.scheduled_start as b_start,
  s2.scheduled_end as b_end
from public.scheduled_shifts s1
join public.scheduled_shifts s2
  on s1.employee_id = s2.employee_id
 and s1.id < s2.id
 and s1.status in ('scheduled','started')
 and s2.status in ('scheduled','started')
 and tstzrange(s1.scheduled_start, s1.scheduled_end, '[)') && tstzrange(s2.scheduled_start, s2.scheduled_end, '[)');

-- 5) Turnos operativos recientes
select
  sh.id,
  sh.employee_id,
  u.email as employee_email,
  sh.restaurant_id,
  r.name as restaurant_name,
  sh.start_time,
  sh.end_time,
  sh.state,
  sh.start_lat,
  sh.start_lng,
  sh.end_lat,
  sh.end_lng,
  sh.updated_at
from public.shifts sh
left join public.users u on u.id = sh.employee_id
left join public.restaurants r on r.id = sh.restaurant_id
order by sh.id desc
limit 100;

-- 6) Integridad: maximo 1 turno activo por empleado (debe ser 0 filas)
select employee_id, count(*) as active_count
from public.shifts
where state = 'activo' and end_time is null
group by employee_id
having count(*) > 1;

-- 7) Relacion agenda -> turno iniciado/finalizado
select
  s.id as scheduled_id,
  s.status as scheduled_status,
  s.started_shift_id,
  sh.state as operational_state,
  sh.start_time,
  sh.end_time
from public.scheduled_shifts s
left join public.shifts sh on sh.id = s.started_shift_id
order by s.id desc
limit 100;

-- 8) Formularios de salud inicio/fin
select
  f.shift_id,
  f.phase,
  f.fit_for_work,
  f.recorded_by,
  f.recorded_at
from public.shift_health_forms f
order by f.recorded_at desc
limit 100;

-- 9) Auditoria de acciones clave
select
  id,
  action,
  user_id,
  actor_user_id,
  created_at,
  context
from public.audit_logs
where action in ('SHIFT_START', 'SHIFT_END', 'start_shift', 'end_shift')
order by created_at desc
limit 100;

-- 10) Release readiness: supplies unit_cost
select count(*) as invalid_unit_cost_rows
from public.supplies
where unit_cost is null or unit_cost < 0;
