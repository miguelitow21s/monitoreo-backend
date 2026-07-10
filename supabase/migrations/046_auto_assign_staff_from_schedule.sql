-- 046_auto_assign_staff_from_schedule.sql
-- Scheduling a service grants the employee access to that restaurant.

begin;

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

  v_actor_role := public.actor_role_secure();
  if v_actor_role not in ('super_admin', 'supervisora') then
    raise exception 'No autorizado para programar turnos';
  end if;

  if p_scheduled_end <= p_scheduled_start then
    raise exception 'Rango horario invalido';
  end if;

  if not exists (
    select 1
    from public.users u
    join public.roles r on r.id = u.role_id
    where u.id = p_employee_id
      and u.is_active = true
      and r.name::text = 'empleado'
  ) then
    raise exception 'Empleado invalido o inactivo';
  end if;

  if not exists (
    select 1
    from public.restaurants r
    where r.id = p_restaurant_id
      and r.is_active = true
      and r.lat is not null
      and r.lng is not null
      and coalesce(r.geofence_radius_m, r.radius) is not null
      and coalesce(r.geofence_radius_m, r.radius) > 0
  ) then
    raise exception 'Restaurante invalido, inactivo o sin geocerca';
  end if;

  insert into public.restaurant_employees (restaurant_id, user_id)
  values (p_restaurant_id, p_employee_id)
  on conflict (restaurant_id, user_id) do nothing;

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

create or replace function public.reschedule_scheduled_shift(
  p_scheduled_shift_id bigint,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_actor_role text;
  v_row public.scheduled_shifts%rowtype;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'No autenticado';
  end if;

  v_actor_role := public.actor_role_secure();
  if v_actor_role not in ('super_admin', 'supervisora') then
    raise exception 'No autorizado para reprogramar turnos';
  end if;

  if p_scheduled_end <= p_scheduled_start then
    raise exception 'Rango horario invalido';
  end if;

  select * into v_row
  from public.scheduled_shifts s
  where s.id = p_scheduled_shift_id;

  if not found then
    raise exception 'Turno programado no encontrado';
  end if;

  if v_row.status <> 'scheduled' then
    raise exception 'Solo se puede reprogramar un turno en estado scheduled';
  end if;

  insert into public.restaurant_employees (restaurant_id, user_id)
  values (v_row.restaurant_id, v_row.employee_id)
  on conflict (restaurant_id, user_id) do nothing;

  update public.scheduled_shifts
  set
    scheduled_start = p_scheduled_start,
    scheduled_end = p_scheduled_end,
    notes = coalesce(nullif(trim(p_notes), ''), notes),
    updated_at = now()
  where id = p_scheduled_shift_id;
end;
$$;

grant execute on function public.reschedule_scheduled_shift(bigint, timestamptz, timestamptz, text) to authenticated;

insert into public.restaurant_employees (restaurant_id, user_id)
select distinct s.restaurant_id, s.employee_id
from public.scheduled_shifts s
join public.users u on u.id = s.employee_id
join public.roles role on role.id = u.role_id
join public.restaurants r on r.id = s.restaurant_id
where s.status = 'scheduled'
  and s.scheduled_end >= now()
  and u.is_active = true
  and role.name::text = 'empleado'
  and r.is_active = true
on conflict (restaurant_id, user_id) do nothing;

commit;
