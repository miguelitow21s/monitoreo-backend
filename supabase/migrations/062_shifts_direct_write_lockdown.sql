-- 062_shifts_direct_write_lockdown.sql
-- Fix #1 (ALTO), step 2: close direct PostgREST writes to `shifts`.
--
-- The `authenticated` (empleado) role could INSERT/UPDATE its own shift straight
-- through PostgREST -- RLS allows own-row writes -- and NO shift trigger enforces
-- the geofence. So a contractor could fabricate a full visit (arbitrary
-- coordinates, arbitrary hours, no photos) from anywhere, bypassing the Edge
-- geofence/evidence capture the product is built on. (supervisor_presence is
-- already protected at the DB layer by trg_supervisor_presence_guard; shifts was
-- the gap.)
--
-- The geofence lives only in the Edge code (settings-driven radius:
-- geofence_radius_m -> radius -> default, plus min accuracy and the
-- require_gps_for_shift_start toggle). Replicating that in a trigger would
-- recreate RLS<->code divergence, so instead the Edge functions are made the
-- sole writer and direct client writes are revoked.
--
-- Prerequisite (already deployed in step 1): shifts_start/end/approve/reject now
-- write via the service role (clientAdmin). Each fully authorizes in code and
-- scopes the row to the right shift, so bypassing RLS there is safe:
--   shifts_start   roleGuard(empleado,supervisora) + ensureNoActiveShift +
--                  geoValidatorByRestaurant + insert with employee_id = user.id
--   shifts_end     .eq(id).eq(employee_id,user.id).eq(state,'activo')
--   shifts_approve roleGuard(sup,admin)+ensureSupervisorShiftAccess+.eq(id).eq(state,'finalizado')
--   shifts_reject  identical to approve
--   shiftAutoClose already service role
--
-- SELECT is intentionally kept: shifts_select_hardened RLS still governs reads
-- and the authenticated role reads shifts directly.

begin;

revoke insert, update, delete, truncate on public.shifts from authenticated, anon;

commit;
