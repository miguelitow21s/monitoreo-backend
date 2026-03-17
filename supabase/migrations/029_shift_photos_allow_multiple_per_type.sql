-- 029_shift_photos_allow_multiple_per_type.sql
-- Allow multiple photos per shift and phase (inicio/fin)

begin;

alter table public.shift_photos
  drop constraint if exists shift_photos_shift_id_type_key;

create index if not exists idx_shift_photos_shift_type
  on public.shift_photos (shift_id, type);

commit;
