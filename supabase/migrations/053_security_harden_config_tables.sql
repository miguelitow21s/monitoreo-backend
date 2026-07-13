-- 053_security_harden_config_tables.sql
-- Pre-launch security hardening. Audit found several tables with RLS disabled
-- that rely on Supabase's default `grant all ... to anon, authenticated`, so any
-- authenticated user can read/write them via PostgREST. Verified live: an
-- `empleado` could SELECT and PATCH `public.system_settings` (e.g. disable the
-- GPS geofence, change PIN policy, legal text), and could DELETE their own
-- rate-limit rows to bypass throttling.
--
-- The Edge Functions access all of these exclusively through the service role
-- (clientAdmin) or SECURITY DEFINER RPCs, both of which bypass RLS, so enabling
-- RLS + revoking client grants does NOT break any legitimate flow.

begin;

-- 1) Config/infra tables: service-role only. Enable RLS + revoke client access.
do $$
declare t text;
begin
  foreach t in array array[
    'system_settings',
    'idempotency_records',
    'rate_limit_windows',
    'security_rate_limit_events',
    'incidents_orphan_backup'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on table public.%I from public, anon, authenticated', t);
    end if;
  end loop;
end $$;

-- 2) roles lookup: keep SELECT (authGuard/UI read role names) but block writes,
--    which would break actor_role_secure() / all authorization.
revoke insert, update, delete on table public.roles from public, anon, authenticated;

-- 3) Defense-in-depth (audit B1): the frontend never reads these auth tables
--    directly (uses the trusted_device_* / phone_otp_* endpoints). 048 revoked
--    writes; also drop residual client SELECT so hashes aren't readable at all.
revoke select on table public.user_trusted_devices from anon, authenticated;
revoke select on table public.user_phone_verification_sessions from anon, authenticated;
drop policy if exists user_trusted_devices_select_scoped on public.user_trusted_devices;
drop policy if exists user_phone_verification_sessions_select_scoped on public.user_phone_verification_sessions;

-- 4) Evidence immutability (audit M1): drop client UPDATE/DELETE on the evidence
--    bucket so a contractor can't overwrite/delete already-submitted evidence.
--    Uploads use service-role signed URLs, so INSERT/SELECT are enough.
do $$
begin
  execute 'drop policy if exists shift_evidence_update on storage.objects';
  execute 'drop policy if exists shift_evidence_delete on storage.objects';
exception
  when insufficient_privilege then
    raise notice 'No permission to alter storage.objects policies; drop shift_evidence_update/delete manually in Storage.';
end $$;

commit;
