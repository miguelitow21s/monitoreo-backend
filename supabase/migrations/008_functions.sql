-- 05_functions.sql
-- FASE 5: FUNCIONES (SECURITY DEFINER ENDURECIDO, VALIDACIONES, SIN OVERLOADS PELIGROSOS)

begin;

-- 1) Tabla de rate-limit persistente
create table if not exists public.security_rate_limit_events (
  id bigserial primary key,
  action text not null,
  actor_id uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_rate_limit_action_actor_created_at
  on public.security_rate_limit_events (action, actor_id, created_at desc);

-- 2) Funcion de rate-limit
create or replace function public.enforce_rate_limit(
  p_action text,
  p_max_attempts integer,
  p_window interval,
  p_actor_id uuid default auth.uid()
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if p_actor_id is null then
    raise exception 'No autenticado';
  end if;

  if p_max_attempts < 1 then
    raise exception 'p_max_attempts invalido';
  end if;

  if p_window <= interval '0 second' then
    raise exception 'p_window invalido';
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
end;
$$;

revoke execute on function public.enforce_rate_limit(text, integer, interval, uuid) from public;
grant execute on function public.enforce_rate_limit(text, integer, interval, uuid) to authenticated;

-- 3) Eliminar overloads peligrosos (si existen)
drop function if exists public.start_shift(uuid, integer, double precision, double precision);
drop function if exists public.end_shift(integer, double precision, double precision);
drop function if exists public.start_shift(double precision, double precision, text, text, text, bigint);
drop function if exists public.end_shift(integer, double precision, double precision, text, text, text, bigint);

-- 4) get_my_active_shift seguro
create or replace function public.get_my_active_shift()
returns table (
  id integer,
  start_time timestamptz,
  end_time timestamptz,
  status text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select s.id, s.start_time, s.end_time, s.status
  from public.shifts s
  where s.employee_id = auth.uid()
    and s.end_time is null
  order by s.start_time desc
  limit 1;
$$;

revoke execute on function public.get_my_active_shift() from public;
grant execute on function public.get_my_active_shift() to authenticated;

-- 5) start_shift seguro (firma compatible frontend)
create or replace function public.start_shift(
  lat double precision,
  lng double precision,
  evidence_path text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_scheduled_id bigint;
  v_restaurant_id integer;
  v_shift_id integer;
  v_server_evidence_path text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'No autenticado';
  end if;

  perform public.enforce_rate_limit('start_shift', 6, interval '15 minutes', v_actor_id);

  if lat is null or lng is null or not isfinite(lat) or not isfinite(lng)
     or lat < -90 or lat > 90 or lng < -180 or lng > 180 then
    raise exception 'Coordenadas invalidas';
  end if;

  v_role := public.actor_role_secure();
  if v_role not in ('empleado','supervisora','super_admin') then
    raise exception 'Rol no autorizado para iniciar turno';
  end if;

  select s.id, s.restaurant_id
    into v_scheduled_id, v_restaurant_id
  from public.scheduled_shifts s
  where s.employee_id = v_actor_id
    and s.status = 'scheduled'
    and now() between (s.scheduled_start - interval '15 minutes') and (s.scheduled_end + interval '15 minutes')
  order by s.scheduled_start asc
  limit 1;

  if v_restaurant_id is null then
    raise exception 'No hay turno programado vigente para iniciar';
  end if;

  insert into public.shifts (employee_id, restaurant_id, start_time, start_lat, start_lng, state, status)
  select v_actor_id, v_restaurant_id, now(), lat, lng, 'activo', 'active'
  from public.restaurants r
  where r.id = v_restaurant_id
    and earth_distance(ll_to_earth(r.lat, r.lng), ll_to_earth(lat, lng)) <= r.radius
  returning id into v_shift_id;

  if v_shift_id is null then
    raise exception 'GPS fuera de geocerca o restaurante invalido';
  end if;

  update public.scheduled_shifts
  set status = 'started', started_shift_id = v_shift_id, updated_at = now()
  where id = v_scheduled_id;

  -- ruta de evidencia generada por backend
  v_server_evidence_path := format(
    'secure/%s/shifts/%s/start_%s.jpg',
    v_actor_id,
    v_shift_id,
    to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISSMS')
  );

  update public.shifts
  set
    start_evidence_path = v_server_evidence_path,
    start_evidence_created_at = now(),
    start_evidence_uploaded_by = v_actor_id,
    updated_at = now()
  where id = v_shift_id;

  insert into public.audit_logs (action, actor_user_id)
  values ('start_shift', v_actor_id);

  return v_shift_id;
end;
$$;

revoke execute on function public.start_shift(double precision, double precision, text) from public;
grant execute on function public.start_shift(double precision, double precision, text) to authenticated;

-- 6) end_shift seguro (firma compatible frontend)
create or replace function public.end_shift(
  shift_id integer,
  lat double precision,
  lng double precision,
  evidence_path text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_actor_role text;
  v_shift_employee uuid;
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
    into v_shift_employee, v_restaurant_id
  from public.shifts s
  where s.id = shift_id
    and s.end_time is null;

  if v_shift_employee is null then
    raise exception 'Turno invalido o ya finalizado';
  end if;

  v_actor_role := public.actor_role_secure();

  if v_actor_role = 'empleado' and v_shift_employee <> v_actor_id then
    raise exception 'No autorizado para finalizar turno ajeno';
  end if;

  if v_actor_role = 'supervisora' and not public.is_supervisor_for_restaurant(v_restaurant_id) then
    raise exception 'Supervisora no asignada al restaurante del turno';
  end if;

  if v_actor_role not in ('empleado','supervisora','super_admin') then
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
    raise exception 'GPS fuera de geocerca';
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
    and status in ('scheduled','started');

  v_server_evidence_path := format(
    'secure/%s/shifts/%s/end_%s.jpg',
    v_shift_employee,
    shift_id,
    to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISSMS')
  );

  update public.shifts
  set
    end_evidence_path = v_server_evidence_path,
    end_evidence_created_at = now(),
    end_evidence_uploaded_by = v_actor_id,
    updated_at = now()
  where id = shift_id;

  insert into public.audit_logs (action, actor_user_id)
  values ('end_shift', v_actor_id);
end;
$$;

revoke execute on function public.end_shift(integer, double precision, double precision, text) from public;
grant execute on function public.end_shift(integer, double precision, double precision, text) to authenticated;

commit;
