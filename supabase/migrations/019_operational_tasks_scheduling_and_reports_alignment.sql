-- 019_operational_tasks_scheduling_and_reports_alignment.sql
-- Close critical product gaps: scheduling lifecycle, operational tasks RPCs,
-- and report/assignment policy alignment for supervisora role.

begin;
-- ---------------------------------------------------------
-- 1) Policy alignment: restaurant assignments + reports write scope
-- ---------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'restaurant_employees'
      and policyname = 'restaurant_employees_write_admin'
  ) then
    drop policy restaurant_employees_write_admin on public.restaurant_employees;
  end if;

  create policy restaurant_employees_write_admin
  on public.restaurant_employees
  for all
  to authenticated
  using (
    public.actor_role_secure() = 'super_admin'
    or (
      public.actor_role_secure() = 'supervisora'
      and public.is_supervisor_for_restaurant(restaurant_id)
    )
  )
  with check (
    public.actor_role_secure() = 'super_admin'
    or (
      public.actor_role_secure() = 'supervisora'
      and public.is_supervisor_for_restaurant(restaurant_id)
    )
  );

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'reports'
      and policyname = 'reports_write_hardened'
  ) then
    drop policy reports_write_hardened on public.reports;
  end if;

  create policy reports_write_hardened
  on public.reports
  for all
  to authenticated
  using (
    public.actor_role_secure() = 'super_admin'
    or (
      public.actor_role_secure() = 'supervisora'
      and restaurant_id is not null
      and public.is_supervisor_for_restaurant(restaurant_id)
    )
  )
  with check (
    public.actor_role_secure() = 'super_admin'
    or (
      public.actor_role_secure() = 'supervisora'
      and restaurant_id is not null
      and public.is_supervisor_for_restaurant(restaurant_id)
    )
  );
end $$;
-- ---------------------------------------------------------
-- 1.1) Supplies access alignment for supervisora
-- ---------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'supplies'
      and policyname = 'supplies_select_hardened'
  ) then
    drop policy supplies_select_hardened on public.supplies;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'supplies'
      and policyname = 'supplies_write_hardened'
  ) then
    drop policy supplies_write_hardened on public.supplies;
  end if;

  create policy supplies_select_hardened
  on public.supplies
  for select
  to authenticated
  using (
    public.actor_role_secure() = 'super_admin'
    or (
      public.actor_role_secure() = 'supervisora'
      and (
        restaurant_id is null
        or public.is_supervisor_for_restaurant(restaurant_id)
      )
    )
  );

  create policy supplies_write_hardened
  on public.supplies
  for all
  to authenticated
  using (
    public.actor_role_secure() = 'super_admin'
    or (
      public.actor_role_secure() = 'supervisora'
      and restaurant_id is not null
      and public.is_supervisor_for_restaurant(restaurant_id)
    )
  )
  with check (
    public.actor_role_secure() = 'super_admin'
    or (
      public.actor_role_secure() = 'supervisora'
      and restaurant_id is not null
      and public.is_supervisor_for_restaurant(restaurant_id)
    )
  );
