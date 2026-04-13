-- 040_operational_tasks_global_scope.sql
-- Align operational tasks access/creation with global-scope model
-- (no restaurant assignment requirement for supervisora/empleado).

begin;

-- ---------------------------------------------------------
-- 1) RLS policies for operational_tasks (global scope)
-- ---------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'operational_tasks'
      and policyname = 'operational_tasks_select_scoped'
  ) then
    drop policy operational_tasks_select_scoped on public.operational_tasks;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'operational_tasks'
      and policyname = 'operational_tasks_insert_supervision'
  ) then
    drop policy operational_tasks_insert_supervision on public.operational_tasks;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'operational_tasks'
      and policyname = 'operational_tasks_update_supervision'
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

-- ---------------------------------------------------------
-- 2) RPC create_operational_task (shift-based)
-- ---------------------------------------------------------
create or replace function public.create_operational_task(
  p_shift_id integer,
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

  select s.restaurant_id
    into v_restaurant_id
  from public.shifts s
  where s.id = p_shift_id;

  if v_restaurant_id is null then
    raise exception 'Turno invalido para crear tarea';
  end if;

  insert into public.operational_tasks (
    shift_id,
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
    p_shift_id,
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

grant execute on function public.create_operational_task(integer, uuid, text, text, text, timestamptz, boolean) to authenticated;

-- ---------------------------------------------------------
-- 3) RPC create_operational_task_for_schedule (scheduled-shift based)
-- ---------------------------------------------------------
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
