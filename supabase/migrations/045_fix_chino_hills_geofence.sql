-- 045_fix_chino_hills_geofence.sql
-- Correct Chino Hills geofence to match 4505 Chino Hills Pkwy, Chino Hills, CA 91709.

begin;

update public.restaurants
set
  address_line = '4505 Chino Hills Pkwy',
  city = 'Chino Hills',
  state = 'CA',
  postal_code = '91709',
  country = 'US',
  lat = 33.982651,
  lng = -117.706140,
  radius = 300,
  geofence_radius_m = 300,
  updated_at = now()
where id = 28
  and name = 'Chino Hills';

commit;
