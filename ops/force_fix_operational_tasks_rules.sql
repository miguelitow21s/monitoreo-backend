-- Force fix for legacy RULE rewrites on public.operational_tasks
-- Run this in Supabase SQL Editor (production project)

begin;

-- A) Show current rewrite rules before cleanup
select schemaname, tablename, rulename, definition
from pg_rules
where schemaname = 'public'
  and tablename = 'operational_tasks';

-- B) Drop every rewrite rule attached to operational_tasks
do $$
declare
  r record;
begin
  for r in
    select rulename
    from pg_rules
    where schemaname = 'public'
      and tablename = 'operational_tasks'
  loop
    execute format('drop rule if exists %I on public.operational_tasks', r.rulename);
  end loop;
end $$;

-- C) Re-validate: must return 0 rows
select schemaname, tablename, rulename
from pg_rules
where schemaname = 'public'
  and tablename = 'operational_tasks';

-- D) Inspect currently active function sources (sanity check)
select p.proname, pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_operational_task', 'create_operational_task_for_schedule');

commit;
