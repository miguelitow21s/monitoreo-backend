-- 036_users_pin_policy.sql
-- Track mandatory PIN/password changes

begin;
alter table public.users
  add column if not exists must_change_pin boolean not null default false,
  add column if not exists pin_updated_at timestamptz;
commit;
