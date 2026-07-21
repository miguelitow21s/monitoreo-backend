-- 059_shift_scheduled_email_names_and_local_time.sql
--
-- The "servicio programado" email is the one notification built in SQL by a
-- trigger, not in the Edge Function code, so the pass that made every other email
-- readable (names instead of UUIDs, the site's clock instead of raw UTC) never
-- reached it. It still read:
--
--   "Se programo un turno para eda1d05c-1690-420c-b519-c9c149a94aec
--    (inicio: 2026-07-20 01:00:00 UTC, ..., restaurante: 16)."
--
-- Same fix as the rest of the system: the contractor's name, the site's name, and
-- the time in the site's own clock. Whoever reads this is a supervisor, not a
-- database; the raw ids stay in `payload` for traceability.

begin;

create or replace function public.enqueue_shift_scheduled_notifications()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  insert into public.email_notifications (
    event_type,
    dedupe_key,
    recipient_email,
    recipient_user_id,
    subject,
    body_text,
    payload,
    restaurant_id,
    scheduled_shift_id,
    status,
    scheduled_for
  )
  select
    'shift_scheduled',
    format('shift_scheduled:%s:%s', new.id, u.id),
    u.email,
    u.id,
    format('Turno programado | %s', ctx.rest_name),
    format(
      'Se programo un servicio para %s en %s. Inicio: %s. Fin: %s (hora local del sitio, %s).',
      who.emp_name,
      ctx.rest_name,
      to_char(new.scheduled_start at time zone ctx.tz_name, 'YYYY-MM-DD FMHH12:MI AM'),
      to_char(new.scheduled_end   at time zone ctx.tz_name, 'YYYY-MM-DD FMHH12:MI AM'),
      ctx.tz_name
    ),
    -- Ids stay here for traceability; they just don't belong in the readable body.
    jsonb_build_object(
      'scheduled_shift_id', new.id,
      'employee_id', new.employee_id,
      'restaurant_id', new.restaurant_id,
      'scheduled_start', new.scheduled_start,
      'scheduled_end', new.scheduled_end,
      'timezone', ctx.tz_name
    ),
    new.restaurant_id,
    new.id,
    'pending',
    now()
  from public.users u
  join public.roles r on r.id = u.role_id
  -- These laterals SELECT with no FROM, so each yields exactly one row and can
  -- never drop a recipient, even if the site or employee row were missing.
  cross join lateral (
    select
      coalesce(
        (select nullif(trim(name), '') from public.restaurants where id = new.restaurant_id),
        'sitio ' || new.restaurant_id
      ) as rest_name,
      coalesce(
        (select coalesce(nullif(trim(timezone), ''), 'America/Los_Angeles') from public.restaurants where id = new.restaurant_id),
        'America/Los_Angeles'
      ) as tz_name
  ) ctx
  cross join lateral (
    select coalesce(
      (select nullif(trim(full_name), '') from public.users where id = new.employee_id),
      (select email from public.users where id = new.employee_id),
      'usuario ' || left(new.employee_id::text, 8)
    ) as emp_name
  ) who
  where u.is_active = true
    and u.email is not null
    and (
      u.id = new.employee_id
      or r.name = 'super_admin'
      or (
        r.name = 'supervisora'
        and exists (
          select 1
          from public.restaurant_employees re
          where re.user_id = u.id
            and re.restaurant_id = new.restaurant_id
        )
      )
    )
  on conflict (dedupe_key) do nothing;

  return new;
end;
$function$;

commit;
