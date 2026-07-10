-- 047_restaurant_timezone.sql
-- Timezone-aware scheduling (Option A): each restaurant carries an explicit IANA
-- timezone (e.g. 'America/Los_Angeles') so shifts are scheduled/displayed in the
-- restaurant's local wall-clock time regardless of where the admin/supervisor is.
--
-- Storage does not change: scheduled_start/scheduled_end stay timestamptz (absolute
-- instants). This column only tells the app how to interpret input and format output.

begin;

alter table public.restaurants
  add column if not exists timezone text;

-- One-time best-effort backfill for existing rows.
-- 1) Colombia by country name.
update public.restaurants
set timezone = 'America/Bogota', updated_at = now()
where timezone is null
  and (country ilike '%colombia%' or country ilike 'co');

-- 2) Continental US by longitude band, guarded by latitude so non-US coords
--    (e.g. Colombia) never fall into these bands if country was missing.
update public.restaurants
set timezone = case
    when lng < -114 then 'America/Los_Angeles'
    when lng < -102 then 'America/Denver'
    when lng < -87  then 'America/Chicago'
    else 'America/New_York'
  end,
  updated_at = now()
where timezone is null
  and lat between 24 and 50
  and lng between -125 and -66;

-- 3) Safety default for anything still unresolved: business is primarily California.
update public.restaurants
set timezone = 'America/Los_Angeles', updated_at = now()
where timezone is null;

comment on column public.restaurants.timezone is
  'IANA timezone (e.g. America/Los_Angeles) used to interpret and display this restaurant''s scheduled shift times. Derived from lat/lng on create/update; admin can override.';

commit;
