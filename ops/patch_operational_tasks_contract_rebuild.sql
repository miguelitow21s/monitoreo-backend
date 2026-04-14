-- Patch: rebuild operational_tasks contract for scheduled task creation
-- Safe/idempotent script for production SQL Editor

begin;

-- 1) Ensure expected columns and nullability for scheduled-task flow
alter table if exists public.operational_tasks
  add column if not exists scheduled_shift_id bigint references public.scheduled_shifts(id) on delete set null;

alter table if exists public.operational_tasks
  alter column shift_id drop not null;

-- 2) Remove legacy rewrite rules that can redirect INSERTs to old RPC behavior
--    (symptom: P0001 "Turno invalido para crear tarea" while inserting scheduled tasks)
do $$
declare
  r record;
begin
  for r in
    select rulename
    from pg_rules
    where schemaname = 'public'
      and tablename = 'operational_tasks'
  loop
    execute format('drop rule if exists %I on public.operational_tasks', r.rulename);
  end loop;
end $$;

-- 3) Recreate update guard with latest scheduled_shift-aware logic
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

drop trigger if exists tr_operational_tasks_guard_update on public.operational_tasks;
create trigger tr_operational_tasks_guard_update
before update on public.operational_tasks
for each row execute function public.operational_tasks_guard_update();

-- 4) Global-scope policies for supervision inserts/updates
--    (keeps employee self-closure policy intact)
do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'operational_tasks' and policyname = 'operational_tasks_select_scoped'
  ) then
    drop policy operational_tasks_select_scoped on public.operational_tasks;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'operational_tasks' and policyname = 'operational_tasks_insert_supervision'
  ) then
    drop policy operational_tasks_insert_supervision on public.operational_tasks;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'operational_tasks' and policyname = 'operational_tasks_update_supervision'
  ) then
    drop policy operational_tasks_update_supervision on public.operational_tasks;
  end if;

  create policy operational_tasks_select_scoped
  on public.operational_tasks
  for select to authenticated
  using (
    assigned_employee_id = auth.uid()
    or public.actor_role_secure() in ('super_admin', 'supervisora')
  );

  create policy operational_tasks_insert_supervision
  on public.operational_tasks
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.actor_role_secure() in ('super_admin', 'supervisora')
  );

  create policy operational_tasks_update_supervision
  on public.operational_tasks
  for update to authenticated
  using (public.actor_role_secure() in ('super_admin', 'supervisora'))
  with check (public.actor_role_secure() in ('super_admin', 'supervisora'));
end $$;

commit;
