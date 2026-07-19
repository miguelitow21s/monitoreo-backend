-- 057_operational_tasks_multi_video_evidence.sql
-- #9: the contractor answers a special task with MULTIPLE photos and/or videos.
--   1) evidence_items jsonb keeps the full list; the legacy single evidence_*
--      columns keep the first item (the guard trigger requires them).
--   2) video mimes are now valid evidence — both the CHECK constraint and the
--      guard trigger previously accepted only images/json, which made closing a
--      video task impossible.

begin;

alter table public.operational_tasks
  add column if not exists evidence_items jsonb;

comment on column public.operational_tasks.evidence_items is
  'Array of {path, hash, mime_type, size_bytes} for multi-file task evidence. evidence_path/hash/mime_type/size_bytes mirror the first item for backwards compatibility.';

-- 1) Allow video mimes on the evidence column.
alter table public.operational_tasks
  drop constraint if exists operational_tasks_evidence_mime_check;

alter table public.operational_tasks
  add constraint operational_tasks_evidence_mime_check
  check (
    evidence_mime_type is null
    or evidence_mime_type in (
      'application/json',
      'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
      'video/mp4', 'video/quicktime', 'video/webm'
    )
  );

-- 2) Same for the employee-close guard trigger (verbatim from 055 plus a video
--    branch validating the same users/<uid>/task-evidence/ prefix).
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

  if new.status = 'in_progress'
     and old.status in ('pending', 'in_progress')
     and new.resolved_by is not distinct from old.resolved_by
     and new.resolved_at is not distinct from old.resolved_at
     and new.evidence_path is not distinct from old.evidence_path
     and new.requires_evidence is not distinct from old.requires_evidence then
    return new;
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
    elsif new.evidence_mime_type in (
      'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
      'video/mp4', 'video/quicktime', 'video/webm'
    ) then
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

commit;
