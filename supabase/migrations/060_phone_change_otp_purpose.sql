-- 060_phone_change_otp_purpose.sql
--
-- Let the OTP table carry a second purpose so a contractor can authorize a phone
-- change with a code emailed to their account. The table already emails the login
-- OTP; reusing it (with a distinct purpose) keeps one hashing/expiry/attempts path
-- instead of a parallel one. 'shift_ops' stays exactly as it was.

begin;

alter table public.user_phone_otps
  drop constraint if exists user_phone_otps_purpose_check;

alter table public.user_phone_otps
  add constraint user_phone_otps_purpose_check
  check (purpose in ('shift_ops', 'phone_change'));

commit;
