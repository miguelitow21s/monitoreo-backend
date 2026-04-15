-- 041_shift_start_window_60_60.sql
-- Align operational shift start window tolerances to 60/60 minutes.

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
