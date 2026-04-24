-- 042_restaurant_scoped_tasks.sql
-- Support restaurant-scoped operational tasks (no shift, no assigned employee).
-- Any employee of the restaurant can pick up and complete the task.

begin;

-- ---------------------------------------------------------
-- 1. Add task_scope column
-- ---------------------------------------------------------
alter table public.operational_tasks
  add column if not exists task_scope text not null default 'employee'
  check (task_scope in ('employee', 'restaurant'));

-- ---------------------------------------------------------
-- 2. Make assigned_employee_id nullable
-- ---------------------------------------------------------
alter table public.operational_tasks
  alter column assigned_employee_id drop not null;

-- ---------------------------------------------------------
-- 3. Enforce: employee-scoped tasks must have assigned_employee_id
-- ---------------------------------------------------------
alter table public.operational_tasks
  add constraint operational_tasks_employee_scope_requires_assignment
  check (task_scope = 'restaurant' or assigned_employee_id is not null);

-- ---------------------------------------------------------
-- 4. UPDATE SELECT RLS: employees also see restaurant-scoped tasks
--    for restaurants they work at
-- ---------------------------------------------------------
do $$ begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'operational_tasks'
      and policyname = 'operational_tasks_select_scoped'
  ) then
    drop policy operational_tasks_select_scoped on public.operational_tasks;
  end if;

  create policy operational_tasks_select_scoped
  on public.operational_tasks
  for select to authenticated
  using (
    assigned_employee_id = auth.uid()
    or public.actor_role_secure() in ('super_admin', 'supervisora')
    or (
      task_scope = 'restaurant'
      and restaurant_id in (
        select re.restaurant_id
        from public.restaurant_employees re
        where re.user_id = auth.uid()
      )
    )
  );
end $$;

-- ---------------------------------------------------------
-- 5. UPDATE UPDATE RLS: employees can update their own tasks
--    AND restaurant-scoped tasks for their restaurant
-- ---------------------------------------------------------
do $$ begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'operational_tasks'
      and policyname = 'operational_tasks_update_supervision'
  ) then
    drop policy operational_tasks_update_supervision on public.operational_tasks;
  end if;

  create policy operational_tasks_update_supervision
  on public.operational_tasks
  for update to authenticated
  using (
    public.actor_role_secure() in ('super_admin', 'supervisora')
    or (
      public.actor_role_secure() = 'empleado'
      and (
        assigned_employee_id = auth.uid()
        or (
          task_scope = 'restaurant'
          and restaurant_id in (
            select re.restaurant_id
            from public.restaurant_employees re
            where re.user_id = auth.uid()
          )
        )
      )
    )
  )
  with check (
    public.actor_role_secure() in ('super_admin', 'supervisora')
    or (
      public.actor_role_secure() = 'empleado'
      and (
        assigned_employee_id = auth.uid()
        or (
          task_scope = 'restaurant'
          and restaurant_id in (
            select re.restaurant_id
            from public.restaurant_employees re
            where re.user_id = auth.uid()
          )
        )
      )
    )
  );
end $$;

-- ---------------------------------------------------------
-- 6. RPC: create_operational_task_for_restaurant
-- ---------------------------------------------------------
create or replace function public.create_operational_task_for_restaurant(
  p_restaurant_id integer,
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
  v_task_id bigint;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'No autenticado';
  end if;

  v_actor_role := public.actor_role_secure();
  if v_actor_role not in ('super_admin', 'supervisora') then
    raise exception 'No autorizado para crear tareas de restaurante';
  end if;

  if not exists (select 1 from public.restaurants where id = p_restaurant_id) then
    raise exception 'RESTAURANT_NOT_FOUND: restaurante % no existe', p_restaurant_id;
  end if;

  insert into public.operational_tasks (
    shift_id,
    scheduled_shift_id,
    restaurant_id,
    task_scope,
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
    null,
    p_restaurant_id,
    'restaurant',
    null,
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

grant execute on function public.create_operational_task_for_restaurant(integer, text, text, text, timestamptz, boolean) to authenticated;

commit;
