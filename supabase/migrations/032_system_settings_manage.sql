-- 032_system_settings_manage.sql
-- System-wide settings for super_admin configuration UI

begin;
create table if not exists public.system_settings (
  id integer primary key default 1,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid null
);
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'system_settings_single_row'
      and conrelid = 'public.system_settings'::regclass
  ) then
    alter table public.system_settings
      add constraint system_settings_single_row check (id = 1);
  end if;
end $$;
insert into public.system_settings (id, settings)
values (1, '{}'::jsonb)
on conflict (id) do nothing;
commit;
