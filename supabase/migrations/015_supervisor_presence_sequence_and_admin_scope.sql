-- 015_supervisor_presence_sequence_and_admin_scope.sql
-- Final alignment for supervisor presence lifecycle and admin insert scope.

begin;

-- ---------------------------------------------------------
-- 1) Guard sequence: avoid duplicate start without end
-- ---------------------------------------------------------
create or replace function public.supervisor_presence_logs_guard_sequence()
returns trigger
language plpgsql
as $$
declare
  v_effective_at timestamptz;
  v_open_start_exists boolean;
begin
  v_effective_at := coalesce(new.recorded_at, now());
  new.recorded_at := v_effective_at;

  if new.phase = 'start' then
    select exists (
      select 1
      from public.supervisor_presence_logs s
      where s.supervisor_id = new.supervisor_id
        and s.restaurant_id = new.restaurant_id
        and (s.recorded_at at time zone 'utc')::date = (v_effective_at at time zone 'utc')::date
        and s.phase = 'start'
        and not exists (
          select 1
          from public.supervisor_presence_logs e
          where e.supervisor_id = s.supervisor_id
            and e.restaurant_id = s.restaurant_id
            and (e.recorded_at at time zone 'utc')::date = (s.recorded_at at time zone 'utc')::date
            and e.phase = 'end'
            and e.recorded_at >= s.recorded_at
        )
    ) into v_open_start_exists;

    if v_open_start_exists then
      raise exception 'Ya existe un start abierto para este restaurante en el dia';
    end if;
  end if;

  if new.phase = 'end' then
    select exists (
      select 1
      from public.supervisor_presence_logs s
      where s.supervisor_id = new.supervisor_id
        and s.restaurant_id = new.restaurant_id
        and (s.recorded_at at time zone 'utc')::date = (v_effective_at at time zone 'utc')::date
        and s.phase = 'start'
        and s.recorded_at <= v_effective_at
        and not exists (
          select 1
          from public.supervisor_presence_logs e
          where e.supervisor_id = s.supervisor_id
            and e.restaurant_id = s.restaurant_id
            and (e.recorded_at at time zone 'utc')::date = (s.recorded_at at time zone 'utc')::date
            and e.phase = 'end'
            and e.recorded_at >= s.recorded_at
            and e.recorded_at <= v_effective_at
        )
    ) into v_open_start_exists;

    if not v_open_start_exists then
      raise exception 'No existe un start abierto para registrar end';
    end if;
  end if;

  return new;
end;
$$;

do $$
begin
  if exists (
    select 1 from pg_trigger where tgname = 'tr_supervisor_presence_logs_guard_sequence'
  ) then
    drop trigger tr_supervisor_presence_logs_guard_sequence on public.supervisor_presence_logs;
  end if;

  create trigger tr_supervisor_presence_logs_guard_sequence
  before insert on public.supervisor_presence_logs
  for each row execute function public.supervisor_presence_logs_guard_sequence();
end $$;

-- ---------------------------------------------------------
-- 2) RLS: super_admin full insert scope on supervisor presence
-- ---------------------------------------------------------
do $$
declare
  p record;
begin
  for p in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'supervisor_presence_logs'
      and policyname in ('supervisor_presence_logs_insert_scoped')
  loop
    execute format('drop policy %I on public.supervisor_presence_logs', p.policyname);
  end loop;

  create policy supervisor_presence_logs_insert_scoped
  on public.supervisor_presence_logs
  for insert to authenticated
  with check (
    (
      public.actor_role_secure() = 'super_admin'
      and exists (
        select 1
        from public.users u
        join public.roles r on r.id = u.role_id
        where u.id = supervisor_id
          and r.name in ('supervisora', 'super_admin')
      )
    )
    or (
      public.actor_role_secure() = 'supervisora'
      and supervisor_id = auth.uid()
      and public.is_supervisor_for_restaurant(restaurant_id)
    )
  );
end $$;

commit;
