-- 020_fix_shifts_employee_rls_for_edge_functions.sql
-- Ensure empleado can start/end own shift through Edge Functions (RLS-safe).

begin;

-- Needed because shifts_start inserts into public.shifts using clientUser.
grant insert on table public.shifts to authenticated;

-- Employee insert policy for own active shift rows.
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

-- Employee update policy for ending own active shift.
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

commit;
