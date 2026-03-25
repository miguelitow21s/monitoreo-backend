-- 033_restaurants_cleaning_areas.sql
-- Add configurable cleaning areas per restaurant

begin;

alter table public.restaurants
  add column if not exists cleaning_areas jsonb;

commit;

