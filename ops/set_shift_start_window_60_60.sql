-- Apply operational shift start window in current environment.
-- Intended for manual execution in STG/PROD SQL editor if needed.

begin;

insert into public.system_settings (id, settings)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

update public.system_settings
set
  settings = jsonb_set(
    jsonb_set(
      coalesce(settings, '{}'::jsonb),
      '{shifts,early_start_tolerance_minutes}',
      to_jsonb(60),
      true
    ),
    '{shifts,late_start_tolerance_minutes}',
    to_jsonb(60),
    true
  ),
  updated_at = now()
where id = 1;

commit;
