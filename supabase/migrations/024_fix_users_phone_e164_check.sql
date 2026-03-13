-- 024_fix_users_phone_e164_check.sql
-- Fix phone_e164 check constraint to accept valid E.164 numbers (+<country><number>).

begin;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'users_phone_e164_check'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users drop constraint users_phone_e164_check;
  end if;

  alter table public.users
    add constraint users_phone_e164_check
    check (phone_e164 is null or phone_e164 ~ E'^\\+[1-9][0-9]{7,14}$');
end $$;

commit;
