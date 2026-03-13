do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'user_phone_otps_phone_check'
      and conrelid = 'public.user_phone_otps'::regclass
  ) then
    alter table public.user_phone_otps
      drop constraint user_phone_otps_phone_check;
  end if;

  alter table public.user_phone_otps
    add constraint user_phone_otps_phone_check
    check (phone_e164 ~ E'^\\+[1-9][0-9]{7,14}$');
end $$;
