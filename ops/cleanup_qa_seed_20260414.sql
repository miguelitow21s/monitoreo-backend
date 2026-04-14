-- Cleanup controlado QA Seed - Produccion
-- Ejecutar en SQL Editor del proyecto orwingqtwoqfhcogggac

begin;

create temporary table if not exists _qa_seed_users(id uuid primary key) on commit drop;
create temporary table if not exists _qa_seed_restaurants(id integer primary key) on commit drop;
create temporary table if not exists _cleanup_summary(entity text primary key, deleted_count bigint not null default 0) on commit drop;

truncate table _qa_seed_users;
truncate table _qa_seed_restaurants;
truncate table _cleanup_summary;

insert into _qa_seed_users(id)
values
  ('edf7dab8-e426-46a3-b192-3e6f372303e4'),
  ('649bf34d-0298-4b31-9a0b-3259f9a37cb0'),
  ('ef02c7a8-730c-4b1a-8ea8-0746843ff982');

insert into _qa_seed_restaurants(id)
values (12), (13), (14), (15);

do $$
declare
  v_count bigint;
begin
  -- Limpiar dependencias de turnos/tareas
  delete from public.operational_tasks ot
  where ot.assigned_employee_id in (select id from _qa_seed_users)
     or ot.created_by in (select id from _qa_seed_users)
     or ot.restaurant_id in (select id from _qa_seed_restaurants)
     or ot.shift_id in (
       select s.id
       from public.shifts s
       where s.restaurant_id in (select id from _qa_seed_restaurants)
          or s.employee_id in (select id from _qa_seed_users)
     )
     or ot.scheduled_shift_id in (
       select ss.id
       from public.scheduled_shifts ss
       where ss.restaurant_id in (select id from _qa_seed_restaurants)
          or ss.employee_id in (select id from _qa_seed_users)
     );
  get diagnostics v_count = row_count;
  insert into _cleanup_summary(entity, deleted_count) values ('operational_tasks', v_count);

  delete from public.shift_photos sp
  where sp.shift_id in (
    select s.id
    from public.shifts s
    where s.restaurant_id in (select id from _qa_seed_restaurants)
       or s.employee_id in (select id from _qa_seed_users)
  )
  or sp.user_id in (select id from _qa_seed_users);
  get diagnostics v_count = row_count;
  insert into _cleanup_summary(entity, deleted_count) values ('shift_photos', v_count);

  delete from public.incidents i
  where i.shift_id in (
    select s.id
    from public.shifts s
    where s.restaurant_id in (select id from _qa_seed_restaurants)
       or s.employee_id in (select id from _qa_seed_users)
  )
  or i.created_by in (select id from _qa_seed_users);
  get diagnostics v_count = row_count;
  insert into _cleanup_summary(entity, deleted_count) values ('incidents', v_count);

  delete from public.supervisor_presence_evidences spe
  where spe.presence_id in (
    select spl.id
    from public.supervisor_presence_logs spl
    where spl.restaurant_id in (select id from _qa_seed_restaurants)
       or spl.supervisor_id in (select id from _qa_seed_users)
  );
  get diagnostics v_count = row_count;
  insert into _cleanup_summary(entity, deleted_count) values ('supervisor_presence_evidences', v_count);

  delete from public.supervisor_presence_logs spl
  where spl.restaurant_id in (select id from _qa_seed_restaurants)
     or spl.supervisor_id in (select id from _qa_seed_users);
  get diagnostics v_count = row_count;
  insert into _cleanup_summary(entity, deleted_count) values ('supervisor_presence_logs', v_count);

  delete from public.supply_deliveries sd
  where sd.restaurant_id in (select id from _qa_seed_restaurants)
     or sd.delivered_by in (select id from _qa_seed_users);
  get diagnostics v_count = row_count;
  insert into _cleanup_summary(entity, deleted_count) values ('supply_deliveries', v_count);

  delete from public.reports r
  where r.restaurant_id in (select id from _qa_seed_restaurants)
     or r.generated_by in (select id from _qa_seed_users);
  get diagnostics v_count = row_count;
  insert into _cleanup_summary(entity, deleted_count) values ('reports', v_count);

  delete from public.audit_logs al
  where al.user_id in (select id from _qa_seed_users)
     or al.actor_id in (select id from _qa_seed_users)
     or al.actor_user_id in (select id from _qa_seed_users);
  get diagnostics v_count = row_count;
  insert into _cleanup_summary(entity, deleted_count) values ('audit_logs', v_count);

  delete from public.scheduled_shifts ss
  where ss.restaurant_id in (select id from _qa_seed_restaurants)
     or ss.employee_id in (select id from _qa_seed_users);
  get diagnostics v_count = row_count;
  insert into _cleanup_summary(entity, deleted_count) values ('scheduled_shifts', v_count);

  delete from public.shifts s
  where s.restaurant_id in (select id from _qa_seed_restaurants)
     or s.employee_id in (select id from _qa_seed_users);
  get diagnostics v_count = row_count;
  insert into _cleanup_summary(entity, deleted_count) values ('shifts', v_count);

  delete from public.restaurant_employees re
  where re.restaurant_id in (select id from _qa_seed_restaurants)
     or re.user_id in (select id from _qa_seed_users);
  get diagnostics v_count = row_count;
  insert into _cleanup_summary(entity, deleted_count) values ('restaurant_employees', v_count);

  delete from public.restaurants r
  where r.id in (select id from _qa_seed_restaurants);
  get diagnostics v_count = row_count;
  insert into _cleanup_summary(entity, deleted_count) values ('restaurants', v_count);

  delete from public.users u
  where u.id in (select id from _qa_seed_users);
  get diagnostics v_count = row_count;
  insert into _cleanup_summary(entity, deleted_count) values ('users', v_count);
end $$;

-- Opcional: descomentar si tambien quieren limpiar Auth (suele requerir permisos altos)
-- delete from auth.users au where au.id in (select id from _qa_seed_users);

select entity, deleted_count
from _cleanup_summary
order by entity;

commit;
