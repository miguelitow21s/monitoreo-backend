begin;
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

  return new;
end;
$$;
commit;
