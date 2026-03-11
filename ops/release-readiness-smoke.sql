-- release-readiness-smoke.sql
-- Post-migration smoke checks for 018_release_readiness_restaurants_supplies.sql

-- 1) Schema: restaurants.is_active
select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'restaurants'
  and column_name = 'is_active';

-- 2) Schema: supplies.unit_cost
select
  column_name,
  data_type,
  numeric_precision,
  numeric_scale,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'supplies'
  and column_name = 'unit_cost';

-- 3) Constraint: supplies_unit_cost_non_negative
select
  conname,
  pg_get_constraintdef(c.oid) as definition
from pg_constraint c
where c.conrelid = 'public.supplies'::regclass
  and c.conname = 'supplies_unit_cost_non_negative';

-- 4) Index: idx_restaurants_is_active_name
select
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'restaurants'
  and indexname = 'idx_restaurants_is_active_name';

-- 5) Data quality: unit_cost should be non-null/non-negative
select
  count(*) as invalid_unit_cost_rows
from public.supplies
where unit_cost is null or unit_cost < 0;

-- 6) Functional sanity: active/inactive split counts
select
  is_active,
  count(*) as restaurants_count
from public.restaurants
group by is_active
order by is_active desc;
