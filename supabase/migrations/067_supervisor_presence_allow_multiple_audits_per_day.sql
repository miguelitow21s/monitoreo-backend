-- 067_supervisor_presence_allow_multiple_audits_per_day.sql
-- Allow inspectors to audit the same site multiple times a day (follow-up visits,
-- re-audits after findings, AM/PM shifts).
--
-- The sequence guard was written for the old start/end model and treated any
-- 'start' without a matching 'end' as "open" -- but the draft flow never writes an
-- 'end', so a COMPLETED audit still counted as open and blocked the next start
-- (surfaced as SUPERVISION_ALREADY_COMPLETED_TODAY).
--
-- Fix: only an OPEN DRAFT (status='draft') blocks a new start. That keeps the
-- double-tap / accidental-reentry protection (the client's second start returns
-- the same draft) while allowing a fresh audit once the previous one is finalized.
-- The 'end' branch (legacy register path) is unchanged.

create or replace function public.supervisor_presence_logs_guard_sequence()
 returns trigger
 language plpgsql
as $function$
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
        and s.status = 'draft'
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
$function$;
