-- 048_security_harden_auth_tables.sql
-- CRITICAL security fix (audit C1/C2): the device-trust / OTP tables granted
-- INSERT/UPDATE/DELETE to the `authenticated` role with permissive
-- `*_insert_self` / `*_update_scoped` RLS policies. Because the Edge Functions
-- write these tables exclusively with the service role (clientAdmin), no
-- legitimate client needs those grants — but they let ANY authenticated user
-- forge their own OTP verification session (bypassing the email second factor),
-- bind unlimited devices, or reset their own OTP attempt counter, straight
-- through PostgREST with the anon key + their JWT.
--
-- Fix: revoke client write access; keep scoped SELECT only where harmless.
-- Verified: the frontend (repo `html`) never touches these tables directly —
-- it uses the dedicated endpoints (trusted_device_register/validate,
-- phone_otp_send/verify), which run as service role.

begin;

-- 1) Revoke write privileges from client roles on the three auth tables.
revoke insert, update, delete on public.user_phone_verification_sessions from authenticated, anon;
revoke insert, update, delete on public.user_trusted_devices               from authenticated, anon;
revoke insert, update, delete on public.user_phone_otps                    from authenticated, anon;

-- The OTP code hash is sensitive (offline recovery if OTP_HASH_PEPPER is empty),
-- and the frontend never reads it directly -> drop client SELECT too.
revoke select on public.user_phone_otps from authenticated, anon;

-- 2) Drop the now-unnecessary permissive write policies (belt and suspenders).
drop policy if exists user_phone_verification_sessions_insert_self  on public.user_phone_verification_sessions;
drop policy if exists user_phone_verification_sessions_update_scoped on public.user_phone_verification_sessions;
drop policy if exists user_trusted_devices_insert_self   on public.user_trusted_devices;
drop policy if exists user_trusted_devices_update_scoped on public.user_trusted_devices;
drop policy if exists user_phone_otps_insert_self   on public.user_phone_otps;
drop policy if exists user_phone_otps_update_scoped on public.user_phone_otps;
drop policy if exists user_phone_otps_select_scoped on public.user_phone_otps;

-- 3) Correctness (audit M4): enforce a single active shift per employee at the
--    DB level, not just in application code (ensureNoActiveShift). No current
--    data violates this (verified before applying).
create unique index if not exists uq_shifts_one_active_per_employee
  on public.shifts (employee_id)
  where state = 'activo';

commit;
