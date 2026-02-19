-- 01_precheck.sql
-- FASE 1: SOLO DIAGNOSTICO (NO MODIFICA DATOS)

begin;

do $$
declare
  v_count bigint;
begin
  -- 1) Duplicados turno activo por empleado
  select count(*) into v_count
  from (
    select employee_id
    from public.shifts
    where state = 'activo' and end_time is null
    group by employee_id
    having count(*) > 1
  ) t;
  raise notice '[PRECHECK] Duplicados turno activo por empleado: %', v_count;

  -- 2) Coordenadas fuera de rango en shifts
  select count(*) into v_count
  from public.shifts
  where (start_lat is not null and (start_lat < -90 or start_lat > 90))
     or (start_lng is not null and (start_lng < -180 or start_lng > 180))
     or (end_lat is not null and (end_lat < -90 or end_lat > 90))
     or (end_lng is not null and (end_lng < -180 or end_lng > 180));
  raise notice '[PRECHECK] Coordenadas invalidas en shifts: %', v_count;

  -- 3) Tiempos inconsistentes en shifts
  select count(*) into v_count
  from public.shifts
  where end_time is not null and end_time < start_time;
  raise notice '[PRECHECK] Shifts con end_time < start_time: %', v_count;

  -- 4) scheduled_shifts con rango invalido
  select count(*) into v_count
  from public.scheduled_shifts
  where scheduled_end <= scheduled_start;
  raise notice '[PRECHECK] scheduled_shifts con rango invalido: %', v_count;

  -- 5) status invalido en scheduled_shifts
  select count(*) into v_count
  from public.scheduled_shifts
  where status not in ('scheduled','started','completed','cancelled');
  raise notice '[PRECHECK] scheduled_shifts con status invalido: %', v_count;

  -- 6) Incidents huerfanos (sin shift)
  select count(*) into v_count
  from public.incidents i
  left join public.shifts s on s.id = i.shift_id
  where s.id is null;
  raise notice '[PRECHECK] incidents huerfanos: %', v_count;

  -- 7) scheduled_shifts.started_shift_id huerfano
  select count(*) into v_count
  from public.scheduled_shifts ss
  left join public.shifts s on s.id = ss.started_shift_id
  where ss.started_shift_id is not null and s.id is null;
  raise notice '[PRECHECK] scheduled_shifts.started_shift_id huerfano: %', v_count;

  -- 8) restaurant_employees huerfanos
  select count(*) into v_count
  from public.restaurant_employees re
  left join public.restaurants r on r.id = re.restaurant_id
  left join public.users u on u.id = re.user_id
  where r.id is null or u.id is null;
  raise notice '[PRECHECK] restaurant_employees huerfanos: %', v_count;

  -- 9) supplies con restaurant_id huerfano
  select count(*) into v_count
  from public.supplies sp
  left join public.restaurants r on r.id = sp.restaurant_id
  where sp.restaurant_id is not null and r.id is null;
  raise notice '[PRECHECK] supplies.restaurant_id huerfano: %', v_count;

  -- 10) quantity invalida en supply_deliveries
  select count(*) into v_count
  from public.supply_deliveries
  where quantity is null or quantity <= 0;
  raise notice '[PRECHECK] supply_deliveries quantity <= 0 o null: %', v_count;

  -- 11) restaurants coordenadas/radio invalidos
  select count(*) into v_count
  from public.restaurants
  where lat is null or lng is null or radius is null
     or lat < -90 or lat > 90
     or lng < -180 or lng > 180
     or radius <= 0;
  raise notice '[PRECHECK] restaurants con geofence invalida: %', v_count;

  -- 12) status libre en shifts
  select count(*) into v_count
  from public.shifts
  where status is null
     or lower(status) not in ('active','completed','approved','rejected');
  raise notice '[PRECHECK] shifts.status fuera de catalogo esperado: %', v_count;

  -- 13) actor_id / user_id vacios en audit_logs
  select count(*) into v_count
  from public.audit_logs
  where coalesce(actor_id, user_id) is null;
  raise notice '[PRECHECK] audit_logs sin actor/user: %', v_count;

end $$;

commit;