end $$;
-- ---------------------------------------------------------
-- 2) Scheduling RPCs: cancel / reschedule / bulk assign
-- ---------------------------------------------------------
create or replace function public.cancel_scheduled_shift(
  p_scheduled_shift_id bigint,
  p_reason text default null
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
    raise exception 'No autorizado para cancelar turnos';
  end if;

  select * into v_row
  from public.scheduled_shifts s
  where s.id = p_scheduled_shift_id;

  if not found then
    raise exception 'Turno programado no encontrado';
  end if;

  if v_row.status not in ('scheduled', 'started') then
    raise exception 'Solo se pueden cancelar turnos scheduled o started';
  end if;

  if v_actor_role = 'supervisora' and not public.is_supervisor_for_restaurant(v_row.restaurant_id) then
    raise exception 'Supervisora sin alcance para cancelar este turno';
  end if;

  update public.scheduled_shifts
  set
    status = 'cancelled',
    notes = case
      when nullif(trim(p_reason), '') is null then notes
      when notes is null then format('[CANCELLED] %s', trim(p_reason))
      else notes || E'\n' || format('[CANCELLED] %s', trim(p_reason))
    end,
    updated_at = now()
  where id = p_scheduled_shift_id;
end;
$$;
grant execute on function public.cancel_scheduled_shift(bigint, text) to authenticated;
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

  if v_actor_role = 'supervisora' and not public.is_supervisor_for_restaurant(v_row.restaurant_id) then
    raise exception 'Supervisora sin alcance para reprogramar este turno';
  end if;

  if exists (
    select 1
    from public.scheduled_shifts s
    where s.id <> p_scheduled_shift_id
      and s.employee_id = v_row.employee_id
      and s.status in ('scheduled', 'started')
      and tstzrange(s.scheduled_start, s.scheduled_end, '[)') && tstzrange(p_scheduled_start, p_scheduled_end, '[)')
  ) then
    raise exception 'El empleado ya tiene un turno programado en ese rango';
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
create or replace function public.bulk_assign_scheduled_shifts(
  p_entries jsonb
)
returns table (
  total integer,
  created integer,
  failed integer,
  created_ids bigint[],
  errors jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_actor_role text;
  v_item jsonb;
  v_employee_id uuid;
  v_restaurant_id integer;
  v_start timestamptz;
  v_end timestamptz;
  v_notes text;
  v_id bigint;
  v_total integer := 0;
  v_created integer := 0;
  v_failed integer := 0;
  v_ids bigint[] := '{}';
  v_errors jsonb := '[]'::jsonb;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'No autenticado';
  end if;

  v_actor_role := public.actor_role_secure();
  if v_actor_role not in ('super_admin', 'supervisora') then
    raise exception 'No autorizado para programar turnos';
  end if;

  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception 'p_entries debe ser un arreglo json';
  end if;

  for v_item in select value from jsonb_array_elements(p_entries)
  loop
    v_total := v_total + 1;

    begin
      v_employee_id := (v_item ->> 'employee_id')::uuid;
      v_restaurant_id := (v_item ->> 'restaurant_id')::integer;
      v_start := (v_item ->> 'scheduled_start')::timestamptz;
      v_end := (v_item ->> 'scheduled_end')::timestamptz;
      v_notes := nullif(trim(v_item ->> 'notes'), '');

      if v_employee_id is null or v_restaurant_id is null or v_start is null or v_end is null then
        raise exception 'Campos requeridos faltantes en item %', v_total;
      end if;

      if v_actor_role = 'supervisora' and not public.is_supervisor_for_restaurant(v_restaurant_id) then
        raise exception 'Sin alcance para restaurante %', v_restaurant_id;
      end if;

      v_id := public.assign_scheduled_shift(v_employee_id, v_restaurant_id, v_start, v_end, v_notes);
      v_created := v_created + 1;
      v_ids := array_append(v_ids, v_id);
    exception when others then
      v_failed := v_failed + 1;
      v_errors := v_errors || jsonb_build_array(
        jsonb_build_object(
          'index', v_total,
          'error', sqlerrm,
          'payload', v_item
        )
      );
    end;
  end loop;

  return query
  select v_total, v_created, v_failed, v_ids, v_errors;
end;
$$;
grant execute on function public.bulk_assign_scheduled_shifts(jsonb) to authenticated;
-- ---------------------------------------------------------
-- 3) Operational tasks RPCs
-- ---------------------------------------------------------
create or replace function public.create_operational_task(
  p_shift_id integer,
  p_assigned_employee_id uuid,
  p_title text,
  p_description text,
  p_priority text default 'normal',
  p_due_at timestamptz default null
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
    restaurant_id,
    assigned_employee_id,
    created_by,
    title,
    description,
    priority,
    status,
    due_at,
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
    now(),
    now()
  )
  returning id into v_task_id;

  return v_task_id;
end;
$$;
grant execute on function public.create_operational_task(integer, uuid, text, text, text, timestamptz) to authenticated;
create or replace function public.complete_operational_task(
  p_task_id bigint,
  p_evidence_path text,
  p_evidence_hash text,
  p_evidence_mime_type text,
  p_evidence_size_bytes bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_actor_role text;
  v_assigned_employee uuid;
  v_restaurant_id integer;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'No autenticado';
  end if;

  v_actor_role := public.actor_role_secure();
  if v_actor_role not in ('super_admin', 'supervisora', 'empleado') then
    raise exception 'Rol no autorizado para cerrar tarea';
  end if;

  select t.assigned_employee_id, t.restaurant_id
    into v_assigned_employee, v_restaurant_id
  from public.operational_tasks t
  where t.id = p_task_id;

  if v_assigned_employee is null then
    raise exception 'Tarea operativa no encontrada';
  end if;

  if v_actor_role = 'empleado' and v_assigned_employee <> v_actor_id then
    raise exception 'Solo el empleado asignado puede cerrar la tarea';
  end if;

  if v_actor_role = 'supervisora' and not public.is_supervisor_for_restaurant(v_restaurant_id) then
    raise exception 'Supervisora sin alcance para cerrar tarea';
  end if;

  update public.operational_tasks
  set
    status = 'completed',
    resolved_at = now(),
    resolved_by = v_actor_id,
    evidence_path = trim(p_evidence_path),
    evidence_hash = trim(p_evidence_hash),
    evidence_mime_type = trim(p_evidence_mime_type),
    evidence_size_bytes = p_evidence_size_bytes,
    updated_at = now()
  where id = p_task_id;

  if not found then
    raise exception 'No se pudo actualizar tarea';
  end if;
end;
$$;
grant execute on function public.complete_operational_task(bigint, text, text, text, bigint) to authenticated;
-- ---------------------------------------------------------
-- 4) Storage bucket for report artifacts
-- ---------------------------------------------------------
do $$
begin
  begin
    insert into storage.buckets (id, name, public)
    values ('reports', 'reports', false)
    on conflict (id) do nothing;
  exception when insufficient_privilege then
    raise notice 'Sin permisos para crear bucket reports desde SQL Editor. Crealo manualmente en Storage > Buckets.';
  end;
end $$;
commit;
