-- 063_operational_tables_revoke_unused_writes.sql
-- Defense-in-depth hygiene: remove DELETE/TRUNCATE from the client roles on the
-- six operational/evidence tables. RLS already denies deletes on all of them
-- (there is no DELETE policy) and TRUNCATE is not reachable through PostgREST,
-- so this changes no behavior -- it just removes standing privileges nothing
-- uses. INSERT/UPDATE/SELECT are intentionally kept: these tables are written by
-- the Edge functions via clientUser and rely on their grants + RLS + guard
-- triggers (unlike shifts, whose writers moved to the service role in 062).
--
-- anon is included so the anonymous role holds no write privilege here at all
-- (shift_photos in particular still granted writes to anon; RLS denied them,
-- but the grant should not exist).

begin;

revoke delete, truncate on public.shift_photos                   from authenticated, anon;
revoke delete, truncate on public.supervisor_presence_evidences  from authenticated, anon;
revoke delete, truncate on public.supervisor_presence_logs       from authenticated, anon;
revoke delete, truncate on public.shift_health_forms             from authenticated, anon;
revoke delete, truncate on public.incidents                      from authenticated, anon;
revoke delete, truncate on public.operational_tasks              from authenticated, anon;

-- shift_photos has RLS enabled with NO policy (deny-all for client roles), and
-- evidence_upload writes it via the service role -- so no client ever needs
-- INSERT/UPDATE here. Drop those too (esp. the stray anon write grant).
revoke insert, update on public.shift_photos from authenticated, anon;

commit;
