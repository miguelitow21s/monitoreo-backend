-- 044_supervisora_global_restaurant_access.sql
-- Supervisora users have global access to active restaurant operations.

begin;

create or replace function public.is_supervisor_for_restaurant(p_restaurant_id integer)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.users u
    join public.roles r on r.id = u.role_id
    where u.id = auth.uid()
      and u.is_active = true
      and r.name::text = 'supervisora'
  )
  and exists (
    select 1
    from public.restaurants rest
    where rest.id = p_restaurant_id
  );
$$;

grant execute on function public.is_supervisor_for_restaurant(integer) to authenticated;

create or replace function public.can_supervise_restaurant(p_restaurant_id integer)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.users u
    join public.roles r on r.id = u.role_id
    where u.id = auth.uid()
      and u.is_active = true
      and r.name::text = 'supervisora'
  )
  and exists (
    select 1
    from public.restaurants rest
    where rest.id = p_restaurant_id
  );
$$;

grant execute on function public.can_supervise_restaurant(integer) to authenticated;

commit;
