-- 018_release_readiness_restaurants_supplies.sql
-- Delivery readiness: restaurant activation flag + supplies unit cost.

begin;

-- ---------------------------------------------------------
-- 1) Restaurants soft activation/deactivation support
-- ---------------------------------------------------------
alter table public.restaurants
  add column if not exists is_active boolean not null default true;

create index if not exists idx_restaurants_is_active_name
  on public.restaurants (is_active, name);

-- ---------------------------------------------------------
-- 2) Supplies unit cost support for operational expenses
-- ---------------------------------------------------------
alter table public.supplies
  add column if not exists unit_cost numeric(12,2);

-- Normalize legacy/dirty values before enforcing NOT NULL + CHECK.
update public.supplies
set unit_cost = greatest(coalesce(unit_cost, 0), 0)
where unit_cost is null or unit_cost < 0;

alter table public.supplies
  alter column unit_cost set default 0,
  alter column unit_cost set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'supplies_unit_cost_non_negative'
      and conrelid = 'public.supplies'::regclass
  ) then
    alter table public.supplies
      add constraint supplies_unit_cost_non_negative
      check (unit_cost >= 0);
  end if;
end $$;

commit;
