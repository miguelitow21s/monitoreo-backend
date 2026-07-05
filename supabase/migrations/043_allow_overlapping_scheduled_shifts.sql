-- 043_allow_overlapping_scheduled_shifts.sql
-- Allow an employee to have multiple scheduled services in the same time window.

begin;

alter table public.scheduled_shifts
  drop constraint if exists scheduled_shifts_no_overlap_active;

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

alter table public.operational_tasks
  drop constraint if exists operational_tasks_evidence_mime_check;

alter table public.operational_tasks
  add constraint operational_tasks_evidence_mime_check
  check (
    evidence_mime_type is null
    or evidence_mime_type in ('application/json', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')
  );

alter table public.supervisor_presence_logs
  drop constraint if exists supervisor_presence_logs_mime_check;

alter table public.supervisor_presence_logs
  add constraint supervisor_presence_logs_mime_check
  check (
    evidence_mime_type is null
    or evidence_mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')
  );

create or replace function public.operational_tasks_guard_update()
returns trigger
language plpgsql
as $$
declare
  v_role text;
  v_uid uuid;
begin
  new.updated_at := now();

  if tg_op <> 'UPDATE' then
    return new;
  end if;

  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'No autenticado';
  end if;

  v_role := public.actor_role_secure();

  if v_role in ('super_admin', 'supervisora') then
    return new;
  end if;

  if v_role <> 'empleado' then
    raise exception 'Rol no autorizado para actualizar tarea operativa';
  end if;

  if old.task_scope is distinct from 'restaurant' and old.assigned_employee_id <> v_uid then
    raise exception 'Solo el empleado asignado puede cerrar la tarea';
  end if;

  if new.shift_id is distinct from old.shift_id
     or new.scheduled_shift_id is distinct from old.scheduled_shift_id
     or new.restaurant_id is distinct from old.restaurant_id
     or new.task_scope is distinct from old.task_scope
     or new.assigned_employee_id is distinct from old.assigned_employee_id
     or new.created_by is distinct from old.created_by
     or new.title is distinct from old.title
     or new.description is distinct from old.description
     or new.priority is distinct from old.priority
     or new.due_at is distinct from old.due_at
     or new.created_at is distinct from old.created_at then
    raise exception 'Empleado no puede editar datos base de la tarea';
  end if;

  if new.status <> 'completed' then
    raise exception 'Cierre de tarea debe usar estado completed';
  end if;

  if new.resolved_by is null or new.resolved_by <> v_uid then
    raise exception 'resolved_by invalido para cierre de tarea';
  end if;

  if new.resolved_at is null then
    new.resolved_at := now();
  end if;

  if new.requires_evidence is distinct from old.requires_evidence then
    raise exception 'Empleado no puede cambiar el requerimiento de evidencia';
  end if;

  if new.requires_evidence then
    if new.evidence_path is null
       or new.evidence_hash is null
       or new.evidence_mime_type is null
       or new.evidence_size_bytes is null then
      raise exception 'Faltan metadatos de evidencia para cerrar tarea';
    end if;

    if new.evidence_mime_type = 'application/json' then
      if new.evidence_path not like format('users/%s/task-manifest/%%', v_uid::text) then
        raise exception 'Ruta de manifest invalida para cierre de tarea';
      end if;
    elsif new.evidence_mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif') then
      if new.evidence_path not like format('users/%s/task-evidence/%%', v_uid::text) then
        raise exception 'Ruta de evidencia invalida para cierre de tarea';
      end if;
    else
      raise exception 'Mime de evidencia invalido para cierre de tarea';
    end if;
  end if;

  return new;
end;
$$;

update public.system_settings
set settings = jsonb_set(
  jsonb_set(
    coalesce(settings, '{}'::jsonb) || jsonb_build_object('gps', coalesce(settings -> 'gps', '{}'::jsonb)),
    '{gps,require_gps_for_supervision}',
    'true'::jsonb,
    true
  ) || jsonb_build_object('evidence', coalesce(settings -> 'evidence', '{}'::jsonb)),
  '{evidence,require_supervision_photos}',
  'true'::jsonb,
  true
)
where id = 1;

commit;
