-- 037_operational_tasks_scheduled_shift.sql
-- Allow operational tasks to be created for scheduled shifts and link them when the shift starts.

begin;
alter table public.operational_tasks
  add column if not exists scheduled_shift_id bigint references public.scheduled_shifts(id) on delete set null;
alter table public.operational_tasks
  alter column shift_id drop not null;
create index if not exists idx_operational_tasks_scheduled_shift
  on public.operational_tasks (scheduled_shift_id);
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

  if old.assigned_employee_id <> v_uid then
    raise exception 'Solo el empleado asignado puede cerrar la tarea';
  end if;

  if new.shift_id is distinct from old.shift_id
     or new.scheduled_shift_id is distinct from old.scheduled_shift_id
     or new.restaurant_id is distinct from old.restaurant_id
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
    elsif new.evidence_mime_type in ('image/jpeg', 'image/png', 'image/webp') then
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
create or replace function public.create_operational_task_for_schedule(
  p_scheduled_shift_id bigint,
  p_assigned_employee_id uuid,
  p_title text,
  p_description text,
  p_priority text default 'normal',
  p_due_at timestamptz default null,
  p_requires_evidence boolean default true
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_actor_role text;
  v_restaurant_id integer;
  v_employee_id uuid;
  v_status text;
  v_task_id bigint;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'No autenticado';
  end if;

  v_actor_role := public.actor_role_secure();
  if v_actor_role not in ('super_admin', 'supervisora') then
    raise exception 'No autorizado para crear tareas operativas';
  end if;

  select s.restaurant_id, s.employee_id, s.status
    into v_restaurant_id, v_employee_id, v_status
  from public.scheduled_shifts s
  where s.id = p_scheduled_shift_id;

  if v_restaurant_id is null then
    raise exception 'Turno programado invalido para crear tarea';
  end if;

  if v_status <> 'scheduled' then
    raise exception 'Solo se pueden asignar tareas a turnos programados';
  end if;

  if v_employee_id is null or p_assigned_employee_id is null then
    raise exception 'Empleado invalido para la tarea';
  end if;

  if v_employee_id <> p_assigned_employee_id then
    raise exception 'Empleado no coincide con el turno programado';
  end if;

  if v_actor_role = 'supervisora' and not public.is_supervisor_for_restaurant(v_restaurant_id) then
    raise exception 'Supervisora sin alcance para crear tarea';
  end if;

  if not exists (
    select 1
    from public.restaurant_employees re
    where re.restaurant_id = v_restaurant_id
      and re.user_id = p_assigned_employee_id
  ) then
    raise exception 'Empleado asignado no pertenece al restaurante';
  end if;

  insert into public.operational_tasks (
    shift_id,
    scheduled_shift_id,
    restaurant_id,
    assigned_employee_id,
    created_by,
    title,
    description,
    priority,
    status,
    due_at,
    requires_evidence,
    created_at,
    updated_at
  )
  values (
    null,
    p_scheduled_shift_id,
    v_restaurant_id,
    p_assigned_employee_id,
    v_actor_id,
    trim(p_title),
    trim(p_description),
    coalesce(nullif(trim(p_priority), ''), 'normal'),
    'pending',
    p_due_at,
    coalesce(p_requires_evidence, true),
    now(),
    now()
  )
  returning id into v_task_id;

  return v_task_id;
end;
$$;
grant execute on function public.create_operational_task_for_schedule(bigint, uuid, text, text, text, timestamptz, boolean) to authenticated;
commit;
