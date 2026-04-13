-- 021_supervisora_shift_and_staff_alignment.sql
-- Enable supervisora own start/end shift flow and employee assignment operations.

begin;
-- Needed because shifts_start inserts into public.shifts using clientUser.
grant insert on table public.shifts to authenticated;
-- Empleado insert policy for own active shift rows.
do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'shifts'
      and policyname = 'shifts_insert_employee_own'
  ) then
    drop policy shifts_insert_employee_own on public.shifts;
  end if;

  create policy shifts_insert_employee_own
  on public.shifts
  for insert
  to authenticated
  with check (
    public.actor_role_secure() = 'empleado'
    and employee_id = auth.uid()
    and state = 'activo'
    and end_time is null
  );
end $$;
-- Supervisora insert policy for own active shift rows.
do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'shifts'
      and policyname = 'shifts_insert_supervisora_own'
  ) then
    drop policy shifts_insert_supervisora_own on public.shifts;
  end if;

  create policy shifts_insert_supervisora_own
  on public.shifts
  for insert
  to authenticated
  with check (
    public.actor_role_secure() = 'supervisora'
    and employee_id = auth.uid()
    and state = 'activo'
    and end_time is null
  );
end $$;
-- Empleado update policy for ending own active shift.
do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'shifts'
      and policyname = 'shifts_update_employee_own_active'
  ) then
    drop policy shifts_update_employee_own_active on public.shifts;
  end if;

  create policy shifts_update_employee_own_active
  on public.shifts
  for update
  to authenticated
  using (
    public.actor_role_secure() = 'empleado'
    and employee_id = auth.uid()
    and state = 'activo'
    and end_time is null
  )
  with check (
    public.actor_role_secure() = 'empleado'
    and employee_id = auth.uid()
  );
end $$;
-- Supervisora update policy for ending own active shift.
do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'shifts'
      and policyname = 'shifts_update_supervisora_own_active'
  ) then
    drop policy shifts_update_supervisora_own_active on public.shifts;
  end if;

  create policy shifts_update_supervisora_own_active
  on public.shifts
  for update
  to authenticated
  using (
    public.actor_role_secure() = 'supervisora'
    and employee_id = auth.uid()
    and state = 'activo'
    and end_time is null
  )
  with check (
    public.actor_role_secure() = 'supervisora'
    and employee_id = auth.uid()
  );
end $$;
commit;
