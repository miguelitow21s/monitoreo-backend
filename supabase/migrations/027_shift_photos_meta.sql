-- 027_shift_photos_meta.sql
-- Optional metadata for shift photos (area/subarea tagging)

begin;

alter table public.shift_photos
  add column if not exists meta jsonb;

commit;
