begin;

do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname='public'
    and tablename not in ('roles','system_settings','legal_terms_versions')
  loop
    execute format('truncate table public.%I restart identity cascade', r.tablename);
  end loop;
end $$;

delete from auth.users;

with seed as (
  select * from (values
    ('admin@gmail.com','super_admin','Admin'),
    ('empleado@gmail.com','empleado','Empleado'),
    ('supervisora@gmail.com','supervisora','Supervisora')
  ) as v(email, role_name, full_name)
),
ids as (
  select gen_random_uuid() as id, email, role_name, full_name from seed
),
auth_ins as (
  insert into auth.users (
    id, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at, aud, role
  )
  select id, email,
         crypt('123456', gen_salt('bf')),
         now(),
         jsonb_build_object('provider','email','providers', jsonb_build_array('email')),
         jsonb_build_object('full_name', full_name),
         now(), now(),
         'authenticated','authenticated'
  from ids
  returning id
)
insert into public.users (id, email, role_id, full_name, is_active, must_change_pin, pin_updated_at)
select i.id, i.email, r.id, i.full_name, true, false, now()
from ids i
join public.roles r on r.name::text = i.role_name;

commit;
